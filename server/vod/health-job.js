/**
 * health-job.js — keep the VOD library healthy in the background.
 *
 * Two responsibilities, both throttled and concurrency-safe:
 *   1. SCAN finished VODs that were never health-checked (or not checked in a while) for
 *      corruption / zero-byte / bad-duration. On a problem it first tries to REPAIR from
 *      the lossless .master.mkv archive (and repairs a missing duration); only genuinely
 *      unrecoverable files are quarantined (hidden, is_public=0) — never silently deleted.
 *   2. CLEAN UP VODs that have been quarantined as unrecoverably-broken for a grace period:
 *      one last recovery attempt, else delete the dead files + row to free disk.
 *
 * Design mirrors the transcript backfill: a single serialized worker, at most one ffmpeg
 * pass at a time, small batches, and it backs off to lighter (probe-only) work while any
 * stream is live so it never competes with the live encoders.
 */
'use strict';

const fs = require('fs');
const db = require('../db/database');
const scanner = require('./health-scanner');

const TICK_MS = 5 * 60 * 1000;      // scan pass every 5 minutes
const SCAN_STALE_DAYS = 45;         // re-scan a healthy VOD at most this often
const SCAN_BATCH_IDLE = 3;          // VODs per pass when no stream is live
const SCAN_BATCH_LIVE = 1;          // ...and while live (probe-only, cheap)
const QUARANTINE_GRACE_DAYS = 21;   // clean up unrecoverable quarantined VODs after this
const CLEANUP_BATCH = 3;

let _running = false;
let _timer = null;
let _busy = false;

function _anyLive() {
    try { return ((db.getLiveStreams && db.getLiveStreams()) || []).length > 0; }
    catch { return false; }
}

// Scan (and, if needed, repair) a single VOD. The routine scan is PROBE-based (fast,
// non-destructive) — it catches the breakages viewers actually hit (missing / zero-byte /
// unreadable container / bad duration) without pinning a CPU decoding every healthy VOD.
// The expensive full decode + re-encode only runs to REPAIR a file that already looks
// broken, and only while idle (`deep`).
async function _scanOne(vod, { deep }) {
    let scan = await scanner.scanVod(vod, { decode: false, repairDuration: true, quarantineBad: false });

    const broken = ['corrupt', 'zero_byte', 'missing_file', 'needs_review'].includes(scan.status)
        || (scan.issues || []).some(i => /decode_failed|probe_failed|invalid_duration/.test(i));

    if (!broken) {
        // Healthy (or duration just repaired) — record the clean scan so we don't re-check soon.
        try { db.updateVodHealth(vod.id, { status: 'ok', issues: scan.issues || [] }); } catch { /* */ }
        // The lossless .master.mkv is only a finalize-time recovery fallback. This VOD probed
        // healthy and is long finished, so a lingering master is pure wasted disk — reclaim it.
        // (Finalize normally deletes it; this cleans up ones orphaned by an old crash/bug.)
        try {
            const master = vod.master_file_path || (vod.file_path ? vod.file_path.replace(/\.webm$/, '.master.mkv') : null);
            if (master && fs.existsSync(master)) {
                const freedMb = (fs.statSync(master).size / 1024 / 1024).toFixed(0);
                fs.unlinkSync(master);
                if (vod.master_file_path) { try { db.run('UPDATE vods SET master_file_path = NULL WHERE id = ?', [vod.id]); } catch { /* */ } }
                console.log(`[VOD-Health] Reclaimed orphaned master for vod ${vod.id} (${freedMb}MB)`);
            }
        } catch { /* */ }
        return { id: vod.id, status: 'ok' };
    }

    // Broken but a stream is live → defer the heavy recovery/quarantine to the next idle
    // pass. Don't stamp last_health_scan_at, so it stays first in the queue and is handled
    // promptly once idle.
    if (!deep) return { id: vod.id, status: 'deferred' };

    // Broken → try to rebuild from the lossless master before quarantining.
    let recovered = false;
    if (scan.status !== 'missing_file') {
        try {
            const r = await scanner.recoverFromMaster(vod);
            if (r.recovered) {
                // Re-scan the rebuilt file to confirm it's actually good now.
                const fresh = db.getVodById(vod.id) || vod;
                const rescan = await scanner.scanVod(fresh, { decode: deep, repairDuration: true, quarantineBad: false });
                recovered = !['corrupt', 'zero_byte', 'missing_file'].includes(rescan.status)
                    && !(rescan.issues || []).some(i => /decode_failed|probe_failed/.test(i));
                if (recovered) {
                    console.log(`[VOD-Health] Recovered vod ${vod.id} from master (${Math.round(r.duration)}s)`);
                    return { id: vod.id, status: 'recovered' };
                }
            }
        } catch (e) { console.warn(`[VOD-Health] master recovery error for vod ${vod.id}:`, e.message); }
    }

    // Still broken → quarantine (hide, keep the file for possible manual recovery).
    // 'needs_review' (e.g. very short) is flagged but NOT hidden — it may be watchable.
    const terminal = ['corrupt', 'zero_byte', 'missing_file'].includes(scan.status);
    try {
        db.updateVodHealth(vod.id, {
            status: scan.status,
            issues: scan.issues || [],
            probeDuration: scan.probe ? scan.probe.duration : undefined,
            probeFormat: scan.probe ? scan.probe.format : undefined,
            quarantine: terminal,           // only hide genuinely-broken files
            keepPublic: !terminal,
        });
    } catch { /* */ }
    if (terminal) console.warn(`[VOD-Health] Quarantined vod ${vod.id} — ${scan.status} (${(scan.issues || []).slice(0, 3).join(', ')})`);
    return { id: vod.id, status: scan.status };
}

async function _scanPass(deep) {
    const limit = deep ? SCAN_BATCH_IDLE : SCAN_BATCH_LIVE;
    let vods = [];
    try { vods = db.getVodsNeedingHealthScan({ staleDays: SCAN_STALE_DAYS, limit }); } catch { return; }
    for (const vod of vods) {
        try { await _scanOne(vod, { deep }); }
        catch (e) { console.warn(`[VOD-Health] scan error for vod ${vod.id}:`, e.message); }
    }
}

// Delete a VOD's files everywhere + its DB row. Mirrors the manual delete route.
function _hardDeleteVod(vod) {
    try {
        if (vod.file_path) {
            try { require('./vod-storage').deleteVodObjects(vod).catch(() => {}); } catch { /* */ }
            // Local file + sidecars (.seekable.webm, .master.mkv).
            for (const p of [vod.file_path, vod.file_path.replace(/\.webm$/, '.seekable.webm'), vod.file_path.replace(/\.webm$/, '.master.mkv'), vod.master_file_path].filter(Boolean)) {
                try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* */ }
            }
        }
        db.run('DELETE FROM vods WHERE id = ?', [vod.id]);
        return true;
    } catch (e) {
        console.warn(`[VOD-Health] cleanup delete failed for vod ${vod.id}:`, e.message);
        return false;
    }
}

async function _cleanupPass(deep) {
    let vods = [];
    try { vods = db.getQuarantinedVodsForCleanup({ graceDays: QUARANTINE_GRACE_DAYS, limit: CLEANUP_BATCH }); } catch { return; }
    for (const vod of vods) {
        // One last recovery attempt before deleting — the master may have survived even if
        // the served file didn't. If it recovers, un-quarantine and keep it.
        if (deep && vod.file_path && vod.health_status !== 'missing_file') {
            try {
                const r = await scanner.recoverFromMaster(vod);
                if (r.recovered) {
                    const fresh = db.getVodById(vod.id) || vod;
                    const rescan = await scanner.scanVod(fresh, { decode: true, repairDuration: true, quarantineBad: false });
                    if (!['corrupt', 'zero_byte', 'missing_file'].includes(rescan.status)) {
                        db.run("UPDATE vods SET quarantined_at = NULL, health_status = 'ok' WHERE id = ?", [vod.id]);
                        console.log(`[VOD-Health] Cleanup recovered vod ${vod.id} from master — un-quarantined`);
                        continue;
                    }
                }
            } catch { /* fall through to delete */ }
        }
        if (_hardDeleteVod(vod)) {
            console.log(`[VOD-Health] Cleaned up unrecoverable vod ${vod.id} (quarantined ${vod.health_status}, ${vod.quarantined_at})`);
        }
    }
}

async function _tick() {
    if (_busy) return;
    _busy = true;
    try {
        const deep = !_anyLive();     // full decode + recovery only while idle
        await _scanPass(deep);
        if (deep) await _cleanupPass(deep);
    } catch (e) {
        console.warn('[VOD-Health] tick error:', e.message);
    } finally {
        _busy = false;
    }
}

function start() {
    if (_running) return;
    _running = true;
    // First pass shortly after boot (idle window), then on the interval.
    setTimeout(() => { _tick().catch(() => {}); }, 90 * 1000);
    _timer = setInterval(() => { _tick().catch(() => {}); }, TICK_MS);
    if (_timer.unref) _timer.unref();
    console.log('[VOD] Health job started (scan + master-recovery + quarantine cleanup)');
}

function stop() {
    _running = false;
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, _tick };
