// Supabase Edge Function: e-mail a confirmed Grand Prix summary to every member.
//
// Deploy:  supabase functions deploy send-gp-summary
// Secrets: supabase secrets set SMTP_HOST=smtp.gmail.com SMTP_PORT=465 \
//            SMTP_USER=you@gmail.com SMTP_PASS=<app password> \
//            MAIL_FROM="Kart Club <you@gmail.com>" APP_URL=https://prateekm.me/mariokart/
// (SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
//
// Mail goes out over plain SMTP with Nodemailer (MIT). Edge Functions block
// outbound ports 25 and 587, so use implicit-TLS port 465 (Gmail, Outlook,
// Fastmail, Zoho and most providers support it).

import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6';

const POINTS = [15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const env = (k: string, fallback?: string) => {
  const v = Deno.env.get(k) ?? fallback;
  if (v === undefined || v === '') throw new Error(`missing secret ${k}`);
  return v;
};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

type Participant = { id: string; profile_id: string | null; label: string; character: string | null; is_cpu: boolean; final_total: number; final_place: number };
type Race = { race_number: number; track: string | null; race_results: { participant_id: string; placement: number; points: number }[] };
type Gp = {
  id: string; event_id: string; seq: number; cup: string | null; engine_class: string; entry_mode: string; status: string;
  confirmed_at: string; confirmed_by: string; summary_sent_at: string | null;
  gp_participants: Participant[]; races: Race[]; events: { id: string; name: string };
};

function eventTable(gps: Gp[]) {
  const agg = new Map<string, { name: string; pts: number; gps: number; wins: number; places: number[] }>();
  for (const g of gps) {
    for (const p of g.gp_participants) {
      if (!p.profile_id) continue;
      const a = agg.get(p.profile_id) ?? { name: p.label, pts: 0, gps: 0, wins: 0, places: [] };
      a.pts += p.final_total; a.gps++; a.wins += p.final_place === 1 ? 1 : 0; a.places.push(p.final_place);
      agg.set(p.profile_id, a);
    }
  }
  return [...agg.values()]
    .map((a) => ({ ...a, avg: Math.round((a.pts / a.gps) * 10) / 10, avgPlace: Math.round((a.places.reduce((s, x) => s + x, 0) / a.places.length) * 100) / 100 }))
    .sort((x, y) => y.avg - x.avg || y.wins - x.wins);
}

function highlights(gp: Gp): string[] {
  const out: string[] = [];
  const ps = [...gp.gp_participants].sort((a, b) => a.final_place - b.final_place);
  const [first, second] = ps;
  if (first && second) {
    const margin = first.final_total - second.final_total;
    out.push(margin === 0 ? `Dead heat at the top: ${first.label} and ${second.label} both on ${first.final_total}.`
      : `${first.label} won by ${margin} point${margin === 1 ? '' : 's'} over ${second.label}.`);
  }
  if (first?.final_total === 60) out.push(`${first.label} scored a perfect 60 — four race wins!`);
  if (gp.entry_mode === 'races' && gp.races.length === 4) {
    const wins = new Map<string, number>();
    for (const r of gp.races) {
      const w = r.race_results.find((x) => x.placement === 1);
      if (w) wins.set(w.participant_id, (wins.get(w.participant_id) ?? 0) + 1);
    }
    const label = (id: string) => ps.find((p) => p.id === id)?.label ?? '?';
    const top = [...wins.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] > 1) out.push(`${label(top[0])} won ${top[1]} of the 4 races.`);
    // Biggest climb from race 1 to final standing.
    const r1 = gp.races.find((r) => r.race_number === 1)!;
    let best: { id: string; gain: number } | null = null;
    for (const res of r1.race_results) {
      const p = ps.find((x) => x.id === res.participant_id);
      if (!p?.profile_id) continue;
      const gain = res.placement - p.final_place;
      if (gain > 0 && (!best || gain > best.gain)) best = { id: p.id, gain };
    }
    if (best && best.gain >= 2) out.push(`Comeback: ${label(best.id)} climbed ${best.gain} places after race 1.`);
  }
  return out;
}

function buildEmail(gp: Gp, eventGps: Gp[], appUrl: string) {
  const ps = [...gp.gp_participants].sort((a, b) => a.final_place - b.final_place);
  const races = [...gp.races].sort((a, b) => a.race_number - b.race_number);
  const ev = eventTable(eventGps);
  const hl = highlights(gp);
  const base = appUrl.endsWith('/') ? appUrl : `${appUrl}/`;
  const gpLink = `${base}#/gp/${gp.id}`;
  const eventLink = `${base}#/events/${gp.event_id}`;
  const title = `${gp.events.name} — VS ${gp.seq}${gp.cup ? `, ${gp.cup} Cup` : ''} (${gp.engine_class})`;
  const winner = ps[0];

  const cell = 'padding:8px 10px;border-bottom:1px solid #e5e1d8;font-size:14px;';
  const head = 'padding:8px 10px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#667085;text-align:left;background:#f3f0ea;';
  const raceCell = (p: Participant, r: Race) => {
    const x = r.race_results.find((q) => q.participant_id === p.id);
    return x ? `${ordinal(x.placement)} <span style="color:#667085">(${x.points})</span>` : '—';
  };

  const standings = ps.map((p) =>
    `<tr><td style="${cell}font-weight:700">${p.final_place <= 3 ? ['🥇', '🥈', '🥉'][p.final_place - 1] : ordinal(p.final_place)}</td>` +
    `<td style="${cell}">${p.profile_id ? `<b>${esc(p.label)}</b>` : esc(p.label)}${p.is_cpu ? ' <span style="color:#667085">CPU</span>' : ''}` +
    `${p.character ? `<br><span style="color:#667085;font-size:12px">${esc(p.character)}</span>` : ''}</td>` +
    (gp.entry_mode === 'races' ? races.map((r) => `<td style="${cell}white-space:nowrap">${raceCell(p, r)}</td>`).join('') : '') +
    `<td style="${cell}text-align:right;font-weight:800">${p.final_total}</td></tr>`).join('');

  const raceHeads = gp.entry_mode === 'races' ? races.map((r) => `<th style="${head}">R${r.race_number}</th>`).join('') : '';
  const eventRows = ev.map((r, i) =>
    `<tr><td style="${cell}">${i + 1}. ${esc(r.name)}</td><td style="${cell}text-align:right">${r.avg}</td>` +
    `<td style="${cell}text-align:right">${r.avgPlace}</td><td style="${cell}text-align:right">${r.wins}/${r.gps}</td></tr>`).join('');

  const html = `<!doctype html><html><body style="margin:0;background:#f4f2ee;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1b1d22">
<div style="max-width:600px;margin:0 auto;padding:16px">
  <div style="background:#c81e2a;color:#fff;border-radius:14px 14px 0 0;padding:16px 18px">
    <div style="font-size:12px;opacity:.85;text-transform:uppercase;letter-spacing:.08em">VS session confirmed</div>
    <div style="font-size:20px;font-weight:800;margin-top:4px">${esc(title)}</div>
    ${winner ? `<div style="margin-top:6px;font-size:15px">🏆 ${esc(winner.label)} with ${winner.final_total} points</div>` : ''}
  </div>
  <div style="background:#fff;border:1px solid #e5e1d8;border-top:0;border-radius:0 0 14px 14px;padding:12px 8px">
    ${hl.length ? `<ul style="margin:4px 8px 12px;padding-left:18px;font-size:14px">${hl.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div style="overflow-x:auto"><table role="presentation" style="width:100%;border-collapse:collapse">
      <tr><th style="${head}"></th><th style="${head}">Kart</th>${raceHeads}<th style="${head}text-align:right">Pts</th></tr>${standings}
    </table></div>
    ${gp.entry_mode === 'races' && races.some((r) => r.track) ? `<p style="margin:10px 8px 0;font-size:12px;color:#667085">Tracks: ${races.map((r) => `R${r.race_number} ${esc(r.track || '—')}`).join(' · ')}</p>` : ''}
    <h3 style="margin:20px 8px 6px;font-size:15px">${esc(gp.events.name)} so far (${eventGps.length} GP${eventGps.length === 1 ? '' : 's'})</h3>
    <table role="presentation" style="width:100%;border-collapse:collapse">
      <tr><th style="${head}">Player</th><th style="${head}text-align:right">Avg pts</th><th style="${head}text-align:right">Avg place</th><th style="${head}text-align:right">Wins</th></tr>${eventRows}
    </table>
    <p style="margin:18px 8px 6px">
      <a href="${esc(gpLink)}" style="display:inline-block;background:#c81e2a;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px">View this GP</a>
      &nbsp; <a href="${esc(eventLink)}" style="color:#c81e2a;font-weight:600">Event &amp; analytics →</a>
    </p>
  </div>
  <p style="font-size:12px;color:#667085;text-align:center">You get this because you're a Kart Club member.</p>
</div></body></html>`;

  const text = [
    `GRAND PRIX CONFIRMED: ${title}`,
    winner ? `Winner: ${winner.label} (${winner.final_total} pts)` : '',
    ...hl.map((x) => `* ${x}`),
    '',
    ...ps.map((p) => `${ordinal(p.final_place).padEnd(5)} ${p.label}${p.is_cpu ? ' (CPU)' : ''}${gp.entry_mode === 'races' ? '  [' + races.map((r) => { const x = r.race_results.find((q) => q.participant_id === p.id); return x ? ordinal(x.placement) : '-'; }).join(', ') + ']' : ''}  ${p.final_total}`),
    '',
    `${gp.events.name} so far:`,
    ...ev.map((r, i) => `${i + 1}. ${r.name} — avg ${r.avg} pts, avg place ${r.avgPlace}, ${r.wins}/${r.gps} wins`),
    '',
    `This GP: ${gpLink}`,
    `Event: ${eventLink}`,
  ].filter((l) => l !== null).join('\n');

  return { subject: `🏁 ${winner ? `${winner.label} wins ` : ''}VS ${gp.seq} — ${gp.events.name}`, html, text };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let admin: ReturnType<typeof createClient> | null = null;
  let claimedId: string | null = null;
  try {
    const url = env('SUPABASE_URL');
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'sign in first' }, 401);

    const userClient = createClient(url, env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user?.email) return json({ error: 'invalid session' }, 401);

    admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const { data: approved } = await admin.from('approved_users').select('email').eq('email', user.email).maybeSingle();
    if (!approved) return json({ error: 'not an approved member' }, 403);

    const { gp_id } = await req.json().catch(() => ({}));
    if (typeof gp_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(gp_id)) return json({ error: 'gp_id required' }, 400);

    const select = '*, gp_participants(*), races(*, race_results(*)), events(id,name)';
    const { data: gp, error: gpErr } = await admin.from('grand_prix').select(select).eq('id', gp_id).single<Gp>();
    if (gpErr || !gp) return json({ error: 'grand prix not found' }, 404);
    if (gp.status !== 'confirmed') return json({ error: 'grand prix is not confirmed yet' }, 409);

    // Claim the send atomically so a double tap can't e-mail twice.
    const { data: claim } = await admin.from('grand_prix').update({ summary_sent_at: new Date().toISOString() })
      .eq('id', gp_id).is('summary_sent_at', null).select('id');
    if (!claim?.length) return json({ error: 'summary already sent' }, 409);
    claimedId = gp_id;

    const { data: eventGps } = await admin.from('grand_prix').select(select)
      .eq('event_id', gp.event_id).eq('status', 'confirmed').order('seq');
    const { data: members } = await admin.from('approved_users').select('email');
    const recipients = (members ?? []).map((m: { email: string }) => m.email);

    const port = Number(env('SMTP_PORT', '465'));
    if (port === 25 || port === 587) throw new Error('Edge Functions block SMTP ports 25 and 587 — use 465 (implicit TLS).');
    const transport = nodemailer.createTransport({
      host: env('SMTP_HOST'),
      port,
      secure: port === 465,
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    });
    const from = env('MAIL_FROM', Deno.env.get('SMTP_USER'));
    const mail = buildEmail(gp, (eventGps ?? []) as Gp[], env('APP_URL'));
    // BCC keeps members' addresses private from each other.
    await transport.sendMail({ from, to: from, bcc: recipients, subject: mail.subject, html: mail.html, text: mail.text });

    return json({ ok: true, recipients: recipients.length });
  } catch (e) {
    console.error(e);
    if (admin && claimedId) await admin.from('grand_prix').update({ summary_sent_at: null }).eq('id', claimedId);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
