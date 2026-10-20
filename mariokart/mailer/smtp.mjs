// Minimal, dependency-free SMTP client for sending one message at a time.
// Supports STARTTLS on 587 (Proton Mail, Outlook…) and implicit TLS on 465,
// AUTH PLAIN / LOGIN, multipart/alternative (text + HTML), UTF-8 subjects.

import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';

class Conn {
  constructor(socket) { this.attach(socket); }
  attach(socket) {
    this.socket = socket;
    this.buf = '';
    this.waiters = [];
    // No setEncoding: the raw socket is later handed to TLS for STARTTLS.
    socket.on('data', (d) => { this.buf += d.toString('utf8'); this.flush(); });
    socket.on('error', (e) => { this.error = e; this.flush(); });
    socket.on('close', () => { this.closed = true; this.flush(); });
  }
  detach() { this.socket.removeAllListeners('data'); this.socket.removeAllListeners('error'); this.socket.removeAllListeners('close'); }
  flush() {
    while (this.waiters.length) {
      const reply = this.take();
      if (reply) { this.waiters.shift().resolve(reply); continue; }
      if (this.error || this.closed) { this.waiters.shift().reject(this.error || new Error('SMTP connection closed')); continue; }
      break;
    }
  }
  // A complete reply: lines "250-…" continue, "250 …" ends.
  take() {
    const lines = this.buf.split(CRLF);
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const text = lines.slice(0, i + 1);
        this.buf = lines.slice(i + 1).join(CRLF);
        return { code: Number(text[i].slice(0, 3)), lines: text.map((l) => l.slice(4)) };
      }
    }
    return null;
  }
  read() { return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.flush(); }); }
  async cmd(line, expect) {
    if (line !== null) this.socket.write(line + CRLF);
    const r = await this.read();
    const ok = Array.isArray(expect) ? expect.includes(r.code) : r.code === expect;
    if (!ok) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'} failed: ${r.code} ${r.lines.join(' ')}`);
    return r;
  }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, (m) => m + CRLF).trimEnd();
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = (s) => { const m = String(s).match(/<([^>]+)>/); return (m ? m[1] : String(s)).trim(); };

// "Name <a@b>" with a non-ASCII name → encoded display name.
function formatAddress(s) {
  const m = String(s).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!m) return String(s).trim();
  return m[1] ? `${encodeHeader(m[1].replace(/^"|"$/g, ''))} <${m[2]}>` : `<${m[2]}>`;
}

export function buildMessage({ from, to, subject, text, html, date = new Date(), messageId }) {
  const boundary = `kart-${randomUUID()}`;
  const domain = addr(from).split('@')[1] || 'localhost';
  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${[].concat(to).map(formatAddress).join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId || randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap76(b64(body))].join(CRLF);
  return [...headers, '', part('text/plain', text), part('text/html', html), `--${boundary}--`, ''].join(CRLF);
}

/**
 * Send one message. bcc recipients go in the envelope only (kept private).
 * opts: { host, port, user, pass, from, to, bcc, subject, text, html, rejectUnauthorized, timeoutMs }
 */
export async function sendMail(opts) {
  const port = Number(opts.port || 587);
  const implicit = port === 465;
  const tlsOpts = { servername: opts.host, rejectUnauthorized: opts.rejectUnauthorized !== false, ca: opts.ca };
  const socket = implicit
    ? tls.connect({ host: opts.host, port, ...tlsOpts })
    : net.connect({ host: opts.host, port });
  socket.setTimeout(opts.timeoutMs || 30000, () => socket.destroy(new Error('SMTP timeout')));
  const c = new Conn(socket);
  const helo = opts.heloName || 'kart-club.local';
  try {
    await c.cmd(null, 220);
    let ehlo = await c.cmd(`EHLO ${helo}`, 250);
    if (!implicit) {
      if (!ehlo.lines.some((l) => /^STARTTLS/i.test(l))) throw new Error('Server does not offer STARTTLS; refusing to send credentials in clear text');
      await c.cmd('STARTTLS', 220);
      c.detach();
      const secure = tls.connect({ socket, ...tlsOpts });
      await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
      c.attach(secure);
      ehlo = await c.cmd(`EHLO ${helo}`, 250);
    }
    if (opts.user) {
      const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || '';
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        await c.cmd(`AUTH PLAIN ${Buffer.from(`\0${opts.user}\0${opts.pass}`, 'utf8').toString('base64')}`, 235);
      } else {
        await c.cmd('AUTH LOGIN', 334);
        await c.cmd(b64(opts.user), 334);
        await c.cmd(b64(opts.pass), 235);
      }
    }
    const rcpts = [...new Set([].concat(opts.to || [], opts.bcc || []).map(addr).filter(Boolean))];
    if (!rcpts.length) throw new Error('No recipients');
    await c.cmd(`MAIL FROM:<${addr(opts.from)}>`, 250);
    for (const r of rcpts) await c.cmd(`RCPT TO:<${r}>`, [250, 251]);
    await c.cmd('DATA', 354);
    const msg = buildMessage({ ...opts, to: opts.to || opts.from });
    // Dot-stuffing: lines starting with "." get an extra ".".
    c.socket.write(msg.replace(/\r\n\./g, '\r\n..') + CRLF + '.' + CRLF);
    const done = await c.cmd(null, 250);
    await c.cmd('QUIT', 221).catch(() => {});
    return { accepted: rcpts, response: done.lines.join(' ') };
  } finally {
    c.socket.destroy();
  }
}
