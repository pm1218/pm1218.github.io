// Browser image-analysis engine for Mario Kart Wii result photos.
// OpenCV.js (computer vision) + Tesseract.js (OCR), all on the uploader's
// phone — nothing to host, photos stay private.
//
// Pipeline, tuned on real photos of a TV:
//   1. find the TV picture (largest bright/saturated region) and crop to it
//   2. straighten it (median angle of the long horizontal bar edges)
//   3. pass 1 — sparse OCR of three binarisations of the whole screen →
//      wii-layout.planScreen(): which screen (standings / final), where each
//      row and each name / total cell is
//   4. pass 2 — every cell is cut from a 2× copy of the straightened photo:
//        names:  3 binarisations, single-line OCR, letters only, matched to
//                the 25 characters + the group's Mii names
//        totals: 6 binarisations → isolateDigits() keeps the right-most tall
//                glyphs (drops "pts", "+gained", the wheel icon, bar edges)
//                → single-line OCR, digits only
//   5. bar colour under each name → which rows are human players
//   6. wii-layout.finishScreen(): votes, "totals go down the list" decoding,
//      duplicate-character cleanup, issues for the uploader to check
//   7. icons next to each name are matched against the group's learned
//      templates (only needed for rows showing a Mii name)
//
// Accuracy on 17 real photos (tests/fixtures/wii): screen type 17/17;
// player rows — name 87%, total 81%; all rows — name 89%, total 67%.
// The uploader always reviews and corrects before confirming.

import { planScreen, finishScreen, isolateDigits, detectHumans } from './wii-layout.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
// docs.opencv.org can't be loaded cross-site reliably; jsDelivr serves the same 4.10 build.
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const WORK = 1600; // pass-1 working width
const HI = 3200;   // cell crops come from up to this width
export const ICON_SIZE = 48;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.';

// ------------------------------------------------------------------ loaders
function loadScript(src, timeoutMs) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing?.dataset.loaded) return resolve();
    const s = existing || document.createElement('script');
    const timer = setTimeout(() => reject(new Error(`Timed out loading ${src}`)), timeoutMs);
    s.addEventListener('load', () => { clearTimeout(timer); s.dataset.loaded = '1'; resolve(); });
    s.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Couldn't load ${src} — check your connection`)); });
    if (!existing) { s.src = src; s.async = true; document.head.appendChild(s); }
  });
}

let cvPromise = null;
export function loadOpenCV() {
  if (!cvPromise) {
    cvPromise = loadScript(OPENCV_URL, 90000).then(() => new Promise((resolve, reject) => {
      const cv = window.cv;
      if (!cv) return reject(new Error('OpenCV failed to start'));
      if (cv.Mat) return resolve(cv);
      if (typeof cv.then === 'function') return cv.then((m) => { window.cv = m; resolve(m); });
      cv.onRuntimeInitialized = () => resolve(window.cv);
    })).catch((e) => { cvPromise = null; throw e; });
  }
  return cvPromise;
}

let workerPromise = null;
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT_URL, 60000);
      return window.Tesseract.createWorker('eng', 1);
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// ------------------------------------------------------------------ helpers
const newCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

async function fileToBitmap(file) {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

function drawScaled(src, sx, sy, sw, sh, dw, dh) {
  const c = newCanvas(dw, dh);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

const matToCanvas = (cv, mat) => { const c = newCanvas(mat.cols, mat.rows); cv.imshow(c, mat); return c; };

// Downscale for upload (keeps the free storage tier roomy).
export function compressForUpload(canvas, maxWidth = 1400) {
  const s = Math.min(1, maxWidth / canvas.width);
  const c = drawScaled(canvas, 0, 0, canvas.width, canvas.height, canvas.width * s, canvas.height * s);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
}

export const canvasToBlob = (canvas, type = 'image/png') => new Promise((r) => canvas.toBlob(r, type));

export async function blobToIconCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = drawScaled(bmp, 0, 0, bmp.width, bmp.height, ICON_SIZE, ICON_SIZE);
  bmp.close?.();
  return c;
}

// ---------------------------------------------------- 1-2. crop + straighten
// Largest bright or saturated region = the TV picture. Returns a rect in the
// given mat's coordinates.
function screenRect(cv, rgba) {
  const W = rgba.cols; const H = rgba.rows;
  const rgb = new cv.Mat(); const hsv = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const ch = new cv.MatVector(); cv.split(hsv, ch);
  const S = ch.get(1); const V = ch.get(2);
  const a = new cv.Mat(); const b = new cv.Mat(); const c = new cv.Mat(); const m = new cv.Mat();
  cv.threshold(S, a, 90, 255, cv.THRESH_BINARY);
  cv.threshold(V, b, 90, 255, cv.THRESH_BINARY);
  cv.bitwise_and(a, b, m);
  cv.threshold(V, c, 215, 255, cv.THRESH_BINARY);
  cv.bitwise_or(m, c, m);
  const k = Math.max(5, Math.floor(W / 60));
  const kern = cv.Mat.ones(k, k, cv.CV_8U);
  cv.morphologyEx(m, m, cv.MORPH_CLOSE, kern);
  cv.morphologyEx(m, m, cv.MORPH_OPEN, kern);
  const labels = new cv.Mat(); const stats = new cv.Mat(); const cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(m, labels, stats, cents);
  let best = null;
  for (let i = 1; i < n; i++) {
    const area = stats.intAt(i, cv.CC_STAT_AREA);
    if (!best || area > best.area) {
      best = { area, x: stats.intAt(i, cv.CC_STAT_LEFT), y: stats.intAt(i, cv.CC_STAT_TOP), w: stats.intAt(i, cv.CC_STAT_WIDTH), h: stats.intAt(i, cv.CC_STAT_HEIGHT) };
    }
  }
  [rgb, hsv, S, V, a, b, c, m, kern, labels, stats, cents].forEach((x) => x.delete());
  ch.delete();
  if (!best || best.area < 0.08 * W * H) return { x: 0, y: 0, w: W, h: H };
  const pad = Math.floor(0.02 * Math.max(best.w, best.h));
  const x0 = Math.max(0, best.x - pad); const y0 = Math.max(0, best.y - pad);
  return { x: x0, y: y0, w: Math.min(W, best.x + best.w + pad) - x0, h: Math.min(H, best.y + best.h + pad) - y0 };
}

// Weighted median angle (degrees) of long near-horizontal lines.
function skewAngle(cv, rgba) {
  const gray = new cv.Mat(); const edges = new cv.Mat(); const lines = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  cv.Canny(gray, edges, 60, 160);
  cv.HoughLinesP(edges, lines, 1, Math.PI / 720, 120, Math.floor(0.3 * rgba.cols), 8);
  const items = [];
  for (let i = 0; i < lines.rows; i++) {
    const [x1, y1, x2, y2] = lines.data32S.slice(i * 4, i * 4 + 4);
    const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    if (Math.abs(ang) < 15) items.push([ang, Math.hypot(x2 - x1, y2 - y1)]);
  }
  [gray, edges, lines].forEach((x) => x.delete());
  if (!items.length) return 0;
  items.sort((p, q) => p[0] - q[0]);
  const total = items.reduce((s, x) => s + x[1], 0);
  let acc = 0;
  for (const [ang, w] of items) { acc += w; if (acc >= total / 2) return ang; }
  return 0;
}

function rotate(cv, mat, angle) {
  const out = new cv.Mat();
  const M = cv.getRotationMatrix2D(new cv.Point(mat.cols / 2, mat.rows / 2), angle, 1);
  cv.warpAffine(mat, out, M, new cv.Size(mat.cols, mat.rows), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  M.delete();
  return out;
}

/**
 * Straightened screen at two resolutions: `lo` (1600 wide, for layout) and
 * `hi` (up to 3200 wide, same geometry ×k, for reading cells).
 */
function prepare(cv, bitmap) {
  const s0 = WORK / Math.max(bitmap.width, bitmap.height);
  const small = drawScaled(bitmap, 0, 0, bitmap.width, bitmap.height, bitmap.width * s0, bitmap.height * s0);
  const smallMat = cv.imread(small);
  const r = screenRect(cv, smallMat);
  smallMat.delete();
  // Crop region in original-photo pixels.
  const ox = r.x / s0; const oy = r.y / s0; const ow = r.w / s0; const oh = r.h / s0;
  const loW = WORK; const loH = (oh / ow) * loW;
  const loCanvas = drawScaled(bitmap, ox, oy, ow, oh, loW, loH);
  const loMat = cv.imread(loCanvas);
  const angle = skewAngle(cv, loMat);
  const lo = rotate(cv, loMat, angle);
  loMat.delete();
  const hiW = Math.min(HI, Math.max(loW, ow));
  const hiCanvas = drawScaled(bitmap, ox, oy, ow, oh, hiW, (oh / ow) * hiW);
  const hiMat = cv.imread(hiCanvas);
  const hi = rotate(cv, hiMat, angle);
  hiMat.delete();
  return { lo, hi, k: hiW / loW, angle };
}

// ------------------------------------------------------ 3. pass-1 variants
function hsvChannels(cv, rgba) {
  const rgb = new cv.Mat(); const hsv = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const ch = new cv.MatVector(); cv.split(hsv, ch);
  const H = ch.get(0); const S = ch.get(1); const V = ch.get(2);
  rgb.delete(); hsv.delete(); ch.delete();
  return { H, S, V };
}

// mask = lo ≤ channel ≤ hi for each given channel, ANDed together.
function rangeMask(cv, chans) {
  let out = null;
  for (const [mat, lo, hi] of chans) {
    const a = new cv.Mat(); const b = new cv.Mat();
    cv.threshold(mat, a, lo - 1, 255, cv.THRESH_BINARY);      // > lo-1
    cv.threshold(mat, b, hi, 255, cv.THRESH_BINARY_INV);       // ≤ hi
    cv.bitwise_and(a, b, a);
    if (out) { cv.bitwise_and(out, a, out); a.delete(); } else out = a;
    b.delete();
  }
  return out;
}

function tophat(cv, V, k) {
  const kern = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
  const th = new cv.Mat(); const out = new cv.Mat();
  cv.morphologyEx(V, th, cv.MORPH_TOPHAT, kern);
  cv.threshold(th, out, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  kern.delete(); th.delete();
  return out;
}

function openSmall(cv, m) {
  const k = cv.Mat.ones(2, 2, cv.CV_8U);
  cv.morphologyEx(m, m, cv.MORPH_OPEN, k);
  k.delete();
  return m;
}

function invertToCanvas(cv, m, border = 0) {
  const inv = new cv.Mat();
  cv.bitwise_not(m, inv);
  let out = inv;
  if (border) {
    out = new cv.Mat();
    cv.copyMakeBorder(inv, out, border, border, border, border, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    inv.delete();
  }
  const c = matToCanvas(cv, out);
  out.delete();
  return c;
}

function pass1Variants(cv, lo) {
  const { H, S, V } = hsvChannels(cv, lo);
  const white = openSmall(cv, rangeMask(cv, [[S, 0, 84], [V, 176, 255]]));
  const top = openSmall(cv, tophat(cv, V, Math.max(9, Math.floor(lo.rows / 35)) | 1));
  const gray = new cv.Mat();
  cv.cvtColor(lo, gray, cv.COLOR_RGBA2GRAY);
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  clahe.apply(gray, gray);
  const out = { white: invertToCanvas(cv, white), tophat: invertToCanvas(cv, top), gray: invertToCanvas(cv, gray) };
  [H, S, V, white, top, gray].forEach((m) => m.delete());
  clahe.delete();
  return out;
}

async function recognizeWords(worker, canvas, psm, whitelist = '') {
  await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist, preserve_interword_spaces: '1' });
  const { data } = await worker.recognize(canvas);
  return (data.words || []).map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox }));
}

// --------------------------------------------------------- 4. cell reading
function cropMat(cv, mat, box, k, targetH) {
  const x0 = Math.max(0, Math.round(box.x0 * k)); const y0 = Math.max(0, Math.round(box.y0 * k));
  const x1 = Math.min(mat.cols, Math.round(box.x1 * k)); const y1 = Math.min(mat.rows, Math.round(box.y1 * k));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const roi = mat.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
  const out = new cv.Mat();
  const f = targetH / (y1 - y0);
  cv.resize(roi, out, new cv.Size(Math.max(2, Math.round((x1 - x0) * f)), targetH), 0, 0, cv.INTER_CUBIC);
  roi.delete();
  return out;
}

function nameVariants(cv, c) {
  const { H, S, V } = hsvChannels(cv, c);
  const gray = new cv.Mat(); cv.cvtColor(c, gray, cv.COLOR_RGBA2GRAY);
  const white = rangeMask(cv, [[S, 0, 84], [V, 176, 255]]);
  const top = tophat(cv, V, Math.max(7, Math.floor(c.rows * 0.35)) | 1);
  const otsu = new cv.Mat(); cv.threshold(gray, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const out = [white, top, otsu].map((m) => invertToCanvas(cv, m, 12));
  [H, S, V, gray, white, top, otsu].forEach((m) => m.delete());
  return out;
}

function digitMasks(cv, c) {
  const { H, S, V } = hsvChannels(cv, c);
  const gray = new cv.Mat(); cv.cvtColor(c, gray, cv.COLOR_RGBA2GRAY);
  const adapt = new cv.Mat();
  cv.adaptiveThreshold(gray, adapt, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, Math.floor(c.rows * 0.9) | 1, -12);
  const masks = [
    adapt,
    rangeMask(cv, [[H, 89, 139], [S, 61, 255], [V, 121, 255]]),   // CPU totals: blue digits
    rangeMask(cv, [[S, 0, 84], [V, 176, 255]]),                    // human totals: white digits
    rangeMask(cv, [[S, 0, 119], [V, 151, 255]]),
    rangeMask(cv, [[H, 96, 134], [S, 111, 255], [V, 111, 255]]),
    tophat(cv, V, Math.max(7, Math.floor(c.rows * 0.35)) | 1),
  ].map((m) => openSmall(cv, m));
  [H, S, V, gray].forEach((m) => m.delete());
  const out = masks.map((m) => ({ data: Uint8Array.from(m.data), width: m.cols, height: m.rows }));
  masks.forEach((m) => m.delete());
  return out;
}

function grayToCanvas(img) {
  const c = newCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = img.data[i];
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

// Median HSV of thin strips just above and below a name → bar colour.
function barColour(cv, lo, nameBox, textH) {
  const yc = (nameBox.y0 + nameBox.y1) / 2;
  const strips = [[yc - 0.62 * textH, yc - 0.42 * textH], [yc + 0.42 * textH, yc + 0.62 * textH]];
  const vals = [[], [], []];
  const { H, S, V } = hsvChannels(cv, lo);
  for (const [a, b] of strips) {
    const y0 = Math.max(0, Math.round(a)); const y1 = Math.min(lo.rows, Math.round(b));
    for (let y = y0; y < y1; y++) {
      for (let x = Math.max(0, Math.round(nameBox.x0)); x < Math.min(lo.cols, Math.round(nameBox.x1)); x += 2) {
        vals[0].push(H.ucharAt(y, x)); vals[1].push(S.ucharAt(y, x)); vals[2].push(V.ucharAt(y, x));
      }
    }
  }
  [H, S, V].forEach((m) => m.delete());
  const med = (v) => { if (!v.length) return 0; const s = [...v].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  return { h: med(vals[0]), s: med(vals[1]), v: med(vals[2]) };
}

// ------------------------------------------------------------ 7. icons
function nccCanvas(a, b) {
  const da = a.getContext('2d').getImageData(0, 0, ICON_SIZE, ICON_SIZE).data;
  const db = b.getContext('2d').getImageData(0, 0, ICON_SIZE, ICON_SIZE).data;
  let ma = 0; let mb = 0; let n = 0;
  for (let i = 0; i < da.length; i++) if (i % 4 !== 3) { ma += da[i]; mb += db[i]; n++; }
  ma /= n; mb /= n;
  let num = 0; let sa = 0; let sb = 0;
  for (let i = 0; i < da.length; i++) {
    if (i % 4 === 3) continue;
    const x = da[i] - ma; const y = db[i] - mb;
    num += x * y; sa += x * x; sb += y * y;
  }
  return sa && sb ? num / Math.sqrt(sa * sb) : 0;
}

/** templates: [{ character, canvas }] → { character, confidence } | null */
export function matchIcon(crop, templates) {
  if (!crop || !templates.length) return null;
  const best = new Map();
  for (const t of templates) {
    const s = nccCanvas(crop, t.canvas);
    if (!best.has(t.character) || s > best.get(t.character)) best.set(t.character, s);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const [character, score] = ranked[0];
  if (score < 0.55) return null;
  const margin = score - (ranked[1]?.[1] ?? 0);
  return { character, confidence: Math.round(100 * Math.min(1, 0.7 * score + 0.3 * Math.min(1, margin * 4))) / 100 };
}

// ------------------------------------------------------------ orchestration
/**
 * @param file      photo (any format the browser decodes; EXIF rotation honoured)
 * @param opts      { miiNames: [], templates: [], onProgress({ status, progress }) }
 * @returns {
 *   kind: 'final' | 'standings' | 'unknown', phase: 'race' | 'totals' | null,
 *   rows: [{ place, name, character, points, gained, human, confidence, nameBox, pointsBox, iconCanvas }],
 *   issues: [], canvas (straightened photo, for display/upload), engine
 * }
 */
export async function analyzePhoto(file, { miiNames = [], templates = [], onProgress } = {}) {
  const report = (status, progress) => onProgress?.({ status, progress });
  report('Loading the vision engine (first time ~20 s)', 0.02);
  const [cv, worker, bitmap] = await Promise.all([loadOpenCV(), getWorker(), fileToBitmap(file)]);
  const opts = { extraNames: miiNames };
  const mats = [];
  try {
    report('Finding the TV screen', 0.06);
    const { lo, hi, k } = prepare(cv, bitmap);
    mats.push(lo, hi);
    bitmap.close?.();

    // Pass 1
    const variants = pass1Variants(cv, lo);
    const ocr = { width: lo.cols, height: lo.rows, variants: {} };
    let n = 0;
    for (const [name, canvas] of Object.entries(variants)) {
      report('Reading the screen', 0.1 + 0.25 * (n++ / 3));
      ocr.variants[name] = await recognizeWords(worker, canvas, 11);
    }
    const plan = planScreen(ocr, opts);
    if (!plan.slots.length) {
      return { kind: plan.kind, phase: null, rows: [], issues: plan.issues, canvas: matToCanvas(cv, lo), engine: 'opencv+tesseract' };
    }

    // Pass 2
    const cellOcr = {};
    const bars = [];
    for (const [i, s] of plan.slots.entries()) {
      report(`Reading row ${i + 1} of ${plan.slots.length}`, 0.35 + 0.6 * (i / plan.slots.length));
      const cell = { name: [], points: [], human: null };
      const nc = cropMat(cv, hi, s.cells.name, k, 64);
      if (nc) {
        for (const v of nameVariants(cv, nc)) cell.name.push(await recognizeWords(worker, v, 7, LETTERS));
        nc.delete();
      }
      const pc = cropMat(cv, hi, s.cells.points, k, 80);
      if (pc) {
        for (const m of digitMasks(cv, pc)) {
          const iso = isolateDigits(m);
          if (!iso) continue;
          const ws = await recognizeWords(worker, grayToCanvas(iso), 7, '0123456789');
          const text = ws.map((w) => w.text).join('');
          if (text) cell.points.push({ text, confidence: Math.min(...ws.map((w) => w.confidence)) });
        }
        pc.delete();
      }
      cellOcr[s.place] = cell;
      bars.push({ place: s.place, ...barColour(cv, lo, s.cells.name, plan.textH) });
    }
    const humans = detectHumans(plan.kind, bars);
    for (const s of plan.slots) cellOcr[s.place].human = humans[s.place] ?? null;

    report('Checking the results', 0.97);
    const result = finishScreen(plan, cellOcr, opts);
    const canvas = matToCanvas(cv, lo);
    const rows = result.rows.map((r) => {
      const iconCanvas = r.iconBox ? drawScaled(canvas, r.iconBox.x0, r.iconBox.y0, r.iconBox.x1 - r.iconBox.x0, r.iconBox.y1 - r.iconBox.y0, ICON_SIZE, ICON_SIZE) : null;
      // A Mii name hides the character: fall back to the learned icon templates.
      if (!r.character) {
        const m = matchIcon(iconCanvas, templates);
        if (m) return { ...r, character: m.character, characterConfidence: m.confidence, characterSource: 'icon', iconCanvas };
      }
      return { ...r, iconCanvas };
    });
    report('Done', 1);
    return { kind: result.kind, phase: result.phase, rows, issues: result.issues, canvas, engine: 'opencv+tesseract' };
  } finally {
    mats.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
  }
}
