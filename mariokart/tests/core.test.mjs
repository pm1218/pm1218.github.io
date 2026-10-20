// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { pointsFor, CUPS, MAX_GP_TOTAL } from '../js/data.js';
import { similarity } from '../js/text.js';
import { planScreen, finishScreen, isolateDigits, decodeDescending, pointsCandidates, parseOrdinal, parseNumber, matchName, detectHumans, vocabulary } from '../js/wii-layout.js';
import { suggestIdentities } from '../js/identity.js';
import {
  emptyDraft, makeParticipant, validateDraft, computeStandings, toPayload,
  draftFromScreens, completedRaceCount, racePlacementOf, addExtraAsPlayer,
} from '../js/scoring.js';
import { powerRankings, eloRatings, consistencyMetrics, trackStats, trackReport, headToHead, insights, fullReport } from '../js/analytics.js';
import { profiles, gps } from './sample-data.mjs';

// OCR fixtures from 17 real photos of a TV (text + boxes only; no images).
const FIX_DIR = new URL('./fixtures/wii/', import.meta.url);
const fixtures = readdirSync(FIX_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, FIX_DIR))));
const MIIS = { extraNames: ['bob', 'dog man'] };
const readFixture = (fx) => finishScreen(planScreen(fx.pass1, MIIS), fx.cells, MIIS);
const fixture = (id) => fixtures.find((f) => f.id === id);

test('points table matches Mario Kart Wii', () => {
  assert.deepEqual([1, 2, 3, 4, 12].map(pointsFor), [15, 12, 10, 8, 0]);
  assert.equal(MAX_GP_TOTAL, 60);
  assert.throws(() => pointsFor(13));
  assert.equal(CUPS.Mushroom.length, 4);
});

test('OCR token repair', () => {
  assert.equal(parseOrdinal('1st'), 1);
  assert.equal(parseOrdinal('lst'), 1);
  assert.equal(parseOrdinal('12th'), 12);
  assert.equal(parseOrdinal('Sth'), null, '"Sth" could be 5th, 8th or 9th');
  assert.deepEqual(parseNumber('+15'), { value: 15, gained: true });
  assert.deepEqual(parseNumber('46pts'), { value: 46, gained: false });
  assert.equal(parseNumber('B'), null, 'name fragments are never points');
  assert.equal(matchName('Manito', vocabulary()).value, 'Mario');
  assert.equal(matchName('Koopa Tioopa', vocabulary()).value, 'Koopa Troopa');
  assert.ok(similarity('Prateek', 'PRATEEK') === 1);
});

test('real photos: screen type, names, totals and players', () => {
  let screens = 0; let names = 0; let pts = 0; let total = 0;
  let pNames = 0; let pPts = 0; let pTotal = 0; let found = 0; let falsePlayers = 0;
  for (const fx of fixtures) {
    const r = readFixture(fx);
    screens += r.kind === fx.truth.kind;
    fx.truth.rows.forEach(([name, points], i) => {
      const row = r.rows[i];
      total++; names += row.name === name; pts += row.points === points;
      const human = fx.truth.humans.includes(i + 1);
      if (human) { pTotal++; pNames += row.name === name; pPts += row.points === points; found += Boolean(row.human); } else falsePlayers += Boolean(row.human);
    });
  }
  // Locks in measured accuracy (see README → Image analysis engine).
  assert.equal(screens, fixtures.length, 'every screen classified');
  assert.ok(names / total >= 0.85, `names ${names}/${total}`);
  assert.ok(pts / total >= 0.62, `totals ${pts}/${total}`);
  assert.ok(pNames / pTotal >= 0.84, `player names ${pNames}/${pTotal}`);
  assert.ok(pPts / pTotal >= 0.78, `player totals ${pPts}/${pTotal}`);
  assert.ok(found / pTotal >= 0.85 && falsePlayers <= 4, `players found ${found}/${pTotal}, false ${falsePlayers}`);
});

test('a clean standings photo reads perfectly', () => {
  const r = readFixture(fixture('5438'));
  assert.equal(r.kind, 'standings');
  assert.equal(r.phase, 'totals');
  assert.deepEqual(r.rows.map((x) => x.name), fixture('5438').truth.rows.map((x) => x[0]));
  assert.deepEqual(r.rows.map((x) => x.points), fixture('5438').truth.rows.map((x) => x[1]));
  assert.deepEqual(r.rows.filter((x) => x.human).map((x) => x.place), [1, 2, 3, 6]);
});

test('an after-race screen is recognised and pins race placements', () => {
  const r = readFixture(fixture('5428'));
  assert.equal(r.phase, 'race');
  assert.deepEqual(r.rows.slice(0, 3).map((x) => [x.name, x.gained, racePlacementOf(x)]), [['Diddy Kong', 15, 1], ['Mario', 12, 2], ['Waluigi', 10, 3]]);
});

test('digit isolation drops "pts", bar edges and specks', () => {
  // 40×20 mask: a bar edge across row 0, two "digits" (8×14), a small "pts" blob, a speck.
  const W = 40; const H = 20; const data = new Uint8Array(W * H);
  const fill = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data[y * W + x] = 255; };
  fill(0, 0, 40, 1);       // bar edge
  fill(10, 3, 7, 14);      // digit 1
  fill(19, 3, 7, 14);      // digit 2
  fill(29, 10, 6, 5);      // "pts"
  fill(2, 15, 2, 2);       // speck
  const iso = isolateDigits({ data, width: W, height: H });
  assert.equal(iso.glyphs, 2);
  assert.equal(iso.width, 16 + 28);
});

test('totals decode in descending order, skipping bad reads', () => {
  const m = (o) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
  assert.deepEqual(decodeDescending([m({ 46: 2 }), m({ 4: 1.2, 45: 1 }), m({ 45: 1.5 }), m({ 0: 0.5 }), m({ 29: 1.4 })]), [46, 45, 45, null, 29]);
  const c = pointsCandidates([{ text: '45', confidence: 80 }, { text: '5', confidence: 90 }]);
  assert.ok(c.get(45) > c.get(5), 'a lone "5" supports "45"');
});

test('player bars: coloured vs plain rows', () => {
  const final = detectHumans('final', [{ place: 1, h: 150, s: 200, v: 220 }, { place: 2, h: 117, s: 220, v: 150 }, { place: 3, h: 116, s: 225, v: 148 }, { place: 4, h: 95, s: 200, v: 210 }]);
  assert.deepEqual(final, { 1: true, 2: false, 3: false, 4: true });
});

test('identity suggestion: Mii name, then favourite character on a player bar', () => {
  const rows = [
    { name: 'PRATEEK', character: 'Yoshi', characterConfidence: 0.7, human: true },
    { name: 'Mario', character: 'Mario', characterConfidence: 0.9, human: false },
    { name: 'Bowser', character: 'Bowser', characterConfidence: 0.9, human: true },
    { name: 'Peach', character: 'Peach', characterConfidence: 0.9, human: true },
    { name: 'Peach', character: 'Baby Peach', characterConfidence: 0.9, human: false },
  ];
  const s = suggestIdentities(rows, profiles);
  assert.equal(s[0].profile_id, 'u-pm', 'Mii name');
  assert.equal(s[1].is_cpu, true, 'no player bar → CPU');
  assert.equal(s[2].profile_id, 'u-dv', 'unique favourite Bowser → Dev');
  assert.equal(s[3].profile_id, 'u-an', 'unique favourite Peach → Anya');
  assert.equal(s[4].is_cpu, true);
  // A shared favourite (Yoshi: Prateek + Sam) is weak evidence on its own.
  const shared = suggestIdentities([{ name: 'Yoshi', character: 'Yoshi', characterConfidence: 0.5, human: true }], profiles);
  assert.equal(shared[0].profile_id, null);
  assert.equal(shared[0].is_cpu, false, 'a player we could not identify is not a CPU');
});

function threeKartDraft() {
  const d = emptyDraft();
  d.participants = [
    makeParticipant({ key: 'a', profile_id: 'u-pm', label: 'Prateek' }),
    makeParticipant({ key: 'b', profile_id: 'u-an', label: 'Anya' }),
    makeParticipant({ key: 'c', label: 'Guest' }),
  ];
  return d;
}

test('4-race rule: fewer than 4 complete races is rejected', () => {
  const d = threeKartDraft();
  d.mode = 'races'; d.source = 'manual_races';
  [[1, 2, 3], [2, 1, 3], [1, 3, 2]].forEach((pl, i) => { d.races[i].results = { a: pl[0], b: pl[1], c: pl[2] }; });
  assert.equal(completedRaceCount(d), 3);
  const v = validateDraft(d);
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /all 4 races \(3 of 4 complete\).*final totals/);
  assert.throws(() => toPayload(d));

  d.races[3].results = { a: 2, b: 1, c: 3 };
  assert.equal(validateDraft(d).ok, true);
  const st = computeStandings(d);
  assert.deepEqual(st.map((r) => [r.label, r.total, r.place]), [['Prateek', 15 + 12 + 15 + 12, 1], ['Anya', 12 + 15 + 10 + 15, 2], ['Guest', 10 + 10 + 12 + 10, 3]]);
  const payload = toPayload(d);
  assert.equal(payload.races.length, 4);
  assert.deepEqual(payload.races[0].results, [{ key: 'a', placement: 1 }, { key: 'b', placement: 2 }, { key: 'c', placement: 3 }]);
});

test('4-race rule: duplicate placements make a race incomplete', () => {
  const d = threeKartDraft();
  d.mode = 'races';
  d.races.forEach((r) => { r.results = { a: 1, b: 2, c: 3 }; });
  d.races[2].results = { a: 1, b: 1, c: 3 };
  assert.equal(completedRaceCount(d), 3);
  assert.equal(validateDraft(d).ok, false);
});

test('final total mode: totals 0-60, ties share a place', () => {
  const d = threeKartDraft();
  d.participants[0].final_total = 40;
  d.participants[1].final_total = 40;
  d.participants[2].final_total = 61;
  assert.equal(validateDraft(d).ok, false);
  d.participants[2].final_total = 30;
  assert.deepEqual(computeStandings(d).map((r) => r.place), [1, 1, 3]);
  assert.equal(toPayload(d).races.length, 0);
});

test('photo normalisation: 3 after-race screens are refused with a pointer to final totals', () => {
  const race = readFixture(fixture('5428'));
  assert.throws(
    () => draftFromScreens({ screens: [race, race, race], identities: [], profiles }),
    (e) => e.code === 'INCOMPLETE_RACES' && /final results/.test(e.message),
  );
});

test('photo normalisation: 4 after-race screens → race-mode draft with computed totals', () => {
  const race = readFixture(fixture('5428'));
  const ids = suggestIdentities(race.rows, profiles);
  const { draft, extras } = draftFromScreens({ screens: [race, race, race, race], identities: ids, profiles });
  assert.equal(draft.mode, 'races');
  assert.equal(draft.source, 'photo_races');
  assert.equal(draft.races[0].track, '', 'VS tracks are random: left for the uploader');
  assert.ok(draft.participants.every((p) => !p.is_cpu), 'only players are kept');
  assert.equal(draft.participants.length + extras.length, 12);
  const st = computeStandings(draft);
  assert.equal(st[0].total, 60, 'first in all four races');
  // A player the reader mistook for a CPU can be added back with all 4 placements.
  const x = extras.find((e) => e.places.every(Boolean));
  addExtraAsPlayer(draft, x);
  assert.ok(draft.races.every((r) => r.results[x.key]));
});

test('photo normalisation: final results → only the players, CPUs set aside', () => {
  const fin = readFixture(fixture('7316'));
  const ids = suggestIdentities(fin.rows, profiles);
  const { draft, extras } = draftFromScreens({ screens: [fin], identities: ids, profiles });
  assert.equal(draft.mode, 'total');
  assert.deepEqual(draft.participants.map((p) => p.ocr_name), ['Mario', 'Diddy Kong', 'Yoshi', 'Waluigi'], 'the 4 players on 7316');
  const yoshi = draft.participants.find((p) => p.character === 'Yoshi');
  assert.equal(yoshi.profile_id, 'u-pm', 'Yoshi on a player bar → the Yoshi fan');
  assert.equal(yoshi.final_total, 36);
  assert.equal(extras.length, 8);
  assert.throws(() => draftFromScreens({ screens: [fin, readFixture(fixture('5428'))], identities: [], profiles }), /Mixing screens/);
});

test('analytics: power, elo, consistency, tracks, head-to-head', () => {
  const power = powerRankings(gps, profiles);
  assert.equal(power[0].name, 'Anya', 'best avg points + place wins out over one more race win');
  assert.ok(power.every((r, i) => i === 0 || power[i - 1].power >= r.power));
  const sam = power.find((r) => r.name === 'Sam');
  assert.equal(sam.gps, 1);

  const elo = eloRatings(gps, profiles);
  assert.equal(elo.length, 4);
  assert.equal(Math.round(elo.reduce((s, r) => s + r.elo, 0) / 4), 1500, 'Elo is zero-sum');

  const cons = consistencyMetrics(gps, profiles);
  assert.ok(cons.every((c) => c.consistency === null || (c.consistency >= 0 && c.consistency <= 100)));

  const tracks = trackStats(gps, profiles);
  const pmLuigi = tracks.perTrack.find((t) => t.name === 'Prateek' && t.track === 'Luigi Circuit');
  assert.deepEqual([pmLuigi.races, pmLuigi.avgPlace], [1, 1]);

  const h = headToHead(gps, 'u-pm', 'u-an');
  assert.equal(h.gps, 3);
  assert.equal(h.aWins + h.bWins + h.ties, 3);
  assert.equal(h.races, 8);

  const ins = insights(gps, profiles);
  assert.ok(ins.find((i) => i.name === 'Prateek').bestGp >= 49);
  assert.equal(fullReport(gps, profiles).gpCount, 3);
});

test('track report: overall and per player, including final-score sessions', () => {
  const r = trackReport(gps, profiles);
  const luigiC = r.overall.find((t) => t.track === 'Luigi Circuit');
  assert.equal(luigiC.plays, 2, 'once race-by-race (gp1), once listed with final totals (gp3)');
  assert.equal(luigiC.sessions, 2);
  assert.equal(luigiC.placedRaces, 3, 'placements only from the race-by-race session');
  assert.equal(luigiC.best.name, 'Prateek');
  const rainbow = r.overall.find((t) => t.track === 'Rainbow Road');
  assert.deepEqual([rainbow.plays, rainbow.avgPlace, rainbow.best], [1, null, null]);
  const sam = r.players.find((p) => p.name === 'Sam');
  assert.equal(sam.tracks.length, 4, 'Sam only played the final-score session');
  assert.ok(sam.tracks.every((t) => t.avgPlace === null && t.avgSessionPlace === 3));
  const pm = r.players.find((p) => p.name === 'Prateek').tracks.find((t) => t.track === 'Luigi Circuit');
  assert.deepEqual([pm.plays, pm.placedRaces, pm.avgPlace, pm.wins, pm.avgSessionPlace], [2, 1, 1, 1, 1]);
  assert.equal(r.trackCount, 9, '8 race-by-race tracks + Rainbow Road');
});
