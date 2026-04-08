/**
 * Breaking News API Routes
 * 
 * Admin: configure sources, set global enable/disable
 * Streamers: toggle news for their own streams
 */
'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/auth');
const newsService = require('./news-service');

// ── Get all news sources + their status (admin) ─────────────
router.get('/sources', requireAuth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    res.json({ sources: newsService.getSources() });
});

// ── Update a news source config (admin) ─────────────────────
router.put('/sources/:id', requireAuth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const { enabled, config } = req.body;
        newsService.updateSource(req.params.id, { enabled, config });
        res.json({ success: true, source: newsService.getSources().find(s => s.id === req.params.id) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get streamer's news preference ──────────────────────────
router.get('/my-settings', requireAuth, (req, res) => {
    const enabled = newsService.getUserEnabled(req.user.id);
    res.json({ enabled }); // null = inherit from global
});

// ── Set streamer's news preference ──────────────────────────
router.put('/my-settings', requireAuth, (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    newsService.setUserEnabled(req.user.id, enabled);
    res.json({ success: true, enabled });
});

module.exports = router;
