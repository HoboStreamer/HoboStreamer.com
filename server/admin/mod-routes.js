/**
 * HoboStreamer — Moderator API Routes
 *
 * Accessible by global_mod + admin.
 * These are moderator-specific tools that don't belong in the admin panel.
 *
 * GET    /api/mod/bans                    - List stream-scoped bans
 * POST   /api/mod/global-ban              - Global ban (admin + global_mod): site-wide + IP
 * POST   /api/mod/stream-ban              - Local ban (any mod with stream powers)
 * DELETE /api/mod/ban/:id                 - Unban (removes ban entry + clears is_banned if global)
 * GET    /api/mod/chat/search             - Search all chat logs
 * GET    /api/mod/chat/user/:userId       - View a user's chat history
 * GET    /api/mod/ip/user/:userId         - Get all IPs used by a user
 * GET    /api/mod/ip/anon/:anonId         - Get latest IP + alts for an anon
 * GET    /api/mod/ip/lookup/:ip           - Get all accounts on an IP
 * GET    /api/mod/ip/alts/:userId         - Get linked accounts (alt detection)
 * POST   /api/mod/ip/ban-all              - Ban all accounts on an IP
 * GET    /api/mod/ip/log                  - Search IP history log
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const chatServer = require('../chat/chat-server');
const ipUtils = require('./ip-utils');

const router = express.Router();

// All mod routes require auth (individual routes check specific permissions)
router.use(requireAuth);

// ── List bans ────────────────────────────────────────────────
router.get('/bans', permissions.requireGlobalMod, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100'), 500);
        const streamId = req.query.stream_id ? parseInt(req.query.stream_id) : null;
        const where = streamId ? 'WHERE b.stream_id = ?' : '';
        const params = streamId ? [streamId, limit] : [limit];
        const bans = db.all(`
            SELECT b.*, u.username as banned_username, m.username as banned_by_username,
                   s.title as stream_title
            FROM bans b
            LEFT JOIN users u ON b.user_id = u.id
            LEFT JOIN users m ON b.banned_by = m.id
            LEFT JOIN streams s ON b.stream_id = s.id
            ${where}
            ORDER BY b.created_at DESC LIMIT ?
        `, params);
        res.json({ bans });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list bans' });
    }
});

// ── Global Ban (admin + global_mod) ──────────────────────────
// Site-wide ban: sets is_banned flag, creates bans entry with no stream_id, adds IP ban.
// Also cascades: bans all other accounts that share this user's IP.
router.post('/global-ban', permissions.requireGlobalMod, (req, res) => {
    try {
        const { user_id, reason, duration_hours, ip_address } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id required' });

        const targetUser = db.getUserById(parseInt(user_id));
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        const banReason = reason || 'Banned by moderator';
        const expires = duration_hours
            ? new Date(Date.now() + parseInt(duration_hours) * 3600000).toISOString()
            : null;

        // Auto-detect IP from connected WebSocket clients, then fall back to IP log
        let resolvedIp = ip_address || chatServer.getConnectedUserIp(targetUser.id);
        if (!resolvedIp) {
            const latest = db.getLatestIpForUser(targetUser.id);
            if (latest) resolvedIp = latest.ip_address;
        }

        // Set the site-wide is_banned flag
        db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?',
            [banReason, targetUser.id]);

        // Create user-based global ban
        db.run(
            `INSERT INTO bans (user_id, ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
            [targetUser.id, resolvedIp, banReason, req.user.id, expires]
        );

        // Also create standalone IP ban for the IP (catches alt accounts + future visits)
        if (resolvedIp) {
            db.run(
                `INSERT INTO bans (ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
                [resolvedIp, banReason + ` (IP of ${targetUser.username})`, req.user.id, expires]
            );

            // Cascade: ban all other accounts that have ever used this IP
            const linked = db.getLinkedAccounts(targetUser.id);
            let cascadeBanned = 0;
            for (const alt of linked) {
                if (alt.is_banned) continue; // already banned
                db.run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?',
                    [banReason + ` (alt of ${targetUser.username})`, alt.id]);
                db.run(`INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
                    [alt.id, banReason + ` (alt of ${targetUser.username})`, req.user.id, expires]);
                chatServer.disconnectUser({ userId: alt.id });
                cascadeBanned++;
            }

            if (cascadeBanned > 0) {
                console.log(`[Mod] Global ban cascade: ${cascadeBanned} alt accounts of ${targetUser.username} also banned`);
            }
        }

        // Immediately disconnect the user from chat
        chatServer.disconnectUser({ userId: targetUser.id, ip: resolvedIp });

        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            target_user_id: targetUser.id,
            action_type: 'global_ban',
            details: { reason: banReason, duration_hours: duration_hours || null, ip: resolvedIp },
        });

        res.json({ message: `${targetUser.username} globally banned` });
    } catch (err) {
        console.error('[Mod] Global ban error:', err.message);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// ── Stream Ban (any mod with stream moderation powers) ───────
// Local ban: creates bans entry scoped to a specific stream
router.post('/stream-ban', (req, res) => {
    try {
        const { user_id, anon_id, stream_id, reason, duration_hours, ip_address } = req.body;
        const streamId = parseInt(stream_id);
        if (!streamId) return res.status(400).json({ error: 'stream_id required' });
        if (!user_id && !anon_id) return res.status(400).json({ error: 'user_id or anon_id required' });

        // Check moderation permission for this stream
        if (!permissions.canModerateStream(req.user, streamId)) {
            return res.status(403).json({ error: 'You cannot moderate this stream' });
        }

        const banReason = reason || 'Banned by moderator';
        const expires = duration_hours
            ? new Date(Date.now() + parseInt(duration_hours) * 3600000).toISOString()
            : null;

        if (user_id) {
            const targetUser = db.getUserById(parseInt(user_id));
            if (!targetUser) return res.status(404).json({ error: 'User not found' });

            // Auto-detect IP from connected clients if not provided
            const resolvedIp = ip_address || chatServer.getConnectedUserIp(targetUser.id);

            db.run(
                `INSERT INTO bans (stream_id, user_id, ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [streamId, targetUser.id, resolvedIp, banReason, req.user.id, expires]
            );

            // Disconnect from this stream's chat
            chatServer.disconnectUser({ userId: targetUser.id, ip: resolvedIp, streamId });

            db.logModerationAction({
                scope_type: 'stream',
                scope_id: streamId,
                actor_user_id: req.user.id,
                target_user_id: targetUser.id,
                action_type: 'stream_ban',
                details: { reason: banReason, duration_hours: duration_hours || null },
            });

            res.json({ message: `${targetUser.username} banned from stream` });
        } else {
            // Anon ban — look up IP from connected anon client
            const anonClient = chatServer.findClientByAnonId(anon_id, streamId);
            const resolvedIp = ip_address || anonClient?.ip || null;

            db.run(
                `INSERT INTO bans (stream_id, ip_address, anon_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [streamId, resolvedIp, anon_id, banReason, req.user.id, expires]
            );

            // Disconnect the anon user
            if (resolvedIp) chatServer.disconnectUser({ ip: resolvedIp, streamId });

            db.logModerationAction({
                scope_type: 'stream',
                scope_id: streamId,
                actor_user_id: req.user.id,
                action_type: 'stream_ban_anon',
                details: { anon_id, reason: banReason, duration_hours: duration_hours || null },
            });

            res.json({ message: `${anon_id} banned from stream` });
        }
    } catch (err) {
        console.error('[Mod] Stream ban error:', err.message);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// ── Unban ────────────────────────────────────────────────────
router.delete('/ban/:id', (req, res) => {
    try {
        const ban = db.get('SELECT * FROM bans WHERE id = ?', [req.params.id]);
        if (!ban) return res.status(404).json({ error: 'Ban not found' });

        // Permission check: global bans require global_mod+, stream bans require stream mod
        if (!ban.stream_id) {
            if (!permissions.isGlobalModOrAbove(req.user)) {
                return res.status(403).json({ error: 'Only global mods can remove global bans' });
            }
            // Clear is_banned flag if this was a global user ban
            if (ban.user_id) {
                db.run('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [ban.user_id]);
                // Remove ALL global bans for this user (user + IP entries)
                db.run('DELETE FROM bans WHERE user_id = ? AND stream_id IS NULL', [ban.user_id]);
                db.run('DELETE FROM bans WHERE ip_address IS NOT NULL AND banned_by = ? AND stream_id IS NULL AND reason LIKE ?',
                    [ban.banned_by, '%' + (ban.reason || '') + '%']);
            }
        } else {
            if (!permissions.canModerateStream(req.user, ban.stream_id)) {
                return res.status(403).json({ error: 'You cannot moderate this stream' });
            }
        }

        db.run('DELETE FROM bans WHERE id = ?', [req.params.id]);

        db.logModerationAction({
            scope_type: ban.stream_id ? 'stream' : 'site',
            scope_id: ban.stream_id || undefined,
            actor_user_id: req.user.id,
            target_user_id: ban.user_id || undefined,
            action_type: 'unban',
            details: { ban_id: ban.id, original_reason: ban.reason },
        });

        res.json({ message: 'Ban removed' });
    } catch (err) {
        console.error('[Mod] Unban error:', err.message);
        res.status(500).json({ error: 'Failed to unban' });
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

// ══════════════════════════════════════════════════════════════
//  IP TRACKING & ADMIN TOOLS
// ══════════════════════════════════════════════════════════════

// ── Get all IPs used by a user ───────────────────────────────
router.get('/ip/user/:userId', permissions.requireGlobalMod, (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const user = db.getUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const ips = db.getIpsByUser(userId);
        const linked = db.getLinkedAccounts(userId);

        // Also check if the user is currently connected and get their live IP
        const liveIp = chatServer.getConnectedUserIp(userId);

        res.json({
            user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, is_banned: user.is_banned, ban_reason: user.ban_reason, created_at: user.created_at },
            ips,
            linked_accounts: linked,
            live_ip: liveIp || null,
        });
    } catch (err) {
        console.error('[Mod] IP user lookup error:', err.message);
        res.status(500).json({ error: 'Failed to lookup user IPs' });
    }
});

// ── Get IP info for an anon ──────────────────────────────────
router.get('/ip/anon/:anonId', permissions.requireGlobalMod, (req, res) => {
    try {
        const anonId = req.params.anonId;
        const latest = db.getLatestIpForAnon(anonId);
        const linked = db.getLinkedAccountsByAnon(anonId);

        // Try to find their live IP from connected clients
        const anonClient = chatServer.findClientByAnonId(anonId);
        const liveIp = anonClient?.ip || null;
        const currentIp = liveIp || latest?.ip_address || null;

        // If we have an IP, do a GeoIP lookup
        let geo = null;
        if (currentIp) {
            geo = ipUtils.lookupIp(currentIp);
        }

        res.json({
            anon_id: anonId,
            current_ip: currentIp,
            geo,
            latest_record: latest,
            linked_accounts: linked,
        });
    } catch (err) {
        console.error('[Mod] IP anon lookup error:', err.message);
        res.status(500).json({ error: 'Failed to lookup anon IPs' });
    }
});

// ── Lookup all accounts on a specific IP ─────────────────────
router.get('/ip/lookup/:ip', permissions.requireGlobalMod, (req, res) => {
    try {
        const ip = req.params.ip;
        const users = db.getUsersByIp(ip);
        const geo = ipUtils.lookupIp(ip);
        const isBanned = db.isIpBanned(ip, null);

        res.json({ ip, geo, is_banned: isBanned, accounts: users });
    } catch (err) {
        console.error('[Mod] IP lookup error:', err.message);
        res.status(500).json({ error: 'Failed to lookup IP' });
    }
});

// ── Get linked accounts (alt detection) ──────────────────────
router.get('/ip/alts/:userId', permissions.requireGlobalMod, (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const linked = db.getLinkedAccounts(userId);
        res.json({ user_id: userId, linked_accounts: linked });
    } catch (err) {
        console.error('[Mod] Alt detection error:', err.message);
        res.status(500).json({ error: 'Failed to find linked accounts' });
    }
});

// ── Ban all accounts on an IP ────────────────────────────────
router.post('/ip/ban-all', permissions.requireGlobalMod, (req, res) => {
    try {
        const { ip, reason, duration_hours } = req.body;
        if (!ip) return res.status(400).json({ error: 'ip required' });

        const banReason = reason || 'IP-wide ban by moderator';
        const expires = duration_hours
            ? new Date(Date.now() + parseInt(duration_hours) * 3600000).toISOString()
            : null;

        const bannedIds = db.banAllAccountsOnIp(ip, {
            reason: banReason,
            bannedBy: req.user.id,
            expires,
        });

        // Disconnect all clients on this IP
        chatServer.disconnectUser({ ip });

        // Log the action
        db.logModerationAction({
            scope_type: 'site',
            actor_user_id: req.user.id,
            action_type: 'ip_ban_all',
            details: { ip, reason: banReason, banned_user_ids: bannedIds, duration_hours: duration_hours || null },
        });

        res.json({ message: `Banned IP ${ip} and ${bannedIds.length} associated account(s)`, banned_user_ids: bannedIds });
    } catch (err) {
        console.error('[Mod] IP ban-all error:', err.message);
        res.status(500).json({ error: 'Failed to ban IP' });
    }
});

// ── Search IP history log ────────────────────────────────────
router.get('/ip/log', permissions.requireGlobalMod, (req, res) => {
    try {
        const filters = {};
        if (req.query.user_id) filters.userId = parseInt(req.query.user_id);
        if (req.query.anon_id) filters.anonId = req.query.anon_id;
        if (req.query.ip) filters.ip = req.query.ip;
        if (req.query.action) filters.action = req.query.action;
        filters.limit = Math.min(parseInt(req.query.limit || '100'), 500);
        filters.offset = parseInt(req.query.offset || '0');

        const log = db.getIpLog(filters);
        res.json({ log });
    } catch (err) {
        console.error('[Mod] IP log error:', err.message);
        res.status(500).json({ error: 'Failed to get IP log' });
    }
});

module.exports = router;
