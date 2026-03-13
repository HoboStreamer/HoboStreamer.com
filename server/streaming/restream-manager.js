/**
 * HoboStreamer — Restream Manager
 * 
 * Manages FFmpeg processes that forward live streams to external RTMP destinations
 * (YouTube, Twitch, Kick, custom RTMP). Supports RTMP and JSMPEG input sources.
 * 
 * Input sources:
 *   - RTMP: Reads via HTTP-FLV from node-media-server (codec copy, zero CPU overhead)
 *   - JSMPEG: Taps relay data, pipes combined MPEG-TS → FFmpeg (re-encodes MPEG1 → H.264)
 *   - WebRTC: Not yet supported server-side (browser-side RS restream handles this)
 * 
 * Architecture:
 *   Stream → Restream Manager → FFmpeg child process → External RTMP endpoint
 *   
 *   For RTMP input:  ffmpeg -i http://localhost:9935/live/{key}.flv -c copy -f flv rtmp://dest
 *   For JSMPEG input: ffmpeg -f mpegts -i pipe:0 -c:v libx264 -preset ultrafast ... -f flv rtmp://dest
 */
const { spawn } = require('child_process');
const EventEmitter = require('events');
const config = require('../config');

const RESTART_BASE_DELAY = 5000;
const RESTART_MAX_DELAY = 60000;
const STABLE_THRESHOLD_MS = 30000;
const MAX_RESTART_ATTEMPTS = 10;
const FFMPEG_STARTUP_DELAY_RTMP = 3000;

class RestreamManager extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, RestreamSession>} key: `${streamId}:${destId}` */
        this.sessions = new Map();
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
            console.warn('[Restream] WebRTC → RTMP not yet supported server-side. Use browser-side RS restream for WebRTC streams.');
            return null;
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

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-f', 'mpegts',
            '-i', 'pipe:0',             // Read combined MPEG-TS from stdin
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-crf', '23',
            '-maxrate', '2500k',
            '-bufsize', '5000k',
            '-g', '60',                  // Keyframe interval
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
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
     * Spawn an FFmpeg child process and monitor its lifecycle.
     */
    _spawnFFmpeg(session, args) {
        const maskedArgs = args.map(a =>
            a.includes('rtmp://') ? a.replace(/\/[^/]+$/, '/****') : a
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

            session.status = 'starting';
            this.emit('status-change', {
                streamId: session.streamId, destId: session.destId, status: 'starting',
            });

            if (session.streamInfo.protocol === 'rtmp') {
                this._startRtmpRestream(session, session.streamInfo.streamKey, destUrl);
            } else if (session.streamInfo.protocol === 'jsmpeg') {
                this._startJsmpegRestream(session, session.streamInfo.streamKey, destUrl);
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
}

module.exports = new RestreamManager();
