// Suggest which group member drove which kart in an analysed photo.
//
// Mario Kart Wii result rows show the character's name, and human players'
// rows get a coloured bar. Each member sets the character they race as on
// their profile, so:
//   - a player-bar row whose character is used by exactly one member → that member
//   - a character shared by several members → the uploader chooses (we say who)
//   - a player-bar row nobody uses → "choose who it was" (e.g. a guest)
//   - no player bar → CPU (not tracked)
// Assignment is one row per member; the uploader can override every row.

const ASSIGN_MIN = 0.4;
const CHAR_WEIGHT = 0.45;
const HUMAN_BONUS = 0.15;

export function scorePair(row, profile, charCounts) {
  const reasons = [];
  let score = 0;
  const ch = profile.favorite_character;
  if (ch && row.character && ch === row.character) {
    const share = charCounts.get(ch) || 1;
    score += (CHAR_WEIGHT * (row.characterConfidence ?? 0.8)) / share;
    reasons.push(`races as ${ch}${share > 1 ? ` (shared by ${share} members)` : ''}`);
  }
  if (score > 0 && row.human) {
    score += HUMAN_BONUS;
    reasons.push('player bar');
  }
  return { score: Math.min(1, score), reasons };
}

/**
 * @param rows     [{ name, character, characterConfidence, human }]
 * @param profiles [{ id, display_name, favorite_character }]
 * @returns        per row: { profile_id, confidence, reasons, is_cpu }
 */
export function suggestIdentities(rows, profiles) {
  const charCounts = new Map();
  const usersOf = new Map();
  for (const p of profiles) {
    if (!p.favorite_character) continue;
    charCounts.set(p.favorite_character, (charCounts.get(p.favorite_character) || 0) + 1);
    usersOf.set(p.favorite_character, [...(usersOf.get(p.favorite_character) || []), p.display_name]);
  }
  const pairs = [];
  rows.forEach((row, ri) => {
    if (row.human === false) return; // no player bar → CPU
    profiles.forEach((p) => {
      const { score, reasons } = scorePair(row, p, charCounts);
      if (score >= ASSIGN_MIN) pairs.push({ ri, profile: p, score, reasons });
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
    if (row.human === false) {
      result[i] = { profile_id: null, confidence: 0.8, reasons: ['no player bar → CPU'], is_cpu: true };
      return;
    }
    const sharers = row.character ? usersOf.get(row.character) || [] : [];
    const reason = sharers.length > 1
      ? `${row.character} is used by ${sharers.join(' and ')} — choose who it was`
      : row.human ? 'player bar, but no member races as this character — choose who it was' : 'no member races as this character → CPU';
    result[i] = { profile_id: null, confidence: 0.5, reasons: [reason], is_cpu: !row.human && sharers.length === 0 };
  });
  return result;
}
