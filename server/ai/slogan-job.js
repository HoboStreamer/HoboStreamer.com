/**
 * slogan-job.js — periodically regenerate the home hero's rotating copy from live site context.
 *
 * Pulls the community "vibe" from the global chat-AI summary + a sample of recently-active
 * usernames, asks the shared LLM for two lists (audiences + funny quips, some referencing the
 * community/users kindly), and caches them in site_settings('home_hero_slogans'). The home
 * hero endpoint reads that cache and falls back to a static set, so this is purely additive.
 */
'use strict';
const db = require('../db/database');
const ai = require('./ai-analysis');
let chatAi = null; try { chatAi = require('./chat-ai'); } catch { /* optional */ }

const INTERVAL_MS = 6 * 60 * 60 * 1000; // regenerate every 6h
let _timer = null, _busy = false;

function _parseJson(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch { /* */ }
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
    return null;
}

function _cleanList(arr, maxLen, max = 24) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
        let s = String(raw == null ? '' : raw).trim().replace(/^["'\-•\s]+|["'\s]+$/g, '');
        if (!s || s.length > maxLen) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

async function tick() {
    if (_busy || !ai.isEnabled() || !ai.withinBudget()) return;
    _busy = true;
    try {
        // Community vibe from the global chat-AI summary (rolling overview + running memory).
        let vibe = '';
        try {
            const g = chatAi && chatAi.getGlobalInsight && chatAi.getGlobalInsight();
            if (g) vibe = [g.overview, g.memory].filter(Boolean).join('\n').slice(0, 1600);
        } catch { /* */ }

        // A friendly sample of recently-active usernames to (optionally) reference.
        let users = [];
        try {
            users = (db.all(`
                SELECT u.username FROM chat_messages c
                JOIN users u ON c.user_id = u.id
                WHERE c.timestamp >= datetime('now','-14 days')
                  AND COALESCE(u.is_banned,0)=0 AND COALESCE(c.is_deleted,0)=0
                GROUP BY u.username
                ORDER BY COUNT(*) DESC
                LIMIT 30
            `) || []).map(r => r.username).filter(Boolean);
        } catch { /* */ }

        const prompt =
`You write playful marketing microcopy for HoboStreamer — a scrappy, open-source, hobbyist-run live-streaming site with a campfire / hobo / nomad theme (IRL streamers, van-dwellers, coders, tinkerers, desktop gamers, the beautifully unhinged). Voice: witty, warm, self-aware, anti-corporate, a little irreverent — NEVER mean-spirited, never punching down.

Live community vibe right now (from our internal AI chat summary; may be sparse):
${vibe || '(quiet at the moment)'}

Active community usernames you MAY reference by name, kindly and in good fun (optional — don't force it, don't @ them, and never mock anyone): ${users.join(', ') || '(none yet)'}

Produce STRICT JSON, exactly this shape and nothing else:
{
  "audiences": [ 22 short noun phrases that finish the sentence "Live streaming for ___" — funny, specific, on-theme, 1-5 words each, lowercase, no trailing punctuation ],
  "quips": [ 22 standalone one-liner taglines — punchy, <= 70 characters, some nodding to the community vibe or a username in a friendly way ]
}
Return ONLY the JSON object.`;

        const text = await ai.summarizeText(prompt, 1000, 'hero_slogans');
        if (!text) return;
        const parsed = _parseJson(text);
        if (!parsed) return;
        const audiences = _cleanList(parsed.audiences, 60);
        const quips = _cleanList(parsed.quips, 110);
        if (audiences.length >= 4 || quips.length >= 4) {
            db.setSetting('home_hero_slogans', JSON.stringify({ audiences, quips, updated_at: Date.now() }));
            console.log(`[Slogans] Regenerated hero copy: ${audiences.length} audiences, ${quips.length} quips`);
        }
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
    // First pass a few minutes after boot (only regenerates if none cached yet / stale).
    setTimeout(() => {
        try {
            const cur = db.getSetting('home_hero_slogans');
            const obj = typeof cur === 'string' ? (() => { try { return JSON.parse(cur); } catch { return null; } })() : cur;
            const stale = !obj || !obj.updated_at || (Date.now() - obj.updated_at) > INTERVAL_MS;
            if (stale) tick().catch(() => {});
        } catch { tick().catch(() => {}); }
    }, 3 * 60 * 1000);
    console.log('[Slogans] hero-slogan job started (6h refresh)');
}

module.exports = { start, tick };
