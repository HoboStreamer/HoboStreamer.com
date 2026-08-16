/**
 * AI "crazy moments" job — once a day, picks a handful of standout stream moments from the
 * AI memory data, extracts a frame at each moment's timestamp for the home-page hero
 * background, and auto-creates a discoverability paste (description + link to the VOD at that
 * exact timestamp). Rotates daily, dedups against recently-used moments, and costs at most
 * ONE cheap LLM pick per day (with a daily-rotating heuristic fallback when AI is off).
 */
const db = require('../db/database');
const ai = require('./ai-analysis');
let thumb = null; try { thumb = require('../thumbnails/thumbnail-service'); } catch { /* optional */ }

const INTERVAL_MS = 24 * 60 * 60 * 1000;
const TARGET = 6;
const SETTING = 'home_hero_moments';
let _busy = false;

function _load() { try { return JSON.parse(db.getSetting(SETTING) || '{}') || {}; } catch { return {}; } }
function _due() { const p = _load(); return !p.updated_at || (Date.now() - p.updated_at) >= INTERVAL_MS; }

const _ADJ = ['wild', 'epic', 'cursed', 'feral', 'unhinged', 'chaotic', 'legendary', 'peak', 'rogue', 'hazy', 'unreal', 'prime'];
const _NOUN = ['moment', 'clip', 'frame', 'scene', 'vibe', 'snippet', 'flash', 'glimpse', 'beat', 'take'];
function _slug() {
    const r = a => a[Math.floor(Math.random() * a.length)];
    return `${r(_ADJ)}-${r(_NOUN)}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// One cheap LLM call: pick the wildest N moments + give each a punchy title.
async function _aiPick(pool, n) {
    const list = pool.slice(0, 40).map((c, i) => `${i}. ${String(c.description).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
    const prompt = `From these livestream moments, pick the ${n} MOST surprising, funny, chaotic, or genuinely memorable ones for a highlights showcase. For each, write a short punchy title (max 8 words, no surrounding quotes).\n\n${list}\n\nReturn STRICT JSON only, nothing else: [{"index": <number from the list>, "title": "<punchy title>"}] with exactly ${n} items and distinct indexes.`;
    try {
        const text = await ai.summarizeText(prompt, 500, 'hero_moments');
        const m = text && text.match(/\[[\s\S]*\]/);
        if (!m) return [];
        const arr = JSON.parse(m[0]);
        const seen = new Set();
        return arr.filter(x => pool[x.index] && !seen.has(x.index) && seen.add(x.index))
            .slice(0, n).map(x => ({ cand: pool[x.index], title: String(x.title || '').replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 80) }));
    } catch { return []; }
}

// Daily-rotating deterministic pick (no AI): different set each day.
function _heuristicPick(pool, n) {
    const day = Math.floor(Date.now() / INTERVAL_MS);
    return pool.map((c, i) => ({ c, k: (((i + 1) * 2654435761) ^ (day * 40503)) >>> 0 }))
        .sort((a, b) => a.k - b.k).slice(0, n).map(s => ({ cand: s.c, title: null }));
}

async function tick() {
    if (_busy || !_due()) return;
    _busy = true;
    try {
        const prev = _load();
        const usedIds = new Set(prev.usedIds || []);
        const cands = (db.getAiMomentCandidates(30, 150) || []).filter(c => c.vod_id);
        if (!cands.length) { _busy = false; return; }
        const fresh = cands.filter(c => !usedIds.has(c.memory_id));
        const pool = fresh.length >= TARGET ? fresh : cands;

        let picks = [];
        if (ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget() && pool.length > TARGET) {
            picks = await _aiPick(pool, TARGET);
        }
        if (picks.length < TARGET) {
            const chosen = new Set(picks.map(p => p.cand.memory_id));
            for (const h of _heuristicPick(pool.filter(c => !chosen.has(c.memory_id)), TARGET - picks.length)) picks.push(h);
        }

        const moments = [];
        const newUsed = [];
        for (const p of picks) {
            const c = p.cand;
            // Prefer a real frame at the moment's timestamp; fall back to existing thumbnails.
            let img = c.thumbnail_url || `/api/thumbnails/generate/vod/${c.vod_id}`;
            try {
                const vod = db.getVodById(c.vod_id);
                if (thumb && vod && vod.file_path) {
                    const url = await thumb.generateMomentThumbnail(c.memory_id, vod.file_path, c.offset_seconds);
                    if (url) img = url;
                }
            } catch { /* keep fallback */ }

            const title = (p.title || c.stream_title || 'A wild moment').slice(0, 80);
            const desc = String(c.description || '').replace(/\s+/g, ' ').trim();
            const offset = Math.floor(c.offset_seconds || 0);
            const vodLink = `/vod/${c.vod_id}?t=${offset}`;
            const slug = _slug();
            const content = `${desc}\n\nCaught by the AI on @${c.username}'s stream — watch this exact moment: ${vodLink}`;
            try {
                db.createPaste({
                    slug, userId: c.user_id, type: 'paste', title, content,
                    language: 'text', visibility: 'public', streamId: c.stream_id,
                    metadata: JSON.stringify({ ai_moment: true, memory_id: c.memory_id, vod_id: c.vod_id, offset, image: img, username: c.username }),
                });
            } catch { /* slug collision / other — skip this paste */ }

            moments.push({ memoryId: c.memory_id, vodId: c.vod_id, offset, title, thumbnail: img, username: c.username, pasteSlug: slug });
            newUsed.push(c.memory_id);
        }

        const usedLog = [...newUsed, ...(prev.usedIds || [])].slice(0, 400);
        db.setSetting(SETTING, JSON.stringify({ moments, usedIds: usedLog, updated_at: Date.now() }));
        console.log(`[AI-Moments] Selected ${moments.length} hero moments + created pastes`);
    } catch (e) {
        console.warn('[AI-Moments] tick error:', e.message);
    } finally {
        _busy = false;
    }
}

function start() {
    setTimeout(() => { tick().catch(() => {}); }, 60 * 1000);      // shortly after boot
    setInterval(() => { tick().catch(() => {}); }, 30 * 60 * 1000); // self-gates on 24h
}

module.exports = { start, tick };
