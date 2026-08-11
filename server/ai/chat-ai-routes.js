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
        res.json({
            insight: insight || null,
            user: user ? { id: user.id, username: user.username, display_name: user.display_name } : null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user chat insight' });
    }
});

module.exports = router;
