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
const permissions = require('../auth/permissions');

// The user id of the channel/streamer that owns a clip's source (stream, else VOD).
function clipChannelOwnerId(clip) {
    if (!clip) return null;
    if (clip.stream_id) { const s = db.getStreamById(clip.stream_id); if (s) return s.user_id; }
    if (clip.vod_id) { const v = db.get('SELECT user_id FROM vods WHERE id = ?', [clip.vod_id]); if (v) return v.user_id; }
    return null;
}

// Can `actor` EDIT (title) this clip? The creator may title their own clip (the
// post-create titling flow), plus the streamer / mods / staff.
function canActorModerateClip(actor, clip) {
    if (!actor || !clip) return false;
    if (actor.id === clip.user_id) return true;
    const ownerId = clipChannelOwnerId(clip);
    if (ownerId && actor.id === ownerId) return true;
    if (ownerId) { const ch = db.getChannelByUserId(ownerId); if (ch && db.isChannelModerator(actor.id, ch.id)) return true; }
    const clipOwner = clip.user_id ? db.getUserById(clip.user_id) : null;
    const streamOwner = ownerId ? db.getUserById(ownerId) : null;
    return permissions.canModerateContentOwner(actor, clipOwner) &&
           permissions.canModerateContentOwner(actor, streamOwner);
}

// Can `actor` DELETE this clip? Stricter than editing: by default the CREATOR
// (when not the streamer) may NOT delete — only the channel owner, channel mods,
// and site staff can. The streamer can opt in per-channel
// (channels.clips_allow_creator_delete) to let creators delete their own clips.
function canActorDeleteClip(actor, clip) {
    if (!actor || !clip) return false;
    const ownerId = clipChannelOwnerId(clip);
    if (ownerId && actor.id === ownerId) return true;          // the streamer / vod owner
    if (!ownerId && actor.id === clip.user_id) return true;    // orphaned clip: creator manages it
    if (ownerId) {
        const ch = db.getChannelByUserId(ownerId);
        if (ch && db.isChannelModerator(actor.id, ch.id)) return true;                       // channel mod
        if (actor.id === clip.user_id && ch && ch.clips_allow_creator_delete) return true;   // creator, if channel opted in
    }
    const clipOwner = clip.user_id ? db.getUserById(clip.user_id) : null;
    const streamOwner = ownerId ? db.getUserById(ownerId) : null;
    return permissions.canModerateContentOwner(actor, clipOwner) &&
           permissions.canModerateContentOwner(actor, streamOwner);
}
const config = require('../config');

const router = express.Router();

// ── My Clips (clips I created) ───────────────────────────────
router.get('/mine', requireAuth, (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '0', 10), 0), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const allClips = db.getClipsByUser(req.user.id, true);
        const total = allClips.length;
        const clips = (limit > 0 ? allClips.slice(offset, offset + limit) : allClips)
            .map(c => ({ ...c, can_delete: canActorDeleteClip(req.user, c) }));
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
        const clips = (limit > 0 ? allClips.slice(offset, offset + limit) : allClips)
            .map(c => ({ ...c, can_delete: true }));  // the streamer owns these
        res.json({ clips, total, limit: limit || total, offset });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list stream clips' });
    }
});

// ── Clip settings for my channel (creator-delete opt-in) ─────
router.get('/settings/channel', requireAuth, (req, res) => {
    try {
        const ch = db.getChannelByUserId(req.user.id);
        res.json({ clips_allow_creator_delete: !!(ch && ch.clips_allow_creator_delete) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load clip settings' });
    }
});

router.put('/settings/channel', requireAuth, (req, res) => {
    try {
        const ch = db.getChannelByUserId(req.user.id);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        const val = req.body.clips_allow_creator_delete ? 1 : 0;
        db.run('UPDATE channels SET clips_allow_creator_delete = ? WHERE id = ?', [val, ch.id]);
        res.json({ clips_allow_creator_delete: !!val });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save clip settings' });
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

        // Server-authoritative permission flags for the client UI.
        clip.can_delete = canActorDeleteClip(req.user, clip);
        clip.can_edit = canActorModerateClip(req.user, clip);

        // Whether the source VOD is still available (exists, not private, not mid-recording)
        // so the client can offer a "watch in the full VOD at this timestamp" deep link.
        clip.vod_available = false;
        if (clip.vod_id) {
            try {
                const v = db.get('SELECT visibility, is_recording FROM vods WHERE id = ?', [clip.vod_id]);
                if (v && v.visibility !== 'private' && !v.is_recording) clip.vod_available = true;
            } catch { /* */ }
        }

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
        if (!canActorModerateClip(req.user, clip)) {
            return res.status(403).json({ error: 'Not authorized to edit this clip' });
        }

        const title = (req.body.title || '').trim();
        if (!title || title.length > 200) {
            return res.status(400).json({ error: 'Title must be 1-200 characters' });
        }

        db.run('UPDATE clips SET title = ? WHERE id = ?', [title, clip.id]);
        // If the clip's chat announcement is still pending, fire it now with this title.
        try { require('./clip-notify').bumpClipNotifyNow(clip.id); } catch { /* */ }
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

        // Stream owner / vod owner / clip creator, or a permitted moderator
        // (admins may not touch an owner-rank user's clips).
        if (!canActorModerateClip(req.user, clip)) {
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
        let done = 0, skipped = 0;
        for (const rawId of ids.slice(0, 500)) {
            const id = parseInt(rawId, 10);
            if (!id) { skipped++; continue; }
            const clip = db.get('SELECT * FROM clips WHERE id = ?', [id]);
            const allowed = action === 'delete' ? canActorDeleteClip(req.user, clip) : canActorModerateClip(req.user, clip);
            if (!clip || !allowed) { skipped++; continue; }
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

        // Streamer / channel mod / staff — the creator only if the channel opted in.
        if (!canActorDeleteClip(req.user, clip)) {
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
