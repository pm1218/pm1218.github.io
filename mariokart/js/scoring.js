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

import { MAX_GP_TOTAL, MAX_PLAYERS, POINTS, RACES_PER_GP, pointsFor } from './data.js';
import { similarity } from './text.js';

let keySeq = 0;
export const newKey = () => `k${Date.now().toString(36)}${(keySeq++).toString(36)}`;

// VS sessions: 4 races on random tracks, so tracks start blank (optional).
export function emptyDraft() {
  return {
    mode: 'total',
    source: 'manual_total',
    participants: [],
    races: Array.from({ length: RACES_PER_GP }, (_, i) => ({ race_number: i + 1, track: '', results: {} })),
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
  return new Set(places).size === places.length;
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
  if (ps.some((p) => p.is_cpu)) errors.push('CPU players are not tracked — remove them.');
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
          track: String(r.track || '').trim() || null,
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
      label: profile ? profile.display_name : read,
      character: row.character || null,
      is_cpu: Boolean(id.is_cpu),
      ocr_name: row.name,
      row_index: i,
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

/**
 * Photo screens → draft. Only players are tracked: rows identified as CPUs
 * are left out of the draft and returned as `extras`, so the uploader can
 * add one back if the photo reader mistook a player for a CPU.
 * Returns { draft, issues, extras: [{ key, name, character, place, final_total | places[] }] }.
 */
export function draftFromScreens({ screens, identities, profiles }) {
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const draft = emptyDraft();
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

  let candidates;
  if (!races.length) {
    if (totals.length !== 1) throw new Error('Upload a single final results photo.');
    const base = totals[0];
    draft.mode = 'total';
    draft.source = 'photo_total';
    candidates = participantsFromRows(base.rows, identities, profilesById);
    base.rows.forEach((row, i) => {
      candidates[i].place = row.place;
      candidates[i].final_total = Number.isInteger(row.points) && row.points <= MAX_GP_TOTAL ? row.points : null;
      if (Number.isInteger(row.points) && row.points > MAX_GP_TOTAL && !candidates[i].is_cpu) {
        issues.push(`${candidates[i].label} shows ${row.points} points — more than 4 races' worth. Enter the total for these 4 races.`);
      }
    });
  } else {
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
    candidates = participantsFromRows(base.rows, identities, profilesById);
    base.rows.forEach((row, i) => { candidates[i].place = row.place; candidates[i].places = [null, null, null, null]; });
    races.forEach((screen, ri) => {
      const used = new Set();
      for (const row of screen.rows) {
        // Same kart across photos: the character/Mii name is on every screen.
        let best = null;
        candidates.forEach((p) => {
          if (used.has(p.key)) return;
          const sim = row.name && p.ocr_name ? similarity(row.name, p.ocr_name) : 0;
          if (!best || sim > best.s) best = { p, s: sim };
        });
        if (!best || best.s < 0.75) continue;
        used.add(best.p.key);
        best.p.places[ri] = racePlacementOf(row);
      }
    });
  }

  const players = candidates.filter((p) => !p.is_cpu);
  const extras = candidates.filter((p) => p.is_cpu).map((p) => ({
    key: p.key, name: p.ocr_name, character: p.character, place: p.place, row_index: p.row_index,
    ...(draft.mode === 'total' ? { final_total: p.final_total } : { places: p.places }),
  }));
  draft.participants = players.map(({ place, places, ...p }) => p);
  if (draft.mode === 'races') {
    draft.races.forEach((r, ri) => {
      r.results = {};
      for (const p of players) if (p.places[ri]) r.results[p.key] = p.places[ri];
      if (!isRaceComplete(r, draft.participants)) issues.push(`Race ${ri + 1} is missing a placement for a player — fill it in before confirming.`);
    });
  }
  if (!players.length) issues.push('No players were spotted on the photo — add them from the list of rows below.');
  return { draft, issues, extras };
}

/** Add a row the photo reader called a CPU back in as a player. */
export function addExtraAsPlayer(draft, extra) {
  const p = makeParticipant({ key: extra.key, label: extra.name || `Kart ${extra.place}`, character: extra.character || null, ocr_name: extra.name, row_index: extra.row_index });
  if (draft.mode === 'total') p.final_total = extra.final_total ?? null;
  draft.participants.push(p);
  if (draft.mode === 'races' && extra.places) {
    extra.places.forEach((place, ri) => { if (place) draft.races[ri].results[p.key] = place; });
  }
  return p;
}
