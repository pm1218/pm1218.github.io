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
// Photo → draft normalisation
// ---------------------------------------------------------------------

function participantsFromRows(rows, identities, profilesById) {
  return rows.map((row, i) => {
    const id = identities?.[i] || {};
    const profile = id.profile_id ? profilesById.get(id.profile_id) : null;
    return makeParticipant({
      profile_id: id.profile_id || null,
      label: profile ? profile.display_name : row.name || `Kart ${row.place}`,
      character: row.character || row.cpuCharacter || null,
      is_cpu: Boolean(id.is_cpu),
      ocr_name: row.name,
      suggestion: id,
    });
  });
}

// Race placement for a row on a post-race screen. "+gained" pins it exactly,
// which also covers photos taken after the game re-sorted rows by total.
export function racePlacementOf(row) {
  if (Number.isInteger(row.gained)) {
    const idx = POINTS.indexOf(row.gained);
    if (idx >= 0) return idx + 1;
  }
  return row.place;
}

/**
 * screens: parsed screens in order. Either exactly one 'final' screen, or
 * race screens. Fewer than four race screens is rejected here exactly as
 * the server would, so the uploader is told to use the final total instead.
 */
export function draftFromScreens({ screens, identities, profiles, cup }) {
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const draft = emptyDraft(cup);
  const finals = screens.filter((s) => s.kind === 'final');
  const races = screens.filter((s) => s.kind === 'race');
  const issues = [];

  if (finals.length && races.length) {
    throw new Error('Upload either the final standings screen or the four race screens, not both.');
  }

  if (finals.length) {
    if (finals.length > 1) throw new Error('Upload a single final standings screen.');
    const base = finals[0];
    draft.mode = 'total';
    draft.source = 'photo_total';
    draft.participants = participantsFromRows(base.rows, identities, profilesById);
    base.rows.forEach((row, i) => {
      draft.participants[i].final_total = Number.isInteger(row.points) && row.points <= MAX_GP_TOTAL ? row.points : null;
    });
    return { draft, issues };
  }

  if (races.length !== RACES_PER_GP) {
    const err = new Error(
      `Race-by-race upload needs all ${RACES_PER_GP} race screens; got ${races.length}. ` +
        'Upload the final standings screen (or type the final totals) instead.',
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
      // Match this row to a base participant by OCR'd name.
      let best = null;
      draft.participants.forEach((p) => {
        if (used.has(p.key)) return;
        const s = similarity(row.name, p.ocr_name || p.label);
        if (!best || s > best.s) best = { p, s };
      });
      if (!best || best.s < 0.6) {
        issues.push(`Race ${ri + 1}: could not match "${row.name}" to a kart from race 1.`);
        continue;
      }
      used.add(best.p.key);
      results[best.p.key] = racePlacementOf(row);
    }
    draft.races[ri].results = results;
    if (!isRaceComplete(draft.races[ri], draft.participants)) {
      issues.push(`Race ${ri + 1} is missing placements — fix them before confirming.`);
    }
  });
  return { draft, issues };
}
