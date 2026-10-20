// Analytics engine. Pure functions over confirmed Grand Prix data:
//
//   gps = [{ id, event_id, seq, cup, confirmed_at, entry_mode,
//            participants: [{ id, profile_id, label, character, is_cpu, final_total, final_place }],
//            races: [{ race_number, track, results: [{ participant_id, placement, points }] }] }]
//
// Only players linked to a member (profile_id) are ranked. Sessions store
// players only (no CPUs), so GP places are among the players; race
// placements stay out of 12 karts.

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
        // Race placements are out of all 12 karts (CPUs race but aren't tracked).
        out.push({ profile_id: p.profile_id, gp_id: gp.id, race_number: race.race_number, track: race.track || null, placement: res.placement, points: res.points, field: 12 });
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
    if (!r.track) continue; // VS tracks are optional
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

/**
 * Track stats from every confirmed session that recorded tracks — including
 * final-total sessions, which list the tracks played but no placements.
 *
 * overall:   per track — times played, sessions, players' average race
 *            placement (out of 12, where placements were entered), wins, and
 *            the player who does best there
 * players:   per member, per track — times played, average placement and
 *            points, wins, and their average finish among the players in
 *            sessions that included the track (works for final-total uploads)
 */
export function trackReport(gps, profiles) {
  const names = new Map(profiles.map((p) => [p.id, p.display_name]));
  const tracks = new Map();
  const per = new Map(); // `${profile}|${track}` → stats
  const getT = (t) => { if (!tracks.has(t)) tracks.set(t, { track: t, plays: 0, sessions: new Set(), places: [], wins: new Map(), byPlayer: new Map() }); return tracks.get(t); };
  const getP = (pid, t) => {
    const k = `${pid}|${t}`;
    if (!per.has(k)) per.set(k, { profile_id: pid, track: t, plays: 0, places: [], points: [], wins: 0, podiums: 0, sessionPlaces: [], sessions: new Set() });
    return per.get(k);
  };
  for (const gp of gps) {
    const members = gp.participants.filter((p) => p.profile_id);
    for (const race of gp.races || []) {
      if (!race.track) continue;
      const T = getT(race.track);
      T.plays++;
      T.sessions.add(gp.id);
      for (const m of members) {
        const P = getP(m.profile_id, race.track);
        P.plays++;
        if (!P.sessions.has(gp.id)) { P.sessions.add(gp.id); P.sessionPlaces.push(m.final_place); }
        const res = (race.results || []).find((r) => r.participant_id === m.id);
        if (!res) continue;
        P.places.push(res.placement); P.points.push(res.points);
        if (res.placement === 1) { P.wins++; T.wins.set(m.profile_id, (T.wins.get(m.profile_id) || 0) + 1); }
        if (res.placement <= 3) P.podiums++;
        T.places.push(res.placement);
        if (!T.byPlayer.has(m.profile_id)) T.byPlayer.set(m.profile_id, []);
        T.byPlayer.get(m.profile_id).push(res.placement);
      }
    }
  }
  const overall = [...tracks.values()].map((T) => {
    const best = [...T.byPlayer.entries()].map(([pid, pl]) => ({ pid, avg: mean(pl), n: pl.length }))
      .sort((a, b) => a.avg - b.avg || b.n - a.n)[0];
    const topWinner = [...T.wins.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      track: T.track,
      plays: T.plays,
      sessions: T.sessions.size,
      placedRaces: T.places.length,
      avgPlace: round(mean(T.places), 2),
      best: best ? { name: names.get(best.pid) ?? 'Unknown', avgPlace: round(best.avg, 2), races: best.n } : null,
      mostWins: topWinner ? { name: names.get(topWinner[0]) ?? 'Unknown', wins: topWinner[1] } : null,
    };
  }).sort((a, b) => b.plays - a.plays || a.track.localeCompare(b.track));

  const byPlayer = new Map();
  for (const P of per.values()) {
    if (!byPlayer.has(P.profile_id)) byPlayer.set(P.profile_id, []);
    byPlayer.get(P.profile_id).push({
      track: P.track,
      plays: P.plays,
      placedRaces: P.places.length,
      avgPlace: round(mean(P.places), 2),
      avgPoints: round(mean(P.points)),
      wins: P.wins,
      podiums: P.podiums,
      avgSessionPlace: round(mean(P.sessionPlaces), 2),
    });
  }
  // Best first: by race placement where known, else by session finish.
  const key = (t) => (t.avgPlace ?? 99) * 100 + (t.avgSessionPlace ?? 99);
  const players = [...byPlayer.entries()].map(([pid, ts]) => ({
    profile_id: pid,
    name: names.get(pid) ?? 'Unknown',
    tracks: ts.sort((a, b) => key(a) - key(b) || b.plays - a.plays),
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { overall, players, trackCount: overall.length, plays: overall.reduce((s, t) => s + t.plays, 0) };
}

/**
 * Live leaderboard for one event: per player sessions, wins, podiums, total
 * and average points, average finish. Ordered by wins, then average points.
 */
export function eventSummary(gps, profiles) {
  const names = new Map(profiles.map((p) => [p.id, p.display_name]));
  const confirmed = [...gps].filter((g) => g.participants?.length).sort(byTime);
  const agg = new Map();
  for (const gp of confirmed) {
    for (const p of gp.participants) {
      if (!p.profile_id) continue;
      const a = agg.get(p.profile_id) ?? { profile_id: p.profile_id, name: names.get(p.profile_id) ?? p.label, sessions: 0, wins: 0, podiums: 0, points: 0, places: [] };
      a.sessions++; a.points += p.final_total; a.places.push(p.final_place);
      if (p.final_place === 1) a.wins++;
      if (p.final_place <= 3) a.podiums++;
      agg.set(p.profile_id, a);
    }
  }
  const rows = [...agg.values()].map(({ places, ...a }) => ({ ...a, avgPts: round(a.points / a.sessions), avgPlace: round(mean(places), 2) }))
    .sort((a, b) => b.wins - a.wins || b.avgPts - a.avgPts || b.points - a.points)
    .map((r, i) => ({ rank: i + 1, ...r }));
  const last = confirmed[confirmed.length - 1] || null;
  const lastWinner = last ? last.participants.find((p) => p.final_place === 1) : null;
  return { rows, sessions: confirmed.length, last: last && { seq: last.seq, confirmed_at: last.confirmed_at, winner: lastWinner ? (names.get(lastWinner.profile_id) ?? lastWinner.label) : null, points: lastWinner?.final_total ?? null } };
}

export const AUTO_FINALIZE_HOURS = 12;

/** Last upload activity for an event row with its grand_prix(created_at, confirmed_at). */
export function eventLastActivity(ev) {
  const times = [ev.created_at, ...(ev.grand_prix || []).flatMap((g) => [g.created_at, g.confirmed_at])].filter(Boolean).map((t) => new Date(t).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

/** 'live' | 'final', and when a live event will auto-finalize. */
export function eventState(ev, now = Date.now()) {
  if (ev.finalized_at) return { state: 'final', finalizedAt: new Date(ev.finalized_at) };
  const last = eventLastActivity(ev);
  const autoAt = last ? new Date(last.getTime() + AUTO_FINALIZE_HOURS * 3600e3) : null;
  if (autoAt && autoAt.getTime() <= now) return { state: 'final', finalizedAt: autoAt };
  return { state: 'live', lastActivity: last, autoFinalizeAt: autoAt };
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
