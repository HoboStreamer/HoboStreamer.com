/**
 * HoboStreamer — Admin Panel API Routes
 * 
 * All routes require admin role.
 * 
 * GET    /api/admin/stats                  - Dashboard statistics
 * GET    /api/admin/users                  - List all users
 * PUT    /api/admin/users/:id              - Update user (role, ban)
 * POST   /api/admin/users/:id/ban          - Ban a user
 * DELETE /api/admin/users/:id/ban          - Unban a user
 * GET    /api/admin/streams                - All active streams
 * DELETE /api/admin/streams/:id            - Force end a stream
 * GET    /api/admin/bans                   - List all bans
 * GET    /api/admin/vpn-queue              - VPN approval queue
 * PUT    /api/admin/vpn-queue/:id          - Approve/deny VPN
 * GET    /api/admin/settings               - Get all site settings
 * PUT    /api/admin/settings               - Update site settings (bulk)
 * PUT    /api/admin/settings/:key          - Update a single setting
 * DELETE /api/admin/settings/:key          - Delete a setting
 * GET    /api/admin/moderators             - List global moderators
 * POST   /api/admin/moderators             - Promote user to mod
 * DELETE /api/admin/moderators/:id         - Demote mod to user
 * GET    /api/admin/verification-keys      - List verification keys
 * POST   /api/admin/verification-keys      - Generate a verification key
 * DELETE /api/admin/verification-keys/:id  - Revoke a verification key
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');

const router = express.Router();

// All admin routes require admin role
router.use(requireAuth, permissions.requireAdmin);

// ── Dashboard Stats ──────────────────────────────────────────
router.get('/stats', (req, res) => {
    try {
        const stats = {
            users: {
                total: db.get('SELECT COUNT(*) as c FROM users').c,
                streamers: db.get("SELECT COUNT(*) as c FROM users WHERE role IN ('streamer', 'admin')").c,
                banned: db.get('SELECT COUNT(*) as c FROM users WHERE is_banned = 1').c,
            },
            streams: {
                live: db.get('SELECT COUNT(*) as c FROM streams WHERE is_live = 1').c,
                total: db.get('SELECT COUNT(*) as c FROM streams').c,
                totalViewers: db.get('SELECT COALESCE(SUM(viewer_count), 0) as c FROM streams WHERE is_live = 1').c,
            },
            hoboBucks: {
                totalCirculating: db.get('SELECT COALESCE(SUM(hobo_bucks_balance), 0) as c FROM users').c,
                totalTransactions: db.get('SELECT COUNT(*) as c FROM transactions').c,
                pendingCashouts: db.get("SELECT COUNT(*) as c FROM transactions WHERE type = 'cashout' AND status = 'escrow'").c,
                totalDonated: db.get("SELECT COALESCE(SUM(amount), 0) as c FROM transactions WHERE type = 'donation'").c,
            },
            vods: {
                total: db.get('SELECT COUNT(*) as c FROM vods').c,
                public: db.get('SELECT COUNT(*) as c FROM vods WHERE is_public = 1').c,
            },
            chat: {
                totalMessages: db.get('SELECT COUNT(*) as c FROM chat_messages').c,
            },
        };

        // Recent activity
        stats.recentUsers = db.all(
            'SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at DESC LIMIT 10'
        );

        stats.recentStreams = db.all(`
            SELECT s.id, s.title, s.protocol, s.viewer_count, s.started_at, u.username
            FROM streams s JOIN users u ON s.user_id = u.id
            WHERE s.is_live = 1
            ORDER BY s.viewer_count DESC LIMIT 20
        `);

        res.json(stats);
    } catch (err) {
        console.error('[Admin] Stats error:', err.message);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// ── List Users ───────────────────────────────────────────────
router.get('/users', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');
        const search = req.query.search || '';

        let sql = `SELECT id, username, display_name, email, role, hobo_bucks_balance,
                    is_banned, ban_reason, created_at, last_seen FROM users`;
        const params = [];

        if (search) {
            sql += ' WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ?';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        const countSql = search
            ? `SELECT COUNT(*) as c FROM users WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ?`
            : `SELECT COUNT(*) as c FROM users`;
        const countParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const users = db.all(sql, params);
        const total = db.get(countSql, countParams).c;

        res.json({ users, total });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list users' });
    }
});

// ── Update User ──────────────────────────────────────────────
router.put('/users/:id', (req, res) => {
    try {
        const { role, display_name } = req.body;
        const updates = [];
        const params = [];

        if (role) {
            const validRoles = ['user', 'streamer', 'global_mod', 'admin'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
            }
            updates.push('role = ?'); params.push(role);
        }
        if (display_name) { updates.push('display_name = ?'); params.push(display_name); }

        if (updates.length > 0) {
            params.push(req.params.id);
            db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        const user = db.getUserById(req.params.id);
        // Sanitize — never expose password_hash or stream_key
        const { password_hash, stream_key, ...safeUser } = user;
        res.json({ user: safeUser });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// ── Ban User ─────────────────────────────────────────────────
router.post('/users/:id/ban', (req, res) => {
    try {
        const { reason, duration_hours } = req.body;
        const expires = duration_hours
            ? new Date(Date.now() + duration_hours * 3600000).toISOString()
            : null;

        db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?',
            [reason || 'Banned by admin', req.params.id]);

        db.run(
            `INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
            [req.params.id, reason || 'Banned by admin', req.user.id, expires]
        );

        res.json({ message: 'User banned' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// ── Unban User ───────────────────────────────────────────────
router.delete('/users/:id/ban', (req, res) => {
    try {
        db.run('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [req.params.id]);
        db.run('DELETE FROM bans WHERE user_id = ?', [req.params.id]);
        res.json({ message: 'User unbanned' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

// ── List All Active Streams ──────────────────────────────────
router.get('/streams', (req, res) => {
    try {
        const streams = db.all(`
            SELECT s.*, u.username, u.display_name
            FROM streams s JOIN users u ON s.user_id = u.id
            WHERE s.is_live = 1
            ORDER BY s.viewer_count DESC
        `);
        res.json({ streams });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list streams' });
    }
});

// ── Force End Stream ─────────────────────────────────────────
router.delete('/streams/:id', (req, res) => {
    try {
        db.endStream(req.params.id);
        res.json({ message: 'Stream force-ended' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to end stream' });
    }
});

// ── List Bans ────────────────────────────────────────────────
router.get('/bans', (req, res) => {
    try {
        const bans = db.all(`
            SELECT b.*, u.username as banned_username, m.username as banned_by_username
            FROM bans b
            LEFT JOIN users u ON b.user_id = u.id
            LEFT JOIN users m ON b.banned_by = m.id
            ORDER BY b.created_at DESC LIMIT 100
        `);
        res.json({ bans });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list bans' });
    }
});

// ── VPN Approval Queue ───────────────────────────────────────
router.get('/vpn-queue', (req, res) => {
    try {
        const queue = db.all(`
            SELECT v.*, u.username
            FROM vpn_approvals v
            LEFT JOIN users u ON v.user_id = u.id
            WHERE v.status = 'pending'
            ORDER BY v.created_at ASC
        `);
        res.json({ queue });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get VPN queue' });
    }
});

// ── Approve/Deny VPN ─────────────────────────────────────────
router.put('/vpn-queue/:id', (req, res) => {
    try {
        const { status } = req.body; // 'approved' or 'denied'
        if (!['approved', 'denied'].includes(status)) {
            return res.status(400).json({ error: 'Status must be approved or denied' });
        }

        db.run('UPDATE vpn_approvals SET status = ?, reviewed_by = ? WHERE id = ?',
            [status, req.user.id, req.params.id]);

        res.json({ message: `VPN request ${status}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update VPN request' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Site Settings
// ═══════════════════════════════════════════════════════════════

// ── Get All Settings ─────────────────────────────────────────
router.get('/settings', (req, res) => {
    try {
        const settings = db.getAllSettings();
        res.json({ settings });
    } catch (err) {
        console.error('[Admin] Settings error:', err.message);
        res.status(500).json({ error: 'Failed to get settings' });
    }
});

// ── Update Settings (bulk) ───────────────────────────────────
router.put('/settings', (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Invalid settings payload' });
        }
        for (const [key, value] of Object.entries(settings)) {
            if (typeof key === 'string' && key.length <= 100) {
                db.setSetting(key, value);
            }
        }
        res.json({ message: 'Settings updated', settings: db.getAllSettings() });
    } catch (err) {
        console.error('[Admin] Settings update error:', err.message);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// ── Update Single Setting ────────────────────────────────────
router.put('/settings/:key', (req, res) => {
    try {
        const { value } = req.body;
        if (value === undefined) {
            return res.status(400).json({ error: 'Value is required' });
        }
        db.setSetting(req.params.key, value);
        res.json({ message: 'Setting updated', setting: db.getSettingRow(req.params.key) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting' });
    }
});

// ── Delete Setting ───────────────────────────────────────────
router.delete('/settings/:key', (req, res) => {
    try {
        db.deleteSetting(req.params.key);
        res.json({ message: 'Setting deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete setting' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Global Moderators
// ═══════════════════════════════════════════════════════════════

// ── List Mods ────────────────────────────────────────────────
router.get('/moderators', (req, res) => {
    try {
        const mods = db.all(
            "SELECT id, username, display_name, avatar_url, created_at, last_seen FROM users WHERE role = 'global_mod' ORDER BY username"
        );
        res.json({ moderators: mods });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list moderators' });
    }
});

// ── Promote to Global Mod ────────────────────────────────────
router.post('/moderators', (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Username is required' });

        const user = db.getUserByUsername(username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(400).json({ error: 'Cannot change admin role' });
        if (user.role === 'global_mod') return res.status(400).json({ error: 'User is already a global moderator' });

        db.run("UPDATE users SET role = 'global_mod' WHERE id = ?", [user.id]);
        res.json({ message: `${user.username} promoted to global moderator` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to promote user' });
    }
});

// ── Demote Global Mod ────────────────────────────────────────
router.delete('/moderators/:id', (req, res) => {
    try {
        const user = db.getUserById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role !== 'global_mod') return res.status(400).json({ error: 'User is not a global moderator' });

        db.run("UPDATE users SET role = 'user' WHERE id = ?", [user.id]);
        res.json({ message: `${user.username} demoted to user` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to demote moderator' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Verification Keys (legacy RS-Companion username claims)
// ═══════════════════════════════════════════════════════════════

// ── List All Keys ────────────────────────────────────────────
router.get('/verification-keys', (req, res) => {
    try {
        const keys = db.getAllVerificationKeys();
        res.json({ keys });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list verification keys' });
    }
});

// ── Generate Key ─────────────────────────────────────────────
router.post('/verification-keys', (req, res) => {
    try {
        const { target_username, note } = req.body;
        if (!target_username) {
            return res.status(400).json({ error: 'Target username is required' });
        }
        if (!/^[a-zA-Z0-9_]+$/.test(target_username) || target_username.length < 3 || target_username.length > 24) {
            return res.status(400).json({ error: 'Invalid username format (3-24 chars, alphanumeric + underscore)' });
        }

        // Check if username already taken by a real user
        const existingUser = db.getUserByUsername(target_username);
        if (existingUser) {
            return res.status(409).json({ error: `Username "${target_username}" is already registered` });
        }

        // Check for duplicate active key for same username
        const existingKey = db.getVerificationKeyByUsername(target_username);
        if (existingKey) {
            return res.status(409).json({ error: `Active key already exists for "${target_username}"` });
        }

        // Generate a readable key: HOBO-XXXX-XXXX-XXXX
        const key = 'HOBO-' + [4, 4, 4].map(() =>
            crypto.randomBytes(2).toString('hex').toUpperCase()
        ).join('-');

        db.createVerificationKey({
            key,
            target_username,
            note: note || '',
            created_by: req.user.id,
        });

        const created = db.getVerificationKeyByKey(key);
        res.status(201).json({ key: created });
    } catch (err) {
        console.error('[Admin] Verification key error:', err.message);
        res.status(500).json({ error: 'Failed to generate key' });
    }
});

// ── Revoke Key ───────────────────────────────────────────────
router.delete('/verification-keys/:id', (req, res) => {
    try {
        const result = db.revokeVerificationKey(req.params.id);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Key not found or already used/revoked' });
        }
        res.json({ message: 'Verification key revoked' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to revoke key' });
    }
});

module.exports = router;
