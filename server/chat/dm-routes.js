/**
 * HoboStreamer — DM REST API Routes
 *
 * GET  /api/dm/conversations          — list conversations
 * POST /api/dm/conversations          — create or get 1-on-1 / group
 * GET  /api/dm/conversations/:id      — get conversation details + participants
 * GET  /api/dm/conversations/:id/messages — paginated messages
 * POST /api/dm/conversations/:id/messages — send a message
 * POST /api/dm/conversations/:id/read — mark conversation read
 * POST /api/dm/conversations/:id/participants — add participant to group
 * DELETE /api/dm/conversations/:id/participants/:userId — remove participant
 * PATCH /api/dm/conversations/:id     — rename group
 * GET  /api/dm/unread                 — total unread count
 * GET  /api/dm/users/search           — search users for new-message picker
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/auth');
const dm = require('./dm');

// All DM routes require authentication
router.use(requireAuth);

// List conversations for current user
router.get('/conversations', (req, res) => {
    try {
        const conversations = dm.getConversations(req.user.id);
        // Attach participant info to each conversation
        for (const conv of conversations) {
            conv.participants = dm.getParticipants(conv.id);
        }
        res.json({ conversations });
    } catch (err) {
        console.error('[DM] List conversations error:', err.message);
        res.status(500).json({ error: 'Failed to load conversations' });
    }
});

// Create or get a conversation
router.post('/conversations', (req, res) => {
    try {
        const { user_ids, name } = req.body;
        if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
            return res.status(400).json({ error: 'user_ids array required' });
        }
        // Ensure current user is included
        const participantIds = [...new Set([req.user.id, ...user_ids.map(Number).filter(Boolean)])];
        if (participantIds.length < 2) {
            return res.status(400).json({ error: 'Need at least one other user' });
        }

        let conversationId;
        if (participantIds.length === 2) {
            // 1-on-1: get or create
            const otherId = participantIds.find(id => id !== req.user.id);
            conversationId = dm.getOrCreateDirect(req.user.id, otherId);
        } else {
            // Group: always create new
            conversationId = dm.createConversation(req.user.id, participantIds, name || null);
        }

        const conversation = dm.getConversation(conversationId);
        conversation.participants = dm.getParticipants(conversationId);
        res.json({ conversation });
    } catch (err) {
        console.error('[DM] Create conversation error:', err.message);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
});

// Get conversation details
router.get('/conversations/:id', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const conversation = dm.getConversation(convId);
        if (!conversation) return res.status(404).json({ error: 'Not found' });
        conversation.participants = dm.getParticipants(convId);
        res.json({ conversation });
    } catch (err) {
        console.error('[DM] Get conversation error:', err.message);
        res.status(500).json({ error: 'Failed to load conversation' });
    }
});

// Get messages (paginated)
router.get('/conversations/:id/messages', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const before = parseInt(req.query.before) || null;
        const messages = dm.getMessages(convId, limit, before);
        res.json({ messages });
    } catch (err) {
        console.error('[DM] Get messages error:', err.message);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// Send a message
router.post('/conversations/:id/messages', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const { message } = req.body;
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: 'Message required' });
        }
        const msg = dm.sendMessage(convId, req.user.id, message);
        if (!msg) return res.status(400).json({ error: 'Failed to send' });

        // Attach sender info
        const db = require('../db/database');
        const sender = db.getUserById(req.user.id);
        msg.username = sender?.username;
        msg.display_name = sender?.display_name;
        msg.avatar_url = sender?.avatar_url;
        msg.profile_color = sender?.profile_color;

        // Real-time delivery via chat WebSocket
        try {
            const chatServer = require('./chat-server');
            const participants = dm.getParticipants(convId);
            for (const p of participants) {
                if (p.id === req.user.id) continue; // skip sender
                chatServer.sendDm(p.id, {
                    type: 'dm',
                    conversation_id: convId,
                    message: msg,
                });
            }
        } catch { /* non-critical */ }

        res.json({ message: msg });
    } catch (err) {
        console.error('[DM] Send message error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Mark conversation read
router.post('/conversations/:id/read', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        dm.markRead(convId, req.user.id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Mark read error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Add participant to group
router.post('/conversations/:id/participants', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id required' });
        dm.addParticipant(convId, user_id);
        const participants = dm.getParticipants(convId);

        // Notify all participants about the new member
        try {
            const chatServer = require('./chat-server');
            for (const p of participants) {
                chatServer.sendDm(p.id, {
                    type: 'dm-participant-added',
                    conversation_id: convId,
                    user_id,
                    participants,
                });
            }
        } catch { /* non-critical */ }

        res.json({ participants });
    } catch (err) {
        console.error('[DM] Add participant error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Remove participant from group
router.delete('/conversations/:id/participants/:userId', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const targetUserId = parseInt(req.params.userId);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        // Can only remove self (leave) or be the creator
        const conv = dm.getConversation(convId);
        if (targetUserId !== req.user.id && conv?.created_by !== req.user.id) {
            return res.status(403).json({ error: 'Only the creator can remove others' });
        }
        dm.removeParticipant(convId, targetUserId);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Remove participant error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Rename group conversation
router.patch('/conversations/:id', (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const { name } = req.body;
        dm.renameConversation(convId, name || null);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Rename error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Total unread count
router.get('/unread', (req, res) => {
    try {
        const total = dm.getTotalUnread(req.user.id);
        res.json({ unread: total });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// Search users for new-message picker
router.get('/users/search', (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 1) return res.json({ users: [] });
        const users = dm.searchUsers(q, req.user.id);
        res.json({ users });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

module.exports = router;
