// Stats: live events pinned on top, then rankings, ratings, head to head, tracks.
import * as api from '../api.js';
import { ordinal } from '../data.js';
import { consistencyMetrics, eloRatings, eventState, eventSummary, headToHead, headToHeadMatrix, insights, powerRankings, trackReport } from '../analytics.js';
import { clear, emptyState, fmtDateTime, h, selectEl, spinner, table } from '../ui.js';
import { go, page, profileName, state } from '../core.js';
import { summaryTable } from './widgets.js';

function liveCard(ev, gps) {
  const st = eventState(ev);
  const sum = eventSummary(gps, state.profiles);
  return h('section', { class: 'card live-card' },
    h('div', { class: 'row-between' },
      h('a', { href: `#/events/${ev.id}`, class: 'live-title' }, h('span', { class: 'pill live' }, 'LIVE'), ' ', ev.name),
      h('a', { href: `#/stats/${ev.id}`, class: 'small' }, 'Event stats →')),
    h('p', { class: 'muted small' }, `${sum.sessions} session${sum.sessions === 1 ? '' : 's'} so far`,
      st.autoFinalizeAt ? ` · ends ${fmtDateTime(st.autoFinalizeAt)} unless more scores are uploaded` : ''),
    sum.rows.length ? summaryTable(sum) : h('p', { class: 'muted' }, 'Waiting for the first scores.'));
}

function powerTable(rows) {
  return table(['Player', 'Power', 'Sessions', 'Opp. strength', 'Avg pts', 'Avg place', 'Wins', 'Podium', 'Form'],
    rows.map((r) => [`${r.rank}. ${r.name}`, h('strong', {}, r.power), r.gps, r.sos, r.avgPts, r.avgPlace, `${r.winRate}%`, `${r.podiumRate}%`, r.form]));
}

export async function viewStats(eventId) {
  page('Stats', spinner());
  // One fetch of every confirmed session, filtered here for the chosen
  // scope and for each live event.
  const [events, allGps] = await Promise.all([api.listEvents(), api.confirmedGps()]);
  const gps = eventId ? allGps.filter((g) => g.event_id === eventId) : allGps;
  const scope = selectEl([{ value: '', label: 'All time (lifetime)' }, ...events.map((e) => ({ value: e.id, label: e.name }))], eventId || '', { 'aria-label': 'Scope' });
  scope.addEventListener('change', () => go(scope.value ? `#/stats/${scope.value}` : '#/stats'));
  const header = h('div', { class: 'card tight' }, h('label', {}, 'Showing'), scope);
  // Live events stay pinned at the top until they are finalized.
  const liveEvents = events.filter((e) => eventState(e).state === 'live');
  const live = liveEvents.map((e) => liveCard(e, allGps.filter((g) => g.event_id === e.id)));
  if (!gps.length) return page('Stats', ...live, header, emptyState('No confirmed sessions yet', 'Stats appear once scores are confirmed.'));

  const P = state.profiles;
  // Strength of each player comes from all sessions, even in an event view.
  const power = powerRankings(gps, P, { history: allGps });
  const elo = eloRatings(gps, P);
  const cons = consistencyMetrics(gps, P);
  const tracks = trackReport(gps, P);
  const h2hM = headToHeadMatrix(gps, P);
  const ins = insights(gps, P);
  const raceGps = gps.filter((g) => g.entry_mode === 'races').length;

  // Head-to-head picker
  const players = h2hM.players;
  const aSel = selectEl(players.map((p) => ({ value: p.id, label: p.name })), players[0]?.id, { 'aria-label': 'Player A' });
  const bSel = selectEl(players.map((p) => ({ value: p.id, label: p.name })), players[1]?.id, { 'aria-label': 'Player B' });
  const h2hOut = h('div', {});
  const drawH2h = () => {
    const a = aSel.value; const b = bSel.value;
    if (!a || !b || a === b) return clear(h2hOut).append(h('p', { class: 'muted' }, 'Pick two different players.'));
    const r = headToHead(gps, a, b);
    clear(h2hOut).append(r.gps
      ? h('div', { class: 'h2h' },
          h('div', { class: 'h2h-score' }, h('span', {}, profileName(a)), h('strong', {}, `${r.aWins} – ${r.bWins}`), h('span', {}, profileName(b))),
          h('p', { class: 'muted small' }, `${r.gps} session${r.gps === 1 ? '' : 's'} together${r.ties ? `, ${r.ties} tied` : ''} · avg margin ${r.avgMargin > 0 ? '+' : ''}${r.avgMargin} pts for ${profileName(a)}`),
          r.races ? h('p', { class: 'muted small' }, `Races: ${r.aRaceWins} – ${r.bRaceWins} (${r.races} head-to-head races)`) : null)
      : h('p', { class: 'muted' }, 'These two haven’t raced in the same session yet.'));
  };
  aSel.addEventListener('change', drawH2h); bSel.addEventListener('change', drawH2h); drawH2h();

  // Track filter
  // Tracks: overall, then one player at a time (picker), best tracks first.
  const dash = (v) => (v === null || v === undefined ? '—' : v);
  const trackPlayer = selectEl(tracks.players.map((p) => ({ value: p.profile_id, label: p.name })), tracks.players.find((p) => p.profile_id === state.me.profile.id)?.profile_id ?? tracks.players[0]?.profile_id, { 'aria-label': 'Player for track stats' });
  const trackOut = h('div', {});
  const drawTracks = () => {
    const pl = tracks.players.find((p) => p.profile_id === trackPlayer.value);
    if (!pl) return clear(trackOut).append(h('p', { class: 'muted' }, 'No tracks recorded for this player yet.'));
    const withPlace = pl.tracks.filter((t) => t.avgPlace !== null);
    const ranked = withPlace.length >= 2 ? withPlace : pl.tracks.filter((t) => t.avgSessionPlace !== null);
    const best = ranked.slice(0, Math.min(3, Math.ceil(ranked.length / 2)));
    const worst = ranked.slice(best.length).slice(-3).reverse();
    const key = (t) => (t.avgPlace ?? t.avgSessionPlace);
    const fmt = (t) => `${t.track} (${t.avgPlace !== null ? `avg ${ordinal(Math.round(t.avgPlace))}` : `${t.avgSessionPlace} session avg`})`;
    clear(trackOut).append(...[
      // Only call tracks best/worst when they actually differ.
      ranked.length >= 2 && key(ranked[0]) !== key(ranked[ranked.length - 1]) ? h('div', { class: 'bw' },
        h('p', { class: 'ok-text small' }, '▲ Best: ', best.map(fmt).join(', ')),
        worst.length ? h('p', { class: 'warn-text small' }, '▼ Worst: ', worst.map(fmt).join(', ')) : null) : null,
      table(['Track', 'Played', 'Avg place', 'Avg pts', 'Wins', 'Session avg'],
        pl.tracks.map((t) => [t.track, t.plays, t.avgPlace !== null ? `${t.avgPlace} (${t.placedRaces})` : '—', dash(t.avgPoints), t.wins || '—', dash(t.avgSessionPlace)])),
    ].filter(Boolean));
  };
  trackPlayer.addEventListener('change', drawTracks); drawTracks();

  const section = (title, note, ...content) => h('section', { class: 'card' }, h('h2', {}, title), note ? h('p', { class: 'muted small' }, note) : null, ...content);

  page('Stats', ...live, header,
    h('p', { class: 'muted small' }, `${gps.length} confirmed VS session${gps.length === 1 ? '' : 's'} · ${raceGps} with race-by-race detail`),
    section('Power rankings', 'Points share (45%), results against the field (45%) and recent form (10%). Results are weighed by how strong the other players were (their overall ratings), so beating a tough field counts for more and losing to one costs less. "Opp. strength" is the average rating of the players you raced (1500 = average). Players with few sessions are pulled toward the group average.', powerTable(power)),
    section('Skill rating (Elo)', 'Every session counts as head-to-head duels between players by final total. Starts at 1500.',
      table(['Player', 'Elo', 'Sessions'], elo.map((r) => [`${r.rank}. ${r.name}`, h('strong', {}, r.elo), r.gps]))),
    section('Consistency', 'Consistency 0-100: 100 = same place every race, 50 = as scattered as a random finisher. Volatility = average swing in total between consecutive sessions.',
      table(['Player', 'Consistency', 'Total σ', 'CV', 'Volatility', 'Race σ'], cons.map((c) => [c.name, h('strong', {}, c.consistency ?? '—'), c.gpStdev ?? '—', c.cv ?? '—', c.volatility ?? '—', c.raceStdev ?? '—']))),
    section('Head to head', null, h('div', { class: 'grid-2' }, aSel, bSel), h2hOut,
      h('details', {}, h('summary', {}, 'Win % matrix (row vs column)'), h2hMatrixTable(h2hM))),
    section('Tracks',
      `${tracks.trackCount} track${tracks.trackCount === 1 ? '' : 's'} · ${tracks.plays} race${tracks.plays === 1 ? '' : 's'} recorded. Place = finishing position out of 12 (only from race-by-race entries). Tracks added to final-score sessions count toward "Played" and "Session avg" (average finish among the players in sessions that included the track).`,
      tracks.overall.length
        ? table(['Track', 'Played', 'Avg place', 'Best player', 'Most wins'], tracks.overall.map((t) => [
            t.track, t.plays, t.avgPlace !== null ? t.avgPlace : '—',
            t.best ? `${t.best.name} (${t.best.avgPlace})` : '—',
            t.mostWins ? `${t.mostWins.name} ×${t.mostWins.wins}` : '—']))
        : h('p', { class: 'muted' }, 'No tracks recorded yet — pick the 4 tracks when entering a session.'),
      tracks.players.length ? h('h3', { class: 'subhead' }, 'By player') : null,
      tracks.players.length ? h('div', { class: 'card tight' }, trackPlayer) : null,
      tracks.players.length ? trackOut : null),
    section('More insights', 'Clutch = race 4 avg placement minus races 1-3 (negative finishes strong). Comebacks = session wins after 4th or worse (of 12) in race 1.',
      table(['Player', 'Best session', '60s', 'Win streak', 'Clutch', 'Comebacks', 'Best character'], ins.map((x) => [x.name, x.bestGp, x.perfectGps, x.winStreak, x.clutch ?? '—', x.comebacks, x.characters[0] ? `${x.characters[0].character} (${x.characters[0].avgPts})` : '—']))));
}

function h2hMatrixTable(m) {
  const cell = (a, b) => {
    if (a === b) return '—';
    const c = m.cells.find((x) => x.a === a && x.b === b);
    return c ? `${c.winPct}%` : '·';
  };
  return table(['', ...m.players.map((p) => p.name)], m.players.map((p) => [p.name, ...m.players.map((q) => cell(p.id, q.id))]));
}
