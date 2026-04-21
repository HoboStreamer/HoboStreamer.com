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
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');

const RESTART_BASE_DELAY = 5000;
const RESTART_MAX_DELAY = 120000;          // 2 min cap (was 60s — too aggressive for persistent outages)
const STABLE_THRESHOLD_MS = 30000;
const MAX_RESTART_ATTEMPTS = 30;           // 30 attempts (was 10 — too few for Twitch connection storms)
const FFMPEG_STARTUP_DELAY_RTMP = 3000;
const RAPID_CRASH_THRESHOLD_MS = 5000;     // If FFmpeg exits within this, apply extra backoff
const LIVE_OUTPUT_BUFFER_MS = 1000;

/**
 * Path to a static FFmpeg binary built with OpenSSL (not GnuTLS).
 * GnuTLS has a known issue where long-running TLS sessions get "invalidated"
 * during rekeying against certain CDN servers (especially AWS CloudFront,
 * which Kick uses). Using an OpenSSL-based binary avoids this completely.
 * Falls back to system ffmpeg if the static binary doesn't exist.
 */
const OPENSSL_FFMPEG_PATH = path.join(__dirname, '../../bin/ffmpeg');

/**
 * Quality presets for restream encoding.
 * Used for JSMPEG and WebRTC sources (RTMP uses codec copy).
 * 
 * Each preset defines video/audio encoding parameters tuned for RTMP output.
 * Key design decisions:
 *   - Uses `-b:v` with CBR-like rate control (not CRF) for stable RTMP delivery
 *   - `-tune zerolatency` — essential for real-time WebRTC/JSMPEG input; eliminates
 *     encoder stalls from lookahead buffering on jittery source data. B-frames are
 *     disabled (implicit with zerolatency) as they add reordering latency.
 *   - `-vsync cfr` forces constant framerate, required for RTMP
 *   - `-sc_threshold 0` prevents excessive keyframes on scene changes
 *   - `nal-hrd=cbr` produces truly CBR output for optimal RTMP ingest compatibility
 *   - `-flags +cgop` — closed GOPs for clean segment boundaries
 *   - `-thread_queue_size` on input prevents demuxer blocking (video/audio interleave)
 *   - `-max_muxing_queue_size` on output prevents FLV muxer stalls
 *
 * Per-destination overrides (custom_video_bitrate, custom_audio_bitrate, custom_fps)
 * are applied on top of the resolved preset to allow fine-tuning without changing preset.
 */
const QUALITY_PRESETS = {
    low: {
        label: 'Low (720p 1500k)',
        videoBitrate: '1500k',
        maxrate: '1800k',
        bufsize: '3000k',
        audioBitrate: '96k',
        preset: 'ultrafast',       // ultrafast: ~50% less CPU than veryfast — critical for multi-dest servers
        scale: '1280:720',
        fps: 30,
        gop: 60,        // 2s keyframe interval at 30fps
    },
    medium: {
        label: 'Medium (720p 2500k)',
        videoBitrate: '2500k',
        maxrate: '3000k',
        bufsize: '5000k',
        audioBitrate: '128k',
        preset: 'ultrafast',       // ultrafast: stream stability > marginal quality gain from veryfast
        scale: '1280:720',
        fps: 30,
        gop: 60,
    },
    high: {
        label: 'High (720p 4000k)',
        videoBitrate: '4000k',
        maxrate: '4500k',
        bufsize: '8000k',
        audioBitrate: '160k',
        preset: 'superfast',       // superfast: good balance for single-dest or beefier servers
        scale: '1280:720',
        fps: 30,
        gop: 60,
    },
    ultra: {
        label: 'Ultra (1080p 6000k)',
        videoBitrate: '6000k',
        maxrate: '6500k',
        bufsize: '12000k',
        audioBitrate: '192k',
        preset: 'veryfast',
        scale: null,     // No scaling — pass through native resolution
        fps: 30,
        gop: 60,
    },
    source: {
        label: 'Source (native 8000k)',
        videoBitrate: '8000k',
        maxrate: '8500k',
        bufsize: '16000k',
        audioBitrate: '192k',
        preset: 'fast',
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

/** Allowed encoder presets (exposed in UI for custom override) */
const ENCODER_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];

class RestreamManager extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, RestreamSession>} key: `${streamId}:${destId}` */
        this.sessions = new Map();
        this._sfuListenerBound = false;
        /** @type {Map<number, { count: number|null, fetchedAt: number }>} destId → cached viewer count */
        this._viewerCountCache = new Map();
        this._viewerPollTimer = null;
        /** Twitch Helix App Access Token cache */
        this._twitchToken = null;
        this._twitchTokenExpiry = 0;
        /** Kick Dev API App Access Token cache */
        this._kickToken = null;
        this._kickTokenExpiry = 0;
    }

    /**
     * Bind to the WebRTC SFU's producer-removed event.
     * Called lazily on first WebRTC restream start to avoid require-time circular deps.
     * When a producer dies (broadcaster disconnect/reconnect), all restream sessions
     * consuming from that room are killed and restarted so they pick up the new producer.
     */
    _bindSfuEvents() {
        if (this._sfuListenerBound) return;
        this._sfuListenerBound = true;

        const webrtcSFU = require('./webrtc-sfu');
        webrtcSFU.on('producer-removed', ({ roomId, producerId, kind }) => {
            if (kind !== 'video') return; // Only restart on video producer loss
            this._handleProducerRemoved(roomId, producerId);
        });
    }

    /**
     * Handle a video producer being removed from the SFU.
     * Kills all WebRTC restream sessions for the affected room and schedules restarts
     * so they re-create consumers from the new producer.
     */
    _handleProducerRemoved(roomId, producerId) {
        // roomId format: 'stream-{streamId}'
        const streamIdMatch = roomId.match(/^stream-(\d+)$/);
        if (!streamIdMatch) return;
        const streamId = parseInt(streamIdMatch[1], 10);

        let restarted = 0;
        for (const [key, session] of this.sessions) {
            if (session.streamId !== streamId) continue;
            if (session.streamInfo?.protocol !== 'webrtc') continue;
            if (session.status === 'stopped') continue;

            console.log(`[Restream] Producer removed in ${roomId} — restarting ${key}`);
            // Kill current FFmpeg (it's receiving no data anyway)
            this._killProcess(session);
            session.status = 'error';
            session.lastError = 'Source producer reconnected';
            // Reset backoff so restart is quick
            session.restartAttempts = 0;
            session.restartDelay = RESTART_BASE_DELAY;
            this._scheduleRestart(session);
            restarted++;
        }
        if (restarted > 0) {
            console.log(`[Restream] Restarting ${restarted} WebRTC restream(s) for stream ${streamId} after producer change`);
        }
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

        // Already running for this exact stream+dest?
        if (this.sessions.has(key)) {
            const existing = this.sessions.get(key);
            if (existing.status === 'live' || existing.status === 'starting') {
                console.log(`[Restream] Already active: ${key}`);
                return existing;
            }
            this._cleanup(key);
        }

        // Check if another stream is already restreaming to the same destination.
        // Two streams pushing to the same RTMP ingest causes platform disconnects.
        for (const [, session] of this.sessions) {
            if (session.destId === destination.id && session.streamId !== streamId
                && (session.status === 'live' || session.status === 'starting')) {
                console.log(`[Restream] Destination ${destination.id} already active on stream ${session.streamId}, skipping for stream ${streamId}`);
                return session;
            }
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
        };
        this.sessions.set(key, session);
        this.emit('status-change', { streamId, destId: destination.id, status: 'starting' });

        if (protocol === 'rtmp') {
            // Delay to let NMS HTTP-FLV endpoint be ready
            await new Promise(r => setTimeout(r, FFMPEG_STARTUP_DELAY_RTMP));
            this._startRtmpRestream(session, streamKey, destUrl);
        } else if (protocol === 'jsmpeg') {
            this._startJsmpegRestream(session, streamKey, destUrl);
        } else if (protocol === 'webrtc') {
            await this._startWebrtcRestream(session, destUrl);
        } else {
            console.warn(`[Restream] Unsupported protocol: ${protocol}`);
            this._cleanup(key);
            return null;
        }

        return session;
    }

    /**
     * Build the full RTMP destination URL from server_url + stream_key.
     * Auto-corrects known platform URL issues (e.g. Kick requires /app path).
     */
    _buildDestUrl(dest) {
        if (!dest.server_url || !dest.stream_key) return null;
        let url = dest.server_url.replace(/\/+$/, '');

        // Twitch is much more stable over RTMPS. Normalize old RTMP configs
        // transparently so existing saved destinations don't need manual edits.
        if (dest.platform === 'twitch' && url.startsWith('rtmp://')) {
            url = url.replace(/^rtmp:\/\//, 'rtmps://');
        }

        // Kick ingest URLs require /app path — auto-add if missing.
        // Without /app, the RTMP handshake sends the wrong app name and Kick
        // closes the connection immediately after TLS (looks like a TLS error).
        if (dest.platform === 'kick' && !url.endsWith('/app')) {
            console.log(`[Restream] Auto-adding /app to Kick server URL`);
            url += '/app';
        }

        return `${url}/${dest.stream_key}`;
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
            '-fflags', '+nobuffer+discardcorrupt',
            '-muxdelay', '0',
            '-muxpreload', '0',
            '-flush_packets', '1',
            '-rtmp_live', 'live',
            '-rtmp_buffer', '2000',      // 2s output buffer — absorbs input jitter
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
        const customOverrides = this._getCustomOverrides(session.destination);
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-thread_queue_size', '1024',
            '-f', 'mpegts',
            '-i', 'pipe:0',             // Read combined MPEG-TS from stdin
            ...this._getEncodingArgs(preset, { customOverrides }),
            '-muxdelay', '0',
            '-muxpreload', '0',
            '-flush_packets', '1',
            '-rtmp_live', 'live',
            '-rtmp_buffer', '2000',
            '-max_muxing_queue_size', '4096',
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

        // Bind to producer lifecycle events (lazy, once)
        this._bindSfuEvents();

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
        const customOverrides = this._getCustomOverrides(session.destination);
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-protocol_whitelist', 'file,rtp,udp',
            '-thread_queue_size', '2048',      // Prevent input queue blocking (video+audio demux interleave)
            '-analyzeduration', '5000000',     // 5s — give more time for jittery RTP to stabilize
            '-probesize', '5000000',           // 5MB — handle missed packets and late arrivals
            '-max_delay', '500000',            // 500ms max delay for packet reordering
            '-reorder_queue_size', '200',      // Allow reordering up to 200 packets before stalling
            '-use_wallclock_as_timestamps', '1',
            '-fflags', '+genpts+discardcorrupt+nobuffer+igndts',
            '-err_detect', 'ignore_err',       // Don't bail on corrupt RTP packets (missed packets → partial frames)
            '-avoid_negative_ts', 'make_zero', // Handle timestamp resets from packet gaps gracefully
            '-i', sdpPath,
            ...this._getEncodingArgs(preset, { hasAudio: !!audioConsumer, customOverrides }),
            '-muxdelay', '0',
            '-muxpreload', '0',
            '-flush_packets', '1',
            '-rtmp_live', 'live',
            '-rtmp_buffer', '2000',            // 2s output buffer (was 1s) — absorbs input jitter
            '-max_muxing_queue_size', '4096',  // Prevent FLV muxer stalls from interleave gaps
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
     * Extract per-destination custom overrides from DB row.
     * These override the preset values for fine-tuning without changing preset.
     * @param {object} destination - DB row
     * @returns {object} Override fields (only those that are set)
     */
    _getCustomOverrides(destination) {
        const overrides = {};
        if (destination?.custom_video_bitrate && Number.isFinite(Number(destination.custom_video_bitrate))) {
            overrides.videoBitrate = `${destination.custom_video_bitrate}k`;
        }
        if (destination?.custom_audio_bitrate && Number.isFinite(Number(destination.custom_audio_bitrate))) {
            overrides.audioBitrate = `${destination.custom_audio_bitrate}k`;
        }
        if (destination?.custom_fps && Number.isFinite(Number(destination.custom_fps)) && destination.custom_fps > 0) {
            overrides.fps = Number(destination.custom_fps);
        }
        if (destination?.custom_encoder_preset && ENCODER_PRESETS.includes(destination.custom_encoder_preset)) {
            overrides.encoderPreset = destination.custom_encoder_preset;
        }
        return overrides;
    }

    /**
     * Build the video + audio encoding args for FFmpeg.
     * Produces stable CBR H.264/AAC output suitable for RTMP ingest.
     * Uses `-tune zerolatency` to prevent encoder stalls on jittery real-time input.
     * 
     * @param {object} preset - Resolved quality preset
     * @param {object} [opts] - { hasAudio: boolean, customOverrides: object }
     * @returns {string[]} FFmpeg args array
     */
    _getEncodingArgs(preset, opts = {}) {
        const { hasAudio = true, customOverrides = {} } = opts;
        const args = [];

        // Apply custom overrides on top of preset
        const videoBitrate = customOverrides.videoBitrate || preset.videoBitrate;
        const audioBitrate = customOverrides.audioBitrate || preset.audioBitrate;
        const fps = customOverrides.fps || preset.fps;
        const encoderPreset = customOverrides.encoderPreset || preset.preset;

        // Compute maxrate/bufsize relative to video bitrate (if custom bitrate overridden)
        let maxrate = videoBitrate;
        let bufsize = preset.bufsize;
        if (customOverrides.videoBitrate) {
            const kbps = parseInt(customOverrides.videoBitrate, 10);
            maxrate = `${kbps}k`;
            bufsize = `${kbps * 2}k`;
        }

        // Video encoding — CBR with zerolatency for stable real-time RTMP delivery
        args.push(
            '-map', '0:v:0',
            '-c:v', 'libx264',
            '-preset', encoderPreset,
            '-tune', 'zerolatency',          // Eliminates lookahead buffering; critical for jittery real-time input
            '-b:v', videoBitrate,
            '-minrate', videoBitrate,
            '-maxrate', maxrate,
            '-bufsize', bufsize,
            '-g', String(preset.gop),
            '-keyint_min', String(preset.gop), // Consistent keyframe intervals (min = max)
            '-sc_threshold', '0',            // Prevent random keyframes on scene changes
            '-flags', '+cgop',               // Closed GOPs — clean segment boundaries for RTMP ingest
            '-pix_fmt', 'yuv420p',
            '-threads', '2',                  // Cap per-process threads — prevents N encodes from fighting over all cores
            '-x264-params', 'nal-hrd=cbr:force-cfr=1',   // Truly CBR output for RTMP service compatibility
        );

        // Optional resolution scaling
        if (preset.scale) {
            args.push('-vf', `scale=${preset.scale}:force_original_aspect_ratio=decrease,pad=${preset.scale}:(ow-iw)/2:(oh-ih)/2`);
        }

        // Constant framerate for RTMP (WebRTC/JSMPEG can send variable fps)
        if (fps > 0) {
            args.push('-r', String(fps), '-fps_mode', 'cfr');
        }

        // Audio encoding
        if (hasAudio) {
            // Kick requires 48000 Hz sample rate; use it for all platforms (universally compatible)
            args.push(
                '-map', '0:a:0',
                '-c:a', 'aac',
                '-b:a', audioBitrate,
                '-ar', '48000',
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
     * Automatically uses the OpenSSL-based static FFmpeg for RTMPS destinations
     * to avoid GnuTLS TLS session invalidation issues.
     */
    _spawnFFmpeg(session, args) {
        this._disposeTransientSessionState(session);

        // Use OpenSSL FFmpeg binary for RTMPS destinations (GnuTLS has TLS rekeying issues)
        const destUrl = args[args.length - 1] || '';
        const isRtmps = destUrl.startsWith('rtmps://');
        const useOpenSslBinary = isRtmps && fs.existsSync(OPENSSL_FFMPEG_PATH);
        const ffmpegBin = useOpenSslBinary ? OPENSSL_FFMPEG_PATH : 'ffmpeg';

        if (isRtmps && !useOpenSslBinary) {
            console.warn(`[Restream] RTMPS destination but OpenSSL FFmpeg not found at ${OPENSSL_FFMPEG_PATH} — using system ffmpeg (GnuTLS TLS rekeying issues likely)`);
        }

        const maskedArgs = args.map(a =>
            (a.includes('rtmp://') || a.includes('rtmps://')) ? a.replace(/\/[^/]+$/, '/****') : a
        );
        const binLabel = useOpenSslBinary ? 'ffmpeg(openssl)' : 'ffmpeg';
        console.log(`[Restream] Spawning FFmpeg for ${session.key}: ${binLabel} ${maskedArgs.join(' ')}`);

        const proc = spawn(ffmpegBin, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        session.process = proc;
        session.startedAt = Date.now();

        let stderrBuf = '';
        let liveConfirmed = false;

        const confirmLive = () => {
            if (liveConfirmed) return;
            if (session.process !== proc || session.status !== 'starting') return;
            liveConfirmed = true;

            session.status = 'live';
            this.emit('status-change', {
                streamId: session.streamId, destId: session.destId, status: 'live',
            });

            // Reset backoff after stable period
            session.stableTimer = setTimeout(() => {
                if (session.process === proc && session.status === 'live') {
                    session.restartAttempts = 0;
                    session.restartDelay = RESTART_BASE_DELAY;
                    console.log(`[Restream] Session ${session.key} stable — reset backoff`);
                }
            }, STABLE_THRESHOLD_MS);
        };

        proc.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderrBuf += chunk;
            if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);

            // FFmpeg prints "Output #0" when it opens the output and "frame=" when encoding frames.
            // Either one confirms the RTMP connection is alive.
            if (!liveConfirmed && (chunk.includes('Output #0') || chunk.includes('frame='))) {
                confirmLive();
            }
        });

        proc.stdout.on('data', () => {}); // drain stdout

        proc.on('error', (err) => {
            this._disposeTransientSessionState(session, proc);
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
            this._disposeTransientSessionState(session, proc);
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

        // Fallback: if stderr parsing hasn't confirmed live after 15s and FFmpeg is
        // still running, assume it's connected (some FFmpeg builds suppress output)
        setTimeout(() => {
            if (!liveConfirmed && session.process === proc && session.status === 'starting') {
                console.log(`[Restream] Fallback live confirmation for ${session.key} (no stderr signal after 15s)`);
                confirmLive();
            }
        }, 15000);
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

        // Rapid-crash detection: if FFmpeg died within 5s, it likely can't connect at all.
        // Apply extra backoff to avoid hammering the ingest server (which can trigger IP bans).
        const runtime = Date.now() - (session.startedAt || Date.now());
        if (runtime < RAPID_CRASH_THRESHOLD_MS) {
            session.restartDelay = Math.min(session.restartDelay * 2, RESTART_MAX_DELAY);
        }

        const delay = session.restartDelay;
        session.restartDelay = Math.min(session.restartDelay * 1.5, RESTART_MAX_DELAY);
        session.restartAttempts++;

        console.log(`[Restream] Scheduling restart for ${session.key} in ${(delay / 1000).toFixed(1)}s (attempt ${session.restartAttempts}/${MAX_RESTART_ATTEMPTS}, ran ${(runtime / 1000).toFixed(1)}s)`);

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

            session.status = 'starting';
            this.emit('status-change', {
                streamId: session.streamId, destId: session.destId, status: 'starting',
            });

            if (session.streamInfo.protocol === 'rtmp') {
                this._startRtmpRestream(session, session.streamInfo.streamKey, destUrl);
            } else if (session.streamInfo.protocol === 'jsmpeg') {
                this._startJsmpegRestream(session, session.streamInfo.streamKey, destUrl);
            } else if (session.streamInfo.protocol === 'webrtc') {
                this._startWebrtcRestream(session, destUrl).catch(err => {
                    console.warn(`[Restream] WebRTC restart failed for ${session.key}:`, err.message);
                    session.lastError = err.message;
                    session.status = 'error';
                    this._scheduleRestart(session);
                });
            }
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
     * Clear per-run resources after an FFmpeg exit/error without removing the session.
     * This prevents stale stable timers, leaked JSMPEG taps, and leaked WebRTC
     * PlainRtpTransport consumers from surviving into restart attempts.
     */
    _disposeTransientSessionState(session, proc = null) {
        if (session.stableTimer) {
            clearTimeout(session.stableTimer);
            session.stableTimer = null;
        }

        if (proc && session.process && session.process !== proc) return;

        if (session.dataTapCleanup) {
            try { session.dataTapCleanup(); } catch {}
            session.dataTapCleanup = null;
        }

        if (proc) {
            try { proc.stdin?.destroy(); } catch {}
            try { proc.stdout?.destroy(); } catch {}
            try { proc.stderr?.destroy(); } catch {}
        }

        if (!proc || session.process === proc) {
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

    // ── Viewer Count Polling ─────────────────────────────────

    /**
     * Get a cached viewer count for a destination.
     * Returns the count if fresh (<180s), otherwise null.
     */
    getCachedViewerCount(destId) {
        const cached = this._viewerCountCache.get(destId);
        if (!cached || Date.now() - cached.fetchedAt > 180000) return null;
        return cached.count;
    }

    /**
     * Check if a platform has confirmed the restream is actually live.
     * Returns true/false if we have a recent signal, null if unknown.
     */
    isPlatformLive(destId) {
        const cached = this._viewerCountCache.get(destId);
        if (!cached || Date.now() - cached.fetchedAt > 180000) return null;
        if (cached.platformLive != null) return cached.platformLive;
        return null;
    }

    /**
     * Set viewer count from an external source (e.g. broadcaster client-side polling).
     */
    setViewerCount(destId, count, platformLive) {
        const existing = this._viewerCountCache.get(destId);
        this._viewerCountCache.set(destId, {
            count,
            fetchedAt: Date.now(),
            // Preserve existing platformLive if not explicitly provided
            platformLive: platformLive != null ? platformLive : (existing?.platformLive ?? null),
        });
    }

    /**
     * Get total external viewer count for a user across all active restream destinations.
     * Returns { total, breakdown: [{ platform, name, count }] }
     * count is null when the platform is live but viewer count is unavailable.
     */
    getExternalViewerCountsForUser(userId) {
        const db = require('../db/database');
        const dests = db.getRestreamDestinationsByUserId(userId) || [];
        const breakdown = [];
        let total = 0;
        for (const d of dests) {
            if (!d.enabled) continue;
            const count = this.getCachedViewerCount(d.id);
            const platformLive = this.isPlatformLive(d.id);
            if (count != null && count > 0) {
                breakdown.push({ platform: d.platform, name: d.name || d.platform, count, destId: d.id });
                total += count;
            } else if (platformLive === true) {
                // Platform is live but viewer count is unavailable (e.g. Kick without OAuth, YouTube)
                breakdown.push({ platform: d.platform, name: d.name || d.platform, count: null, destId: d.id });
            }
        }
        return { total, breakdown };
    }

    getViewerPollingConfig() {
        const db = require('../db/database');
        const hasKickApi = !!(db.getSetting('kick_client_id') && db.getSetting('kick_client_secret'));
        const hasYoutubeApi = !!db.getSetting('youtube_api_key');
        return {
            kick: {
                serverFetchEnabled: hasKickApi,
            },
            youtube: {
                serverFetchEnabled: hasYoutubeApi,
            },
        };
    }

    /**
     * Start periodic viewer count polling for active restream destinations.
     * Called from server/index.js on startup.
     */
    startViewerCountPolling() {
        if (this._viewerPollTimer) return;
        this._viewerPollTimer = setInterval(() => this._pollViewerCounts(), 60000);
        // Initial poll after short delay
        setTimeout(() => this._pollViewerCounts(), 5000);
    }

    stopViewerCountPolling() {
        if (this._viewerPollTimer) {
            clearInterval(this._viewerPollTimer);
            this._viewerPollTimer = null;
        }
    }

    /**
     * Poll viewer counts for all active restream destinations.
     */
    async _pollViewerCounts() {
        const db = require('../db/database');
        const chatRelayService = require('../integrations/chat-relay-service');
        const activeDests = new Set();

        for (const [, session] of this.sessions) {
            if (session.status === 'live' || session.status === 'starting') {
                activeDests.add(session.destId);
            }
        }

        if (activeDests.size === 0) return;

        // Get destination details from DB
        for (const destId of activeDests) {
            try {
                const dest = db.getRestreamDestinationById(destId);
                if (!dest?.channel_url) continue;

                let count = null;
                let platformLive = null;
                if (dest.platform === 'kick') {
                    // Primary: Kick official API (requires client_id + client_secret)
                    if (this.getViewerPollingConfig().kick.serverFetchEnabled) {
                        const result = await this._fetchKickViewerCount(dest.channel_url);
                        if (result != null) {
                            count = result.count;
                            platformLive = result.platformLive;
                        }
                    }
                    // Fallback: chat relay Pusher viewer count
                    if (count == null) {
                        count = chatRelayService.getViewerCount(destId);
                        platformLive = chatRelayService.getPlatformLive(destId);
                        if (count != null && platformLive == null) platformLive = true;
                    }
                } else if (dest.platform === 'twitch') {
                    // Twitch Helix API — returns { count, platformLive }
                    const result = await this._fetchTwitchViewerCount(dest.channel_url);
                    if (result != null) {
                        count = result.count;
                        platformLive = result.platformLive;
                    }
                } else if (dest.platform === 'youtube') {
                    if (this.getViewerPollingConfig().youtube.serverFetchEnabled) {
                        const result = await this._fetchYouTubeViewerCount(dest.channel_url);
                        if (result != null) {
                            count = result.count;
                            platformLive = result.platformLive;
                        }
                    }
                }

                // Update cache with count AND platform live status
                const now = Date.now();
                if (count != null || platformLive != null) {
                    const existing = this._viewerCountCache.get(destId);
                    this._viewerCountCache.set(destId, {
                        count: count ?? existing?.count ?? null,
                        fetchedAt: now,
                        platformLive,
                    });
                } else {
                    // If there's no existing cache entry at all, set null so getCachedViewerCount returns null
                    if (!this._viewerCountCache.has(destId)) {
                        this._viewerCountCache.set(destId, { count: null, fetchedAt: now, platformLive: null });
                    }
                }
            } catch (e) {
                // Silent — don't spam logs for polling failures
            }
        }

        // Clean stale entries for no-longer-active destinations
        for (const [destId] of this._viewerCountCache) {
            if (!activeDests.has(destId)) {
                this._viewerCountCache.delete(destId);
            }
        }
    }

    /**
     * Get a Kick App Access Token via Client Credentials grant.
     * Uses the official Kick Developer API (https://docs.kick.com).
     * Caches the token and refreshes 5 minutes before expiry.
     * @returns {Promise<{accessToken: string}|null>}
     */
    async _getKickToken() {
        const db = require('../db/database');
        const clientId = db.getSetting('kick_client_id');
        const clientSecret = db.getSetting('kick_client_secret');
        if (!clientId || !clientSecret) return null;

        // Return cached token if still valid (5 min buffer)
        if (this._kickToken && Date.now() < this._kickTokenExpiry - 300000) {
            return { accessToken: this._kickToken };
        }

        const https = require('https');
        return new Promise((resolve) => {
            const body = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
            const req = https.request('https://id.kick.com/oauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
                timeout: 8000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        console.warn(`[Restream] Kick token request failed: HTTP ${res.statusCode}`);
                        return resolve(null);
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.access_token) {
                            this._kickToken = parsed.access_token;
                            this._kickTokenExpiry = Date.now() + (parsed.expires_in || 7200) * 1000;
                            resolve({ accessToken: parsed.access_token });
                        } else {
                            resolve(null);
                        }
                    } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    }

    /**
     * Fetch viewer count from the official Kick API.
     * GET https://api.kick.com/public/v1/channels?slug[]={slug}
     * @param {string} channelUrl - e.g. https://kick.com/HoboStreamer?chatroom=123
     * @returns {Promise<{count: number, platformLive: boolean}|null>}
     */
    async _fetchKickViewerCount(channelUrl) {
        const https = require('https');
        try {
            const url = new URL(channelUrl);
            const slug = url.pathname.split('/').filter(Boolean)[0];
            if (!slug) return null;

            const auth = await this._getKickToken();
            if (!auth) return null;

            return new Promise((resolve) => {
                const reqUrl = `https://api.kick.com/public/v1/channels?slug[]=${encodeURIComponent(slug)}`;
                const req = https.get(reqUrl, {
                    headers: {
                        'Authorization': `Bearer ${auth.accessToken}`,
                        'Accept': 'application/json',
                    },
                    timeout: 8000,
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 401) {
                            // Token expired — clear cache so next poll refreshes
                            this._kickToken = null;
                            this._kickTokenExpiry = 0;
                            return resolve(null);
                        }
                        if (res.statusCode >= 400) return resolve(null);
                        try {
                            const parsed = JSON.parse(data);
                            const channel = parsed?.data?.[0];
                            if (channel?.stream) {
                                const isLive = channel.stream.is_live === true;
                                const viewers = typeof channel.stream.viewer_count === 'number' ? channel.stream.viewer_count : 0;
                                resolve({ count: isLive ? viewers : 0, platformLive: isLive });
                            } else {
                                // No stream data = not live
                                resolve({ count: 0, platformLive: false });
                            }
                        } catch { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
            });
        } catch {
            return null;
        }
    }

    /**
     * Get a Twitch App Access Token via Client Credentials grant.
     * Caches the token and refreshes 5 minutes before expiry.
     * @returns {Promise<{accessToken: string, clientId: string}|null>}
     */
    async _getTwitchToken() {
        const db = require('../db/database');
        const clientId = db.getSetting('twitch_client_id');
        const clientSecret = db.getSetting('twitch_client_secret');
        if (!clientId || !clientSecret) return null;

        // Return cached token if still valid (5 min buffer)
        if (this._twitchToken && Date.now() < this._twitchTokenExpiry - 300000) {
            return { accessToken: this._twitchToken, clientId };
        }

        const https = require('https');
        return new Promise((resolve) => {
            const body = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
            const req = https.request('https://id.twitch.tv/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
                timeout: 8000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        console.warn(`[Restream] Twitch token request failed: HTTP ${res.statusCode}`);
                        return resolve(null);
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.access_token) {
                            this._twitchToken = parsed.access_token;
                            this._twitchTokenExpiry = Date.now() + (parsed.expires_in || 3600) * 1000;
                            resolve({ accessToken: parsed.access_token, clientId });
                        } else {
                            resolve(null);
                        }
                    } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    }

    /**
     * Fetch viewer count from Twitch Helix API.
     * @param {string} channelUrl - e.g. https://twitch.tv/HoboStreamerDotCom
     * @returns {Promise<number|null>}
     */
    async _fetchTwitchViewerCount(channelUrl) {
        const https = require('https');
        try {
            const url = new URL(channelUrl);
            const login = url.pathname.split('/').filter(Boolean)[0];
            if (!login) return null;

            const auth = await this._getTwitchToken();
            if (!auth) return null;

            return new Promise((resolve) => {
                const req = https.get(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login.toLowerCase())}`, {
                    headers: {
                        'Authorization': `Bearer ${auth.accessToken}`,
                        'Client-Id': auth.clientId,
                        'Accept': 'application/json',
                    },
                    timeout: 8000,
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 401) {
                            // Token expired — clear cache so next poll refreshes
                            this._twitchToken = null;
                            this._twitchTokenExpiry = 0;
                            return resolve(null);
                        }
                        if (res.statusCode >= 400) return resolve(null);
                        try {
                            const parsed = JSON.parse(data);
                            const stream = parsed?.data?.[0];
                            if (stream && typeof stream.viewer_count === 'number') {
                                resolve({ count: stream.viewer_count, platformLive: true });
                            } else {
                                // No stream data = not live on Twitch
                                resolve({ count: 0, platformLive: false });
                            }
                        } catch { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
            });
        } catch {
            return null;
        }
    }

    /**
     * Fetch YouTube live viewer count using the YouTube Data API v3.
     * Requires 'youtube_api_key' in site settings.
     * Extracts channel handle or ID from channel URL, searches for live broadcasts,
     * and reads concurrentViewers from liveStreamingDetails.
     */
    async _fetchYouTubeViewerCount(channelUrl) {
        const https = require('https');
        const db = require('../db/database');
        try {
            const apiKey = db.getSetting('youtube_api_key');
            if (!apiKey) return null;

            // Extract channel identifier from URL
            const url = new URL(channelUrl);
            const parts = url.pathname.split('/').filter(Boolean);
            let channelId = null;

            // youtube.com/channel/UC... → direct channel ID
            if (parts[0] === 'channel' && parts[1]) {
                channelId = parts[1];
            } else {
                // youtube.com/@handle or youtube.com/c/name → resolve to channel ID via search
                const handle = parts[0]?.startsWith('@') ? parts[0] : parts[1] || parts[0];
                if (!handle) return null;
                channelId = await this._resolveYouTubeChannelId(apiKey, handle);
                if (!channelId) return null;
            }

            // Search for active live broadcast on this channel
            return new Promise((resolve) => {
                const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${encodeURIComponent(channelId)}&type=video&eventType=live&key=${encodeURIComponent(apiKey)}`;
                const req = https.get(searchUrl, { timeout: 8000 }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 400) return resolve(null);
                        try {
                            const parsed = JSON.parse(data);
                            const videoId = parsed?.items?.[0]?.id?.videoId;
                            if (!videoId) return resolve({ count: 0, platformLive: false });
                            // Fetch viewer count from video details
                            this._fetchYouTubeVideoViewers(apiKey, videoId).then(resolve);
                        } catch { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
            });
        } catch {
            return null;
        }
    }

    /** Resolve a YouTube handle/username to a channel ID */
    async _resolveYouTubeChannelId(apiKey, handle) {
        const https = require('https');
        const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
        return new Promise((resolve) => {
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(cleanHandle)}&type=channel&maxResults=1&key=${encodeURIComponent(apiKey)}`;
            const req = https.get(url, { timeout: 8000 }, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 400) return resolve(null);
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed?.items?.[0]?.snippet?.channelId || null);
                    } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    }

    /** Fetch concurrent viewers for a live YouTube video */
    async _fetchYouTubeVideoViewers(apiKey, videoId) {
        const https = require('https');
        return new Promise((resolve) => {
            const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;
            const req = https.get(url, { timeout: 8000 }, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 400) return resolve(null);
                    try {
                        const parsed = JSON.parse(data);
                        const details = parsed?.items?.[0]?.liveStreamingDetails;
                        if (details?.concurrentViewers != null) {
                            resolve({ count: parseInt(details.concurrentViewers) || 0, platformLive: true });
                        } else {
                            resolve({ count: 0, platformLive: true });
                        }
                    } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    }

    /**
     * Cross-checks platform API signals — if the platform reports not-live but
     * our session says 'live', downgrade to 'error' and note the discrepancy.
     * @returns {Array<{destId, status, startedAt, restartAttempts, lastError}>}
     */
    getStreamStatus(streamId) {
        const statuses = [];
        for (const [, session] of this.sessions) {
            if (session.streamId === streamId) {
                let effectiveStatus = session.status;
                let effectiveError = session.lastError;

                // If we think we're live, cross-check cached platform signal
                if (effectiveStatus === 'live') {
                    const platformLive = this.isPlatformLive(session.destId);
                    const platform = session.destination?.platform || null;
                    // Kick live-state signals can lag or be unavailable even when ingest is healthy.
                    // Do not force-downgrade Kick to error based solely on platform polling.
                    if (platformLive === false && platform !== 'kick') {
                        // Platform API says not live — flag as stale
                        effectiveStatus = 'error';
                        effectiveError = 'FFmpeg running but platform reports offline';
                    }
                }

                statuses.push({
                    destId: session.destId,
                    status: effectiveStatus,
                    startedAt: session.startedAt,
                    restartAttempts: session.restartAttempts,
                    lastError: effectiveError,
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
     * Resume all enabled restreams for a live stream.
     * Unlike autoStartForStream, this does NOT require auto_start=1.
     * Used on broadcaster reconnect (e.g. after server restart) so manually-started
     * restreams also resume — the stream is live, so they should be running.
     * Skips destinations that already have an active session.
     */
    _getDestinationsForStream(streamId, userId) {
        const stream = db.getStreamById(streamId);
        if (!stream) return [];

        const globalDests = db.getRestreamDestinationsByUserId(userId) || [];
        const slotDests = stream.managed_stream_id
            ? db.getRestreamDestinationsByManagedStream(stream.managed_stream_id) || []
            : [];

        // Preserve user-global destinations while allowing slot-specific overrides.
        const merged = new Map();
        for (const dest of globalDests) merged.set(dest.id, dest);
        for (const dest of slotDests) merged.set(dest.id, dest);
        return Array.from(merged.values());
    }

    async autoStartForStream(streamId, userId, streamInfo) {
        const destinations = this._getDestinationsForStream(streamId, userId);
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

    async resumeForStream(streamId, userId, streamInfo) {
        const destinations = this._getDestinationsForStream(streamId, userId);
        if (!destinations?.length) return;

        let resumed = 0;
        for (const dest of destinations) {
            if (!dest.enabled || !dest.server_url || !dest.stream_key) continue;

            // Skip if already running
            const key = this._key(streamId, dest.id);
            const existing = this.sessions.get(key);
            if (existing && (existing.status === 'live' || existing.status === 'starting')) continue;

            console.log(`[Restream] Resuming ${dest.platform} restream for stream ${streamId}`);
            try {
                await this.startRestream(streamId, dest, streamInfo);
                resumed++;
            } catch (err) {
                console.warn(`[Restream] Resume failed for dest ${dest.id}:`, err.message);
            }
        }
        if (resumed > 0) {
            console.log(`[Restream] Resumed ${resumed} restream(s) for stream ${streamId}`);
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

    /**
     * Get available encoder presets for the client UI.
     * @returns {string[]} encoder preset names
     */
    static getEncoderPresets() {
        return ENCODER_PRESETS;
    }
}

module.exports = new RestreamManager();
