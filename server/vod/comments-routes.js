/**
 * HoboStreamer — Comments API Routes
 * 
 * GET    /api/comments/:type/:id       - List comments for a VOD or clip
 * POST   /api/comments/:type/:id       - Add a comment (auth)
 * PUT    /api/comments/:commentId      - Edit a comment (author or admin)
 * DELETE /api/comments/:commentId      - Delete a comment (author, content owner, or admin)
 * GET    /api/comments/:commentId/replies - Get replies to a comment
 */
const express = require('express');
const db = require('../db/database');
const { requireAuth, optionalAuth } = require('../auth/auth');

const router = express.Router();
const HOBO_TOOLS_INTERNAL_URL = process.env.HOBO_TOOLS_INTERNAL_URL || 'http://127.0.0.1:3100';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.HOBO_INTERNAL_KEY || '';

function truncatePreview(text, max = 120) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function notificationActor(user) {
    return {
        sender_id: user?.id || null,
        sender_name: user?.display_name || user?.username || 'Someone',
        sender_avatar: user?.avatar_url || null,
    };
}

function pushNotification(payload) {
    if (!payload?.user_id) return;

    fetch(`${HOBO_TOOLS_INTERNAL_URL}/internal/notifications/push`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': INTERNAL_API_KEY,
        },
        body: JSON.stringify(payload),
    }).then((response) => {
        if (!response.ok) {
            console.warn(`[Notify] Comment notification push failed: ${response.status}`);
        }
    }).catch((err) => {
        console.warn('[Notify] Comment notification push error:', err.message);
    });
}

function getCommentTarget(contentType, contentId) {
    if (contentType === 'vod') {
        const vod = db.getVodById(contentId);
        if (!vod) return null;
        return {
            user_id: vod.user_id,
            title: vod.title || 'your VOD',
            label: 'VOD',
            url: 'https://hobostreamer.com/vods',
        };
    }

    if (contentType === 'clip') {
        const clip = db.getClipById(contentId);
        if (!clip) return null;
        return {
            user_id: clip.user_id,
            title: clip.title || 'your clip',
            label: 'clip',
            url: 'https://hobostreamer.com/clips',
        };
    }

    return null;
}

// ── List Comments ────────────────────────────────────────────
router.get('/:type/:id', optionalAuth, (req, res) => {
    try {
        const contentType = req.params.type;
        const contentId = parseInt(req.params.id);
        if (!['vod', 'clip'].includes(contentType) || !contentId) {
            return res.status(400).json({ error: 'Invalid content type or ID' });
        }

        const limit = Math.min(parseInt(req.query.limit || '50'), 100);
        const offset = parseInt(req.query.offset || '0');

        const comments = db.getComments(contentType, contentId, limit, offset);
        const totalCount = db.getCommentCount(contentType, contentId);

        // Attach reply counts for each top-level comment
        for (const c of comments) {
            const replies = db.getCommentReplies(c.id);
            c.replies = replies;
            c.reply_count = replies.length;
        }

        res.json({ comments, total: totalCount });
    } catch (err) {
        console.error('[Comments] List error:', err.message);
        res.status(500).json({ error: 'Failed to get comments' });
    }
});

// ── Add Comment ──────────────────────────────────────────────
router.post('/:type/:id', requireAuth, (req, res) => {
    try {
        const contentType = req.params.type;
        const contentId = parseInt(req.params.id);
        if (!['vod', 'clip'].includes(contentType) || !contentId) {
            return res.status(400).json({ error: 'Invalid content type or ID' });
        }

        const message = (req.body.message || '').trim();
        if (!message || message.length > 2000) {
            return res.status(400).json({ error: 'Comment must be 1-2000 characters' });
        }

        const parentId = req.body.parent_id ? parseInt(req.body.parent_id) : null;
        const target = getCommentTarget(contentType, contentId);
        if (!target) {
            return res.status(404).json({ error: 'Content not found' });
        }

        // Verify parent comment exists and belongs to same content
        let parent = null;
        if (parentId) {
            parent = db.getCommentById(parentId);
            if (!parent || parent.content_type !== contentType || parent.content_id !== contentId) {
                return res.status(400).json({ error: 'Invalid parent comment' });
            }
        }

        const result = db.createComment({
            content_type: contentType,
            content_id: contentId,
            user_id: req.user.id,
            parent_id: parentId,
            message,
        });

        // Return the full comment with user data
        const comment = db.get(`
            SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
            FROM comments c JOIN users u ON c.user_id = u.id
            WHERE c.id = ?
        `, [result.lastInsertRowid]);

        const actor = notificationActor(req.user);
        const recipients = new Map();

        if (target.user_id && target.user_id !== req.user.id) {
            recipients.set(target.user_id, {
                user_id: target.user_id,
                type: parentId ? 'CONTENT_REPLY' : 'CONTENT_COMMENT',
                category: 'social',
                priority: 'normal',
                title: parentId ? `New reply on your ${target.label}` : `New comment on your ${target.label}`,
                message: `${actor.sender_name} ${parentId ? 'replied on' : 'commented on'} "${truncatePreview(target.title, 80)}"`,
                icon: parentId ? '↩️' : '💬',
                ...actor,
                service: 'hobostreamer',
                url: `${target.url}#comments`,
                rich_content: {
                    body: truncatePreview(message, 180),
                    context: { content_type: contentType, content_id: contentId, comment_id: comment.id, parent_id: parentId || null },
                },
            });
        }

        if (parent?.user_id && parent.user_id !== req.user.id) {
            recipients.set(parent.user_id, {
                user_id: parent.user_id,
                type: 'CONTENT_REPLY',
                category: 'social',
                priority: 'normal',
                title: 'New reply to your comment',
                message: `${actor.sender_name} replied to your comment on "${truncatePreview(target.title, 80)}"`,
                icon: '↩️',
                ...actor,
                service: 'hobostreamer',
                url: `${target.url}#comments`,
                rich_content: {
                    body: truncatePreview(message, 180),
                    context: { content_type: contentType, content_id: contentId, comment_id: comment.id, parent_id: parentId },
                },
            });
        }

        for (const payload of recipients.values()) {
            pushNotification(payload);
        }

        res.status(201).json({ comment });
    } catch (err) {
        console.error('[Comments] Create error:', err.message);
        res.status(500).json({ error: 'Failed to post comment' });
    }
});

// ── Get Replies ──────────────────────────────────────────────
router.get('/:commentId/replies', optionalAuth, (req, res) => {
    try {
        const commentId = parseInt(req.params.commentId);
        const replies = db.getCommentReplies(commentId);
        res.json({ replies });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get replies' });
    }
});

// ── Edit Comment ─────────────────────────────────────────────
router.put('/:commentId', requireAuth, (req, res) => {
    try {
        const comment = db.getCommentById(req.params.commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const message = (req.body.message || '').trim();
        if (!message || message.length > 2000) {
            return res.status(400).json({ error: 'Comment must be 1-2000 characters' });
        }

        db.updateComment(comment.id, message);
        res.json({ message: 'Comment updated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// ── Delete Comment ───────────────────────────────────────────
router.delete('/:commentId', requireAuth, (req, res) => {
    try {
        const comment = db.getCommentById(req.params.commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });

        let canDelete = (comment.user_id === req.user.id) || (req.user.role === 'admin');

        // Content owner can also delete comments on their content
        if (!canDelete) {
            if (comment.content_type === 'vod') {
                const vod = db.getVodById(comment.content_id);
                if (vod && vod.user_id === req.user.id) canDelete = true;
            } else if (comment.content_type === 'clip') {
                const clip = db.getClipById(comment.content_id);
                if (clip) {
                    // Stream owner can delete
                    if (clip.stream_id) {
                        const stream = db.getStreamById(clip.stream_id);
                        if (stream && stream.user_id === req.user.id) canDelete = true;
                    }
                }
            }
        }

        if (!canDelete) return res.status(403).json({ error: 'Not authorized' });

        db.deleteComment(comment.id);
        res.json({ message: 'Comment deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

module.exports = router;
