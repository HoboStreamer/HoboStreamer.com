/**
 * HoboStreamer — VOD Storage Tier Manager
 *
 * Manages automatic migration of VODs between storage tiers:
 *   hot  = primary SSD (fast, limited)     → ./data/vods
 *   cold = block storage (large, slower)   → /mnt/hobo-cold/vods
 *
 * VODs start on hot storage. A periodic sweep moves less popular ones
 * to cold storage based on configurable thresholds (age, view count,
 * last access time). VODs can be promoted back to hot on demand.
 *
 * The module is transparent to the rest of the codebase — callers use
 * resolveVodPath(filePath) to get the real on-disk location regardless
 * of which tier the file lives on.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config');
const db = require('../db/database');

// ── Defaults (overridable via site_settings in admin) ────────
const DEFAULTS = {
    enabled: true,
    coldPath: config.vod.coldPath || '/mnt/hobo-cold/vods',
    // A VOD must meet ALL of these to be eligible for cold migration
    minAgeDays: 7,              // at least 7 days old
    maxViewsForCold: 5,         // 5 or fewer views
    minLastAccessDays: 3,       // not accessed in the last 3 days
    // How often to run the sweep (ms)
    sweepIntervalMs: 60 * 60 * 1000, // 1 hour
    // Disk pressure: if hot volume usage >= this %, lower thresholds
    hotDiskPressurePct: 80,
    // Max VODs to migrate per sweep (avoid I/O storms)
    maxPerSweep: 10,
};

let sweepTimer = null;
let sweepRunning = false;

// ── Settings helpers ─────────────────────────────────────────

function getSetting(key) {
    try {
        const row = db.get("SELECT value FROM site_settings WHERE key = ?", [`storage_tier.${key}`]);
        if (row) return JSON.parse(row.value);
    } catch { /* use default */ }
    return DEFAULTS[key];
}

function getSettings() {
    const s = {};
    for (const key of Object.keys(DEFAULTS)) {
        s[key] = getSetting(key);
    }
    return s;
}

function setSetting(key, value) {
    if (!(key in DEFAULTS)) return;
    const dbKey = `storage_tier.${key}`;
    const existing = db.get("SELECT key FROM site_settings WHERE key = ?", [dbKey]);
    if (existing) {
        db.run("UPDATE site_settings SET value = ? WHERE key = ?", [JSON.stringify(value), dbKey]);
    } else {
        db.run("INSERT INTO site_settings (key, value) VALUES (?, ?)", [dbKey, JSON.stringify(value)]);
    }
}

// ── Path helpers ─────────────────────────────────────────────

function hotPath() {
    return path.resolve(config.vod.path);
}

function coldPath() {
    return path.resolve(getSetting('coldPath'));
}

/**
 * Resolve the actual on-disk path for a VOD file_path stored in the DB.
 * VOD file_path in DB is always relative to hot storage (e.g. ./data/vods/vod-10-xxx.webm).
 * This function checks hot first, then cold, and returns the real path.
 */
function resolveVodPath(dbFilePath) {
    if (!dbFilePath) return null;

    // If the path is already absolute and exists, use it directly
    const abs = path.resolve(dbFilePath);
    if (fs.existsSync(abs)) return abs;

    // Try cold storage with same basename
    const basename = path.basename(dbFilePath);
    const cold = path.join(coldPath(), basename);
    if (fs.existsSync(cold)) return cold;

    // File not found on either tier
    return abs; // return hot path as canonical even if missing
}

/**
 * Determine which tier a VOD file currently lives on.
 * Returns 'hot', 'cold', or 'missing'.
 */
function getFileTier(dbFilePath) {
    if (!dbFilePath) return 'missing';
    const basename = path.basename(dbFilePath);
    const hot = path.join(hotPath(), basename);
    if (fs.existsSync(hot)) return 'hot';
    const cold = path.join(coldPath(), basename);
    if (fs.existsSync(cold)) return 'cold';
    return 'missing';
}

// ── Disk usage helpers ───────────────────────────────────────

function diskUsage(targetPath) {
    try {
        const resolved = path.resolve(targetPath);
        const output = execSync(`df -B1 "${resolved}" 2>/dev/null | tail -1`, { encoding: 'utf8' });
        const parts = output.trim().split(/\s+/);
        if (parts.length >= 6) {
            return {
                total: parseInt(parts[1], 10) || 0,
                used: parseInt(parts[2], 10) || 0,
                available: parseInt(parts[3], 10) || 0,
                usePct: parseFloat(parts[4]) || 0,
                mount: parts[5] || '/',
            };
        }
    } catch {}
    return { total: 0, used: 0, available: 0, usePct: 0, mount: '/' };
}

function dirStats(dirPath) {
    let bytes = 0, files = 0;
    try {
        const resolved = path.resolve(dirPath);
        if (!fs.existsSync(resolved)) return { bytes: 0, files: 0 };
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                try { bytes += fs.statSync(path.join(resolved, entry.name)).size; files++; } catch {}
            }
        }
    } catch {}
    return { bytes, files };
}

// ── Migration operations ─────────────────────────────────────

/**
 * Move a VOD file from hot to cold storage.
 * Uses cp + verify + unlink pattern for safety (no rename across mount points).
 */
function moveToCold(vodId) {
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    if (!vod || !vod.file_path) return { ok: false, error: 'VOD not found' };
    if (vod.is_recording) return { ok: false, error: 'VOD is currently recording' };

    const basename = path.basename(vod.file_path);
    const src = path.join(hotPath(), basename);
    const dst = path.join(coldPath(), basename);

    if (!fs.existsSync(src)) {
        // Already on cold or missing
        if (fs.existsSync(dst)) {
            db.run("UPDATE vods SET storage_tier = 'cold' WHERE id = ?", [vodId]);
            return { ok: true, already: true };
        }
        return { ok: false, error: 'Source file missing' };
    }

    try {
        // Ensure cold directory exists
        fs.mkdirSync(coldPath(), { recursive: true });

        // Copy then verify size, then remove source
        fs.copyFileSync(src, dst);
        const srcSize = fs.statSync(src).size;
        const dstSize = fs.statSync(dst).size;
        if (srcSize !== dstSize) {
            // Copy failed — clean up and abort
            try { fs.unlinkSync(dst); } catch {}
            return { ok: false, error: `Size mismatch after copy: ${srcSize} vs ${dstSize}` };
        }

        // Safe to remove source
        try {
            fs.unlinkSync(src);
        } catch (err) {
            console.error(`[StorageTier] Failed to remove hot source after cold copy for VOD ${vodId}:`, err.message);
            return { ok: false, error: `Failed to remove hot source after copy: ${err.message}` };
        }

        // Also move seekable sidecar if it exists
        const seekSrc = src.replace(/\.webm$/, '.seekable.webm');
        if (fs.existsSync(seekSrc)) {
            try { fs.unlinkSync(seekSrc); } catch (err) {
                console.warn(`[StorageTier] Could not remove seekable sidecar for VOD ${vodId}:`, err.message);
            }
        }

        // Update DB
        db.run("UPDATE vods SET storage_tier = 'cold' WHERE id = ?", [vodId]);

        console.log(`[StorageTier] VOD ${vodId} moved to cold: ${basename} (${(srcSize / 1048576).toFixed(1)} MB)`);
        return { ok: true, bytes: srcSize };
    } catch (err) {
        console.error(`[StorageTier] Failed to move VOD ${vodId} to cold:`, err.message);
        return { ok: false, error: err.message };
    }
}

/**
 * Promote a VOD file from cold back to hot storage.
 */
function moveToHot(vodId) {
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    if (!vod || !vod.file_path) return { ok: false, error: 'VOD not found' };

    const basename = path.basename(vod.file_path);
    const src = path.join(coldPath(), basename);
    const dst = path.join(hotPath(), basename);

    if (!fs.existsSync(src)) {
        if (fs.existsSync(dst)) {
            db.run("UPDATE vods SET storage_tier = 'hot' WHERE id = ?", [vodId]);
            return { ok: true, already: true };
        }
        return { ok: false, error: 'Source file missing from cold storage' };
    }

    try {
        fs.copyFileSync(src, dst);
        const srcSize = fs.statSync(src).size;
        const dstSize = fs.statSync(dst).size;
        if (srcSize !== dstSize) {
            try { fs.unlinkSync(dst); } catch {}
            return { ok: false, error: `Size mismatch after copy: ${srcSize} vs ${dstSize}` };
        }

        try {
            fs.unlinkSync(src);
        } catch (err) {
            console.error(`[StorageTier] Failed to remove cold source after hot copy for VOD ${vodId}:`, err.message);
            return { ok: false, error: `Failed to remove cold source after copy: ${err.message}` };
        }
        db.run("UPDATE vods SET storage_tier = 'hot' WHERE id = ?", [vodId]);

        console.log(`[StorageTier] VOD ${vodId} promoted to hot: ${basename} (${(srcSize / 1048576).toFixed(1)} MB)`);
        return { ok: true, bytes: srcSize };
    } catch (err) {
        console.error(`[StorageTier] Failed to promote VOD ${vodId} to hot:`, err.message);
        return { ok: false, error: err.message };
    }
}

// ── Automatic sweep ──────────────────────────────────────────

/**
 * Run one sweep: find hot VODs eligible for cold migration, move them.
 * Returns summary { checked, migrated, bytesFreed, errors }.
 */
function runSweep() {
    if (sweepRunning) return { skipped: true, reason: 'already running' };
    sweepRunning = true;

    const settings = getSettings();
    if (!settings.enabled) {
        sweepRunning = false;
        return { skipped: true, reason: 'disabled' };
    }

    // Check if cold storage is available
    if (!fs.existsSync(settings.coldPath)) {
        sweepRunning = false;
        console.warn('[StorageTier] Cold storage path not available:', settings.coldPath);
        return { skipped: true, reason: 'cold storage not mounted' };
    }

    try {
        const maxPerSweep = settings.maxPerSweep;
        let { minAgeDays, maxViewsForCold, minLastAccessDays } = settings;

        // Under disk pressure, relax thresholds to move more aggressively
        const hotDisk = diskUsage(hotPath());
        if (hotDisk.usePct >= settings.hotDiskPressurePct) {
            minAgeDays = Math.max(1, Math.floor(minAgeDays / 2));
            maxViewsForCold = Math.max(maxViewsForCold, 10);
            minLastAccessDays = Math.max(1, Math.floor(minLastAccessDays / 2));
            console.log(`[StorageTier] Hot disk at ${hotDisk.usePct}% — relaxed thresholds (age=${minAgeDays}d, views<=${maxViewsForCold}, access=${minLastAccessDays}d)`);
        }

        // Find eligible hot-tier VODs
        // Must be: not recording, old enough, low views, not recently accessed
        const candidates = db.all(`
            SELECT v.id, v.file_path, v.file_size, v.view_count, v.created_at,
                   v.last_accessed_at, v.storage_tier
            FROM vods v
            WHERE COALESCE(v.storage_tier, 'hot') = 'hot'
              AND COALESCE(v.is_recording, 0) = 0
              AND v.created_at <= datetime('now', ?)
              AND COALESCE(v.view_count, 0) <= ?
              AND (v.last_accessed_at IS NULL OR v.last_accessed_at <= datetime('now', ?))
            ORDER BY v.view_count ASC, v.file_size DESC
            LIMIT ?
        `, [`-${minAgeDays} days`, maxViewsForCold, `-${minLastAccessDays} days`, maxPerSweep]);

        let migrated = 0, bytesFreed = 0, errors = [];

        for (const vod of candidates) {
            // Double-check file is actually on hot
            if (getFileTier(vod.file_path) !== 'hot') continue;

            const result = moveToCold(vod.id);
            if (result.ok && !result.already) {
                migrated++;
                bytesFreed += result.bytes || 0;
            } else if (!result.ok) {
                errors.push({ id: vod.id, error: result.error });
            }
        }

        const summary = { checked: candidates.length, migrated, bytesFreed, errors: errors.length ? errors : undefined, timestamp: new Date().toISOString() };
        if (migrated > 0) {
            console.log(`[StorageTier] Sweep complete: ${migrated}/${candidates.length} migrated, ${(bytesFreed / 1048576).toFixed(1)} MB freed from hot`);
        }
        return summary;
    } catch (err) {
        console.error('[StorageTier] Sweep error:', err.message);
        return { error: err.message };
    } finally {
        sweepRunning = false;
    }
}

// ── Lifecycle ────────────────────────────────────────────────

/**
 * Start the periodic sweep timer.
 */
function start() {
    stop(); // Clear any existing timer
    const settings = getSettings();
    if (!settings.enabled) {
        console.log('[StorageTier] Disabled — not starting sweep timer');
        return;
    }
    const interval = settings.sweepIntervalMs;
    console.log(`[StorageTier] Starting sweep timer (every ${(interval / 60000).toFixed(0)} min)`);
    // Run first sweep after a short delay to let the server finish starting
    setTimeout(() => {
        runSweep();
        sweepTimer = setInterval(runSweep, interval);
    }, 30_000);
}

function stop() {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}

/**
 * Sync storage_tier column with actual file locations.
 * Call on startup to handle manual file moves or missed DB updates.
 */
function syncTiers() {
    try {
        const vods = db.all("SELECT id, file_path, storage_tier FROM vods WHERE COALESCE(is_recording, 0) = 0");
        let fixed = 0;
        for (const vod of vods) {
            const actual = getFileTier(vod.file_path);
            const dbTier = vod.storage_tier || 'hot';
            if (actual !== 'missing' && actual !== dbTier) {
                db.run("UPDATE vods SET storage_tier = ? WHERE id = ?", [actual, vod.id]);
                fixed++;
            }
        }
        if (fixed > 0) console.log(`[StorageTier] Synced ${fixed} VOD tier(s) with actual file locations`);
    } catch (err) {
        console.error('[StorageTier] Sync error:', err.message);
    }
}

// ── Status for admin panel ───────────────────────────────────

function getStatus() {
    const settings = getSettings();
    const hot = diskUsage(hotPath());
    const cold = diskUsage(settings.coldPath);
    const hotStats = dirStats(hotPath());
    const coldStats = dirStats(settings.coldPath);

    const tierCounts = db.get(`
        SELECT
            SUM(CASE WHEN COALESCE(storage_tier, 'hot') = 'hot' THEN 1 ELSE 0 END) as hotCount,
            SUM(CASE WHEN storage_tier = 'cold' THEN 1 ELSE 0 END) as coldCount,
            SUM(CASE WHEN COALESCE(storage_tier, 'hot') = 'hot' THEN file_size ELSE 0 END) as hotBytes,
            SUM(CASE WHEN storage_tier = 'cold' THEN file_size ELSE 0 END) as coldBytes
        FROM vods
    `) || {};

    return {
        settings,
        hot: {
            disk: hot,
            vods: { bytes: hotStats.bytes, files: hotStats.files },
            dbCount: tierCounts.hotCount || 0,
            dbBytes: tierCounts.hotBytes || 0,
        },
        cold: {
            disk: cold,
            vods: { bytes: coldStats.bytes, files: coldStats.files },
            dbCount: tierCounts.coldCount || 0,
            dbBytes: tierCounts.coldBytes || 0,
            available: fs.existsSync(settings.coldPath),
        },
        sweepRunning,
    };
}

module.exports = {
    resolveVodPath,
    getFileTier,
    moveToCold,
    moveToHot,
    runSweep,
    start,
    stop,
    syncTiers,
    getStatus,
    getSettings,
    setSetting,
    diskUsage,
    dirStats,
    hotPath,
    coldPath,
    DEFAULTS,
};
