/**
 * AI auto-clip job.
 *
 *  LIVE  — every ~90s, for each live stream, look at the last chunk of time and detect a
 *          clear "everyone reacted" chat spike; if AI agrees it's genuinely clip-worthy, cut a
 *          clip from the stream's growing recording around that moment. Selective + capped
 *          (max/hour + min spacing) so it only grabs real standouts.
 *  VOD   — clipVodMoment(): cut a clip around a moment the AI-moments pipeline already picked
 *          for a finished VOD (reuses the same detection brain).
 *
 * Fuses chat velocity + AI scene notes + audio transcript, and degrades gracefully when AI is
 * off (a much stronger chat spike is then required).
 */
const db = require('../db/database');
const ai = require('./ai-analysis');
const { cutClip } = require('../vod/clip-cutter');

// ── Tunables ────────────────────────────────────────────────
const CHECK_INTERVAL_MS = 90 * 1000;
const MAX_PER_HOUR = 3;
const MIN_SPACING_MIN = 12;
const WINDOW_SEC = 150;      // chunk of time considered each check
const BUCKET_SEC = 15;
const SPIKE_MIN_MSGS = 6;    // a spike bucket must have at least this many messages
const SPIKE_MULT = 2.5;      // …and be this many× the window average
const SPIKE_MULT_NOAI = 4;   // stricter when we can't get AI agreement
const CLIP_PRE = 16, CLIP_POST = 9;   // seconds cut before/after the moment

let _timer = null;
let _busy = false;

function _aiOn() { return !!(ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()); }
function _clean(t, n) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, n || 300); }

// AI confirmation for a live spike: given what was on screen / said / typed, is this a real
// clip-worthy moment? Returns { clip, title, desc } (clip=false → skip).
async function _confirmLiveMoment(stream) {
    const memories = (db.getStreamMemories(stream.id) || []).filter(m => m.description).slice(-5);
    const transcript = (db.getStreamTranscriptSegments(stream.id) || []).slice(-14);
    const chat = db.getRecentChatText(stream.id, WINDOW_SEC, 40) || [];
    const scene = memories.map(m => `- ${_clean(m.description, 160)}`).join('\n');
    const script = transcript.map(s => `- ${_clean(s.text, 140)}`).join('\n');
    const chatBlock = chat.slice(-30).map(c => `- ${_clean(c, 100)}`).join('\n');
    if (!_aiOn()) return { clip: null }; // caller decides via the stricter no-AI threshold

    const prompt = `A live stream just had a spike in chat activity — viewers reacted to something. Decide if this is a genuinely clip-worthy standout moment (funny, dramatic, surprising, hype) worth auto-clipping, or just routine chatter.

ON SCREEN (recent scene notes):
${scene || '(none)'}

WHAT WAS SAID (recent transcript):
${script || '(none)'}

CHAT (recent messages):
${chatBlock || '(none)'}

Return STRICT JSON only: {"clip": true|false, "title": "<specific punchy 3-8 word title>", "desc": "<one vivid sentence>"}. Set clip=false if nothing genuinely notable is happening.`;
    try {
        const text = await ai.summarizeText(prompt, 220, 'auto_clip_confirm');
        const m = text && text.match(/\{[\s\S]*\}/);
        if (!m) return { clip: false };
        const j = JSON.parse(m[0]);
        return { clip: j.clip === true, title: _clean(j.title, 80), desc: _clean(j.desc, 400) };
    } catch { return { clip: false }; }
}

async function _checkLiveStream(stream) {
    const streamId = stream.id;
    try {
        if (db.isStreamClipRecordingEnabled && !db.isStreamClipRecordingEnabled(stream)) return;
        // Hourly cap + min spacing.
        if (db.countAutoClipsSince(streamId, 60) >= MAX_PER_HOUR) return;
        if (db.countAutoClipsSince(streamId, MIN_SPACING_MIN) > 0) return;

        const rec = db.getActiveVodByStream && db.getActiveVodByStream(streamId);
        if (!rec || !rec.file_path) return;

        // Detect a clear chat spike in the recent chunk.
        const buckets = db.getLiveChatBuckets(streamId, WINDOW_SEC, BUCKET_SEC);
        if (buckets.length < 3) return;
        const counts = buckets.map(b => b.count);
        const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
        const peak = buckets.reduce((mx, b) => (b.count > mx.count ? b : mx), buckets[0]);
        if (peak.count < SPIKE_MIN_MSGS) return;

        // AI agreement (or a much stronger spike when AI is unavailable).
        const verdict = await _confirmLiveMoment(stream);
        if (verdict.clip === true) {
            if (peak.count < Math.max(SPIKE_MIN_MSGS, SPIKE_MULT * avg)) return;
        } else if (verdict.clip === null) { // AI off → stricter chat-only gate
            if (peak.count < Math.max(SPIKE_MIN_MSGS, SPIKE_MULT_NOAI * avg)) return;
        } else {
            return; // AI said not clip-worthy
        }

        // Locate the spike in recording time: how long ago it happened vs the live edge.
        const nowEpoch = Math.floor(Date.now() / 1000);
        const secondsAgo = Math.max(0, nowEpoch - (peak.tsEpoch || nowEpoch));
        let recEdge = 0;
        const recStartMs = Date.parse(String(rec.created_at).replace(' ', 'T') + 'Z');
        if (Number.isFinite(recStartMs)) recEdge = (Date.now() - recStartMs) / 1000;
        // A seek past the flushed footage just yields no decodable clip (cutClip rejects it),
        // so a slightly-optimistic wall-clock edge is safe.
        const momentOffset = Math.max(1, recEdge - secondsAgo);
        const start = Math.max(0, momentOffset - CLIP_PRE);
        const dur = Math.min(CLIP_PRE + CLIP_POST, Math.max(0, recEdge - 0.5 - start));
        if (dur < 5) return; // not enough flushed footage around the moment yet

        const title = verdict.title || 'Chat-Hyped Moment';
        const clip = await cutClip({
            source: rec.file_path, startTime: start, duration: dur,
            streamId, vodId: rec.id, userId: stream.user_id,
            title, description: verdict.desc || '', autoGenerated: true,
        });
        if (clip) console.log(`[AutoClip] LIVE clip for stream ${streamId} @${Math.round(momentOffset)}s ("${title}") — spike ${peak.count} msgs`);
    } catch (e) {
        console.warn(`[AutoClip] live check failed for stream ${streamId}:`, e.message);
    }
}

async function _tick() {
    if (_busy) return;
    _busy = true;
    try {
        let streams = [];
        try { streams = db.getLiveStreams() || []; } catch { /* */ }
        for (const s of streams) { await _checkLiveStream(s); } // serial → bounded ffmpeg load
    } finally { _busy = false; }
}

// ── Historical VOD backfill: a few auto-clips per day (daily-gated, like the moments/paste
// jobs). Processes the most-watched un-clipped VODs first; idempotent (skips VODs that already
// have an auto-clip), so it steadily works through the back catalogue over days. ─────────────
const BACKFILL_SETTING = 'auto_clip_backfill';
const BACKFILL_PER_RUN = 3;                       // a few historical clips…
const BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;  // …every 6h (guarantees ≥1 clip / 6h)

function _backfillDue() {
    try { const p = JSON.parse(db.getSetting(BACKFILL_SETTING) || '{}'); return !p.updated_at || (Date.now() - p.updated_at) >= BACKFILL_INTERVAL_MS; }
    catch { return true; }
}
async function _resolveVodSource(vodId) {
    try {
        const vod = db.getVodById(vodId);
        if (!vod) return null;
        try { const vs = require('../vod/vod-storage'); const src = await vs.resolveMediaSource(vod); if (src && src.value) return src.value; } catch { /* */ }
        return vod.file_path || null;
    } catch { return null; }
}

// Cut auto-clips for up to `limit` historical VODs that don't have one yet. Keeps a `skip`
// list of VODs we couldn't clip (media pruned / cut failed) so dead VODs don't block progress
// or waste an AI call on every run.
async function backfillVodClips({ limit = BACKFILL_PER_RUN, force = false } = {}) {
    if (!force && !_backfillDue()) return 0;
    let prev = {};
    try { prev = JSON.parse(db.getSetting(BACKFILL_SETTING) || '{}') || {}; } catch { /* */ }
    const skip = new Set(prev.skip || []);
    const moments = require('./ai-moments-job');
    // Over-fetch so skipped/dead VODs don't starve a batch.
    const pool = (db.getVodsWithoutAutoClip(Math.max(1, limit) * 6) || []).filter(v => !skip.has(v.vod_id));
    let made = 0;
    const newSkip = [];
    for (const v of pool) {
        if (made >= limit) break;
        try {
            const source = await _resolveVodSource(v.vod_id);
            if (!source) { newSkip.push(v.vod_id); continue; } // media gone / unreadable
            const moment = await moments.findBestMoment(v);
            if (!moment) { newSkip.push(v.vod_id); continue; }
            const clip = await clipVodMoment({ vod: v, offset: moment.offset, title: moment.title, desc: moment.desc, source });
            if (clip) { made++; console.log(`[AutoClip] Backfilled VOD ${v.vod_id} ("${String(moment.title || '').slice(0, 60)}")`); }
            else newSkip.push(v.vod_id); // cut failed (e.g. unseekable/short) — don't retry forever
        } catch (e) { newSkip.push(v.vod_id); console.warn(`[AutoClip] backfill VOD ${v.vod_id} failed:`, e.message); }
    }
    const mergedSkip = [...new Set([...(prev.skip || []), ...newSkip])].slice(-2000);
    try { db.setSetting(BACKFILL_SETTING, JSON.stringify({ updated_at: Date.now(), lastMade: made, skip: mergedSkip })); } catch { /* */ }
    if (made || newSkip.length) console.log(`[AutoClip] Historical backfill: ${made} clip(s) added, ${newSkip.length} VOD(s) skipped (unclippable)`);
    return made;
}

/**
 * Cut a clip around a moment the AI-moments pipeline already chose for a finished VOD.
 * @param {object} o { vod (row w/ user_id, stream_id, vod_id/id), offset, title, desc, source }
 */
async function clipVodMoment(o) {
    try {
        const { vod, offset, title, desc, source } = o || {};
        if (!vod || !source || !(offset >= 0)) return null;
        const dur = CLIP_PRE + CLIP_POST;
        const start = Math.max(0, Math.floor(offset) - CLIP_PRE);
        return await cutClip({
            source, startTime: start, duration: dur,
            streamId: vod.stream_id, vodId: vod.vod_id || vod.id, userId: vod.user_id,
            title: title || 'Standout Moment', description: desc || '', autoGenerated: true,
        });
    } catch { return null; }
}

let _backfillTimer = null;
function start() {
    if (_timer) return;
    _timer = setInterval(() => { _tick().catch(() => {}); }, CHECK_INTERVAL_MS);
    // Historical VOD backfill: a few clips/day (self-gates on 24h). First pass ~3 min after boot.
    setTimeout(() => { backfillVodClips().catch(() => {}); }, 3 * 60 * 1000);
    _backfillTimer = setInterval(() => { backfillVodClips().catch(() => {}); }, 60 * 60 * 1000);
    console.log('[AutoClip] Live auto-clip job started (selective chat-spike + AI agreement) + daily VOD backfill');
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } if (_backfillTimer) { clearInterval(_backfillTimer); _backfillTimer = null; } }

module.exports = { start, stop, clipVodMoment, backfillVodClips, _tick };

// CLI: force a historical backfill batch, e.g. `node server/ai/auto-clip-job.js --backfill --limit=4`
if (require.main === module) {
    const argv = process.argv.slice(2);
    const num = (name, def) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? parseInt(a.split('=')[1], 10) : def; };
    if (argv.includes('--backfill')) {
        const limit = num('limit', 4);
        console.log(`[AutoClip] Manual backfill (limit ${limit})…`);
        backfillVodClips({ limit, force: true })
            .then((n) => { console.log(`[AutoClip] Manual backfill done — ${n} clip(s) created.`); process.exit(0); })
            .catch((e) => { console.error('[AutoClip] Manual backfill failed:', e); process.exit(1); });
    } else {
        console.log('Usage: node server/ai/auto-clip-job.js --backfill [--limit=N]');
        process.exit(0);
    }
}
