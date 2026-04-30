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
                ffmpegCorruptionWarnings: 0,
                _ffmpegCorrupted: false,
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

        const isMasterRecording = _isH264MasterRecordingSupported(videoConsumer, audioConsumer);
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

        if (isMasterRecording) {
            const masterPath = filePath.replace(/\.webm$/, '.master.mkv');
            ffmpegArgs.push(
                '-map', '0',
                '-c:v', 'copy',
                '-c:a', 'copy',
                '-f', 'matroska',
                masterPath,
                '-map', '0',
                '-c:v', 'libvpx',
                '-b:v', '2000k',
                '-crf', '18',
                '-deadline', 'realtime',
                '-cpu-used', '4'
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
            ffmpegArgs.push(
                '-c:v', 'libvpx',
                '-b:v', '2000k',
                '-crf', '18',
                '-deadline', 'realtime',
                '-cpu-used', '4'
            );
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
