/**
 * HoboStreamer — Stream memory job
 *
 * Periodically captures a frame from each live stream and asks the vision model
 * what's happening, storing a timestamped "memory". The latest memory doubles as
 * the stream's home-card "AI Overview". Gated by `ai_enabled` +
 * `ai_stream_memory_enabled` (default OFF) and the configured capture interval, so
 * it costs nothing until an admin turns it on.
 */
const db = require('../db/database');
const ai = require('./ai-analysis');

let vision = null;
try { vision = require('./stream-vision'); } catch { /* optional */ }

const _last = new Map(); // streamId -> last capture ms (avoids overlap / respects interval)

async function _analyzeOne(stream) {
    let image = null;
    try { if (vision && vision.captureFrame) image = await vision.captureFrame(stream); } catch { /* */ }
    if (!image) {
        // Fall back to the freshest thumbnail file on disk.
        try {
            const thumbSvc = require('../thumbnails/thumbnail-service');
            const st = thumbSvc.getStreamThumbnailState && thumbSvc.getStreamThumbnailState(stream.id);
            if (st && st.filePath) image = st.filePath;
        } catch { /* */ }
    }
    if (!image) return;

    const r = await ai.analyzeStreamFrame(image);
    if (!r || !r.description) return;

    // Free local audio transcription (whisper.cpp) folded into the memory, so the
    // overview reflects what was SAID, not just what's on screen.
    let heard = '';
    try {
        if (ai.transcriptionEnabled && ai.transcriptionEnabled()) {
            const audio = require('./stream-audio').captureAudioChunk ? await require('./stream-audio').captureAudioChunk(stream, 12) : null;
            if (audio) {
                heard = await require('./transcribe').transcribeWav(audio);
                try { require('fs').unlinkSync(audio); } catch { /* */ }
            }
        }
    } catch { /* transcription is best-effort */ }
    const memDesc = heard ? `${r.description} — heard: "${heard.slice(0, 500)}"` : r.description;

    const startedMs = stream.started_at ? new Date(String(stream.started_at).replace(' ', 'T') + 'Z').getTime() : Date.now();
    const offset = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
    try {
        db.addStreamMemory({
            stream_id: stream.id, user_id: stream.user_id, offset_seconds: offset,
            description: memDesc, tags: r.tags, thumbnail_url: stream.thumbnail_url || null,
        });
        // Roll ALL of this stream's memories (since it started) into a general
        // "AI Overview" for the home card — not just the latest frame. Falls back
        // to the latest description if the summary call is unavailable.
        let overview = r.description;
        try {
            const memories = db.getStreamMemories(stream.id);
            if (memories && memories.length > 1) {
                const summary = await ai.summarizeStreamMemories(memories);
                if (summary) overview = summary;
            }
        } catch { /* keep latest description */ }
        db.updateStreamAiOverview(stream.id, overview);
    } catch (e) { console.warn('[AI] memory store failed:', e.message); }
}

async function tick() {
    if (!ai.streamMemoryEnabled()) return;
    let streams = [];
    try { streams = db.getLiveStreams() || []; } catch { return; }
    const intervalMs = ai.captureIntervalSec() * 1000;
    const now = Date.now();
    for (const stream of streams) {
        if (now - (_last.get(stream.id) || 0) < intervalMs) continue;
        _last.set(stream.id, now); // set before the async work so we don't double-capture
        _analyzeOne(stream).catch(() => {});
    }
    // GC entries for streams no longer live.
    if (_last.size > 300) {
        const liveIds = new Set(streams.map(s => s.id));
        for (const id of _last.keys()) if (!liveIds.has(id)) _last.delete(id);
    }
}

function start() {
    setInterval(() => { tick().catch(() => {}); }, 30000);
    console.log('[AI] Stream memory job started (30s poll; captures at the configured interval when enabled)');
}

module.exports = { start, tick };
