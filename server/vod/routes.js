/**
 * HoboStreamer — VOD & Clips API Routes
 * 
 * VODs:
 * GET    /api/vods                 - List public VODs
 * GET    /api/vods/mine            - List my VODs (private + public)
 * GET    /api/vods/:id             - Get VOD details
 * PUT    /api/vods/:id             - Update VOD (title, public/private)
 * DELETE /api/vods/:id             - Delete a VOD
 * POST   /api/vods/:id/publish     - Make VOD public
 * POST   /api/vods/bulk-delete-old - Bulk delete own VODs/clips older than N days
 * 
 * Clips:
 * GET    /api/clips                - List public clips
 * GET    /api/clips/:id            - Get clip details
 * POST   /api/clips                - Create a clip from a VOD
 * DELETE /api/clips/:id            - Delete a clip
 * GET    /api/clips/stream/:id     - Get clips for a stream
 * 
 * File serving:
 * GET    /api/vods/file/:filename  - Serve VOD/clip file
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const multer = require('multer');
const db = require('../db/database');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const config = require('../config');
const thumbService = require('../thumbnails/thumbnail-service');

const router = express.Router();
const CLIP_USER_COOLDOWN_MS = 10000;    // 10s between VOD clip creations per user
const CLIP_IP_COOLDOWN_MS = 5000;       // 5s between clip creations per IP
const CLIP_LIVE_USER_COOLDOWN_MS = 2500; // 2.5s for live clips (lighter operation)
const CLIP_LIVE_IP_COOLDOWN_MS = 1200;
const CLIP_DUPLICATE_START_WINDOW_SEC = 8;
const CLIP_DUPLICATE_END_WINDOW_SEC = 10;
const CLIP_DUPLICATE_LOOKBACK_MINUTES = 10;
const CLIP_MAX_PER_USER_PER_HOUR = 20;
const CLIP_MAX_OUTPUT_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const CLIP_FFMPEG_TIMEOUT_MS = 30000;   // 30s FFmpeg timeout
const CLIP_MAX_CONCURRENT_FFMPEG = 3;
const CLIP_MIN_ACCOUNT_AGE_MS = 60000;  // 1 minute
let _activeFFmpegJobs = 0;
const recentClipAttemptsByUser = new Map();
const recentClipAttemptsByIp = new Map();

function getRequesterIp(req) {
    return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

function pruneRecentAttempts(now = Date.now()) {
    const cutoff = now - Math.max(CLIP_USER_COOLDOWN_MS, CLIP_IP_COOLDOWN_MS) - 5000;
    for (const [key, ts] of recentClipAttemptsByUser) {
        if (ts < cutoff) recentClipAttemptsByUser.delete(key);
    }
    for (const [key, ts] of recentClipAttemptsByIp) {
        if (ts < cutoff) recentClipAttemptsByIp.delete(key);
    }
}

function parseClipWindow(body) {
    const startTime = Number.parseFloat(body?.start_time);
    const endTime = Number.parseFloat(body?.end_time);
    return {
        startTime: Number.isFinite(startTime) ? startTime : 0,
        endTime: Number.isFinite(endTime) ? endTime : 0,
    };
}

function findExistingDuplicateClip({ streamId, vodId, startTime, endTime }) {
    if ((!streamId && !vodId) || !Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
    return db.findDuplicateClip({
        streamId: streamId || null,
        vodId: vodId || null,
        startTime,
        endTime,
        startWindow: CLIP_DUPLICATE_START_WINDOW_SEC,
        endWindow: CLIP_DUPLICATE_END_WINDOW_SEC,
        createdSinceMinutes: CLIP_DUPLICATE_LOOKBACK_MINUTES,
    });
}

function shouldThrottleClipRequest(req, isLive = false) {
    const now = Date.now();
    pruneRecentAttempts(now);

    const userCooldown = isLive ? CLIP_LIVE_USER_COOLDOWN_MS : CLIP_USER_COOLDOWN_MS;
    const ipCooldown = isLive ? CLIP_LIVE_IP_COOLDOWN_MS : CLIP_IP_COOLDOWN_MS;
    const userKey = req.user?.id ? `user:${req.user.id}` : null;
    const ipKey = `ip:${getRequesterIp(req)}`;
    const userLast = userKey ? recentClipAttemptsByUser.get(userKey) || 0 : 0;
    const ipLast = recentClipAttemptsByIp.get(ipKey) || 0;

    if ((userKey && (now - userLast) < userCooldown) || (now - ipLast) < ipCooldown) {
        return true;
    }

    if (userKey) recentClipAttemptsByUser.set(userKey, now);
    recentClipAttemptsByIp.set(ipKey, now);
    return false;
}

/** Sanitize user-provided title: strip HTML tags, limit length */
function sanitizeClipTitle(title) {
    if (!title || typeof title !== 'string') return 'Untitled Clip';
    return title.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').trim().slice(0, 200) || 'Untitled Clip';
}

/**
 * Build a sensible default clip title from the source stream/VOD when the user
 * didn't provide one — a grid full of "Untitled Clip" is hard to browse.
 */
function defaultClipTitle(sanitizedTitle, sourceTitle) {
    if (sanitizedTitle && sanitizedTitle !== 'Untitled Clip') return sanitizedTitle;
    const src = (sourceTitle || '').toString().replace(/<[^>]*>/g, '').trim();
    return (src ? `Clip: ${src}` : 'Untitled Clip').slice(0, 200);
}

/** Check if user has exceeded hourly clip creation limit */
function isUserOverHourlyClipLimit(userId) {
    if (!userId) return true;
    const row = db.get(
        `SELECT COUNT(*) as cnt FROM clips WHERE user_id = ? AND created_at >= datetime('now', '-1 hour')`,
        [userId]
    );
    return (row?.cnt || 0) >= CLIP_MAX_PER_USER_PER_HOUR;
}

/** Check account age meets minimum requirement */
function isAccountTooNew(user) {
    if (!user?.created_at) return true;
    const created = new Date(user.created_at + (user.created_at.includes('Z') ? '' : 'Z'));
    return (Date.now() - created.getTime()) < CLIP_MIN_ACCOUNT_AGE_MS;
}

/**
 * Remux all existing WebM files that lack proper duration metadata.
 * Called once at startup to fix previously-uploaded files.
 */
async function remuxExistingFiles() {
    const dirs = [config.vod.path, config.vod.clipsPath].map(d => path.resolve(d));
    let fixed = 0;
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.webm'));
        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                // Quick check: does ffprobe report N/A duration?
                const hasDuration = await new Promise((resolve) => {
                    const probe = spawn('ffprobe', [
                        '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
                    ]);
                    let out = '';
                    probe.stdout.on('data', d => out += d);
                    probe.on('close', () => {
                        try {
                            const info = JSON.parse(out);
                            const dur = parseFloat(info.format?.duration || '0');
                            resolve(dur > 0 && isFinite(dur));
                        } catch { resolve(false); }
                    });
                    probe.on('error', () => resolve(true)); // skip on probe error
                    setTimeout(() => { try { probe.kill(); } catch {} resolve(true); }, 5000);
                });
                if (!hasDuration) {
                    await remuxForSeeking(filePath);
                    fixed++;
                }
            } catch {}
        }
    }
    if (fixed > 0) console.log(`[VOD] Remuxed ${fixed} existing file(s) for seeking support`);
}

// Run once at startup (non-blocking) — skips files already remuxed
const REMUX_FLAG = path.resolve(config.vod.path, '.remux-done');
if (!fs.existsSync(REMUX_FLAG)) {
    remuxExistingFiles()
        .then(() => {
            try { fs.writeFileSync(REMUX_FLAG, new Date().toISOString()); } catch {}
        })
        .catch(() => {});
}

repairZeroDurationVods().catch(() => {});

/**
 * Remux a WebM file with ffmpeg to add proper seek metadata (Cues element).
 * WebM files from MediaRecorder lack Cues and often have Inf duration,
 * which prevents browser-side seeking. A fast copy-remux fixes this.
 * Replaces the original file in-place.
 */
function remuxForSeeking(filePath) {
    return new Promise((resolve) => {
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.webm') return resolve(false); // Only remux WebM

        const tmpPath = filePath + '.remux.webm';
        const proc = spawn('ffmpeg', [
            '-y', '-i', filePath,
            '-c', 'copy',
            '-fflags', '+genpts',
            tmpPath,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', d => stderr += d);

        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(tmpPath)) {
                try {
                    fs.renameSync(tmpPath, filePath);
                    console.log(`[VOD] Remuxed for seeking: ${path.basename(filePath)}`);
                    resolve(true);
                } catch (err) {
                    console.warn(`[VOD] Remux rename failed:`, err.message);
                    try { fs.unlinkSync(tmpPath); } catch {}
                    resolve(false);
                }
            } else {
                console.warn(`[VOD] Remux failed (code ${code}): ${stderr.slice(-200)}`);
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
                resolve(false);
            }
        });

        proc.on('error', () => resolve(false));

        // Timeout: 60s should be plenty for copy-mode remux
        setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
    });
}

/**
 * Probe a media file's start_time using ffprobe.
 * Returns the start time in seconds, or 0 if probing fails.
 */
function probeStartTime(filePath) {
    return new Promise((resolve) => {
        const probe = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json',
            '-show_entries', 'format=start_time',
            filePath,
        ]);
        let out = '';
        probe.stdout.on('data', d => out += d);
        probe.on('close', () => {
            try {
                const info = JSON.parse(out);
                const startTime = parseFloat(info.format?.start_time || '0');
                resolve(Number.isFinite(startTime) && startTime > 0 ? startTime : 0);
            } catch { resolve(0); }
        });
        probe.on('error', () => resolve(0));
        setTimeout(() => { try { probe.kill(); } catch {} resolve(0); }, 5000);
    });
}

function probeVodDuration(filePath) {
    return new Promise((resolve) => {
        const probe = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json',
            '-show_format', filePath,
        ]);
        let out = '';
        probe.stdout.on('data', d => out += d);
        probe.on('close', () => {
            try {
                const info = JSON.parse(out);
                const duration = Math.round(parseFloat(info.format?.duration || '0'));
                resolve(duration > 0 ? duration : 0);
            } catch { resolve(0); }
        });
        probe.on('error', () => resolve(0));
        setTimeout(() => { try { probe.kill(); } catch {} resolve(0); }, 10000);
    });
}

function probeVodInfo(filePath) {
    return new Promise((resolve) => {
        const probe = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json',
            '-show_format', '-show_streams',
            filePath,
        ]);
        let out = '';
        probe.stdout.on('data', d => out += d);
        probe.on('close', () => {
            try {
                const info = JSON.parse(out);
                const duration = Math.round(parseFloat(info.format?.duration || '0'));
                resolve({
                    duration: duration > 0 ? duration : 0,
                    format: info.format || null,
                    streams: info.streams || [],
                });
            } catch { resolve({ duration: 0, format: null, streams: [] }); }
        });
        probe.on('error', () => resolve({ duration: 0, format: null, streams: [] }));
        setTimeout(() => { try { probe.kill(); } catch {} resolve({ duration: 0, format: null, streams: [] }); }, 10000);
    });
}

function getFileSizeSafe(filePath) {
    try { return filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0; } catch { return 0; }
}

/**
 * Resolve whether a new clip should be public, honoring the streamer's
 * default_clip_visibility channel setting. Only 'public' → public; 'unlisted'
 * and 'private' → not public. Defaults to public when the setting is unknown.
 */
function resolveClipIsPublic(streamOwnerId) {
    try {
        if (!streamOwnerId) return 1;
        const channel = db.getChannelByUserId(streamOwnerId);
        if (channel && channel.default_clip_visibility && channel.default_clip_visibility !== 'public') {
            return 0;
        }
    } catch { /* fall through to public */ }
    return 1;
}

async function repairZeroDurationVods() {
    const vods = db.all(
        `SELECT id, file_path FROM vods WHERE COALESCE(is_recording, 0) = 0 AND duration_seconds <= 0`
    );
    for (const vod of vods) {
        if (!vod.file_path || !fs.existsSync(vod.file_path)) {
            console.log(`[VOD] Removing stale zero-duration vod ${vod.id}: missing file`);
            db.run('DELETE FROM vods WHERE id = ?', [vod.id]);
            continue;
        }

        const duration = await probeVodDuration(vod.file_path);
        if (duration > 0) {
            const fileSize = getFileSizeSafe(vod.file_path);
            db.run('UPDATE vods SET duration_seconds = ?, file_size = ?, health_status = ?, probe_duration_seconds = ? WHERE id = ?', [duration, fileSize, 'duration_repaired', duration, vod.id]);
            await remuxForSeeking(vod.file_path).catch(() => {});
            console.log(`[VOD] Repaired zero-duration vod ${vod.id}: duration ${duration}s`);
            continue;
        }

        console.log(`[VOD] Marking corrupted zero-duration vod ${vod.id} as corrupt: ${path.basename(vod.file_path)}`);
        db.run(
            `UPDATE vods SET health_status = ?, health_issues_json = ?, last_health_scan_at = datetime('now'), quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
            ['corrupt', JSON.stringify(['zero-duration-probe-failed']), vod.id]
        );
    }
}

/**
 * Remux a clip file for playback — handles both seeking support and
 * timestamp rebasing for clips recorded after a long streaming session.
 *
 * MediaRecorder rolling-buffer clips can have cluster timestamps far
 * from zero (e.g. 7200s if clipped 2 hours into a stream). Browsers
 * show a black screen because there's no data at timestamp 0.
 *
 * Strategy:
 * 1. Copy-mode remux (fast, adds Cues for seeking)
 * 2. Probe the result's start_time
 * 3. If start_time > 5s, re-encode to reset timestamps to start from 0
 *    (clips are ≤30s so re-encoding is fast and guarantees correctness)
 */
async function remuxClipFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.webm') return false;

    // Step 1: Copy-mode remux for Cues/seeking
    const copyOk = await remuxForSeeking(filePath);

    // Step 2: Probe the first timestamp
    const startOffset = await probeStartTime(filePath);
    if (startOffset <= 5) {
        // Timestamps are fine — copy-mode remux is sufficient
        return copyOk;
    }

    // Step 3: Timestamps are offset — re-encode to rebase to 0
    console.log(`[Clips] Timestamp offset detected (${startOffset.toFixed(1)}s), re-encoding to fix: ${path.basename(filePath)}`);
    return new Promise((resolve) => {
        const tmpPath = filePath + '.rebase.webm';
        const proc = spawn('ffmpeg', [
            '-y', '-err_detect', 'ignore_err',
            '-i', filePath,
            '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
            '-c:a', 'libopus', '-b:a', '128k',
            tmpPath,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(tmpPath)) {
                try {
                    fs.renameSync(tmpPath, filePath);
                    console.log(`[Clips] Re-encoded for timestamp fix: ${path.basename(filePath)}`);
                    resolve(true);
                } catch (err) {
                    console.warn(`[Clips] Re-encode rename failed:`, err.message);
                    try { fs.unlinkSync(tmpPath); } catch {}
                    resolve(false);
                }
            } else {
                console.warn(`[Clips] Re-encode failed (code ${code}): ${stderr.slice(-300)}`);
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
                resolve(false);
            }
        });
        proc.on('error', () => resolve(false));
        // Clips are ≤30s — 90s timeout is generous
        setTimeout(() => { try { proc.kill(); } catch {} }, 90000);
    });
}

/**
 * Create a seekable copy of a live-recording WebM file.
 * Writes to <filename>.seekable.webm WITHOUT touching the original growing file.
 * Debounced per file — only one remux runs at a time per recording.
 */
const _liveRemuxInProgress = new Set();

function remuxForLiveSeeking(filePath) {
    if (_liveRemuxInProgress.has(filePath)) return Promise.resolve(false);
    _liveRemuxInProgress.add(filePath);

    const seekablePath = filePath.replace(/\.webm$/, '.seekable.webm');
    const tmpPath = filePath + '.live-remux.tmp.webm';

    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', [
            '-y', '-i', filePath,
            '-c', 'copy',
            '-fflags', '+genpts',
            tmpPath,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', d => stderr += d);

        proc.on('close', (code) => {
            _liveRemuxInProgress.delete(filePath);
            if (code === 0 && fs.existsSync(tmpPath)) {
                try {
                    fs.renameSync(tmpPath, seekablePath);
                    resolve(true);
                } catch (err) {
                    console.warn(`[VOD] Live remux rename failed:`, err.message);
                    try { fs.unlinkSync(tmpPath); } catch {}
                    resolve(false);
                }
            } else {
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
                resolve(false);
            }
        });

        proc.on('error', () => {
            _liveRemuxInProgress.delete(filePath);
            resolve(false);
        });

        // Timeout: 30s for live remux
        setTimeout(() => {
            _liveRemuxInProgress.delete(filePath);
            try { proc.kill(); } catch {}
        }, 30000);
    });
}

/**
 * Clean up the .seekable.webm file after finalization.
 */
function cleanupSeekableFile(filePath) {
    const seekablePath = filePath.replace(/\.webm$/, '.seekable.webm');
    try { if (fs.existsSync(seekablePath)) fs.unlinkSync(seekablePath); } catch {}
}

// Multer storage for VOD uploads
const VOD_MIME_TO_EXT = { 'video/webm': '.webm', 'video/mp4': '.mp4', 'video/x-matroska': '.mkv', 'video/ogg': '.ogg' };

/** Strip codec params from MIME types like "video/webm;codecs=vp9,opus" → "video/webm" */
function baseMediaType(mime) {
    return (mime || '').split(';')[0].trim().toLowerCase();
}

const vodStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const vodDir = path.resolve(config.vod.path);
        if (!fs.existsSync(vodDir)) fs.mkdirSync(vodDir, { recursive: true });
        cb(null, vodDir);
    },
    filename: (req, file, cb) => {
        const ext = VOD_MIME_TO_EXT[baseMediaType(file.mimetype)] || '.webm';
        cb(null, `vod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
});
const vodUpload = multer({
    storage: vodStorage,
    limits: { fileSize: config.vod.maxSizeMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (VOD_MIME_TO_EXT[baseMediaType(file.mimetype)]) cb(null, true);
        else cb(new Error('Only WebM, MP4, MKV, and OGG video files are allowed'));
    },
});

// ══════════════════════════════════════════════════════════════
//  CHUNKED VOD RECORDING (incremental upload from browser)
// ══════════════════════════════════════════════════════════════

/**
 * Active VOD recordings tracked in memory.
 * streamId → { vodId, filePath, startTime, chunkCount, currentSegmentId, currentSegmentPath }
 */
const activeRecordings = new Map();

function makeSegmentPath(filePath, segmentId) {
    const base = filePath.replace(/\.webm$/, '');
    return `${base}.seg-${segmentId}-${Date.now()}.webm`;
}

function getPendingSegmentFiles(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath).replace(/\.webm$/, '');
    try {
        return fs.readdirSync(dir)
            .filter((name) => name.startsWith(`${base}.seg-`) && name.endsWith('.webm'))
            .map((name) => path.join(dir, name))
            .sort((a, b) => {
                const am = /\.seg-(\d+)-(\d+)\.webm$/.exec(a);
                const bm = /\.seg-(\d+)-(\d+)\.webm$/.exec(b);
                const aSeg = parseInt(am?.[1] || '0', 10);
                const bSeg = parseInt(bm?.[1] || '0', 10);
                if (aSeg !== bSeg) return aSeg - bSeg;
                const aTs = parseInt(am?.[2] || '0', 10);
                const bTs = parseInt(bm?.[2] || '0', 10);
                return aTs - bTs;
            });
    } catch {
        return [];
    }
}

function concatWebmFiles(basePath, appendPath) {
    if (!appendPath || !fs.existsSync(appendPath)) return Promise.resolve(true);
    if (!basePath || !fs.existsSync(basePath)) {
        fs.renameSync(appendPath, basePath);
        return Promise.resolve(true);
    }

    const listPath = `${basePath}.concat.${Date.now()}.txt`;
    const tmpPath = `${basePath}.concat.tmp.webm`;
    const escapedBase = basePath.replace(/'/g, `'\\''`);
    const escapedAppend = appendPath.replace(/'/g, `'\\''`);
    fs.writeFileSync(listPath, `file '${escapedBase}'\nfile '${escapedAppend}'\n`, 'utf8');

    const runConcat = (args) => new Promise((resolve) => {
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => stderr += d);
        proc.on('close', (code) => resolve({ code, stderr }));
        proc.on('error', () => resolve({ code: -1, stderr: 'spawn error' }));
        setTimeout(() => { try { proc.kill(); } catch {} }, 120000);
    });

    return (async () => {
        try {
            let result = await runConcat(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-fflags', '+genpts', tmpPath]);
            if (result.code !== 0 || !fs.existsSync(tmpPath)) {
                result = await runConcat(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k', tmpPath]);
            }
            if (result.code === 0 && fs.existsSync(tmpPath)) {
                fs.renameSync(tmpPath, basePath);
                cleanupTempFile(appendPath);
                cleanupTempFile(listPath);
                return true;
            }
            cleanupTempFile(tmpPath);
            cleanupTempFile(listPath);
            return false;
        } catch {
            cleanupTempFile(tmpPath);
            cleanupTempFile(listPath);
            return false;
        }
    })();
}

async function mergePendingSegments(filePath) {
    for (const segmentPath of getPendingSegmentFiles(filePath)) {
        const ok = await concatWebmFiles(filePath, segmentPath);
        if (!ok) {
            console.warn(`[VOD] Failed to merge segment into ${path.basename(filePath)}: ${path.basename(segmentPath)}`);
        }
    }
}

/**
 * Upload a VOD chunk for a live stream.
 * First chunk creates the VOD record; subsequent chunks append.
 * Chunks are saved to disk immediately for crash resilience.
 */
router.post('/stream/:streamId/chunk', requireAuth, vodUpload.single('chunk'), async (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const segmentId = Math.max(1, parseInt(req.body?.segmentId || req.query.segmentId || '1', 10) || 1);
        if (!req.file) return res.status(400).json({ error: 'No chunk data' });

        const stream = db.getStreamById(streamId);
        if (!stream) { cleanupTempFile(req.file.path); return res.status(404).json({ error: 'Stream not found' }); }
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            cleanupTempFile(req.file.path);
            return res.status(403).json({ error: 'Not your stream' });
        }

        const vodPolicy = db.getChannelVodRecordingPolicyByUserId(stream.user_id, stream.managed_stream_id);
        if (!vodPolicy.recordingEnabled) {
            cleanupTempFile(req.file.path);
            if (db.getActiveVodByStream(streamId)) {
                finalizeVodRecording(streamId).catch(() => {});
            }
            return res.status(403).json({
                error: vodPolicy.forcedDisabled
                    ? 'VOD recording is disabled by admin for this channel'
                    : 'VOD recording is disabled for this channel',
            });
        }

        let rec = activeRecordings.get(streamId);

        if (!rec) {
            // Check DB for an existing active recording for this stream (server may have restarted)
            const existingVod = db.getActiveVodByStream(streamId);
            if (existingVod && fs.existsSync(existingVod.file_path)) {
                rec = {
                    vodId: existingVod.id,
                    filePath: existingVod.file_path,
                    startTime: new Date(existingVod.created_at + 'Z').getTime(),
                    chunkCount: 0,
                    currentSegmentId: segmentId,
                    currentSegmentPath: existingVod.file_path,
                };
                activeRecordings.set(streamId, rec);
            }
        }

        if (!rec) {
            // First chunk — create VOD record and file
            const filename = `vod-${streamId}-${Date.now()}.webm`;
            const filePath = path.resolve(config.vod.path, filename);

            // Write first chunk (contains WebM header)
            fs.copyFileSync(req.file.path, filePath);
            cleanupTempFile(req.file.path);

            const result = db.createVod({
                stream_id: streamId,
                user_id: stream.user_id,
                title: stream.title || 'Stream Recording',
                file_path: filePath,
                file_size: fs.statSync(filePath).size,
                duration_seconds: 0,
            });
            const vodId = result.lastInsertRowid;
            db.run('UPDATE vods SET is_recording = 1 WHERE id = ?', [vodId]);

            // Apply the stream's default VOD visibility (per-slot, else channel).
            db.setVodVisibility(vodId, db.resolveStreamVodVisibility(stream));

            rec = { vodId, filePath, startTime: Date.now(), chunkCount: 1, currentSegmentId: segmentId, currentSegmentPath: filePath };
            activeRecordings.set(streamId, rec);

            console.log(`[VOD] Recording started: stream ${streamId} → vod ${vodId}`);
            return res.json({ vodId, chunkIndex: 0, status: 'created' });
        }

        if (rec.currentSegmentId !== segmentId) {
            if (rec.currentSegmentPath && rec.currentSegmentPath !== rec.filePath) {
                await concatWebmFiles(rec.filePath, rec.currentSegmentPath);
            }
            rec.currentSegmentId = segmentId;
            rec.currentSegmentPath = makeSegmentPath(rec.filePath, segmentId);
            fs.copyFileSync(req.file.path, rec.currentSegmentPath);
            cleanupTempFile(req.file.path);
            rec.chunkCount++;
        } else {
            // Append chunk to existing file/segment
            const targetPath = rec.currentSegmentPath || rec.filePath;
            const chunkData = fs.readFileSync(req.file.path);
            fs.appendFileSync(targetPath, chunkData);
            cleanupTempFile(req.file.path);
            rec.chunkCount++;
        }

        // Update file size and duration estimate in DB
        const stat = { size: getFileSizeSafe(rec.filePath) + (rec.currentSegmentPath && rec.currentSegmentPath !== rec.filePath ? getFileSizeSafe(rec.currentSegmentPath) : 0) };
        const elapsed = Math.round((Date.now() - rec.startTime) / 1000);
        db.run('UPDATE vods SET file_size = ?, duration_seconds = ? WHERE id = ?',
            [stat.size, elapsed, rec.vodId]);

        // Create seekable copy for live DVR (every 2 chunks ≈ ~60s, skip first few)
        if (rec.chunkCount >= 2 && rec.chunkCount % 2 === 0) {
            remuxForLiveSeeking(rec.filePath).catch(() => {});
        }

        res.json({ vodId: rec.vodId, chunkIndex: rec.chunkCount, status: 'appended' });
    } catch (err) {
        console.error('[VOD] Chunk upload error:', err.message);
        if (req.file) cleanupTempFile(req.file.path);
        res.status(500).json({ error: 'Failed to save chunk' });
    }
});

/**
 * Finalize a VOD recording — remux for seeking, update duration, mark complete.
 */
router.post('/stream/:streamId/finalize', requireAuth, async (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const stream = db.getStreamById(streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }

        const vodPolicy = db.getChannelVodRecordingPolicyByUserId(stream.user_id, stream.managed_stream_id);
        if (!vodPolicy.recordingEnabled && !db.getActiveVodByStream(streamId)) {
            return res.status(404).json({ error: 'No active recording for this stream' });
        }

        const result = await finalizeVodRecording(streamId);
        if (!result) return res.status(404).json({ error: 'No active recording for this stream' });

        res.json({ vod: result });
    } catch (err) {
        console.error('[VOD] Finalize error:', err.message);
        res.status(500).json({ error: 'Failed to finalize VOD' });
    }
});

/**
 * Get the live (in-progress) VOD for a stream.
 */
router.get('/stream/:streamId/live', optionalAuth, (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const vod = db.getActiveVodByStream(streamId);
        if (!vod) return res.status(404).json({ error: 'No active VOD recording' });
        res.json({ vod });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get live VOD' });
    }
});

/**
 * Get live info for a recording-in-progress VOD (duration, file size, seekable state).
 * Polled by the client to update the live VOD player.
 */
router.get('/:id/live-info', optionalAuth, (req, res) => {
    try {
        const vod = db.get('SELECT id, duration_seconds, file_size, is_recording, file_path FROM vods WHERE id = ?', [req.params.id]);
        if (!vod) return res.status(404).json({ error: 'VOD not found' });

        const seekablePath = (vod.file_path || '').replace(/\.webm$/, '.seekable.webm');
        const hasSeekable = fs.existsSync(seekablePath);

        res.json({
            id: vod.id,
            duration: vod.duration_seconds || 0,
            fileSize: vod.file_size || 0,
            isRecording: !!vod.is_recording,
            seekable: hasSeekable,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get live info' });
    }
});

/**
 * Finalize a VOD recording: remux for proper seeking, probe duration, update DB.
 * Called automatically on stream end or by the client.
 * Guarded against double-invocation via _finalizingStreams Set.
 */
const _finalizingStreams = new Set();

async function finalizeVodRecording(streamId) {
    // Prevent double finalization (exit handler + POST /finalize race)
    if (_finalizingStreams.has(streamId)) {
        return null;
    }
    // If the recorder is still actively recording this stream, DON'T finalize the open,
    // still-growing file (that locks in a truncated duration). Stop it gracefully instead
    // — its ffmpeg exit handler will finalize the fully-flushed file.
    try {
        const recorder = require('./recorder');
        if (recorder.isActivelyRecording && recorder.isActivelyRecording(streamId)) {
            console.log(`[VOD] finalize requested for stream ${streamId} while still recording — stopping gracefully first`);
            recorder.stopRecording(streamId);
            return null;
        }
    } catch { /* proceed to finalize */ }
    _finalizingStreams.add(streamId);

    try {
        return await _doFinalize(streamId);
    } finally {
        _finalizingStreams.delete(streamId);
    }
}

function isFinalizingStream(streamId) {
    return _finalizingStreams.has(streamId);
}

// Re-encode the lossless master into the served WebM format. Heavy (a real transcode),
// so it only runs on the recovery path when the primary webm came out truncated.
function rebuildWebmFromMaster(masterPath, webmPath) {
    return new Promise((resolve) => {
        const tmp = webmPath + '.recover.webm';
        const args = ['-y', '-i', masterPath,
            '-c:v', 'libvpx', '-b:v', '1500k', '-crf', '20', '-deadline', 'good', '-cpu-used', '2',
            '-force_key_frames', 'expr:gte(t,n_forced*2)', '-g', '240',
            '-c:a', 'libvorbis', '-b:a', '128k', '-f', 'webm', tmp];
        let ff;
        try { ff = spawn('ffmpeg', args, { stdio: 'ignore' }); } catch { return resolve(false); }
        const to = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, 45 * 60 * 1000);
        ff.on('close', (code) => {
            clearTimeout(to);
            try {
                if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 1024) {
                    fs.renameSync(tmp, webmPath);
                    return resolve(true);
                }
            } catch { /* fall through */ }
            try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* */ }
            resolve(false);
        });
        ff.on('error', () => { clearTimeout(to); try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* */ } resolve(false); });
    });
}

async function _doFinalize(streamId) {
    let rec = activeRecordings.get(streamId);
    let vodId, filePath, startTime;

    if (rec) {
        vodId = rec.vodId;
        filePath = rec.filePath;
        startTime = rec.startTime;
        activeRecordings.delete(streamId);
    } else {
        // Fallback: find from DB (server may have restarted)
        const vod = db.getActiveVodByStream(streamId);
        if (!vod) return null;
        vodId = vod.id;
        filePath = vod.file_path;
        startTime = new Date(vod.created_at + 'Z').getTime();
    }

    if (!filePath || !fs.existsSync(filePath)) {
        db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
        return db.getVodById(vodId);
    }

    if (rec?.currentSegmentPath && rec.currentSegmentPath !== filePath) {
        await concatWebmFiles(filePath, rec.currentSegmentPath);
    }
    await mergePendingSegments(filePath);

    // Remux for proper seeking support (fast copy-mode, no re-encode)
    await remuxForSeeking(filePath);

    // Clean up the live seekable copy (no longer needed after final remux)
    cleanupSeekableFile(filePath);

    // Probe actual duration with ffprobe
    const wallClockSeconds = Math.round((Date.now() - startTime) / 1000);
    let durationSeconds = wallClockSeconds;
    let probeFormatJson = JSON.stringify({});
    try {
        const probeInfo = await probeVodInfo(filePath);
        if (probeInfo.duration > 0) {
            // Guard against a corrupt/inflated container duration. The real footage can
            // never be meaningfully longer than the wall-clock time spent recording, so a
            // probe far beyond that means a broken header (e.g. a wall-clock gap or an
            // aborted muxer). Store the wall-clock value instead so the DB duration — which
            // the player clamps to — reflects actual playable length, not a phantom timeline
            // that would let the scrubber seek into a permanent black screen.
            if (wallClockSeconds > 0 && probeInfo.duration > wallClockSeconds * 1.5 + 30) {
                console.warn(`[VOD] vod ${vodId}: probed duration ${probeInfo.duration}s >> wall-clock ${wallClockSeconds}s — using wall-clock (inflated/corrupt container)`);
                durationSeconds = wallClockSeconds;
            } else {
                durationSeconds = probeInfo.duration;
            }
        }
        probeFormatJson = JSON.stringify(probeInfo.format || {});
    } catch (probeErr) {
        console.warn(`[VOD] ffprobe failed for vod ${vodId}:`, probeErr.message);
    }

    // ── Recover from the lossless master if the served webm came out truncated ──
    // (e.g. force-kill during trailer flush, or a container hiccup). This is the fix for
    // "VOD cut off short": the master holds the full recording, so we rebuild the webm.
    const masterPath = (rec && rec.masterFilePath)
        || (db.getVodById(vodId) || {}).master_file_path
        || filePath.replace(/\.webm$/, '.master.mkv');
    let masterDur = 0;
    if (masterPath && fs.existsSync(masterPath)) {
        try { const mi = await probeVodInfo(masterPath); masterDur = mi.duration || 0; } catch { /* */ }
        if (masterDur > 0 && masterDur > durationSeconds + 15 && masterDur > durationSeconds * 1.15) {
            console.warn(`[VOD] vod ${vodId}: webm ${durationSeconds}s is short vs master ${masterDur}s — rebuilding webm from master`);
            const ok = await rebuildWebmFromMaster(masterPath, filePath);
            if (ok) {
                try { await remuxForSeeking(filePath); cleanupSeekableFile(filePath); } catch { /* */ }
                try {
                    const mi2 = await probeVodInfo(filePath);
                    if (mi2.duration > durationSeconds) { durationSeconds = mi2.duration; probeFormatJson = JSON.stringify(mi2.format || {}); }
                } catch { /* */ }
                console.log(`[VOD] vod ${vodId}: recovered from master → ${durationSeconds}s`);
            } else {
                console.warn(`[VOD] vod ${vodId}: master recovery failed — keeping master for manual recovery`);
            }
        }
    }

    if (rec?._ffmpegCorrupted) {
        console.warn(`[VOD] Finalized VOD ${vodId} (stream ${streamId}) marked corrupt by FFmpeg diagnostics; quarantining without deletion`);
        db.run(`UPDATE vods SET is_recording = 0, health_status = ?, health_issues_json = ?, probe_duration_seconds = ?, probe_format_json = ?, last_health_scan_at = datetime('now'), quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
            ['corrupt', JSON.stringify(['ffmpeg-corruption-detected']), durationSeconds > 0 ? durationSeconds : 0, JSON.stringify({ format: 'unknown' }), vodId]);
        return db.getVodById(vodId);
    }

    // Short recordings should be quarantined for review instead of deleted.
    const MIN_VOD_SECONDS = 10;
    if (durationSeconds < MIN_VOD_SECONDS) {
        console.log(`[VOD] Quarantining short vod ${vodId} (stream ${streamId}): duration ${durationSeconds}s`);
        db.run(`UPDATE vods SET is_recording = 0, health_status = ?, health_issues_json = ?, probe_duration_seconds = ?, probe_format_json = ?, last_health_scan_at = datetime('now'), quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
            ['needs_review', JSON.stringify(['short_duration']), durationSeconds > 0 ? durationSeconds : 0, JSON.stringify({ format: 'unknown' }), vodId]);
        return db.getVodById(vodId);
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        console.error(`[VOD] Failed to stat finalized VOD ${vodId}:`, err.message);
        db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
        return null;
    }
    db.run('UPDATE vods SET is_recording = 0, duration_seconds = ?, file_size = ?, probe_duration_seconds = ?, probe_format_json = ?, health_status = ? WHERE id = ?',
        [durationSeconds, stat.size, durationSeconds, probeFormatJson, 'ok', vodId]);

    console.log(`[VOD] Finalized: vod ${vodId} (stream ${streamId}), ${durationSeconds}s, ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

    // The lossless .master.mkv archive is only a fallback. Delete it ONLY once the served
    // webm is confirmed complete (its duration matches the master within tolerance) — so a
    // truncated webm never destroys the one good copy. If the webm is still short (recovery
    // failed), KEEP the master so the footage can be recovered manually/by the health scan.
    try {
        const webmComplete = !masterDur || durationSeconds >= masterDur - 8;
        if (fs.existsSync(masterPath)) {
            if (webmComplete) {
                fs.unlinkSync(masterPath);
                console.log(`[VOD] Removed master archive for vod ${vodId} (${path.basename(masterPath)})`);
                db.run('UPDATE vods SET master_file_path = NULL WHERE id = ?', [vodId]);
            } else {
                console.warn(`[VOD] vod ${vodId}: KEEPING master (webm ${durationSeconds}s still < master ${masterDur}s)`);
            }
        } else {
            db.run('UPDATE vods SET master_file_path = NULL WHERE id = ?', [vodId]);
        }
    } catch (e) {
        console.warn(`[VOD] Master cleanup failed for vod ${vodId}:`, e.message);
    }

    // Generate thumbnail in background
    const thumbService = require('../thumbnails/thumbnail-service');
    thumbService.generateVodThumbnail(vodId, filePath).catch(err => {
        console.warn(`[VOD] Thumbnail generation failed for vod ${vodId}:`, err.message);
    });

    // Kick off transcription + AI timeline/overview right away (both fire-and-forget and
    // internally guarded against overlapping with the backfill poller). This is the
    // "process the VOD after the stream ends" step — it guarantees the timeline brackets
    // the VOD (start + end, +mid for >5min) and picks active frames to keep cost down.
    try {
        const ai = require('../ai/ai-analysis');
        const finalVod = db.getVodById(vodId);
        if (finalVod) {
            if (ai.transcriptionEnabled && ai.transcriptionEnabled()) ai.generateVodTranscript(finalVod).catch(() => {});
            if (ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()) ai.generateVodOverview(finalVod).catch(() => {});
        }
    } catch { /* poller will pick it up */ }

    return db.getVodById(vodId);
}

function cleanupTempFile(filePath) {
    try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
}

// Export finalizeVodRecording so stale-stream cleanup can use it
router.finalizeVodRecording = finalizeVodRecording;
router.activeRecordings = activeRecordings;
router.remuxForLiveSeeking = remuxForLiveSeeking;

// ══════════════════════════════════════════════════════════════
//  VOD ROUTES
// ══════════════════════════════════════════════════════════════

// ── List Public VODs (+ own private VODs when logged in) ────
router.get('/', optionalAuth, (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const usernameFilter = String(req.query.username || '').trim();
        const normalizedUsername = usernameFilter || null;
        const sort = req.query.sort === 'oldest' ? 'oldest' : 'newest';

        let vods = [];
        let myPrivate = [];

        if (req.user) {
            const includeMyPrivate = !normalizedUsername
                || req.user.username?.toLowerCase() === normalizedUsername.toLowerCase();
            if (includeMyPrivate) {
                myPrivate = (db.getVodsByUser(req.user.id, true) || []).filter(v => !v.is_public);
            }
        }

        const publicCount = db.countPublicVods({ username: normalizedUsername });
        const total = publicCount + myPrivate.length;

        if (myPrivate.length > 0) {
            const publicFetchCount = Math.min(Math.max(offset + limit, limit), publicCount);
            const publicVods = db.getPublicVods(publicFetchCount, 0, { username: normalizedUsername, sort });
            const dir = sort === 'oldest' ? 1 : -1;
            vods = [...publicVods, ...myPrivate]
                .sort((a, b) => dir * (new Date(a.created_at) - new Date(b.created_at)))
                .slice(offset, offset + limit);
        } else {
            vods = db.getPublicVods(limit, offset, { username: normalizedUsername, sort });
        }

        res.json({
            vods,
            total,
            limit,
            offset,
            hasMore: offset + vods.length < total,
            streamers: db.listVodStreamers(req.user?.id || null),
            activeFilter: normalizedUsername,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list VODs' });
    }
});

// ── List My VODs ─────────────────────────────────────────────
router.get('/mine', requireAuth, (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '0', 10), 0), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const allVods = db.getVodsByUser(req.user.id, true);
        const total = allVods.length;
        const vods = limit > 0 ? allVods.slice(offset, offset + limit) : allVods;
        res.json({ vods, total, limit: limit || total, offset });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list VODs' });
    }
});

// ── Bulk Delete Old VODs/Clips ──────────────────────────────
router.post('/bulk-delete-old', requireAuth, async (req, res) => {
    try {
        const olderThanDays = parseInt(req.body?.olderThanDays, 10);
        const deleteVods = req.body?.deleteVods !== false;
        const deleteClips = req.body?.deleteClips !== false;
        const action = ['delete', 'public', 'unlisted', 'private'].includes(req.body?.action) ? req.body.action : 'delete';

        if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
            return res.status(400).json({ error: 'olderThanDays must be a positive integer' });
        }
        if (!deleteVods && !deleteClips) {
            return res.status(400).json({ error: 'Select at least one media type to delete' });
        }

        const daysModifier = `-${olderThanDays} days`;

        const vodsToDelete = deleteVods
            ? db.all(
                `SELECT id, file_path, storage_provider, storage_key
                 FROM vods
                 WHERE user_id = ?
                   AND COALESCE(is_recording, 0) = 0
                   AND datetime(created_at) <= datetime('now', ?)`,
                [req.user.id, daysModifier]
            )
            : [];

        const clipsToDelete = deleteClips
            ? db.all(
                `SELECT DISTINCT c.id, c.file_path, c.storage_provider, c.storage_key
                 FROM clips c
                 LEFT JOIN streams s ON c.stream_id = s.id
                 LEFT JOIN vods v ON c.vod_id = v.id
                 WHERE datetime(c.created_at) <= datetime('now', ?)
                   AND (
                     c.user_id = ?
                     OR s.user_id = ?
                     OR v.user_id = ?
                   )`,
                [daysModifier, req.user.id, req.user.id, req.user.id]
            )
            : [];

        // Visibility action (private/unlisted/public) — no file deletion, just flip visibility.
        if (action !== 'delete') {
            for (const v of vodsToDelete) db.setVodVisibility(v.id, action);
            for (const c of clipsToDelete) db.setClipVisibility(c.id, action);
            return res.json({ olderThanDays, action, updated: { vods: vodsToDelete.length, clips: clipsToDelete.length } });
        }

        let vodFilesDeleted = 0;
        let clipFilesDeleted = 0;
        let fileDeleteErrors = 0;

        for (const vod of vodsToDelete) {
            try {
                if (!vod.file_path) continue;
                await require('./vod-storage').deleteVodObjects(vod);
                vodFilesDeleted++;
                cleanupSeekableFile(vod.file_path);
            } catch {
                fileDeleteErrors++;
            }
        }

        for (const clip of clipsToDelete) {
            try {
                if (!clip.file_path) continue;
                if (fs.existsSync(clip.file_path)) {
                    fs.unlinkSync(clip.file_path);
                    clipFilesDeleted++;
                }
                // Also remove any offloaded B2/R2 object.
                if (clip.storage_provider && clip.storage_provider !== 'local' && clip.storage_key) {
                    await require('./vod-storage').deleteVodObjects(clip);
                }
            } catch {
                fileDeleteErrors++;
            }
        }

        if (vodsToDelete.length > 0) {
            const vodIds = vodsToDelete.map((v) => v.id);
            const vodMarks = vodIds.map(() => '?').join(',');
            db.run(`DELETE FROM vods WHERE id IN (${vodMarks})`, vodIds);
            db.run(`DELETE FROM content_views WHERE content_type = 'vod' AND content_id IN (${vodMarks})`, vodIds);
            db.run(`DELETE FROM comments WHERE content_type = 'vod' AND content_id IN (${vodMarks})`, vodIds);
        }

        if (clipsToDelete.length > 0) {
            const clipIds = clipsToDelete.map((c) => c.id);
            const clipMarks = clipIds.map(() => '?').join(',');
            db.run(`DELETE FROM clips WHERE id IN (${clipMarks})`, clipIds);
            db.run(`DELETE FROM content_views WHERE content_type = 'clip' AND content_id IN (${clipMarks})`, clipIds);
            db.run(`DELETE FROM comments WHERE content_type = 'clip' AND content_id IN (${clipMarks})`, clipIds);
        }

        res.json({
            olderThanDays,
            deleted: {
                vods: vodsToDelete.length,
                clips: clipsToDelete.length,
            },
            filesDeleted: {
                vods: vodFilesDeleted,
                clips: clipFilesDeleted,
            },
            fileDeleteErrors,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to bulk delete old media' });
    }
});

// ── Get VOD Details ──────────────────────────────────────────
// AI "memory" timeline for a VOD (from its source live stream). Timestamps are
// seconds into the stream ≈ seconds into a full VOD.
router.get('/:id/memories', optionalAuth, (req, res) => {
    try {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'VOD not found' });
        const vod = db.getVodById(req.params.id);
        if (!vod || !vod.stream_id) return res.json({ memories: [] });
        const memories = (db.getStreamMemories(vod.stream_id) || []).map(m => ({
            offset_seconds: m.offset_seconds,
            description: m.description,
            tags: m.tags ? (() => { try { return JSON.parse(m.tags); } catch { return []; } })() : [],
        }));
        res.json({ memories });
    } catch {
        res.status(500).json({ error: 'Failed to load AI timeline' });
    }
});

router.get('/:id', optionalAuth, async (req, res) => {
    try {
        // Skip non-numeric IDs (avoid matching 'mine', 'file', etc.)
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'VOD not found' });

        let vod = db.getVodById(req.params.id);
        if (!vod) return res.status(404).json({ error: 'VOD not found' });

        if (!vod.is_recording && (!vod.duration_seconds || vod.duration_seconds <= 0) && vod.file_path && fs.existsSync(vod.file_path)) {
            const duration = await probeVodDuration(vod.file_path);
            if (duration > 0) {
                const fileSize = getFileSizeSafe(vod.file_path);
                db.run('UPDATE vods SET duration_seconds = ?, file_size = ? WHERE id = ?', [duration, fileSize, vod.id]);
                vod.duration_seconds = duration;
                vod.file_size = fileSize;
            }
        }

        // Enrich with stream details for chat replay
        if (vod.stream_id) {
            const stream = db.getStreamById(vod.stream_id);
            if (stream) {
                vod.stream_started_at = stream.started_at;
                vod.stream_ended_at = stream.ended_at;
                vod.stream_category = stream.category;
                vod.stream_peak_viewers = stream.peak_viewers;
            }
        }

        // Private VOD — allow page load but restrict video access. Unlisted VODs
        // (is_public=0 but visibility='unlisted') stay reachable by direct link.
        const isOwnerOrAdmin = req.user && (req.user.id === vod.user_id || req.user.role === 'admin');
        const isPrivate = (vod.visibility ? vod.visibility === 'private' : !vod.is_public);
        if (isPrivate && !isOwnerOrAdmin) {
            // Return limited data so clips section is still accessible
            const clips = vod.stream_id ? db.getClipsByStream(vod.stream_id) : [];
            return res.json({
                vod: {
                    id: vod.id,
                    title: vod.title,
                    username: vod.username,
                    display_name: vod.display_name,
                    avatar_url: vod.avatar_url,
                    is_public: 0,
                    is_private: true,
                    stream_id: vod.stream_id,
                    stream_title: vod.stream_title,
                    stream_protocol: vod.stream_protocol,
                    created_at: vod.created_at,
                    user_id: vod.user_id,
                },
                clips,
            });
        }

        // Track unique view by IP
        const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
        const inserted = db.run(
            'INSERT OR IGNORE INTO content_views (content_type, content_id, ip) VALUES (?, ?, ?)',
            ['vod', vod.id, ip]
        );
        if (inserted.changes > 0) {
            // New unique view — update count from actual unique rows
            const count = db.get('SELECT COUNT(*) as c FROM content_views WHERE content_type = ? AND content_id = ?', ['vod', vod.id]);
            db.run('UPDATE vods SET view_count = ? WHERE id = ?', [count.c, vod.id]);
            vod.view_count = count.c;
        }

        // Get clips for this VOD's stream
        let clips = [];
        if (vod.stream_id) {
            clips = db.getClipsByStream(vod.stream_id);
        }

        // Get comment count
        vod.comment_count = db.getCommentCount('vod', vod.id);

        res.json({ vod, clips });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get VOD' });
    }
});

// ── Update VOD ───────────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
    try {
        const vod = db.get('SELECT * FROM vods WHERE id = ?', [req.params.id]);
        if (!vod) return res.status(404).json({ error: 'VOD not found' });
        // Owner's content is protected from admins: only the VOD owner, or a
        // moderator allowed to act on that owner's content, may edit it.
        if (vod.user_id !== req.user.id &&
            !permissions.canModerateContentOwner(req.user, db.getUserById(vod.user_id))) {
            return res.status(403).json({ error: 'Not authorized to edit this VOD' });
        }

        const { title, description, is_public, visibility } = req.body;
        const updates = [];
        const params = [];

        if (title !== undefined) { updates.push('title = ?'); params.push(title); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (updates.length > 0) {
            params.push(req.params.id);
            db.run(`UPDATE vods SET ${updates.join(', ')} WHERE id = ?`, params);
        }
        // Visibility: prefer the explicit 3-state value; fall back to legacy is_public.
        if (visibility !== undefined) {
            db.setVodVisibility(req.params.id, visibility);
        } else if (is_public !== undefined) {
            db.setVodVisibility(req.params.id, is_public ? 'public' : 'private');
        }

        const updated = db.getVodById(req.params.id);
        res.json({ vod: updated });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update VOD' });
    }
});

// ── Bulk action on VODs (owner's own, or any for admins): delete | public | unlisted | private ──
router.post('/bulk', requireAuth, async (req, res) => {
    try {
        const { ids, action } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No ids provided' });
        if (!['delete', 'public', 'unlisted', 'private'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
        let done = 0, skipped = 0;
        for (const rawId of ids.slice(0, 500)) {
            const id = parseInt(rawId, 10);
            if (!id) { skipped++; continue; }
            const vod = db.get('SELECT * FROM vods WHERE id = ?', [id]);
            if (!vod) { skipped++; continue; }
            let owns = vod.user_id === req.user.id;
            if (!owns && vod.stream_id) { const s = db.getStreamById(vod.stream_id); if (s && s.user_id === req.user.id) owns = true; }
            // admins may act on others' — but never an owner-rank user's content.
            if (!owns) owns = permissions.canModerateContentOwner(req.user, db.getUserById(vod.user_id));
            if (!owns) { skipped++; continue; }
            if (action === 'delete') {
                if (vod.file_path) { require('./vod-storage').deleteVodObjects(vod).catch(() => {}); cleanupSeekableFile(vod.file_path); }
                db.run('DELETE FROM vods WHERE id = ?', [id]);
            } else {
                db.setVodVisibility(id, action);
            }
            done++;
        }
        res.json({ done, skipped });
    } catch (err) {
        res.status(500).json({ error: 'Bulk action failed' });
    }
});

// ── Delete VOD ───────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
    try {
        const vod = db.get('SELECT * FROM vods WHERE id = ?', [req.params.id]);
        if (!vod) return res.status(404).json({ error: 'VOD not found' });
        // Allow VOD owner or stream owner; admins may delete others' EXCEPT an
        // owner-rank user's content (protected from admins).
        let canDelete = (vod.user_id === req.user.id);
        if (!canDelete && vod.stream_id) {
            const stream = db.getStreamById(vod.stream_id);
            if (stream && stream.user_id === req.user.id) canDelete = true;
        }
        if (!canDelete) canDelete = permissions.canModerateContentOwner(req.user, db.getUserById(vod.user_id));
        if (!canDelete) {
            return res.status(403).json({ error: 'Not authorized to delete this VOD' });
        }

        // Delete media everywhere (local + B2 + R2)
        if (vod.file_path) {
            require('./vod-storage').deleteVodObjects(vod).catch((err) => {
                console.warn(`[VOD] Object cleanup failed for VOD ${vod.id}:`, err.message);
            });
            cleanupSeekableFile(vod.file_path);
        }

        db.run('DELETE FROM vods WHERE id = ?', [req.params.id]);
        res.json({ message: 'VOD deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete VOD' });
    }
});

// ── Publish VOD ──────────────────────────────────────────────
router.post('/:id/publish', requireAuth, (req, res) => {
    try {
        const vod = db.get('SELECT * FROM vods WHERE id = ?', [req.params.id]);
        if (!vod) return res.status(404).json({ error: 'VOD not found' });
        if (vod.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your VOD' });
        }

        db.run('UPDATE vods SET is_public = 1 WHERE id = ?', [req.params.id]);
        res.json({ message: 'VOD published', is_public: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to publish VOD' });
    }
});

// ── Serve VOD/Clip files ─────────────────────────────────────
router.get('/file/:filename', optionalAuth, async (req, res) => {
    try {
        const vodStorage = require('./vod-storage');
        const filename = path.basename(req.params.filename); // Prevent directory traversal
        const vodPath = path.resolve(config.vod.path, filename);
        const clipPath = path.resolve(config.vod.clipsPath, filename);

        let filePath = null;
        let mediaRecord = null;
        let mediaType = null;

        // Resolve the DB record by basename, NOT by exact file_path: legacy rows carry
        // absolute paths from the old server, so an exact match would miss even files that
        // are present locally. `%/filename` matches any directory prefix.
        const likeName = `%/${filename}`;
        const vodRow = db.get(
            'SELECT id, user_id, is_public, is_recording, file_path, storage_provider, storage_key FROM vods WHERE file_path = ? OR file_path LIKE ?',
            [vodPath, likeName]
        );
        const clipRow = vodRow ? null : db.get(
            `SELECT c.id, c.user_id, c.is_public, c.file_path, c.storage_provider, c.storage_key,
                    s.user_id AS stream_owner_id, v.user_id AS vod_owner_id
             FROM clips c
             LEFT JOIN streams s ON c.stream_id = s.id
             LEFT JOIN vods v ON c.vod_id = v.id
             WHERE c.file_path = ? OR c.file_path LIKE ?`,
            [clipPath, likeName]
        );

        if (vodRow) {
            mediaType = 'vod';
            mediaRecord = vodRow;
            if (fs.existsSync(vodPath)) filePath = vodPath;
        } else if (clipRow) {
            mediaType = 'clip';
            mediaRecord = clipRow;
            if (fs.existsSync(clipPath)) filePath = clipPath;
        } else {
            return res.status(404).json({ error: 'File not found' });
        }

        // No local file and not on remote storage → genuinely gone.
        if (!filePath && !vodStorage.isRemote(mediaRecord)) {
            return res.status(404).json({ error: 'File not found' });
        }

        const isAdmin = req.user?.role === 'admin';
        const isOwner = req.user && req.user.id === mediaRecord.user_id;
        const canAccess = mediaType === 'vod'
            ? !!mediaRecord.is_public || isOwner || isAdmin
            : !!mediaRecord.is_public
                || isOwner
                || isAdmin
                || (req.user && (req.user.id === mediaRecord.stream_owner_id || req.user.id === mediaRecord.vod_owner_id));

        if (!canAccess) {
            return res.status(403).json({ error: 'This media is private' });
        }

        // Track last access time for storage tier decisions
        if (mediaType === 'vod' && mediaRecord.id) {
            try { db.run("UPDATE vods SET last_accessed_at = datetime('now') WHERE id = ?", [mediaRecord.id]); } catch {}
        }

        // Offloaded VOD or clip (B2/R2) — redirect to a presigned object-store URL.
        // resolvePlayback presigns storage_key generically, so clips tier exactly like VODs.
        // Range requests are handled natively by the object store.
        if (!filePath && vodStorage.isRemote(mediaRecord)) {
            const plan = await vodStorage.resolvePlayback(mediaRecord);
            if (plan?.kind === 'redirect') {
                res.set('Cache-Control', 'private, max-age=0');
                return res.redirect(302, plan.url);
            }
            if (plan?.kind === 'file') {
                filePath = plan.path;
            } else {
                return res.status(404).json({ error: 'Media file unavailable' });
            }
        }

        // For live recordings, serve the seekable copy if it exists
        const seekablePath = filePath.replace(/\.webm$/, '.seekable.webm');
        const isLiveSeekable = fs.existsSync(seekablePath);
        if (isLiveSeekable) {
            filePath = seekablePath;
        }

        // Support range requests for video seeking
        const stat = fs.statSync(filePath);
        const range = req.headers.range;
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };
        const contentType = mimeTypes[ext] || 'video/webm';

        // No-cache for live recordings so the player can refresh
        const cacheHeaders = isLiveSeekable
            ? { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
            : {};

        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunkSize = end - start + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': contentType,
                ...cacheHeaders,
            });
            fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                ...cacheHeaders,
            });
            fs.createReadStream(filePath).pipe(res);
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to serve file' });
    }
});

// ══════════════════════════════════════════════════════════════
//  VOD UPLOAD (from browser MediaRecorder)
// ══════════════════════════════════════════════════════════════

router.post('/upload', requireAuth, vodUpload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded' });
        }

        const { stream_id, title } = req.body;

        // Verify ownership of stream
        if (stream_id) {
            const stream = db.getStreamById(stream_id);
            if (stream && stream.user_id !== req.user.id && req.user.role !== 'admin') {
                // Remove uploaded file
                fs.unlinkSync(req.file.path);
                return res.status(403).json({ error: 'Not your stream' });
            }
        }

        // Get file stats
        const stat = fs.statSync(req.file.path);

        // Remux WebM for proper seeking support (adds Cues, fixes duration)
        // This is fast (copy-mode, no re-encoding) and makes a huge difference
        await remuxForSeeking(req.file.path);
        // Re-stat after remux (file size may change slightly)
        const finalStat = fs.statSync(req.file.path);

        // Get duration with ffprobe (awaited so VOD has correct duration)
        let durationSeconds = 0;
        try {
            durationSeconds = await new Promise((resolve) => {
                const probe = spawn('ffprobe', [
                    '-v', 'quiet', '-print_format', 'json', '-show_format',
                    req.file.path,
                ]);
                let probeData = '';
                probe.stdout.on('data', d => probeData += d);
                probe.on('close', () => {
                    try {
                        const info = JSON.parse(probeData);
                        resolve(Math.round(parseFloat(info.format?.duration || '0')));
                    } catch { resolve(0); }
                });
                probe.on('error', () => resolve(0));
                // Timeout after 10s in case ffprobe hangs
                setTimeout(() => { try { probe.kill(); } catch {} resolve(0); }, 10000);
            });
        } catch { /* durationSeconds stays 0 */ }

        // If ffprobe didn't get duration, estimate from stream timing
        if (!durationSeconds && stream_id) {
            const stream = db.getStreamById(stream_id);
            if (stream && stream.started_at) {
                const startMs = new Date(stream.started_at + 'Z').getTime();
                const endMs = stream.ended_at ? new Date(stream.ended_at + 'Z').getTime() : Date.now();
                durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
            }
        }

        // Create VOD entry (apply the stream's default visibility: per-slot, else channel)
        const uStream = stream_id ? db.getStreamById(parseInt(stream_id)) : null;
        const result = db.createVod({
            stream_id: stream_id ? parseInt(stream_id) : null,
            user_id: req.user.id,
            title: title || 'Stream Recording',
            description: '',
            file_path: req.file.path,
            file_size: finalStat.size,
            duration_seconds: durationSeconds,
        });
        db.setVodVisibility(result.lastInsertRowid, uStream ? db.resolveStreamVodVisibility(uStream) : (db.getChannelByUserId(req.user.id)?.default_vod_visibility || 'public'));

        const vod = db.getVodById(result.lastInsertRowid);
        console.log(`[VOD] Uploaded: ${req.file.filename} (${(finalStat.size / 1024 / 1024).toFixed(1)} MB, ${durationSeconds}s) for user ${req.user.username}`);

        // Generate thumbnail in background (non-blocking)
        thumbService.generateVodThumbnail(vod.id, req.file.path).then(thumbUrl => {
            if (thumbUrl) console.log(`[VOD] Thumbnail generated: ${thumbUrl}`);
        }).catch(() => {});

        res.status(201).json({ vod });
    } catch (err) {
        console.error('[VOD] Upload error:', err.message);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Failed to upload VOD' });
    }
});

// ══════════════════════════════════════════════════════════════
//  CLIP ROUTES (mounted under /api/vods but also at /api/clips)
// ══════════════════════════════════════════════════════════════

// Separate multer for clip uploads — more lenient MIME filter because
// MediaRecorder Blobs can arrive with codec-qualified types, empty types,
// or application/octet-stream depending on the browser/platform.
const CLIP_ALLOWED_MIMES = new Set([
    ...Object.keys(VOD_MIME_TO_EXT),
    'application/octet-stream',  // some browsers / Electron builds
    '',                          // empty MIME from Blob() without explicit type
]);
const clipUpload = multer({
    storage: vodStorage,
    limits: { fileSize: config.vod.maxSizeMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const base = baseMediaType(file.mimetype);
        if (CLIP_ALLOWED_MIMES.has(base) || base.startsWith('video/')) cb(null, true);
        else cb(new Error('Only video files are allowed for clips'));
    },
});

// ── Create Clip ──────────────────────────────────────────────
router.post('/clips', requireAuth, clipUpload.single('video'), async (req, res) => {
    try {
        const { vod_id, stream_id, start_time, end_time, title } = req.body;
        const parsedStreamId = stream_id ? parseInt(stream_id, 10) : null;
        const parsedVodId = vod_id ? parseInt(vod_id, 10) : null;
        const { startTime, endTime } = parseClipWindow(req.body);
        // Live clips arrive either as an uploaded MediaRecorder blob (req.file) OR as a
        // JSON body with live:true (server-side cut). Both get the gentler live cooldown.
        const isLiveClip = !!req.file || (req.body.live === true || req.body.live === 'true' || req.body.live === '1');
        const sanitizedTitle = sanitizeClipTitle(title);

        // ── Anti-abuse: account age check ────────────────────
        if (isAccountTooNew(req.user)) {
            if (req.file) cleanupTempFile(req.file.path);
            return res.status(403).json({ error: 'Your account is too new to create clips. Please wait a minute.' });
        }

        // ── Anti-abuse: hourly clip limit ────────────────────
        if (isUserOverHourlyClipLimit(req.user.id)) {
            if (req.file) cleanupTempFile(req.file.path);
            return res.status(429).json({ error: `You've created too many clips this hour (max ${CLIP_MAX_PER_USER_PER_HOUR}). Please try again later.` });
        }

        // ── Anti-abuse: duplicate detection ──────────────────
        const duplicateClip = findExistingDuplicateClip({
            streamId: parsedStreamId,
            vodId: parsedVodId,
            startTime,
            endTime,
        });
        if (duplicateClip) {
            if (req.file) cleanupTempFile(req.file.path);
            return res.status(200).json({
                clip: duplicateClip,
                deduplicated: true,
                message: 'A clip for that moment already exists. Reusing the existing clip.',
            });
        }

        // ── Anti-abuse: per-user/IP cooldown ─────────────────
        if (shouldThrottleClipRequest(req, isLiveClip)) {
            if (req.file) cleanupTempFile(req.file.path);
            const wait = isLiveClip ? 'a few seconds' : '10 seconds';
            return res.status(429).json({ error: `You are clipping too fast. Please wait ${wait} before making another clip.` });
        }

        // Direct clip upload from browser (MediaRecorder clip)
        if (req.file) {
            // Move file to clips directory
            const clipsDir = path.resolve(config.vod.clipsPath);
            if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });
            const clipPath = path.join(clipsDir, req.file.filename);
            fs.renameSync(req.file.path, clipPath);

            // Remux clip: adds seeking support + rebases timestamps if offset
            // (clips from long streams have cluster timestamps hours from zero)
            const remuxOk = await remuxClipFile(clipPath);

            // EBML header validation — first 4 bytes must be 1A 45 DF A3
            try {
                const fd = fs.openSync(clipPath, 'r');
                const hdr = Buffer.alloc(4);
                fs.readSync(fd, hdr, 0, 4, 0);
                fs.closeSync(fd);
                if (hdr[0] !== 0x1A || hdr[1] !== 0x45 || hdr[2] !== 0xDF || hdr[3] !== 0xA3) {
                    console.warn(`[Clips] Corrupt WebM header detected, attempting re-encode: ${req.file.filename}`);
                    // Try to salvage by re-encoding instead of copy-mode remux
                    const salvaged = await new Promise((resolve) => {
                        const tmpPath = clipPath + '.fix.webm';
                        const proc = spawn('ffmpeg', [
                            '-y', '-err_detect', 'ignore_err', '-i', clipPath,
                            '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
                            '-c:a', 'libopus', '-b:a', '128k',
                            tmpPath,
                        ], { stdio: ['ignore', 'ignore', 'pipe'] });
                        let stderr = '';
                        proc.stderr.on('data', d => stderr += d);
                        proc.on('close', (code) => {
                            if (code === 0 && fs.existsSync(tmpPath)) {
                                try { fs.renameSync(tmpPath, clipPath); resolve(true); } catch { resolve(false); }
                            } else {
                                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
                                resolve(false);
                            }
                        });
                        proc.on('error', () => resolve(false));
                        setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
                    });
                    if (!salvaged) {
                        console.error(`[Clips] Could not salvage corrupt clip: ${req.file.filename}`);
                        try { fs.unlinkSync(clipPath); } catch {}
                        return res.status(422).json({ error: 'Clip recording was corrupt and could not be salvaged. Please try again.' });
                    }
                }
            } catch (valErr) {
                console.warn('[Clips] Header validation error:', valErr.message);
            }
            const stat = fs.statSync(clipPath);

            const duration = endTime - startTime;
            // Honor the streamer's per-stream clip settings (streamer = stream owner).
            const liveStream = parsedStreamId ? db.getStreamById(parsedStreamId) : null;
            if (liveStream && !db.isStreamClipRecordingEnabled(liveStream)) {
                try { fs.existsSync(clipPath) && fs.unlinkSync(clipPath); } catch { /* */ }
                return res.status(403).json({ error: 'Clipping is disabled for this stream.' });
            }
            const clipVis = liveStream ? db.resolveStreamClipVisibility(liveStream) : 'public';
            const result = db.createClip({
                stream_id: parsedStreamId,
                user_id: req.user.id,
                title: defaultClipTitle(sanitizedTitle, liveStream?.title),
                file_path: clipPath,
                start_time: startTime,
                end_time: endTime,
                duration_seconds: duration > 0 ? duration : 0,
                description: '',
                is_public: clipVis === 'public' ? 1 : 0,
            });

            const clipId = result.lastInsertRowid;
            try { db.setClipVisibility(clipId, clipVis); } catch { /* */ }
            try { require('./clip-notify').scheduleClipNotify(clipId); } catch { /* */ }
            const clip = db.getClipById(clipId);
            console.log(`[Clips] Direct upload: ${req.file.filename} for user ${req.user.username} (${stat.size} bytes)`);
            // AI overview + local transcript for this clip (fire-and-forget).
            try { require('../ai/ai-analysis').generateClipOverview(clip).catch(() => {}); } catch { /* */ }

            // Notify streamer that someone clipped their stream
            try {
                if (parsedStreamId) {
                    const clipStream = db.getStreamById(parsedStreamId);
                    if (clipStream && clipStream.user_id !== req.user.id) {
                        const { pushNotification, actorInfo } = require('../utils/notify');
                        pushNotification({
                            user_id: clipStream.user_id,
                            type: 'CLIP_CREATED',
                            title: 'New Clip',
                            message: `${req.user.display_name || req.user.username} clipped your stream${sanitizedTitle ? `: ${sanitizedTitle}` : ''}`,
                            url: `https://hobostreamer.com/clip/${clipId}`,
                            ...actorInfo(req.user),
                        });
                    }
                }
            } catch { /* non-critical */ }

            // Generate clip thumbnail in background
            thumbService.generateClipThumbnail(clip.id, clipPath).then(thumbUrl => {
                if (thumbUrl) console.log(`[Clips] Thumbnail generated: ${thumbUrl}`);
            }).catch(err => console.warn(`[Clips] Thumbnail failed for clip ${clip.id}:`, err.message));

            return res.status(201).json({ clip, file: req.file.filename });
        }

        // ══════════════════════════════════════════════════════
        //  LIVE Clip — cut SERVER-SIDE from the stream's active recording
        //  (no client-side MediaRecorder). The browser just asks for a window; the server
        //  cuts it from the growing VOD recording, capped + re-encoded like VOD clips.
        // ══════════════════════════════════════════════════════
        const wantLive = (req.body.live === true || req.body.live === 'true' || req.body.live === '1');
        if (wantLive && parsedStreamId && !parsedVodId) {
            const stream = db.getStreamById(parsedStreamId);
            if (!stream) return res.status(404).json({ error: 'Stream not found' });
            if (!db.isStreamClipRecordingEnabled(stream)) return res.status(403).json({ error: 'Clipping is disabled for this stream.' });
            const rec = db.getActiveVodByStream(parsedStreamId);
            if (!rec || !rec.file_path || !fs.existsSync(rec.file_path)) {
                // No active recording (e.g. it died on a restart). Try to heal it now so the
                // next attempt works, and tell the client it's spinning up so it can retry.
                let starting = false;
                try {
                    const recorder = require('./recorder');
                    if (recorder.isActivelyRecording(parsedStreamId)) {
                        starting = true; // already healing — the file just isn't on disk yet
                    } else if (stream.is_live && typeof recorder.reconcileLiveRecordings === 'function') {
                        recorder.reconcileLiveRecordings();
                        starting = recorder.isActivelyRecording(parsedStreamId);
                    }
                } catch { /* */ }
                return res.status(409).json({
                    error: starting
                        ? 'Recording is starting up — try clipping again in a few seconds.'
                        : 'This stream is not being recorded, so live clips are unavailable.',
                    no_recording: true,
                    recording_starting: starting,
                });
            }
            const maxDur = db.getSetting('max_clip_duration') || 60;
            let dur = parseFloat(req.body.duration);
            if (!Number.isFinite(dur) || dur < 1) dur = 30;
            dur = Math.min(dur, maxDur);
            // Cut the last `dur` seconds of the recording (live edge), or up to the viewer's
            // position `at` if they're DVR-rewound. 1.5s safety margin keeps us inside the
            // bytes ffmpeg has actually flushed to disk.
            const recStartMs = new Date(String(rec.created_at).replace(' ', 'T') + 'Z').getTime();
            let recElapsed = (Date.now() - recStartMs) / 1000;
            if (!Number.isFinite(recElapsed) || recElapsed < 0) recElapsed = dur;
            let clipEnd = parseFloat(req.body.at);
            if (!Number.isFinite(clipEnd) || clipEnd <= 0 || clipEnd > recElapsed) clipEnd = recElapsed;
            clipEnd = Math.max(dur, clipEnd - 1.5);
            const liveStart = Math.max(0, clipEnd - dur);
            const liveDur = Math.min(dur, clipEnd - liveStart);
            if (liveDur < 1) return res.status(400).json({ error: 'Not enough recorded footage yet — try again in a moment.' });

            if (_activeFFmpegJobs >= CLIP_MAX_CONCURRENT_FFMPEG) {
                return res.status(503).json({ error: 'Server is busy processing other clips. Please try again in a few seconds.' });
            }
            const clipsDirL = path.resolve(config.vod.clipsPath);
            if (!fs.existsSync(clipsDirL)) fs.mkdirSync(clipsDirL, { recursive: true });
            const clipFilenameL = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`;
            const clipPathL = path.join(clipsDirL, clipFilenameL);

            _activeFFmpegJobs++;
            let ffErrL = '', ffToL = false;
            const ffL = spawn('ffmpeg', [
                '-y', '-ss', String(liveStart), '-i', rec.file_path, '-t', String(liveDur),
                '-c:v', 'libvpx', '-b:v', '2000k', '-crf', '18', '-deadline', 'realtime', '-cpu-used', '4',
                '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'libopus', '-b:a', '128k',
                '-avoid_negative_ts', 'make_zero', '-f', 'webm', clipPathL,
            ]);
            ffL.stderr?.on('data', d => { ffErrL += d; if (ffErrL.length > 10000) ffErrL = ffErrL.slice(-5000); });
            const toMsL = Math.max(CLIP_FFMPEG_TIMEOUT_MS, Math.round(liveDur) * 2000 + 15000);
            const timerL = setTimeout(() => { ffToL = true; try { ffL.kill('SIGKILL'); } catch {} }, toMsL);
            ffL.on('error', () => {
                _activeFFmpegJobs = Math.max(0, _activeFFmpegJobs - 1); clearTimeout(timerL); cleanupTempFile(clipPathL);
                if (!res.headersSent) res.status(500).json({ error: 'FFmpeg not available' });
            });
            ffL.on('exit', (code) => {
                _activeFFmpegJobs = Math.max(0, _activeFFmpegJobs - 1); clearTimeout(timerL);
                if (ffToL) { cleanupTempFile(clipPathL); if (!res.headersSent) res.status(504).json({ error: 'Clip timed out. Try again.' }); return; }
                if (code !== 0) { cleanupTempFile(clipPathL); console.warn('[Clips] live clip ffmpeg failed:', ffErrL.slice(-400)); if (!res.headersSent) res.status(500).json({ error: 'Failed to create clip' }); return; }
                try { const st = fs.statSync(clipPathL); if (!st.size) { cleanupTempFile(clipPathL); if (!res.headersSent) res.status(500).json({ error: 'Clip extraction produced an empty file' }); return; } }
                catch { cleanupTempFile(clipPathL); if (!res.headersSent) res.status(500).json({ error: 'Failed to verify clip file' }); return; }
                const clipVis = db.resolveStreamClipVisibility(stream);
                const result = db.createClip({
                    vod_id: rec.id, stream_id: parsedStreamId, user_id: req.user.id,
                    title: defaultClipTitle(sanitizedTitle, stream.title),
                    file_path: clipPathL, start_time: liveStart, end_time: liveStart + liveDur,
                    duration_seconds: liveDur, description: '', is_public: clipVis === 'public' ? 1 : 0,
                });
                try { db.setClipVisibility(result.lastInsertRowid, clipVis); } catch { /* */ }
                try { require('./clip-notify').scheduleClipNotify(result.lastInsertRowid); } catch { /* */ }
                const clip = db.getClipById(result.lastInsertRowid);
                console.log(`[Clips] LIVE clip cut server-side: ${clipFilenameL} (stream ${parsedStreamId}, ${liveStart.toFixed(1)}-${(liveStart + liveDur).toFixed(1)}s)`);
                try { require('../ai/ai-analysis').generateClipOverview(clip).catch(() => {}); } catch { /* */ }
                try {
                    if (stream.user_id !== req.user.id) {
                        const { pushNotification, actorInfo } = require('../utils/notify');
                        pushNotification({ user_id: stream.user_id, type: 'CLIP_CREATED', title: 'New Clip', message: `${req.user.display_name || req.user.username} clipped your stream${sanitizedTitle ? `: ${sanitizedTitle}` : ''}`, url: `https://hobostreamer.com/clip/${clip.id}`, ...actorInfo(req.user) });
                    }
                } catch { /* */ }
                thumbService.generateClipThumbnail(clip.id, clipPathL).catch(() => {});
                res.status(201).json({ clip, file: clipFilenameL });
            });
            return;
        }

        // ══════════════════════════════════════════════════════
        //  VOD Clip Extraction (server-side FFmpeg)
        // ══════════════════════════════════════════════════════

        if (start_time === undefined || end_time === undefined) {
            return res.status(400).json({ error: 'start_time and end_time required' });
        }

        // ── Validate time parameters are finite numbers ──────
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
            return res.status(400).json({ error: 'Invalid time values' });
        }
        if (startTime < 0 || endTime < 0) {
            return res.status(400).json({ error: 'Time values cannot be negative' });
        }

        const duration = endTime - startTime;
        const maxClipDuration = db.getSetting('max_clip_duration') || 60;
        if (duration < 1) {
            return res.status(400).json({ error: 'Clip must be at least 1 second' });
        }
        if (duration > maxClipDuration) {
            return res.status(400).json({ error: `Clips are limited to ${maxClipDuration} seconds` });
        }

        if (!parsedVodId || !Number.isFinite(parsedVodId)) {
            return res.status(400).json({ error: 'Valid vod_id is required for VOD clips' });
        }

        // ── Look up VOD and validate ─────────────────────────
        const vod = db.get('SELECT * FROM vods WHERE id = ?', [parsedVodId]);
        if (!vod || !vod.file_path || !fs.existsSync(vod.file_path)) {
            return res.status(404).json({ error: 'VOD not found or file missing' });
        }

        // ── Private VOD check: only owner can clip ───────────
        if (vod.is_private && vod.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Cannot create clips from private videos' });
        }

        // ── Bounds validation: clip must be within VOD duration
        if (vod.duration_seconds && Number.isFinite(vod.duration_seconds)) {
            const vodDur = vod.duration_seconds;
            if (startTime > vodDur + 5) {
                return res.status(400).json({ error: 'Start time exceeds video duration' });
            }
            if (endTime > vodDur + 10) {
                return res.status(400).json({ error: 'End time exceeds video duration' });
            }
        }

        // ── Concurrent FFmpeg limit ──────────────────────────
        if (_activeFFmpegJobs >= CLIP_MAX_CONCURRENT_FFMPEG) {
            return res.status(503).json({ error: 'Server is busy processing other clips. Please try again in a few seconds.' });
        }

        const clipsDir = path.resolve(config.vod.clipsPath);
        if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

        const clipFilename = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`;
        const clipPath = path.join(clipsDir, clipFilename);

        // ── FFmpeg extraction with timeout ───────────────────
        _activeFFmpegJobs++;
        let ffStderr = '';
        let ffTimedOut = false;
        // Re-encode the (short) clip instead of stream-copying. `-ss` before `-i` is a
        // fast seek to the nearest keyframe, and because we re-encode, ffmpeg then decodes
        // to the EXACT requested start — so the clip begins precisely where the user asked
        // with a fresh keyframe at t=0. A `-c copy` cut can only start on a source keyframe,
        // which on these sparsely-keyframed live recordings means an opening of black/frozen
        // frames or a start seconds off from the request.
        const ffmpeg = spawn('ffmpeg', [
            '-y',
            '-ss', String(startTime),
            '-i', vod.file_path,
            '-t', String(duration),
            '-c:v', 'libvpx', '-b:v', '2000k', '-crf', '18',
            '-deadline', 'realtime', '-cpu-used', '4',
            '-force_key_frames', 'expr:gte(t,n_forced*2)',
            '-c:a', 'libopus', '-b:a', '128k',
            '-avoid_negative_ts', 'make_zero',
            '-f', 'webm',
            clipPath,
        ]);
        ffmpeg.stderr?.on('data', d => { ffStderr += d; if (ffStderr.length > 10000) ffStderr = ffStderr.slice(-5000); });

        // Re-encoding needs more headroom than a copy — scale the timeout with clip length.
        const clipTimeoutMs = Math.max(CLIP_FFMPEG_TIMEOUT_MS, Math.round(duration) * 2000 + 15000);
        const ffTimeout = setTimeout(() => {
            ffTimedOut = true;
            try { ffmpeg.kill('SIGKILL'); } catch {}
            console.warn(`[Clips] FFmpeg timed out after ${clipTimeoutMs}ms for VOD ${parsedVodId}`);
        }, clipTimeoutMs);

        ffmpeg.on('error', (err) => {
            _activeFFmpegJobs = Math.max(0, _activeFFmpegJobs - 1);
            clearTimeout(ffTimeout);
            cleanupTempFile(clipPath);
            console.error('[Clips] FFmpeg spawn error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: 'FFmpeg not available' });
        });

        ffmpeg.on('exit', (code) => {
            _activeFFmpegJobs = Math.max(0, _activeFFmpegJobs - 1);
            clearTimeout(ffTimeout);

            if (ffTimedOut) {
                cleanupTempFile(clipPath);
                if (!res.headersSent) return res.status(504).json({ error: 'Clip extraction timed out. Try a shorter clip or try again later.' });
                return;
            }

            if (code !== 0) {
                cleanupTempFile(clipPath);
                console.warn(`[Clips] FFmpeg clip extraction failed (code ${code}):`, ffStderr.slice(-500));
                if (!res.headersSent) return res.status(500).json({ error: 'Failed to create clip' });
                return;
            }

            // ── Output file validation ───────────────────────
            try {
                const stat = fs.statSync(clipPath);
                if (stat.size === 0) {
                    cleanupTempFile(clipPath);
                    if (!res.headersSent) return res.status(500).json({ error: 'Clip extraction produced an empty file' });
                    return;
                }
                if (stat.size > CLIP_MAX_OUTPUT_SIZE_BYTES) {
                    cleanupTempFile(clipPath);
                    console.warn(`[Clips] Output file too large: ${stat.size} bytes for VOD ${parsedVodId}`);
                    if (!res.headersSent) return res.status(500).json({ error: 'Clip file was unexpectedly large. Try a shorter clip.' });
                    return;
                }
            } catch (statErr) {
                cleanupTempFile(clipPath);
                if (!res.headersSent) return res.status(500).json({ error: 'Failed to verify clip file' });
                return;
            }

            const effStreamId = parsedStreamId || vod.stream_id;
            const effStream = effStreamId ? db.getStreamById(effStreamId) : null;
            if (effStream && !db.isStreamClipRecordingEnabled(effStream)) {
                try { fs.existsSync(clipPath) && fs.unlinkSync(clipPath); } catch { /* */ }
                return res.status(403).json({ error: 'Clipping is disabled for this stream.' });
            }
            const clipVis = effStream ? db.resolveStreamClipVisibility(effStream) : 'public';
            const result = db.createClip({
                vod_id: parsedVodId,
                stream_id: effStreamId,
                user_id: req.user.id,
                title: defaultClipTitle(sanitizedTitle, effStream?.title || vod.title),
                file_path: clipPath,
                start_time: startTime,
                end_time: endTime,
                duration_seconds: duration,
                description: '',
                is_public: clipVis === 'public' ? 1 : 0,
            });
            try { db.setClipVisibility(result.lastInsertRowid, clipVis); } catch { /* */ }
            try { require('./clip-notify').scheduleClipNotify(result.lastInsertRowid); } catch { /* */ }

            const clip = db.getClipById(result.lastInsertRowid);
            console.log(`[Clips] VOD clip extracted: ${clipFilename} for user ${req.user.username} (VOD ${parsedVodId}, ${startTime.toFixed(1)}s-${endTime.toFixed(1)}s)`);
            // AI overview + local transcript for this clip (fire-and-forget).
            try { require('../ai/ai-analysis').generateClipOverview(clip).catch(() => {}); } catch { /* */ }

            // Notify streamer that someone clipped their stream
            try {
                const effectiveStreamId = parsedStreamId || vod.stream_id;
                if (effectiveStreamId) {
                    const clipStream = db.getStreamById(effectiveStreamId);
                    if (clipStream && clipStream.user_id !== req.user.id) {
                        const { pushNotification, actorInfo } = require('../utils/notify');
                        pushNotification({
                            user_id: clipStream.user_id,
                            type: 'CLIP_CREATED',
                            title: 'New Clip',
                            message: `${req.user.display_name || req.user.username} clipped your stream${sanitizedTitle ? `: ${sanitizedTitle}` : ''}`,
                            url: `https://hobostreamer.com/clip/${clip.id}`,
                            ...actorInfo(req.user),
                        });
                    }
                }
            } catch { /* non-critical */ }

            // Generate clip thumbnail in background
            thumbService.generateClipThumbnail(clip.id, clipPath).then(thumbUrl => {
                if (thumbUrl) console.log(`[Clips] Thumbnail generated: ${thumbUrl}`);
            }).catch(err => console.warn(`[Clips] Thumbnail failed for clip ${clip.id}:`, err.message));
            res.status(201).json({ clip, file: clipFilename });
        });
    } catch (err) {
        console.error('[Clips] Create error:', err.message);
        res.status(500).json({ error: 'Failed to create clip' });
    }
});

// ── Get Clips for Stream ─────────────────────────────────────
router.get('/clips/stream/:streamId', optionalAuth, (req, res) => {
    try {
        const clips = db.getClipsByStream(req.params.streamId);
        res.json({ clips });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get clips' });
    }
});

// ══════════════════════════════════════════════════════
//  Trim an existing clip down to a final range (server-side)
//  Re-cuts from the stored clip file, replaces it, and shifts
//  the source offsets so the VOD deep-link stays accurate.
// ══════════════════════════════════════════════════════
router.post('/clips/:id/trim', requireAuth, async (req, res) => {
    try {
        const clip = db.getClipById(req.params.id);
        if (!clip) return res.status(404).json({ error: 'Clip not found' });
        if (clip.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'You can only trim your own clips' });
        }
        if (!clip.file_path || !fs.existsSync(clip.file_path)) {
            return res.status(404).json({ error: 'Clip file is missing' });
        }

        const clipDur = clip.duration_seconds || 0;
        let start = parseFloat(req.body.start);
        let end = parseFloat(req.body.end);
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end <= start) {
            return res.status(400).json({ error: 'Invalid trim range' });
        }
        if (clipDur > 0) { start = Math.min(start, clipDur); end = Math.min(end, clipDur); }
        const newDur = end - start;
        if (newDur < 1) {
            return res.status(400).json({ error: 'Trimmed clip must be at least 1 second long' });
        }

        const newTitle = sanitizeClipTitle(req.body.title);

        // Effectively unchanged range → just apply the title (if any), skip re-encode.
        if (start < 0.15 && clipDur > 0 && Math.abs(end - clipDur) < 0.15) {
            if (newTitle) db.run('UPDATE clips SET title = ? WHERE id = ?', [newTitle, clip.id]);
            return res.json({ clip: db.getClipById(clip.id), unchanged: true });
        }

        if (_activeFFmpegJobs >= CLIP_MAX_CONCURRENT_FFMPEG) {
            return res.status(503).json({ error: 'Server is busy processing clips — try again in a moment.' });
        }

        const dir = path.dirname(clip.file_path);
        const outName = `clip-${req.user.id}-${req.params.id}-trim-${process.hrtime.bigint().toString(36)}.webm`;
        const outPath = path.join(dir, outName);

        _activeFFmpegJobs++;
        let ffErr = '', ffTo = false;
        const ff = spawn('ffmpeg', [
            '-y', '-ss', String(start), '-i', clip.file_path, '-t', String(newDur),
            '-c:v', 'libvpx', '-b:v', '2000k', '-crf', '18', '-deadline', 'realtime', '-cpu-used', '4',
            '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'libopus', '-b:a', '128k',
            '-avoid_negative_ts', 'make_zero', '-f', 'webm', outPath,
        ]);
        ff.stderr?.on('data', d => { ffErr += d; if (ffErr.length > 10000) ffErr = ffErr.slice(-5000); });
        const toMs = Math.max(CLIP_FFMPEG_TIMEOUT_MS, Math.round(newDur) * 2000 + 15000);
        const timer = setTimeout(() => { ffTo = true; try { ff.kill('SIGKILL'); } catch {} }, toMs);
        ff.on('error', () => {
            _activeFFmpegJobs = Math.max(0, _activeFFmpegJobs - 1); clearTimeout(timer); cleanupTempFile(outPath);
            if (!res.headersSent) res.status(500).json({ error: 'FFmpeg not available' });
        });
        ff.on('exit', (code) => {
            _activeFFmpegJobs = Math.max(0, _activeFFmpegJobs - 1); clearTimeout(timer);
            if (ffTo) { cleanupTempFile(outPath); if (!res.headersSent) res.status(504).json({ error: 'Trim timed out. Try again.' }); return; }
            if (code !== 0) { cleanupTempFile(outPath); console.warn('[Clips] trim ffmpeg failed:', ffErr.slice(-400)); if (!res.headersSent) res.status(500).json({ error: 'Failed to trim clip' }); return; }
            try { const st = fs.statSync(outPath); if (!st.size) { cleanupTempFile(outPath); if (!res.headersSent) res.status(500).json({ error: 'Trim produced an empty file' }); return; } }
            catch { cleanupTempFile(outPath); if (!res.headersSent) res.status(500).json({ error: 'Failed to verify trimmed clip' }); return; }

            const oldPath = clip.file_path;
            const newStart = (clip.start_time || 0) + start;
            const newEnd = newStart + newDur;
            if (newTitle) {
                db.run('UPDATE clips SET file_path = ?, duration_seconds = ?, start_time = ?, end_time = ?, title = ? WHERE id = ?',
                    [outPath, newDur, newStart, newEnd, newTitle, clip.id]);
            } else {
                db.run('UPDATE clips SET file_path = ?, duration_seconds = ?, start_time = ?, end_time = ? WHERE id = ?',
                    [outPath, newDur, newStart, newEnd, clip.id]);
            }
            try { if (oldPath && oldPath !== outPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch { /* */ }

            const updated = db.getClipById(clip.id);
            console.log(`[Clips] trimmed clip ${clip.id} → ${outName} (${start.toFixed(1)}-${end.toFixed(1)}s of source, new dur ${newDur.toFixed(1)}s)`);
            try { thumbService.generateClipThumbnail(clip.id, outPath).catch(() => {}); } catch { /* */ }
            try { require('../ai/ai-analysis').generateClipOverview(updated).catch(() => {}); } catch { /* */ }
            res.json({ clip: updated, file: outName });
        });
    } catch (err) {
        console.error('[Clips] trim error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to trim clip' });
    }
});

router.isFinalizingStream = isFinalizingStream;
module.exports = router;
