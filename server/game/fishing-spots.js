'use strict';
// fishing-spots.js
// Named fishing location system.
//
// Each zone type has multiple named variants. The specific name for a tile is
// chosen deterministically from the tile coordinates -- so every tile always
// has the same name, but different locations within the same zone feel distinct.
// No randomness at runtime; no extra DB queries.

const FISHING_SPOT_NAMES = {
    shallow: [
        'Shallow Waters',
        'Mudflat Cove',
        'The Sandy Shallows',
        'Barnacle Bay',
        'Tidepools',
    ],
    river: [
        'Murky Current',
        'Calm Bend',
        'The Narrows',
        'Mossy Banks',
        'The Muddy River',
    ],
    deep: [
        'Deep Ocean',
        'The Abyss',
        'Open Sea',
        'Dark Waters',
        'The Drop-Off',
    ],
    arctic: [
        'Arctic Waters',
        'Frostbite Bay',
        'Glacial Basin',
        'The Ice Shelf',
        'Frozen Passage',
    ],
};

/**
 * Returns a deterministic named fishing spot for a given tile coordinate and zone.
 * Same tile always returns the same name; nearby tiles in the same zone may differ.
 *
 * @param {number} tileX
 * @param {number} tileY
 * @param {string} zone - 'shallow' | 'river' | 'deep' | 'arctic'
 * @returns {string} display name for the fishing spot
 */
function getSpotName(tileX, tileY, zone) {
    const names = FISHING_SPOT_NAMES[zone];
    if (!names) return 'Unknown Waters';
    // Mix coords with primes to spread names across the world
    const idx = Math.abs((tileX * 7 + tileY * 13)) % names.length;
    return names[idx];
}

module.exports = { FISHING_SPOT_NAMES, getSpotName };
