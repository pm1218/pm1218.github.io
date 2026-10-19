// The internal scoring model and its normalisation rules.
//
// Every way of entering a Grand Prix — typed totals, typed race-by-race
// placements, or OCR from photos — is normalised into one "draft":
//
//   {
//     mode: 'total' | 'races',
//     source: 'manual_total' | 'manual_races' | 'photo_total' | 'photo_races',
//     participants: [{ key, profile_id, label, character, is_cpu, final_total }],
//     races: [{ race_number: 1..4, track, results: { [key]: placement } }],
//     image_paths: [], ocr_raw: null | object
//   }
//
// validateDraft() mirrors the checks in submit_grand_prix() so the UI can
// explain problems before the server rejects them; the server stays the
// authority and recomputes all points itself.

import { CUPS, MAX_GP_TOTAL, MAX_PLAYERS, POINTS, RACES_PER_GP, pointsFor } from './data.js';
import { similarity } from './text.js';

let keySeq = 0;
export const newKey = () => `k${Date.now().toString(36)}${(keySeq++).toString(36)}`;

export function emptyDraft(cup) {
  const tracks = CUPS[cup] || ['', '', '', ''];
  return {
    mode: 'total',
    source: 'manual_total',
    participants: [],
    races: Array.from({ length: RACES_PER_GP }, (_, i) => ({ race_number: i + 1, track: tracks[i], results: {} })),
    image_paths: [],
    ocr_raw: null,
  };
}

export function makeParticipant(fields = {}) {
  return {
    key: newKey(),
    profile_id: null,
    label: '',
    character: null,
    is_cpu: false,
    final_total: null,
    ...fields,
  };
}

// A race counts as complete when every participant has a distinct placement.
export function isRaceComplete(race, participants) {
  if (!race || !participants.length) return false;
  const places = participants.map((p) => race.results[p.key]);
  if (places.some((x) => !Number.isInteger(x) || x < 1 || x > MAX_PLAYERS)) return false;
  return new Set(places).size === places.length && Boolean(String(race.track || '').trim());
}

export function completedRaceCount(draft) {
  return draft.races.filter((r) => isRaceComplete(r, draft.participants)).length;
}

export function validateDraft(draft) {
  const errors = [];
  const ps = draft.participants;
  if (ps.length < 2) errors.push('Add at least 2 karts.');
  if (ps.length > MAX_PLAYERS) errors.push(`A Grand Prix has at most ${MAX_PLAYERS} karts.`);
  if (ps.some((p) => !String(p.label || '').trim())) errors.push('Every kart needs a name.');
  const linked = ps.filter((p) => p.profile_id);
  if (!linked.length) errors.push('Link at least one kart to a group member.');
  if (new Set(linked.map((p) => p.profile_id)).size !== linked.length) {
    errors.push('The same member is linked to two karts.');
  }

  if (draft.mode === 'races') {
    const done = completedRaceCount(draft);
    if (draft.races.length !== RACES_PER_GP || done < RACES_PER_GP) {
      errors.push(
        `Race-by-race entry needs all ${RACES_PER_GP} races (${done} of ${RACES_PER_GP} complete). ` +
          'If you do not have every race, switch to final totals instead.',
      );
    }
  } else if (draft.mode === 'total') {
    ps.forEach((p) => {
      if (!Number.isInteger(p.final_total) || p.final_total < 0 || p.final_total > MAX_GP_TOTAL) {
        errors.push(`${p.label || 'A kart'} needs a total from 0 to ${MAX_GP_TOTAL}.`);
      }
    });
  } else {
    errors.push('Choose how to enter the scores.');
  }
  return { ok: errors.length === 0, errors };
}

// Totals and standard competition ranking ("1, 1, 3").
export function computeStandings(draft) {
  const rows = draft.participants.map((p) => {
    const perRace = draft.mode === 'races'
      ? draft.races.map((r) => {
          const place = r.results[p.key];
          return Number.isInteger(place) ? { place, points: pointsFor(place) } : null;
        })
      : [];
    const total = draft.mode === 'races'
      ? perRace.reduce((s, r) => s + (r ? r.points : 0), 0)
      : p.final_total ?? 0;
    return { key: p.key, label: p.label, profile_id: p.profile_id, character: p.character, is_cpu: p.is_cpu, total, perRace };
  });
  rows.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  rows.forEach((r, i) => {
    r.place = i > 0 && rows[i - 1].total === r.total ? rows[i - 1].place : i + 1;
  });
  return rows;
}

export function toPayload(draft) {
  const v = validateDraft(draft);
  if (!v.ok) throw new Error(v.errors.join(' '));
  return {
    mode: draft.mode,
    source: draft.source,
    participants: draft.participants.map((p) => ({
      key: p.key,
      profile_id: p.profile_id || null,
      label: p.label.trim(),
      character: p.character || null,
      is_cpu: Boolean(p.is_cpu),
      ...(draft.mode === 'total' ? { final_total: p.final_total } : {}),
    })),
    races: draft.mode === 'races'
      ? draft.races.map((r) => ({
          race_number: r.race_number,
          track: r.track.trim(),
          results: draft.participants.map((p) => ({ key: p.key, placement: r.results[p.key] })),
        }))
      : [],
    image_paths: draft.image_paths,
    ocr_raw: draft.ocr_raw,
  };
}

// ---------------------------------------------------------------------
// Photo → draft normalisation (Mario Kart Wii screens, see wii-layout.js)
// ---------------------------------------------------------------------
//
// screens: results of vision.analyzePhoto(), in upload order.
//   kind 'final'                       → GP totals
//   kind 'standings', phase 'totals'   → standings sorted by total; used as GP
//                                        totals when it is the only photo
//   kind 'standings', phase 'race'     → after a race: rows in that race's
//                                        finishing order, "+gained" visible
// Race-by-race upload needs exactly four 'race' screens (the 4-race rule).

function participantsFromRows(rows, identities, profilesById) {
  return rows.map((row, i) => {
    const id = identities?.[i] || {};
    const profile = id.profile_id ? profilesById.get(id.profile_id) : null;
    const read = row.name || `Kart ${row.place}`;
    return makeParticipant({
      profile_id: id.profile_id || null,
      label: profile ? profile.display_name : id.is_cpu ? (row.character || read) : read,
      character: row.character || null,
      is_cpu: Boolean(id.is_cpu),
      ocr_name: row.name,
      suggestion: id,
    });
  });
}

// Race placement for a row on a post-race screen. "+gained" pins it exactly.
export function racePlacementOf(row) {
  if (Number.isInteger(row.gained)) {
    const idx = POINTS.indexOf(row.gained);
    if (idx >= 0) return idx + 1;
  }
  return row.place;
}

const isTotals = (s) => s.kind === 'final' || (s.kind === 'standings' && s.phase === 'totals');
const isRace = (s) => s.kind === 'standings' && s.phase === 'race';

export function draftFromScreens({ screens, identities, profiles, cup }) {
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const draft = emptyDraft(cup);
  const issues = [];
  if (!screens.length) throw new Error('Add a photo first.');
  if (screens.some((s) => s.kind === 'unknown')) {
    throw new Error("One photo doesn't look like a Mario Kart Wii results screen. Retake it straight on, filling the frame with the list.");
  }

  const races = screens.filter(isRace);
  const totals = screens.filter(isTotals);

  if (races.length && races.length !== screens.length) {
    throw new Error('Mixing screens: upload either the final results, or the four after-race screens (the ones showing +points).');
  }

  if (!races.length) {
    if (totals.length !== 1) throw new Error('Upload a single final results photo.');
    const base = totals[0];
    draft.mode = 'total';
    draft.source = 'photo_total';
    draft.participants = participantsFromRows(base.rows, identities, profilesById);
    base.rows.forEach((row, i) => {
      draft.participants[i].final_total = Number.isInteger(row.points) && row.points <= MAX_GP_TOTAL ? row.points : null;
      if (Number.isInteger(row.points) && row.points > MAX_GP_TOTAL) issues.push(`${row.name || `Row ${row.place}`} shows ${row.points} points — more than one Grand Prix's worth. Enter the GP total.`);
    });
    return { draft, issues };
  }

  if (races.length !== RACES_PER_GP) {
    const err = new Error(
      `Race-by-race upload needs all ${RACES_PER_GP} after-race screens; got ${races.length}. ` +
        'Upload the final results photo (or type the final totals) instead.',
    );
    err.code = 'INCOMPLETE_RACES';
    throw err;
  }

  draft.mode = 'races';
  draft.source = 'photo_races';
  const base = races[0];
  draft.participants = participantsFromRows(base.rows, identities, profilesById);

  races.forEach((screen, ri) => {
    const results = {};
    const used = new Set();
    for (const row of screen.rows) {
      // Same kart across photos: the character/Mii name is shown on every screen.
      let best = null;
      draft.participants.forEach((p) => {
        if (used.has(p.key)) return;
        const sim = row.name && p.ocr_name ? similarity(row.name, p.ocr_name) : 0;
        if (!best || sim > best.s) best = { p, s: sim };
      });
      if (!best || best.s < 0.75) {
        issues.push(`Race ${ri + 1}: couldn't match "${row.name ?? `row ${row.place}`}" to a kart from race 1 — set its place by hand.`);
        continue;
      }
      used.add(best.p.key);
      results[best.p.key] = racePlacementOf(row);
    }
    draft.races[ri].results = results;
    if (!isRaceComplete(draft.races[ri], draft.participants)) {
      issues.push(`Race ${ri + 1} is missing placements — fill them in before confirming.`);
    }
  });
  return { draft, issues };
}
