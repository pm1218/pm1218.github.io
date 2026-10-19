// Suggest which group member drove which kart in an analysed photo.
//
// Signals per (row, member) pair:
//   name   – OCR'd name vs. member's Mii name / display name (fuzzy)
//   char   – detected character vs. member's favourite character,
//            weighted by detection confidence and divided by how many
//            members share that favourite (a shared favourite is weak evidence)
// A row whose name reads as a character name and matches no member is a CPU.
// Assignment is greedy on the best remaining score, so each member is used once.

import { similarity } from './text.js';

const NAME_WEIGHT = 0.6;
const CHAR_WEIGHT = 0.4;
const NAME_MIN = 0.6;
const ASSIGN_MIN = 0.3;

export function scorePair(row, profile, favouriteCounts) {
  const reasons = [];
  const nameSim = Math.max(
    similarity(row.name, profile.mii_name || ''),
    similarity(row.name, profile.display_name || ''),
  );
  let score = 0;
  if (nameSim >= NAME_MIN) {
    score += NAME_WEIGHT * nameSim;
    reasons.push(`name "${row.name}" ≈ ${profile.mii_name || profile.display_name} (${Math.round(nameSim * 100)}%)`);
  }
  const fav = profile.favorite_character;
  if (fav && row.character && fav === row.character) {
    const share = favouriteCounts.get(fav) || 1;
    const conf = row.characterConfidence ?? 0.5;
    score += (CHAR_WEIGHT * conf) / share;
    reasons.push(
      `drives ${fav}, their favourite${share > 1 ? ` (shared by ${share} members)` : ''}`,
    );
  }
  return { score: Math.min(1, score), reasons };
}

/**
 * @param rows     [{ name, character, characterConfidence, cpuCharacter }]
 * @param profiles [{ id, display_name, mii_name, favorite_character }]
 * @returns        same length as rows: { profile_id, confidence, reasons, is_cpu }
 */
export function suggestIdentities(rows, profiles) {
  const favouriteCounts = new Map();
  for (const p of profiles) {
    if (p.favorite_character) favouriteCounts.set(p.favorite_character, (favouriteCounts.get(p.favorite_character) || 0) + 1);
  }

  const pairs = [];
  rows.forEach((row, ri) => {
    profiles.forEach((p) => {
      const { score, reasons } = scorePair(row, p, favouriteCounts);
      if (score >= ASSIGN_MIN) pairs.push({ ri, profile: p, score, reasons });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const result = rows.map((row) => ({
    profile_id: null,
    confidence: 0,
    reasons: [],
    is_cpu: false,
  }));
  const usedProfiles = new Set();
  for (const pair of pairs) {
    if (result[pair.ri].profile_id || usedProfiles.has(pair.profile.id)) continue;
    result[pair.ri] = { profile_id: pair.profile.id, confidence: Math.round(pair.score * 100) / 100, reasons: pair.reasons, is_cpu: false };
    usedProfiles.add(pair.profile.id);
  }

  rows.forEach((row, i) => {
    if (!result[i].profile_id && row.cpuCharacter) {
      result[i] = { profile_id: null, confidence: 0.8, reasons: [`name reads as the character "${row.cpuCharacter}" → CPU`], is_cpu: true };
    }
  });
  return result;
}
