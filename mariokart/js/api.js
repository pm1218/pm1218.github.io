// Thin data layer over Supabase (Postgres + Auth + Storage + Edge Functions).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CONFIG } from './config.js';
import { canvasToBlob, blobToIconCanvas } from './vision.js';

export const configured = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

export const sb = configured
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    })
  : null;

const BUCKET = 'score-photos';

function check({ data, error }) {
  if (error) {
    const msg = error.message || error.error_description || 'Request failed';
    throw new Error(msg.replace(/^.*?ERROR:\s*/, ''));
  }
  return data;
}

// ---------------------------------------------------------------- auth
// Supabase Auth sends the 6-digit code (email template uses {{ .Token }}),
// enforces single use, and expires it after the configured OTP lifetime
// (set to 600 s). The whitelist trigger in schema.sql refuses unknown emails.
export async function requestCode(email) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  // Don't reveal whether an address is on the whitelist; only surface
  // rate-limit errors, which are useful and leak nothing.
  if (error && /rate|seconds|too many/i.test(error.message)) throw new Error(error.message);
}

export async function verifyCode(email, token) {
  return check(await sb.auth.verifyOtp({ email, token, type: 'email' }));
}

export const signOut = () => sb.auth.signOut();
export const getSession = async () => (await sb.auth.getSession()).data.session;

// ---------------------------------------------------------------- people
export async function loadMe(session) {
  const email = session.user.email;
  const [profile, approval] = await Promise.all([
    sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle().then(check),
    sb.from('approved_users').select('*').eq('email', email).maybeSingle().then(check),
  ]);
  return { session, profile, approved: Boolean(approval), isAdmin: Boolean(approval?.is_admin) };
}

export const listProfiles = async () => check(await sb.from('profiles').select('id,email,display_name,mii_name,favorite_character').order('display_name'));

export async function updateProfile(id, fields) {
  return check(await sb.from('profiles').update(fields).eq('id', id).select().single());
}

export const listApproved = async () => check(await sb.from('approved_users').select('*').order('email'));
export async function addApproved(email, isAdmin, by) {
  return check(await sb.from('approved_users').insert({ email: email.trim().toLowerCase(), is_admin: isAdmin, added_by: by }).select().single());
}
export async function removeApproved(email) {
  return check(await sb.from('approved_users').delete().eq('email', email));
}
export async function setAdmin(email, isAdmin) {
  return check(await sb.from('approved_users').update({ is_admin: isAdmin }).eq('email', email));
}

// ---------------------------------------------------------------- events / GPs
export async function listEvents() {
  return check(await sb.from('events').select('*, grand_prix(id,status)').order('starts_on', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }));
}
export async function createEvent(fields) {
  return check(await sb.from('events').insert(fields).select().single());
}
export async function deleteEvent(id) {
  return check(await sb.from('events').delete().eq('id', id));
}
export async function getEvent(id) {
  return check(await sb.from('events').select('*').eq('id', id).single());
}
export async function createGp(fields) {
  return check(await sb.from('grand_prix').insert(fields).select().single());
}
export async function deleteGp(id) {
  return check(await sb.from('grand_prix').delete().eq('id', id));
}

const GP_SELECT = '*, gp_participants(*), races(*, race_results(*)), score_uploads(id,source,image_paths,created_at,uploaded_by)';

// Shape used by analytics.js: participants[], races[].results[]
export function normalizeGp(row) {
  return {
    ...row,
    participants: (row.gp_participants || []).sort((a, b) => a.final_place - b.final_place),
    races: (row.races || []).sort((a, b) => a.race_number - b.race_number).map((r) => ({ ...r, results: r.race_results || [] })),
    uploads: row.score_uploads || [],
  };
}

export async function listGps(eventId) {
  let q = sb.from('grand_prix').select(GP_SELECT).order('seq');
  if (eventId) q = q.eq('event_id', eventId);
  return check(await q).map(normalizeGp);
}

export async function getGp(id) {
  return normalizeGp(check(await sb.from('grand_prix').select(`${GP_SELECT}, events(id,name)`).eq('id', id).single()));
}

export async function confirmedGps(eventId) {
  let q = sb.from('grand_prix').select(GP_SELECT).eq('status', 'confirmed').order('confirmed_at');
  if (eventId) q = q.eq('event_id', eventId);
  return check(await q).map(normalizeGp);
}

export async function submitGp(gpId, payload) {
  return check(await sb.rpc('submit_grand_prix', { p_gp_id: gpId, p_payload: payload }));
}
export async function reopenGp(gpId) {
  return check(await sb.rpc('reopen_grand_prix', { p_gp_id: gpId }));
}

export async function sendSummary(gpId) {
  const { data, error } = await sb.functions.invoke('send-gp-summary', { body: { gp_id: gpId } });
  if (error) {
    let detail = error.message;
    try { detail = (await error.context.json()).error || detail; } catch { /* keep message */ }
    throw new Error(`Summary email failed: ${detail}`);
  }
  return data;
}

// ---------------------------------------------------------------- storage
export async function uploadPhoto(gpId, blob, label) {
  const path = `gp/${gpId}/${Date.now()}-${label}.jpg`;
  check(await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false }));
  return path;
}

export async function signedUrls(paths) {
  if (!paths.length) return [];
  return check(await sb.storage.from(BUCKET).createSignedUrls(paths, 3600)).map((x) => x.signedUrl);
}

// ---------------------------------------------------------------- icon templates
let templateCache = null;
const PER_CHARACTER = 8;

export async function loadTemplates() {
  if (templateCache) return templateCache;
  const rows = check(await sb.from('icon_templates').select('character,image_path,created_at').order('created_at', { ascending: false }).limit(400));
  const perChar = new Map();
  const keep = rows.filter((r) => {
    const n = perChar.get(r.character) || 0;
    perChar.set(r.character, n + 1);
    return n < PER_CHARACTER;
  });
  const loaded = await Promise.all(keep.map(async (r) => {
    const { data, error } = await sb.storage.from(BUCKET).download(r.image_path);
    if (error) return null;
    return { character: r.character, canvas: await blobToIconCanvas(data) };
  }));
  templateCache = loaded.filter(Boolean);
  return templateCache;
}

// Teach the matcher: save confirmed icon crops as new templates.
export async function saveTemplates(items, userId) {
  for (const { character, canvas } of items) {
    const blob = await canvasToBlob(canvas);
    const path = `icons/${character.replace(/[^A-Za-z]/g, '')}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/png' });
    if (up.error) continue;
    await sb.from('icon_templates').insert({ character, image_path: path, created_by: userId });
  }
  templateCache = null;
}
