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
        const limit = Math.min(Math.max(parseInt(req.query.limit || '0', 10), 0), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const allClips = db.getClipsByUser(req.user.id, true);
        const total = allClips.length;
        const clips = limit > 0 ? allClips.slice(offset, offset + limit) : allClips;
        res.json({ clips, total, limit: limit || total, offset });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list your clips' });
    }
});

// ── Clips of My Streams (clips others took of my streams) ────
router.get('/my-stream', requireAuth, (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '0', 10), 0), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const allClips = db.getClipsOfUserStreams(req.user.id);
        const total = allClips.length;
        const clips = limit > 0 ? allClips.slice(offset, offset + limit) : allClips;
        res.json({ clips, total, limit: limit || total, offset });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list stream clips' });
    }
});

// ── List Public Clips ────────────────────────────────────────
router.get('/', (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const usernameFilter = String(req.query.username || '').trim();
        const normalizedUsername = usernameFilter || null;
        const sort = req.query.sort === 'oldest' ? 'oldest' : 'newest';
        const clips = db.getPublicClips(limit, offset, { username: normalizedUsername, sort });
        const total = db.countPublicClips({ username: normalizedUsername });
        res.json({
            clips,
            total,
            limit,
            offset,
            hasMore: offset + clips.length < total,
            streamers: db.listClipStreamers(),
            activeFilter: normalizedUsername,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list clips' });
    }
});

// ── Get Clip Details ─────────────────────────────────────────
router.get('/:id', optionalAuth, (req, res) => {
    try {
        const clip = db.getClipById(req.params.id);
        if (!clip) return res.status(404).json({ error: 'Clip not found' });

        // Private clips: only owner/stream-owner/admin. Unlisted stays link-reachable.
        if (clip.visibility === 'private') {
            let allowed = req.user && (req.user.id === clip.user_id || req.user.role === 'admin');
            if (!allowed && req.user && clip.stream_id) { const s = db.getStreamById(clip.stream_id); if (s && s.user_id === req.user.id) allowed = true; }
            if (!allowed) return res.status(404).json({ error: 'Clip not found' });
        }

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

        if (req.body.visibility !== undefined) {
            db.setClipVisibility(clip.id, req.body.visibility);
            const v = db.getClipById(clip.id);
            return res.json({ message: `Clip is now ${v.visibility}`, visibility: v.visibility, is_public: v.is_public });
        }
        const isPublic = req.body.is_public ? 1 : 0;
        db.setClipPublic(clip.id, isPublic);
        res.json({ message: isPublic ? 'Clip is now public' : 'Clip is now unlisted', is_public: isPublic });
    } catch (err) {
        console.error('[Clips] Visibility toggle error:', err.message);
        res.status(500).json({ error: 'Failed to update clip visibility' });
    }
});

// ── Bulk action on clips (streamer's own, or any for admins): delete | public | unlisted | private ──
router.post('/bulk', requireAuth, async (req, res) => {
    try {
        const { ids, action } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No ids provided' });
        if (!['delete', 'public', 'unlisted', 'private'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
        const isAdmin = req.user.role === 'admin' || req.user.capabilities?.moderate_global;
        const owns = (clip) => {
            if (isAdmin || clip.user_id === req.user.id) return true;
            if (clip.stream_id) { const s = db.getStreamById(clip.stream_id); if (s && s.user_id === req.user.id) return true; }
            if (clip.vod_id) { const v = db.get('SELECT user_id FROM vods WHERE id = ?', [clip.vod_id]); if (v && v.user_id === req.user.id) return true; }
            return false;
        };
        let done = 0, skipped = 0;
        for (const rawId of ids.slice(0, 500)) {
            const id = parseInt(rawId, 10);
            if (!id) { skipped++; continue; }
            const clip = db.get('SELECT * FROM clips WHERE id = ?', [id]);
            if (!clip || !owns(clip)) { skipped++; continue; }
            if (action === 'delete') {
                try { if (clip.file_path && fs.existsSync(clip.file_path)) fs.unlinkSync(clip.file_path); } catch {}
                if (clip.storage_provider && clip.storage_provider !== 'local' && clip.storage_key) {
                    require('./vod-storage').deleteVodObjects(clip).catch(() => {});
                }
                db.run('DELETE FROM clips WHERE id = ?', [id]);
            } else {
                db.setClipVisibility(id, action);
            }
            done++;
        }
        res.json({ done, skipped });
    } catch (err) {
        res.status(500).json({ error: 'Bulk action failed' });
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

        // Delete the local file + any offloaded B2/R2 object (clips carry
        // storage_provider/storage_key like VODs).
        if (clip.file_path && fs.existsSync(clip.file_path)) {
            try { fs.unlinkSync(clip.file_path); } catch { /* ignore */ }
        }
        if (clip.storage_provider && clip.storage_provider !== 'local' && clip.storage_key) {
            require('./vod-storage').deleteVodObjects(clip).catch(err =>
                console.warn(`[Clips] Remote object cleanup failed for clip ${clip.id}:`, err.message));
        }

        db.run('DELETE FROM clips WHERE id = ?', [req.params.id]);
        res.json({ message: 'Clip deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete clip' });
    }
});

module.exports = router;
