/**
 * AI "crazy moments" job — a two-stage pipeline that finds genuinely standout stream moments
 * for the home-page hero background + auto-created discoverability pastes:
 *
 *   Stage 1 — rank whole VODs by their AI overview (+ objective priors: views, clips taken,
 *             peak viewers) to decide which VODs are the most interesting.
 *   Stage 2 — for each chosen VOD, mine its full AI timeline (scene notes) + audio transcript,
 *             boosted by the timestamps viewers actually CLIPPED and chat-activity spikes, to
 *             pick the single best moment; extract that exact frame, vision-verify it, and post
 *             an image paste (description + tags + deep link to the VOD timestamp).
 *
 * Runs daily, rotates across streamers, dedupes against recently-used VODs, and degrades to
 * objective-signal picks when AI is off / over budget.
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
function _aiOn() { return !!(ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()); }
function _mmss(sec) { sec = Math.max(0, Math.floor(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }
function _cleanText(t, max) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, max || 400); }
function _cleanTitle(t) { return String(t || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 80); }

// Lift a plain description out of a value that might still be a raw JSON blob (old rows).
function _deJson(desc) {
    let s = _cleanText(desc, 2000);
    if (/^\{.*"description"\s*:/.test(s)) {
        const dm = s.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
        if (dm) { try { return JSON.parse(`"${dm[1]}"`); } catch { return dm[1]; } }
    }
    return s;
}
// A specific title from a description (fallback when AI titling is unavailable) — the first
// meaningful clause, Title-Cased, so we never fall back to a generic/duplicate stream title.
function _titleFromDesc(desc) {
    let s = _cleanText(desc);
    if (!s) return 'A wild moment';
    s = s.split(/[.!?;:]|,\s(?=(?:with|and|as|while|near|showing)\b)/i)[0].trim();
    const out = s.split(' ').filter(Boolean).slice(0, 8).join(' ').replace(/[,\s]+$/, '').replace(/\b\w/g, ch => ch.toUpperCase());
    return out.slice(0, 70) || 'A wild moment';
}

// ── Stage 1: rank VODs by their AI overview ─────────────────────────────────────────────
// Scores one chunk of VODs via a single LLM call; returns [{vod, score, why}] best-first.
async function _scoreVodChunk(chunk, want) {
    const list = chunk.map((v, i) => {
        const ov = _cleanText(v.ai_overview || v.ai_overview_short, 260) || '(no summary)';
        return `${i}. [${v.view_count || 0} views · ${v.clip_count || 0} clips · peak ${v.peak_viewers || 0}] "${_cleanText(v.title, 70)}" — ${ov}`;
    }).join('\n');
    const prompt = `These are livestream VODs with their AI summaries and popularity stats. Rank the MOST interesting/entertaining/memorable ones for a highlights showcase — favor funny, dramatic, surprising, high-energy, or unusual content over routine "just chatting / sitting at a desk" streams. Clips taken and peak viewers are strong signals that something notable happened.

${list}

Return STRICT JSON only, nothing else: [{"index": <n>, "score": <1-100>, "why": "<3-8 words>"}] for the top ${Math.min(chunk.length, Math.max(want, 6))}, best first.`;
    try {
        const text = await ai.summarizeText(prompt, 700, 'moment_vod_rank');
        const m = text && text.match(/\[[\s\S]*\]/);
        if (!m) return [];
        const arr = JSON.parse(m[0]);
        const seen = new Set();
        return arr.filter(x => chunk[x.index] != null && !seen.has(x.index) && seen.add(x.index))
            .map(x => ({ vod: chunk[x.index], score: Number(x.score) || 0, why: _cleanText(x.why, 60) }))
            .sort((a, b) => b.score - a.score);
    } catch { return []; }
}
// Rank the whole VOD set (batched tournament so "every VOD ever" scales). Falls back to the
// objective prior order (already applied by the DB) when AI is unavailable.
async function _rankVods(vods, want) {
    if (!_aiOn() || vods.length <= 1) return vods.map(v => ({ vod: v }));
    const CH = 25;
    if (vods.length <= CH) {
        const r = await _scoreVodChunk(vods, want);
        return r.length ? r : vods.map(v => ({ vod: v }));
    }
    const chunks = [];
    for (let i = 0; i < vods.length; i += CH) chunks.push(vods.slice(i, i + CH));
    let winners = [];
    for (const ch of chunks) winners.push(...(await _scoreVodChunk(ch, Math.max(want, 6))));
    winners.sort((a, b) => b.score - a.score);
    // Final round over the top finalists to get a coherent overall ranking.
    if (winners.length > want) {
        const finalists = winners.slice(0, CH).map(w => w.vod);
        const fr = await _scoreVodChunk(finalists, want);
        if (fr.length) winners = fr;
    }
    return winners.length ? winners : vods.map(v => ({ vod: v }));
}

// ── Stage 2: find the best moment inside one VOD ────────────────────────────────────────
// Sample an array down to at most `max` items, evenly spread.
function _sample(arr, max) {
    if (arr.length <= max) return arr;
    const out = []; const step = arr.length / max;
    for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
    return out;
}
function _momentContext(streamId, vodId) {
    const memories = _sample((db.getStreamMemories(streamId) || []).filter(m => m.description), 45);
    const transcript = _sample(db.getStreamTranscriptSegments(streamId) || [], 60);
    const clipTimes = db.getClipStartTimesForStream(streamId, vodId) || [];
    const spikes = db.getChatSpikeOffsets(streamId, 30, 8) || [];
    return { memories, transcript, clipTimes, spikes };
}
function _nearestMemory(memories, offset) {
    let best = null, bestD = Infinity;
    for (const m of memories) { const d = Math.abs((m.offset_seconds || 0) - offset); if (d < bestD) { bestD = d; best = m; } }
    return best;
}
async function _findBestMoment(vod) {
    const dur = Math.floor(vod.duration || 0);
    const ctx = _momentContext(vod.stream_id, vod.vod_id);
    if (!ctx.memories.length && !ctx.transcript.length) return null;
    const clamp = (t) => Math.max(1, Math.min(Math.floor(t || 0), dur > 3 ? dur - 2 : (t || 0)));

    if (_aiOn()) {
        const timeline = ctx.memories.map(m => `[${_mmss(m.offset_seconds)}] ${_cleanText(_deJson(m.description), 180)}`).join('\n');
        const script = ctx.transcript.map(s => `[${_mmss(s.start)}] ${_cleanText(s.text, 160)}`).join('\n');
        const clipHint = ctx.clipTimes.length ? ctx.clipTimes.slice(0, 12).map(_mmss).join(', ') : 'none';
        const spikeHint = ctx.spikes.length ? ctx.spikes.slice(0, 6).map(s => _mmss(s.offset)).join(', ') : 'none';
        const prompt = `Below is a single livestream VOD titled "${_cleanText(vod.title, 80)}", described by its on-screen TIMELINE (visual scene notes) and its AUDIO TRANSCRIPT, each line timestamped [m:ss].

TIMELINE:
${timeline || '(none)'}

TRANSCRIPT:
${script || '(none)'}

Viewers CLIPPED these timestamps (very strong "this was a highlight" signal): ${clipHint}
Chat activity SPIKED around: ${spikeHint}

Find the SINGLE most interesting/funny/dramatic/surprising/striking moment in this VOD. Prefer moments backed by the clip/chat signals when they line up with something notable. Return STRICT JSON only, nothing else: {"t": <seconds into the vod>, "title": "<specific punchy 3-8 word title, not the stream name>", "desc": "<one vivid sentence describing the moment>"}`;
        try {
            const text = await ai.summarizeText(prompt, 300, 'moment_pick');
            const m = text && text.match(/\{[\s\S]*\}/);
            if (m) {
                const j = JSON.parse(m[0]);
                let t = Number(j.t);
                if (!isNaN(t)) {
                    t = clamp(t);
                    const near = _nearestMemory(ctx.memories, t);
                    return { offset: t, title: _cleanTitle(j.title) || _titleFromDesc(j.desc), desc: _cleanText(_deJson(j.desc), 400) || (near && _deJson(near.description)) || '', tags: _memTags(near) };
                }
            }
        } catch { /* fall through to signal-based pick */ }
    }

    // No-AI fallback: pick from the strongest objective signal.
    let offset = null;
    if (ctx.clipTimes.length) offset = ctx.clipTimes[Math.floor(ctx.clipTimes.length / 2)]; // where viewers clipped
    else if (ctx.spikes.length) offset = ctx.spikes[0].offset;                              // busiest chat moment
    else { // richest scene note
        const rich = ctx.memories.slice().sort((a, b) => String(b.description).length - String(a.description).length)[0];
        offset = rich ? (rich.offset_seconds || 0) : 0;
    }
    offset = clamp(offset);
    const near = _nearestMemory(ctx.memories, offset);
    const desc = near ? _deJson(near.description) : '';
    return { offset, title: _titleFromDesc(desc), desc, tags: _memTags(near) };
}
function _memTags(m) {
    if (!m) return [];
    try { const t = typeof m.tags === 'string' ? JSON.parse(m.tags) : m.tags; if (Array.isArray(t)) return t.map(String).slice(0, 8); } catch { /* */ }
    return String(m.tags || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
}

async function tick(opts = {}) {
    // opts: { force } bypass the daily gate, { fresh } ignore the recently-used log,
    // { target } how many moments, { vodPool } how many VODs to consider, { perUser } cap.
    if (_busy || (!opts.force && !_due())) return;
    const TARGET_N = Math.max(1, opts.target || TARGET);
    const VOD_POOL = Math.max(TARGET_N, opts.vodPool || 120);
    const perUser = Math.max(1, opts.perUser || 1);
    const ignoreUsed = !!opts.fresh;
    _busy = true;
    try {
        // Clear any stale text moment pastes from earlier failed-extraction runs.
        try { if (db.deleteAiMomentTextPastes) db.deleteAiMomentTextPastes(); } catch { /* */ }
        const prev = _load();
        const usedVods = new Set(ignoreUsed ? [] : (prev.usedVods || []));

        // Stage 1: consider every eligible VOD, ranked by its AI overview + popularity prior.
        let vods = (db.getVodsForMomentRanking(VOD_POOL) || [])
            .filter(v => v.vod_id && (v.memory_count > 0 || (v.ai_overview && v.ai_overview.length > 20)));
        const totalEligible = vods.length;
        const freshVods = vods.filter(v => !usedVods.has(v.vod_id));
        if (freshVods.length >= TARGET_N) vods = freshVods;
        if (!vods.length) { _busy = false; return; }

        const ranked = await _rankVods(vods, TARGET_N * 3 + 2);

        // Diversify: at most `perUser` VODs per streamer, in ranked order, up to TARGET_N.
        const userCount = new Map();
        const chosen = [];
        for (const r of ranked) {
            const uid = r.vod.user_id;
            if ((userCount.get(uid) || 0) >= perUser) continue;
            userCount.set(uid, (userCount.get(uid) || 0) + 1);
            chosen.push(r);
            if (chosen.length >= TARGET_N) break;
        }
        if (chosen.length < TARGET_N) {
            const have = new Set(chosen.map(r => r.vod.vod_id));
            for (const r of ranked) { if (!have.has(r.vod.vod_id)) { chosen.push(r); have.add(r.vod.vod_id); } if (chosen.length >= TARGET_N) break; }
        }

        const moments = [];
        const newUsedVods = [];
        for (const r of chosen) {
            const v = r.vod;
            newUsedVods.push(v.vod_id);
            // Stage 2: find the best moment within this VOD.
            const moment = await _findBestMoment(v);
            if (!moment) continue;
            const offset = Math.floor(moment.offset || 0);
            let desc = moment.desc || '';
            let title = moment.title || _titleFromDesc(desc) || v.title;
            let tags = moment.tags || [];

            const vodPath = `/vod/${v.vod_id}?t=${offset}`;
            const vodLink = `${BASE_URL}${vodPath}`;
            const slug = _slug();

            // Extract the real frame at this moment so the paste is a true IMAGE paste. The
            // source can be a local file OR a presigned B2/R2 URL (for cold/offloaded VODs), so
            // pruned-local VODs still work — ffmpeg range-seeks the remote file.
            let screenshotPath = null;
            let img = `/api/thumbnails/generate/vod/${v.vod_id}`;
            try {
                const vod = db.getVodById(v.vod_id);
                let source = vod && vod.file_path;
                try { const vs = require('../vod/vod-storage'); const src = vod && await vs.resolveMediaSource(vod); if (src && src.value) source = src.value; } catch { /* fall back to file_path */ }
                if (thumb && source && thumb.extractFrameToFile) {
                    const fname = `ai-moment-vod${v.vod_id}-${offset}.jpg`;
                    const outPath = path.join(SCREENSHOTS_DIR, fname);
                    if (await thumb.extractFrameToFile(source, offset, outPath)) {
                        screenshotPath = outPath;
                        img = `/data/pastes/screenshots/${fname}`;
                        // Vision-verify the ACTUAL extracted frame → most accurate description +
                        // tags, and it confirms we didn't grab a black/loading screen.
                        if (_aiOn() && ai.analyzeImagePaste) {
                            try {
                                const vis = await ai.analyzeImagePaste(outPath, title);
                                if (vis && vis.description && vis.description.length > 25) {
                                    desc = _cleanText(vis.description, 500);
                                    if (Array.isArray(vis.tags) && vis.tags.length) tags = vis.tags.slice(0, 8);
                                    if (!moment.title) title = _titleFromDesc(desc);
                                }
                            } catch { /* keep the moment desc */ }
                        }
                    }
                }
            } catch { /* keep fallback */ }

            // These are meant to be IMAGE pastes of the actual moment. If we couldn't extract
            // the frame (e.g. the VOD file was pruned), skip it entirely — never post a text
            // paste, which just clutters the pastes tab.
            if (!screenshotPath) {
                console.log(`[AI-Moments] Skipped VOD ${v.vod_id} — could not extract moment frame (no local file).`);
                continue;
            }

            if (!desc) desc = _cleanText(v.ai_overview_short || v.ai_overview, 400) || 'A standout moment from this stream.';
            const content = `${desc}\n\n▶ Watch this moment on @${v.username}'s stream: ${vodLink}`;
            const metadata = JSON.stringify({ ai_moment: true, vod_id: v.vod_id, offset, image: img, vod_link: vodPath, username: v.username, why: r.why || null });
            try {
                const res = db.createPaste({
                    slug, userId: v.user_id,
                    type: screenshotPath ? 'screenshot' : 'paste',
                    title: title.slice(0, 80), content, language: 'text', visibility: 'public',
                    streamId: v.stream_id, screenshotPath, metadata,
                });
                const pasteId = res && res.lastInsertRowid;
                if (pasteId && db.updatePasteAi) {
                    try { db.updatePasteAi(pasteId, { ai_summary: desc, ai_tags: tags.length ? tags : null }); } catch { /* */ }
                }
            } catch { /* slug collision / other — skip */ }

            moments.push({ vodId: v.vod_id, offset, title: title.slice(0, 80), thumbnail: img, username: v.username, pasteSlug: slug });
        }

        const usedLog = [...newUsedVods, ...(prev.usedVods || [])].slice(0, 300);
        db.setSetting(SETTING, JSON.stringify({ moments, usedVods: usedLog, updated_at: Date.now() }));
        console.log(`[AI-Moments] ${moments.length} moment(s) from ${chosen.length}/${totalEligible} ranked VODs + pastes created`);
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
//   node server/ai/ai-moments-job.js --fresh --target=6 --perUser=2
if (require.main === module) {
    const argv = process.argv.slice(2);
    const has = (f) => argv.includes(f);
    const num = (name, def) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? parseInt(a.split('=')[1], 10) : def; };
    const opts = {
        force: true,
        fresh: has('--fresh'),
        target: num('target', 6),
        vodPool: has('--all') ? 500 : num('vodPool', 120),
        perUser: num('perUser', 1),
    };
    console.log('[AI-Moments] Manual run:', JSON.stringify(opts));
    tick(opts)
        .then(() => { const p = _load(); console.log(`[AI-Moments] Done — ${(p.moments || []).length} moment(s) in the hero set.`); process.exit(0); })
        .catch((e) => { console.error('[AI-Moments] Manual run failed:', e); process.exit(1); });
}
