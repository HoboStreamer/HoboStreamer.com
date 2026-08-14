/**
 * clip-notify.js — announce newly-created clips in the source channel's chat.
 *
 * When a clip is created we set clips.clip_notify_at = now + GRACE (so the creator
 * has a moment to title it). A lightweight sweeper posts a "clip" chat message once
 * per clip (thumbnail + title + link) via the same path donations/AI viewers use.
 * If the creator titles the clip within the grace window we bump clip_notify_at to
 * now so it fires on the next tick. Per-slot opt-out: managed_streams.slot_clip_notify_enabled.
 */
'use strict';
const db = require('../db/database');

const GRACE_SECONDS = 60;         // time to let the creator title the clip
const SWEEP_INTERVAL_MS = 15000;  // how often to check for due notifications

function clipChannelOwnerId(clip) {
    if (!clip) return null;
    if (clip.stream_id) { const s = db.getStreamById(clip.stream_id); if (s) return s.user_id; }
    if (clip.vod_id) { const v = db.get('SELECT user_id FROM vods WHERE id = ?', [clip.vod_id]); if (v) return v.user_id; }
    return null;
}

// Schedule a clip's chat announcement (called right after the clip is created).
function scheduleClipNotify(clipId) {
    try {
        const clip = db.getClipById(clipId);
        if (!clip) return;
        if (!clipChannelOwnerId(clip)) return; // no channel to announce into
        db.run(
            "UPDATE clips SET clip_notify_at = datetime('now', ?) WHERE id = ? AND clip_notified = 0",
            [`+${GRACE_SECONDS} seconds`, clipId]
        );
    } catch (e) { console.warn('[ClipNotify] schedule failed:', e.message); }
}

// Creator titled the clip within the grace window → announce on the next tick.
function bumpClipNotifyNow(clipId) {
    try {
        db.run("UPDATE clips SET clip_notify_at = CURRENT_TIMESTAMP WHERE id = ? AND clip_notified = 0", [clipId]);
    } catch { /* best-effort */ }
}

function _markNotified(clipId) {
    try { db.run('UPDATE clips SET clip_notified = 1, clip_notify_at = NULL WHERE id = ?', [clipId]); } catch { /* */ }
}

function _sendOne(clip) {
    const ownerId = clipChannelOwnerId(clip);
    if (!ownerId) { _markNotified(clip.id); return; }
    if (clip.visibility === 'private') { _markNotified(clip.id); return; } // don't announce private clips

    // Per-slot opt-out via the source stream's managed slot.
    const streamId = clip.stream_id || null;
    if (streamId) {
        try {
            const s = db.getStreamById(streamId);
            if (s && s.managed_stream_id) {
                const ms = db.get('SELECT slot_clip_notify_enabled FROM managed_streams WHERE id = ?', [s.managed_stream_id]);
                if (ms && Number(ms.slot_clip_notify_enabled) === 0) { _markNotified(clip.id); return; }
            }
        } catch { /* fall through and notify */ }
    }

    const creator = clip.user_id ? db.getUserById(clip.user_id) : null;
    const creatorName = (creator && (creator.display_name || creator.username)) || 'Someone';
    const title = clip.title || 'Untitled Clip';
    const thumb = clip.thumbnail_url || null;
    const meta = {
        clip_id: clip.id, title, thumbnail_url: thumb,
        duration: clip.duration_seconds || null, creator: creatorName,
    };
    const payload = {
        type: 'chat',
        message_type: 'clip',
        username: creatorName,
        user_id: null,
        message: `clipped: ${title}`,
        stream_id: streamId,
        channel_user_id: ownerId,
        is_global: false,
        clip: meta,
        timestamp: new Date().toISOString(),
    };
    try {
        const res = db.saveChatMessage({
            stream_id: streamId,
            channel_user_id: ownerId,
            user_id: null,
            username: creatorName,
            message: `clipped: ${title}`,
            message_type: 'clip',
            metadata: meta,
        });
        payload.id = res && res.lastInsertRowid;
        const chatServer = require('../chat/chat-server');
        chatServer.broadcastToChannelRoom(ownerId, streamId, payload);
    } catch (e) {
        console.warn('[ClipNotify] send failed:', e.message);
    }
    _markNotified(clip.id);
}

let _sweepTimer = null;
function startClipNotifySweeper() {
    if (_sweepTimer) return;
    _sweepTimer = setInterval(() => {
        try {
            const due = db.all(
                "SELECT * FROM clips WHERE clip_notified = 0 AND clip_notify_at IS NOT NULL AND clip_notify_at <= CURRENT_TIMESTAMP LIMIT 20"
            );
            for (const clip of due) _sendOne(clip);
        } catch (e) { console.warn('[ClipNotify] sweep error:', e.message); }
    }, SWEEP_INTERVAL_MS);
    if (_sweepTimer.unref) _sweepTimer.unref();
    console.log('[ClipNotify] sweeper started');
}

module.exports = { scheduleClipNotify, bumpClipNotifyNow, startClipNotifySweeper };
