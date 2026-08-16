/**
 * AI "crazy moments" job — once a day, picks a handful of standout stream moments from the
 * AI memory data, extracts a frame at each moment's timestamp for the home-page hero
 * background, and auto-creates a discoverability paste (description + link to the VOD at that
 * exact timestamp). Rotates daily, dedups against recently-used moments, and costs at most
 * ONE cheap LLM pick per day (with a daily-rotating heuristic fallback when AI is off).
 */
const path = require('node:path');
const db = require('../db/database');
const ai = require('./ai-analysis');
let cfg = null; try { cfg = require('../config'); } catch { /* */ }
let thumb = null; try { thumb = require('../thumbnails/thumbnail-service'); } catch { /* optional */ }
const SCREENSHOTS_DIR = path.resolve('./data/pastes/screenshots');
const BASE_URL = (cfg && (cfg.baseUrl || cfg.publicUrl)) || 'https://hobostreamer.com';

const INTERVAL_MS = 24 * 60 * 60 * 1000;
const TARGET = 3;
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

async function tick(opts = {}) {
    // opts: { force } bypass the daily gate, { days, limit } widen the candidate window
    // (e.g. whole-dataset test run), { target } how many moments to select.
    if (_busy || (!opts.force && !_due())) return;
    const TARGET_N = Math.max(1, opts.target || TARGET);
    const DAYS = opts.days || 30;
    const LIMIT = opts.limit || 150;
    // A forced whole-dataset run ("test / best of all-time") ignores the recently-used log so
    // it can re-surface the genuinely top moments; the scheduled daily run still rotates.
    const ignoreUsed = !!opts.force && !!opts.fresh;
    _busy = true;
    try {
        const prev = _load();
        const usedIds = new Set(ignoreUsed ? [] : (prev.usedIds || []));
        // Finished-VOD moments only, with an offset that actually falls inside the VOD.
        const raw = (db.getAiMomentCandidates(DAYS, LIMIT) || [])
            .filter(c => c.vod_id && (!c.vod_duration || (c.offset_seconds || 0) < c.vod_duration - 2));
        if (!raw.length) { _busy = false; return; }
        const fresh = raw.filter(c => !usedIds.has(c.memory_id));
        // One moment per streamer per run so a single busy channel can't flood the pastes tab.
        const seenUser = new Set();
        const oneEach = (fresh.length >= TARGET_N ? fresh : raw).filter(c => {
            if (seenUser.has(c.user_id)) return false;
            seenUser.add(c.user_id); return true;
        });
        const pool = oneEach;

        let picks = [];
        if (ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget() && pool.length > TARGET_N) {
            picks = await _aiPick(pool, TARGET_N);
        }
        if (picks.length < TARGET_N) {
            const chosen = new Set(picks.map(p => p.cand.memory_id));
            for (const h of _heuristicPick(pool.filter(c => !chosen.has(c.memory_id)), TARGET_N - picks.length)) picks.push(h);
        }

        const moments = [];
        const newUsed = [];
        for (const p of picks) {
            const c = p.cand;
            const title = (p.title || c.stream_title || 'A wild moment').slice(0, 80);
            // Defensive: if an old memory still holds a raw JSON blob, lift just the description.
            let desc = String(c.description || '').replace(/\s+/g, ' ').trim();
            if (/^\{.*"description"\s*:/.test(desc)) {
                const dm = desc.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
                if (dm) { try { desc = JSON.parse(`"${dm[1]}"`); } catch { desc = dm[1]; } }
            }
            const offset = Math.floor(c.offset_seconds || 0);
            const vodPath = `/vod/${c.vod_id}?t=${offset}`;
            const vodLink = `${BASE_URL}${vodPath}`;
            const slug = _slug();

            // Extract the actual frame at this moment into the pastes screenshots dir so the
            // paste is a real IMAGE paste (not plain text). Fall back to a text paste + existing
            // thumbnail if the VOD file isn't local.
            let screenshotPath = null;
            let img = c.thumbnail_url || `/api/thumbnails/generate/vod/${c.vod_id}`;
            try {
                const vod = db.getVodById(c.vod_id);
                if (thumb && vod && vod.file_path && thumb.extractFrameToFile) {
                    const fname = `ai-moment-${c.memory_id}-${offset}.jpg`;
                    const outPath = path.join(SCREENSHOTS_DIR, fname);
                    if (await thumb.extractFrameToFile(vod.file_path, c.offset_seconds, outPath)) {
                        screenshotPath = outPath;
                        img = `/data/pastes/screenshots/${fname}`;
                    }
                }
            } catch { /* keep fallback */ }

            // Description = the AI-generated text; card links back to the exact VOD moment.
            const content = `${desc}\n\n▶ Watch this moment on @${c.username}'s stream: ${vodLink}`;
            const metadata = JSON.stringify({ ai_moment: true, memory_id: c.memory_id, vod_id: c.vod_id, offset, image: img, vod_link: vodPath, username: c.username });
            try {
                db.createPaste({
                    slug, userId: c.user_id,
                    type: screenshotPath ? 'screenshot' : 'paste',
                    title, content, language: 'text', visibility: 'public',
                    streamId: c.stream_id, screenshotPath, metadata,
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

// CLI: force a one-off regeneration, e.g. a whole-dataset "best of all-time" test run:
//   node server/ai/ai-moments-job.js --all --fresh --target=8
if (require.main === module) {
    const argv = process.argv.slice(2);
    const has = (f) => argv.includes(f);
    const num = (name, def) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? parseInt(a.split('=')[1], 10) : def; };
    const opts = {
        force: true,
        fresh: has('--fresh'),                       // ignore the recently-used log
        days: has('--all') ? 100000 : num('days', 30),
        limit: has('--all') ? 500 : num('limit', 150),
        target: num('target', 6),
    };
    console.log('[AI-Moments] Manual run:', JSON.stringify(opts));
    tick(opts)
        .then(() => { const p = _load(); console.log(`[AI-Moments] Done — ${(p.moments || []).length} moment(s) in the hero set.`); process.exit(0); })
        .catch((e) => { console.error('[AI-Moments] Manual run failed:', e); process.exit(1); });
}
