// Thin data layer over Supabase (Postgres + Auth + Storage).
// supabase-js is pinned to an exact version: the CDN caches it for a year and
// nothing changes under us. To upgrade, change the version here and in
// tests/browser/smoke.py's route if it ever stops matching.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
import { CONFIG } from './config.js';
// vision.js (OpenCV + OCR, ~18 KB gz) is loaded only when a photo is used.
const vision = () => import('./vision.js');

export const configured = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

export const sb = configured
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    })
  : null;

const BUCKET = 'score-photos';

// ---------------------------------------------------------------- read cache
// Reads are kept for 30 s so moving between screens (and back) is instant.
// Any write from this tab clears the cache, so you always see your own
// changes; other members' changes show up within 30 s or on reload.
const CACHE_MS = 30_000;
const cache = new Map();
function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise.then((v) => structuredClone(v));
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise.then((v) => structuredClone(v));
}
export function invalidate() { cache.clear(); }
const writes = (fn) => async (...args) => { try { return await fn(...args); } finally { invalidate(); } };

// PostgREST returns at most 1000 rows per request; page through the rest.
async function allRows(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const rows = check(await build().range(from, from + pageSize - 1));
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

function check({ data, error }) {
  if (error) {
    const msg = error.message || error.error_description || 'Request failed';
    throw new Error(msg.replace(/^.*?ERROR:\s*/, ''));
  }
  return data;
}

// ---------------------------------------------------------------- auth
// Supabase Auth sends the 8-digit code (email template uses {{ .Token }}),
// enforces single use, and expires it after the configured OTP lifetime
// (set to 600 s). The whitelist trigger in schema.sql refuses unknown emails.
export async function requestCode(email) {
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: CONFIG.APP_URL,
    },
  });
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
const PROFILE_COLS = 'id,display_name,favorite_character,created_at'; // profiles.email is hidden from the browser
export async function loadMe(session) {
  const email = session.user.email;
  const [profile, approval] = await Promise.all([
    sb.from('profiles').select(PROFILE_COLS).eq('id', session.user.id).maybeSingle().then(check),
    sb.from('approved_users').select('*').eq('email', email).maybeSingle().then(check),
  ]);
  return { session, profile, approved: Boolean(approval), isAdmin: Boolean(approval?.is_admin) };
}

export const listProfiles = () => cached('profiles', async () => check(await sb.from('profiles').select('id,display_name,favorite_character').order('display_name')));

export const updateProfile = writes(async (id, fields) => {
  return check(await sb.from('profiles').update(fields).eq('id', id).select(PROFILE_COLS).single());
});

export const listApproved = async () => check(await sb.from('approved_users').select('*').order('email'));
export const addApproved = writes(async (email, isAdmin, by) =>
  check(await sb.from('approved_users').insert({ email: email.trim().toLowerCase(), is_admin: isAdmin, added_by: by }).select().single()));
export const removeApproved = writes(async (email) => check(await sb.from('approved_users').delete().eq('email', email)));
export const setAdmin = writes(async (email, isAdmin) => check(await sb.from('approved_users').update({ is_admin: isAdmin }).eq('email', email)));

// ---------------------------------------------------------------- events / GPs
export const listEvents = () => cached('events', () => allRows(() => sb.from('events')
  .select('*, grand_prix(id,status,created_at,confirmed_at)')
  .order('starts_on', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).order('id')));
export const createEvent = writes(async (fields) => check(await sb.from('events').insert(fields).select().single()));
export const deleteEvent = writes(async (id) => check(await sb.from('events').delete().eq('id', id)));
export const getEvent = (id) => cached(`event:${id}`, async () => check(await sb.from('events').select('*').eq('id', id).single()));
export const createGp = writes(async (fields) => check(await sb.from('grand_prix').insert(fields).select().single()));
export const deleteGp = writes(async (id) => check(await sb.from('grand_prix').delete().eq('id', id)));

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

export const listGps = (eventId) => cached(`gps:${eventId || ''}`, async () => {
  const rows = await allRows(() => {
    let q = sb.from('grand_prix').select(GP_SELECT).order('seq').order('id');
    if (eventId) q = q.eq('event_id', eventId);
    return q;
  });
  return rows.map(normalizeGp);
});

export const getGp = (id) => cached(`gp:${id}`, async () =>
  normalizeGp(check(await sb.from('grand_prix').select(`${GP_SELECT}, events(id,name)`).eq('id', id).single())));

// Every confirmed session, oldest first. Stats filters this one list for
// the chosen event and for each live event instead of fetching per event.
export const confirmedGps = () => cached('confirmed', async () =>
  (await allRows(() => sb.from('grand_prix').select(GP_SELECT).eq('status', 'confirmed').order('confirmed_at').order('id'))).map(normalizeGp));

export const submitGp = writes(async (gpId, payload) => check(await sb.rpc('submit_grand_prix', { p_gp_id: gpId, p_payload: payload })));
export const reopenGp = writes(async (gpId) => check(await sb.rpc('reopen_grand_prix', { p_gp_id: gpId })));

// Events: live until finalized (by hand or after 12 h without uploads).
export async function finalizeStale() {
  const n = check(await sb.rpc('finalize_stale_events'));
  if (n) invalidate();
  return n;
}
export const finalizeEvent = writes(async (id) => check(await sb.rpc('finalize_event', { p_event_id: id })));
export const reopenEvent = writes(async (id) => check(await sb.rpc('reopen_event', { p_event_id: id })));

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
    return { character: r.character, canvas: await (await vision()).blobToIconCanvas(data) };
  }));
  templateCache = loaded.filter(Boolean);
  return templateCache;
}

// Teach the matcher: save confirmed icon crops as new templates.
export async function saveTemplates(items, userId) {
  const { canvasToBlob } = await vision();
  for (const { character, canvas } of items) {
    const blob = await canvasToBlob(canvas);
    const path = `icons/${character.replace(/[^A-Za-z]/g, '')}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/png' });
    if (up.error) continue;
    await sb.from('icon_templates').insert({ character, image_path: path, created_by: userId });
  }
  templateCache = null;
}
