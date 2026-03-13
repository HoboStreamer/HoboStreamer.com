/**
 * HoboStreamer — Restream Manager
 * 
 * Manages FFmpeg processes that forward live streams to external RTMP destinations
 * (YouTube, Twitch, Kick, custom RTMP). Supports RTMP, JSMPEG, and WebRTC input sources.
 * 
 * Input sources:
 *   - RTMP: Reads via HTTP-FLV from node-media-server (codec copy, zero CPU overhead)
 *   - JSMPEG: Taps relay data, pipes combined MPEG-TS → FFmpeg (re-encodes MPEG1 → H.264)
 *   - WebRTC: Consumes via Mediasoup PlainRtpTransport → FFmpeg (re-encodes VP8/Opus → H.264/AAC)
 * 
 * Architecture:
 *   Stream → Restream Manager → FFmpeg child process → External RTMP endpoint
 *   
 *   For RTMP input:   ffmpeg -i http://localhost:9935/live/{key}.flv -c copy -f flv rtmp://dest
 *   For JSMPEG input:  ffmpeg -f mpegts -i pipe:0 -c:v libx264 -preset ultrafast ... -f flv rtmp://dest
 *   For WebRTC input:  ffmpeg -protocol_whitelist file,rtp,udp -i /tmp/hobo-restream-{key}.sdp ... -f flv rtmp://dest
 */
const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');

const RESTART_BASE_DELAY = 5000;
const RESTART_MAX_DELAY = 60000;
const STABLE_THRESHOLD_MS = 30000;
const MAX_RESTART_ATTEMPTS = 10;
const FFMPEG_STARTUP_DELAY_RTMP = 3000;

/** Port range for stunnel RTMPS proxies (separate from WebRTC RTP ports) */
const STUNNEL_PORT_MIN = 30100;
const STUNNEL_PORT_MAX = 30200;

/**
 * Quality presets for restream encoding.
 * Used for JSMPEG and WebRTC sources (RTMP uses codec copy).
 * 
 * Each preset defines video/audio encoding parameters tuned for RTMP output.
 * Key design decisions:
 *   - Uses `-b:v` with CBR-like rate control (not CRF) for stable RTMP delivery
 *   - `-vsync cfr` forces constant framerate, required for RTMP
 *   - No `-tune zerolatency` — restream viewers have 5-10s buffer anyway;
 *     allowing lookahead/B-frames vastly improves compression efficiency
 *   - `-sc_threshold 0` prevents excessive keyframes on scene changes
 *   - `-bf 2` enables B-frames for better compression (compatible with all RTMP services)
 */
const QUALITY_PRESETS = {
    low: {
        label: 'Low (720p 1500k)',
        videoBitrate: '1500k',
        maxrate: '1800k',
        bufsize: '3000k',
        audioBitrate: '96k',
        preset: 'veryfast',
        scale: '1280:720',
        fps: 30,
        gop: 60,        // 2s keyframe interval at 30fps
    },
    medium: {
        label: 'Medium (720p 3000k)',
        videoBitrate: '3000k',
        maxrate: '3500k',
        bufsize: '6000k',
        audioBitrate: '128k',
        preset: 'veryfast',
        scale: '1280:720',
        fps: 30,
        gop: 60,
    },
    high: {
        label: 'High (1080p 4500k)',
        videoBitrate: '4500k',
        maxrate: '5000k',
        bufsize: '9000k',
        audioBitrate: '160k',
        preset: 'fast',
        scale: null,     // No scaling — pass through native resolution
        fps: 30,
        gop: 60,
    },
    source: {
        label: 'Source (native 6000k)',
        videoBitrate: '6000k',
        maxrate: '6500k',
        bufsize: '12000k',
        audioBitrate: '192k',
        preset: 'medium',
        scale: null,
        fps: 0,          // 0 = pass through source framerate
        gop: 60,
    },
};

/** Default preset per platform (used when quality_preset='auto') */
const PLATFORM_DEFAULT_PRESET = {
    twitch: 'medium',
    youtube: 'high',
    kick: 'medium',
    custom: 'medium',
};

class RestreamManager extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, RestreamSession>} key: `${streamId}:${destId}` */
        this.sessions = new Map();
        /** @type {number} Next available port for stunnel RTMPS proxies */
        this._nextStunnelPort = STUNNEL_PORT_MIN;
        /** @type {boolean|null} Cached result of stunnel availability check */
        this._stunnelAvailable = null;
    }

    _key(streamId, destId) {
        return `${streamId}:${destId}`;
    }

    /**
     * Start restreaming a live stream to a destination.
     * @param {number} streamId 
     * @param {object} destination - DB row from restream_destinations
     * @param {object} streamInfo - { protocol, streamKey }
     */
    async startRestream(streamId, destination, streamInfo) {
        const key = this._key(streamId, destination.id);

        // Already running?
        if (this.sessions.has(key)) {
            const existing = this.sessions.get(key);
            if (existing.status === 'live' || existing.status === 'starting') {
                console.log(`[Restream] Already active: ${key}`);
                return existing;
            }
            this._cleanup(key);
        }

        const { protocol, streamKey } = streamInfo;

        if (protocol === 'webrtc') {
            const webrtcSFU = require('./webrtc-sfu');
            if (!webrtcSFU.ready) {
                console.warn('[Restream] WebRTC → RTMP requires Mediasoup SFU. Mediasoup not available.');
                return null;
            }
        }

        const destUrl = this._buildDestUrl(destination);
        if (!destUrl) {
            console.error(`[Restream] Invalid destination URL for ${destination.platform}:${destination.id}`);
            return null;
        }

        // For RTMPS destinations, use a stunnel TLS proxy so FFmpeg connects via
        // plain RTMP to a local port (works around GnuTLS incompatibility with
        // certain RTMPS endpoints like Kick/Amazon CloudFront).
        let effectiveDestUrl = destUrl;
        let stunnelProxy = null;
        if (destUrl.startsWith('rtmps://')) {
            stunnelProxy = this._startStunnelProxy(destUrl);
            if (stunnelProxy) {
                effectiveDestUrl = stunnelProxy.localUrl;
                // Small delay for stunnel to start listening
                await new Promise(r => setTimeout(r, 500));
            } else {
                console.warn(`[Restream] stunnel not available — passing rtmps:// URL directly to FFmpeg`);
            }
        }

        const session = {
            key,
            streamId,
            destId: destination.id,
            destination,
            streamInfo,
            status: 'starting',
            process: null,
            startedAt: null,
            restartAttempts: 0,
            restartDelay: RESTART_BASE_DELAY,
            restartTimer: null,
            stableTimer: null,
            lastError: null,
            dataTapCleanup: null,
            stunnelProcess: stunnelProxy?.stunnelProcess || null,
            stunnelConf: stunnelProxy?.stunnelConf || null,
        };
        this.sessions.set(key, session);
        this.emit('status-change', { streamId, destId: destination.id, status: 'starting' });

        if (protocol === 'rtmp') {
            // Delay to let NMS HTTP-FLV endpoint be ready
            await new Promise(r => setTimeout(r, FFMPEG_STARTUP_DELAY_RTMP));
            this._startRtmpRestream(session, streamKey, effectiveDestUrl);
        } else if (protocol === 'jsmpeg') {
            this._startJsmpegRestream(session, streamKey, effectiveDestUrl);
        } else if (protocol === 'webrtc') {
            await this._startWebrtcRestream(session, effectiveDestUrl);
        } else {
            console.warn(`[Restream] Unsupported protocol: ${protocol}`);
            this._cleanup(key);
            return null;
        }

        return session;
    }

    /**
     * Build the full RTMP destination URL from server_url + stream_key.
     */
    _buildDestUrl(dest) {
        if (!dest.server_url || !dest.stream_key) return null;
        const url = dest.server_url.replace(/\/+$/, '');
        return `${url}/${dest.stream_key}`;
    }

    /**
     * Check if stunnel is available on this system.
     * Caches the result after the first check.
     */
    _isStunnelAvailable() {
        if (this._stunnelAvailable !== null) return this._stunnelAvailable;
        try {
            execSync('which stunnel', { stdio: 'ignore' });
            this._stunnelAvailable = true;
            console.log('[Restream] stunnel is available for RTMPS proxy');
        } catch {
            this._stunnelAvailable = false;
            console.warn('[Restream] stunnel not found — RTMPS destinations may fail with GnuTLS-based FFmpeg');
        }
        return this._stunnelAvailable;
    }

    /**
     * Allocate a local port for stunnel RTMPS proxy.
     */
    _allocateStunnelPort() {
        const port = this._nextStunnelPort;
        this._nextStunnelPort++;
        if (this._nextStunnelPort > STUNNEL_PORT_MAX) this._nextStunnelPort = STUNNEL_PORT_MIN;
        return port;
    }

    /**
     * For RTMPS destinations, spawn a stunnel process that accepts plain RTMP on
     * a local port and tunnels it over TLS to the remote RTMPS endpoint (using
     * OpenSSL). FFmpeg can then connect to the local port with plain `rtmp://`.
     * 
     * This works around FFmpeg's GnuTLS backend being incompatible with certain
     * RTMPS endpoints (notably Kick/Amazon CloudFront).
     * 
     * @param {string} rtmpsUrl - Full destination URL starting with `rtmps://`
     * @returns {{ localUrl: string, stunnelProcess: ChildProcess, stunnelConf: string }|null}
     */
    _startStunnelProxy(rtmpsUrl) {
        if (!this._isStunnelAvailable()) return null;

        // Parse rtmps://host:port/path → host, port (default 443), path
        const match = rtmpsUrl.match(/^rtmps:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/);
        if (!match) {
            console.warn(`[Restream] Could not parse RTMPS URL: ${rtmpsUrl.slice(0, 60)}...`);
            return null;
        }

        const remoteHost = match[1];
        const remotePort = match[2] || '443';
        const urlPath = match[3] || '/';

        const localPort = this._allocateStunnelPort();
        const confPath = path.join(os.tmpdir(), `hobo-stunnel-${localPort}.conf`);

        // Write a minimal stunnel config for a client-mode TLS tunnel
        const confContent = [
            'pid =',                          // Don't write a PID file
            'foreground = yes',               // Stay in foreground (we manage the process)
            'syslog = no',                    // Don't use syslog
            'debug = 4',                      // Warning level
            '',
            '[rtmps-proxy]',
            'client = yes',
            `accept = 127.0.0.1:${localPort}`,
            `connect = ${remoteHost}:${remotePort}`,
            `sni = ${remoteHost}`,            // Send SNI for proper TLS handshake
            'verifyChain = no',               // Don't verify — matches FFmpeg behavior
        ].join('\n');

        fs.writeFileSync(confPath, confContent, 'utf8');

        const stunnelProc = spawn('stunnel', [confPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderrBuf = '';
        stunnelProc.stderr.on('data', (d) => {
            stderrBuf += d.toString();
            if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);
        });
        stunnelProc.stdout.on('data', () => {}); // drain

        stunnelProc.on('error', (err) => {
            console.error(`[Restream] stunnel spawn error: ${err.message}`);
        });

        stunnelProc.on('close', (code) => {
            if (code && code !== 0) {
                const lastLines = stderrBuf.split('\n').filter(Boolean).slice(-3).join(' | ');
                console.warn(`[Restream] stunnel exited code=${code}: ${lastLines.slice(0, 200)}`);
            }
            try { fs.unlinkSync(confPath); } catch {}
        });

        // Build the local RTMP URL that FFmpeg will connect to
        const localUrl = `rtmp://127.0.0.1:${localPort}${urlPath}`;
        console.log(`[Restream] stunnel RTMPS proxy started — ${remoteHost}:${remotePort} → 127.0.0.1:${localPort}`);

        return { localUrl, stunnelProcess: stunnelProc, stunnelConf: confPath };
    }

    /**
     * Kill a stunnel proxy process and clean up its config file.
     */
    _killStunnelProxy(session) {
        if (session.stunnelProcess) {
            try { session.stunnelProcess.kill('SIGTERM'); } catch {}
            const proc = session.stunnelProcess;
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
            session.stunnelProcess = null;
        }
        if (session.stunnelConf) {
            try { fs.unlinkSync(session.stunnelConf); } catch {}
            session.stunnelConf = null;
        }
    }

    /**
     * Start RTMP → RTMP restream (codec copy, zero CPU overhead).
     */
    _startRtmpRestream(session, streamKey, destUrl) {
        const httpFlvPort = config.rtmp.port + 8000;
        const flvUrl = `http://127.0.0.1:${httpFlvPort}/live/${streamKey}.flv`;

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-rw_timeout', '10000000',  // 10s read/write timeout (microseconds)
            '-i', flvUrl,
            '-c', 'copy',               // Codec copy — no re-encoding
            '-f', 'flv',
            '-flvflags', 'no_duration_filesize',
            destUrl,
        ];

        this._spawnFFmpeg(session, args);
    }

    /**
     * Start JSMPEG → RTMP restream (re-encodes MPEG1 → H.264/AAC).
     * Uses data tap from jsmpeg-relay to pipe MPEG-TS data into FFmpeg stdin.
     */
    _startJsmpegRestream(session, streamKey, destUrl) {
        const jsmpegRelay = require('./jsmpeg-relay');

        const preset = this._resolvePreset(session.destination);
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-f', 'mpegts',
            '-i', 'pipe:0',             // Read combined MPEG-TS from stdin
            ...this._getEncodingArgs(preset),
            '-f', 'flv',
            '-flvflags', 'no_duration_filesize',
            destUrl,
        ];

        this._spawnFFmpeg(session, args);

        // Register data tap — both video and audio chunks go to stdin
        // MPEG-TS packets are PID-multiplexed, so interleaving video+audio is fine
        const tap = (type, chunk) => {
            if (session.process?.stdin?.writable) {
                try {
                    session.process.stdin.write(chunk);
                } catch (err) {
                    // stdin may close if FFmpeg exits — ignore
                }
            }
        };

        const registered = jsmpegRelay.registerDataTap(streamKey, tap);
        if (registered) {
            session.dataTapCleanup = () => jsmpegRelay.unregisterDataTap(streamKey, tap);
            console.log(`[Restream] JSMPEG data tap registered for ${streamKey}`);
        } else {
            console.warn(`[Restream] JSMPEG channel not found for ${streamKey} — tap will miss initial data`);
        }
    }

    /**
     * Start WebRTC → RTMP restream.
     * 
     * Flow:
     *   1. Signal the broadcaster to produce tracks into Mediasoup SFU
     *   2. Wait for video + audio producers to appear in the SFU room
     *   3. Create PlainRtpTransport consumers that send RTP to local ports
     *   4. Build an SDP file describing the RTP streams
     *   5. Spawn FFmpeg reading the SDP, re-encoding VP8/Opus → H.264/AAC, outputting RTMP
     */
    async _startWebrtcRestream(session, destUrl) {
        const webrtcSFU = require('./webrtc-sfu');
        const broadcastServer = require('./broadcast-server');

        const roomId = `stream-${session.streamId}`;

        // Step 1: If no producers yet, ask the broadcaster to produce into the SFU
        if (!webrtcSFU.hasProducers(roomId)) {
            const signaled = broadcastServer.requestSfuProduce(session.streamId);
            if (!signaled) {
                console.warn(`[Restream] WebRTC: No broadcaster connected for stream ${session.streamId}`);
                session.lastError = 'Broadcaster not connected';
                session.status = 'error';
                this.emit('status-change', {
                    streamId: session.streamId, destId: session.destId,
                    status: 'error', error: session.lastError,
                });
                this._scheduleRestart(session);
                return;
            }
            console.log(`[Restream] WebRTC: Signaled broadcaster to produce into SFU for stream ${session.streamId}`);
        }

        // Step 2: Wait for video producer (audio is optional)
        let videoProducer;
        try {
            videoProducer = await webrtcSFU.waitForProducer(roomId, 'video', 30000);
        } catch (err) {
            console.warn(`[Restream] WebRTC: ${err.message}`);
            session.lastError = 'No video producer available';
            session.status = 'error';
            this.emit('status-change', {
                streamId: session.streamId, destId: session.destId,
                status: 'error', error: session.lastError,
            });
            this._scheduleRestart(session);
            return;
        }

        // Check for audio producer (don't block on it — start without if not available)
        const audioProducer = webrtcSFU.findProducerByKind(roomId, 'audio');

        // Step 3: Allocate ports and create PlainRtpTransport consumers
        const videoRtpPort = this._allocatePort();
        const videoRtcpPort = videoRtpPort + 1;
        let audioRtpPort, audioRtcpPort;

        let videoConsumer, audioConsumer;
        try {
            videoConsumer = await webrtcSFU.createPlainConsumer(
                roomId, videoProducer.id, '127.0.0.1', videoRtpPort, videoRtcpPort
            );
            console.log(`[Restream] WebRTC: Video consumer created — PT:${videoConsumer.payloadType} SSRC:${videoConsumer.ssrc} port:${videoRtpPort}`);

            if (audioProducer) {
                audioRtpPort = this._allocatePort();
                audioRtcpPort = audioRtpPort + 1;
                audioConsumer = await webrtcSFU.createPlainConsumer(
                    roomId, audioProducer.id, '127.0.0.1', audioRtpPort, audioRtcpPort
                );
                console.log(`[Restream] WebRTC: Audio consumer created — PT:${audioConsumer.payloadType} SSRC:${audioConsumer.ssrc} port:${audioRtpPort}`);
            }
        } catch (err) {
            console.error(`[Restream] WebRTC: Failed to create PlainRTP consumers: ${err.message}`);
            // Clean up any created consumers
            if (videoConsumer) webrtcSFU.closePlainConsumer(roomId, videoConsumer.transportId);
            if (audioConsumer) webrtcSFU.closePlainConsumer(roomId, audioConsumer.transportId);
            session.lastError = err.message;
            session.status = 'error';
            this.emit('status-change', {
                streamId: session.streamId, destId: session.destId,
                status: 'error', error: session.lastError,
            });
            this._scheduleRestart(session);
            return;
        }

        // Step 4: Build SDP file
        const sdpPath = path.join(os.tmpdir(), `hobo-restream-${session.key.replace(':', '-')}.sdp`);
        const sdpContent = this._buildSdp(videoConsumer, audioConsumer, videoRtpPort, audioRtpPort);
        fs.writeFileSync(sdpPath, sdpContent, 'utf8');
        console.log(`[Restream] WebRTC: SDP written to ${sdpPath}`);

        // Store SFU state for cleanup
        session.webrtcState = {
            roomId,
            sdpPath,
            videoTransportId: videoConsumer.transportId,
            audioTransportId: audioConsumer?.transportId || null,
        };

        // Step 5: Spawn FFmpeg with SDP input → RTMP output
        const preset = this._resolvePreset(session.destination);
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-protocol_whitelist', 'file,rtp,udp',
            '-analyzeduration', '10000000',   // 10s — absorb RTP jitter during startup
            '-probesize', '10000000',          // 10MB — reliable stream detection
            '-fflags', '+genpts+discardcorrupt',
            '-i', sdpPath,
            ...this._getEncodingArgs(preset, { hasAudio: !!audioConsumer }),
            '-f', 'flv',
            '-flvflags', 'no_duration_filesize',
            destUrl,
        ];

        this._spawnFFmpeg(session, args);

        // On FFmpeg close, clean up SFU consumers + SDP
        session.dataTapCleanup = () => {
            if (session.webrtcState) {
                const { roomId: rid, videoTransportId, audioTransportId, sdpPath: sdp } = session.webrtcState;
                if (videoTransportId) webrtcSFU.closePlainConsumer(rid, videoTransportId);
                if (audioTransportId) webrtcSFU.closePlainConsumer(rid, audioTransportId);
                try { fs.unlinkSync(sdp); } catch {}
                session.webrtcState = null;
            }
        };
    }

    /**
     * Resolve quality preset for a destination.
     * @param {object} destination - DB row
     * @returns {object} Resolved preset from QUALITY_PRESETS
     */
    _resolvePreset(destination) {
        const presetKey = destination?.quality_preset || 'auto';
        if (presetKey !== 'auto' && QUALITY_PRESETS[presetKey]) {
            return QUALITY_PRESETS[presetKey];
        }
        // Auto: pick per-platform default
        const platform = destination?.platform || 'custom';
        const defaultKey = PLATFORM_DEFAULT_PRESET[platform] || 'medium';
        return QUALITY_PRESETS[defaultKey];
    }

    /**
     * Build the video + audio encoding args for FFmpeg.
     * Produces stable CBR-like H.264/AAC output suitable for RTMP ingest.
     * 
     * @param {object} preset - Resolved quality preset
     * @param {object} [opts] - { hasAudio: boolean }
     * @returns {string[]} FFmpeg args array
     */
    _getEncodingArgs(preset, opts = {}) {
        const { hasAudio = true } = opts;
        const args = [];

        // Video encoding — CBR-like rate control for stable RTMP delivery
        args.push(
            '-map', '0:v:0',
            '-c:v', 'libx264',
            '-preset', preset.preset,
            '-b:v', preset.videoBitrate,
            '-maxrate', preset.maxrate,
            '-bufsize', preset.bufsize,
            '-g', String(preset.gop),
            '-sc_threshold', '0',            // Prevent random keyframes on scene changes
            '-bf', '2',                       // B-frames — better compression; RTMP services support this
            '-pix_fmt', 'yuv420p',
            '-threads', '0',                  // Use all available CPU cores
        );

        // Optional resolution scaling
        if (preset.scale) {
            args.push('-vf', `scale=${preset.scale}:force_original_aspect_ratio=decrease,pad=${preset.scale}:(ow-iw)/2:(oh-ih)/2`);
        }

        // Constant framerate for RTMP (WebRTC/JSMPEG can send variable fps)
        if (preset.fps > 0) {
            args.push('-r', String(preset.fps), '-vsync', 'cfr');
        }

        // Audio encoding
        if (hasAudio) {
            args.push(
                '-map', '0:a:0',
                '-c:a', 'aac',
                '-b:a', preset.audioBitrate,
                '-ar', '44100',
                '-ac', '2',
            );
        }

        return args;
    }

    /**
     * Build an SDP file for FFmpeg to receive RTP from Mediasoup PlainTransport consumers.
     * @param {object} videoConsumer - Video consumer info from createPlainConsumer
     * @param {object|null} audioConsumer - Audio consumer info (nullable)
     * @param {number} videoPort - RTP port for video
     * @param {number} [audioPort] - RTP port for audio
     * @returns {string} SDP content
     */
    _buildSdp(videoConsumer, audioConsumer, videoPort, audioPort) {
        const lines = [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=HoboStreamer WebRTC Restream',
            'c=IN IP4 127.0.0.1',
            't=0 0',
        ];

        // Video media line
        const vPT = videoConsumer.payloadType;
        const vCodecName = (videoConsumer.mimeType || 'video/VP8').split('/')[1];
        lines.push(`m=video ${videoPort} RTP/AVP ${vPT}`);
        lines.push(`a=rtpmap:${vPT} ${vCodecName}/${videoConsumer.clockRate}`);
        if (videoConsumer.ssrc) {
            lines.push(`a=ssrc:${videoConsumer.ssrc} cname:restream-video`);
        }
        // Add codec parameters (e.g., profile-level-id for H264)
        if (videoConsumer.codecParameters) {
            const fmtp = Object.entries(videoConsumer.codecParameters)
                .map(([k, v]) => `${k}=${v}`).join(';');
            if (fmtp) lines.push(`a=fmtp:${vPT} ${fmtp}`);
        }
        lines.push('a=recvonly');

        // Audio media line
        if (audioConsumer && audioPort) {
            const aPT = audioConsumer.payloadType;
            const aCodecName = (audioConsumer.mimeType || 'audio/opus').split('/')[1];
            const channels = audioConsumer.channels || 2;
            lines.push(`m=audio ${audioPort} RTP/AVP ${aPT}`);
            lines.push(`a=rtpmap:${aPT} ${aCodecName}/${audioConsumer.clockRate}/${channels}`);
            if (audioConsumer.ssrc) {
                lines.push(`a=ssrc:${audioConsumer.ssrc} cname:restream-audio`);
            }
            if (audioConsumer.codecParameters) {
                const fmtp = Object.entries(audioConsumer.codecParameters)
                    .map(([k, v]) => `${k}=${v}`).join(';');
                if (fmtp) lines.push(`a=fmtp:${aPT} ${fmtp}`);
            }
            lines.push('a=recvonly');
        }

        lines.push('');
        return lines.join('\r\n');
    }

    /**
     * Allocate a pair of sequential ports for RTP/RTCP.
     * Uses even-numbered ports (RTP convention) from a rotating range.
     */
    _allocatePort() {
        if (!this._nextPort) this._nextPort = 20000;
        const port = this._nextPort;
        this._nextPort += 2;
        if (this._nextPort > 30000) this._nextPort = 20000;
        return port;
    }

    /**
     * Spawn an FFmpeg child process and monitor its lifecycle.
     */
    _spawnFFmpeg(session, args) {
        const maskedArgs = args.map(a =>
            (a.includes('rtmp://') || a.includes('rtmps://')) ? a.replace(/\/[^/]+$/, '/****') : a
        );
        console.log(`[Restream] Spawning FFmpeg for ${session.key}: ffmpeg ${maskedArgs.join(' ')}`);

        const proc = spawn('ffmpeg', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        session.process = proc;
        session.startedAt = Date.now();

        let stderrBuf = '';
        proc.stderr.on('data', (data) => {
            stderrBuf += data.toString();
            if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
        });

        proc.stdout.on('data', () => {}); // drain stdout

        proc.on('error', (err) => {
            console.error(`[Restream] FFmpeg spawn error for ${session.key}:`, err.message);
            session.lastError = err.message;
            session.status = 'error';
            this.emit('status-change', {
                streamId: session.streamId, destId: session.destId,
                status: 'error', error: err.message,
            });
            this._scheduleRestart(session);
        });

        proc.on('close', (code) => {
            if (session.status === 'stopped') return; // intentional stop

            const duration = Date.now() - (session.startedAt || Date.now());
            const lastLines = stderrBuf.split('\n').filter(Boolean).slice(-5).join(' | ');
            console.log(`[Restream] FFmpeg exited for ${session.key}: code=${code}, ran ${(duration / 1000).toFixed(1)}s`);
            if (lastLines) console.log(`[Restream]   stderr: ${lastLines.slice(0, 300)}`);

            if (code === 0) {
                session.status = 'idle';
                this.emit('status-change', {
                    streamId: session.streamId, destId: session.destId, status: 'idle',
                });
            } else {
                session.lastError = lastLines || `FFmpeg exit code ${code}`;
                session.status = 'error';
                this.emit('status-change', {
                    streamId: session.streamId, destId: session.destId,
                    status: 'error', error: session.lastError,
                });
                this._scheduleRestart(session);
            }
        });

        // Mark as live after FFmpeg has been running briefly without crashing
        setTimeout(() => {
            if (session.process === proc && session.status === 'starting') {
                session.status = 'live';
                this.emit('status-change', {
                    streamId: session.streamId, destId: session.destId, status: 'live',
                });

                // Reset backoff after stable period
                session.stableTimer = setTimeout(() => {
                    if (session.process === proc) {
                        session.restartAttempts = 0;
                        session.restartDelay = RESTART_BASE_DELAY;
                        console.log(`[Restream] Session ${session.key} stable — reset backoff`);
                    }
                }, STABLE_THRESHOLD_MS);
            }
        }, 2000);
    }

    /**
     * Schedule a restart with exponential backoff.
     */
    _scheduleRestart(session) {
        if (session.status === 'stopped') return;

        if (session.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            console.warn(`[Restream] Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached for ${session.key}`);
            session.status = 'failed';
            this.emit('status-change', {
                streamId: session.streamId, destId: session.destId,
                status: 'failed', error: session.lastError,
            });
            return;
        }

        const delay = session.restartDelay;
        session.restartDelay = Math.min(session.restartDelay * 1.5, RESTART_MAX_DELAY);
        session.restartAttempts++;

        console.log(`[Restream] Scheduling restart for ${session.key} in ${delay}ms (attempt ${session.restartAttempts}/${MAX_RESTART_ATTEMPTS})`);

        session.restartTimer = setTimeout(() => {
            session.restartTimer = null;
            if (session.status === 'stopped') return;

            // Lazy-require db to avoid circular dependency at module load
            const db = require('../db/database');

            // Re-check destination still exists and is enabled
            const dest = db.getRestreamDestinationById(session.destId);
            if (!dest || !dest.enabled) {
                console.log(`[Restream] Destination ${session.destId} disabled/deleted — not restarting`);
                this._cleanup(session.key);
                return;
            }

            // Re-check stream is still live
            const stream = db.getStreamById(session.streamId);
            if (!stream?.is_live) {
                console.log(`[Restream] Stream ${session.streamId} no longer live — not restarting`);
                this._cleanup(session.key);
                return;
            }

            const destUrl = this._buildDestUrl(dest);
            if (!destUrl) return;

            // Clean up old stunnel proxy if any
            this._killStunnelProxy(session);

            // Set up new stunnel proxy for RTMPS destinations
            let effectiveDestUrl = destUrl;
            if (destUrl.startsWith('rtmps://')) {
                const proxy = this._startStunnelProxy(destUrl);
                if (proxy) {
                    effectiveDestUrl = proxy.localUrl;
                    session.stunnelProcess = proxy.stunnelProcess;
                    session.stunnelConf = proxy.stunnelConf;
                }
            }

            session.status = 'starting';
            this.emit('status-change', {
                streamId: session.streamId, destId: session.destId, status: 'starting',
            });

            // Small delay for stunnel to start listening if it was just spawned
            const stunnelDelay = session.stunnelProcess ? 500 : 0;
            setTimeout(() => {
                if (session.status === 'stopped') return;
                if (session.streamInfo.protocol === 'rtmp') {
                    this._startRtmpRestream(session, session.streamInfo.streamKey, effectiveDestUrl);
                } else if (session.streamInfo.protocol === 'jsmpeg') {
                    this._startJsmpegRestream(session, session.streamInfo.streamKey, effectiveDestUrl);
                } else if (session.streamInfo.protocol === 'webrtc') {
                    this._startWebrtcRestream(session, effectiveDestUrl).catch(err => {
                        console.warn(`[Restream] WebRTC restart failed for ${session.key}:`, err.message);
                        session.lastError = err.message;
                        session.status = 'error';
                        this._scheduleRestart(session);
                    });
                }
            }, stunnelDelay);
        }, delay);
    }

    /**
     * Stop a specific restream.
     */
    stopRestream(streamId, destId) {
        const key = this._key(streamId, destId);
        const session = this.sessions.get(key);
        if (!session) return;

        session.status = 'stopped';
        this._killProcess(session);
        this._cleanup(key);
        this.emit('status-change', { streamId, destId, status: 'idle' });
    }

    /**
     * Stop all restreams for a stream.
     */
    stopAllForStream(streamId) {
        const stopped = [];
        for (const [key, session] of this.sessions) {
            if (session.streamId === streamId) {
                session.status = 'stopped';
                this._killProcess(session);
                stopped.push(key);
            }
        }
        for (const key of stopped) this.sessions.delete(key);
        if (stopped.length > 0) {
            console.log(`[Restream] Stopped ${stopped.length} restream(s) for stream ${streamId}`);
            this.emit('status-change', { streamId, destId: null, status: 'idle' });
        }
    }

    /**
     * Kill the FFmpeg process and clean up timers/taps.
     */
    _killProcess(session) {
        if (session.restartTimer) { clearTimeout(session.restartTimer); session.restartTimer = null; }
        if (session.stableTimer) { clearTimeout(session.stableTimer); session.stableTimer = null; }
        if (session.dataTapCleanup) { session.dataTapCleanup(); session.dataTapCleanup = null; }
        this._killStunnelProxy(session);
        if (session.process) {
            try { session.process.stdin?.end(); } catch {}
            try { session.process.kill('SIGTERM'); } catch {}
            // Force kill after 5s if SIGTERM doesn't work
            const proc = session.process;
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
            session.process = null;
        }
    }

    /**
     * Remove session from the map and clean up.
     */
    _cleanup(key) {
        const session = this.sessions.get(key);
        if (session) {
            this._killProcess(session);
        }
        this.sessions.delete(key);
    }

    /**
     * Get status of all restreams for a stream.
     * @returns {Array<{destId, status, startedAt, restartAttempts, lastError}>}
     */
    getStreamStatus(streamId) {
        const statuses = [];
        for (const [, session] of this.sessions) {
            if (session.streamId === streamId) {
                statuses.push({
                    destId: session.destId,
                    status: session.status,
                    startedAt: session.startedAt,
                    restartAttempts: session.restartAttempts,
                    lastError: session.lastError,
                });
            }
        }
        return statuses;
    }

    /**
     * Auto-start enabled restreams when a stream goes live.
     * Called by server/index.js when RTMP publishes or JSMPEG channel is created.
     * @param {number} streamId
     * @param {number} userId
     * @param {object} streamInfo - { protocol, streamKey }
     */
    async autoStartForStream(streamId, userId, streamInfo) {
        const db = require('../db/database');
        const destinations = db.getRestreamDestinationsByUserId(userId);
        if (!destinations?.length) return;

        for (const dest of destinations) {
            if (!dest.enabled || !dest.auto_start) continue;
            if (!dest.server_url || !dest.stream_key) continue;

            console.log(`[Restream] Auto-starting ${dest.platform} restream for stream ${streamId}`);
            try {
                await this.startRestream(streamId, dest, streamInfo);
            } catch (err) {
                console.warn(`[Restream] Auto-start failed for dest ${dest.id}:`, err.message);
            }
        }
    }

    /**
     * Shutdown — stop all active restreams.
     */
    stopAll() {
        console.log(`[Restream] Stopping all ${this.sessions.size} active restream(s)`);
        for (const [, session] of this.sessions) {
            session.status = 'stopped';
            this._killProcess(session);
        }
        this.sessions.clear();
    }

    /**
     * Get available quality presets for the client UI.
     * @returns {Object} presetKey → { label }
     */
    static getQualityPresets() {
        const presets = { auto: { label: 'Auto (per-platform default)' } };
        for (const [key, val] of Object.entries(QUALITY_PRESETS)) {
            presets[key] = { label: val.label };
        }
        return presets;
    }
}

module.exports = new RestreamManager();
