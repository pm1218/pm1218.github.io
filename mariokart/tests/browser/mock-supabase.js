// In-memory stand-in for @supabase/supabase-js used only by the browser
// smoke test (tests/browser/smoke.py). It implements just the surface the
// app calls, and mirrors submit_grand_prix's validation (incl. the 4-race rule).
const POINTS = [15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0];
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const ME = { id: '00000000-0000-4000-8000-000000000001', email: 'admin@example.com' };
const db = {
  approved_users: [
    { email: 'admin@example.com', is_admin: true, added_at: now() },
    { email: 'anya@example.com', is_admin: false, added_at: now() },
    { email: 'dev@example.com', is_admin: false, added_at: now() },
  ],
  profiles: [
    { id: ME.id, email: ME.email, display_name: 'Prateek', mii_name: 'PRATEEK', favorite_character: 'Yoshi' },
    { id: '00000000-0000-4000-8000-000000000002', email: 'anya@example.com', display_name: 'Anya', mii_name: 'Anya', favorite_character: 'Peach' },
    { id: '00000000-0000-4000-8000-000000000003', email: 'dev@example.com', display_name: 'Dev', mii_name: 'DevK', favorite_character: 'Bowser' },
  ],
  events: [], grand_prix: [], gp_participants: [], races: [], race_results: [], score_uploads: [], icon_templates: [],
};
window.__mockDb = db;
window.__mails = [];
let session = null;

function embed(table, row, sel) {
  const out = { ...row };
  if (table === 'events' && sel.includes('grand_prix(')) out.grand_prix = db.grand_prix.filter((g) => g.event_id === row.id).map(({ id, status }) => ({ id, status }));
  if (table === 'grand_prix') {
    if (sel.includes('gp_participants(')) out.gp_participants = db.gp_participants.filter((p) => p.gp_id === row.id);
    if (sel.includes('races(')) out.races = db.races.filter((r) => r.gp_id === row.id).map((r) => ({ ...r, race_results: db.race_results.filter((x) => x.race_id === r.id) }));
    if (sel.includes('score_uploads(')) out.score_uploads = db.score_uploads.filter((u) => u.gp_id === row.id);
    if (sel.includes('events(')) { const e = db.events.find((x) => x.id === row.event_id); out.events = e && { id: e.id, name: e.name }; }
  }
  return out;
}

class Query {
  constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.sel = '*'; this.orders = []; this.mode = 'many'; }
  select(sel = '*') { if (this.op === 'select') this.sel = sel; this.returning = true; return this; }
  insert(v) { this.op = 'insert'; this.value = v; return this; }
  update(v) { this.op = 'update'; this.value = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push((r) => String(r[c]).toLowerCase() === String(v).toLowerCase()); return this; }
  is(c, v) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  order(c, o = {}) { this.orders.push([c, o.ascending !== false]); return this; }
  limit() { return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  run() {
    const t = db[this.table];
    const match = (r) => this.filters.every((f) => f(r));
    let rows;
    if (this.op === 'insert') {
      const v = { ...this.value };
      if (this.table === 'events') Object.assign(v, { id: uid(), created_by: ME.id, created_at: now() });
      if (this.table === 'grand_prix') Object.assign(v, { id: uid(), created_by: ME.id, created_at: now(), status: 'draft', seq: db.grand_prix.filter((g) => g.event_id === v.event_id).length + 1 });
      if (this.table === 'approved_users') { if (t.some((x) => x.email === v.email)) return { data: null, error: { message: 'duplicate key value violates unique constraint' } }; v.added_at = now(); }
      if (this.table === 'icon_templates') Object.assign(v, { id: uid(), created_at: now() });
      t.push(v); rows = [v];
    } else if (this.op === 'update') {
      rows = t.filter(match); rows.forEach((r) => Object.assign(r, this.value));
    } else if (this.op === 'delete') {
      rows = t.filter(match); db[this.table] = t.filter((r) => !match(r));
      if (this.table === 'grand_prix') rows.forEach((g) => { db.gp_participants = db.gp_participants.filter((p) => p.gp_id !== g.id); });
    } else {
      rows = t.filter(match);
      for (const [c, asc] of [...this.orders].reverse()) rows = [...rows].sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : String(a[c] ?? '') > String(b[c] ?? '') ? 1 : 0) * (asc ? 1 : -1));
      rows = rows.map((r) => embed(this.table, r, this.sel));
    }
    if (this.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
    if (this.mode === 'maybe') return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

function submit(gpId, p) {
  const gp = db.grand_prix.find((g) => g.id === gpId);
  if (gp.status === 'confirmed') throw new Error('grand prix already confirmed');
  if (p.mode === 'races') {
    if (p.races.length !== 4) throw new Error(`individual race mode requires all 4 races (got ${p.races.length}). Upload the final total score instead.`);
    for (const r of p.races) {
      const places = r.results.map((x) => x.placement);
      if (r.results.length !== p.participants.length || new Set(places).size !== places.length) throw new Error(`race ${r.race_number} must list every participant exactly once with distinct placements`);
    }
  }
  const totals = Object.fromEntries(p.participants.map((x) => [x.key, p.mode === 'races'
    ? p.races.reduce((s, r) => s + POINTS[r.results.find((q) => q.key === x.key).placement - 1], 0)
    : x.final_total]));
  const ids = {};
  for (const x of p.participants) {
    ids[x.key] = uid();
    db.gp_participants.push({ id: ids[x.key], gp_id: gpId, profile_id: x.profile_id, label: x.label, character: x.character, is_cpu: x.is_cpu, final_total: totals[x.key] });
  }
  const mine = db.gp_participants.filter((q) => q.gp_id === gpId);
  mine.forEach((q) => { q.final_place = 1 + mine.filter((o) => o.final_total > q.final_total).length; });
  for (const r of p.races) {
    const rid = uid();
    db.races.push({ id: rid, gp_id: gpId, race_number: r.race_number, track: r.track });
    for (const x of r.results) db.race_results.push({ id: uid(), race_id: rid, participant_id: ids[x.key], placement: x.placement, points: POINTS[x.placement - 1] });
  }
  db.score_uploads.push({ id: uid(), gp_id: gpId, source: p.source, image_paths: p.image_paths || [], created_at: now() });
  Object.assign(gp, { status: 'confirmed', entry_mode: p.mode, confirmed_by: ME.id, confirmed_at: now() });
  return { gp_id: gpId, totals };
}

export function createClient() {
  const listeners = [];
  return {
    from: (t) => new Query(t),
    rpc: async (fn, args) => {
      try {
        if (fn === 'submit_grand_prix') return { data: submit(args.p_gp_id, args.p_payload), error: null };
        if (fn === 'reopen_grand_prix') return { data: null, error: null };
      } catch (e) { return { data: null, error: { message: e.message } }; }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
    auth: {
      signInWithOtp: async () => ({ error: null }),
      verifyOtp: async ({ email, token }) => {
        if (token !== '12345678') return { data: null, error: { message: 'Token has expired or is invalid' } };
        session = { user: { id: ME.id, email } }; listeners.forEach((l) => l('SIGNED_IN', session));
        return { data: { session }, error: null };
      },
      getSession: async () => ({ data: { session } }),
      signOut: async () => { session = null; listeners.forEach((l) => l('SIGNED_OUT', null)); return { error: null }; },
      onAuthStateChange: (cb) => { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
    },
    storage: { from: () => ({ upload: async () => ({ data: {}, error: null }), download: async () => ({ data: null, error: { message: 'none' } }), createSignedUrls: async (p) => ({ data: p.map(() => ({ signedUrl: '' })), error: null }) }) },
    functions: {
      invoke: async (name, { body }) => {
        const gp = db.grand_prix.find((g) => g.id === body.gp_id);
        gp.summary_sent_at = now();
        window.__mails.push(body.gp_id);
        return { data: { ok: true, recipients: db.approved_users.length }, error: null };
      },
    },
  };
}
