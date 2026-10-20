// Email bodies: one per confirmed VS session, and a recap when an event ends.
// Inputs use the Supabase row shape (gp_participants, races.race_results).

import { eventSummary } from '../js/analytics.js';
import { ordinal } from '../js/data.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = (url) => (url.endsWith('/') ? url : `${url}/`);
const CELL = 'padding:8px 10px;border-bottom:1px solid #e5e1d8;font-size:14px;';
const HEAD = 'padding:8px 10px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#667085;text-align:left;background:#f3f0ea;';
const medal = (p) => (p <= 3 ? ['🥇', '🥈', '🥉'][p - 1] : ordinal(p));

// Analytics shape (participants / races[].results) from Supabase rows.
export const normalize = (g) => ({
  ...g,
  participants: [...(g.gp_participants || [])].sort((a, b) => a.final_place - b.final_place),
  races: [...(g.races || [])].sort((a, b) => a.race_number - b.race_number).map((r) => ({ ...r, results: r.race_results || [] })),
});

function shell({ kicker, title, headline, body, footerLinks }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f2ee;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1b1d22">
<div style="max-width:600px;margin:0 auto;padding:16px">
  <div style="background:#c81e2a;color:#fff;border-radius:14px 14px 0 0;padding:16px 18px">
    <div style="font-size:12px;opacity:.85;text-transform:uppercase;letter-spacing:.08em">${esc(kicker)}</div>
    <div style="font-size:20px;font-weight:800;margin-top:4px">${esc(title)}</div>
    ${headline ? `<div style="margin-top:6px;font-size:15px">${esc(headline)}</div>` : ''}
  </div>
  <div style="background:#fff;border:1px solid #e5e1d8;border-top:0;border-radius:0 0 14px 14px;padding:12px 8px">
    ${body}
    <p style="margin:18px 8px 6px">${footerLinks}</p>
  </div>
  <p style="font-size:12px;color:#667085;text-align:center">You get this because you're a Kart Club member.</p>
</div></body></html>`;
}

function summaryTableHtml(sum) {
  const rows = sum.rows.map((r) => `<tr><td style="${CELL}">${r.rank}. ${esc(r.name)}</td><td style="${CELL}text-align:right">${r.sessions}</td>` +
    `<td style="${CELL}text-align:right;font-weight:700">${r.wins}</td><td style="${CELL}text-align:right">${r.points}</td>` +
    `<td style="${CELL}text-align:right">${r.avgPts}</td><td style="${CELL}text-align:right">${r.avgPlace}</td></tr>`).join('');
  return `<table role="presentation" style="width:100%;border-collapse:collapse"><tr><th style="${HEAD}">Player</th><th style="${HEAD}text-align:right">Played</th>` +
    `<th style="${HEAD}text-align:right">Wins</th><th style="${HEAD}text-align:right">Pts</th><th style="${HEAD}text-align:right">Avg</th><th style="${HEAD}text-align:right">Avg place</th></tr>${rows}</table>`;
}
const summaryText = (sum) => sum.rows.map((r) => `${r.rank}. ${r.name} — ${r.wins} win${r.wins === 1 ? '' : 's'}, ${r.points} pts (avg ${r.avgPts}, avg place ${r.avgPlace}) over ${r.sessions}`);

function highlights(gp) {
  const out = [];
  const [first, second] = gp.participants;
  if (first && second) {
    const margin = first.final_total - second.final_total;
    out.push(margin === 0 ? `Dead heat at the top: ${first.label} and ${second.label} both on ${first.final_total}.`
      : `${first.label} won by ${margin} point${margin === 1 ? '' : 's'} over ${second.label}.`);
  }
  if (first?.final_total === 60) out.push(`${first.label} scored a perfect 60 — four race wins!`);
  if (gp.entry_mode === 'races') {
    const wins = new Map();
    for (const r of gp.races) {
      const w = r.results.find((x) => x.placement === 1);
      if (w) wins.set(w.participant_id, (wins.get(w.participant_id) ?? 0) + 1);
    }
    const label = (id) => gp.participants.find((p) => p.id === id)?.label ?? '?';
    const top = [...wins.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] > 1) out.push(`${label(top[0])} won ${top[1]} of the 4 races.`);
  }
  return out;
}

/** Email for one confirmed session. gpRow/eventRows are Supabase rows; profiles: [{id, display_name}]. */
export function sessionEmail(gpRow, eventRows, profiles, appUrl) {
  const gp = normalize(gpRow);
  const evName = gpRow.events?.name ?? 'Event';
  const sum = eventSummary(eventRows.map(normalize), profiles);
  const hl = highlights(gp);
  const link = `${base(appUrl)}#/gp/${gp.id}`;
  const eventLink = `${base(appUrl)}#/events/${gp.event_id}`;
  const title = `${evName} — VS ${gp.seq} (${gp.engine_class})`;
  const winner = gp.participants[0];
  const raced = gp.entry_mode === 'races';
  const raceCell = (p, r) => { const x = r.results.find((q) => q.participant_id === p.id); return x ? `${ordinal(x.placement)} <span style="color:#667085">(${x.points})</span>` : '—'; };
  const rows = gp.participants.map((p) =>
    `<tr><td style="${CELL}font-weight:700">${medal(p.final_place)}</td><td style="${CELL}">${p.profile_id ? `<b>${esc(p.label)}</b>` : esc(p.label)}` +
    `${p.character ? `<br><span style="color:#667085;font-size:12px">${esc(p.character)}</span>` : ''}</td>` +
    (raced ? gp.races.map((r) => `<td style="${CELL}white-space:nowrap">${raceCell(p, r)}</td>`).join('') : '') +
    `<td style="${CELL}text-align:right;font-weight:800">${p.final_total}</td></tr>`).join('');
  const heads = raced ? gp.races.map((r) => `<th style="${HEAD}">R${r.race_number}</th>`).join('') : '';
  const tracks = gp.races.filter((r) => r.track);
  const body = `${hl.length ? `<ul style="margin:4px 8px 12px;padding-left:18px;font-size:14px">${hl.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div style="overflow-x:auto"><table role="presentation" style="width:100%;border-collapse:collapse">
      <tr><th style="${HEAD}"></th><th style="${HEAD}">Player</th>${heads}<th style="${HEAD}text-align:right">Pts</th></tr>${rows}</table></div>
    ${tracks.length ? `<p style="margin:10px 8px 0;font-size:12px;color:#667085">Tracks: ${tracks.map((r) => `R${r.race_number} ${esc(r.track)}`).join(' · ')}</p>` : ''}
    <h3 style="margin:20px 8px 6px;font-size:15px">${esc(evName)} so far (${sum.sessions} session${sum.sessions === 1 ? '' : 's'})</h3>
    ${summaryTableHtml(sum)}`;
  const html = shell({
    kicker: 'VS session confirmed', title, headline: winner ? `🏆 ${winner.label} with ${winner.final_total} points` : '', body,
    footerLinks: `<a href="${esc(link)}" style="display:inline-block;background:#c81e2a;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px">View this session</a>
      &nbsp; <a href="${esc(eventLink)}" style="color:#c81e2a;font-weight:600">Live event →</a>`,
  });
  const text = [
    `VS SESSION CONFIRMED: ${title}`,
    winner ? `Winner: ${winner.label} (${winner.final_total} pts)` : '',
    ...hl.map((x) => `* ${x}`), '',
    ...gp.participants.map((p) => `${ordinal(p.final_place).padEnd(5)} ${p.label}${raced ? `  [${gp.races.map((r) => { const x = r.results.find((q) => q.participant_id === p.id); return x ? ordinal(x.placement) : '-'; }).join(', ')}]` : ''}  ${p.final_total}`),
    tracks.length ? `Tracks: ${tracks.map((r) => `R${r.race_number} ${r.track}`).join(' · ')}` : '', '',
    `${evName} so far:`, ...summaryText(sum), '',
    `This session: ${link}`, `Event: ${eventLink}`,
  ].join('\n').replace(/\n{3,}/g, '\n\n');
  return { subject: `🏁 ${winner ? `${winner.label} wins ` : ''}VS ${gp.seq} — ${evName}`, html, text };
}

/** Recap when an event is finalized (by hand or after 12 h idle). */
export function eventRecapEmail(eventRow, eventRows, profiles, appUrl) {
  const sum = eventSummary(eventRows.map(normalize), profiles);
  const champ = sum.rows[0];
  const link = `${base(appUrl)}#/events/${eventRow.id}`;
  const statsLink = `${base(appUrl)}#/stats/${eventRow.id}`;
  const body = sum.rows.length
    ? `<p style="margin:4px 8px 12px;font-size:14px">${sum.sessions} VS session${sum.sessions === 1 ? '' : 's'} played. Final standings:</p>${summaryTableHtml(sum)}`
    : '<p style="margin:4px 8px 12px;font-size:14px">No sessions were confirmed for this event.</p>';
  const html = shell({
    kicker: 'Event over — final standings', title: eventRow.name,
    headline: champ ? `🏆 Champion: ${champ.name} (${champ.wins} win${champ.wins === 1 ? '' : 's'}, avg ${champ.avgPts})` : '', body,
    footerLinks: `<a href="${esc(statsLink)}" style="display:inline-block;background:#c81e2a;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px">Event stats</a>
      &nbsp; <a href="${esc(link)}" style="color:#c81e2a;font-weight:600">All sessions →</a>`,
  });
  const text = [
    `EVENT OVER: ${eventRow.name}`,
    champ ? `Champion: ${champ.name}` : '',
    `${sum.sessions} session${sum.sessions === 1 ? '' : 's'} played.`, '',
    ...summaryText(sum), '',
    `Event stats: ${statsLink}`,
  ].join('\n');
  return { subject: `🏆 ${eventRow.name} is over${champ ? ` — ${champ.name} takes it` : ''}`, html, text };
}
