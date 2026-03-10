/**
 * HoboStreamer — Moderator API Routes
 *
 * Accessible by global_mod + admin.
 * These are moderator-specific tools that don't belong in the admin panel.
 *
 * GET    /api/mod/bans                    - List stream-scoped bans
 * GET    /api/mod/chat/search             - Search all chat logs
 * GET    /api/mod/chat/user/:userId       - View a user's chat history
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');

const router = express.Router();

// All mod routes require global_mod or admin
router.use(requireAuth, permissions.requireGlobalMod);

// ── List stream-scoped bans (not site bans) ──────────────────
router.get('/bans', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100'), 500);
        const bans = db.all(`
            SELECT b.*, u.username as banned_username, m.username as banned_by_username,
                   s.title as stream_title
            FROM bans b
            LEFT JOIN users u ON b.user_id = u.id
            LEFT JOIN users m ON b.banned_by = m.id
            LEFT JOIN streams s ON b.stream_id = s.id
            WHERE b.stream_id IS NOT NULL
            ORDER BY b.created_at DESC LIMIT ?
        `, [limit]);
        res.json({ bans });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list bans' });
    }
});

// ── Search chat messages (all users) ─────────────────────────
router.get('/chat/search', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');
        const query = req.query.q || '';
        const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
        const streamId = req.query.stream_id ? parseInt(req.query.stream_id) : null;

        const result = db.searchChatMessages({ query, userId, streamId, limit, offset });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// ── View a user's chat history ───────────────────────────────
router.get('/chat/user/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');

        const result = db.getUserChatHistory(userId, limit, offset);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat history' });
    }
});

module.exports = router;
