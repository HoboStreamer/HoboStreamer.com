/**
 * HoboStreamer — Restream API Routes
 * 
 * CRUD endpoints for managing restream destinations (YouTube, Twitch, Kick, Custom RTMP).
 * Start/stop endpoints for controlling active restreams on live streams.
 * Status endpoint returns real-time FFmpeg process status per destination.
 */
const express = require('express');

const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const restreamManager = require('./restream-manager');

const router = express.Router();

const VALID_PLATFORMS = ['youtube', 'twitch', 'kick', 'custom'];
const MAX_DESTINATIONS = 10;

/** Platform presets with default RTMP server URLs and UI metadata. */
const PLATFORM_PRESETS = {
    youtube: { name: 'YouTube', defaultServerUrl: 'rtmp://a.rtmp.youtube.com/live2', icon: 'fa-brands fa-youtube', color: '#ff0000' },
    twitch:  { name: 'Twitch', defaultServerUrl: 'rtmp://live.twitch.tv/app', icon: 'fa-brands fa-twitch', color: '#9146ff' },
    kick:    { name: 'Kick', defaultServerUrl: '', icon: 'fa-solid fa-k', color: '#53fc18' },
    custom:  { name: 'Custom RTMP', defaultServerUrl: '', icon: 'fa-solid fa-globe', color: '#888' },
};

/**
 * Sanitize a destination for the client — mask stream key.
 */
function sanitizeDest(d) {
    if (!d) return d;
    return {
        ...d,
        stream_key: d.stream_key ? '****' + d.stream_key.slice(-4) : '',
        has_key: !!d.stream_key,
    };
}

// ── GET /presets — platform hints for the client ─────────────
router.get('/presets', requireAuth, (req, res) => {
    res.json({ presets: PLATFORM_PRESETS });
});

// ── GET /destinations — list user's restream destinations ────
router.get('/destinations', requireAuth, (req, res) => {
    try {
        const dests = db.getRestreamDestinationsByUserId(req.user.id) || [];
        res.json({ destinations: dests.map(sanitizeDest) });
    } catch (err) {
        console.error('[Restream] List destinations error:', err.message);
        res.status(500).json({ error: 'Failed to load restream destinations' });
    }
});

// ── POST /destinations — create a new restream destination ───
router.post('/destinations', requireAuth, (req, res) => {
    try {
        const { platform, name, server_url, stream_key, enabled, auto_start } = req.body;

        if (!platform || !VALID_PLATFORMS.includes(platform)) {
            return res.status(400).json({ error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}` });
        }

        // Enforce a reasonable limit
        const existing = db.getRestreamDestinationsByUserId(req.user.id) || [];
        if (existing.length >= MAX_DESTINATIONS) {
            return res.status(400).json({ error: `Maximum ${MAX_DESTINATIONS} restream destinations allowed` });
        }

        if (!stream_key || typeof stream_key !== 'string' || !stream_key.trim()) {
            return res.status(400).json({ error: 'Stream key is required' });
        }

        // Auto-fill server URL from platform preset if not provided
        let finalUrl = server_url?.trim() || '';
        if (!finalUrl && PLATFORM_PRESETS[platform]?.defaultServerUrl) {
            finalUrl = PLATFORM_PRESETS[platform].defaultServerUrl;
        }
        if (!finalUrl) {
            return res.status(400).json({ error: 'Server URL is required' });
        }

        const dest = db.createRestreamDestination(req.user.id, {
            platform,
            name: name?.trim() || PLATFORM_PRESETS[platform]?.name || platform,
            server_url: finalUrl,
            stream_key: stream_key.trim(),
            enabled: enabled !== false ? 1 : 0,
            auto_start: auto_start ? 1 : 0,
        });

        res.json({ destination: sanitizeDest(dest) });
    } catch (err) {
        console.error('[Restream] Create destination error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to create restream destination' });
    }
});

// ── PUT /destinations/:id — update a destination ─────────────
router.put('/destinations/:id', requireAuth, (req, res) => {
    try {
        const dest = db.getRestreamDestinationById(parseInt(req.params.id));
        if (!dest || dest.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Destination not found' });
        }

        const updates = {};
        if (req.body.name !== undefined) updates.name = req.body.name?.trim() || dest.name;
        if (req.body.server_url !== undefined) updates.server_url = req.body.server_url?.trim() || dest.server_url;
        if (req.body.stream_key !== undefined && req.body.stream_key.trim()) {
            updates.stream_key = req.body.stream_key.trim();
        }
        if (req.body.enabled !== undefined) updates.enabled = req.body.enabled ? 1 : 0;
        if (req.body.auto_start !== undefined) updates.auto_start = req.body.auto_start ? 1 : 0;

        const updated = db.updateRestreamDestination(dest.id, updates);
        res.json({ destination: sanitizeDest(updated) });
    } catch (err) {
        console.error('[Restream] Update destination error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to update destination' });
    }
});

// ── DELETE /destinations/:id — delete a destination ──────────
router.delete('/destinations/:id', requireAuth, (req, res) => {
    try {
        const dest = db.getRestreamDestinationById(parseInt(req.params.id));
        if (!dest || dest.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Destination not found' });
        }

        // Stop any active restream for this destination
        const liveStreams = db.getLiveStreamsByUserId(req.user.id) || [];
        for (const stream of liveStreams) {
            restreamManager.stopRestream(stream.id, dest.id);
        }

        db.deleteRestreamDestination(dest.id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Restream] Delete destination error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to delete destination' });
    }
});

// ── POST /destinations/:id/start — start restream ────────────
router.post('/destinations/:id/start', requireAuth, async (req, res) => {
    try {
        const dest = db.getRestreamDestinationById(parseInt(req.params.id));
        if (!dest || dest.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Destination not found' });
        }
        if (!dest.server_url || !dest.stream_key) {
            return res.status(400).json({ error: 'Destination is not fully configured (missing server URL or stream key)' });
        }

        // Find the user's live stream
        const liveStreams = db.getLiveStreamsByUserId(req.user.id) || [];
        const { streamId } = req.body;
        const stream = streamId
            ? liveStreams.find(s => s.id === parseInt(streamId))
            : liveStreams[0];

        if (!stream) {
            return res.status(400).json({ error: 'No live stream found. Go live first.' });
        }

        if (stream.protocol === 'webrtc') {
            // WebRTC → RTMP requires Mediasoup SFU
            const webrtcSFU = require('./webrtc-sfu');
            if (!webrtcSFU.ready) {
                return res.status(400).json({
                    error: 'WebRTC → RTMP restreaming requires Mediasoup. Install mediasoup: npm install mediasoup',
                });
            }
        }

        const user = db.getUserById(req.user.id);
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }

        const session = await restreamManager.startRestream(stream.id, dest, {
            protocol: stream.protocol,
            streamKey: user.stream_key,
        });

        res.json({ ok: true, status: session?.status || 'starting' });
    } catch (err) {
        console.error('[Restream] Start restream error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to start restream' });
    }
});

// ── POST /destinations/:id/stop — stop restream ─────────────
router.post('/destinations/:id/stop', requireAuth, (req, res) => {
    try {
        const dest = db.getRestreamDestinationById(parseInt(req.params.id));
        if (!dest || dest.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Destination not found' });
        }

        // Stop restream for all of this user's live streams
        const liveStreams = db.getLiveStreamsByUserId(req.user.id) || [];
        for (const stream of liveStreams) {
            restreamManager.stopRestream(stream.id, dest.id);
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('[Restream] Stop restream error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to stop restream' });
    }
});

// ── GET /status — combined restream status for all live streams
router.get('/status', requireAuth, (req, res) => {
    try {
        const liveStreams = db.getLiveStreamsByUserId(req.user.id) || [];
        const allStatuses = {};
        for (const stream of liveStreams) {
            allStatuses[stream.id] = restreamManager.getStreamStatus(stream.id);
        }
        res.json({ statuses: allStatuses });
    } catch (err) {
        console.error('[Restream] Status error:', err.message);
        res.status(500).json({ error: 'Failed to get restream status' });
    }
});

module.exports = router;
