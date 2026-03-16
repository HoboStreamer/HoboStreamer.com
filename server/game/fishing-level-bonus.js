'use strict';
// fishing-level-bonus.js
// Computes per-catch weight multipliers driven by fishing level and total level.
// Used by buildFishTable() in items.js to boost rare fish and reduce junk
// as the player's character progresses -- without touching rod-tier gating logic.

// How much each rodTier fish benefits from fishing level at max (level 99).
// Tier 0 (Common) is unchanged -- boosting common fish would dilute the effect.
// Higher tiers scale up so rarer fish become meaningfully more accessible over time.
const TIER_LEVEL_BONUS = {
    0: 0.00,  // Common    (minnow, bass, perch...)      -- no change
    1: 0.40,  // Uncommon  (catfish, salmon, puffer...)  -- up to +40% at level 99
    2: 0.80,  // Rare      (eel, swordfish, deep sea...) -- up to +80% at level 99
    3: 1.20,  // Epic      (shark, whale...)             -- up to +120% at level 99
    4: 2.00,  // Legendary (kraken, golden, leviathan)  -- up to +200% at level 99
};

/**
 * Returns a weight multiplier for a fish of the given rodTier based on fishing level.
 * At level 1  -> 1.00 (no bonus).
 * At level 99 -> 1 + TIER_LEVEL_BONUS[rodTier].
 *
 * @param {number} fishingLevel - player's current fishing level (1+)
 * @param {number} rodTier      - the fish species' rodTier (0-4)
 * @returns {number} multiplier >= 1.0
 */
function fishingLevelWeightMult(fishingLevel, rodTier) {
    const bonus    = TIER_LEVEL_BONUS[rodTier] ?? 0;
    const progress = Math.min(1, (fishingLevel - 1) / 98); // 0 at lvl 1, 1.0 at lvl 99
    return 1 + bonus * progress;
}

/**
 * Returns a junk weight multiplier based on fishing level and total level.
 * Stacks with the existing rod-tier junk reduction in buildFishTable().
 * At level 1 / total 0   -> 1.0  (no additional reduction).
 * At level 99 / total 200+ -> 0.4 (60% additional junk reduction on top of rod bonus).
 *
 * @param {number} fishingLevel - player's current fishing level (1+)
 * @param {number} totalLevel   - sum of all skill levels
 * @returns {number} multiplier between 0.4 and 1.0
 */
function junkLevelMult(fishingLevel, totalLevel) {
    const fishProg  = Math.min(1, (fishingLevel - 1) / 98); // fishing contribution: up to -40%
    const totalProg = Math.min(1, totalLevel / 200);         // total level contribution: up to -20%
    return Math.max(0.4, 1 - fishProg * 0.4 - totalProg * 0.2);
}

module.exports = { fishingLevelWeightMult, junkLevelMult };
