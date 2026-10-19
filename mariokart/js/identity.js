// Suggest which group member drove which kart in an analysed photo.
//
// On Mario Kart Wii a result row shows the character's name (or the player's
// Mii name), the character icon, and — for human players — a coloured bar.
// Signals per (row, member):
//   mii    – row text ≈ the member's Mii name (strong: it is their own label)
//   fav    – row character == member's favourite character, weighted by how
//            sure we are of the character and divided by how many members
//            share that favourite (a shared favourite is weak evidence)
//   human  – the row has a player's coloured bar (CPUs never do)
// Assignment is greedy on the best remaining score, one row per member.
// Rows nobody claims become CPUs unless they look human (then: guest).

import { similarity } from './text.js';

const MII_WEIGHT = 0.6;
const FAV_WEIGHT = 0.45;
const HUMAN_BONUS = 0.15;
const ASSIGN_MIN = 0.3;

export function scorePair(row, profile, favouriteCounts) {
  const reasons = [];
  let score = 0;
  const mii = Math.max(similarity(row.name, profile.mii_name || ''), similarity(row.name, profile.display_name || ''));
  if (row.name && mii >= 0.75) {
    score += MII_WEIGHT * mii;
    reasons.push(`name "${row.name}" ≈ ${profile.mii_name || profile.display_name}`);
  }
  const fav = profile.favorite_character;
  if (fav && row.character && fav === row.character) {
    const share = favouriteCounts.get(fav) || 1;
    score += (FAV_WEIGHT * (row.characterConfidence ?? 0.8)) / share;
    reasons.push(`drives ${fav}, their favourite${share > 1 ? ` (shared by ${share} members)` : ''}`);
  }
  if (score > 0 && row.human) {
    score += HUMAN_BONUS;
    reasons.push('player bar');
  }
  return { score: Math.min(1, score), reasons };
}

/**
 * @param rows     [{ name, character, characterConfidence, human }]
 * @param profiles [{ id, display_name, mii_name, favorite_character }]
 * @returns        per row: { profile_id, confidence, reasons, is_cpu }
 */
export function suggestIdentities(rows, profiles) {
  const favouriteCounts = new Map();
  for (const p of profiles) {
    if (p.favorite_character) favouriteCounts.set(p.favorite_character, (favouriteCounts.get(p.favorite_character) || 0) + 1);
  }
  const pairs = [];
  rows.forEach((row, ri) => {
    // A row without a player bar is a CPU unless its text is someone's Mii name.
    profiles.forEach((p) => {
      const { score, reasons } = scorePair(row, p, favouriteCounts);
      const miiMatch = reasons.some((r) => r.startsWith('name'));
      if (score >= ASSIGN_MIN && (row.human !== false || miiMatch)) pairs.push({ ri, profile: p, score, reasons });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const result = rows.map(() => ({ profile_id: null, confidence: 0, reasons: [], is_cpu: false }));
  const used = new Set();
  for (const pair of pairs) {
    if (result[pair.ri].profile_id || used.has(pair.profile.id)) continue;
    result[pair.ri] = { profile_id: pair.profile.id, confidence: Math.round(pair.score * 100) / 100, reasons: pair.reasons, is_cpu: false };
    used.add(pair.profile.id);
  }
  rows.forEach((row, i) => {
    if (result[i].profile_id) return;
    if (row.human) result[i] = { profile_id: null, confidence: 0.5, reasons: ['player bar, but no member matched — choose who it was'], is_cpu: false };
    else result[i] = { profile_id: null, confidence: row.human === false ? 0.8 : 0.5, reasons: [row.human === false ? 'no player bar → CPU' : 'no member matched → CPU'], is_cpu: true };
  });
  return result;
}
