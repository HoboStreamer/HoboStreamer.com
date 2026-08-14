/**
 * chat-ai-routes.js — read API for chat AI insight.
 *   GET /api/chat-ai/global        → global chat overview + timeline + memory
 *   GET /api/chat-ai/user/:id       → a user's "today vs all-time" insight + timeline
 * Read-only; the summaries are produced by the chat-ai poller.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const chatAi = require('./chat-ai');

router.get('/global', (req, res) => {
    try {
        const insight = chatAi.getGlobalInsight();
        res.json({ insight: insight || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load global chat insight' });
    }
});

router.get('/user/:id', (req, res) => {
    try {
        const uid = parseInt(req.params.id, 10);
        if (!Number.isFinite(uid)) return res.status(400).json({ error: 'Invalid user id' });
        const user = db.getUserById ? db.getUserById(uid) : null;
        const insight = chatAi.getUserInsight(uid);

        // If this user is a streamer with an AI overview, lead the popover with who they
        // are as a streamer (their overview + recent stream "memories" as context/timeline)
        // before the chat-behavior insight.
        let streamer = null;
        try {
            const ov = db.getStreamerOverview(uid);
            if (ov && (ov.overview || ov.overview_short)) {
                const mems = (db.getStreamMemoriesByUser(uid, 8) || []).map(m => ({
                    description: m.description || '',
                    created_at: m.created_at,
                    stream_id: m.stream_id,
                    offset_seconds: m.offset_seconds,
                }));
                streamer = {
                    overview: ov.overview || null,
                    overview_short: ov.overview_short || null,
                    generated_at: ov.generated_at || null,
                    memories: mems,
                };
            }
        } catch { /* streamer context is best-effort */ }

        res.json({
            insight: insight || null,
            streamer,
            user: user ? { id: user.id, username: user.username, display_name: user.display_name } : null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user chat insight' });
    }
});

// A bridged external (relay) chatter's insight, keyed by platform + username.
router.get('/relay/:platform/:username', (req, res) => {
    try {
        const ru = db.getRelayUser(req.params.platform, req.params.username);
        if (!ru) return res.json({ insight: null, user: null });
        const insight = chatAi.getRelayUserInsight(ru.id);
        res.json({
            insight: insight || null,
            user: { platform: ru.platform, username: ru.display_name || ru.username, message_count: ru.message_count || 0, first_seen: ru.first_seen || null },
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load relay chat insight' });
    }
});

module.exports = router;
