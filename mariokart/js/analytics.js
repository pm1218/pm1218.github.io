// Analytics engine. Pure functions over confirmed Grand Prix data:
//
//   gps = [{ id, event_id, seq, cup, confirmed_at, entry_mode,
//            participants: [{ id, profile_id, label, character, is_cpu, final_total, final_place }],
//            races: [{ race_number, track, results: [{ participant_id, placement, points }] }] }]
//
// Only karts linked to a member (profile_id) are ranked; CPUs and guests
// still count toward field size, so beating a full field is worth more.

import { MAX_GP_TOTAL } from './data.js';

const round = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const stdev = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const byTime = (a, b) => String(a.confirmed_at || '').localeCompare(String(b.confirmed_at || '')) || a.seq - b.seq;

export const POWER_WEIGHTS = { points: 0.45, place: 0.3, wins: 0.15, form: 0.1 };
export const POWER_PRIOR_GPS = 2; // Bayesian shrinkage strength
export const ELO_K = 32;
export const ELO_START = 1500;

// One record per member per GP.
export function playerRecords(gps) {
  const out = new Map();
  for (const gp of [...gps].sort(byTime)) {
    const field = gp.participants.length;
    for (const p of gp.participants) {
      if (!p.profile_id) continue;
      const rec = {
        gp_id: gp.id,
        event_id: gp.event_id,
        total: p.final_total,
        place: p.final_place,
        field,
        character: p.character,
        normPts: p.final_total / MAX_GP_TOTAL,
        placeScore: field > 1 ? (field - p.final_place) / (field - 1) : 1,
        won: p.final_place === 1,
        podium: p.final_place <= 3,
      };
      if (!out.has(p.profile_id)) out.set(p.profile_id, []);
      out.get(p.profile_id).push(rec);
    }
  }
  return out;
}

function ewma(xs, alpha = 0.5) {
  if (!xs.length) return null;
  return xs.slice(1).reduce((acc, x) => alpha * x + (1 - alpha) * acc, xs[0]);
}

/**
 * Power ranking (0-100):
 *   raw   = 0.45·(avg points / 60) + 0.30·(avg field-relative place score)
 *         + 0.15·(win rate) + 0.10·(form = EWMA of points share, α=0.5)
 *   power = 100 · (n·raw + k·fieldMean) / (n + k),  k = 2 GPs
 * The shrinkage keeps someone who won their only GP from outranking a
 * player who has won 6 of 10.
 */
export function powerRankings(gps, profiles) {
  const records = playerRecords(gps);
  const rows = [];
  for (const [profileId, recs] of records) {
    const avgPts = mean(recs.map((r) => r.total));
    const raw =
      POWER_WEIGHTS.points * mean(recs.map((r) => r.normPts)) +
      POWER_WEIGHTS.place * mean(recs.map((r) => r.placeScore)) +
      POWER_WEIGHTS.wins * mean(recs.map((r) => (r.won ? 1 : 0))) +
      POWER_WEIGHTS.form * ewma(recs.map((r) => r.normPts));
    rows.push({
      profile_id: profileId,
      gps: recs.length,
      avgPts,
      avgPlace: mean(recs.map((r) => r.place)),
      winRate: mean(recs.map((r) => (r.won ? 1 : 0))),
      podiumRate: mean(recs.map((r) => (r.podium ? 1 : 0))),
      form: ewma(recs.map((r) => r.total)),
      raw,
    });
  }
  const fieldMean = mean(rows.map((r) => r.raw)) ?? 0;
  const names = new Map(profiles.map((p) => [p.id, p.display_name]));
  return rows
    .map(({ raw, ...r }) => ({
      ...r,
      name: names.get(r.profile_id) ?? 'Unknown',
      power: round((100 * (r.gps * raw + POWER_PRIOR_GPS * fieldMean)) / (r.gps + POWER_PRIOR_GPS)),
      avgPts: round(r.avgPts),
      avgPlace: round(r.avgPlace, 2),
      winRate: round(r.winRate * 100, 0),
      podiumRate: round(r.podiumRate * 100, 0),
      form: round(r.form),
    }))
    .sort((a, b) => b.power - a.power || b.avgPts - a.avgPts)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

/**
 * Multiplayer Elo across every confirmed GP (lifetime skill rating).
 * Each GP is treated as all pairwise duels between members by final total;
 * K is split across opponents so a 12-kart GP moves ratings no more than a duel.
 */
export function eloRatings(gps, profiles) {
  const rating = new Map();
  const played = new Map();
  for (const gp of [...gps].sort(byTime)) {
    const humans = gp.participants.filter((p) => p.profile_id);
    if (humans.length < 2) continue;
    const before = new Map(humans.map((p) => [p.profile_id, rating.get(p.profile_id) ?? ELO_START]));
    for (const a of humans) {
      let delta = 0;
      for (const b of humans) {
        if (a === b) continue;
        const ra = before.get(a.profile_id);
        const rb = before.get(b.profile_id);
        const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
        const actual = a.final_total > b.final_total ? 1 : a.final_total === b.final_total ? 0.5 : 0;
        delta += actual - expected;
      }
      rating.set(a.profile_id, before.get(a.profile_id) + (ELO_K / (humans.length - 1)) * delta);
      played.set(a.profile_id, (played.get(a.profile_id) || 0) + 1);
    }
  }
  const names = new Map(profiles.map((p) => [p.id, p.display_name]));
  return [...rating.entries()]
    .map(([id, r]) => ({ profile_id: id, name: names.get(id) ?? 'Unknown', elo: Math.round(r), gps: played.get(id) }))
    .sort((a, b) => b.elo - a.elo)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

// Every race result for members, flattened.
export function raceRecords(gps) {
  const out = [];
  for (const gp of gps) {
    const byId = new Map(gp.participants.map((p) => [p.id, p]));
    for (const race of gp.races || []) {
      for (const res of race.results) {
        const p = byId.get(res.participant_id);
        if (!p?.profile_id) continue;
        out.push({ profile_id: p.profile_id, gp_id: gp.id, race_number: race.race_number, track: race.track, placement: res.placement, points: res.points, field: gp.participants.length });
      }
    }
  }
  return out;
}

/**
 * Consistency:
 *   gpStdev      – standard deviation of GP totals
 *   cv           – coefficient of variation (stdev / mean), scale-free
 *   volatility   – mean |Δ total| between consecutive GPs (session-to-session swing)
 *   raceStdev    – standard deviation of race placements (race-mode GPs)
 *   consistency  – 0-100 = 100 · σ_random / (σ_random + σ), where σ is the stdev of
 *                  field-relative race placement (0 = 1st, 1 = last) and σ_random
 *                  is what a uniformly random finisher in the same field size
 *                  would show: √((n+1) / (12(n−1))). 100 = same place every race,
 *                  50 = as scattered as a random finisher, lower = streakier. Falls back to GP places when no
 *                  race-level data exists.
 */
export function consistencyMetrics(gps, profiles) {
  const records = playerRecords(gps);
  const races = raceRecords(gps);
  const names = new Map(profiles.map((p) => [p.id, p.display_name]));
  const rows = [];
  for (const [id, recs] of records) {
    const totals = recs.map((r) => r.total);
    const mine = races.filter((r) => r.profile_id === id);
    const relRace = mine.map((r) => (r.field > 1 ? (r.placement - 1) / (r.field - 1) : 0));
    const relGp = recs.map((r) => 1 - r.placeScore);
    const useRaces = relRace.length >= 4;
    const spread = stdev(useRaces ? relRace : relGp);
    const fields = useRaces ? mine.map((r) => r.field) : recs.map((r) => r.field);
    const sdRandom = mean(fields.filter((n) => n > 1).map((n) => Math.sqrt((n + 1) / (12 * (n - 1)))));
    const sd = stdev(totals);
    const m = mean(totals);
    const swings = totals.slice(1).map((t, i) => Math.abs(t - totals[i]));
    rows.push({
      profile_id: id,
      name: names.get(id) ?? 'Unknown',
      gps: recs.length,
      races: mine.length,
      gpStdev: round(sd),
      cv: sd === null || !m ? null : round(sd / m, 2),
      volatility: round(mean(swings)),
      raceStdev: round(stdev(mine.map((r) => r.placement)), 2),
      consistency: spread === null || !sdRandom ? null : Math.round((100 * sdRandom) / (sdRandom + spread)),
    });
  }
  return rows.sort((a, b) => (b.consistency ?? -1) - (a.consistency ?? -1));
}

// Average placement per track for every member, plus best/worst tracks.
export function trackStats(gps, profiles) {
  const names = new Map(profiles.map((p) => [p.id, p.display_name]));
  const agg = new Map();
  for (const r of raceRecords(gps)) {
    const key = `${r.profile_id}|${r.track}`;
    if (!agg.has(key)) agg.set(key, { profile_id: r.profile_id, track: r.track, places: [], points: [] });
    agg.get(key).places.push(r.placement);
    agg.get(key).points.push(r.points);
  }
  const perTrack = [...agg.values()].map((a) => ({
    profile_id: a.profile_id,
    name: names.get(a.profile_id) ?? 'Unknown',
    track: a.track,
    races: a.places.length,
    avgPlace: round(mean(a.places), 2),
    avgPoints: round(mean(a.points)),
  }));

  const byPlayer = new Map();
  for (const t of perTrack) {
    if (!byPlayer.has(t.profile_id)) byPlayer.set(t.profile_id, []);
    byPlayer.get(t.profile_id).push(t);
  }
  const bestWorst = [...byPlayer.entries()].map(([id, ts]) => {
    const sorted = [...ts].sort((a, b) => a.avgPlace - b.avgPlace || b.races - a.races);
    // Best and worst never list the same track.
    const best = sorted.slice(0, Math.min(3, Math.ceil(sorted.length / 2)));
    const worst = sorted.slice(best.length).slice(-3).reverse();
    return { profile_id: id, name: names.get(id) ?? 'Unknown', best, worst };
  });

  const trackOverall = new Map();
  for (const t of perTrack) {
    if (!trackOverall.has(t.track)) trackOverall.set(t.track, []);
    trackOverall.get(t.track).push(t);
  }
  const trackKings = [...trackOverall.entries()].map(([track, ts]) => {
    const king = [...ts].sort((a, b) => a.avgPlace - b.avgPlace || b.races - a.races)[0];
    return { track, king: king.name, avgPlace: king.avgPlace, races: ts.reduce((s, t) => s + t.races, 0) };
  }).sort((a, b) => a.track.localeCompare(b.track));

  return { perTrack, bestWorst, trackKings };
}

// Head-to-head between two members.
export function headToHead(gps, aId, bId) {
  const res = { gps: 0, aWins: 0, bWins: 0, ties: 0, avgMargin: null, races: 0, aRaceWins: 0, bRaceWins: 0 };
  const margins = [];
  for (const gp of gps) {
    const a = gp.participants.find((p) => p.profile_id === aId);
    const b = gp.participants.find((p) => p.profile_id === bId);
    if (!a || !b) continue;
    res.gps++;
    margins.push(a.final_total - b.final_total);
    if (a.final_total > b.final_total) res.aWins++;
    else if (b.final_total > a.final_total) res.bWins++;
    else res.ties++;
    for (const race of gp.races || []) {
      const ra = race.results.find((r) => r.participant_id === a.id);
      const rb = race.results.find((r) => r.participant_id === b.id);
      if (!ra || !rb) continue;
      res.races++;
      if (ra.placement < rb.placement) res.aRaceWins++;
      else res.bRaceWins++;
    }
  }
  res.avgMargin = round(mean(margins));
  return res;
}

// Win-rate matrix for every pair of members who have met.
export function headToHeadMatrix(gps, profiles) {
  const ids = [...playerRecords(gps).keys()];
  const names = new Map(profiles.map((p) => [p.id, p.display_name]));
  const cells = [];
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const h = headToHead(gps, a, b);
      if (h.gps) cells.push({ a, b, aName: names.get(a), bName: names.get(b), ...h, winPct: Math.round((100 * (h.aWins + h.ties / 2)) / h.gps) });
    }
  }
  return { players: ids.map((id) => ({ id, name: names.get(id) ?? 'Unknown' })), cells };
}

/**
 * Extra insights:
 *   clutch     – avg race-4 placement minus avg races 1-3 placement (negative = finishes strong)
 *   comebacks  – GPs won after placing 4th or worse in race 1
 *   streak     – longest run of consecutive GP wins
 *   bestGp     – highest single-GP total
 *   characters – avg GP total by character driven
 */
export function insights(gps, profiles) {
  const names = new Map(profiles.map((p) => [p.id, p.display_name]));
  const records = playerRecords(gps);
  const races = raceRecords(gps);
  const out = [];
  for (const [id, recs] of records) {
    const mine = races.filter((r) => r.profile_id === id);
    const r4 = mine.filter((r) => r.race_number === 4).map((r) => r.placement);
    const r13 = mine.filter((r) => r.race_number < 4).map((r) => r.placement);
    let streak = 0;
    let best = 0;
    for (const r of recs) {
      streak = r.won ? streak + 1 : 0;
      best = Math.max(best, streak);
    }
    const comebacks = recs.filter((rec) => {
      if (!rec.won) return false;
      const first = mine.find((r) => r.gp_id === rec.gp_id && r.race_number === 1);
      return first && first.placement >= 4;
    }).length;
    const chars = new Map();
    for (const r of recs) {
      if (!r.character) continue;
      if (!chars.has(r.character)) chars.set(r.character, []);
      chars.get(r.character).push(r.total);
    }
    out.push({
      profile_id: id,
      name: names.get(id) ?? 'Unknown',
      clutch: r4.length && r13.length ? round(mean(r4) - mean(r13), 2) : null,
      comebacks,
      winStreak: best,
      bestGp: Math.max(...recs.map((r) => r.total)),
      perfectGps: recs.filter((r) => r.total === MAX_GP_TOTAL).length,
      characters: [...chars.entries()].map(([c, ts]) => ({ character: c, gps: ts.length, avgPts: round(mean(ts)) })).sort((a, b) => b.avgPts - a.avgPts),
    });
  }
  return out;
}

// Everything for one page in one call.
export function fullReport(gps, profiles) {
  const confirmed = gps.filter((g) => g.participants?.length);
  return {
    power: powerRankings(confirmed, profiles),
    elo: eloRatings(confirmed, profiles),
    consistency: consistencyMetrics(confirmed, profiles),
    tracks: trackStats(confirmed, profiles),
    h2h: headToHeadMatrix(confirmed, profiles),
    insights: insights(confirmed, profiles),
    gpCount: confirmed.length,
  };
}
