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

/**
 * Build an SDP string for FFmpeg to receive RTP from mediasoup PlainRTP consumers.
 */
function _buildRtpRecordSdp(videoConsumer, audioConsumer, videoPort, audioPort) {
    const lines = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=HoboStreamer VOD Recording',
        'c=IN IP4 127.0.0.1',
        't=0 0',
    ];
    const vPT = videoConsumer.payloadType;
    const vCodecName = (videoConsumer.mimeType || 'video/VP8').split('/')[1];
    lines.push(`m=video ${videoPort} RTP/AVP ${vPT}`);
    lines.push(`a=rtpmap:${vPT} ${vCodecName}/${videoConsumer.clockRate}`);
    if (videoConsumer.ssrc) lines.push(`a=ssrc:${videoConsumer.ssrc} cname:record-video`);
    if (videoConsumer.codecParameters) {
        const fmtp = Object.entries(videoConsumer.codecParameters).map(([k, v]) => `${k}=${v}`).join(';');
        if (fmtp) lines.push(`a=fmtp:${vPT} ${fmtp}`);
    }
    lines.push('a=recvonly');
    if (audioConsumer && audioPort) {
        const aPT = audioConsumer.payloadType;
        const aCodecName = (audioConsumer.mimeType || 'audio/opus').split('/')[1];
        const channels = audioConsumer.channels || 2;
        lines.push(`m=audio ${audioPort} RTP/AVP ${aPT}`);
        lines.push(`a=rtpmap:${aPT} ${aCodecName}/${audioConsumer.clockRate}/${channels}`);
        if (audioConsumer.ssrc) lines.push(`a=ssrc:${audioConsumer.ssrc} cname:record-audio`);
        if (audioConsumer.codecParameters) {
            const fmtp = Object.entries(audioConsumer.codecParameters).map(([k, v]) => `${k}=${v}`).join(';');
            if (fmtp) lines.push(`a=fmtp:${aPT} ${fmtp}`);
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
     * @param {string} protocol - 'rtmp', 'jsmpeg', 'webrtc', 'browser', 'screen', 'whip'
     * @param {{ streamKey?: string, videoPort?: number }} endpoint
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
            });
            this._startWebrtcRecording(streamId, vodId, filePath, timestamp, protocol).catch(err => {
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
                const recording = this.activeRecordings.get(streamId);
                if (line.includes('Error') || line.includes('error')) {
                    if (_isControlledFfmpegError(line, recording?._expectedShutdown)) return;
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
                vodId,
                startTime: timestamp,
                ws: null,
                remuxTimer: null,
                _expectedShutdown: false,
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
            // WebRTC recording startup was still pending — just delete and finalize
            this.activeRecordings.delete(streamId);
            return;
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
     * Start recording a WebRTC/WHIP/browser stream via mediasoup PlainRTP consumers → FFmpeg.
     * Waits up to 60s for producers to appear in the SFU room, then starts FFmpeg.
     */
    async _startWebrtcRecording(streamId, vodId, filePath, startTime, protocol) {
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
        let audioRtpPort, audioConsumer, videoConsumer;

        try {
            videoConsumer = await webrtcSFU.createPlainConsumer(
                roomId, videoProducer.id, '127.0.0.1', videoRtpPort, videoRtcpPort
            );
            console.log(`[VOD] WebRTC recording: video consumer — PT:${videoConsumer.payloadType} port:${videoRtpPort}`);

            if (audioProducer) {
                audioRtpPort = _allocateRecordRtpPort();
                const audioRtcpPort = audioRtpPort + 1;
                audioConsumer = await webrtcSFU.createPlainConsumer(
                    roomId, audioProducer.id, '127.0.0.1', audioRtpPort, audioRtcpPort
                );
                console.log(`[VOD] WebRTC recording: audio consumer — PT:${audioConsumer.payloadType} port:${audioRtpPort}`);
            }
        } catch (err) {
            console.error(`[VOD] WebRTC recording: PlainRTP consumer failed for stream ${streamId}:`, err.message);
            if (videoConsumer) webrtcSFU.closePlainConsumer(roomId, videoConsumer.transportId);
            this.activeRecordings.delete(streamId);
            db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
            return;
        }

        const sdpContent = _buildRtpRecordSdp(videoConsumer, audioConsumer, videoRtpPort, audioRtpPort);
        const sdpPath = path.join(os.tmpdir(), `hobo-vod-${streamId}-${Date.now()}.sdp`);
        fs.writeFileSync(sdpPath, sdpContent, 'utf8');

        const webrtcState = {
            roomId,
            sdpPath,
            videoTransportId: videoConsumer.transportId,
            audioTransportId: audioConsumer?.transportId || null,
        };

        const ffmpegArgs = [
            '-y',
            '-protocol_whitelist', 'file,rtp,udp',
            '-thread_queue_size', '2048',
            '-analyzeduration', '10000000',   // 10s — gives ICE time to establish before giving up
            '-probesize', '5000000',
            '-use_wallclock_as_timestamps', '1',
            '-fflags', '+genpts+discardcorrupt+nobuffer+igndts',
            '-err_detect', 'ignore_err',
            '-i', sdpPath,
            '-c:v', 'libvpx',
            '-b:v', '2000k',
            '-crf', '18',
            '-deadline', 'realtime',
            '-cpu-used', '4',
            ...(audioConsumer ? ['-c:a', 'libvorbis', '-b:a', '128k'] : ['-an']),
            '-f', 'webm',
            filePath,
        ];

        let proc;
        try {
            proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            console.error(`[VOD] WebRTC recording: FFmpeg spawn failed for stream ${streamId}:`, err.message);
            webrtcSFU.closePlainConsumer(roomId, webrtcState.videoTransportId);
            if (webrtcState.audioTransportId) webrtcSFU.closePlainConsumer(roomId, webrtcState.audioTransportId);
            try { fs.unlinkSync(sdpPath); } catch {}
            this.activeRecordings.delete(streamId);
            db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
            return;
        }

        proc.stderr.on('data', (data) => {
            const line = data.toString();
            const recording = this.activeRecordings.get(streamId);
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
            try { webrtcSFU.closePlainConsumer(roomId, webrtcState.videoTransportId); } catch {}
            if (webrtcState.audioTransportId) {
                try { webrtcSFU.closePlainConsumer(roomId, webrtcState.audioTransportId); } catch {}
            }
            try { fs.unlinkSync(sdpPath); } catch {}
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
            this.activeRecordings.delete(streamId);
            db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
        });

        // Update the recording entry with the live process and webrtcState
        const activeRec = this.activeRecordings.get(streamId);
        if (activeRec) {
            activeRec.process = proc;
            activeRec.webrtcState = webrtcState;
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
