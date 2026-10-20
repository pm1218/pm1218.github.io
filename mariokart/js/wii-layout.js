// Reads Mario Kart Wii result screens from OCR word boxes.
//
// Pure functions (no DOM) — runs in the browser and in Node tests.
//
// Two Wii screens matter:
//
//   "standings"  12 full-width bars, shown after every race:
//                [1st] [icon] [name] [wheel?] [+gained?] [NNpts]
//                While "+gained" is shown, rows are in *race* order and the
//                totals already include that race. Afterwards rows re-sort by
//                total and "+gained" disappears.
//   "final"      "You got Nth place!" after the last race: two columns of six,
//                [place] [icon] [name] [NN / pts] — left 1st-6th, right 7th-12th.
//
// Names on both screens are character names (or Mii names), never player
// names, so they are matched against a closed vocabulary: the 25 characters
// plus the group's Mii names. That makes OCR errors ("Manito", "fing Ebo")
// recoverable.
//
// Input: { width, height, variants: { [name]: [{ text, confidence, bbox }] } } —
// word boxes from Tesseract run on several binarisations of the same image.
// Every variant contributes candidates; agreeing candidates vote.

import { CHARACTERS } from './data.js';
import { similarity, normalizeName } from './text.js';

// Common misreads that are still unambiguous ("Sth" is not here: it is 5th, 8th or 9th).
const ORDINAL_FIX = { lst: 1, ist: 1, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8, '9th': 9, '10th': 10, '11th': 11, '12th': 12, '1ith': 11, i1th: 11, '11h': 11, '12h': 12, '10h': 10, iith: 11, lith: 11, '1oth': 10, ioth: 10, loth: 10, '1zth': 12, '12tn': 12, '7tn': 7, '8tn': 8, '9tn': 9 };
const DIGIT_FIX = { O: '0', o: '0', Q: '0', D: '0', l: '1', I: '1', i: '1', '|': '1', '!': '1', Z: '2', z: '2', S: '5', s: '5', B: '8', g: '9', q: '9', A: '4', G: '6' };

const clean = (t) => String(t || '').replace(/[“”"'‘’`´,;:_~—–=«»()[\]{}<>*^\\/]/g, '').trim();

export function parseOrdinal(text) {
  const t = clean(text).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!t || t.length > 5) return null;
  const m = t.match(/^(1[0-2]|[1-9])(st|nd|rd|th)$/);
  if (m) return Number(m[1]);
  return ORDINAL_FIX[t] ?? null;
}

/**
 * Numbers: "46pts", "46", "+12", "4O", "+O". Returns { value, gained } or null.
 * "pts" glued to digits (or misread as "ots", "rts", "ets", "cts") is stripped.
 */
export function parseNumber(text) {
  let t = clean(text).replace(/\.$/, '');
  t = t.replace(/[pPoOrReEcCnNbBgG]?[tT][sS5]\.?$/, '').replace(/pts?$/i, '');
  const gained = t.startsWith('+') || t.startsWith('4+') && false;
  t = t.replace(/^\+/, '');
  if (!t || t.length > 3) return null;
  if (!/\d/.test(t)) return null; // only repair tokens that already contain a digit
  t = [...t].map((c) => (/\d/.test(c) ? c : DIGIT_FIX[c] ?? c)).join('');
  if (!/^\d{1,3}$/.test(t)) return null;
  const value = Number(t);
  if (gained && value > 15) return null;
  return { value, gained };
}

// Group one variant's words into text lines. Boxes far taller or shorter than
// typical text (icons, bars, specks read as letters) are dropped first so they
// can't glue neighbouring rows together.
export function lines(words) {
  const all = words
    .filter((w) => w?.text && clean(w.text))
    .map((w) => ({ ...w, yc: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 }));
  const hs = all.filter((w) => clean(w.text).length >= 3).map((w) => w.h).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)] || 20;
  const ws = all.filter((w) => w.h <= 2.0 * med && w.h >= 0.3 * med).sort((a, b) => a.yc - b.yc);
  const out = [];
  for (const w of ws) {
    const l = out.find((x) => Math.abs(x.yc - w.yc) < 0.5 * med);
    if (l) { l.words.push(w); l.yc = (l.yc * (l.words.length - 1) + w.yc) / l.words.length; l.h = Math.max(l.h, w.h); }
    else out.push({ yc: w.yc, h: w.h, words: [w] });
  }
  out.forEach((l) => l.words.sort((a, b) => a.bbox.x0 - b.bbox.x0));
  return out;
}

const union = (ws) => ({
  x0: Math.min(...ws.map((w) => w.bbox.x0)), y0: Math.min(...ws.map((w) => w.bbox.y0)),
  x1: Math.max(...ws.map((w) => w.bbox.x1)), y1: Math.max(...ws.map((w) => w.bbox.y1)),
});

// Best vocabulary match for a string; short names need a closer match.
export function matchName(text, vocab) {
  const n = normalizeName(text);
  if (n.length < 3) return null;
  let best = null;
  for (const v of vocab) {
    const nv = normalizeName(v);
    let s = similarity(n, nv);
    // OCR often adds a stray letter from the icon or outline: allow containment.
    // Only letters may be extra — "luigi40" is a name glued to its points, and its box would be wrong.
    if (n.length > nv.length && n.length <= nv.length + 2 && n.includes(nv) && nv.length >= 4 && !/\d/.test(n)) s = Math.max(s, 0.9 - 0.05 * (n.length - nv.length));
    const need = nv.length <= 4 ? 0.74 : nv.length <= 6 ? 0.66 : 0.6;
    if (s >= need && (!best || s > best.score)) best = { value: v, score: s };
  }
  return best;
}

// Candidate detections (names, numbers, ordinals) from one variant.
const PTS_RE = /^[a-z]?[a-z]?[tfl][s5]\.?$/i; // "pts", "ots", "rts", "ets"…

function detect(words, vocab, variant) {
  const out = [];
  for (const line of lines(words)) {
    const lineText = normalizeName(line.words.map((w) => w.text).join(''));
    const isTitle = /yougot|got1st|place/.test(lineText);
    const ws = line.words.filter((w) => !PTS_RE.test(clean(w.text)));
    const used = new Set();
    // Two-word names first ("Baby Mario"), then single words.
    for (const span of [3, 2, 1]) {
      for (let i = 0; i + span <= ws.length; i++) {
        const slice = ws.slice(i, i + span);
        if (slice.some((w) => used.has(w))) continue;
        if (slice.some((w) => parseOrdinal(w.text) !== null || parseNumber(w.text) || (clean(w.text).match(/\d/g) || []).length >= 2)) continue;
        // Words in a name sit close together.
        const box = union(slice);
        if (span > 1 && box.x1 - box.x0 > 9 * line.h) continue;
        if (slice.some((w, j) => j > 0 && w.bbox.x0 - slice[j - 1].bbox.x1 > 1.3 * line.h)) continue;
        const text = slice.map((w) => clean(w.text)).join(' ');
        const m = matchName(text, vocab);
        if (m) {
          out.push({ type: 'name', value: m.value, score: m.score * (span > 1 ? 1.05 : 1), box, variant, raw: text });
          slice.forEach((w) => used.add(w));
        }
      }
    }
    for (const w of ws) {
      if (isTitle) break; // "You got 1st place!" is not a row
      const o = parseOrdinal(w.text);
      if (o !== null) { out.push({ type: 'ordinal', value: o, box: w.bbox, variant }); continue; }
      const n = parseNumber(w.text);
      if (n) out.push({ type: n.gained ? 'gained' : 'num', value: n.value, box: w.bbox, variant, conf: w.confidence });
    }
    if (isTitle && line.words.length) out.push({ type: 'title', box: union(line.words), variant });
  }
  return out;
}

const cx = (b) => (b.x0 + b.x1) / 2;
const cy = (b) => (b.y0 + b.y1) / 2;
const bh = (b) => b.y1 - b.y0;

// Merge detections of the same thing seen in several variants; vote on value.
function cluster(dets) {
  const groups = [];
  for (const d of dets) {
    const g = groups.find((x) => x.type === d.type
      && Math.abs(cy(x.box) - cy(d.box)) < 0.5 * Math.max(bh(x.box), bh(d.box))
      && Math.abs(cx(x.box) - cx(d.box)) < Math.max(0.6 * (x.box.x1 - x.box.x0), 2 * bh(d.box)));
    if (g) { g.items.push(d); } else groups.push({ type: d.type, box: d.box, items: [d] });
  }
  return groups.map((g) => {
    const votes = new Map();
    for (const d of g.items) votes.set(d.value, (votes.get(d.value) || 0) + (d.score ?? 1));
    const [value, weight] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    const best = g.items.filter((d) => d.value === value);
    // Median box: one variant gluing debris onto a word shouldn't stretch it.
    const med = (k) => { const v = best.map((d) => d.box[k]).sort((a, b) => a - b); return v[Math.floor((v.length - 1) / 2)]; };
    const box = { x0: med('x0'), y0: med('y0'), x1: med('x1'), y1: med('y1') };
    return { type: g.type, value, weight, support: new Set(g.items.map((d) => d.variant)).size, box, raws: [...new Set(best.map((d) => d.raw).filter(Boolean))] };
  });
}

// Least-squares y = a + b·k + c·k² (with outlier removal); null if degenerate.
function quadFit(pairs) {
  const solve = (ps) => {
    // Normal equations for [a, b, c].
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const T = [0, 0, 0];
    for (const [k, y] of ps) {
      const v = [1, k, k * k];
      for (let i = 0; i < 3; i++) { T[i] += v[i] * y; for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j]; }
    }
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(S);
    if (Math.abs(D) < 1e-9) return null;
    const col = (i) => S.map((row, r) => row.map((x, c) => (c === i ? T[r] : x)));
    const [a, b, c] = [0, 1, 2].map((i) => det(col(i)) / D);
    return (k) => a + b * k + c * k * k;
  };
  let f = solve(pairs);
  if (!f) return null;
  const res = pairs.map(([k, y]) => Math.abs(y - f(k)));
  const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)];
  const keep = pairs.filter((_, i) => res[i] <= Math.max(2.5 * med, 3));
  if (keep.length >= 4 && keep.length < pairs.length) f = solve(keep) || f;
  return f;
}

// Least-squares y = a + b·k over (k, y) pairs, with one round of outlier removal.
function fitLine(pairs) {
  const fit = (ps) => {
    const n = ps.length;
    const mk = ps.reduce((s, p) => s + p[0], 0) / n;
    const my = ps.reduce((s, p) => s + p[1], 0) / n;
    const sxx = ps.reduce((s, p) => s + (p[0] - mk) ** 2, 0);
    const b = sxx ? ps.reduce((s, p) => s + (p[0] - mk) * (p[1] - my), 0) / sxx : 0;
    return { a: my - b * mk, b };
  };
  let f = fit(pairs);
  if (pairs.length >= 4) {
    const res = pairs.map((p) => Math.abs(p[1] - (f.a + f.b * p[0])));
    const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)];
    const keep = pairs.filter((_, i) => res[i] <= Math.max(3 * med, 0.25 * Math.abs(f.b)));
    if (keep.length >= 2) f = fit(keep);
  }
  return f;
}

/**
 * Row geometry: rows are evenly spaced, so search pitch p and phase for the
 * grid that puts the most names/ordinals on its lines (preferring the larger
 * pitch, since p/2 fits equally well). Ordinals then fix which line is "1st";
 * without any, a list that spans every row is self-locating, otherwise the
 * top-most name is taken as row 1.
 * anchors: [{ k: row index (0-based) | null, y, w: weight }]
 */
function rowModel(anchors, nRows, height, textH) {
  if (anchors.length < 2) return null;
  const ys = anchors.map((a) => a.y);
  const span = Math.max(...ys) - Math.min(...ys);
  const pMin = Math.max(1.05 * textH, span / (nRows - 1 + 0.6));
  const pMax = Math.min(height / (nRows - 1), 3.2 * textH);
  if (!(pMax > pMin)) return null;
  let best = null;
  for (let p = pMin; p <= pMax; p += 0.5) {
    for (let ph = 0; ph < p; ph += p / 24) {
      let score = 0;
      for (const a of anchors) {
        const d = Math.abs(((a.y - ph) % p + p) % p);
        const off = Math.min(d, p - d);
        if (off < 0.22 * p) score += a.w * (1 - off / (0.22 * p));
      }
      // Tie-break toward the larger pitch (p/2 explains the same points).
      score += p * 1e-4;
      if (!best || score > best.score) best = { score, p, ph };
    }
  }
  const { p, ph } = best;
  const gridK = (y) => Math.round((y - ph) / p);
  const onLine = anchors.filter((a) => Math.abs(a.y - (ph + gridK(a.y) * p)) < 0.3 * p);
  const ks = onLine.map((a) => gridK(a.y));
  const kMin = Math.min(...ks);
  // Which grid line is row 0?
  const votes = new Map();
  for (const a of onLine.filter((x) => x.k !== null)) {
    const base = gridK(a.y) - a.k;
    votes.set(base, (votes.get(base) || 0) + 1);
  }
  let base = kMin;
  let locked = false;
  if (votes.size) {
    base = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0];
    locked = true;
  } else if (Math.max(...ks) - kMin + 1 >= nRows) {
    locked = true;
  }
  return { a: ph + base * p, b: p, locked };
}

/**
 * Pass 1 — whole-image sparse OCR → screen kind, row geometry, first guesses,
 * and the cells (name / points boxes) worth re-reading one by one.
 *
 * @param ocr   { width, height, variants: { name: words[] } }
 * @param opts  { extraNames: [] }  — Mii names of the group
 */
export function planScreen(ocr, opts = {}) {
  const vocab = vocabulary(opts);
  const dets = Object.entries(ocr.variants).flatMap(([v, words]) => detect(words, vocab, v));
  const groups = cluster(dets);
  const W = ocr.width;
  const H = ocr.height;
  const names = groups.filter((g) => g.type === 'name');
  const nums = groups.filter((g) => g.type === 'num');
  const gaineds = groups.filter((g) => g.type === 'gained');
  const ords = groups.filter((g) => g.type === 'ordinal');

  // ---- which screen? Final screens have a title and two columns of names.
  const title = groups.some((g) => g.type === 'title');
  const xs = names.map((n) => cx(n.box) / W).sort((a, b) => a - b);
  let split = null;
  let gap = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > gap) { gap = xs[i] - xs[i - 1]; split = (xs[i] + xs[i - 1]) / 2; }
  const leftN = split === null ? 0 : xs.filter((x) => x < split).length;
  const twoCols = gap > 0.18 && leftN >= 2 && xs.length - leftN >= 2;
  const ordSplit = ords.some((o) => o.value >= 7 && cx(o.box) / W > 0.35) && ords.some((o) => o.value <= 6 && cx(o.box) / W < 0.3);
  const kind = names.length < 2 ? 'unknown' : title || twoCols || ordSplit ? 'final' : 'standings';
  if (kind === 'unknown') return { kind, slots: [], issues: ['No result rows found — retake the photo straight on, filling the frame with the list.'] };
  const splitX = kind === 'final' ? (twoCols ? split : 0.47) * W : W;

  const nRows = kind === 'final' ? 6 : 12;
  const colOf = (b) => (cx(b) < splitX ? 0 : 1);
  // Text height from single-word detections (multi-word spans pick up debris).
  const hs = [...ords, ...names.filter((n) => !n.value.includes(' '))].map((n) => bh(n.box)).sort((a, b) => a - b);
  const textH = hs[Math.floor(hs.length / 2)] || H / 40;
  const anchors = [
    // An ordinal must agree with its column on the final screen (1st-6th left, 7th-12th right).
    ...ords.filter((o) => kind !== 'final' || (o.value >= 7) === (colOf(o.box) === 1))
      .map((o) => ({ k: (o.value - 1) % nRows, y: cy(o.box), w: 1.5 })),
    ...names.map((n) => ({ k: null, y: cy(n.box), w: Math.min(1.5, n.weight) })),
  ];
  const model = rowModel(anchors, nRows, H, textH);
  if (!model) return { kind, slots: [], issues: ['Could not line up the rows — retake the photo straight on.'] };
  // Perspective makes the pitch change down the list, so after the even grid
  // has fixed row indices, fit y = a + b·k + c·k² through the anchors and use
  // that curve; then re-centre each row on the text actually found in it.
  let curve = (k) => model.a + model.b * k;
  for (let pass = 0; pass < 2; pass++) {
    const pairs = [];
    for (const a of anchors) {
      const k = a.k !== null && model.locked ? a.k : Math.round((a.y - model.a) / model.b);
      if (k >= 0 && k < nRows && Math.abs(a.y - curve(k)) < 0.45 * model.b) pairs.push([k, a.y]);
    }
    if (new Set(pairs.map((x) => x[0])).size < 4) break;
    curve = quadFit(pairs) || curve;
  }
  const gridY = curve;
  const rowOf = (y) => {
    let best = 0;
    for (let k = 1; k < nRows; k++) if (Math.abs(gridY(k) - y) < Math.abs(gridY(best) - y)) best = k;
    return best;
  };
  const refined = Array.from({ length: nRows }, (_, k) => {
    const near = [...names, ...ords, ...nums].filter((d) => Math.abs(cy(d.box) - gridY(k)) < 0.35 * model.b && bh(d.box) < 1.6 * textH);
    return near.length ? near.reduce((t, d) => t + cy(d.box), 0) / near.length : null;
  });
  const rowY = (k) => (refined[k] !== null ? refined[k] : gridY(k));

  // ---- names into slots (column, row); the best-supported name wins a slot.
  const slotName = new Map();
  for (const n of [...names].sort((a, b) => b.weight - a.weight)) {
    const k = rowOf(cy(n.box));
    if (k < 0 || k >= nRows || Math.abs(cy(n.box) - gridY(k)) > 0.45 * model.b) continue;
    const key = `${colOf(n.box)}:${k}`;
    if (!slotName.has(key)) slotName.set(key, n);
  }

  // ---- column geometry from what was found (falls back to the fixed layout).
  const cols = kind === 'final' ? [0, 1] : [0];
  const geom = cols.map((col) => ({ ...columnGeometry(col), ordRight: ordRightOf(col) }));
  function ordRightOf(col) {
    const xs = ords.filter((o) => colOf(o.box) === col).map((o) => o.box.x1).sort((a, b) => a - b);
    return xs.length >= 2 ? xs[Math.floor(xs.length / 2)] : null;
  }
  function columnGeometry(col) {
    const ns = [...slotName.entries()].filter(([key]) => key.startsWith(`${col}:`)).map(([, n]) => n);
    const lo = col ? splitX : 0;
    const hi = col ? W : splitX;
    const nameX0 = ns.length ? Math.min(...ns.map((n) => n.box.x0)) : lo + 0.12 * (hi - lo);
    const nameX1 = ns.length ? Math.max(...ns.map((n) => n.box.x1)) : lo + 0.6 * (hi - lo);
    const ptsX = nums.filter((g) => colOf(g.box) === col && cx(g.box) > nameX1 - textH).map((g) => g.box);
    if (kind === 'final') {
      // The total follows the name inside the same bar; the left column's bars
      // stop just before the 7th-12th labels. Cells start at the name's end
      // (clamped near the column's typical name end, in case a name box
      // swallowed something) and the digit finder takes the right-most glyphs.
      const rights = ns.map((n) => n.box.x1).sort((a, b) => a - b);
      const medRight = rights.length ? rights[Math.floor(rights.length / 2)] : (col ? 0.8 * W : splitX - 3 * textH);
      const rightOrds = ords.filter((o) => o.value >= 7 && colOf(o.box) === 1).map((o) => o.box.x0).sort((a, b) => a - b);
      const stop = col === 0
        ? (rightOrds.length ? rightOrds[Math.floor(rightOrds.length / 2)] - 0.2 * textH : splitX + 0.5 * textH)
        : W;
      // Best evidence: totals read in pass 1 right after a name share one right edge.
      const ends = [];
      for (const n of ns) {
        const d = nums.filter((q) => Math.abs(cy(q.box) - cy(n.box)) < 0.6 * textH && q.box.x0 > n.box.x1 - 0.6 * textH && q.box.x0 < n.box.x1 + 1.5 * textH && bh(q.box) < 1.5 * textH)
          .sort((a, b) => a.box.x0 - b.box.x0)[0];
        if (d) ends.push(d.box.x1);
      }
      ends.sort((a, b) => a - b);
      if (ends.length >= 2) {
        const end = Math.min(stop, ends[Math.floor(ends.length / 2)] + 0.45 * textH);
        return { nameX0: Math.max(lo, nameX0 - 1.2 * textH), nameX1: nameX1 + textH, ptsX0: end - 3.0 * textH, ptsX1: end };
      }
      return { nameX0: Math.max(lo, nameX0 - 1.2 * textH), nameX1: nameX1 + textH, ptsX0: null, ptsX1: null, medRight, stop };
    }
    // Totals are right-aligned at the end of the bars: use the median right edge
    // of numbers found there (robust to a stray number elsewhere).
    const rights = nums.filter((g) => cx(g.box) > 0.6 * W).map((g) => g.box.x1).sort((a, b) => a - b);
    const right = rights.length ? rights[Math.floor(rights.length / 2)] : 0.97 * W;
    return { nameX0: Math.max(0, nameX0 - 1.5 * textH), nameX1: Math.min(W, nameX1 + 1.5 * textH), ptsX0: Math.max(0.5 * W, right - 6 * textH), ptsX1: Math.min(W, right + 1.5 * textH) };
  }

  const slots = [];
  for (const col of cols) {
    const g = geom[col];
    for (let k = 0; k < nRows; k++) {
      const y = rowY(k);
      const n = slotName.get(`${col}:${k}`) || null;
      const inRow = (d) => Math.abs(cy(d.box) - y) < 0.5 * model.b;
      const cand = nums.filter((d) => inRow(d) && cx(d.box) > g.ptsX0 - textH && cx(d.box) < g.ptsX1 + textH)
        .sort((a, b) => b.weight - a.weight);
      const gd = gaineds.find((d) => inRow(d) && colOf(d.box) === col);
      const half = Math.min(0.5 * model.b, 1.1 * textH);
      // Final-screen totals have a small "pts" under the digits: give the cell room below.
      // Final-screen totals sit above a small "pts": read only the digits.
      const p = model.b;
      const px0 = g.ptsX0 ?? Math.min(n ? n.box.x1 : g.medRight, g.medRight + 2 * textH) - 0.3 * textH;
      const ptsBox = { x0: px0, x1: g.ptsX1 ?? Math.min(g.stop, px0 + 3.4 * textH), y0: y - (kind === 'final' ? 0.55 : 0.48) * p, y1: y + (kind === 'final' ? 0.18 : 0.55) * p };
      // Character icon: just right of the place label ("1st"), one icon wide.
      const iconBox = g.ordRight !== null
        ? { x0: g.ordRight + 0.15 * textH, x1: g.ordRight + 1.95 * textH, y0: y - 0.9 * textH, y1: y + 0.9 * textH }
        : null;
      slots.push({
        place: col * 6 + k + 1,
        col,
        y,
        name: n ? { value: n.value, weight: n.weight, raw: n.raws[0] } : null,
        points: cand[0] ? { value: cand[0].value, weight: cand[0].weight } : null,
        gained: gd ? gd.value : null,
        cells: {
          icon: iconBox && clampBox(iconBox, W, H),
          name: clampBox({ x0: n ? n.box.x0 - 1.2 * textH : g.nameX0, x1: n ? n.box.x1 + 1.2 * textH : g.nameX1, y0: y - half, y1: y + half }, W, H),
          points: clampBox(ptsBox, W, H),
        },
        rowBox: clampBox({ x0: col ? splitX : 0, x1: kind === 'final' && !col ? splitX : W, y0: y - model.b / 2, y1: y + model.b / 2 }, W, H),
      });
    }
  }
  const phase = kind === 'standings' ? (slots.filter((s) => s.gained !== null).length >= 2 ? 'race' : 'totals') : null;
  return { kind, phase, slots, pitch: model.b, textH, issues: [] };
}

const clampBox = (b, W, H) => {
  const x0 = Math.round(Math.min(W - 2, Math.max(0, b.x0)));
  const y0 = Math.round(Math.min(H - 2, Math.max(0, b.y0)));
  return { x0, y0, x1: Math.round(Math.max(x0 + 2, Math.min(W, b.x1))), y1: Math.round(Math.max(y0 + 2, Math.min(H, b.y1))) };
};

export const vocabulary = (opts = {}) => [...CHARACTERS.filter((c) => c !== 'Mii'), ...(opts.extraNames || []).filter(Boolean)];

// Read a name out of one cell's OCR words (several variants).
export function readNameCell(variantsWords, vocab) {
  const votes = new Map();
  for (const words of variantsWords) {
    const text = words.filter((w) => /[A-Za-z]/.test(w.text)).map((w) => clean(w.text)).join(' ');
    const tries = [text, text.replace(/ /g, '')];
    // Also each word on its own (icon/wheel debris around the name).
    const parts = text.split(' ');
    for (let i = 0; i < parts.length; i++) {
      tries.push(parts[i]);
      if (i + 1 < parts.length) tries.push(`${parts[i]} ${parts[i + 1]}`);
    }
    let best = null;
    for (const t of tries) {
      const m = matchName(t, vocab);
      // "Baby Daisy" must beat its own substring "Daisy".
      if (m) m.score *= m.value.includes(' ') ? 1.08 : 1;
      if (m && (!best || m.score > best.score)) best = { ...m, raw: t };
    }
    if (best) votes.set(best.value, { weight: (votes.get(best.value)?.weight || 0) + best.score, raw: best.raw });
  }
  const top = [...votes.entries()].sort((a, b) => b[1].weight - a[1].weight)[0];
  return top ? { value: top[0], weight: top[1].weight, raw: top[1].raw } : null;
}

/**
 * Isolate the total's digits in a binary cell mask (255 = ink).
 * Totals are the right-most group of tall glyphs in the cell; "pts", the
 * wheel icon, "+gained" and specks are smaller or further left.
 * mask: { data: Uint8Array|Uint8ClampedArray (w*h, 0/255), width, height }
 * Returns { data, width, height } (black ink on white, padded) or null.
 */
export function isolateDigits(mask) {
  const { width: W, height: H } = mask;
  // Bar edges and frame lines run across the cell and glue digits into one
  // huge blob: erase horizontal ink runs much longer than a digit is wide.
  const data = Uint8Array.from(mask.data);
  const maxRun = Math.max(8, Math.round(1.5 * H));
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!data[y * W + x]) { x++; continue; }
      let e = x;
      while (e < W && data[y * W + e]) e++;
      if (e - x > maxRun) data.fill(0, y * W + x, y * W + e);
      x = e;
    }
  }
  const lab = new Int32Array(W * H);
  const stats = [null];
  const stack = [];
  let next = 1;
  for (let i = 0; i < W * H; i++) {
    if (!data[i] || lab[i]) continue;
    let x0 = W; let y0 = H; let x1 = -1; let y1 = -1; let area = 0;
    lab[i] = next; stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      const x = p % W; const y = (p - x) / W;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W || (!dx && !dy)) continue;
          const q = yy * W + xx;
          if (data[q] && !lab[q]) { lab[q] = next; stack.push(q); }
        }
      }
    }
    stats.push({ id: next, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
    next++;
  }
  const comps = stats.slice(1).filter((c) => c.h > 0.3 * H && c.h < 0.95 * H && c.w < 2.4 * c.h && c.area > 0.12 * c.w * c.h);
  if (!comps.length) return null;
  const hmax = Math.max(...comps.map((c) => c.h));
  const tall = comps.filter((c) => c.h > 0.7 * hmax).sort((a, b) => a.x - b.x);
  const group = [tall[tall.length - 1]];
  for (let i = tall.length - 2; i >= 0; i--) {
    const c = tall[i]; const g0 = group[0];
    if (g0.x - (c.x + c.w) < 0.45 * hmax && Math.abs(c.y + c.h / 2 - (g0.y + g0.h / 2)) < 0.3 * hmax) group.unshift(c);
    else break;
  }
  const keep = group.slice(-3);
  const ids = new Set(keep.map((c) => c.id));
  const gx0 = Math.min(...keep.map((c) => c.x)); const gx1 = Math.max(...keep.map((c) => c.x + c.w));
  const gy0 = Math.min(...keep.map((c) => c.y)); const gy1 = Math.max(...keep.map((c) => c.y + c.h));
  const pad = 14;
  const ow = gx1 - gx0 + 2 * pad; const oh = gy1 - gy0 + 2 * pad;
  const out = new Uint8ClampedArray(ow * oh).fill(255);
  for (let y = gy0; y < gy1; y++) {
    for (let x = gx0; x < gx1; x++) {
      if (ids.has(lab[y * W + x])) out[(y - gy0 + pad) * ow + (x - gx0 + pad)] = 0;
    }
  }
  return { data: out, width: ow, height: oh, glyphs: keep.length };
}

/**
 * Score candidate totals for one row from several digit reads
 * (reads: [{ text, confidence }], one per binarisation that found digits).
 * A lone digit that matches the end of a two-digit read supports it
 * ("45" often reads as "5" when the 4 is faint).
 */
export function pointsCandidates(reads, prior = {}) {
  const score = new Map();
  for (const r of reads || []) {
    const t = String(r.text || '').replace(/\D/g, '');
    if (!t || t.length > 2) continue;
    const v = Number(t);
    score.set(v, (score.get(v) || 0) + (0.5 + (r.confidence ?? 50) / 100) * (t.length === 1 && prior.twoDigits ? 0.4 : 1));
  }
  const base = [...score.entries()];
  for (const [v, sc] of base) {
    if (v < 10) for (const [u] of base) if (u >= 10 && u % 10 === v) score.set(u, score.get(u) + 0.7 * sc);
  }
  return score;
}

/**
 * Choose one total per row so totals never increase down the list (the
 * final screen and sorted standings are ordered by points). Rows may be
 * left unread (null) at no cost; ties are allowed.
 * cands: [Map value→score] in place order.
 */
export function decodeDescending(cands) {
  let states = new Map([[Infinity, { score: 0, picks: [] }]]);
  for (const c of cands) {
    const nextStates = new Map();
    const offer = (key, st) => { const cur = nextStates.get(key); if (!cur || cur.score < st.score) nextStates.set(key, st); };
    for (const [last, st] of states) {
      offer(last, { score: st.score, picks: [...st.picks, null] });
      for (const [v, sc] of c) if (v <= last) offer(v, { score: st.score + sc, picks: [...st.picks, v] });
    }
    states = nextStates;
  }
  return [...states.values()].sort((a, b) => b.score - a.score)[0].picks;
}

/**
 * Pass 2 — combine the plan with per-cell OCR.
 * cellOcr: { [place]: { name: [words per variant], points: [{ text, confidence }], human: bool|null } }
 */
export function finishScreen(plan, cellOcr, opts = {}) {
  if (!plan.slots.length) return { kind: plan.kind, phase: null, rows: [], issues: plan.issues };
  const vocab = vocabulary(opts);
  const cands = plan.slots.map((s) => {
    // In a 4-race GP the top half of the table almost always has 2-digit totals.
    const m = pointsCandidates(cellOcr[s.place]?.points, { twoDigits: s.place <= 6 });
    if (s.points && s.points.value <= 99) m.set(s.points.value, (m.get(s.points.value) || 0) + 0.4 * s.points.weight);
    return m;
  });
  const best = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  let phase = plan.phase;
  if (phase === 'totals') {
    // "+gained" is often too small to read, but an after-race screen gives it
    // away anyway: its totals are confidently out of order.
    const sure = cands.map((m) => { const b = m.size ? best(m) : null; return b && b[1] >= 1.2 ? b[0] : null; });
    let inversions = 0;
    for (let i = 1; i < sure.length; i++) {
      const prev = sure.slice(0, i).filter((x) => x !== null).pop();
      if (sure[i] !== null && prev !== undefined && sure[i] > prev + 2) inversions++;
    }
    if (inversions >= 2) phase = 'race';
  }
  const sorted = plan.kind === 'final' || phase === 'totals';
  const picks = sorted ? decodeDescending(cands) : cands.map((m) => (m.size ? best(m)[0] : null));

  const rows = plan.slots.map((s, i) => {
    const c = cellOcr[s.place] || {};
    const cn = c.name ? readNameCell(c.name, vocab) : null;
    let name = s.name;
    if (cn && (!name || cn.value === name.value || cn.weight > name.weight * 1.2)) {
      name = cn.value === name?.value ? { ...name, weight: name.weight + cn.weight } : cn;
    }
    const pts = picks[i];
    const ptsScore = pts === null ? 0 : cands[i].get(pts) || 0;
    const nm = name?.value ?? null;
    return {
      place: s.place,
      name: nm,
      // The row shows the character's name unless the player uses a Mii name.
      character: nm && CHARACTER_SET.has(nm) ? nm : null,
      characterConfidence: nm && CHARACTER_SET.has(nm) ? 0.9 : 0,
      characterSource: nm && CHARACTER_SET.has(nm) ? 'name' : null,
      rawName: name?.raw ?? null,
      points: pts,
      gained: phase === 'race' ? POINTS_TABLE[s.place - 1] : s.gained,
      human: c.human ?? null,
      nameBox: s.cells.name,
      pointsBox: s.cells.points,
      iconBox: s.cells.icon,
      rowBox: s.rowBox,
      confidence: Math.round(100 * (0.6 * Math.min(1, (name?.weight || 0) / 1.6) + 0.4 * Math.min(1, ptsScore / 2))),
    };
  });

  // Each character appears once: keep the stronger claim (Mii names may repeat).
  const byName = new Map();
  rows.forEach((r) => { if (r.name) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); } });
  const miis = new Set((opts.extraNames || []).filter(Boolean));
  for (const [nm, rs] of byName) {
    if (rs.length > 1 && !miis.has(nm)) rs.sort((a, b) => b.confidence - a.confidence).slice(1).forEach((r) => { r.name = null; });
  }

  const issues = [];
  rows.forEach((r) => {
    if (!r.name) issues.push(`Couldn't read the name in ${ordinalStr(r.place)}.`);
    if (r.points === null) issues.push(`Couldn't read the points for ${ordinalStr(r.place)}.`);
  });
  const top = rows.map((r) => r.points).filter((x) => x !== null);
  if (top.some((x) => x > 60)) issues.push('Totals above 60 mean more than 4 races were played — this looks like a longer VS session; enter the total for the 4 races.');
  return { kind: plan.kind, phase, rows, issues };
}

const POINTS_TABLE = [15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0];
const CHARACTER_SET = new Set(CHARACTERS);

/**
 * Which rows are human players? Their rows get a bright coloured bar; CPU
 * rows don't. bars: [{ place, h, s, v }] — median HSV (OpenCV ranges: h 0-180)
 * of thin strips just above and below each name. Returns { place: bool }.
 *  - standings: CPU rows are dark/translucent → low saturation·value.
 *  - final: CPU rows sit on the plain blue background → hue/value match it.
 */
export function detectHumans(kind, bars) {
  const out = {};
  if (!bars.length) return out;
  if (kind === 'final') {
    const med = (k) => { const v = bars.map((b) => b[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    const bgH = med('h'); const bgV = med('v');
    for (const b of bars) out[b.place] = Math.max(Math.abs(b.h - bgH) / 8, (b.v - bgV) / 40) > 1;
  } else {
    const score = bars.map((b) => (b.s * b.v) / 255);
    const mx = Math.max(...score) || 1;
    bars.forEach((b, i) => { out[b.place] = score[i] > 0.55 * mx; });
  }
  return out;
}

const ordinalStr = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
