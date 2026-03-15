/**
 * HoboStreamer — Streaming & Channel API Routes
 * 
 * Channels (permanent, static URL per user):
 * GET    /api/streams/channel/:username  - Get channel + live stream
 * PUT    /api/streams/channel            - Update own channel
 * 
 * Streams (sessions on a channel):
 * GET    /api/streams                    - List live streams
 * GET    /api/streams/recent             - List recently ended streams
 * GET    /api/streams/:id                - Get stream details
 * POST   /api/streams                    - Go live (creates stream on channel)
 * PUT    /api/streams/:id                - Update stream info
 * DELETE /api/streams/:id                - End a stream
 * GET    /api/streams/:id/endpoint       - Get streaming endpoint info
 * POST   /api/streams/:id/follow         - Follow/unfollow streamer
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth, requireStreamer, optionalAuth } = require('../auth/auth');
const jsmpegRelay = require('./jsmpeg-relay');
const webrtcSFU = require('./webrtc-sfu');
const recorder = require('../vod/recorder');

const router = express.Router();

// ── Get Channel by Username ──────────────────────────────────
router.get('/channel/:username', optionalAuth, (req, res) => {
    try {
        let channel = db.getChannelByUsername(req.params.username);
        if (!channel) {
            const user = db.getUserByUsername(req.params.username);
            if (!user) return res.status(404).json({ error: 'Channel not found' });
            db.ensureChannel(user.id);
            channel = db.getChannelByUsername(req.params.username);
            if (!channel) return res.status(404).json({ error: 'Channel not found' });
        }

        // Get live streams (may be multiple with different protocols)
        const liveStreams = db.getLiveStreamsByUserId(channel.user_id) || [];
        for (const liveStream of liveStreams) {
            if (liveStream.protocol === 'jsmpeg') {
                const user = db.getUserById(liveStream.user_id);
                liveStream.endpoint = jsmpegRelay.getChannelInfo(user.stream_key);
            } else if (liveStream.protocol === 'webrtc') {
                liveStream.endpoint = { roomId: `stream-${liveStream.id}` };
            } else if (liveStream.protocol === 'rtmp') {
                const config = require('../config');
                const user = db.getUserById(liveStream.user_id);
                const hostname = config.host === '0.0.0.0' ? req.hostname : config.host;
                liveStream.endpoint = {
                    flvUrl: `http://${hostname}:${config.rtmp.port + 8000}/live/${user.stream_key}.flv`,
                };
            }
            delete liveStream.stream_key;
        }

        // Show private VODs to the channel owner, only public to others
        const isOwner = req.user && req.user.id === channel.user_id;
        const vods = db.getVodsByUser(channel.user_id, isOwner) || [];
        const clips = db.getClipsByUser(channel.user_id, isOwner) || [];
        const followerCount = db.getFollowerCount(channel.user_id);
        const isFollowing = req.user ? db.isFollowing(req.user.id, channel.user_id) : false;

        res.json({
            channel: { ...channel, follower_count: followerCount, is_following: isFollowing },
            stream: liveStreams[0] || null,
            streams: liveStreams,
            vods,
            clips,
        });
    } catch (err) {
        console.error('[Channels] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get channel' });
    }
});

// ── Get Own Channel ──────────────────────────────────────────
router.get('/channel', requireAuth, (req, res) => {
    try {
        db.ensureChannel(req.user.id);
        const channel = db.getChannelByUserId(req.user.id);
        res.json(channel || {});
    } catch (err) {
        console.error('[Channels] Get own error:', err.message);
        res.status(500).json({ error: 'Failed to get channel' });
    }
});

// ── Update Own Channel ───────────────────────────────────────
router.put('/channel', requireAuth, (req, res) => {
    try {
        db.ensureChannel(req.user.id);
        const { title, description, category, protocol, is_nsfw, auto_record, panels, default_vod_visibility, default_clip_visibility } = req.body;
        const fields = {};
        if (title !== undefined) fields.title = title;
        if (description !== undefined) fields.description = description;
        if (category !== undefined) fields.category = category;
        if (protocol !== undefined) fields.protocol = protocol;
        if (is_nsfw !== undefined) fields.is_nsfw = is_nsfw ? 1 : 0;
        if (auto_record !== undefined) fields.auto_record = auto_record ? 1 : 0;
        if (panels !== undefined) fields.panels = typeof panels === 'string' ? panels : JSON.stringify(panels);
        if (default_vod_visibility !== undefined && ['public', 'unlisted', 'private'].includes(default_vod_visibility)) {
            fields.default_vod_visibility = default_vod_visibility;
        }
        if (default_clip_visibility !== undefined && ['public', 'unlisted', 'private'].includes(default_clip_visibility)) {
            fields.default_clip_visibility = default_clip_visibility;
        }

        if (Object.keys(fields).length > 0) {
            db.updateChannel(req.user.id, fields);
        }

        const channel = db.getChannelByUserId(req.user.id);
        res.json({ channel });
    } catch (err) {
        console.error('[Channels] Update error:', err.message);
        res.status(500).json({ error: 'Failed to update channel' });
    }
});

// ── List Live Streams ────────────────────────────────────────
router.get('/', optionalAuth, (req, res) => {
    try {
        const streams = db.getLiveStreams();
        const enriched = streams.map(s => {
            const channel = db.getChannelByUserId(s.user_id);
            return { ...s, channel: channel || null };
        });
        res.json({ streams: enriched });
    } catch (err) {
        console.error('[Streams] List error:', err.message);
        res.status(500).json({ error: 'Failed to list streams' });
    }
});

// ── List My Streams (all streams for current user) ───────────
router.get('/mine', requireAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const streams = db.getStreamsByUserId(req.user.id, limit);
        res.json({ streams });
    } catch (err) {
        console.error('[Streams] My streams error:', err.message);
        res.status(500).json({ error: 'Failed to list streams' });
    }
});

// ── List Recently Ended Streams ──────────────────────────────
router.get('/recent', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '20'), 100);
        const streams = db.getRecentStreams(limit);
        const enriched = streams.map(s => {
            const channel = db.getChannelByUserId(s.user_id);
            return { ...s, channel: channel || null };
        });
        res.json({ streams: enriched });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list recent streams' });
    }
});

// ── Get Stream Details ───────────────────────────────────────
router.get('/:id', optionalAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });

        delete stream.stream_key;

        if (stream.is_live) {
            const user = db.getUserById(stream.user_id);
            if (stream.protocol === 'jsmpeg') {
                stream.endpoint = jsmpegRelay.getChannelInfo(user.stream_key);
            } else if (stream.protocol === 'webrtc') {
                stream.endpoint = { roomId: `stream-${stream.id}` };
            } else if (stream.protocol === 'rtmp') {
                const config = require('../config');
                const hostname = config.host === '0.0.0.0' ? req.hostname : config.host;
                stream.endpoint = {
                    flvUrl: `http://${hostname}:${config.rtmp.port + 8000}/live/${user.stream_key}.flv`,
                };
            }
        }

        stream.cameras = db.all('SELECT * FROM cameras WHERE stream_id = ?', [stream.id]);
        stream.controls = db.getStreamControls(stream.id);
        stream.channel = db.getChannelByUserId(stream.user_id) || null;

        if (req.user) stream.isFollowing = db.isFollowing(req.user.id, stream.user_id);
        stream.follower_count = db.getFollowerCount(stream.user_id);

        res.json({ stream });
    } catch (err) {
        console.error('[Streams] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get stream' });
    }
});

// ── Start a New Stream (Go Live) ─────────────────────────────
router.post('/', requireAuth, (req, res) => {
    try {
        const { title, description, category, protocol, is_nsfw, tags, call_mode } = req.body;

        const channel = db.ensureChannel(req.user.id);

        if (req.user.role === 'user') {
            db.run('UPDATE users SET role = ? WHERE id = ?', ['streamer', req.user.id]);
        }

        const streamProtocol = protocol || channel.protocol || 'webrtc';
        const streamCategory = category || channel.category || 'irl';

        const result = db.createStream({
            user_id: req.user.id,
            channel_id: channel.id,
            title: title || channel.title || `${req.user.display_name}'s Stream`,
            description: description || channel.description || '',
            category: streamCategory,
            protocol: streamProtocol,
            is_nsfw: is_nsfw !== undefined ? is_nsfw : channel.is_nsfw,
        });

        const streamId = result.lastInsertRowid;

        // Initialize heartbeat
        db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);

        if (tags) {
            db.run('UPDATE streams SET tags = ? WHERE id = ?', [JSON.stringify(tags), streamId]);
        }

        // Set call mode if provided
        if (call_mode && ['mic', 'mic+cam', 'cam+mic'].includes(call_mode)) {
            db.run('UPDATE streams SET call_mode = ? WHERE id = ?', [call_mode, streamId]);
        }

        let endpoint = {};
        if (streamProtocol === 'jsmpeg') {
            endpoint = jsmpegRelay.createChannel(req.user.stream_key);
        } else if (streamProtocol === 'webrtc') {
            endpoint = { roomId: `stream-${streamId}` };
        }

        db.run(
            `INSERT INTO cameras (stream_id, camera_index, label, protocol) VALUES (?, 0, 'Main', ?)`,
            [streamId, streamProtocol]
        );

        const stream = db.getStreamById(streamId);
        res.status(201).json({ stream, endpoint });
    } catch (err) {
        console.error('[Streams] Create error:', err.message);
        res.status(500).json({ error: 'Failed to create stream' });
    }
});

// ── Update Stream Info ───────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }

        const { title, description, category, is_nsfw, tags } = req.body;
        const updates = [];
        const params = [];

        if (title !== undefined) { updates.push('title = ?'); params.push(title); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (category !== undefined) { updates.push('category = ?'); params.push(category); }
        if (is_nsfw !== undefined) { updates.push('is_nsfw = ?'); params.push(is_nsfw ? 1 : 0); }
        if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }

        if (updates.length > 0) {
            params.push(req.params.id);
            db.run(`UPDATE streams SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        const updated = db.getStreamById(req.params.id);
        res.json({ stream: updated });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update stream' });
    }
});

// ── End a Stream ─────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }

        db.endStream(stream.id);

        // Stop server-side recording (RTMP is handled in rtmp-server.js, but JSMPEG needs it here)
        if (stream.protocol === 'jsmpeg') {
            recorder.stopRecording(stream.id);
        }

        // Auto-finalize VOD recording server-side (catches cases where client didn't finalize)
        const vodRoutes = require('../vod/routes');
        vodRoutes.finalizeVodRecording(stream.id).catch(err => {
            console.warn(`[VOD] Auto-finalize on stream end failed for ${stream.id}:`, err.message);
        });

        const user = db.getUserById(stream.user_id);
        if (stream.protocol === 'jsmpeg') {
            jsmpegRelay.destroyChannel(user.stream_key);
        } else if (stream.protocol === 'webrtc') {
            webrtcSFU.closeRoom(`stream-${stream.id}`);
        }

        // End any active group call
        callServer.endCall(stream.id);

        res.json({ message: 'Stream ended' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to end stream' });
    }
});

// ── Get Streaming Endpoint Info ──────────────────────────────
router.get('/:id/endpoint', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }

        const user = db.getUserById(stream.user_id);
        const config = require('../config');
        let endpoint = {};

        const hostname = config.host === '0.0.0.0' ? req.hostname : config.host;

        if (stream.protocol === 'jsmpeg') {
            endpoint = jsmpegRelay.getChannelInfo(user.stream_key) || jsmpegRelay.createChannel(user.stream_key);

            // Start server-side VOD recording for JSMPEG (taps the relay WebSocket, zero delay to live)
            if (stream.is_live && !recorder.isRecording(stream.id)) {
                recorder.startRecording(stream.id, 'jsmpeg', {
                    streamKey: user.stream_key,
                    videoPort: endpoint.videoPort,
                });
            }

            const url = `http://${hostname}:${endpoint.videoPort}/${user.stream_key}/640/480/`;
            const urlHD = `http://${hostname}:${endpoint.videoPort}/${user.stream_key}/1280/720/`;
            const audioUrl = `http://${hostname}:${endpoint.audioPort}/${user.stream_key}/`;
            endpoint.ffmpegCommand = `ffmpeg -f v4l2 -i /dev/video0 -f alsa -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 ${url}`;
            endpoint.ffmpegVideoOnly = `ffmpeg -f v4l2 -i /dev/video0 -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -bf 0 -muxdelay 0.001 ${url}`;
            endpoint.ffmpegScreen = `ffmpeg -f x11grab -s 1920x1080 -r 24 -i :0.0 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 500k -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 ${url}`;
            endpoint.ffmpegOBS = `ffmpeg -f v4l2 -i /dev/video2 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 500k -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 ${url}`;
            endpoint.ffmpegAudioOnly = `ffmpeg -f alsa -i default -f mpegts -codec:a mp2 -b:a 128k -ar 44100 -ac 1 ${audioUrl}`;
            endpoint.ffmpegHD = `ffmpeg -f v4l2 -video_size 1280x720 -framerate 30 -i /dev/video0 -f alsa -i default -f mpegts -codec:v mpeg1video -s 1280x720 -b:v 1200k -r 30 -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 2 -muxdelay 0.001 ${urlHD}`;
        } else if (stream.protocol === 'webrtc') {
            endpoint = { roomId: `stream-${stream.id}`, signalingUrl: `/ws/broadcast?streamId=${stream.id}` };
        } else if (stream.protocol === 'rtmp') {
            endpoint = {
                rtmpUrl: `rtmp://${hostname}:${config.rtmp.port}/live`,
                streamKey: user.stream_key,
                flvUrl: `http://${hostname}:${config.rtmp.port + 8000}/live/${user.stream_key}.flv`,
            };
        }

        res.json({ endpoint, stream_key: user.stream_key });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get endpoint' });
    }
});

// ── Stream Heartbeat ─────────────────────────────────────────
router.post('/:id/heartbeat', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) return res.status(400).json({ error: 'Stream is not live' });

        db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [stream.id]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Heartbeat failed' });
    }
});

// ── RTMP Feed Status ─────────────────────────────────────────
router.get('/:id/rtmp-status', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (stream.protocol !== 'rtmp') {
            return res.status(400).json({ error: 'Not an RTMP stream' });
        }
        const user = db.getUserById(stream.user_id);
        const rtmpServer = require('./rtmp-server');
        const receiving = rtmpServer.isReceiving(user.stream_key);
        res.json({ receiving });
    } catch (err) {
        res.status(500).json({ error: 'Failed to check RTMP status' });
    }
});

// ── Follow/Unfollow Streamer ─────────────────────────────────
router.post('/:id/follow', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });

        if (db.isFollowing(req.user.id, stream.user_id)) {
            db.unfollowUser(req.user.id, stream.user_id);
            res.json({ following: false, count: db.getFollowerCount(stream.user_id) });
        } else {
            db.followUser(req.user.id, stream.user_id);
            // Award Hobo Coins for following
            try {
                const hoboCoins = require('../monetization/hobo-coins');
                hoboCoins.awardFollow(req.user.id, stream.user_id);
            } catch { /* non-critical */ }
            res.json({ following: true, count: db.getFollowerCount(stream.user_id) });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to follow/unfollow' });
    }
});

// ── Follow/Unfollow by Username ──────────────────────────────
router.post('/channel/:username/follow', requireAuth, (req, res) => {
    try {
        const user = db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (db.isFollowing(req.user.id, user.id)) {
            db.unfollowUser(req.user.id, user.id);
            res.json({ following: false, count: db.getFollowerCount(user.id) });
        } else {
            db.followUser(req.user.id, user.id);
            // Award Hobo Coins for following
            try {
                const hoboCoins = require('../monetization/hobo-coins');
                hoboCoins.awardFollow(req.user.id, user.id);
            } catch { /* non-critical */ }
            res.json({ following: true, count: db.getFollowerCount(user.id) });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to follow/unfollow' });
    }
});

// ── Group Call: Enable / Disable / Get Status ────────────────
const callServer = require('./call-server');

router.put('/:id/call', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) {
            return res.status(400).json({ error: 'Stream is not live' });
        }

        const { call_mode } = req.body;
        const validModes = ['mic', 'mic+cam', 'cam+mic', null];
        if (!validModes.includes(call_mode)) {
            return res.status(400).json({ error: 'Invalid call mode. Use: mic, mic+cam, cam+mic, or null to disable' });
        }

        const previousMode = stream.call_mode || null;
        db.run('UPDATE streams SET call_mode = ? WHERE id = ?', [call_mode, stream.id]);

        // Any mode change resets the active room so everyone resyncs to the new settings.
        if (previousMode !== call_mode) {
            callServer.endCall(stream.id);
        }

        res.json({
            call_mode,
            participants: callServer.getParticipants(stream.id),
            participant_count: callServer.getParticipantCount(stream.id),
        });
    } catch (err) {
        console.error('[Streams] Call mode error:', err.message);
        res.status(500).json({ error: 'Failed to update call mode' });
    }
});

router.get('/:id/call', optionalAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });

        res.json({
            call_mode: stream.call_mode || null,
            participants: callServer.getParticipants(stream.id),
            participant_count: callServer.getParticipantCount(stream.id),
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get call status' });
    }
});

module.exports = router;
