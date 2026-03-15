const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const { canManageChannel, isStaff } = require('../auth/permissions');

const router = express.Router();

router.use(requireAuth);

function parseBoolean(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
    }
    return fallback;
}

function requireChannelAccess(req, res, next) {
    const channelId = parseInt(req.params.channelId, 10);
    if (!channelId) return res.status(400).json({ error: 'Invalid channel ID' });
    const channel = db.getChannelById(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!canManageChannel(req.user, channelId)) {
        return res.status(403).json({ error: 'Channel moderation access required' });
    }
    req.channel = channel;
    next();
}

router.get('/moderation/mine', (req, res) => {
    try {
        const channels = db.getOwnedAndModeratedChannels(req.user.id).map((channel) => ({
            ...channel,
            moderation_settings: db.getChannelModerationSettings(channel.id),
            moderators: db.getChannelModerators(channel.id),
        }));
        res.json({ channels });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load channel moderation access' });
    }
});

router.get('/:channelId/moderators', requireChannelAccess, (req, res) => {
    res.json({ moderators: db.getChannelModerators(req.channel.id) });
});

router.post('/:channelId/moderators', requireChannelAccess, (req, res) => {
    try {
        const username = (req.body.username || '').trim();
        if (!username) return res.status(400).json({ error: 'Username is required' });
        const user = db.getUserByUsername(username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.id === req.channel.user_id) {
            return res.status(400).json({ error: 'Channel owner does not need moderator status' });
        }
        db.addChannelModerator(req.channel.id, user.id, req.user.id);
        db.logModerationAction({
            scope_type: 'channel',
            scope_id: req.channel.id,
            actor_user_id: req.user.id,
            target_user_id: user.id,
            action_type: 'channel_mod_add',
            details: { channel_id: req.channel.id, username: user.username },
        });
        res.status(201).json({ moderators: db.getChannelModerators(req.channel.id) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add channel moderator' });
    }
});

router.delete('/:channelId/moderators/:userId', requireChannelAccess, (req, res) => {
    try {
        const targetUserId = parseInt(req.params.userId, 10);
        const target = db.getUserById(targetUserId);
        if (!target) return res.status(404).json({ error: 'User not found' });
        db.removeChannelModerator(req.channel.id, targetUserId);
        db.logModerationAction({
            scope_type: 'channel',
            scope_id: req.channel.id,
            actor_user_id: req.user.id,
            target_user_id: targetUserId,
            action_type: 'channel_mod_remove',
            details: { channel_id: req.channel.id, username: target.username },
        });
        res.json({ moderators: db.getChannelModerators(req.channel.id) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove channel moderator' });
    }
});

router.get('/:channelId/moderation/settings', requireChannelAccess, (req, res) => {
    try {
        res.json({ settings: db.getChannelModerationSettings(req.channel.id) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load channel moderation settings' });
    }
});

router.put('/:channelId/moderation/settings', requireChannelAccess, (req, res) => {
    try {
        const nextSettings = db.upsertChannelModerationSettings(req.channel.id, {
            slowmode_seconds: Number(req.body.slowmode_seconds ?? req.body.slowmodeSeconds ?? 0),
            allow_anonymous: parseBoolean(req.body.allow_anonymous ?? req.body.allowAnonymous, true),
            links_allowed: parseBoolean(req.body.links_allowed ?? req.body.linksAllowed, true),
            aggressive_filter: parseBoolean(req.body.aggressive_filter ?? req.body.aggressiveFilter, false),
            followers_only: parseBoolean(req.body.followers_only ?? req.body.followersOnly, false),
            account_age_gate_hours: Number(req.body.account_age_gate_hours ?? req.body.accountAgeGateHours ?? 0),
            caps_percentage_limit: Number(req.body.caps_percentage_limit ?? req.body.capsPercentageLimit ?? 70),
            max_message_length: Number(req.body.max_message_length ?? req.body.maxMessageLength ?? 500),
        }, req.user.id);

        db.logModerationAction({
            scope_type: 'channel',
            scope_id: req.channel.id,
            actor_user_id: req.user.id,
            action_type: 'channel_settings_update',
            details: nextSettings,
        });
        res.json({ settings: nextSettings });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save channel moderation settings' });
    }
});

router.get('/:channelId/moderation/logs', requireChannelAccess, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        res.json({
            actions: db.getModerationActions({
                scopeType: 'channel',
                scopeId: req.channel.id,
                limit,
                offset,
            }),
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load channel moderation log' });
    }
});

router.get('/:channelId/moderation/chat-search', requireChannelAccess, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const q = (req.query.q || '').trim();
        const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
        const result = db.searchChannelChatMessages(req.channel.user_id, { query: q, userId, limit, offset });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to search channel chat' });
    }
});

router.post('/:channelId/moderation/messages/:messageId/delete', requireChannelAccess, (req, res) => {
    try {
        const messageId = parseInt(req.params.messageId, 10);
        const message = db.getChatMessageById(messageId);
        if (!message) return res.status(404).json({ error: 'Message not found' });
        if (message.stream_owner_id !== req.channel.user_id && !isStaff(req.user)) {
            return res.status(403).json({ error: 'Message is outside this channel scope' });
        }
        db.deleteChatMessage(messageId);
        db.logModerationAction({
            scope_type: 'channel',
            scope_id: req.channel.id,
            actor_user_id: req.user.id,
            target_user_id: message.user_id,
            action_type: 'channel_message_delete',
            details: { message_id: messageId, stream_id: message.stream_id },
        });
        res.json({ message: 'Message deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

module.exports = router;
