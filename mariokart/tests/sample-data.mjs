// A small realistic dataset: one trip, three confirmed Grand Prix (two entered
// race-by-race, one as final totals). Used by the tests and the README examples.
import { pointsFor } from '../js/data.js';

export const profiles = [
  { id: 'u-pm', display_name: 'Prateek', mii_name: 'PRATEEK', favorite_character: 'Yoshi' },
  { id: 'u-an', display_name: 'Anya', mii_name: 'Anya', favorite_character: 'Peach' },
  { id: 'u-dv', display_name: 'Dev', mii_name: 'DevK', favorite_character: 'Bowser' },
  { id: 'u-sa', display_name: 'Sam', mii_name: 'Sammy', favorite_character: 'Yoshi' },
];

function raceGp(id, seq, cup, confirmedAt, karts, placements, tracks) {
  const participants = karts.map(([pid, label, character], i) => ({ id: `${id}-p${i}`, profile_id: pid, label, character, is_cpu: !pid }));
  const races = placements.map((places, ri) => ({
    race_number: ri + 1,
    track: tracks[ri],
    results: places.map((place, pi) => ({ participant_id: participants[pi].id, placement: place, points: pointsFor(place) })),
  }));
  participants.forEach((p, pi) => { p.final_total = placements.reduce((s, r) => s + pointsFor(r[pi]), 0); });
  const sorted = [...participants].sort((a, b) => b.final_total - a.final_total);
  participants.forEach((p) => { p.final_place = sorted.findIndex((q) => q.final_total === p.final_total) + 1; });
  return { id, event_id: 'ev-lake', seq, cup, confirmed_at: confirmedAt, entry_mode: 'races', participants, races };
}

const karts = [['u-pm', 'Prateek', 'Yoshi'], ['u-an', 'Anya', 'Peach'], ['u-dv', 'Dev', 'Bowser'], [null, 'Mario', 'Mario']];

export const gps = [
  raceGp('gp1', 1, 'Mushroom', '2026-10-17T19:00:00Z', karts,
    [[1, 2, 4, 3], [3, 1, 2, 4], [1, 3, 2, 5], [2, 1, 6, 3]],
    ['Luigi Circuit', 'Moo Moo Meadows', 'Mushroom Gorge', "Toad's Factory"]),
  raceGp('gp2', 2, 'Flower', '2026-10-17T19:30:00Z', karts,
    [[2, 1, 3, 4], [1, 4, 2, 3], [5, 1, 2, 3], [4, 2, 1, 3]],
    ['Mario Circuit', 'Coconut Mall', 'DK Summit', "Wario's Gold Mine"]),
  {
    // Final totals only, with the 4 tracks recorded (no placements).
    id: 'gp3', event_id: 'ev-lake', seq: 3, cup: null, confirmed_at: '2026-10-18T20:00:00Z', entry_mode: 'total',
    races: [['Coconut Mall', 1], ['Rainbow Road', 2], ['DK Summit', 3], ['Luigi Circuit', 4]].map(([track, n]) => ({ race_number: n, track, results: [] })),
    participants: [
      { id: 'gp3-p0', profile_id: 'u-pm', label: 'Prateek', character: 'Yoshi', is_cpu: false, final_total: 49, final_place: 1 },
      { id: 'gp3-p1', profile_id: 'u-an', label: 'Anya', character: 'Peach', is_cpu: false, final_total: 44, final_place: 2 },
      { id: 'gp3-p2', profile_id: 'u-sa', label: 'Sam', character: 'Yoshi', is_cpu: false, final_total: 38, final_place: 3 },
      { id: 'gp3-p3', profile_id: 'u-dv', label: 'Dev', character: 'Bowser', is_cpu: false, final_total: 31, final_place: 4 },
    ],
  },
];
