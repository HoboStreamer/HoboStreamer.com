/**
 * HoboStreamer — Channel Moderator Routes
 *
 * Manage per-channel mod assignments.
 *
 * GET    /api/channels/:id/mods           - List channel mods
 * POST   /api/channels/:id/mods           - Add channel mod (channel owner or admin)
 * DELETE /api/channels/:id/mods/:userId   - Remove channel mod
 * GET    /api/channels/:id/moderation     - Get channel moderation settings
 * PUT    /api/channels/:id/moderation     - Update channel moderation settings
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');

const router = express.Router({ mergeParams: true });

// ── List channel mods ────────────────────────────────────────
router.get('/:channelId/mods', requireAuth, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const mods = db.getChannelModerators(channelId);
        res.json({ moderators: mods, channel_id: channelId });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list channel moderators' });
    }
});

// ── Add channel mod ──────────────────────────────────────────
router.post('/:channelId/mods', requireAuth, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        if (!permissions.canAssignChannelMods(req.user, channelId)) {
            return res.status(403).json({ error: 'Only the channel owner or an admin can add moderators' });
        }

        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Username is required' });

        const targetUser = db.getUserByUsername(username);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        if (targetUser.id === channel.user_id) {
            return res.status(400).json({ error: 'Channel owner is already a moderator' });
        }

        db.addChannelModerator(channelId, targetUser.id, req.user.id);
        res.json({ message: `${targetUser.username} added as channel moderator` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add channel moderator' });
    }
});

// ── Remove channel mod ───────────────────────────────────────
router.delete('/:channelId/mods/:userId', requireAuth, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const userId = parseInt(req.params.userId);
        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        if (!permissions.canAssignChannelMods(req.user, channelId)) {
            return res.status(403).json({ error: 'Only the channel owner or an admin can remove moderators' });
        }

        db.removeChannelModerator(channelId, userId);
        res.json({ message: 'Channel moderator removed' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove channel moderator' });
    }
});

// ── Get channel moderation settings ──────────────────────────
router.get('/:channelId/moderation', requireAuth, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const settings = db.getChannelModerationSettings(channelId);
        res.json({ settings });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get moderation settings' });
    }
});

// ── Update channel moderation settings ───────────────────────
router.put('/:channelId/moderation', requireAuth, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const channel = db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        if (!permissions.canModerateChannel(req.user, channelId)) {
            return res.status(403).json({ error: 'Permission denied' });
        }

        const { slow_mode_seconds, followers_only, emote_only } = req.body;
        const settings = db.upsertChannelModerationSettings(channelId, {
            slow_mode_seconds: slow_mode_seconds !== undefined ? Math.max(0, parseInt(slow_mode_seconds) || 0) : undefined,
            followers_only,
            emote_only,
        });
        res.json({ settings });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update moderation settings' });
    }
});

module.exports = router;
