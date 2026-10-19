// Browser image-analysis engine: OpenCV.js computer vision + Tesseract.js OCR.
// Everything runs on the uploader's phone — no server to pay for.
//
// Pipeline (leans on the fixed Mario Kart Wii results layout):
//   1. rectify     find the TV screen quadrilateral and undo the camera's
//                  perspective (photos of a TV are never square-on)
//   2. findRows    the results list is a stack of wide text rows; find them
//                  with Sobel-x edges → Otsu → horizontal closing → contours,
//                  merging fragments that share a row (name block + points block)
//   3. OCR rows    each row is read on its own as a single text line (PSM 7),
//                  trying three binarisations (white-text mask, Otsu, inverted
//                  gray) and keeping the most confident — the game draws white
//                  text with a dark outline on coloured bars
//   4. parse       ocr-parse.js maps tokens to place / name / +gained / points
//   5. icons       crop the icon left of each name and match it against the
//                  group's own template library (TM_CCOEFF_NORMED + HSV histogram)
//
// If OpenCV.js can't load (slow connection), steps 1-3 fall back to one
// sparse-text OCR pass over a contrast-stretched image, and icon matching
// falls back to plain-JS normalised cross-correlation.

import { parseRows, parseScreen } from './ocr-parse.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';
const WORK_WIDTH = 1400;
export const ICON_SIZE = 48;

function loadScript(src, timeoutMs) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing?.dataset.loaded) return resolve();
    const s = existing || document.createElement('script');
    const timer = setTimeout(() => reject(new Error(`timed out loading ${src}`)), timeoutMs);
    s.addEventListener('load', () => { clearTimeout(timer); s.dataset.loaded = '1'; resolve(); });
    s.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`failed to load ${src}`)); });
    if (!existing) { s.src = src; s.async = true; document.head.appendChild(s); }
  });
}

let cvPromise = null;
export function loadOpenCV() {
  if (!cvPromise) {
    cvPromise = loadScript(OPENCV_URL, 60000)
      .then(() => new Promise((resolve) => {
        const cv = window.cv;
        if (!cv) return resolve(null);
        if (cv.Mat) return resolve(cv);
        if (typeof cv.then === 'function') return cv.then((m) => { window.cv = m; resolve(m); });
        cv.onRuntimeInitialized = () => resolve(window.cv);
      }))
      .catch(() => null);
  }
  return cvPromise;
}

let workerPromise = null;
let progressSink = null;
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT_URL, 45000);
      return window.Tesseract.createWorker('eng', 1, { logger: (m) => progressSink?.(m) });
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// File/Blob → canvas at working resolution, honouring EXIF rotation.
export async function fileToCanvas(file, width = WORK_WIDTH) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = width / bmp.width;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}

// Downscale for upload (keeps storage use tiny on the free tier).
export function compressForUpload(canvas, maxWidth = 1280) {
  const scale = Math.min(1, maxWidth / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
}

const matToCanvas = (cv, mat) => {
  const c = document.createElement('canvas');
  cv.imshow(c, mat);
  return c;
};

// ---------------------------------------------------------------------
// 1. Screen rectification
// ---------------------------------------------------------------------
function orderQuad(pts) {
  const sum = pts.map((p) => p[0] + p[1]);
  const diff = pts.map((p) => p[1] - p[0]);
  const at = (arr, fn) => pts[arr.indexOf(fn(...arr))];
  return [at(sum, Math.min), at(diff, Math.min), at(sum, Math.max), at(diff, Math.max)];
}

function findScreenQuad(cv, rgba) {
  const w = rgba.cols;
  const h = rgba.rows;
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 40, 120);
  const k3 = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.dilate(edges, edges, k3);
  const th = new cv.Mat();
  cv.threshold(gray, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const k15 = cv.Mat.ones(15, 15, cv.CV_8U);
  cv.morphologyEx(th, th, cv.MORPH_CLOSE, k15);

  let best = null;
  for (const mask of [th, edges]) {
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const list = [];
    for (let i = 0; i < contours.size(); i++) list.push(contours.get(i));
    list.sort((a, b) => cv.contourArea(b) - cv.contourArea(a));
    for (const c of list.slice(0, 5)) {
      const hull = new cv.Mat();
      cv.convexHull(c, hull);
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, 0.02 * cv.arcLength(hull, true), true);
      const area = cv.contourArea(approx);
      if (approx.rows === 4 && area > 0.3 * w * h && area < 0.98 * w * h && (!best || area > best.area)) {
        const pts = [];
        for (let i = 0; i < 4; i++) pts.push([approx.data32S[i * 2], approx.data32S[i * 2 + 1]]);
        best = { area, pts };
      }
      hull.delete(); approx.delete();
    }
    list.forEach((c) => c.delete());
    contours.delete(); hier.delete();
  }
  [gray, edges, th, k3, k15].forEach((m) => m.delete());
  if (!best) return null;

  // Pad 3% outward so rows on the screen edge are never clipped.
  const q = orderQuad(best.pts);
  const cx = q.reduce((s, p) => s + p[0], 0) / 4;
  const cy = q.reduce((s, p) => s + p[1], 0) / 4;
  return q.map(([x, y]) => [
    Math.min(w - 1, Math.max(0, cx + (x - cx) * 1.03)),
    Math.min(h - 1, Math.max(0, cy + (y - cy) * 1.03)),
  ]);
}

function rectify(cv, rgba) {
  const q = findScreenQuad(cv, rgba);
  if (!q) return null;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wt = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const ht = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const W = WORK_WIDTH;
  const H = Math.round((W * ht) / wt);
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, q.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = cv.getPerspectiveTransform(src, dst);
  const out = new cv.Mat();
  cv.warpPerspective(rgba, out, M, new cv.Size(W, H));
  [src, dst, M].forEach((m) => m.delete());
  return out;
}

// ---------------------------------------------------------------------
// 2. Row detection
// ---------------------------------------------------------------------
function findRows(cv, gray) {
  const w = gray.cols;
  const h = gray.rows;
  const gx = new cv.Mat();
  cv.Sobel(gray, gx, cv.CV_16S, 1, 0, 3);
  cv.convertScaleAbs(gx, gx);
  const bw = new cv.Mat();
  cv.threshold(gx, bw, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const k1 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(15, Math.floor(w / 40)), 3));
  const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(25, Math.floor(w / 15)), 1));
  const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 3));
  cv.morphologyEx(bw, bw, cv.MORPH_CLOSE, k1);
  cv.dilate(bw, bw, k2);
  cv.erode(bw, bw, k3);
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(bw, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const boxes = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const r = cv.boundingRect(c);
    if (r.height > 0.02 * h && r.height < 0.12 * h && r.width > 0.05 * w) boxes.push([r.x, r.y, r.width, r.height]);
    c.delete();
  }
  [gx, bw, k1, k2, k3, hier].forEach((m) => m.delete());
  contours.delete();
  return groupRowBoxes(boxes, w);
}

// Merge fragments that share a row; keep wide rows of typical height.
export function groupRowBoxes(boxes, imageWidth) {
  const sorted = [...boxes].sort((a, b) => a[1] + a[3] / 2 - (b[1] + b[3] / 2));
  const groups = [];
  for (const b of sorted) {
    const g = groups.find((g) => Math.min(g[1] + g[3], b[1] + b[3]) - Math.max(g[1], b[1]) >= 0.5 * Math.min(g[3], b[3]));
    if (g) {
      const x0 = Math.min(g[0], b[0]); const y0 = Math.min(g[1], b[1]);
      const x1 = Math.max(g[0] + g[2], b[0] + b[2]); const y1 = Math.max(g[1] + g[3], b[1] + b[3]);
      g.splice(0, 4, x0, y0, x1 - x0, y1 - y0);
    } else groups.push([...b]);
  }
  const wide = groups.filter((g) => g[2] > 0.35 * imageWidth);
  if (!wide.length) return [];
  const heights = wide.map((g) => g[3]).sort((a, b) => a - b);
  const med = heights[Math.floor(heights.length / 2)];
  return wide.filter((g) => g[3] > 0.5 * med && g[3] < 1.8 * med).sort((a, b) => a[1] - b[1]).slice(0, 12);
}

// ---------------------------------------------------------------------
// 3. Per-row OCR
// ---------------------------------------------------------------------
function rowVariants(cv, rgba, box) {
  const [x, y, w, h] = box;
  const pad = Math.round(h * 0.1);
  const x0 = Math.max(0, x - pad); const y0 = Math.max(0, y - pad);
  const x1 = Math.min(rgba.cols, x + w + pad); const y1 = Math.min(rgba.rows, y + h + pad);
  const roi = rgba.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
  const f = 64 / (y1 - y0);
  const big = new cv.Mat();
  cv.resize(roi, big, new cv.Size(Math.round((x1 - x0) * f), 64), 0, 0, cv.INTER_CUBIC);
  roi.delete();

  const rgb = new cv.Mat(); const hsv = new cv.Mat(); const gray = new cv.Mat();
  cv.cvtColor(big, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  cv.cvtColor(big, gray, cv.COLOR_RGBA2GRAY);

  // White glyph fill: low saturation, high value.
  const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 170, 0]);
  const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 70, 255, 255]);
  const white = new cv.Mat();
  cv.inRange(hsv, lo, hi, white);
  const k2 = cv.Mat.ones(2, 2, cv.CV_8U);
  cv.morphologyEx(white, white, cv.MORPH_OPEN, k2);
  cv.bitwise_not(white, white);

  const otsu = new cv.Mat();
  cv.threshold(gray, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.bitwise_not(otsu, otsu);
  const inv = new cv.Mat();
  cv.bitwise_not(gray, inv);

  const canvases = [white, otsu, inv].map((m) => matToCanvas(cv, m));
  [big, rgb, hsv, gray, lo, hi, white, k2, otsu, inv].forEach((m) => m.delete());
  return { canvases, x0, y0, f };
}

async function ocrRows(cv, rgba, rows, worker, onRow) {
  await worker.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' });
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const { canvases, x0, y0, f } = rowVariants(cv, rgba, rows[i]);
    let best = null;
    for (const c of canvases) {
      const { data } = await worker.recognize(c);
      const words = data.words || [];
      const score = words.filter((w) => w.confidence > 30).reduce((s, w) => s + w.confidence, 0);
      if (!best || score > best.score) best = { score, words };
    }
    out.push(best.words.map((w) => ({
      text: w.text,
      confidence: w.confidence,
      bbox: {
        x0: Math.round(x0 + w.bbox.x0 / f), x1: Math.round(x0 + w.bbox.x1 / f),
        y0: Math.round(y0 + w.bbox.y0 / f), y1: Math.round(y0 + w.bbox.y1 / f),
      },
    })));
    onRow?.(i + 1, rows.length);
  }
  return out;
}

// Fallback preprocessing without OpenCV: grayscale + contrast stretch + invert.
function canvasFallback(srcCanvas) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const data = srcCanvas.getContext('2d').getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  let lo = 255; let hi = 0;
  for (let i = 0; i < g.length; i++) {
    const v = 0.299 * data.data[i * 4] + 0.587 * data.data[i * 4 + 1] + 0.114 * data.data[i * 4 + 2];
    g[i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  const span = Math.max(1, hi - lo);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const out = c.getContext('2d').createImageData(w, h);
  for (let i = 0; i < g.length; i++) {
    const v = 255 - ((g[i] - lo) * 255) / span;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

// ---------------------------------------------------------------------
// 5. Icon matching
// ---------------------------------------------------------------------
export function cropIcon(colorCanvas, box) {
  // Inset 10% so the bar colour behind the icon doesn't dominate the match.
  const w = Math.max(1, box.x1 - box.x0);
  const h = Math.max(1, box.y1 - box.y0);
  const c = document.createElement('canvas');
  c.width = ICON_SIZE; c.height = ICON_SIZE;
  c.getContext('2d').drawImage(colorCanvas, box.x0 + w * 0.1, box.y0 + h * 0.1, w * 0.8, h * 0.8, 0, 0, ICON_SIZE, ICON_SIZE);
  return c;
}

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

function iconSimilarity(crop, tpl, cv) {
  if (!cv) return nccCanvas(crop, tpl);
  const a = cv.imread(crop);
  const b = cv.imread(tpl);
  const res = new cv.Mat();
  cv.matchTemplate(a, b, res, cv.TM_CCOEFF_NORMED);
  const ncc = res.data32F[0];
  const hist = (m) => {
    const rgb = new cv.Mat(); const hsv = new cv.Mat();
    cv.cvtColor(m, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const vec = new cv.MatVector(); vec.push_back(hsv);
    const hh = new cv.Mat(); const none = new cv.Mat();
    cv.calcHist(vec, [0, 1], none, hh, [18, 8], [0, 180, 0, 256]);
    cv.normalize(hh, hh, 0, 1, cv.NORM_MINMAX);
    rgb.delete(); hsv.delete(); vec.delete(); none.delete();
    return hh;
  };
  const ha = hist(a); const hb = hist(b);
  const hc = cv.compareHist(ha, hb, cv.HISTCMP_CORREL);
  [a, b, res, ha, hb].forEach((m) => m.delete());
  return 0.6 * ncc + 0.4 * hc;
}

/**
 * templates: [{ character, canvas }]. Returns { character, confidence, score } or null.
 * Confidence blends the best score with its margin over the best *other* character.
 */
export function matchIcon(crop, templates, cv) {
  if (!templates.length) return null;
  const bestPer = new Map();
  for (const t of templates) {
    const s = iconSimilarity(crop, t.canvas, cv);
    if (!bestPer.has(t.character) || s > bestPer.get(t.character)) bestPer.set(t.character, s);
  }
  const ranked = [...bestPer.entries()].sort((a, b) => b[1] - a[1]);
  const [character, score] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  if (score < 0.55) return null;
  const confidence = Math.max(0, Math.min(1, 0.7 * score + 0.3 * Math.min(1, (score - second) * 4)));
  return { character, confidence: Math.round(confidence * 100) / 100, score: Math.round(score * 100) / 100 };
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------
/**
 * @returns { kind, rows: [{ ...parsedRow, character, characterConfidence, characterSource, iconCanvas }],
 *            issues, engine, colorCanvas }
 */
export async function analyzePhoto(file, { expectedKind = 'auto', templates = [], onProgress } = {}) {
  const report = (status, progress) => onProgress?.({ status, progress });
  report('Loading image', 0.02);
  const original = await fileToCanvas(file);
  report('Loading vision engine (first time can take ~20s)', 0.05);
  progressSink = (m) => {
    if (m.status && m.status !== 'recognizing text') report(m.status, 0.1);
  };
  const [cv, worker] = await Promise.all([loadOpenCV(), getWorker()]);

  let colorCanvas = original;
  let parsed = null;
  let engine = 'tesseract (sparse)';

  if (cv) {
    report('Finding the score list', 0.15);
    const src = cv.imread(original);
    const clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
    const candidates = [];
    const warped = rectify(cv, src);
    if (warped) candidates.push(warped);
    candidates.push(src);
    let best = null;
    for (const mat of candidates) {
      const gray = new cv.Mat();
      cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
      clahe.apply(gray, gray);
      const rows = findRows(cv, gray);
      gray.delete();
      if (!best || rows.length > best.rows.length) best = { mat, rows };
    }
    clahe.delete();
    if (best.rows.length >= 2) {
      engine = best.mat === warped ? 'opencv (rectified) + tesseract rows' : 'opencv + tesseract rows';
      const words = await ocrRows(cv, best.mat, best.rows, worker, (i, n) => report(`Reading row ${i} of ${n}`, 0.2 + 0.7 * (i / n)));
      parsed = parseRows(words, { expectedKind });
      colorCanvas = matToCanvas(cv, best.mat);
    }
    candidates.forEach((m) => m.delete());
  }

  if (!parsed || parsed.rows.length < 2) {
    report('Reading text', 0.5);
    await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(canvasFallback(original));
    const sparse = parseScreen(data.words || [], { expectedKind });
    if (!parsed || sparse.rows.length > parsed.rows.length) {
      parsed = sparse;
      colorCanvas = original;
      engine = 'tesseract (sparse)';
    }
  }

  report('Matching characters', 0.95);
  const rows = parsed.rows.map((row) => {
    const iconCanvas = row.iconBox ? cropIcon(colorCanvas, row.iconBox) : null;
    const m = iconCanvas ? matchIcon(iconCanvas, templates, cv) : null;
    return {
      ...row,
      iconCanvas,
      character: m?.character ?? row.cpuCharacter ?? null,
      characterConfidence: m?.confidence ?? (row.cpuCharacter ? 0.7 : 0),
      characterSource: m ? 'icon' : row.cpuCharacter ? 'name' : null,
    };
  });
  report('Done', 1);
  return { kind: parsed.kind, rows, issues: parsed.issues, engine, colorCanvas };
}

export const canvasToBlob = (canvas, type = 'image/png') => new Promise((r) => canvas.toBlob(r, type));

export async function blobToIconCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = ICON_SIZE; c.height = ICON_SIZE;
  c.getContext('2d').drawImage(bmp, 0, 0, ICON_SIZE, ICON_SIZE);
  bmp.close?.();
  return c;
}
