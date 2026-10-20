// Mailer tests: a real STARTTLS SMTP conversation against a local server,
// and the run loop against an in-memory Supabase REST stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendMail, buildMessage } from '../mailer/smtp.mjs';
import { runMailer } from '../mailer/run.mjs';
import { sessionEmail, eventRecapEmail } from '../mailer/templates.mjs';

// ---------------------------------------------------------------- fake SMTP (587 + STARTTLS)
function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), 'smtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

function fakeSmtp({ key, cert, user, pass }) {
  const seen = [];
  const server = net.createServer((raw) => {
    const s = { from: null, rcpt: [], data: '', authed: false, tls: false };
    let sock = raw; let buf = ''; let inData = false;
    const write = (l) => sock.write(`${l}\r\n`);
    const onLine = (line) => {
      if (inData) {
        if (line === '.') { inData = false; seen.push({ ...s }); write('250 2.0.0 queued'); return; }
        s.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`; return;
      }
      const [verb] = line.split(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO': write('250-fake.local'); write(s.tls ? '250 AUTH PLAIN LOGIN' : '250 STARTTLS'); break;
        case 'STARTTLS':
          write('220 go ahead');
          raw.removeAllListeners('data');
          sock = new tls.TLSSocket(raw, { isServer: true, key, cert });
          s.tls = true; buf = '';
          sock.on('data', onData);
          break;
        case 'AUTH': {
          if (!s.tls) { write('530 must STARTTLS'); break; }
          const [, , token] = line.split(' ');
          const [, u, p] = Buffer.from(token, 'base64').toString().split('\0');
          if (u === user && p === pass) { s.authed = true; write('235 ok'); } else write('535 bad credentials');
          break;
        }
        case 'MAIL': if (!s.authed) { write('530 auth required'); break; } s.from = line.match(/<(.*)>/)[1]; write('250 ok'); break;
        case 'RCPT': s.rcpt.push(line.match(/<(.*)>/)[1]); write('250 ok'); break;
        case 'DATA': inData = true; write('354 go'); break;
        case 'QUIT': write('221 bye'); sock.end(); break;
        default: write('502 ?');
      }
    };
    function onData(d) { buf += d.toString(); let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } }
    raw.on('data', onData);
    write('220 fake ESMTP');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, seen })));
}

const decodePart = (data, type) => {
  const m = data.split(/--kart-[^\r\n]+/).find((p) => p.includes(`Content-Type: ${type}`));
  return Buffer.from(m.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString('utf8');
};

test('SMTP: STARTTLS on 587, AUTH PLAIN, BCC in envelope only, UTF-8 subject, dot-stuffing', async () => {
  const { key, cert } = selfSigned();
  const { server, port, seen } = await fakeSmtp({ key, cert, user: 'kart@club.example', pass: 'token123' });
  try {
    const r = await sendMail({
      host: 'localhost', port, user: 'kart@club.example', pass: 'token123', ca: cert, timeoutMs: 5000,
      from: 'Kart Club <kart@club.example>', to: 'kart@club.example', bcc: ['a@x.com', 'b@y.com'],
      subject: '🏁 Anya wins VS 2', text: 'line one\n.starts with a dot', html: '<p>Hi</p>',
    });
    assert.deepEqual(r.accepted, ['kart@club.example', 'a@x.com', 'b@y.com']);
    assert.equal(seen.length, 1);
    const msg = seen[0];
    assert.equal(msg.tls, true, 'upgraded before AUTH');
    assert.deepEqual(msg.rcpt, ['kart@club.example', 'a@x.com', 'b@y.com']);
    assert.ok(!/a@x\.com/.test(msg.data), 'BCC addresses are not in the headers');
    assert.match(msg.data, /^Subject: =\?UTF-8\?B\?/m);
    assert.equal(decodePart(msg.data, 'text/plain'), 'line one\n.starts with a dot');
    assert.equal(decodePart(msg.data, 'text/html'), '<p>Hi</p>');
  } finally { server.close(); }
});

test('SMTP: wrong password is reported, not swallowed', async () => {
  const { key, cert } = selfSigned();
  const { server, port } = await fakeSmtp({ key, cert, user: 'u@x', pass: 'right' });
  try {
    await assert.rejects(() => sendMail({ host: 'localhost', port, user: 'u@x', pass: 'wrong', ca: cert, from: 'u@x', to: 'u@x', subject: 's', text: 't', html: 'h', timeoutMs: 5000 }), /535/);
  } finally { server.close(); }
});

test('message builder: valid multipart', () => {
  const m = buildMessage({ from: 'A <a@b.c>', to: 'a@b.c', subject: 'Plain', text: 't', html: '<b>h</b>' });
  assert.match(m, /^From: A <a@b\.c>/m);
  assert.match(m, /Content-Type: multipart\/alternative; boundary="kart-/);
});

// ---------------------------------------------------------------- run loop
const P = (id, profile_id, label, total, place) => ({ id, profile_id, label, character: null, is_cpu: false, final_total: total, final_place: place });
function fakeDb() {
  const db = {
    approved_users: [{ email: 'anya@x.com', is_admin: false }, { email: 'dev@x.com', is_admin: false }, { email: 'sam@x.com', is_admin: false }, { email: 'boss@x.com', is_admin: true }],
    profiles: [{ id: 'u1', display_name: 'Anya', email: 'anya@x.com' }, { id: 'u2', display_name: 'Dev', email: 'Dev@x.com' }, { id: 'u3', display_name: 'Sam', email: 'sam@x.com' }, { id: 'u4', display_name: 'Removed', email: 'gone@x.com' }],
    events: [
      { id: 'e1', name: 'Friday', finalized_at: null, recap_sent_at: null },
      { id: 'e2', name: 'Lake trip', finalized_at: '2026-10-19T20:00:00Z', recap_sent_at: null },
    ],
    grand_prix: [
      { id: 'g1', event_id: 'e1', seq: 1, engine_class: '150cc', entry_mode: 'total', status: 'confirmed', confirmed_at: '2026-10-19T21:00:00Z', summary_sent_at: null,
        gp_participants: [P('p1', 'u1', 'Anya', 50, 1), P('p2', 'u2', 'Dev', 41, 2), P('p5', null, 'Guest', 30, 3), P('p6', 'u4', 'Removed', 20, 4)], races: [{ race_number: 1, track: 'Coconut Mall', race_results: [] }], events: { id: 'e1', name: 'Friday' } },
      { id: 'g2', event_id: 'e2', seq: 1, engine_class: '150cc', entry_mode: 'total', status: 'confirmed', confirmed_at: '2026-10-19T08:00:00Z', summary_sent_at: '2026-10-19T08:05:00Z',
        gp_participants: [P('p3', 'u2', 'Dev', 44, 1), P('p4', 'u1', 'Anya', 40, 2)], races: [], events: { id: 'e2', name: 'Lake trip' } },
    ],
  };
  const calls = [];
  const fetchImpl = async (url, { method, headers, body }) => {
    calls.push({ method, url, headers });
    const u = new URL(url);
    const [table, fn] = u.pathname.replace('/rest/v1/', '').split('/');
    const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (table === 'rpc') return ok(fn === 'finalize_stale_events' ? 0 : null);
    let rows = db[table];
    for (const [k, v] of u.searchParams) {
      if (['select', 'order'].includes(k)) continue;
      if (v === 'is.null') rows = rows.filter((r) => r[k] == null);
      else if (v === 'not.is.null') rows = rows.filter((r) => r[k] != null);
      else if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith('gte.')) rows = rows.filter((r) => r[k] >= v.slice(4));
    }
    if (method === 'PATCH') { const patch = JSON.parse(body); rows.forEach((r) => Object.assign(r, patch)); }
    return ok(rows);
  };
  return { db, fetchImpl, calls };
}
const ENV = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x', APP_URL: 'https://prateekm.me/mariokart/', MAIL_FROM: 'Kart Club <kart@club.example>', SMTP_HOST: 'smtp.protonmail.ch', SMTP_PORT: '587', SMTP_USER: 'kart@club.example', SMTP_PASS: 't' };

test('mailer run: one summary + one recap, to the players involved + admins, claims recorded, no double send', async () => {
  const { db, fetchImpl, calls } = fakeDb();
  const sent = [];
  const send = async (m) => { sent.push(m); };
  const r = await runMailer(ENV, { fetchImpl, send, now: new Date('2026-10-19T22:00:00Z'), log: () => {} });
  assert.deepEqual([r.sessions, r.recaps, r.failures.length], [1, 1, 0]);
  assert.equal(sent[0].subject, '🏁 Anya wins VS 1 — Friday');
  // players in the session (approved only: no guest, no removed member) + the admin; Sam didn't play
  assert.deepEqual(sent[0].bcc, ['anya@x.com', 'boss@x.com', 'dev@x.com']);
  assert.deepEqual(sent[1].bcc, ['anya@x.com', 'boss@x.com', 'dev@x.com'], 'recap: everyone who played in the event + admins');
  assert.equal(sent[0].port, 587);
  assert.match(sent[0].html, /Tracks: R1 Coconut Mall/);
  assert.match(sent[1].subject, /Lake trip is over — Dev takes it/);
  assert.ok(db.grand_prix[0].summary_sent_at && db.events[1].recap_sent_at);
  assert.equal(calls[0].headers.Authorization, undefined, 'new-style secret key goes in apikey only');
  const again = await runMailer(ENV, { fetchImpl, send, now: new Date('2026-10-19T22:10:00Z'), log: () => {} });
  assert.deepEqual([again.sessions, again.recaps], [0, 0]);
});

test('mailer run: a failed send releases the claim for the next run', async () => {
  const { db, fetchImpl } = fakeDb();
  const r = await runMailer(ENV, { fetchImpl, send: async () => { throw new Error('535 bad credentials'); }, now: new Date('2026-10-19T22:00:00Z'), log: () => {} });
  assert.equal(r.failures.length, 2);
  assert.equal(db.grand_prix[0].summary_sent_at, null);
  assert.equal(db.events[1].recap_sent_at, null);
});

test('templates render players, standings and links', () => {
  const { db } = fakeDb();
  const s = sessionEmail(db.grand_prix[0], [db.grand_prix[0]], db.profiles, ENV.APP_URL);
  assert.match(s.text, /Friday so far:\n1\. Anya — 1 win, 50 pts/);
  assert.match(s.html, /#\/gp\/g1/);
  const e = eventRecapEmail(db.events[1], [db.grand_prix[1]], db.profiles, ENV.APP_URL);
  assert.match(e.text, /Champion: Dev/);
});
