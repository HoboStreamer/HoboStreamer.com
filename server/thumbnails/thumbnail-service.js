/**
 * HoboStreamer — Universal Thumbnail Service
 *
 * Handles thumbnail generation, storage, and serving for:
 *   • Live streams  — periodic frame capture from broadcaster (WebRTC/JSMPEG canvas, RTMP ffmpeg)
 *   • VODs          — extracted via ffmpeg at ~10% into the video (or on upload)
 *   • Clips         — extracted via ffmpeg at the first I-frame
 *
 * Thumbnails are stored as JPEG files in data/thumbnails/ and served via
 * GET /api/thumbnails/:filename. The DB column `thumbnail_url` is updated
 * to hold the relative API path (e.g. "/api/thumbnails/stream-42-1672531200.jpg").
 *
 * Architecture:
 *   Client-side:  Broadcaster periodically captures a frame from <video>/<canvas>
 *                 and POSTs it to /api/thumbnails/live/:streamId (JPEG base64 or blob).
 *   Server-side:  On VOD/clip creation, ffmpeg extracts a frame.
 *                 Live thumbnails also accepted as base64 POST from client.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const config = require('../config');
const db = require('../db/database');

// ── Constants ────────────────────────────────────────────────
const THUMB_DIR = path.resolve(config.thumbnails?.path || './data/thumbnails');
const THUMB_WIDTH = 640;
const THUMB_QUALITY = 6; // ffmpeg qscale:v  (2=best, 31=worst, 6 is good balance)
const LIVE_THUMB_MIN_INTERVAL_MS = 120000;
const CLIENT_THUMB_WRITE_MIN_INTERVAL_MS = 15000;
const activeLiveThumbnailJobs = new Set();

// Ensure thumbnail directory exists
if (!fs.existsSync(THUMB_DIR)) {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
}

function getStreamThumbnailState(streamId) {
    const row = db.get('SELECT thumbnail_url FROM streams WHERE id = ?', [streamId]);
    const thumbUrl = row?.thumbnail_url || null;
    if (!thumbUrl) return { thumbUrl: null, filePath: null, exists: false, ageMs: Infinity };

    const filePath = path.join(THUMB_DIR, path.basename(thumbUrl));
    if (!fs.existsSync(filePath)) return { thumbUrl, filePath, exists: false, ageMs: Infinity };

    const stat = fs.statSync(filePath);
    return {
        thumbUrl,
        filePath,
        exists: true,
        ageMs: Date.now() - stat.mtimeMs,
    };
}

function shouldRefreshLiveThumbnail(streamId, minAgeMs = LIVE_THUMB_MIN_INTERVAL_MS) {
    const state = getStreamThumbnailState(streamId);
    return !state.exists || state.ageMs >= minAgeMs;
}

function getCurrentLiveThumbnailUrl(streamId) {
    return getStreamThumbnailState(streamId).thumbUrl || null;
}

// ── Generate Thumbnail from Video File (VODs & Clips) ────────
/**
 * Extract a thumbnail frame from a video file using ffmpeg.
 * @param {string} videoPath  – Absolute path to the video file
 * @param {string} prefix     – Filename prefix ('vod' or 'clip')
 * @param {number} entityId   – DB id (vod or clip id)
 * @param {object} opts
 * @param {number} [opts.seekPercent=10] – Seek to this % of duration
 * @param {number} [opts.seekSeconds]    – Or seek to exact seconds (overrides %)
 * @returns {Promise<string|null>} The API-relative thumbnail URL, or null on failure
 */
function generateFromVideo(videoPath, prefix, entityId, opts = {}) {
    return new Promise((resolve) => {
        if (!videoPath || !fs.existsSync(videoPath)) {
            return resolve(null);
        }

        const outFilename = `${prefix}-${entityId}-${Date.now()}.jpg`;
        const outPath = path.join(THUMB_DIR, outFilename);

        // First, probe the duration
        const probe = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json', '-show_format', videoPath,
        ]);
        let probeData = '';
        probe.stdout.on('data', (d) => (probeData += d));

        probe.on('close', (probeCode) => {
            let seekTime = opts.seekSeconds || 1;

            if (probeCode === 0 && !opts.seekSeconds) {
                try {
                    const info = JSON.parse(probeData);
                    const duration = parseFloat(info.format?.duration || '0');
                    if (duration > 2) {
                        seekTime = Math.min(
                            duration * ((opts.seekPercent || 10) / 100),
                            duration - 0.5
                        );
                    }
                } catch {}
            }

            // Extract frame
            const args = [
                '-y',
                '-ss', String(Math.max(0, seekTime)),
                '-i', videoPath,
                '-vframes', '1',
                '-vf', `scale=${THUMB_WIDTH}:-1`,
                '-q:v', String(THUMB_QUALITY),
                outPath,
            ];

            const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
            ff.on('close', (code) => {
                if (code === 0 && fs.existsSync(outPath)) {
                    const thumbUrl = `/api/thumbnails/${outFilename}`;
                    resolve(thumbUrl);
                } else {
                    resolve(null);
                }
            });
            ff.on('error', () => resolve(null));
        });

        probe.on('error', () => resolve(null));
    });
}

// ── Generate VOD Thumbnail ───────────────────────────────────
/**
 * Generate thumbnail for a VOD and update the DB record.
 * @param {number} vodId
 * @param {string} filePath – Absolute path to the VOD file
 * @returns {Promise<string|null>}
 */
async function generateVodThumbnail(vodId, filePath) {
    const thumbUrl = await generateFromVideo(filePath, 'vod', vodId, { seekPercent: 10 });
    if (thumbUrl) {
        db.run('UPDATE vods SET thumbnail_url = ? WHERE id = ?', [thumbUrl, vodId]);
    }
    return thumbUrl;
}

// ── Generate Clip Thumbnail ──────────────────────────────────
/**
 * Generate thumbnail for a clip and update the DB record.
 * @param {number} clipId
 * @param {string} filePath – Absolute path to the clip file
 * @returns {Promise<string|null>}
 */
async function generateClipThumbnail(clipId, filePath) {
    const thumbUrl = await generateFromVideo(filePath, 'clip', clipId, { seekSeconds: 0.5 });
    if (thumbUrl) {
        db.run('UPDATE clips SET thumbnail_url = ? WHERE id = ?', [thumbUrl, clipId]);
    }
    return thumbUrl;
}

// ── Save Live Stream Thumbnail (from client-side capture) ────
/**
 * Save a live-stream thumbnail. Accepts either:
 *   - A Buffer of JPEG data
 *   - A base64-encoded JPEG string (with or without data: prefix)
 *
 * @param {number} streamId
 * @param {Buffer|string} imageData
 * @returns {string|null} The thumbnail URL, or null on failure
 */
function saveLiveThumbnail(streamId, imageData) {
    try {
        const current = getStreamThumbnailState(streamId);
        if (current.exists && current.ageMs < CLIENT_THUMB_WRITE_MIN_INTERVAL_MS) {
            return current.thumbUrl;
        }

        let buffer;
        if (Buffer.isBuffer(imageData)) {
            buffer = imageData;
        } else if (typeof imageData === 'string') {
            // Strip data:image/jpeg;base64, prefix if present
            const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
            buffer = Buffer.from(base64, 'base64');
        } else {
            return null;
        }

        // Validate it's a JPEG (starts with FF D8)
        if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
            // Try to accept PNG too (89 50 4E 47)
            if (buffer.length < 4 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
                console.warn('[Thumbnails] Invalid image data for stream', streamId);
                return null;
            }
        }

        // Clean up old thumbnail for this stream
        const oldThumb = db.get('SELECT thumbnail_url FROM streams WHERE id = ?', [streamId]);
        if (oldThumb?.thumbnail_url) {
            const oldFile = path.join(THUMB_DIR, path.basename(oldThumb.thumbnail_url));
            if (fs.existsSync(oldFile)) {
                try { fs.unlinkSync(oldFile); } catch {}
            }
        }

        const filename = `stream-${streamId}-${Date.now()}.jpg`;
        const outPath = path.join(THUMB_DIR, filename);
        fs.writeFileSync(outPath, buffer);

        const thumbUrl = `/api/thumbnails/${filename}`;
        db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', [thumbUrl, streamId]);
        return thumbUrl;
    } catch (err) {
        console.error('[Thumbnails] Save live thumbnail error:', err.message);
        return null;
    }
}

// ── Serve Thumbnail File ─────────────────────────────────────
/**
 * Express middleware to serve a thumbnail file.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function serveThumbnail(req, res) {
    try {
        const filename = path.basename(req.params.filename); // prevent traversal
        const filePath = path.join(THUMB_DIR, filename);

        if (!fs.existsSync(filePath)) {
            // Return a 1x1 transparent pixel JPEG as fallback
            const pixel = Buffer.from(
                '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA=',
                'base64'
            );
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': pixel.length,
                'Cache-Control': 'no-cache',
            });
            return res.end(pixel);
        }

        const stat = fs.statSync(filePath);
        const ext = path.extname(filename).toLowerCase();
        const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

        // Cache for 30s for live thumbnails, longer for VOD/clip
        const isLive = filename.startsWith('stream-');
        const maxAge = isLive ? 30 : 86400;

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
            'Cache-Control': `public, max-age=${maxAge}`,
        });
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: 'Failed to serve thumbnail' });
    }
}

// ── Generate Live Thumbnail from RTMP/JSMPEG Stream (server-side) ──
/**
 * Capture a thumbnail from a live RTMP stream using ffmpeg.
 * Connects to the HTTP-FLV endpoint and grabs a single frame.
 *
 * @param {number} streamId  – Stream DB id
 * @param {string} streamKey – The user's stream key
 * @param {object} opts
 * @param {number} [opts.rtmpHttpPort] – HTTP-FLV port (default: config.rtmp.port + 8000)
 * @returns {Promise<string|null>} The thumbnail URL, or null on failure
 */
function generateLiveStreamThumbnail(streamId, streamKey, opts = {}) {
    return new Promise((resolve) => {
        const minAgeMs = Number.isFinite(opts.minAgeMs) ? opts.minAgeMs : LIVE_THUMB_MIN_INTERVAL_MS;
        if (!shouldRefreshLiveThumbnail(streamId, minAgeMs)) {
            return resolve(getCurrentLiveThumbnailUrl(streamId));
        }

        const jobKey = `rtmp:${streamId}`;
        if (activeLiveThumbnailJobs.has(jobKey)) {
            return resolve(getCurrentLiveThumbnailUrl(streamId));
        }
        activeLiveThumbnailJobs.add(jobKey);

        const rtmpHttpPort = opts.rtmpHttpPort || ((config.rtmp?.port || 1935) + 8000);
        const flvUrl = `http://127.0.0.1:${rtmpHttpPort}/live/${streamKey}.flv`;

        // Clean up old thumbnail for this stream
        const oldThumb = db.get('SELECT thumbnail_url FROM streams WHERE id = ?', [streamId]);
        if (oldThumb?.thumbnail_url) {
            const oldFile = path.join(THUMB_DIR, path.basename(oldThumb.thumbnail_url));
            if (fs.existsSync(oldFile)) {
                try { fs.unlinkSync(oldFile); } catch {}
            }
        }

        const filename = `stream-${streamId}-${Date.now()}.jpg`;
        const outPath = path.join(THUMB_DIR, filename);

        // Use ffmpeg to grab a single frame from the live FLV stream
        const args = [
            '-y',
            '-i', flvUrl,
            '-vframes', '1',
            '-vf', `scale=${THUMB_WIDTH}:-1`,
            '-q:v', String(THUMB_QUALITY),
            outPath,
        ];

        const ff = spawn('ffmpeg', args, { stdio: 'ignore' });

        // Kill ffmpeg after 8s if it hangs
        const killTimer = setTimeout(() => {
            try { ff.kill('SIGKILL'); } catch {}
        }, 8000);

        ff.on('close', (code) => {
            activeLiveThumbnailJobs.delete(jobKey);
            clearTimeout(killTimer);
            if (code === 0 && fs.existsSync(outPath)) {
                const thumbUrl = `/api/thumbnails/${filename}`;
                db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', [thumbUrl, streamId]);
                resolve(thumbUrl);
            } else {
                // Clean up failed output
                if (fs.existsSync(outPath)) {
                    try { fs.unlinkSync(outPath); } catch {}
                }
                resolve(null);
            }
        });
        ff.on('error', () => {
            activeLiveThumbnailJobs.delete(jobKey);
            clearTimeout(killTimer);
            resolve(null);
        });
    });
}

// ── Generate Live Thumbnail from JSMPEG Stream (server-side via WS) ──
/**
 * Capture a thumbnail from a live JSMPEG stream by connecting to the
 * WebSocket relay as a viewer, collecting raw MPEG-TS data, and piping
 * it through ffmpeg to extract a single frame.
 *
 * @param {number} streamId  – Stream DB id
 * @param {number} videoPort – The JSMPEG video WebSocket port
 * @returns {Promise<string|null>} The thumbnail URL, or null on failure
 */
function generateJSMPEGThumbnail(streamId, videoPort) {
    return new Promise((resolve) => {
        if (!shouldRefreshLiveThumbnail(streamId, LIVE_THUMB_MIN_INTERVAL_MS)) {
            return resolve(getCurrentLiveThumbnailUrl(streamId));
        }

        const jobKey = `jsmpeg:${streamId}`;
        if (activeLiveThumbnailJobs.has(jobKey)) {
            return resolve(getCurrentLiveThumbnailUrl(streamId));
        }
        activeLiveThumbnailJobs.add(jobKey);

        // Clean up old thumbnail for this stream
        const oldThumb = db.get('SELECT thumbnail_url FROM streams WHERE id = ?', [streamId]);
        if (oldThumb?.thumbnail_url) {
            const oldFile = path.join(THUMB_DIR, path.basename(oldThumb.thumbnail_url));
            if (fs.existsSync(oldFile)) {
                try { fs.unlinkSync(oldFile); } catch {}
            }
        }

        const filename = `stream-${streamId}-${Date.now()}.jpg`;
        const outPath = path.join(THUMB_DIR, filename);

        // Connect to the JSMPEG WebSocket relay as a viewer
        const wsUrl = `ws://127.0.0.1:${videoPort}`;
        let ws;
        try { ws = new WebSocket(wsUrl); } catch { return resolve(null); }
        ws.binaryType = 'arraybuffer';

        const chunks = [];
        let totalBytes = 0;
        const MAX_BYTES = 512 * 1024; // 512KB should contain at least one I-frame

        const killTimer = setTimeout(() => {
            try { ws.close(); } catch {}
        }, 6000);

        ws.on('message', (data) => {
            if (data instanceof ArrayBuffer) data = Buffer.from(data);
            chunks.push(data);
            totalBytes += data.length;
            if (totalBytes >= MAX_BYTES) {
                try { ws.close(); } catch {}
            }
        });

        ws.on('error', () => {
            activeLiveThumbnailJobs.delete(jobKey);
            clearTimeout(killTimer);
            resolve(null);
        });

        ws.on('close', () => {
            clearTimeout(killTimer);
            if (!chunks.length) {
                activeLiveThumbnailJobs.delete(jobKey);
                return resolve(null);
            }

            // Pipe collected MPEG-TS data through ffmpeg stdin
            const ff = spawn('ffmpeg', [
                '-y',
                '-f', 'mpegts',
                '-i', 'pipe:0',
                '-vframes', '1',
                '-vf', `scale=${THUMB_WIDTH}:-1`,
                '-q:v', String(THUMB_QUALITY),
                outPath,
            ], { stdio: ['pipe', 'ignore', 'ignore'] });

            for (const chunk of chunks) {
                try { ff.stdin.write(chunk); } catch {}
            }
            try { ff.stdin.end(); } catch {}

            const ffKill = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 5000);

            ff.on('close', (code) => {
                activeLiveThumbnailJobs.delete(jobKey);
                clearTimeout(ffKill);
                if (code === 0 && fs.existsSync(outPath)) {
                    const thumbUrl = `/api/thumbnails/${filename}`;
                    db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', [thumbUrl, streamId]);
                    resolve(thumbUrl);
                } else {
                    if (fs.existsSync(outPath)) { try { fs.unlinkSync(outPath); } catch {} }
                    resolve(null);
                }
            });
            ff.on('error', () => {
                activeLiveThumbnailJobs.delete(jobKey);
                clearTimeout(ffKill);
                resolve(null);
            });
        });
    });
}

// ── Cleanup Old Live Thumbnails ──────────────────────────────
/**
 * Remove live-stream thumbnails older than `maxAgeMs` (default 1 hour).
 * Intended to be called periodically (e.g. from the heartbeat cleanup cron).
 */
function cleanupOldThumbnails(maxAgeMs = 3600000) {
    try {
        const files = fs.readdirSync(THUMB_DIR);
        const now = Date.now();
        let cleaned = 0;

        for (const file of files) {
            // Only auto-clean live stream thumbs (vod/clip thumbs are permanent)
            if (!file.startsWith('stream-')) continue;

            const filePath = path.join(THUMB_DIR, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAgeMs) {
                fs.unlinkSync(filePath);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[Thumbnails] Cleaned up ${cleaned} old live thumbnails`);
        }
    } catch (err) {
        console.error('[Thumbnails] Cleanup error:', err.message);
    }
}

module.exports = {
    generateFromVideo,
    generateVodThumbnail,
    generateClipThumbnail,
    generateLiveStreamThumbnail,
    generateJSMPEGThumbnail,
    saveLiveThumbnail,
    serveThumbnail,
    shouldRefreshLiveThumbnail,
    getCurrentLiveThumbnailUrl,
    cleanupOldThumbnails,
    THUMB_DIR,
};
