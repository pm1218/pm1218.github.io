// End-to-end evaluation using the app's own JS (planScreen, isolateDigits,
// pointsCandidates, decodeDescending, finishScreen, detectHumans) with the
// Tesseract 5 CLI standing in for Tesseract.js.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planScreen, finishScreen, isolateDigits, detectHumans } from '../../js/wii-layout.js';
const run = promisify(execFile);
const dir = process.argv[2]; const only = process.argv[3];
const gt = JSON.parse(readFileSync(`${dir}/gt.json`));
const opts = { extraNames: ['bob', 'dog man'] };
const readPgm = (f) => {
  const b = readFileSync(f); let i = 0; const tok = () => { while (/\s/.test(String.fromCharCode(b[i]))) i++; let s = ''; while (!/\s/.test(String.fromCharCode(b[i]))) s += String.fromCharCode(b[i++]); return s; };
  tok(); const w = +tok(); const h = +tok(); tok(); i++;
  return { width: w, height: h, data: b.subarray(i, i + w * h) };
};
const writePgm = (f, im) => writeFileSync(f, Buffer.concat([Buffer.from(`P5\n${im.width} ${im.height}\n255\n`), Buffer.from(im.data)]));
async function tess(file, wl) {
  const { stdout } = await run('tesseract', [file, 'stdout', '--psm', '7', '-c', `tessedit_char_whitelist=${wl}`, 'tsv'], { maxBuffer: 1 << 24 });
  return stdout.split('\n').slice(1).map((l) => l.split('\t')).filter((c) => c[0] === '5' && c[11]?.trim())
    .map((c) => ({ text: c[11], confidence: +c[10], bbox: { x0: +c[6], y0: +c[7], x1: +c[6] + +c[8], y1: +c[7] + +c[9] } }));
}
async function pool(tasks, n = 8) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } })); return out; }
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.';
let tn = 0, tp = 0, tot = 0, kinds = 0, htp = 0, hfp = 0, hfn = 0, hn = 0, hp = 0, ht = 0;
for (const [id, g] of Object.entries(gt)) {
  if (only && id !== only) continue;
  const plan = planScreen(JSON.parse(readFileSync(`${dir}/dump/${id}.json`)), opts);
  const cd = `${dir}/cells/${id}`; mkdirSync(`${cd}/iso`, { recursive: true });
  const cellOcr = {};
  const tasks = [];
  for (const s of plan.slots) {
    cellOcr[s.place] = { name: [], points: [] };
    for (const v of ['white', 'top', 'otsu']) tasks.push(async () => { cellOcr[s.place].name.push(await tess(`${cd}/${s.place}_name_${v}.pgm`, LETTERS)); });
    for (const v of ['adapt', 'blue2', 'white', 'loose', 'blue', 'top']) tasks.push(async () => {
      const iso = isolateDigits(readPgm(`${cd}/${s.place}_pts_${v}.pgm`));
      if (!iso) return;
      const f = `${cd}/iso/${s.place}_${v}.pgm`; writePgm(f, iso);
      const ws = await tess(f, '0123456789');
      const text = ws.map((w) => w.text).join('');
      if (text) cellOcr[s.place].points.push({ text, confidence: Math.min(...ws.map((w) => w.confidence)) });
    });
  }
  await pool(tasks);
  const bars = JSON.parse(readFileSync(`${cd}/bars.json`));
  const humans = detectHumans(plan.kind, Object.entries(bars).map(([place, [h, s, v]]) => ({ place: +place, h, s, v })));
  for (const s of plan.slots) cellOcr[s.place].human = humans[s.place] ?? null;
  const r = finishScreen(plan, cellOcr, opts);
  if (process.env.FIXTURES) {
    const slim = (ws) => ws.map((w) => ({ text: w.text, confidence: Math.round(w.confidence), bbox: w.bbox }));
    const pass1 = JSON.parse(readFileSync(`${dir}/dump/${id}.json`));
    const fx = { id, truth: g, pass1: { width: pass1.width, height: pass1.height, variants: Object.fromEntries(Object.entries(pass1.variants).map(([k, v]) => [k, slim(v)])) },
      cells: Object.fromEntries(Object.entries(cellOcr).map(([p, c]) => [p, { name: c.name.map((ws) => ws.map((w) => ({ text: w.text, confidence: Math.round(w.confidence) }))), points: c.points.map((x) => ({ text: x.text, confidence: Math.round(x.confidence) })), human: c.human }])) };
    writeFileSync(`${process.env.FIXTURES}/${id}.json`, JSON.stringify(fx));
  }
  let n = 0, p = 0; const bad = [];
  g.rows.forEach(([name, pts], i) => {
    const row = r.rows.find((x) => x.place === i + 1);
    const okN = row?.name === name; const okP = row?.points === pts;
    n += okN; p += okP;
    if (!okN || !okP) bad.push(`${i + 1}:${okN ? '' : `${row?.name ?? '∅'}≠${name}`}${okP ? '' : ` ${row?.points ?? '∅'}≠${pts}`}`);
    const isH = g.humans.includes(i + 1);
    if (isH) { ht++; hn += okN; hp += okP; }
    if (row?.human && isH) htp++; else if (row?.human) hfp++; else if (isH) hfn++;
  });
  kinds += r.kind === g.kind; tn += n; tp += p; tot += 12;
  console.log(`${id} ${g.kind.padEnd(9)} names ${String(n).padStart(2)}/12 pts ${String(p).padStart(2)}/12  ${bad.join(' | ')}`);
}
console.log(`TOTAL screens ${kinds}/${only ? 1 : Object.keys(gt).length}  names ${tn}/${tot} (${Math.round(100 * tn / tot)}%)  points ${tp}/${tot} (${Math.round(100 * tp / tot)}%)  humans found ${htp}/${htp + hfn}, false ${hfp}`);
console.log(`PLAYER ROWS ONLY: names ${hn}/${ht} (${Math.round(100 * hn / ht)}%)  points ${hp}/${ht} (${Math.round(100 * hp / ht)}%)`);
