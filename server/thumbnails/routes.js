/**
 * HoboStreamer — Thumbnail API Routes (mounted at /api/thumbnails)
 *
 * GET  /api/thumbnails/:filename          – Serve a thumbnail image
 * POST /api/thumbnails/live/:streamId     – Upload a live-stream thumbnail (from broadcaster client)
 * POST /api/thumbnails/generate/vod/:id   – Generate VOD thumbnail (admin/owner)
 * POST /api/thumbnails/generate/clip/:id  – Generate clip thumbnail (admin/owner)
 */
const express = require('express');
const multer = require('multer');
const db = require('../db/database');
const { requireAuth, optionalAuth } = require('../auth/auth');
const thumbService = require('./thumbnail-service');

const router = express.Router();

// Multer for raw image upload (max 2 MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
});

// ── Serve thumbnail image ────────────────────────────────────
router.get('/:filename', thumbService.serveThumbnail);

// ── Live stream thumbnail upload (from broadcaster) ──────────
// Accepts either multipart form with 'thumbnail' field or JSON { image: "base64..." }
router.post('/live/:streamId', requireAuth, upload.single('thumbnail'), (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const stream = db.getStreamById(streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) return res.status(400).json({ error: 'Stream is not live' });

        let imageData;
        if (req.file) {
            // Multipart upload
            imageData = req.file.buffer;
        } else if (req.body && req.body.image) {
            // Base64 JSON upload
            imageData = req.body.image;
        } else {
            return res.status(400).json({ error: 'No image data provided' });
        }

        const thumbUrl = thumbService.saveLiveThumbnail(streamId, imageData);
        if (thumbUrl) {
            res.json({ thumbnail_url: thumbUrl });
        } else {
            res.status(400).json({ error: 'Invalid image data' });
        }
    } catch (err) {
        console.error('[Thumbnails] Live upload error:', err.message);
        res.status(500).json({ error: 'Failed to save thumbnail' });
    }
});

// ── Regenerate VOD thumbnail ─────────────────────────────────
router.post('/generate/vod/:id', optionalAuth, async (req, res) => {
    try {
        const vod = db.getVodById(req.params.id);
        if (!vod) return res.status(404).json({ error: 'VOD not found' });
        const canManage = !!req.user && (vod.user_id === req.user.id || req.user.role === 'admin');
        if (!canManage && !vod.is_public) {
            return res.status(403).json({ error: 'Not your VOD' });
        }

        const thumbUrl = await thumbService.generateVodThumbnail(vod.id, vod.file_path);
        if (thumbUrl) {
            res.json({ thumbnail_url: thumbUrl });
        } else {
            res.status(500).json({ error: 'Failed to generate thumbnail' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate thumbnail' });
    }
});

// ── Regenerate Clip thumbnail ────────────────────────────────
router.post('/generate/clip/:id', optionalAuth, async (req, res) => {
    try {
        const clip = db.get('SELECT * FROM clips WHERE id = ?', [req.params.id]);
        if (!clip) return res.status(404).json({ error: 'Clip not found' });
        const canManage = !!req.user && (clip.user_id === req.user.id || req.user.role === 'admin');
        if (!canManage && !clip.is_public) {
            return res.status(403).json({ error: 'Not your clip' });
        }

        const thumbUrl = await thumbService.generateClipThumbnail(clip.id, clip.file_path);
        if (thumbUrl) {
            res.json({ thumbnail_url: thumbUrl });
        } else {
            res.status(500).json({ error: 'Failed to generate thumbnail' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate thumbnail' });
    }
});

module.exports = router;
