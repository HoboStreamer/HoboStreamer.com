const express = require('express');
const db = require('../db/database');
const { requireStaff } = require('../auth/auth');
const { isAdmin, isGlobalMod } = require('../auth/permissions');

const router = express.Router();

router.use(requireStaff);

router.get('/stats', (req, res) => {
    try {
        res.json({
            stats: {
                liveStreams: db.get('SELECT COUNT(*) AS c FROM streams WHERE is_live = 1')?.c || 0,
                activeBans: db.get('SELECT COUNT(*) AS c FROM bans WHERE expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP')?.c || 0,
                totalMessages: db.get('SELECT COUNT(*) AS c FROM chat_messages')?.c || 0,
                channelActions: db.get("SELECT COUNT(*) AS c FROM moderation_actions WHERE scope_type = 'channel'")?.c || 0,
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load moderator stats' });
    }
});

router.get('/chat/search', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const query = req.query.q || '';
        const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
        const streamId = req.query.stream_id ? parseInt(req.query.stream_id, 10) : null;
        const result = db.searchChatMessages({ query, userId, streamId, limit, offset });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to search chat logs' });
    }
});

router.get('/chat/user/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        if (!userId) return res.status(400).json({ error: 'Invalid user ID' });
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        res.json(db.getUserChatHistory(userId, limit, offset));
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user chat history' });
    }
});

router.get('/streams', (req, res) => {
    try {
        const streams = db.all(`
            SELECT s.*, u.username, u.display_name
            FROM streams s
            JOIN users u ON s.user_id = u.id
            WHERE s.is_live = 1
            ORDER BY s.viewer_count DESC, s.started_at DESC
        `);
        res.json({ streams });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list live streams' });
    }
});

router.delete('/streams/:id', (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        db.endStream(req.params.id);
        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: stream.user_id,
            action_type: 'force_end_stream',
            details: { stream_id: stream.id, title: stream.title },
        });
        res.json({ message: 'Stream force-ended' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to end stream' });
    }
});

router.get('/bans', (req, res) => {
    try {
        const bans = db.all(`
            SELECT b.*, u.username AS banned_username, m.username AS banned_by_username
            FROM bans b
            LEFT JOIN users u ON b.user_id = u.id
            LEFT JOIN users m ON b.banned_by = m.id
            ORDER BY b.created_at DESC
            LIMIT 200
        `);
        res.json({ bans });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list bans' });
    }
});

router.post('/users/:id/ban', (req, res) => {
    try {
        const target = db.getUserById(req.params.id);
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (isGlobalMod(req.user) && isAdmin(target)) {
            return res.status(403).json({ error: 'Global moderators cannot ban admins' });
        }

        const durationHours = Number(req.body.duration_hours || 0);
        const reason = req.body.reason || 'Banned by staff';
        const expiresAt = durationHours > 0
            ? new Date(Date.now() + durationHours * 3600000).toISOString()
            : null;

        db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?', [reason, target.id]);
        db.run(
            'INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)',
            [target.id, reason, req.user.id, expiresAt]
        );
        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: target.id,
            action_type: 'site_ban',
            details: { reason, duration_hours: durationHours || null },
        });
        res.json({ message: 'User banned' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

router.delete('/users/:id/ban', (req, res) => {
    try {
        const target = db.getUserById(req.params.id);
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (isGlobalMod(req.user) && isAdmin(target)) {
            return res.status(403).json({ error: 'Global moderators cannot unban admins' });
        }

        db.run('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [target.id]);
        db.run('DELETE FROM bans WHERE user_id = ?', [target.id]);
        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: target.id,
            action_type: 'site_unban',
        });
        res.json({ message: 'User unbanned' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

router.get('/actions', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const scopeType = req.query.scope_type || undefined;
        const scopeId = req.query.scope_id ? Number(req.query.scope_id) : undefined;
        res.json({
            actions: db.getModerationActions({
                scopeType,
                scopeId,
                limit,
                offset: Math.max(parseInt(req.query.offset || '0', 10), 0),
            }),
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load moderation actions' });
    }
});

module.exports = router;
