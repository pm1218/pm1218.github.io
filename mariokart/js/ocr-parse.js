// Turns OCR word boxes into Mario Kart Wii result rows.
//
// Pure functions (no DOM), so they run in the browser and in Node tests.
// Input words use the Tesseract.js shape: { text, confidence, bbox: {x0,y0,x1,y1} }.
//
// Every Mario Kart Wii result screen is a vertical list of up to 12 rows:
//   [place]  [character icon]  [name]  ......  [+gained]  [points]
// so we group words into text lines by vertical position, then read each
// line left-to-right against that template.

import { CHARACTERS, MAX_PLAYERS, POINTS, MAX_GP_TOTAL } from './data.js';
import { bestMatch } from './text.js';

// Characters OCR commonly confuses with digits on the game's rounded font.
const DIGIT_FIX = { l: '1', I: '1', i: '1', '|': '1', '!': '1', O: '0', o: '0', D: '0', Q: '0', S: '5', s: '5', Z: '2', z: '2', B: '8', g: '9', q: '9' };

export function fixDigits(token) {
  return [...token].map((ch) => (/\d/.test(ch) ? ch : DIGIT_FIX[ch] ?? ch)).join('');
}

const PLACE_RE = /^(1[0-2]|[1-9])(st|nd|rd|th)?[.:]?$/i;
const POINTS_RE = /^\+?\d{1,2}$/;

export function parsePlace(token) {
  const raw = token.trim();
  let m = raw.match(PLACE_RE);
  if (!m) {
    const core = raw.replace(/[.:]$/, '').replace(/(st|nd|rd|th)$/i, '');
    if (core.length >= 1 && core.length <= 2) m = fixDigits(core).match(PLACE_RE);
  }
  return m ? Number(m[1]) : null;
}

export function parsePoints(token) {
  const cleaned = token.replace(/[^\w+|!]/g, '');
  // Only "repair" tokens that already look numeric, so name fragments
  // such as "B" or "S" are never mistaken for points.
  if (!/\d/.test(cleaned) && !cleaned.startsWith('+')) return null;
  const t = fixDigits(cleaned);
  if (!POINTS_RE.test(t)) return null;
  return { value: Number(t.replace('+', '')), gained: t.startsWith('+') };
}

// Group word boxes into horizontal lines.
export function groupLines(words, { minConfidence = 20 } = {}) {
  const usable = words
    .filter((w) => w && w.text && w.text.trim() && (w.confidence ?? 100) >= minConfidence)
    .map((w) => ({
      text: w.text.trim(),
      confidence: w.confidence ?? 100,
      bbox: w.bbox,
      yc: (w.bbox.y0 + w.bbox.y1) / 2,
      h: w.bbox.y1 - w.bbox.y0,
    }))
    .sort((a, b) => a.yc - b.yc);
  if (!usable.length) return [];

  const heights = usable.map((w) => w.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;
  const lines = [];
  for (const w of usable) {
    const line = lines.find((l) => Math.abs(l.yc - w.yc) < medianH * 0.6);
    if (line) {
      line.words.push(w);
      line.yc = line.words.reduce((s, x) => s + x.yc, 0) / line.words.length;
    } else {
      lines.push({ yc: w.yc, words: [w] });
    }
  }
  for (const l of lines) l.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return lines.sort((a, b) => a.yc - b.yc);
}

// Read one text line as a result row; returns null if it isn't one.
export function parseLine(line) {
  const words = [...line.words];
  if (words.length < 2) return null;

  let place = null;
  let placeWord = null;
  const first = parsePlace(words[0].text);
  if (first !== null) {
    place = first;
    placeWord = words.shift();
  }

  // Trailing numbers: optional "+gained" then the running/final total.
  const trailing = [];
  while (words.length && trailing.length < 2) {
    const p = parsePoints(words[words.length - 1].text);
    if (!p) break;
    trailing.unshift({ ...p, word: words.pop() });
  }
  let points = null;
  let gained = null;
  if (trailing.length === 2) {
    gained = trailing[0].value;
    points = trailing[1].value;
  } else if (trailing.length === 1) {
    if (trailing[0].gained) gained = trailing[0].value;
    else points = trailing[0].value;
  }

  const nameWords = words.filter((w) => /[A-Za-z]/.test(w.text));
  // The character icon often OCRs as a stray "O"/"Q@" before the name.
  // Its box is then the best estimate of where the icon is.
  const iconWords = [];
  while (nameWords.length > 1 && nameWords[0].text.replace(/[^A-Za-z0-9]/g, '').length <= 2) iconWords.push(nameWords.shift());
  for (const w of words) {
    if (!nameWords.includes(w) && !iconWords.includes(w) && nameWords.length && w.bbox.x1 <= nameWords[0].bbox.x0) iconWords.push(w);
  }
  const name = nameWords.map((w) => w.text).join(' ').replace(/[^\p{L}\p{N} .'-]/gu, '').trim();
  if (!name && points === null) return null;
  if (place === null && points === null && gained === null) return null;

  const all = line.words;
  const rowBox = {
    x0: Math.min(...all.map((w) => w.bbox.x0)),
    y0: Math.min(...all.map((w) => w.bbox.y0)),
    x1: Math.max(...all.map((w) => w.bbox.x1)),
    y1: Math.max(...all.map((w) => w.bbox.y1)),
  };
  const nameBox = nameWords.length
    ? {
        x0: Math.min(...nameWords.map((w) => w.bbox.x0)),
        y0: Math.min(...nameWords.map((w) => w.bbox.y0)),
        x1: Math.max(...nameWords.map((w) => w.bbox.x1)),
        y1: Math.max(...nameWords.map((w) => w.bbox.y1)),
      }
    : null;

  // The character icon sits between the place number and the name.
  let iconBox = null;
  if (nameBox) {
    const textH = nameBox.y1 - nameBox.y0;
    const yc = (nameBox.y0 + nameBox.y1) / 2;
    const glyph = iconWords.find((w) => w.bbox.y1 - w.bbox.y0 >= 1.2 * textH);
    if (glyph) {
      const gx = (glyph.bbox.x0 + glyph.bbox.x1) / 2;
      const gy = (glyph.bbox.y0 + glyph.bbox.y1) / 2;
      const half = Math.max(glyph.bbox.x1 - glyph.bbox.x0, glyph.bbox.y1 - glyph.bbox.y0) / 2;
      iconBox = { x0: Math.round(gx - half), y0: Math.round(gy - half), x1: Math.round(gx + half), y1: Math.round(gy + half) };
    } else {
      const size = Math.round(textH * 1.8);
      const right = Math.round(nameBox.x0 - textH * 0.3);
      const left = placeWord ? Math.max(placeWord.bbox.x1 + 2, right - size) : right - size;
      if (right - left > 4) iconBox = { x0: left, y0: Math.round(yc - size / 2), x1: right, y1: Math.round(yc + size / 2) };
    }
    if (iconBox) { iconBox.x0 = Math.max(0, iconBox.x0); iconBox.y0 = Math.max(0, iconBox.y0); }
  }

  const conf = line.words.reduce((s, w) => s + w.confidence, 0) / line.words.length;
  const cpuCharacter = name ? bestMatch(name, CHARACTERS, 0.75) : null;
  return {
    place,
    name,
    points,
    gained,
    cpuCharacter: cpuCharacter?.value ?? null,
    nameBox,
    iconBox,
    rowBox,
    confidence: Math.round(conf),
  };
}

// Full screen: words → ordered, de-duplicated rows plus diagnostics.
export function parseScreen(words, opts = {}) {
  return parseLines(groupLines(words), opts);
}

// Rows already isolated by the layout detector (one OCR pass per row).
export function parseRows(rowWordLists, opts = {}) {
  const lines = rowWordLists
    .map((words) => ({
      words: words
        .filter((w) => w && w.text && w.text.trim() && (w.confidence ?? 100) >= 10)
        .map((w) => ({ ...w, text: w.text.trim(), confidence: w.confidence ?? 100 }))
        .sort((a, b) => a.bbox.x0 - b.bbox.x0),
    }))
    .filter((l) => l.words.length);
  return parseLines(lines, opts);
}

export function parseLines(lines, { expectedKind = 'auto' } = {}) {
  const rows = lines.map(parseLine).filter(Boolean);

  // Fill missing place numbers from vertical order when neighbours agree.
  rows.forEach((r, i) => {
    if (r.place === null) {
      const prev = rows[i - 1]?.place;
      const next = rows[i + 1]?.place;
      if (prev && (!next || next === prev + 2)) r.place = prev + 1;
      else if (next && next > 1) r.place = next - 1;
    }
  });

  // Gained points pin the race placement exactly (15→1st … 0→12th).
  for (const r of rows) {
    if (r.gained !== null && r.place === null) {
      const idx = POINTS.indexOf(r.gained);
      if (idx >= 0) r.place = idx + 1;
    }
  }

  const byPlace = new Map();
  for (const r of rows) {
    if (r.place === null || r.place < 1 || r.place > MAX_PLAYERS) continue;
    const existing = byPlace.get(r.place);
    if (!existing || r.confidence > existing.confidence) byPlace.set(r.place, r);
  }
  const ordered = [...byPlace.values()].sort((a, b) => a.place - b.place);

  // Post-race screens show "+gained" on (nearly) every row; a stray digit on
  // one row of a final screen must not flip the classification.
  const gainedShare = ordered.length ? ordered.filter((r) => r.gained !== null).length / ordered.length : 0;
  const kind = expectedKind !== 'auto' ? expectedKind : gainedShare >= 0.5 ? 'race' : 'final';
  if (kind === 'final') for (const r of ordered) r.gained = null;

  const issues = [];
  ordered.forEach((r, i) => {
    if (r.place !== i + 1) issues.push(`Row for place ${i + 1} was not found.`);
    if (!r.name) issues.push(`No name read for place ${r.place}.`);
  });
  if (kind === 'final') {
    ordered.forEach((r, i) => {
      if (r.points === null) issues.push(`No total read for place ${r.place}.`);
      else if (r.points > MAX_GP_TOTAL) issues.push(`Total ${r.points} for place ${r.place} is above ${MAX_GP_TOTAL}.`);
      const prev = ordered[i - 1];
      if (prev && prev.points !== null && r.points !== null && r.points > prev.points) {
        issues.push(`Totals are not in descending order at place ${r.place}.`);
      }
    });
  } else {
    ordered.forEach((r) => {
      if (r.gained !== null && POINTS[r.place - 1] !== r.gained) {
        issues.push(`Place ${r.place} shows +${r.gained}, expected +${POINTS[r.place - 1]}.`);
      }
    });
  }

  return { kind, rows: ordered, issues: [...new Set(issues)] };
}
