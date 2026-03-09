/**
 * HoboStreamer — Server-Side Stream Recorder
 *
 * Records RTMP and JSMPEG streams to VOD files via FFmpeg.
 * Integrates with the existing VOD routes infrastructure for seeking,
 * thumbnails, and database records.
 *
 * Flow:
 *   startRecording()  → spawn FFmpeg → write .webm to data/vods/
 *   stopRecording()   → SIGINT FFmpeg → finalizeVodRecording() → remux + probe + thumbnail
 *
 * For JSMPEG: connects as a WebSocket client to the JSMPEG relay,
 * pipes mpeg-ts binary data directly to FFmpeg stdin → WebM output.
 * This adds zero delay to the live stream — it's a passive tap.
 *
 * Periodic live-seeking remux runs every 60s so viewers can DVR-seek
 * into the growing recording without waiting for the stream to end.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const db = require('../db/database');
const config = require('../config');

class StreamRecorder {
    constructor() {
        /** @type {Map<number, { process: ChildProcess, filePath: string, vodId: number, startTime: number, ws?: WebSocket, remuxTimer?: NodeJS.Timeout }>} */
        this.activeRecordings = new Map();

        // Ensure VOD directory exists
        const vodDir = path.resolve(config.vod.path);
        if (!fs.existsSync(vodDir)) {
            fs.mkdirSync(vodDir, { recursive: true });
        }
    }

    /**
     * Start recording a stream via FFmpeg.
     * Creates a VOD database record immediately and begins writing data.
     *
     * @param {number} streamId
     * @param {string} protocol - 'rtmp' or 'jsmpeg'
     * @param {{ streamKey: string, videoPort?: number }} endpoint
     */
    startRecording(streamId, protocol, endpoint) {
        if (this.activeRecordings.has(streamId)) {
            console.log(`[VOD] Already recording stream ${streamId}`);
            return;
        }

        const stream = db.getStreamById(streamId);
        if (!stream) {
            console.error(`[VOD] Cannot record — stream ${streamId} not found`);
            return;
        }

        const timestamp = Date.now();
        const filename = `vod-${streamId}-${timestamp}.webm`;
        const filePath = path.resolve(config.vod.path, filename);

        const useStdinPipe = protocol === 'jsmpeg';

        let inputArgs;
        switch (protocol) {
            case 'rtmp':
                inputArgs = [
                    '-rw_timeout', '15000000',
                    '-i', `rtmp://127.0.0.1:${config.rtmp.port}/live/${endpoint.streamKey}`,
                ];
                break;

            case 'jsmpeg':
                // Read muxed mpeg-ts from stdin (piped from JSMPEG relay WebSocket)
                inputArgs = [
                    '-f', 'mpegts',
                    '-i', 'pipe:0',
                ];
                break;

            default:
                console.log(`[VOD] Server-side recording not supported for protocol: ${protocol}`);
                return;
        }

        // Create VOD record in DB first so it's tracked even if FFmpeg dies early
        const result = db.createVod({
            stream_id: streamId,
            user_id: stream.user_id,
            title: stream.title || 'Stream Recording',
            file_path: filePath,
            file_size: 0,
            duration_seconds: 0,
        });
        const vodId = result.lastInsertRowid;
        db.run('UPDATE vods SET is_recording = 1 WHERE id = ?', [vodId]);

        // Also register in vodRoutes.activeRecordings so finalizeVodRecording() can find it
        try {
            const vodRoutes = require('./routes');
            vodRoutes.activeRecordings.set(streamId, {
                vodId,
                filePath,
                startTime: timestamp,
                chunkCount: 0,
            });
        } catch (err) {
            console.warn(`[VOD] Could not register in vodRoutes.activeRecordings:`, err.message);
        }

        const ffmpegArgs = [
            '-y',
            ...inputArgs,
            // Encode to VP8/Vorbis WebM (same format as client-side recordings)
            '-c:v', 'libvpx',
            '-b:v', '1500k',
            '-crf', '20',
            '-deadline', 'realtime',
            '-cpu-used', '4',
            '-c:a', 'libvorbis',
            '-b:a', '128k',
            '-f', 'webm',
            filePath,
        ];

        try {
            const proc = spawn('ffmpeg', ffmpegArgs, {
                stdio: [useStdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            });

            proc.stderr.on('data', (data) => {
                const line = data.toString();
                if (line.includes('Error') || line.includes('error')) {
                    console.error(`[VOD] FFmpeg error (stream ${streamId}):`, line.trim());
                }
            });

            proc.on('exit', (code, signal) => {
                console.log(`[VOD] FFmpeg exited for stream ${streamId} (code: ${code}, signal: ${signal})`);
                const rec = this.activeRecordings.get(streamId);
                if (rec) {
                    if (rec.remuxTimer) clearInterval(rec.remuxTimer);
                    if (rec.ws) try { rec.ws.close(); } catch {}
                }
                this.activeRecordings.delete(streamId);

                // Let finalizeVodRecording handle remux, probe, thumbnail
                // Short delay to ensure file is fully flushed
                setTimeout(() => {
                    const vodRoutes = require('./routes');
                    vodRoutes.finalizeVodRecording(streamId).catch(err => {
                        console.error(`[VOD] Finalization failed for stream ${streamId}:`, err.message);
                    });
                }, 1000);
            });

            proc.on('error', (err) => {
                console.error(`[VOD] FFmpeg spawn error (stream ${streamId}):`, err.message);
                const rec = this.activeRecordings.get(streamId);
                if (rec) {
                    if (rec.remuxTimer) clearInterval(rec.remuxTimer);
                    if (rec.ws) try { rec.ws.close(); } catch {}
                }
                this.activeRecordings.delete(streamId);
                db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
            });

            const recording = {
                process: proc,
                filePath,
                vodId,
                startTime: timestamp,
                ws: null,
                remuxTimer: null,
            };

            // For JSMPEG: connect to the relay WebSocket and pipe data to FFmpeg stdin
            if (useStdinPipe && endpoint.videoPort) {
                const ws = new WebSocket(`ws://127.0.0.1:${endpoint.videoPort}`);
                ws.binaryType = 'arraybuffer';
                ws.on('open', () => {
                    console.log(`[VOD] JSMPEG WS relay connected for recording (stream ${streamId})`);
                });
                ws.on('message', (data) => {
                    try {
                        if (proc.stdin && !proc.stdin.destroyed) {
                            proc.stdin.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
                        }
                    } catch {}
                });
                ws.on('close', () => {
                    try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end(); } catch {}
                });
                ws.on('error', (err) => {
                    console.warn(`[VOD] JSMPEG WS error (stream ${streamId}):`, err.message);
                });
                recording.ws = ws;
            }

            // Periodic live-seeking remux: generate a .seekable.webm sidecar every 60s
            // so DVR viewers can seek into the growing file without waiting for finalization
            recording.remuxTimer = setInterval(() => {
                this._periodicRemux(streamId);
            }, 60000);
            // Also run a first remux at 30s for early DVR availability
            setTimeout(() => {
                if (this.activeRecordings.has(streamId)) this._periodicRemux(streamId);
            }, 30000);

            this.activeRecordings.set(streamId, recording);

            console.log(`[VOD] Recording started: stream ${streamId} → ${filename} (${protocol})`);
        } catch (err) {
            console.error(`[VOD] Failed to start recording stream ${streamId}:`, err.message);
            db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
        }
    }

    /**
     * Run periodic live-seeking remux and update DB duration/file size.
     * Called every 60s (and once at 30s) during a recording.
     */
    _periodicRemux(streamId) {
        const rec = this.activeRecordings.get(streamId);
        if (!rec || !rec.filePath || !fs.existsSync(rec.filePath)) return;

        // Update duration and file size in DB
        const elapsed = Math.round((Date.now() - rec.startTime) / 1000);
        try {
            const stat = fs.statSync(rec.filePath);
            db.run('UPDATE vods SET duration_seconds = ?, file_size = ? WHERE id = ?',
                [elapsed, stat.size, rec.vodId]);
        } catch {}

        // Generate seekable sidecar for live DVR
        try {
            const vodRoutes = require('./routes');
            if (typeof vodRoutes.remuxForLiveSeeking === 'function') {
                vodRoutes.remuxForLiveSeeking(rec.filePath).catch(() => {});
            }
        } catch {}
    }

    /**
     * Gracefully stop recording a stream.
     * FFmpeg SIGINT triggers trailer write → exit handler → finalizeVodRecording.
     */
    stopRecording(streamId) {
        const recording = this.activeRecordings.get(streamId);
        if (!recording) return;

        console.log(`[VOD] Stopping recording for stream ${streamId}`);

        // Stop periodic remux
        if (recording.remuxTimer) {
            clearInterval(recording.remuxTimer);
            recording.remuxTimer = null;
        }

        // Close JSMPEG WebSocket (causes FFmpeg stdin EOF)
        if (recording.ws) {
            try { recording.ws.close(); } catch {}
            recording.ws = null;
        }

        try {
            // SIGINT lets FFmpeg write WebM Cues/trailer for seekability
            recording.process.kill('SIGINT');
        } catch {
            try { recording.process.kill('SIGTERM'); } catch { /* ignore */ }
        }

        // Safety net: force-kill after 10s if FFmpeg hangs
        setTimeout(() => {
            try {
                if (recording.process && !recording.process.killed) {
                    recording.process.kill('SIGKILL');
                }
            } catch { /* ignore */ }
        }, 10000);
    }

    /**
     * Check if a stream is currently being recorded
     */
    isRecording(streamId) {
        return this.activeRecordings.has(streamId);
    }

    /**
     * Stop all active recordings (for graceful shutdown)
     */
    stopAll() {
        for (const [streamId] of this.activeRecordings) {
            this.stopRecording(streamId);
        }
    }
}

module.exports = new StreamRecorder();
