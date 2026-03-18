const express = require('express');
const db = require('../db/database');
const mediaQueue = require('./media-queue');
const { requireAuth, optionalAuth } = require('../auth/auth');

const router = express.Router();

function cleanInt(value, fallback) {
    const num = parseInt(value, 10);
    return Number.isFinite(num) ? num : fallback;
}

router.get('/channel/:username', optionalAuth, (req, res) => {
    try {
        const user = db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'Channel not found' });

        const channel = db.getChannelByUserId(user.id) || db.ensureChannel(user.id);
        const streams = db.getLiveStreamsByUserId(user.id) || [];
        const state = mediaQueue.getState(user.id);

        res.json({
            channel: {
                id: channel?.id || null,
                user_id: user.id,
                username: user.username,
                display_name: user.display_name || user.username,
                avatar_url: user.avatar_url || null,
            },
            live_stream: streams[0] || null,
            state,
            is_owner: !!req.user && req.user.id === user.id,
            media_player_url: `/media/${user.username}`,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load media queue' });
    }
});

router.get('/settings', requireAuth, (req, res) => {
    res.json({ settings: mediaQueue.getSettings(req.user.id), media_player_url: `/media/${req.user.username}` });
});

router.put('/settings', requireAuth, (req, res) => {
    try {
        const fields = {};
        const mapping = {
            enabled: 'enabled',
            request_cost: 'request_cost',
            max_per_user: 'max_per_user',
            max_duration_seconds: 'max_duration_seconds',
            allow_youtube: 'allow_youtube',
            allow_vimeo: 'allow_vimeo',
            allow_direct_media: 'allow_direct_media',
            auto_advance: 'auto_advance',
        };

        for (const [key, target] of Object.entries(mapping)) {
            if (req.body[key] === undefined) continue;
            if (['enabled', 'allow_youtube', 'allow_vimeo', 'allow_direct_media', 'auto_advance'].includes(key)) {
                fields[target] = req.body[key] ? 1 : 0;
            } else {
                const num = cleanInt(req.body[key], null);
                if (!Number.isFinite(num) || num < 0) {
                    return res.status(400).json({ error: `Invalid ${key}` });
                }
                fields[target] = num;
            }
        }

        const settings = mediaQueue.updateSettings(req.user.id, fields);
        res.json({ settings, media_player_url: `/media/${req.user.username}` });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to update settings' });
    }
});

router.post('/request', requireAuth, async (req, res) => {
    try {
        let streamerId = cleanInt(req.body.streamerId, null);
        let streamId = cleanInt(req.body.streamId, null);

        if (!streamerId && req.body.username) {
            const streamer = db.getUserByUsername(String(req.body.username));
            streamerId = streamer?.id || null;
        }
        if (!streamerId && streamId) {
            const stream = db.getStreamById(streamId);
            streamerId = stream?.user_id || null;
        }
        if (!streamerId) return res.status(400).json({ error: 'streamerId or username required' });
        if (!streamId) {
            const live = db.getLiveStreamsByUserId(streamerId) || [];
            streamId = live[0]?.id || null;
        }

        const username = req.user.display_name || req.user.username;
        const request = await mediaQueue.addRequest({
            streamerId,
            streamId,
            userId: req.user.id,
            username,
            input: req.body.input,
        });

        res.status(201).json({ request, remaining: db.getUserById(req.user.id)?.hobo_coins_balance || 0 });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to add request' });
    }
});

router.post('/start', requireAuth, (req, res) => {
    try {
        const request = mediaQueue.startNext(req.user.id);
        res.json({ request });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to start next request' });
    }
});

router.post('/advance', requireAuth, (req, res) => {
    try {
        const ended = mediaQueue.finishCurrent(req.user.id, req.body.status === 'skipped' ? 'skipped' : 'played');
        const next = mediaQueue.startNext(req.user.id);
        res.json({ ended, next });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to advance queue' });
    }
});

router.post('/queue/:id/play', requireAuth, (req, res) => {
    try {
        if (db.getActiveMediaRequestByStreamer(req.user.id)) {
            return res.status(400).json({ error: 'Finish or skip the current item first' });
        }
        const request = db.getMediaRequestByStreamerAndId(req.user.id, req.params.id);
        if (!request || request.status !== 'pending') return res.status(404).json({ error: 'Pending request not found' });
        db.updateMediaRequest(request.id, { queue_position: 0 });
        db.renormalizePendingMediaRequestPositions(req.user.id);
        const started = mediaQueue.startNext(req.user.id);
        res.json({ request: started });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to start request' });
    }
});

router.post('/queue/:id/skip', requireAuth, (req, res) => {
    try {
        const request = mediaQueue.skip(req.user.id, cleanInt(req.params.id, 0));
        res.json({ request });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to skip request' });
    }
});

router.post('/queue/:id/move', requireAuth, (req, res) => {
    try {
        const direction = req.body.direction === 'down' ? 'down' : 'up';
        const request = mediaQueue.move(req.user.id, cleanInt(req.params.id, 0), direction);
        res.json({ request });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to reorder request' });
    }
});

router.delete('/queue/:id', requireAuth, (req, res) => {
    try {
        const request = mediaQueue.skip(req.user.id, cleanInt(req.params.id, 0));
        res.json({ request });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to remove request' });
    }
});

module.exports = router;
