/**
 * HoboStreamer — Chat API Routes
 * 
 * GET  /api/chat/:streamId/history   - Get chat history for a stream
 * GET  /api/chat/:streamId/users     - Get users in chat
 * GET  /api/chat/search              - Search chat messages
 * GET  /api/chat/user/:userId/history - Get a user's chat history
 * GET  /api/chat/user/:username/profile - Get user profile card data
 */
const express = require('express');
const db = require('../db/database');
const { optionalAuth, requireAuth, requireAdmin } = require('../auth/auth');
const permissions = require('../auth/permissions');

const router = express.Router();

// ── Search Chat Messages (admin or self) ─────────────────────
router.get('/search', requireAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');
        const query = req.query.q || '';
        const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
        const streamId = req.query.stream_id ? parseInt(req.query.stream_id) : null;

        // Admin / global_mod can search anyone; others search only their own
        const effectiveUserId = permissions.canViewOtherUserLogs(req.user) ? userId : req.user.id;

        const result = db.searchChatMessages({
            query, userId: effectiveUserId, streamId, limit, offset,
        });

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// ── User Chat History ────────────────────────────────────────
router.get('/user/:userId/history', requireAuth, (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');

        // Admin / global_mod can view anyone; others view only their own
        if (!permissions.canViewOtherUserLogs(req.user) && req.user.id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = db.getUserChatHistory(userId, limit, offset);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat history' });
    }
});

// ── User Profile Card ────────────────────────────────────────
router.get('/user/:username/profile', optionalAuth, (req, res) => {
    try {
        // Try core username first, then fall back to display_name lookup
        let user = db.getUserByUsername(req.params.username);
        if (!user) {
            user = db.get('SELECT * FROM users WHERE display_name = ? COLLATE NOCASE', [req.params.username]);
        }
        if (!user) return res.status(404).json({ error: 'User not found' });

        const profile = db.getUserProfile(user.id);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        // Add game stats if available
        try {
            const game = require('../game/game-engine');
            const player = game.getPlayer(user.id);
            if (player) {
                profile.game = {
                    total_level: player.total_level,
                    mining_level: player.mining_level,
                    fishing_level: player.fishing_level,
                    woodcut_level: player.woodcut_level,
                    farming_level: player.farming_level,
                    combat_level: player.combat_level,
                    crafting_level: player.crafting_level,
                    mining_xp: player.mining_xp,
                    fishing_xp: player.fishing_xp,
                    woodcut_xp: player.woodcut_xp,
                    farming_xp: player.farming_xp,
                    combat_xp: player.combat_xp,
                    crafting_xp: player.crafting_xp,
                    total_coins_earned: player.total_coins_earned || 0,
                };
            }
        } catch { /* game not initialized or player doesn't exist */ }

        res.json(profile);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

// ── Global Chat History (all streams) ────────────────────────
router.get('/global/history', optionalAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '500'), 500);
        const before = req.query.before;

        let sql = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name,
                          u.username AS core_username,
                          s.id AS sid, su.username AS stream_username
                   FROM chat_messages cm
                   LEFT JOIN users u ON cm.user_id = u.id
                   LEFT JOIN streams s ON cm.stream_id = s.id
                   LEFT JOIN users su ON s.user_id = su.id
                   WHERE cm.is_deleted = 0 AND cm.message_type IN ('chat', 'system')`;
        const params = [];

        if (before) {
            sql += ` AND cm.timestamp < ?`;
            params.push(before);
        }

        sql += ` ORDER BY cm.timestamp DESC LIMIT ?`;
        params.push(limit);

        const messages = db.all(sql, params).reverse();
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get global chat history' });
    }
});

// ── Chat Replay (for VOD/clip playback sync) ────────────────
router.get('/:streamId/replay', optionalAuth, (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        if (!streamId) return res.status(400).json({ error: 'Invalid stream ID' });

        const from = req.query.from || null;  // ISO timestamp
        const to = req.query.to || null;      // ISO timestamp

        const messages = db.getChatReplay(streamId, from, to);
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat replay' });
    }
});

// ── Chat History ─────────────────────────────────────────────
router.get('/:streamId/history', optionalAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '500'), 500);
        const before = req.query.before; // ISO timestamp for pagination

        let sql = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name,
                          u.username AS core_username
                   FROM chat_messages cm
                   LEFT JOIN users u ON cm.user_id = u.id
                   WHERE cm.stream_id = ? AND cm.is_deleted = 0`;
        const params = [req.params.streamId];

        if (before) {
            sql += ` AND cm.timestamp < ?`;
            params.push(before);
        }

        sql += ` ORDER BY cm.timestamp DESC LIMIT ?`;
        params.push(limit);

        const messages = db.all(sql, params).reverse();
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat history' });
    }
});

// ── Chat User Count ──────────────────────────────────────────
router.get('/:streamId/users', (req, res) => {
    const chatServer = require('./chat-server');
    const count = chatServer.getStreamViewerCount(parseInt(req.params.streamId));
    res.json({ count });
});

module.exports = router;
