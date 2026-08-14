/**
 * slogan-job.js — grow the home hero's rotating copy from real community context.
 *
 * Every run it samples the site's actual vibe — the global chat-AI summary (chatters), recent
 * streamer AI overviews (streamers), and recent VOD AI overviews (content) — plus a friendly
 * list of recently-active usernames, and asks the shared LLM for a FEW fresh slogans. Those are
 * MERGED into an accumulating pool in site_settings('home_hero_slogans') (deduped, capped), so
 * the copy keeps evolving with the community — a few new ones a day. The hero endpoint reads
 * that pool and falls back to a static set, so this is purely additive.
 */
'use strict';
const db = require('../db/database');
const ai = require('./ai-analysis');
let chatAi = null; try { chatAi = require('./chat-ai'); } catch { /* optional */ }

const INTERVAL_MS = 8 * 60 * 60 * 1000; // ~3 passes/day, each adding a few
const POOL_CAP = 50;                    // keep the pool fresh, not infinite
let _timer = null, _busy = false;

function _parseJson(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch { /* */ }
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
    return null;
}

// Audiences must be JUST the noun phrase completing "Live streaming for ___".
function _stripAudiencePrefix(s) {
    return String(s == null ? '' : s)
        .replace(/^\s*(live\s+)?streaming\s+for\s+/i, '')
        .replace(/^\s*for\s+/i, '');
}

function _cleanList(arr, maxLen, max = 12) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
        let s = String(raw == null ? '' : raw).trim()
            .replace(/^["'‘’“”\-•\s]+|["'‘’“”\s]+$/g, '')
            .replace(/[.,;:]+$/, '');
        if (!s || s.length > maxLen) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

function _dedupeCap(arr, cap) {
    const seen = new Set(), out = [];
    for (const s of arr) {
        const v = String(s || '').trim();
        if (!v) continue;
        const k = v.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(v);
        if (out.length >= cap) break;
    }
    return out;
}

function _loadPool() {
    try {
        const cur = db.getSetting('home_hero_slogans');
        const o = typeof cur === 'string' ? JSON.parse(cur) : cur;
        if (o) return { audiences: Array.isArray(o.audiences) ? o.audiences : [], quips: Array.isArray(o.quips) ? o.quips : [], updated_at: o.updated_at || 0 };
    } catch { /* */ }
    return { audiences: [], quips: [], updated_at: 0 };
}

async function tick() {
    if (_busy || !ai.isEnabled() || !ai.withinBudget()) return;
    _busy = true;
    try {
        // ── Sample real community context: chatters, streamers, VODs ──
        let vibe = '';
        try { const g = chatAi && chatAi.getGlobalInsight && chatAi.getGlobalInsight(); if (g) vibe = [g.overview, g.memory].filter(Boolean).join('\n').slice(0, 1400); } catch { /* */ }

        let streamerCtx = '';
        try {
            const rows = db.all(`
                SELECT u.username, COALESCE(so.overview_short, so.overview) AS ov
                FROM streamer_overviews so JOIN users u ON so.user_id = u.id
                WHERE COALESCE(u.is_banned,0)=0 AND so.overview IS NOT NULL
                ORDER BY so.generated_at DESC LIMIT 8
            `) || [];
            streamerCtx = rows.map(r => `- ${r.username}: ${String(r.ov || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n').slice(0, 1400);
        } catch { /* */ }

        let vodCtx = '';
        try {
            const rows = db.all(`
                SELECT title, ai_overview FROM vods
                WHERE is_public = 1 AND ai_overview IS NOT NULL AND LENGTH(ai_overview) > 0
                ORDER BY created_at DESC LIMIT 10
            `) || [];
            vodCtx = rows.map(r => `- ${String(r.title || '').slice(0, 60)}: ${String(r.ai_overview || '').replace(/\s+/g, ' ').slice(0, 150)}`).join('\n').slice(0, 1400);
        } catch { /* */ }

        let users = [];
        try {
            users = (db.all(`
                SELECT u.username FROM chat_messages c JOIN users u ON c.user_id = u.id
                WHERE c.timestamp >= datetime('now','-14 days') AND COALESCE(u.is_banned,0)=0 AND COALESCE(c.is_deleted,0)=0
                GROUP BY u.username ORDER BY COUNT(*) DESC LIMIT 30
            `) || []).map(r => r.username).filter(Boolean);
        } catch { /* */ }

        const pool = _loadPool();
        const existing = [...pool.audiences, ...pool.quips].slice(0, 40).join(' | ');

        const prompt =
`You write playful marketing microcopy for HoboStreamer — a scrappy, open-source, hobbyist-run live-streaming site with a campfire / hobo / nomad theme (IRL streamers, van-dwellers, coders, tinkerers, desktop gamers, the beautifully unhinged). Voice: witty, warm, self-aware, anti-corporate, a little irreverent — NEVER mean-spirited, never punching down.

=== THE ACTUAL COMMUNITY RIGHT NOW ===
Overall chat vibe:
${vibe || '(quiet at the moment)'}

Recent streamers (what they stream):
${streamerCtx || '(none yet)'}

Recent VODs (what's been on):
${vodCtx || '(none yet)'}

Active usernames you MAY reference by name, kindly and in good fun (optional — don't force it, don't @ them, never mock): ${users.join(', ') || '(none yet)'}

We already have these (do NOT repeat them, give us DIFFERENT ones):
${existing || '(none)'}

=== TASK ===
Draw on the community context above so the copy feels specific to THIS site. Produce STRICT JSON, exactly this shape and nothing else:
{
  "audiences": [ 10 short noun phrases, each a good fit for the sentence "Live streaming for ___". CRITICAL: give ONLY the noun phrase (e.g. "van-dwelling coders") — do NOT include the words "live streaming for" or "for". 1-5 words, lowercase, no trailing punctuation ],
  "quips": [ 10 standalone one-liner taglines, punchy, <= 70 characters, a few nodding to the real streamers/VODs/vibe or a username in a friendly way ]
}
Return ONLY the JSON object.`;

        const text = await ai.summarizeText(prompt, 1000, 'hero_slogans');
        if (!text) return;
        const parsed = _parseJson(text);
        if (!parsed) return;
        const newAud = _cleanList((parsed.audiences || []).map(_stripAudiencePrefix), 60, 12);
        const newQuips = _cleanList(parsed.quips || [], 110, 12);
        if (!newAud.length && !newQuips.length) return;

        // Merge NEW first so fresh copy surfaces, dedupe, cap the pool.
        const mergedAud = _dedupeCap([...newAud, ...pool.audiences.map(_stripAudiencePrefix)], POOL_CAP);
        const mergedQuips = _dedupeCap([...newQuips, ...pool.quips], POOL_CAP);
        db.setSetting('home_hero_slogans', JSON.stringify({ audiences: mergedAud, quips: mergedQuips, updated_at: Date.now() }));
        console.log(`[Slogans] +${newAud.length} audiences, +${newQuips.length} quips (pool now ${mergedAud.length}/${mergedQuips.length})`);
    } catch (e) {
        console.warn('[Slogans] generation failed:', e.message);
    } finally {
        _busy = false;
    }
}

function start() {
    if (_timer) return;
    _timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    // First pass a few minutes after boot — regenerate if the pool is empty, stale, or was
    // written in the old buggy format (audiences carrying a "streaming for" prefix).
    setTimeout(() => {
        const pool = _loadPool();
        const buggy = pool.audiences.some(a => /streaming\s+for/i.test(String(a)));
        const stale = !pool.updated_at || (Date.now() - pool.updated_at) > INTERVAL_MS;
        if (buggy || stale || pool.audiences.length < 8) tick().catch(() => {});
    }, 3 * 60 * 1000);
    console.log('[Slogans] hero-slogan job started (8h refresh, accumulating pool)');
}

module.exports = { start, tick };
