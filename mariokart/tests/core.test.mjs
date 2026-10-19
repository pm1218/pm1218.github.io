// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pointsFor, CUPS, MAX_GP_TOTAL } from '../js/data.js';
import { similarity } from '../js/text.js';
import { parsePlace, parsePoints, parseRows, parseScreen } from '../js/ocr-parse.js';
import { suggestIdentities } from '../js/identity.js';
import {
  emptyDraft, makeParticipant, validateDraft, computeStandings, toPayload,
  draftFromScreens, completedRaceCount, racePlacementOf,
} from '../js/scoring.js';
import { powerRankings, eloRatings, consistencyMetrics, trackStats, headToHead, insights, fullReport } from '../js/analytics.js';
import { groupRowBoxes } from '../js/vision.js';
import { profiles, gps } from './sample-data.mjs';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.ocr.json`, import.meta.url)));

test('points table matches Mario Kart Wii', () => {
  assert.deepEqual([1, 2, 3, 4, 12].map(pointsFor), [15, 12, 10, 8, 0]);
  assert.equal(MAX_GP_TOTAL, 60);
  assert.throws(() => pointsFor(13));
  assert.equal(CUPS.Mushroom.length, 4);
});

test('OCR token repair', () => {
  assert.equal(parsePlace('1st'), 1);
  assert.equal(parsePlace('lst'), 1);
  assert.equal(parsePlace('12'), 12);
  assert.equal(parsePlace('Mario'), null);
  assert.deepEqual(parsePoints('+15'), { value: 15, gained: true });
  assert.deepEqual(parsePoints('4O'), { value: 40, gained: false });
  assert.equal(parsePoints('B'), null, 'name fragments are never points');
  assert.ok(similarity('Prateek', 'PRATEEK') === 1);
});

test('final standings photo → 12 rows with correct totals', () => {
  const p = parseRows(fixture('final_photo'));
  assert.equal(p.kind, 'final');
  assert.equal(p.rows.length, 12);
  assert.deepEqual(p.rows.map((r) => r.points), [52, 47, 41, 36, 33, 27, 22, 17, 12, 9, 5, 2]);
  assert.deepEqual(p.rows.slice(0, 3).map((r) => r.name), ['Prateek', 'Mario', 'Anya']);
  assert.equal(p.rows[1].cpuCharacter, 'Mario');
  assert.ok(p.rows.every((r) => r.iconBox));
  assert.deepEqual(p.issues, []);
});

test('post-race photo → placements from +gained', () => {
  const p = parseRows(fixture('race_photo'));
  assert.equal(p.kind, 'race');
  assert.deepEqual(p.rows.slice(0, 4).map((r) => [r.name, r.gained, racePlacementOf(r)]), [
    ['Anya', 15, 1], ['Prateek', 12, 2], ['Mario', 10, 3], ['Dev', 8, 4],
  ]);
});

test('sparse-mode parser groups words into lines', () => {
  const w = (text, x, y) => ({ text, confidence: 90, bbox: { x0: x, y0: y, x1: x + 20, y1: y + 20 } });
  const p = parseScreen([w('1', 10, 10), w('Anya', 80, 12), w('52', 400, 9), w('2', 10, 50), w('Mario', 80, 51), w('47', 400, 50)]);
  assert.deepEqual(p.rows.map((r) => [r.place, r.name, r.points]), [[1, 'Anya', 52], [2, 'Mario', 47]]);
});

test('row grouping merges the name block and the points block', () => {
  const rows = groupRowBoxes([[100, 40, 500, 50], [1000, 42, 200, 48], [100, 100, 480, 50], [1000, 101, 200, 49], [0, 5, 900, 2]], 1400);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], [100, 40, 1100, 50]);
});

test('identity suggestion uses Mii name, then favourite character', () => {
  const rows = [
    { name: 'Prateek', character: 'Yoshi', characterConfidence: 0.9 },
    { name: 'Mario', character: 'Mario', characterConfidence: 0.7, cpuCharacter: 'Mario' },
    { name: 'Player 3', character: 'Bowser', characterConfidence: 0.8 },
    { name: 'Player 4', character: 'Peach', characterConfidence: 0.85 },
  ];
  const s = suggestIdentities(rows, profiles);
  assert.equal(s[0].profile_id, 'u-pm');
  assert.equal(s[1].is_cpu, true);
  assert.equal(s[2].profile_id, 'u-dv', 'unique favourite Bowser → Dev');
  assert.equal(s[3].profile_id, 'u-an', 'unique favourite Peach → Anya');
  // Shared favourite (Yoshi: Prateek + Sam) is weak evidence on its own.
  const shared = suggestIdentities([{ name: '???', character: 'Yoshi', characterConfidence: 0.5 }], profiles);
  assert.equal(shared[0].profile_id, null);
});

function threeKartDraft() {
  const d = emptyDraft('Mushroom');
  d.participants = [
    makeParticipant({ key: 'a', profile_id: 'u-pm', label: 'Prateek' }),
    makeParticipant({ key: 'b', profile_id: 'u-an', label: 'Anya' }),
    makeParticipant({ key: 'c', label: 'Mario', is_cpu: true }),
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
  assert.deepEqual(st.map((r) => [r.label, r.total, r.place]), [['Prateek', 15 + 12 + 15 + 12, 1], ['Anya', 12 + 15 + 10 + 15, 2], ['Mario', 10 + 10 + 12 + 10, 3]]);
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

test('photo normalisation: 3 race screens is refused with a pointer to final totals', () => {
  const race = parseRows(fixture('race_photo'));
  assert.throws(
    () => draftFromScreens({ screens: [race, race, race], identities: [], profiles, cup: 'Mushroom' }),
    (e) => e.code === 'INCOMPLETE_RACES' && /final standings/.test(e.message),
  );
});

test('photo normalisation: 4 race screens → race-mode draft with computed totals', () => {
  const race = parseRows(fixture('race_photo'));
  const ids = suggestIdentities(race.rows, profiles);
  const { draft, issues } = draftFromScreens({ screens: [race, race, race, race], identities: ids, profiles, cup: 'Mushroom' });
  assert.equal(draft.mode, 'races');
  assert.equal(draft.source, 'photo_races');
  assert.deepEqual(issues, []);
  assert.equal(completedRaceCount(draft), 4);
  const st = computeStandings(draft);
  assert.equal(st[0].total, 60);
  assert.equal(draft.races[0].track, 'Luigi Circuit');
  const anya = draft.participants.find((p) => p.profile_id === 'u-an');
  assert.ok(anya, 'Anya linked by Mii name');
});

test('photo normalisation: final screen → total-mode draft', () => {
  const fin = parseRows(fixture('final_photo'));
  const ids = suggestIdentities(fin.rows, profiles);
  const { draft } = draftFromScreens({ screens: [fin], identities: ids, profiles, cup: 'Star' });
  assert.equal(draft.mode, 'total');
  assert.equal(draft.participants.length, 12);
  assert.equal(draft.participants[0].profile_id, 'u-pm');
  assert.equal(draft.participants[0].final_total, 52);
  assert.equal(draft.participants.filter((p) => p.is_cpu).length, 9);
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
