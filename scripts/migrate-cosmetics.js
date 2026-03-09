#!/usr/bin/env node
/**
 * HoboGame — Supplementary Migration: Cosmetics, Voices, Effects
 *
 * Ports Patrick's RS-Companion active effects, unlocked voices,
 * and cosmetic items into the HoboGame cosmetics system.
 *
 * This script:
 * 1. Activates all fx_* / px_* items in inventory as global cosmetics
 * 2. Adds all RS unlocked voices as global cosmetics
 * 3. Equips the active effects (fx_neon name, px_void particle)
 * 4. Equips the selected voice (crackhead)
 * 5. Sets game_players name_effect and particle_effect columns
 *
 * Safe to run multiple times (uses INSERT OR IGNORE / ON CONFLICT).
 *
 * Usage:
 *   node scripts/migrate-cosmetics.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const RS_DB_PATH = '/home/deck/.config/rs-companion/rs-companion.db';
const HOBO_DB_PATH = path.resolve(__dirname, '../data/hobostreamer.db');

console.log('[Migration] RS-Companion DB:', RS_DB_PATH);
console.log('[Migration] HoboStreamer DB:', HOBO_DB_PATH);

const rsDb = new Database(RS_DB_PATH, { readonly: true });
const hoboDb = new Database(HOBO_DB_PATH);
hoboDb.pragma('journal_mode = WAL');

// ── Build username → hobo user id map ────────────────────────
const hoboUsers = hoboDb.prepare('SELECT id, username FROM users').all();
const hoboMap = new Map();
for (const u of hoboUsers) {
    hoboMap.set(u.username.toLowerCase(), u.id);
}
console.log('[Migration] ' + hoboUsers.length + ' HoboStreamer users loaded');

// ── Fetch RS users ───────────────────────────────────────────
const rsUsers = rsDb.prepare('SELECT user_id, username FROM users').all();
const userMap = new Map(); // rs user_id → hobo user id
let matched = 0;
for (const rsu of rsUsers) {
    const hoboId = hoboMap.get(rsu.username.toLowerCase());
    if (hoboId) {
        userMap.set(rsu.user_id, hoboId);
        matched++;
    }
}
console.log('[Migration] Matched ' + matched + ' users\n');

// ── Prepared statements ──────────────────────────────────────
const upsertCosmetic = hoboDb.prepare(
    'INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)'
);
const upsertEquipped = hoboDb.prepare(
    'INSERT OR REPLACE INTO user_equipped (user_id, slot, item_id) VALUES (?, ?, ?)'
);
const updatePlayerEffect = hoboDb.prepare(
    'UPDATE game_players SET name_effect = ?, particle_effect = ? WHERE user_id = ?'
);

// ── RS voice_id → cosmetic category mapping ──────────────────
// All RS voice IDs are stored directly as cosmetic item_ids
const VOICE_CATEGORY = 'voice';

// ── Run migration ────────────────────────────────────────────
const migrate = hoboDb.transaction(() => {
    let cosmeticCount = 0;
    let voiceCount = 0;
    let equipCount = 0;

    for (const [rsId, hoboId] of userMap) {
        // ── 1. Activate fx_* and px_* items from inventory as cosmetics ──
        const fxItems = hoboDb.prepare(
            "SELECT item_id FROM game_inventory WHERE user_id = ? AND (item_id LIKE 'fx_%' OR item_id LIKE 'px_%') AND quantity > 0"
        ).all(hoboId);

        for (const item of fxItems) {
            const category = item.item_id.startsWith('fx_') ? 'name_effect' : 'particle';
            const result = upsertCosmetic.run(hoboId, item.item_id, category);
            if (result.changes > 0) cosmeticCount++;
        }

        // ── 2. Port unlocked voices from RS to cosmetics ─────────
        let rsVoices = [];
        try {
            rsVoices = rsDb.prepare('SELECT voice_id FROM user_voices WHERE user_id = ?').all(rsId);
        } catch (e) { /* table may not exist */ }

        for (const v of rsVoices) {
            const result = upsertCosmetic.run(hoboId, v.voice_id, VOICE_CATEGORY);
            if (result.changes > 0) voiceCount++;
        }

        // ── 3. Port active effects to equipped and player columns ──
        let activeEffects = [];
        try {
            activeEffects = rsDb.prepare('SELECT * FROM active_effects WHERE user_id = ?').all(rsId);
        } catch (e) { /* table may not exist */ }

        let nameEffect = null;
        let particleEffect = null;

        for (const eff of activeEffects) {
            try {
                const data = JSON.parse(eff.data || '{}');
                if (eff.effect_type === 'name_fx' && data.itemId) {
                    nameEffect = data.itemId;
                    // Ensure cosmetic exists
                    upsertCosmetic.run(hoboId, data.itemId, 'name_effect');
                    // Equip it
                    upsertEquipped.run(hoboId, 'name_effect', data.itemId);
                    equipCount++;
                } else if (eff.effect_type === 'particle_fx' && data.itemId) {
                    particleEffect = data.itemId;
                    upsertCosmetic.run(hoboId, data.itemId, 'particle');
                    upsertEquipped.run(hoboId, 'particle', data.itemId);
                    equipCount++;
                }
            } catch (e) {
                console.warn('[Migration] Failed to parse effect data for user ' + rsId + ':', e.message);
            }
        }

        // Update game_players columns
        if (nameEffect || particleEffect) {
            updatePlayerEffect.run(nameEffect, particleEffect, hoboId);
        }

        // ── 4. Port selected voice to equipped ───────────────────
        let selectedVoice = null;
        try {
            const sel = rsDb.prepare('SELECT voice_id FROM user_voice_selection WHERE user_id = ?').get(rsId);
            if (sel) selectedVoice = sel.voice_id;
        } catch (e) { /* table may not exist */ }

        if (selectedVoice) {
            // Ensure voice cosmetic exists
            upsertCosmetic.run(hoboId, selectedVoice, VOICE_CATEGORY);
            // Equip it
            upsertEquipped.run(hoboId, 'voice', selectedVoice);
            equipCount++;
        }

        console.log('[Migration] User ' + rsId + ' → Hobo #' + hoboId +
            ': ' + fxItems.length + ' effects, ' + rsVoices.length + ' voices' +
            ', equipped: name=' + (nameEffect || 'none') +
            ', particle=' + (particleEffect || 'none') +
            ', voice=' + (selectedVoice || 'none'));
    }

    console.log('\n[Migration] Summary:');
    console.log('  Cosmetics activated: ' + cosmeticCount);
    console.log('  Voices ported: ' + voiceCount);
    console.log('  Equipped items: ' + equipCount);
});

try {
    migrate();
    console.log('\n[Migration] Done!');
} catch (err) {
    console.error('\n[Migration] Failed:', err.message);
    process.exit(1);
} finally {
    rsDb.close();
    hoboDb.close();
}
