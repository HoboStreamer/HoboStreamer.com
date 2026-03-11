/**
 * HoboStreamer — Clips API Routes (standalone mount at /api/clips)
 * 
 * GET    /api/clips/mine      - List clips I created (auth)
 * GET    /api/clips/my-stream - List clips of my streams (auth)
 * GET    /api/clips           - List public clips
 * GET    /api/clips/:id       - Get clip details
 * PUT    /api/clips/:id/title - Update clip title (creator only)
 * PUT    /api/clips/:id/visibility - Toggle clip public/unlisted (streamer only)
 * DELETE /api/clips/:id       - Delete a clip
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { requireAuth, optionalAuth } = require('../auth/auth');
const config = require('../config');

const router = express.Router();

// ── My Clips (clips I created) ───────────────────────────────
router.get('/mine', requireAuth, (req, res) => {
    try {
        const clips = db.getClipsByUser(req.user.id, true);
        res.json({ clips });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list your clips' });
    }
});

// ── Clips of My Streams (clips others took of my streams) ────
router.get('/my-stream', requireAuth, (req, res) => {
    try {
        const clips = db.getClipsOfUserStreams(req.user.id);
        res.json({ clips });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list stream clips' });
    }
});

// ── List Public Clips ────────────────────────────────────────
router.get('/', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '20'), 100);
        const offset = parseInt(req.query.offset || '0');
        const clips = db.getPublicClips(limit, offset);
        res.json({ clips });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list clips' });
    }
});

// ── Get Clip Details ─────────────────────────────────────────
router.get('/:id', optionalAuth, (req, res) => {
    try {
        const clip = db.getClipById(req.params.id);
        if (!clip) return res.status(404).json({ error: 'Clip not found' });

        // Track unique view by IP
        const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
        const inserted = db.run(
            'INSERT OR IGNORE INTO content_views (content_type, content_id, ip) VALUES (?, ?, ?)',
            ['clip', clip.id, ip]
        );
        if (inserted.changes > 0) {
            const count = db.get('SELECT COUNT(*) as c FROM content_views WHERE content_type = ? AND content_id = ?', ['clip', clip.id]);
            db.run('UPDATE clips SET view_count = ? WHERE id = ?', [count.c, clip.id]);
            clip.view_count = count.c;
        }

        // Enrich with stream details for chat replay
        if (clip.stream_id) {
            const stream = db.getStreamById(clip.stream_id);
            if (stream) {
                clip.stream_started_at = stream.started_at;
                clip.stream_ended_at = stream.ended_at;
                clip.stream_title = stream.title;
                clip.stream_category = stream.category;
                clip.stream_peak_viewers = stream.peak_viewers;
                clip.stream_protocol = stream.protocol;
            }
        }

        // Get comment count
        clip.comment_count = db.getCommentCount('clip', clip.id);

        res.json({ clip });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get clip' });
    }
});

// ── Update Clip Title ────────────────────────────────────────
router.put('/:id/title', requireAuth, (req, res) => {
    try {
        const clip = db.get('SELECT * FROM clips WHERE id = ?', [req.params.id]);
        if (!clip) return res.status(404).json({ error: 'Clip not found' });
        if (clip.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized to edit this clip' });
        }

        const title = (req.body.title || '').trim();
        if (!title || title.length > 200) {
            return res.status(400).json({ error: 'Title must be 1-200 characters' });
        }

        db.run('UPDATE clips SET title = ? WHERE id = ?', [title, clip.id]);
        res.json({ message: 'Clip title updated', title });
    } catch (err) {
        console.error('[Clips] Title update error:', err.message);
        res.status(500).json({ error: 'Failed to update clip title' });
    }
});

// ── Toggle Clip Visibility ────────────────────────────────────
router.put('/:id/visibility', requireAuth, (req, res) => {
    try {
        const clip = db.get('SELECT * FROM clips WHERE id = ?', [req.params.id]);
        if (!clip) return res.status(404).json({ error: 'Clip not found' });

        // Only the stream owner (streamer) or admin can toggle visibility
        let canToggle = (req.user.role === 'admin');
        if (!canToggle && clip.stream_id) {
            const stream = db.getStreamById(clip.stream_id);
            if (stream && stream.user_id === req.user.id) canToggle = true;
        }
        if (!canToggle && clip.vod_id) {
            const vod = db.get('SELECT user_id FROM vods WHERE id = ?', [clip.vod_id]);
            if (vod && vod.user_id === req.user.id) canToggle = true;
        }
        if (!canToggle) {
            return res.status(403).json({ error: 'Only the streamer can change clip visibility' });
        }

        const isPublic = req.body.is_public ? 1 : 0;
        db.setClipPublic(clip.id, isPublic);
        res.json({ message: isPublic ? 'Clip is now public' : 'Clip is now unlisted', is_public: isPublic });
    } catch (err) {
        console.error('[Clips] Visibility toggle error:', err.message);
        res.status(500).json({ error: 'Failed to update clip visibility' });
    }
});

// ── Delete Clip ──────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
    try {
        const clip = db.get('SELECT * FROM clips WHERE id = ?', [req.params.id]);
        if (!clip) return res.status(404).json({ error: 'Clip not found' });

        // Allow clip creator, stream owner, or admin to delete
        let canDelete = (clip.user_id === req.user.id) || (req.user.role === 'admin');
        if (!canDelete && clip.stream_id) {
            const stream = db.getStreamById(clip.stream_id);
            if (stream && stream.user_id === req.user.id) canDelete = true;
        }
        if (!canDelete && clip.vod_id) {
            const vod = db.get('SELECT user_id FROM vods WHERE id = ?', [clip.vod_id]);
            if (vod && vod.user_id === req.user.id) canDelete = true;
        }
        if (!canDelete) {
            return res.status(403).json({ error: 'Not authorized to delete this clip' });
        }

        // Delete file
        if (clip.file_path && fs.existsSync(clip.file_path)) {
            fs.unlinkSync(clip.file_path);
        }

        db.run('DELETE FROM clips WHERE id = ?', [req.params.id]);
        res.json({ message: 'Clip deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete clip' });
    }
});

module.exports = router;
