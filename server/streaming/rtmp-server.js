/**
 * HoboStreamer — RTMP Ingest Server
 * 
 * Accepts RTMP streams from OBS/FFmpeg and converts to HLS or relays.
 * Uses node-media-server for RTMP handling.
 */
const EventEmitter = require('events');
const config = require('../config');
const db = require('../db/database');
const recorder = require('../vod/recorder');

let NodeMediaServer;
try {
    NodeMediaServer = require('node-media-server');
} catch {
    console.warn('[RTMP] node-media-server not installed — RTMP streaming disabled');
    console.warn('[RTMP] Install with: npm install node-media-server');
}

class RTMPServer extends EventEmitter {
    constructor() {
        super();
        this.nms = null;
        this.activeStreams = new Map(); // streamKey → { streamId, userId }
    }

    start() {
        if (!NodeMediaServer) {
            console.warn('[RTMP] node-media-server not available, RTMP disabled');
            return;
        }

        const nmsConfig = {
            rtmp: {
                port: config.rtmp.port,
                chunk_size: config.rtmp.chunkSize,
                gop_cache: true,
                ping: 30,
                ping_timeout: 60,
            },
            http: {
                port: config.rtmp.port + 8000, // HTTP-FLV port (9935 by default)
                allow_origin: '*',  // Public media — CORS open (CSP restricts which pages can load it)
                mediaroot: './data/media',
            },
            trans: {
                ffmpeg: '/usr/bin/ffmpeg',
                tasks: [
                    {
                        app: 'live',
                        hls: true,
                        hlsFlags: '[hls_time=2:hls_list_size=3:hls_flags=delete_segments]',
                        hlsKeep: false,
                        dash: false,
                    },
                ],
            },
        };

        this.nms = new NodeMediaServer(nmsConfig);

        // ── Auth: Validate stream key on publish ─────────────
        this.nms.on('prePublish', (id, streamPath, args) => {
            console.log(`[RTMP] PrePublish: ${streamPath} from session ${id}`);
            // Stream path format: /live/STREAM_KEY
            const parts = streamPath.split('/');
            const streamKey = parts[parts.length - 1];

            if (!streamPath.startsWith('/live/') || !/^[a-zA-Z0-9_-]{8,128}$/.test(streamKey)) {
                console.log(`[RTMP] Rejected malformed publish path: ${streamPath}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            const existingActive = this.activeStreams.get(streamKey);
            if (existingActive && existingActive.sessionId !== id) {
                console.log(`[RTMP] Rejected duplicate publisher for stream key ${streamKey}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            const user = db.getUserByStreamKey(streamKey);
            if (!user) {
                console.log(`[RTMP] Rejected: invalid stream key ${streamKey}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            if (user.is_banned) {
                console.log(`[RTMP] Rejected: banned user ${user.username}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            // Create or update stream record
            // Look for an existing RTMP stream (created via Go Live page) that's waiting for the RTMP client
            const existingStreams = db.getLiveStreamsByUserId(user.id);
            const rtmpStream = existingStreams.find(s => s.protocol === 'rtmp');
            let streamId;
            if (rtmpStream) {
                streamId = rtmpStream.id;
                db.run('UPDATE streams SET is_live = 1, started_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [streamId]);
            } else {
                // No pre-created RTMP stream — auto-create one (direct OBS connect without Go Live page)
                db.ensureChannel(user.id);
                const result = db.createStream({
                    user_id: user.id,
                    title: `${user.display_name}'s Stream`,
                    protocol: 'rtmp',
                });
                streamId = result.lastInsertRowid;
            }

            // Ensure heartbeat is always set (for stale-stream cleanup)
            db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);

            this.activeStreams.set(streamKey, { streamId, userId: user.id, sessionId: id });
            console.log(`[RTMP] Stream started: ${user.username} (stream ${streamId})`);

            // Emit event for restream auto-start
            this.emit('publish', { streamId, userId: user.id, streamKey });

            // Start server-side VOD recording via FFmpeg
            // Small delay to let NMS fully register the RTMP stream before FFmpeg pulls it
            setTimeout(() => {
                recorder.startRecording(streamId, 'rtmp', { streamKey });
            }, 2000);
        });

        this.nms.on('donePublish', (id, streamPath, args) => {
            const parts = streamPath.split('/');
            const streamKey = parts[parts.length - 1];
            const info = this.activeStreams.get(streamKey);

            if (info) {
                // Stop VOD recording first (SIGINT → FFmpeg writes trailer → finalize)
                recorder.stopRecording(info.streamId);

                // Emit event for restream cleanup
                this.emit('unpublish', { streamId: info.streamId, userId: info.userId, streamKey });

                db.endStream(info.streamId);
                try { db.computeAndCacheStreamAnalytics(info.streamId); } catch {}
                this.activeStreams.delete(streamKey);
                console.log(`[RTMP] Stream ended: ${streamKey} (stream ${info.streamId})`);
            }
        });

        this.nms.on('prePlay', () => {});
        this.nms.on('donePlay', () => {});

        this.nms.run();
        console.log(`[RTMP] Server started on port ${config.rtmp.port}`);
    }

    getActiveStreams() {
        return Array.from(this.activeStreams.entries()).map(([key, info]) => ({
            streamKey: key,
            ...info,
        }));
    }

    /**
     * Check if an RTMP feed is actively being received for a given stream key.
     * @param {string} streamKey
     * @returns {boolean}
     */
    isReceiving(streamKey) {
        return this.activeStreams.has(streamKey);
    }

    stop() {
        // Stop all active recordings before shutting down RTMP server
        recorder.stopAll();
        if (this.nms) {
            this.nms.stop();
        }
    }
}

module.exports = new RTMPServer();
