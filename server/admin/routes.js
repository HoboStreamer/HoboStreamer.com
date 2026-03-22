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
 * GET    /api/admin/storage                - Disk usage & per-directory breakdown
 * GET    /api/admin/storage/vods           - Detailed VOD file listing
 * DELETE /api/admin/storage/vods/bulk      - Bulk-delete VODs by ID
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const chatServer = require('../chat/chat-server');
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
        let { role, display_name, username } = req.body;
        const updates = [];
        const params = [];

        if (role) {
            const validRoles = ['user', 'streamer', 'global_mod', 'admin'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
            }
            updates.push('role = ?'); params.push(role);
        }
        if (username) {
            // Validate username format (same rules as registration)
            username = String(username).trim();
            if (username.length < 3 || username.length > 24) {
                return res.status(400).json({ error: 'Username must be 3-24 characters' });
            }
            if (!/^[a-zA-Z0-9_]+$/.test(username)) {
                return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
            }
            if (/^anon\d*$/i.test(username)) {
                return res.status(400).json({ error: 'That username is reserved for anonymous users' });
            }
            // Check uniqueness (case-insensitive)
            const existing = db.getUserByUsername(username);
            if (existing && String(existing.id) !== String(req.params.id)) {
                return res.status(409).json({ error: 'Username already taken' });
            }
            updates.push('username = ?'); params.push(username);
        }
        if (display_name) {
            // Sanitize display name — strip HTML + dangerous chars
            display_name = display_name.replace(/<[^>]*>/g, '').replace(/[\\`'"<>(){};:/\[\]]/g, '').replace(/\s+/g, ' ').trim();
            if (display_name.length < 1 || display_name.length > 60) {
                return res.status(400).json({ error: 'Display name must be 1-60 characters' });
            }
            updates.push('display_name = ?'); params.push(display_name);
        }

        if (updates.length > 0) {
            params.push(req.params.id);
            db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        // If display_name or username changed, update denormalized chat_messages.username
        // (chat_messages.username stores display_name at message creation time)
        if (display_name || username) {
            const freshUser = db.getUserById(req.params.id);
            if (freshUser) {
                const newChatName = freshUser.display_name || freshUser.username;
                db.run('UPDATE chat_messages SET username = ? WHERE user_id = ?', [newChatName, req.params.id]);
            }
        }

        const user = db.getUserById(req.params.id);
        // Sanitize — never expose password_hash or stream_key
        const { password_hash, stream_key, ...safeUser } = user;

        // Push real-time update to the affected user's chat connections
        if (updates.length > 0) {
            chatServer.sendUserUpdate(parseInt(req.params.id), safeUser);
        }

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

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: Number(req.params.id),
            action_type: 'site_ban',
            details: { reason: reason || 'Banned by admin', duration_hours: duration_hours || null },
        });

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

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: Number(req.params.id),
            action_type: 'site_unban',
        });

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
            "SELECT id, username, display_name, avatar_url, created_at, last_seen FROM users WHERE role IN ('mod', 'global_mod') ORDER BY username"
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

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: user.id,
            action_type: 'global_mod_promote',
            details: { username: user.username },
        });

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

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: user.id,
            action_type: 'global_mod_demote',
            details: { username: user.username },
        });

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

// ═══════════════════════════════════════════════════════════════
// Storage / Data Management
// ═══════════════════════════════════════════════════════════════

/**
 * Recursively compute total size (bytes) and file count for a directory.
 * Returns { bytes, files }.
 */
function dirStats(dirPath) {
    let bytes = 0, files = 0;
    try {
        const resolved = path.resolve(dirPath);
        if (!fs.existsSync(resolved)) return { bytes: 0, files: 0 };
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(resolved, entry.name);
            if (entry.isDirectory()) {
                const sub = dirStats(full);
                bytes += sub.bytes;
                files += sub.files;
            } else if (entry.isFile()) {
                try {
                    bytes += fs.statSync(full).size;
                    files++;
                } catch { /* permission / race */ }
            }
        }
    } catch { /* dir doesn't exist or inaccessible */ }
    return { bytes, files };
}

/**
 * Get disk usage for the volume containing a path.
 * Returns { total, used, available } in bytes.
 */
function diskUsage(targetPath) {
    try {
        const resolved = path.resolve(targetPath);
        // `df -B1` gives bytes; last line of output has the numbers
        const output = execSync(`df -B1 "${resolved}" 2>/dev/null | tail -1`, { encoding: 'utf8' });
        const parts = output.trim().split(/\s+/);
        // Format: Filesystem 1B-blocks Used Available Use% Mounted
        if (parts.length >= 6) {
            return {
                total: parseInt(parts[1], 10) || 0,
                used: parseInt(parts[2], 10) || 0,
                available: parseInt(parts[3], 10) || 0,
                usePct: parts[4] || '0%',
                mount: parts[5] || '/',
            };
        }
    } catch { /* not Linux / df not available */ }
    return { total: 0, used: 0, available: 0, usePct: '0%', mount: '/' };
}

// ── GET /api/admin/storage ───────────────────────────────────
// Full disk overview + per-directory breakdown
router.get('/storage', (req, res) => {
    try {
        const dataRoot = path.resolve('./data');
        const disk = diskUsage(dataRoot);

        // Per-directory breakdown
        const directories = [
            { name: 'VODs',       path: './data/vods',                icon: 'fa-video' },
            { name: 'Clips',      path: './data/clips',               icon: 'fa-film' },
            { name: 'Thumbnails', path: './data/thumbnails',          icon: 'fa-image' },
            { name: 'Avatars',    path: './data/avatars',             icon: 'fa-user-circle' },
            { name: 'Emotes',     path: './data/emotes',              icon: 'fa-face-smile' },
            { name: 'Media',      path: './data/media',               icon: 'fa-photo-film' },
            { name: 'Pastes',     path: './data/pastes',              icon: 'fa-paste' },
        ];

        const breakdown = directories.map(d => {
            const stats = dirStats(d.path);
            return { name: d.name, icon: d.icon, bytes: stats.bytes, files: stats.files };
        });

        // Database file size
        let dbBytes = 0;
        try { dbBytes = fs.statSync(path.resolve('./data/hobostreamer.db')).size; } catch {}

        // Total data directory
        const dataTotal = dirStats(dataRoot);

        // VOD stats from DB
        const vodDbStats = db.get(`
            SELECT COUNT(*) as count,
                   COALESCE(SUM(file_size), 0) as totalSize,
                   COALESCE(MIN(created_at), '') as oldest,
                   COALESCE(MAX(created_at), '') as newest
            FROM vods
        `) || {};

        // Clip stats from DB
        const clipDbStats = db.get(`
            SELECT COUNT(*) as count
            FROM clips
        `) || {};

        res.json({
            disk,
            dataTotal: { bytes: dataTotal.bytes, files: dataTotal.files },
            database: { bytes: dbBytes },
            breakdown,
            vodStats: vodDbStats,
            clipStats: clipDbStats,
        });
    } catch (err) {
        console.error('[Admin] Storage error:', err.message);
        res.status(500).json({ error: 'Failed to analyze storage' });
    }
});

// ── GET /api/admin/storage/vods ──────────────────────────────
// Detailed VOD listing with file sizes, owner info, age
router.get('/storage/vods', (req, res) => {
    try {
        const sort = req.query.sort || 'size'; // size, date, user
        const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
        const limit = Math.min(parseInt(req.query.limit || '100'), 500);
        const offset = parseInt(req.query.offset || '0');

        let orderBy;
        switch (sort) {
            case 'date': orderBy = `v.created_at ${order}`; break;
            case 'user': orderBy = `u.username ${order}, v.file_size DESC`; break;
            case 'duration': orderBy = `v.duration_seconds ${order}`; break;
            default:      orderBy = `v.file_size ${order}`; break;
        }

        const vods = db.all(`
            SELECT v.id, v.title, v.file_path, v.file_size, v.duration_seconds,
                   v.is_public, v.is_recording, v.created_at,
                   v.stream_id, u.username, u.display_name, u.id as user_id
            FROM vods v
            JOIN users u ON v.user_id = u.id
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
        `, [limit, offset]);

        const total = db.get('SELECT COUNT(*) as c FROM vods').c;

        // Verify which files actually exist on disk
        const enriched = vods.map(v => {
            let diskSize = 0;
            let exists = false;
            if (v.file_path) {
                try {
                    const stat = fs.statSync(path.resolve(v.file_path));
                    diskSize = stat.size;
                    exists = true;
                } catch { /* file missing */ }
            }
            return { ...v, diskSize, fileExists: exists };
        });

        // Per-user summary
        const userSummary = db.all(`
            SELECT u.username, u.id as user_id, COUNT(v.id) as vodCount,
                   COALESCE(SUM(v.file_size), 0) as totalSize
            FROM vods v JOIN users u ON v.user_id = u.id
            GROUP BY v.user_id
            ORDER BY totalSize DESC
            LIMIT 20
        `);

        res.json({ vods: enriched, total, userSummary });
    } catch (err) {
        console.error('[Admin] VOD storage error:', err.message);
        res.status(500).json({ error: 'Failed to list VOD storage' });
    }
});

// ── DELETE /api/admin/storage/vods/bulk ──────────────────────
// Bulk delete VODs by array of IDs
router.delete('/storage/vods/bulk', (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'ids array required' });
        }
        if (ids.length > 200) {
            return res.status(400).json({ error: 'Max 200 VODs per bulk delete' });
        }

        let deleted = 0, freed = 0, errors = [];
        for (const id of ids) {
            try {
                const vod = db.get('SELECT * FROM vods WHERE id = ?', [id]);
                if (!vod) { errors.push(`VOD ${id} not found`); continue; }

                // Delete file from disk
                if (vod.file_path) {
                    const filePath = path.resolve(vod.file_path);
                    if (fs.existsSync(filePath)) {
                        const size = fs.statSync(filePath).size;
                        fs.unlinkSync(filePath);
                        freed += size;
                    }
                    // Also remove .seekable variant if exists
                    const seekable = filePath.replace(/(\.[^.]+)$/, '.seekable$1');
                    if (fs.existsSync(seekable)) {
                        freed += fs.statSync(seekable).size;
                        fs.unlinkSync(seekable);
                    }
                }

                db.run('DELETE FROM vods WHERE id = ?', [id]);
                deleted++;
            } catch (err) {
                errors.push(`VOD ${id}: ${err.message}`);
            }
        }

        console.log(`[Admin] Bulk VOD delete by ${req.user.username}: ${deleted}/${ids.length} deleted, ${(freed / 1048576).toFixed(1)} MB freed`);
        res.json({ deleted, freed, errors: errors.length ? errors : undefined });
    } catch (err) {
        console.error('[Admin] Bulk VOD delete error:', err.message);
        res.status(500).json({ error: 'Bulk delete failed' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Media Tools — yt-dlp cookies, diagnostics, test extraction
// ═══════════════════════════════════════════════════════════════
const downloader = require('../media/media-downloader');

// GET  /api/admin/media-tools/status — yt-dlp availability + cookies status
router.get('/media-tools/status', (req, res) => {
    try {
        const cookiesPath = downloader.getCookiesPath();
        let cookiesExist = false;
        let cookiesSize = 0;
        try {
            const stat = fs.statSync(cookiesPath);
            cookiesExist = stat.size > 0;
            cookiesSize = stat.size;
        } catch {}
        res.json({
            ytdlp_available: downloader.isAvailable(),
            ytdlp_path: downloader.getYtdlpPath(),
            cookies_configured: cookiesExist,
            cookies_size: cookiesSize,
            cookies_path: cookiesPath,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT  /api/admin/media-tools/cookies — Upload/paste cookies.txt content
router.put('/media-tools/cookies', (req, res) => {
    try {
        const { cookies } = req.body;
        if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 10) {
            return res.status(400).json({ error: 'Cookies content is required (Netscape cookies.txt format)' });
        }
        const cookiesPath = downloader.getCookiesPath();
        const dir = path.dirname(cookiesPath);
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        fs.writeFileSync(cookiesPath, cookies.trim() + '\n', 'utf8');
        console.log(`[Admin] yt-dlp cookies updated by ${req.user.username} (${cookies.length} bytes)`);
        res.json({ message: 'Cookies saved', size: cookies.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/media-tools/cookies — Remove cookies file
router.delete('/media-tools/cookies', (req, res) => {
    try {
        const cookiesPath = downloader.getCookiesPath();
        try { fs.unlinkSync(cookiesPath); } catch {}
        console.log(`[Admin] yt-dlp cookies removed by ${req.user.username}`);
        res.json({ message: 'Cookies removed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/media-tools/test — Test yt-dlp extraction on a URL
router.post('/media-tools/test', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'URL is required' });
        }
        const results = { url, steps: [] };

        // Step 1: Check yt-dlp availability
        results.steps.push({ name: 'yt-dlp available', ok: downloader.isAvailable() });
        if (!downloader.isAvailable()) {
            return res.json(results);
        }

        // Step 2: Get info
        try {
            const info = await downloader.getInfo(url);
            results.steps.push({ name: 'getInfo', ok: true, data: { title: info.title, duration: info.duration, extractor: info.extractor } });
        } catch (err) {
            results.steps.push({ name: 'getInfo', ok: false, error: err.message });
        }

        // Step 3: Extract stream URL
        try {
            const stream = await downloader.extractStreamUrl(url);
            results.steps.push({ name: 'extractStreamUrl', ok: true, data: { streamUrl: stream.streamUrl.substring(0, 120) + '...' } });
        } catch (err) {
            results.steps.push({ name: 'extractStreamUrl', ok: false, error: err.message });
        }

        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
