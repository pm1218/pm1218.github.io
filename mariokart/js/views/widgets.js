// Small pieces of UI shared by several screens.
import { ordinal } from '../data.js';
import { fmtDateTime, h, table } from '../ui.js';

export const gpTitle = (g) => `VS ${g.seq}${g.cup ? ` · ${g.cup} Cup` : ''}`;
export const medal = (place) => h('span', { class: `place place-${place}` }, place <= 3 ? ['🥇', '🥈', '🥉'][place - 1] : ordinal(place));

export function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function summaryTable(sum) {
  return h('div', {},
    table(['Player', 'Played', 'Wins', 'Pts', 'Avg', 'Avg place'],
      sum.rows.map((r) => [`${r.rank}. ${r.name}`, r.sessions, h('strong', {}, r.wins), r.points, r.avgPts, r.avgPlace])),
    sum.last ? h('p', { class: 'muted small' }, `Latest: VS ${sum.last.seq}${sum.last.winner ? ` won by ${sum.last.winner} (${sum.last.points})` : ''} · ${fmtDateTime(sum.last.confirmed_at)}`) : null);
}
