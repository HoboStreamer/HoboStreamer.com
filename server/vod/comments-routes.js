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

        // Verify parent comment exists and belongs to same content
        if (parentId) {
            const parent = db.getCommentById(parentId);
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
