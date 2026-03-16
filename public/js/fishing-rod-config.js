'use strict';
// fishing-rod-config.js
// Rod-specific tuning for the fishing mini-game reel mechanic.
// Item IDs match the ITEMS catalog in server/game/items.js.
//
// speedMult          — multiplier on the per-zone base bar speed (lower = slower pointer = easier)
// sweetSpotBonus     — added to the base sweet spot width of 0.28 (higher = wider green zone = easier)
// roundsNeeded       — how many reel rounds before the catch is sent to the server
// speedIncPerRound   — how much bar speed increases each round (lower = gentler difficulty ramp)
// sweetShrinkPerRound— how much the sweet spot shrinks each round (lower = gentler difficulty ramp)
//
// Bamboo is the baseline (no bonuses). Each tier progressively eases the mini-game.

const ROD_FISHING_CONFIG = {
    rod_bamboo:     { speedMult: 1.00, sweetSpotBonus: 0.00, roundsNeeded: 3, speedIncPerRound: 0.007, sweetShrinkPerRound: 0.040 },
    rod_fiberglass: { speedMult: 0.88, sweetSpotBonus: 0.03, roundsNeeded: 3, speedIncPerRound: 0.006, sweetShrinkPerRound: 0.035 },
    rod_carbon:     { speedMult: 0.76, sweetSpotBonus: 0.06, roundsNeeded: 3, speedIncPerRound: 0.005, sweetShrinkPerRound: 0.030 },
    rod_titanium:   { speedMult: 0.64, sweetSpotBonus: 0.09, roundsNeeded: 3, speedIncPerRound: 0.004, sweetShrinkPerRound: 0.025 },
    rod_mythril:    { speedMult: 0.50, sweetSpotBonus: 0.13, roundsNeeded: 3, speedIncPerRound: 0.003, sweetShrinkPerRound: 0.020 },
};

const ROD_FISHING_DEFAULT = ROD_FISHING_CONFIG.rod_bamboo;

function getRodFishingConfig(rodId) {
    return ROD_FISHING_CONFIG[rodId] || ROD_FISHING_DEFAULT;
}
