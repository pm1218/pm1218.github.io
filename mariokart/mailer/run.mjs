// Kart Club mailer — run by the GitHub Action every 10 minutes (or by hand).
//
// 1. finalizes events idle for 12 hours
// 2. emails a summary for each newly confirmed VS session
// 3. emails a recap for each newly finalized event
//
// Each email is claimed in the database first (summary_sent_at /
// recap_sent_at set atomically), so overlapping runs never double-send; if
// sending fails the claim is released and the next run retries.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEY (or legacy service_role key),
//      SMTP_HOST, SMTP_PORT (587 STARTTLS / 465 TLS), SMTP_USER, SMTP_PASS,
//      MAIL_FROM, APP_URL. Optional: MAX_AGE_DAYS (default 3), DRY_RUN=1.
//
// Recipients: the players in the session (or, for a recap, everyone who
// played in the event) plus all admins — only addresses still approved.

import { sendMail } from './smtp.mjs';
import { sessionEmail, eventRecapEmail } from './templates.mjs';

const GP_SELECT = '*,gp_participants(*),races(*,race_results(*)),events(id,name)';

export function makeDb(url, key, fetchImpl = fetch) {
  const root = `${url.replace(/\/$/, '')}/rest/v1`;
  // New Supabase keys (sb_secret_…) go in `apikey` only; legacy JWT keys also as Bearer.
  const headers = { apikey: key, 'Content-Type': 'application/json', ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }) };
  const call = async (method, path, body, extra = {}) => {
    const res = await fetchImpl(`${root}/${path}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const txt = await res.text();
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status} ${txt.slice(0, 300)}`);
    return txt ? JSON.parse(txt) : null;
  };
  return {
    get: (path) => call('GET', path),
    rpc: (fn, args = {}) => call('POST', `rpc/${fn}`, args),
    // Conditional update; returns the rows actually changed.
    patch: (path, body) => call('PATCH', path, body, { Prefer: 'return=representation' }),
  };
}

const iso = (d) => encodeURIComponent(d.toISOString());

export async function runMailer(env, { fetchImpl = fetch, send = sendMail, now = new Date(), log = console.log } = {}) {
  const need = ['SUPABASE_URL', 'APP_URL', 'MAIL_FROM'];
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  for (const k of need) if (!env[k]) throw new Error(`Missing ${k}`);
  if (!key) throw new Error('Missing SUPABASE_SECRET_KEY');
  const db = makeDb(env.SUPABASE_URL, key, fetchImpl);
  const dry = env.DRY_RUN === '1';
  const since = new Date(now.getTime() - Number(env.MAX_AGE_DAYS || 3) * 864e5);
  const smtp = { host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM };
  const report = { finalized: 0, sessions: 0, recaps: 0, failures: [] };

  report.finalized = await db.rpc('finalize_stale_events');
  if (report.finalized) log(`Auto-finalized ${report.finalized} idle event(s).`);

  const approved = await db.get('approved_users?select=email,is_admin');
  const profiles = await db.get('profiles?select=id,display_name,email');
  const lc = (e) => String(e || '').toLowerCase();
  const approvedSet = new Set(approved.map((a) => lc(a.email)));
  const admins = approved.filter((a) => a.is_admin).map((a) => lc(a.email));
  const emailOf = new Map(profiles.map((p) => [p.id, lc(p.email)]));

  /** Players (members with a profile) in the given sessions + admins, approved only. */
  const recipientsFor = (gps) => {
    const players = gps.flatMap((g) => (g.gp_participants || []).map((p) => emailOf.get(p.profile_id))).filter(Boolean);
    return [...new Set([...players, ...admins])].filter((e) => approvedSet.has(e)).sort();
  };

  const deliver = async (mail, recipients) => {
    if (!recipients.length) { log(`No recipients for "${mail.subject}"`); return; }
    if (dry) { log(`[dry run] would send "${mail.subject}" to ${recipients.join(', ')}`); return; }
    // To: the sender; recipients on BCC so addresses stay private.
    await send({ ...smtp, to: smtp.from, bcc: recipients, ...mail });
  };

  // Session summaries (recent only, so a fresh setup doesn't email history).
  const pending = await db.get(`grand_prix?select=${GP_SELECT}&status=eq.confirmed&summary_sent_at=is.null&confirmed_at=gte.${iso(since)}&order=confirmed_at`);
  for (const gp of pending) {
    const claimed = await db.patch(`grand_prix?id=eq.${gp.id}&summary_sent_at=is.null`, { summary_sent_at: now.toISOString() });
    if (!claimed.length) continue; // another run got it
    try {
      const eventGps = await db.get(`grand_prix?select=${GP_SELECT}&event_id=eq.${gp.event_id}&status=eq.confirmed&order=seq`);
      const mail = sessionEmail(gp, eventGps, profiles, env.APP_URL);
      await deliver(mail, recipientsFor([gp]));
      report.sessions++;
      log(`Sent: ${mail.subject}`);
    } catch (e) {
      await db.patch(`grand_prix?id=eq.${gp.id}`, { summary_sent_at: null });
      report.failures.push(`session ${gp.id}: ${e.message}`);
    }
  }

  // Event recaps.
  const finished = await db.get(`events?select=*&finalized_at=not.is.null&recap_sent_at=is.null&finalized_at=gte.${iso(since)}&order=finalized_at`);
  for (const ev of finished) {
    const claimed = await db.patch(`events?id=eq.${ev.id}&recap_sent_at=is.null`, { recap_sent_at: now.toISOString() });
    if (!claimed.length) continue;
    try {
      const eventGps = await db.get(`grand_prix?select=${GP_SELECT}&event_id=eq.${ev.id}&status=eq.confirmed&order=seq`);
      const mail = eventRecapEmail(ev, eventGps, profiles, env.APP_URL);
      await deliver(mail, recipientsFor(eventGps));
      report.recaps++;
      log(`Sent: ${mail.subject}`);
    } catch (e) {
      await db.patch(`events?id=eq.${ev.id}`, { recap_sent_at: null });
      report.failures.push(`event ${ev.id}: ${e.message}`);
    }
  }
  return report;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runMailer(process.env).then((r) => {
    console.log(JSON.stringify(r));
    if (r.failures.length) { console.error(r.failures.join('\n')); process.exit(1); }
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
