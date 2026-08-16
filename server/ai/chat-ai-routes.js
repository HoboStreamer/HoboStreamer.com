/**
 * chat-ai-routes.js — read API for chat AI insight.
 *   GET /api/chat-ai/global        → global chat overview + timeline + memory
 *   GET /api/chat-ai/user/:id       → a user's "today vs all-time" insight + timeline
 * Read-only; the summaries are produced by the chat-ai poller.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const chatAi = require('./chat-ai');

router.get('/global', (req, res) => {
    try {
        const insight = chatAi.getGlobalInsight();
        res.json({ insight: insight || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load global chat insight' });
    }
});

router.get('/user/:id', (req, res) => {
    try {
        const uid = parseInt(req.params.id, 10);
        if (!Number.isFinite(uid)) return res.status(400).json({ error: 'Invalid user id' });
        const user = db.getUserById ? db.getUserById(uid) : null;
        const insight = chatAi.getUserInsight(uid);

        // If this user is a streamer with an AI overview, lead the popover with who they
        // are as a streamer (their overview + recent stream "memories" as context/timeline)
        // before the chat-behavior insight.
        let streamer = null;
        try {
            const ov = db.getStreamerOverview(uid);
            if (ov && (ov.overview || ov.overview_short)) {
                const mems = (db.getStreamMemoriesByUser(uid, 8) || []).map(m => ({
                    description: m.description || '',
                    created_at: m.created_at,
                    stream_id: m.stream_id,
                    offset_seconds: m.offset_seconds,
                }));
                streamer = {
                    overview: ov.overview || null,
                    overview_short: ov.overview_short || null,
                    generated_at: ov.generated_at || null,
                    memories: mems,
                };
            }
        } catch { /* streamer context is best-effort */ }

        res.json({
            insight: insight || null,
            streamer,
            user: user ? { id: user.id, username: user.username, display_name: user.display_name } : null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user chat insight' });
    }
});

// An anonymous chatter's insight, keyed by their stable anon_id ("anon<N>").
router.get('/anon/:anonId', (req, res) => {
    try {
        const anonId = String(req.params.anonId || '');
        if (!/^anon\d+$/i.test(anonId)) return res.status(400).json({ error: 'Invalid anon id' });
        const insight = chatAi.getAnonInsight(anonId);
        res.json({ insight: insight || null, user: { anon_id: anonId, username: anonId } });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load anon chat insight' });
    }
});

// A bridged external (relay) chatter's insight, keyed by platform + username.
router.get('/relay/:platform/:username', (req, res) => {
    try {
        const ru = db.getRelayUser(req.params.platform, req.params.username);
        if (!ru) return res.json({ insight: null, user: null });
        const insight = chatAi.getRelayUserInsight(ru.id);
        res.json({
            insight: insight || null,
            user: { platform: ru.platform, username: ru.display_name || ru.username, message_count: ru.message_count || 0, first_seen: ru.first_seen || null },
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load relay chat insight' });
    }
});

// A single "whole person" overview fusing who they are as a streamer + as a chatter.
// Non-blocking: returns the cached synthesis if fresh, otherwise returns a quick fallback
// NOW and regenerates the AI synthesis in the background for next time (≤1 cheap LLM call
// per user per day, only when the tab is viewed). Falls back to concatenation with no AI.
const _combinedBusy = new Set();
function _combinedOverview(userId, streamerOv, chatIns) {
    const sOv = (streamerOv && (streamerOv.overview || streamerOv.overview_short)) || '';
    const cOv = (chatIns && (chatIns.overview_alltime || chatIns.overview_24h)) || '';
    if (!sOv && !cOv) return null;
    // Only one side → that's the whole story; no synthesis (and no AI cost) needed.
    if (!sOv || !cOv) return sOv || cOv;

    const key = `ai_whole_overview_${userId}`;
    const srcLen = sOv.length + '|' + cOv.length; // cheap change-detector
    let cachedText = null, fresh = false;
    try {
        const raw = db.getSetting(key);
        if (raw) { const j = JSON.parse(raw); cachedText = j.text || null; fresh = j.src === srcLen && (Date.now() - (j.generated_at || 0) < 24 * 60 * 60 * 1000); }
    } catch { /* rebuild */ }
    if (cachedText && fresh) return cachedText;

    // Regenerate in the background (best-effort) so the request never blocks on the LLM.
    const ai = require('./ai-analysis');
    if (!_combinedBusy.has(userId) && ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()) {
        _combinedBusy.add(userId);
        const prompt = `You are describing a person on a streaming site by fusing two AI summaries about them into ONE cohesive 2-4 sentence overview of who they are overall — both as a STREAMER and as a CHATTER. Be natural, specific, and not repetitive.\n\nAS A STREAMER:\n${sOv}\n\nAS A CHATTER:\n${cOv}\n\nCombined overview:`;
        Promise.resolve(ai.summarizeText(prompt, 320, 'combined_overview'))
            .then(text => { if (text) { try { db.setSetting(key, JSON.stringify({ text: text.trim(), generated_at: Date.now(), src: srcLen })); } catch { /* */ } } })
            .catch(() => { })
            .finally(() => _combinedBusy.delete(userId));
    }
    // Return whatever we have now: last synthesis (even if stale) or a simple stitch.
    return cachedText || `${sOv}\n\n${cOv}`;
}

// Full AI timeline for a streamer's channel page (streamer overview + every session's AI
// overview + memory moments with VOD timestamps). Lazily assembled + cached (15 min TTL),
// so it only rebuilds when the tab is actually opened and the cache is stale — no LLM cost.
router.get('/timeline/:username', (req, res) => {
    try {
        const uname = String(req.params.username || '').trim();
        const user = db.getUserByUsername ? db.getUserByUsername(uname) : null;
        if (!user) return res.status(404).json({ error: 'Channel not found' });

        const timeline = db.getStreamerAiTimeline(user.id); // full, cached
        const allSessions = timeline.sessions || [];
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
        const page = allSessions.slice(offset, offset + limit);

        // On the first page, also ship overview + a lightweight index of EVERY session
        // (no moment bodies) so the client can render a month-jump bar without the payload.
        const first = offset === 0;
        const index = first ? allSessions.map(s => ({
            id: s.id, title: s.title, vod_id: s.vod_id, memory_count: s.memory_count,
            when: s.started_at || s.created_at,
        })) : undefined;

        // First page also carries the CHATTER side (how they behave in chat) + a combined
        // "whole person" overview fusing streamer + chatter. Both are best-effort.
        let chatInsight, combinedOverview;
        if (first) {
            try { chatInsight = chatAi.getUserInsight(user.id) || null; } catch { chatInsight = null; }
            try { combinedOverview = _combinedOverview(user.id, timeline.overview, chatInsight); } catch { combinedOverview = null; }
        }

        res.json({
            username: user.username,
            display_name: user.display_name || user.username,
            overview: first ? timeline.overview : undefined,
            chatInsight,
            combinedOverview,
            sessionCount: timeline.sessionCount,
            momentCount: timeline.momentCount,
            generatedAt: timeline.generatedAt,
            index,
            sessions: page,
            offset, limit,
            hasMore: offset + limit < allSessions.length,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load AI timeline' });
    }
});

// Full audio transcript for a stream (AI Timeline transcript viewer), with a VOD id for links.
router.get('/transcript/:streamId', (req, res) => {
    try {
        const sid = parseInt(req.params.streamId, 10);
        if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid stream id' });
        const segments = db.getStreamTranscriptSegments(sid) || [];
        let vodId = null;
        try {
            const v = db.get('SELECT id FROM vods WHERE stream_id = ? AND COALESCE(is_recording, 0) = 0 ORDER BY COALESCE(is_public,1) DESC, id DESC LIMIT 1', [sid]);
            vodId = v ? v.id : null;
        } catch { /* */ }
        res.json({ streamId: sid, vodId, segments });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load transcript' });
    }
});

module.exports = router;
