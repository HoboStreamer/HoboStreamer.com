/**
 * HoboStreamer — Server-Side Stream Recorder
 *
 * Records RTMP, JSMPEG, and WebRTC/WHIP streams to VOD files via FFmpeg.
 * Integrates with the existing VOD routes infrastructure for seeking,
 * thumbnails, and database records.
 *
 * Flow (RTMP/JSMPEG):
 *   startRecording()  → spawn FFmpeg → write .webm to data/vods/
 *   stopRecording()   → SIGINT FFmpeg → finalizeVodRecording() → remux + probe + thumbnail
 *
 * Flow (WebRTC/WHIP/browser):
 *   startRecording()  → wait for SFU producer → create PlainRTP consumers → FFmpeg
 *   stopRecording()   → SIGINT FFmpeg → close PlainRTP consumers → finalize
 *
 * For JSMPEG: connects as a WebSocket client to the JSMPEG relay,
 * pipes mpeg-ts binary data directly to FFmpeg stdin → WebM output.
 *
 * Periodic live-seeking remux runs every 60s so viewers can DVR-seek
 * into the growing recording without waiting for the stream to end.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const db = require('../db/database');
const config = require('../config');

// Grace period for ffmpeg to flush the WebM trailer/cues after SIGINT before we
// force-kill. Generous on purpose — a long recording's trailer flush must not be cut
// short (that truncates the VOD). Cleared the instant ffmpeg exits cleanly.
const STOP_GRACE_MS = parseInt(process.env.VOD_STOP_GRACE_MS, 10) || 60000;

// ── VOD rotation + disk protection ───────────────────────────────────────────
// A single continuous recording is rotated into a fresh VOD "part" once it gets too
// long or too big, so neither the served .webm nor its lossless .master.mkv can grow
// unbounded and fill the disk on a marathon stream. Recording is decoupled from live
// delivery (a separate SFU consumer / RTMP puller), so rotating never interrupts viewers.
const VOD_MAX_DURATION_MS = (parseFloat(process.env.VOD_MAX_HOURS) || 4) * 3600 * 1000;
const VOD_MAX_BYTES = (parseFloat(process.env.VOD_MAX_GB) || 10) * 1024 * 1024 * 1024; // webm+master combined
const VOD_ROTATE_MIN_MS = 5 * 60 * 1000;          // never rotate a recording younger than this (anti-churn)
// Disk guardian thresholds (free bytes on the VOD volume).
const DISK_WARN_BYTES = (parseFloat(process.env.VOD_DISK_WARN_GB) || 15) * 1024 * 1024 * 1024;
const DISK_CRIT_BYTES = (parseFloat(process.env.VOD_DISK_CRIT_GB) || 5) * 1024 * 1024 * 1024;
const FORCE_ROTATE_COOLDOWN_MS = 10 * 60 * 1000;  // don't force-rotate the same stream more than this often

// RTP port range for recording PlainRTP consumers.
// Distinct from mediasoup (10000-10999) and restream-manager (20000-30000).
let _nextRecordRtpPort = 25100;
function _allocateRecordRtpPort() {
    const port = _nextRecordRtpPort;
    _nextRecordRtpPort += 2;
    if (_nextRecordRtpPort > 26000) _nextRecordRtpPort = 25100;
    return port;
}

function _isControlledFfmpegError(line, expectedShutdown) {
    if (!line || !expectedShutdown) return false;
    const normalized = line.toLowerCase();
    return /demux.*timeout|timeout|broken pipe|connection.*reset|closed|end of file|sigterm|sigint|error while reading/i.test(normalized);
}

function _isFfmpegCorruptionLine(line) {
    if (!line) return false;
    const normalized = line.toLowerCase();
    return /error while decoding|concealing|non[- ]monotonically increasing dts|missing picture in access unit|invalid .* header|invalid .* nal unit|could not find codec parameters|moov atom|invalid packet/i.test(normalized);
}

function _trackFfmpegDiagnostics(line, recording) {
    if (!recording || !_isFfmpegCorruptionLine(line)) return;
    recording.ffmpegCorruptionWarnings = (recording.ffmpegCorruptionWarnings || 0) + 1;
    if (recording.ffmpegCorruptionWarnings >= 5) {
        recording._ffmpegCorrupted = true;
    }
}

function _isVodDiagnosticsEnabled() {
    return process.env.VOD_DEBUG === '1' || process.env.VOD_DIAGNOSTICS === '1';
}

function _getVodDiagnosticsDir() {
    const diagnosticsDir = path.resolve(config.vod.path, 'diagnostics');
    if (!fs.existsSync(diagnosticsDir)) {
        fs.mkdirSync(diagnosticsDir, { recursive: true });
    }
    return diagnosticsDir;
}

function _writeVodDiagnosticsFile(vodId, streamId, name, content) {
    try {
        const diagnosticsDir = _getVodDiagnosticsDir();
        const filename = `vod-${vodId}-stream-${streamId}.${name}`;
        const filePath = path.join(diagnosticsDir, filename);
        fs.writeFileSync(filePath, content, 'utf8');
        return filePath;
    } catch {
        return null;
    }
}

function _sanitizeDiagnosticJson(obj) {
    const clone = JSON.parse(JSON.stringify(obj));
    if (clone.streamKey) delete clone.streamKey;
    if (clone.token) delete clone.token;
    return clone;
}

function _isH264MasterRecordingSupported(videoConsumer, audioConsumer) {
    if (!videoConsumer || !videoConsumer.mimeType) return false;
    if (!audioConsumer || !audioConsumer.mimeType) return false;
    return videoConsumer.mimeType.toLowerCase().includes('h264')
        && audioConsumer.mimeType.toLowerCase().includes('opus');
}

function _formatFmtpParameters(params) {
    return Object.entries(params || {}).map(([k, v]) => `${k}=${v}`).join(';');
}

/**
 * Build an SDP string for FFmpeg to receive RTP from mediasoup PlainRTP consumers.
 */
function _buildRtpRecordSdp(videoConsumer, audioConsumer, videoPort, videoRtcpPort, audioPort, audioRtcpPort) {
    const lines = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=HoboStreamer VOD Recording',
        'c=IN IP4 127.0.0.1',
        't=0 0',
    ];

    const vPT = videoConsumer.payloadType;
    const vCodec = videoConsumer.rtpParameters.codecs?.[0] || {};
    const vCodecName = (videoConsumer.mimeType || 'video/VP8').split('/')[1];
    const videoProtocol = Array.isArray(vCodec.rtcpFeedback) && vCodec.rtcpFeedback.length > 0 ? 'RTP/AVPF' : 'RTP/AVP';
    lines.push(`m=video ${videoPort} ${videoProtocol} ${vPT}`);
    lines.push(`a=rtpmap:${vPT} ${vCodecName}/${videoConsumer.clockRate}`);
    if (videoRtcpPort) lines.push(`a=rtcp:${videoRtcpPort} IN IP4 127.0.0.1`);
    if (videoConsumer.ssrc) lines.push(`a=ssrc:${videoConsumer.ssrc} cname:record-video`);
    if (videoConsumer.codecParameters) {
        const fmtp = _formatFmtpParameters(videoConsumer.codecParameters);
        if (fmtp) lines.push(`a=fmtp:${vPT} ${fmtp}`);
    }
    if (Array.isArray(vCodec.rtcpFeedback)) {
        for (const fb of vCodec.rtcpFeedback) {
            if (!fb || !fb.type) continue;
            lines.push(`a=rtcp-fb:${vPT} ${fb.type}${fb.parameter ? ` ${fb.parameter}` : ''}`);
        }
    }
    if (Array.isArray(videoConsumer.rtpParameters.headerExtensions)) {
        for (const ext of videoConsumer.rtpParameters.headerExtensions) {
            if (ext && ext.uri && ext.id) {
                lines.push(`a=extmap:${ext.id} ${ext.uri}`);
            }
        }
    }
    lines.push('a=recvonly');

    if (audioConsumer && audioPort) {
        const aPT = audioConsumer.payloadType;
        const aCodec = audioConsumer.rtpParameters.codecs?.[0] || {};
        const aCodecName = (audioConsumer.mimeType || 'audio/opus').split('/')[1];
        const channels = audioConsumer.channels || 2;
        const audioProtocol = Array.isArray(aCodec.rtcpFeedback) && aCodec.rtcpFeedback.length > 0 ? 'RTP/AVPF' : 'RTP/AVP';
        lines.push(`m=audio ${audioPort} ${audioProtocol} ${aPT}`);
        lines.push(`a=rtpmap:${aPT} ${aCodecName}/${audioConsumer.clockRate}/${channels}`);
        if (audioRtcpPort) lines.push(`a=rtcp:${audioRtcpPort} IN IP4 127.0.0.1`);
        if (audioConsumer.ssrc) lines.push(`a=ssrc:${audioConsumer.ssrc} cname:record-audio`);
        if (audioConsumer.codecParameters) {
            const fmtp = _formatFmtpParameters(audioConsumer.codecParameters);
            if (fmtp) lines.push(`a=fmtp:${aPT} ${fmtp}`);
        }
        if (Array.isArray(aCodec.rtcpFeedback)) {
            for (const fb of aCodec.rtcpFeedback) {
                if (!fb || !fb.type) continue;
                lines.push(`a=rtcp-fb:${aPT} ${fb.type}${fb.parameter ? ` ${fb.parameter}` : ''}`);
            }
        }
        if (Array.isArray(audioConsumer.rtpParameters.headerExtensions)) {
            for (const ext of audioConsumer.rtpParameters.headerExtensions) {
                if (ext && ext.uri && ext.id) {
                    lines.push(`a=extmap:${ext.id} ${ext.uri}`);
                }
            }
        }
        lines.push('a=recvonly');
    }
    lines.push('');
    return lines.join('\r\n');
}

const WEBRTC_PROTOCOLS = new Set(['webrtc', 'browser', 'screen', 'whip']);

class StreamRecorder {
    constructor() {
        /** @type {Map<number, { process: ChildProcess|null, filePath: string, vodId: number, startTime: number, ws?: WebSocket, remuxTimer?: NodeJS.Timeout, webrtcState?: object, _cancelWebrtc?: boolean }>} */
        this.activeRecordings = new Map();
        this._rotating = new Set();          // streamIds mid-rotation (reconciler must skip)
        this._forceRotatedAt = new Map();    // streamId → last force-rotate time (cooldown)
        this._diskState = 'ok';              // 'ok' | 'warning' | 'critical' — set by checkDisk()

        // Ensure VOD directory exists
        const vodDir = path.resolve(config.vod.path);
        if (!fs.existsSync(vodDir)) {
            fs.mkdirSync(vodDir, { recursive: true });
        }
    }

    _cleanupFailedVod(vodId, filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            try {
                db.run('DELETE FROM vods WHERE id = ?', [vodId]);
                console.log(`[VOD] Deleted stale failed VOD ${vodId}`);
            } catch (err) {
                console.warn(`[VOD] Failed to delete stale VOD ${vodId}:`, err.message);
            }
            return;
        }

        try {
            db.run(
                'UPDATE vods SET is_recording = 0, health_status = ?, health_issues_json = ?, quarantined_at = datetime(\'now\'), is_public = 0 WHERE id = ?',
                ['corrupt', JSON.stringify(['failed_recording_start']), vodId]
            );
            console.log(`[VOD] Marked failed VOD ${vodId} as corrupt`);
        } catch (err) {
            console.warn(`[VOD] Failed to mark VOD ${vodId} as corrupt:`, err.message);
        }
    }

    /**
     * Start recording a stream via FFmpeg.
     * Creates a VOD database record immediately and begins writing data.
     *
     * @param {number} streamId
     * @param {string} protocol - 'rtmp', 'jsmpeg', 'webrtc', 'browser', 'screen', 'whip'
     * @param {{ streamKey?: string, videoPort?: number }} endpoint
     */
    startRecording(streamId, protocol, endpoint, opts = {}) {
        if (this.activeRecordings.has(streamId)) {
            console.log(`[VOD] Already recording stream ${streamId}`);
            return;
        }

        // Disk guardian: when the VOD volume is critically low, keep the stream LIVE but
        // skip recording rather than risk filling the disk (which would corrupt every
        // active recording and can take down the whole server).
        if (this._diskState === 'critical') {
            console.warn(`[VOD] Disk critically low — NOT starting recording for stream ${streamId} (stream stays live, no VOD)`);
            return;
        }

        const stream = db.getStreamById(streamId);
        if (!stream) {
            console.error(`[VOD] Cannot record — stream ${streamId} not found`);
            return;
        }

        const timestamp = Date.now();
        // RTMP is recorded by lossless stream-copy into a fragmented MP4 (H.264/AAC
        // passthrough): near-zero CPU, always keeps real-time, browser-native, and it IS
        // its own lossless master (no separate .master.mkv). Every other server-pulled
        // protocol (jsmpeg) transcodes to VP8/WebM. WebRTC is handled earlier via PlainRTP.
        const recExt = protocol === 'rtmp' ? '.mp4' : '.webm';
        const filename = `vod-${streamId}-${timestamp}${recExt}`;
        const filePath = path.resolve(config.vod.path, filename);

        // Rotation metadata: a marathon stream is split into "Part N" VODs so no single
        // file (or its master) grows without bound.
        const part = opts.part || 1;
        const baseTitle = opts.baseTitle || stream.title || 'Stream Recording';
        const title = part > 1 ? `${baseTitle} (Part ${part})` : baseTitle;
        // Recording MODE: 'vod' publishes a full VOD; 'clips' records an ephemeral rolling
        // file solely to serve the clip system on a VOD-disabled slot (never published,
        // deleted on stream end, short rotation to bound disk).
        const mode = opts.mode || 'vod';
        const clipsOnly = mode === 'clips';
        // Skip the lossless master when it was explicitly requested OR the disk is under
        // pressure OR this is a clips-only ephemeral recording — the master is a recovery aid.
        const skipMaster = !!opts.skipMaster || clipsOnly || this._diskState !== 'ok';

        // Create VOD record in DB first so it's tracked even if FFmpeg dies early
        const result = db.createVod({
            stream_id: streamId,
            user_id: stream.user_id,
            title,
            file_path: filePath,
            file_size: 0,
            duration_seconds: 0,
        });
        const vodId = result.lastInsertRowid;
        db.run('UPDATE vods SET is_recording = 1, clips_only = ? WHERE id = ?', [clipsOnly ? 1 : 0, vodId]);

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

        // WebRTC/WHIP/browser: record via PlainRTP consumers from mediasoup SFU
        if (WEBRTC_PROTOCOLS.has(protocol)) {
            // Placeholder so stopRecording() knows recording is in progress
            this.activeRecordings.set(streamId, {
                process: null,
                filePath,
                vodId,
                startTime: timestamp,
                ws: null,
                remuxTimer: null,
                webrtcState: null,
                _cancelWebrtc: false,
                _expectedShutdown: false,
                protocol, endpoint, part, baseTitle, skipMaster, mode, clipsOnly,
            });
            this._startWebrtcRecording(streamId, vodId, filePath, timestamp, protocol, { skipMaster }).catch(err => {
                console.error(`[VOD] WebRTC recording startup failed for stream ${streamId}:`, err.message);
                this.activeRecordings.delete(streamId);
                db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
            });
            return;
        }

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
                db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
                return;
        }

        // Lossless master archive written ALONGSIDE the served webm. If the webm ends up
        // truncated (e.g. force-kill during trailer flush, or a container issue), finalize
        // recovers the full recording from this master. Cheap: it's a stream copy, no
        // re-encode. Deleted once the webm is confirmed complete. Skipped when the disk is
        // under pressure (webm-only) to halve the recording's footprint.
        // RTMP needs no master: its served MP4 is already a lossless copy of the source.
        const masterPath = (skipMaster || protocol === 'rtmp') ? null : filePath.replace(/\.webm$/, '.master.mkv');

        const ffmpegArgs = protocol === 'rtmp'
            ? [
                '-y',
                ...inputArgs,
                // ── Lossless stream-copy → fragmented MP4 ──
                // No re-encode (H.264/AAC pass straight through from the RTMP feed), so this
                // ALWAYS keeps real-time regardless of source resolution/bitrate. Fragmented
                // (frag_keyframe/empty_moov/default_base_moof) so the growing file is seekable
                // live for DVR and survives an abrupt kill without needing a moov-atom rewrite.
                '-c', 'copy',
                '-fflags', '+genpts',
                '-max_muxing_queue_size', '1024',
                '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
                '-f', 'mp4',
                filePath,
            ]
            : [
                '-y',
                ...inputArgs,
                // ── Output 1: served VP8/Vorbis WebM (jsmpeg transcode) ──
                // Pin to a constant canvas so a mid-stream resolution change can't shear the
                // rest of the VOD (see the WebRTC path). Escape hatch: VOD_NO_NORMALIZE=1.
                ...(process.env.VOD_NO_NORMALIZE !== '1' ? ['-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1'] : []),
                '-c:v', 'libvpx',
                '-b:v', '1500k',
                '-crf', '20',
                '-deadline', 'realtime',
                '-cpu-used', '4',
                // Force a keyframe every 2s so seeking always lands on one (no black scrub).
                // Time-based so it's correct regardless of the source framerate.
                '-force_key_frames', 'expr:gte(t,n_forced*2)',
                '-g', '240',
                '-c:a', 'libvorbis',
                '-b:a', '128k',
                '-f', 'webm',
                filePath,
            ];
        if (masterPath) {
            // ── Output 2: lossless copy master (recovery fallback) ──
            ffmpegArgs.push('-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-f', 'matroska', masterPath);
        }

        try {
            const proc = spawn('ffmpeg', ffmpegArgs, {
                stdio: [useStdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            });

            proc.stderr.on('data', (data) => {
                const line = data.toString();
                const recording = this.activeRecordings.get(streamId);
                _trackFfmpegDiagnostics(line, recording);
                if (line.includes('Error') || line.includes('error')) {
                    if (_isControlledFfmpegError(line, recording?._expectedShutdown)) return;
                    console.error(`[VOD] FFmpeg error (stream ${streamId}):`, line.trim());
                }
            });

            proc.on('exit', (code, signal) => {
                console.log(`[VOD] FFmpeg exited for stream ${streamId} (code: ${code}, signal: ${signal})`);
                const rec = this.activeRecordings.get(streamId);
                if (rec) {
                    if (rec._killTimer) { clearTimeout(rec._killTimer); rec._killTimer = null; }
                    if (rec.remuxTimer) clearInterval(rec.remuxTimer);
                    if (rec.ws) try { rec.ws.close(); } catch {}
                }
                this.activeRecordings.delete(streamId);

                // Let finalizeVodRecording handle remux, probe, thumbnail
                // Short delay to ensure file is fully flushed to disk
                setTimeout(() => {
                    const vodRoutes = require('./routes');
                    vodRoutes.finalizeVodRecording(streamId).catch(err => {
                        console.error(`[VOD] Finalization failed for stream ${streamId}:`, err.message);
                    });
                }, 2000);
            });

            proc.on('error', (err) => {
                console.error(`[VOD] FFmpeg spawn error (stream ${streamId}):`, err.message);
                const rec = this.activeRecordings.get(streamId);
                if (rec) {
                    if (rec.remuxTimer) clearInterval(rec.remuxTimer);
                    if (rec.ws) try { rec.ws.close(); } catch {}
                }
                this.activeRecordings.delete(streamId);
                // Try to finalize whatever was written; if file is empty/missing, finalize will clean up
                const vodRoutes = require('./routes');
                vodRoutes.finalizeVodRecording(streamId).catch(() => {
                    // If finalize also fails, at least mark not recording
                    db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
                });
            });

            const recording = {
                process: proc,
                filePath,
                masterFilePath: masterPath,
                vodId,
                startTime: timestamp,
                ws: null,
                remuxTimer: null,
                _expectedShutdown: false,
                ffmpegCorruptionWarnings: 0,
                _ffmpegCorrupted: false,
                // Rotation metadata — lets the watchdog restart this recording as a new part.
                protocol, endpoint, part, baseTitle, skipMaster, mode, clipsOnly,
            };
            // Track the master on the vod row + finalize registry so it's found on restart.
            if (masterPath) try { db.run('UPDATE vods SET master_file_path = ? WHERE id = ?', [masterPath, vodId]); } catch { /* */ }
            try {
                const vodRoutes = require('./routes');
                const areg = vodRoutes.activeRecordings.get(streamId);
                if (areg) areg.masterFilePath = masterPath;
            } catch { /* */ }

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

        // ── Rotation check: split into a new "Part N" VOD before this one gets too big ──
        // Bounds both the served .webm and its lossless .master.mkv so a marathon stream
        // can't fill the disk. Only after a minimum age (anti-churn).
        try {
            if ((Date.now() - rec.startTime) < VOD_ROTATE_MIN_MS) return;
            let combined = 0;
            try { combined += fs.statSync(rec.filePath).size; } catch { /* */ }
            if (rec.masterFilePath) { try { combined += fs.statSync(rec.masterFilePath).size; } catch { /* */ } }
            const tooLong = (Date.now() - rec.startTime) >= VOD_MAX_DURATION_MS;
            const tooBig = combined >= VOD_MAX_BYTES;
            if (tooLong || tooBig) {
                console.log(`[VOD] Rotating stream ${streamId} recording — ${tooLong ? 'max duration' : 'max size'} reached (part ${rec.part || 1} → ${(rec.part || 1) + 1})`);
                this.rotateRecording(streamId, { reason: tooLong ? 'duration' : 'size' });
            }
        } catch { /* */ }
    }

    /**
     * Rotate a stream's recording into a fresh VOD "part": cleanly finalize the current
     * recording (freeing its master), then start a new one. Recording is decoupled from
     * live delivery, so viewers are unaffected — the VOD just gains a Part N. Serialized
     * via this._rotating so the reconciler can't double-start during the brief gap.
     */
    async rotateRecording(streamId, opts = {}) {
        if (this._rotating.has(streamId)) return false;
        const rec = this.activeRecordings.get(streamId);
        if (!rec) return false;
        // Only rotate server-pulled recordings that can cleanly restart (same set the
        // reconciler heals). jsmpeg is fed by the browser relay WS — leave it be.
        if (!(WEBRTC_PROTOCOLS.has(rec.protocol) || rec.protocol === 'rtmp')) return false;
        this._rotating.add(streamId);
        const protocol = rec.protocol;
        const endpoint = rec.endpoint || {};
        const baseTitle = rec.baseTitle;
        const nextPart = (rec.part || 1) + 1;
        try {
            // Finalize the current part (normal path → remux, master→webm recovery, master delete).
            this.stopRecording(streamId);
            // Wait for ffmpeg to exit (activeRecordings entry cleared by the exit handler).
            const deadline = Date.now() + STOP_GRACE_MS + 15000;
            while (this.activeRecordings.has(streamId) && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 500));
            }
            // Small settle so the delayed finalize has started before we reuse the streamId key.
            await new Promise(r => setTimeout(r, 3500));
            // Confirm the stream is still live before starting the next part.
            const stream = db.getStreamById(streamId);
            if (!stream || !stream.is_live) { console.log(`[VOD] Stream ${streamId} no longer live — not starting next part`); return false; }
            const skipMaster = opts.skipMaster || this._diskState !== 'ok';
            // Carry the recording mode forward so an ephemeral clips-only recording stays
            // clips-only across rotation (and never suddenly publishes a VOD).
            const nextMode = rec.clipsOnly ? 'clips' : (rec.mode || 'vod');
            this.startRecording(streamId, protocol, endpoint, { part: nextPart, baseTitle, skipMaster, mode: nextMode });
            return true;
        } catch (e) {
            console.warn(`[VOD] Rotation failed for stream ${streamId}:`, e.message);
            return false;
        } finally {
            this._rotating.delete(streamId);
        }
    }

    /**
     * Disk guardian: sample free space on the VOD volume and protect against exhaustion.
     *  - warning  → new/rotated recordings drop the lossless master (webm-only); nudge offload.
     *  - critical → also force-rotate active recordings to shed their masters NOW, and refuse
     *               to start new recordings (streams stay live, just no VOD) until it recovers.
     * Called on an interval from the server bootstrap. Cheap (`df` + a few size checks).
     */
    checkDisk() {
        let free = 0;
        try { free = require('./vod-storage').diskUsage(config.vod.path).available || 0; } catch { return; }
        if (!free) return;
        const prev = this._diskState;
        const state = free < DISK_CRIT_BYTES ? 'critical' : free < DISK_WARN_BYTES ? 'warning' : 'ok';
        this._diskState = state;
        if (state !== prev) {
            const gb = (free / 1024 / 1024 / 1024).toFixed(1);
            if (state === 'ok') console.log(`[VOD] Disk recovered — ${gb}GB free (recordings back to normal)`);
            else console.warn(`[VOD] Disk ${state.toUpperCase()} — only ${gb}GB free on the VOD volume`);
        }
        if (state === 'ok') return;

        // Under pressure: nudge the storage sweep to offload cold VODs and free local space.
        try { const vs = require('./vod-storage'); if (typeof vs.runSweep === 'function') vs.runSweep().catch(() => {}); } catch { /* */ }

        // Critical: force-rotate active recordings that still carry a master, so the master
        // is finalized+deleted and the next part is webm-only. Cooldown-guarded to avoid churn.
        if (state === 'critical') {
            const now = Date.now();
            for (const [sid, rec] of this.activeRecordings) {
                if (this._rotating.has(sid)) continue;
                if (!rec.masterFilePath) continue;                              // already webm-only
                if (now - (this._forceRotatedAt.get(sid) || 0) < FORCE_ROTATE_COOLDOWN_MS) continue;
                if ((now - rec.startTime) < VOD_ROTATE_MIN_MS) continue;        // too young
                this._forceRotatedAt.set(sid, now);
                console.warn(`[VOD] Disk critical — force-rotating stream ${sid} to shed its master`);
                this.rotateRecording(sid, { reason: 'disk', skipMaster: true });
            }
        }
    }

    /**
     * Gracefully stop recording a stream.
     * FFmpeg SIGINT triggers trailer write → exit handler → finalizeVodRecording.
     */
    stopRecording(streamId) {
        const recording = this.activeRecordings.get(streamId);
        if (!recording) return;

        console.log(`[VOD] Stopping recording for stream ${streamId}`);

        // Mark this as an expected teardown so FFmpeg shutdown noise is suppressed
        recording._expectedShutdown = true;
        // Signal any pending WebRTC async startup to abort
        recording._cancelWebrtc = true;

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

        if (!recording.process) {
            // WebRTC recording startup was still pending — clean up the stale VOD record.
            this.activeRecordings.delete(streamId);
            this._cleanupFailedVod(recording.vodId, recording.filePath);
            return;
        }

        try {
            // SIGINT lets FFmpeg write WebM Cues/trailer for seekability
            recording.process.kill('SIGINT');
        } catch {
            try { recording.process.kill('SIGTERM'); } catch { /* ignore */ }
        }

        // Safety net: force-kill only if FFmpeg is REALLY stuck. A long libvpx WebM can
        // take many seconds to flush its trailer/cues — force-killing too early (the old
        // 10s) truncated the file and produced short/unseekable VODs. We give it a
        // generous window and clear the timer the moment ffmpeg exits cleanly (see the
        // exit handler), so this only ever fires on a genuine hang.
        recording._killTimer = setTimeout(() => {
            try {
                if (recording.process && !recording.process.killed) {
                    console.warn(`[VOD] FFmpeg didn't exit within grace for stream ${streamId} — force-killing (VOD may be truncated; master fallback will be used if present)`);
                    recording.process.kill('SIGKILL');
                }
            } catch { /* ignore */ }
        }, STOP_GRACE_MS);
    }

    /**
     * True while a stream's ffmpeg/webrtc recording is still live (in the active map).
     * Used to stop finalize from touching an open, still-growing file.
     */
    isActivelyRecording(streamId) {
        return this.activeRecordings.has(streamId);
    }

    /**
     * Heal recordings for live streams that should be recording but aren't — e.g. after a
     * server restart (deploy) or if a recording ffmpeg died mid-stream. This is what keeps
     * SERVER-SIDE clipping working across streaming methods: live clips are cut from the
     * growing recording, so there must always be one while a stream is live.
     *
     * webrtc/whip/browser/screen → re-create PlainRTP consumers (waits for the SFU producer).
     * rtmp                       → re-attach ffmpeg to the still-connected publisher.
     * jsmpeg                     → fed by the browser relay WS; can't be resumed server-side.
     */
    reconcileLiveRecordings() {
        let streams;
        try { streams = db.getLiveStreams(); } catch { return; }
        const now = Date.now();
        if (!this._healAttempts) this._healAttempts = new Map();

        for (const stream of streams) {
            const sid = stream.id;
            if (this.isActivelyRecording(sid)) continue;
            if (this._rotating.has(sid)) continue;   // mid-rotation: a new part is about to start

            // Respect the per-slot recording mode — never force recording on a both-off stream,
            // and heal a clips-only stream as clips-only (not as a published VOD).
            let mode = 'none';
            try { mode = db.resolveStreamRecordingMode(stream); } catch { /* */ }
            if (mode === 'none') continue;

            // Per-stream cooldown so a stream that can't heal isn't retried every tick.
            if (now - (this._healAttempts.get(sid) || 0) < 60000) continue;

            const proto = stream.protocol;
            if (WEBRTC_PROTOCOLS.has(proto)) {
                this._healAttempts.set(sid, now);
                console.log(`[VOD] Auto-healing recording for live ${proto} stream ${sid} (mode: ${mode})`);
                try { this.startRecording(sid, proto, {}, { mode }); }
                catch (e) { console.warn(`[VOD] heal failed for stream ${sid}:`, e.message); }
            } else if (proto === 'rtmp') {
                // Need the live RTMP publish key (what ffmpeg reads from); only heal if the
                // publisher is still connected.
                let streamKey = null;
                try {
                    const rtmp = require('../streaming/rtmp-server');
                    if (rtmp && rtmp.activeStreams) {
                        for (const [key, info] of rtmp.activeStreams) { if (info && info.streamId === sid) { streamKey = key; break; } }
                    }
                } catch { /* */ }
                if (!streamKey) continue; // publisher gone → not truly live; leave it for stale cleanup
                this._healAttempts.set(sid, now);
                console.log(`[VOD] Auto-healing RTMP recording for live stream ${sid} (mode: ${mode})`);
                try { this.startRecording(sid, 'rtmp', { streamKey }, { mode }); }
                catch (e) { console.warn(`[VOD] heal failed for stream ${sid}:`, e.message); }
            }
        }

        // Forget cooldowns for streams that are no longer live.
        const liveIds = new Set(streams.map(s => s.id));
        for (const id of Array.from(this._healAttempts.keys())) if (!liveIds.has(id)) this._healAttempts.delete(id);
    }

    /**
     * Start recording a WebRTC/WHIP/browser stream via mediasoup PlainRTP consumers → FFmpeg.
     * Waits up to 60s for producers to appear in the SFU room, then starts FFmpeg.
     */
    async _startWebrtcRecording(streamId, vodId, filePath, startTime, protocol, wopts = {}) {
        let webrtcSFU;
        try {
            webrtcSFU = require('../streaming/webrtc-sfu');
        } catch (err) {
            console.warn(`[VOD] WebRTC recording unavailable — SFU not loaded: ${err.message}`);
            this.activeRecordings.delete(streamId);
            db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
            return;
        }

        const roomId = `stream-${streamId}`;

        // Wait for a video producer to appear in the SFU room (up to 60s)
        let videoProducer;
        try {
            videoProducer = await webrtcSFU.waitForProducer(roomId, 'video', 60000);
        } catch (err) {
            console.warn(`[VOD] WebRTC recording: no video producer for stream ${streamId} within timeout`);
            this.activeRecordings.delete(streamId);
            db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
            return;
        }

        // Check if stopRecording() was called while we were waiting
        const rec = this.activeRecordings.get(streamId);
        if (!rec || rec._cancelWebrtc) {
            console.log(`[VOD] WebRTC recording cancelled for stream ${streamId}`);
            this.activeRecordings.delete(streamId);
            return;
        }

        const audioProducer = webrtcSFU.findProducerByKind(roomId, 'audio');

        // Create PlainRTP consumers so mediasoup forwards media to local UDP ports
        const videoRtpPort = _allocateRecordRtpPort();
        const videoRtcpPort = videoRtpPort + 1;
        let audioRtpPort = null;
        let audioRtcpPort = null;
        let audioConsumer = null;
        let videoConsumer = null;

        try {
            videoConsumer = await webrtcSFU.createPlainConsumer(
                roomId, videoProducer.id, '127.0.0.1', videoRtpPort, videoRtcpPort
            );
            console.log(`[VOD] WebRTC recording: video consumer — PT:${videoConsumer.payloadType} port:${videoRtpPort}`);

            if (audioProducer) {
                audioRtpPort = _allocateRecordRtpPort();
                audioRtcpPort = audioRtpPort + 1;
                audioConsumer = await webrtcSFU.createPlainConsumer(
                    roomId, audioProducer.id, '127.0.0.1', audioRtpPort, audioRtcpPort
                );
                console.log(`[VOD] WebRTC recording: audio consumer — PT:${audioConsumer.payloadType} port:${audioRtpPort}`);
            }
        } catch (err) {
            console.error(`[VOD] WebRTC recording: PlainRTP consumer failed for stream ${streamId}:`, err.message);
            if (videoConsumer) {
                try { webrtcSFU.closePlainConsumer(roomId, videoConsumer.transportId); } catch {}
            }
            if (audioConsumer) {
                try { webrtcSFU.closePlainConsumer(roomId, audioConsumer.transportId); } catch {}
            }
            this.activeRecordings.delete(streamId);
            this._cleanupFailedVod(vodId, filePath);
            return;
        }

        const sdpContent = _buildRtpRecordSdp(videoConsumer, audioConsumer, videoRtpPort, videoRtcpPort, audioRtpPort, audioRtcpPort);
        const sdpPath = path.join(os.tmpdir(), `hobo-vod-${streamId}-${Date.now()}.sdp`);
        fs.writeFileSync(sdpPath, sdpContent, 'utf8');

        const diagnostics = {
            roomId,
            streamId,
            vodId,
            protocol,
            videoProducerId: videoProducer.id,
            audioProducerId: audioProducer?.id || null,
            videoConsumerId: videoConsumer.id,
            audioConsumerId: audioConsumer?.id || null,
            videoTransportId: videoConsumer.transportId,
            audioTransportId: audioConsumer?.transportId || null,
            videoPayloadType: videoConsumer.payloadType,
            audioPayloadType: audioConsumer?.payloadType || null,
            videoMimeType: videoConsumer.mimeType,
            audioMimeType: audioConsumer?.mimeType || null,
            videoClockRate: videoConsumer.clockRate,
            audioClockRate: audioConsumer?.clockRate || null,
            videoSsrc: videoConsumer.ssrc,
            audioSsrc: audioConsumer?.ssrc || null,
            videoChannels: videoConsumer.channels || null,
            audioChannels: audioConsumer?.channels || null,
            videoCodecParameters: videoConsumer.codecParameters || {},
            audioCodecParameters: audioConsumer?.codecParameters || {},
            videoRtcpFeedback: videoConsumer.rtcpFeedback || [],
            audioRtcpFeedback: audioConsumer?.rtcpFeedback || [],
            videoHeaderExtensions: videoConsumer.headerExtensions || [],
            audioHeaderExtensions: audioConsumer?.headerExtensions || [],
            ffmpegArgs: [],
        };

        const debugMode = _isVodDiagnosticsEnabled();
        const writeDiagnostics = (name, content) => {
            if (!debugMode) return;
            _writeVodDiagnosticsFile(vodId, streamId, name, content);
        };
        writeDiagnostics('rtp.json', JSON.stringify(_sanitizeDiagnosticJson(diagnostics), null, 2));
        writeDiagnostics('sdp', sdpContent);

        // Skip the master under disk pressure (webm-only) — halves the recording footprint.
        const isMasterRecording = !wopts.skipMaster && _isH264MasterRecordingSupported(videoConsumer, audioConsumer);
        const webrtcState = {
            videoTransportId: videoConsumer.transportId,
            audioTransportId: audioConsumer?.transportId || null,
            videoConsumerId: videoConsumer.id,
            audioConsumerId: audioConsumer?.id || null,
        };
        const ffmpegArgs = [
            '-y',
            '-use_wallclock_as_timestamps', '1',
            '-protocol_whitelist', 'file,rtp,udp',
            '-thread_queue_size', '2048',
            '-analyzeduration', '10000000',
            '-probesize', '5000000',
            '-avoid_negative_ts', 'make_zero',
            '-i', sdpPath,
        ];

        if (debugMode) {
            // In diagnostics mode, surface corruption instead of silently discarding it.
        } else {
            ffmpegArgs.push('-fflags', '+genpts+discardcorrupt+nobuffer+igndts');
            ffmpegArgs.push('-err_detect', 'ignore_err');
        }

        // Pin the transcoded VOD to a CONSTANT canvas. WebRTC sources (esp. screen shares)
        // can change resolution mid-stream (window resize, monitor switch, bandwidth adaptation);
        // without a fixed-size scale the VP8 encoder loses dimensional sync from that point on and
        // the rest of the VOD shears/rotates/melts. scale-to-fit + pad guarantees every output
        // frame is exactly 1920x1080, so a resolution change just gets re-fit into the same box.
        // Escape hatch: VOD_NO_NORMALIZE=1.
        const normalizeVod = process.env.VOD_NO_NORMALIZE !== '1';
        const VOD_SCALE_VF = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1';
        const libvpxVideo = [
            ...(normalizeVod ? ['-vf', VOD_SCALE_VF] : []),
            '-c:v', 'libvpx',
            '-b:v', '2000k',
            '-crf', '18',
            '-deadline', 'realtime',
            '-cpu-used', '4',
            // Keyframe every 2s → seekable WebM (see RTMP path for rationale)
            '-force_key_frames', 'expr:gte(t,n_forced*2)',
            '-g', '240',
        ];
        // Declared at function scope so it's in scope later (activeRec.masterFilePath).
        const masterPath = filePath.replace(/\.webm$/, '.master.mkv');
        if (isMasterRecording) {
            ffmpegArgs.push(
                '-map', '0',
                '-c:v', 'copy',
                '-c:a', 'copy',
                '-f', 'matroska',
                masterPath,
                '-map', '0',
                ...libvpxVideo
            );
            if (audioConsumer) {
                ffmpegArgs.push('-c:a', 'libopus', '-b:a', '128k', '-application', 'audio');
            } else {
                ffmpegArgs.push('-an');
            }
            ffmpegArgs.push('-f', 'webm', filePath);
            diagnostics.masterFilePath = path.basename(masterPath);
            diagnostics.filePath = path.basename(filePath);
        } else {
            ffmpegArgs.push(...libvpxVideo);
            if (audioConsumer) {
                ffmpegArgs.push('-c:a', 'libopus', '-b:a', '128k', '-application', 'audio');
            } else {
                ffmpegArgs.push('-an');
            }
            ffmpegArgs.push('-f', 'webm', filePath);
            diagnostics.filePath = path.basename(filePath);
        }
        diagnostics.ffmpegArgs = ffmpegArgs.slice();
        writeDiagnostics('ffmpeg-args.json', JSON.stringify(_sanitizeDiagnosticJson(diagnostics), null, 2));

        let proc;
        let ffmpegLogPath = null;
        let ffmpegLogStream = null;
        if (debugMode) {
            ffmpegLogPath = _writeVodDiagnosticsFile(vodId, streamId, 'ffmpeg.log', '');
            if (ffmpegLogPath) {
                ffmpegLogStream = fs.createWriteStream(ffmpegLogPath, { flags: 'a' });
            }
        }

        try {
            proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            console.error(`[VOD] WebRTC recording: FFmpeg spawn failed for stream ${streamId}:`, err.message);
            if (webrtcState.videoTransportId) {
                try { webrtcSFU.closePlainConsumer(roomId, webrtcState.videoTransportId); } catch {};
            }
            if (webrtcState.audioTransportId) {
                try { webrtcSFU.closePlainConsumer(roomId, webrtcState.audioTransportId); } catch {};
            }
            try { fs.unlinkSync(sdpPath); } catch {}
            this.activeRecordings.delete(streamId);
            this._cleanupFailedVod(vodId, filePath);
            if (ffmpegLogStream) ffmpegLogStream.end();
            return;
        }

        proc.stderr.on('data', (data) => {
            const line = data.toString();
            if (ffmpegLogStream) {
                ffmpegLogStream.write(line);
            }
            const recording = this.activeRecordings.get(streamId);
            _trackFfmpegDiagnostics(line, recording);
            if (debugMode) {
                if (/non-existing PPS|decode_slice_header error|concealing|RTP|max delay reached|Non-monotonous DTS|invalid|corrupt|error|timestamp/i.test(line)) {
                    console.warn(`[VOD] FFmpeg diagnostic (webrtc stream ${streamId}):`, line.trim());
                }
                return;
            }
            if (line.includes('Error') || line.includes('error')) {
                if (_isControlledFfmpegError(line, recording?._expectedShutdown)) return;
                console.error(`[VOD] FFmpeg error (webrtc stream ${streamId}):`, line.trim());
            }
        });

        proc.on('exit', (code, signal) => {
            console.log(`[VOD] FFmpeg (webrtc) exited for stream ${streamId} (code: ${code}, signal: ${signal})`);
            const activeRec = this.activeRecordings.get(streamId);
            if (activeRec) {
                if (activeRec.remuxTimer) clearInterval(activeRec.remuxTimer);
            }
            // Clean up PlainRTP consumers and SDP file
            if (webrtcState.videoTransportId) {
                try { webrtcSFU.closePlainConsumer(roomId, webrtcState.videoTransportId); } catch {}
            }
            if (webrtcState.audioTransportId) {
                try { webrtcSFU.closePlainConsumer(roomId, webrtcState.audioTransportId); } catch {}
            }
            try { fs.unlinkSync(sdpPath); } catch {}
            if (ffmpegLogStream) {
                try { ffmpegLogStream.end(); } catch {}
            }
            this.activeRecordings.delete(streamId);
            setTimeout(() => {
                const vodRoutes = require('./routes');
                vodRoutes.finalizeVodRecording(streamId).catch(err => {
                    console.error(`[VOD] Finalization failed for stream ${streamId}:`, err.message);
                });
            }, 2000);
        });

        proc.on('error', (err) => {
            console.error(`[VOD] FFmpeg spawn error (webrtc, stream ${streamId}):`, err.message);
            try { webrtcSFU.closePlainConsumer(roomId, webrtcState.videoTransportId); } catch {}
            if (webrtcState.audioTransportId) {
                try { webrtcSFU.closePlainConsumer(roomId, webrtcState.audioTransportId); } catch {}
            }
            try { fs.unlinkSync(sdpPath); } catch {}
            if (ffmpegLogStream) {
                try { ffmpegLogStream.end(); } catch {}
            }
            this.activeRecordings.delete(streamId);
            this._cleanupFailedVod(vodId, filePath);
        });

        // Update the recording entry with the live process and webrtcState
        const activeRec = this.activeRecordings.get(streamId);
        if (activeRec) {
            activeRec.process = proc;
            activeRec.webrtcState = webrtcState;
            if (isMasterRecording) {
                activeRec.masterFilePath = masterPath;
            }
            activeRec.remuxTimer = setInterval(() => this._periodicRemux(streamId), 60000);
            setTimeout(() => {
                if (this.activeRecordings.has(streamId)) this._periodicRemux(streamId);
            }, 30000);
        }

        console.log(`[VOD] WebRTC recording started: stream ${streamId} (${protocol}) → ${path.basename(filePath)}`);
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
