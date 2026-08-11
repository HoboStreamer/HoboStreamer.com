/**
 * backfill-job.js — slowly fills in AI output for EXISTING content that predates
 * (or missed) analysis: paste summaries, VOD overviews, and clip overviews +
 * transcripts. Processes a few items per minute so it never spikes CPU/cost.
 */
'use strict';
const db = require('../db/database');
const ai = require('./ai-analysis');

let _timer = null;
let _busy = false;

async function tick() {
    if (_busy) return;
    _busy = true;
    try {
        // Transcripts — FREE local whisper (no API/cost), so they run independent of
        // the AI master switch. Backfills existing VODs/clips that have no transcript.
        // We DON'T stop while streams are live anymore (that's why an active channel's
        // recent VODs never got transcribed) — instead we drop to low-power (fewer
        // whisper threads) and a smaller batch so we never starve the live encoders.
        let anyLive = false;
        try { anyLive = ((db.getLiveStreams && db.getLiveStreams()) || []).length > 0; } catch { /* */ }
        if (ai.transcriptionEnabled && ai.transcriptionEnabled()) {
            try { require('./transcribe').setLowPower(anyLive); } catch { /* */ }
            const batch = anyLive ? 1 : 2;   // throttle while live, catch up faster when idle
            try { for (const v of db.getVodsNeedingTranscript(batch)) await ai.generateVodTranscript(v); }
            catch (e) { console.warn('[AI backfill] vod transcript:', e.message); }
            try { for (const c of db.getClipsNeedingTranscript(batch)) await ai.generateClipTranscript(c); }
            catch (e) { console.warn('[AI backfill] clip transcript:', e.message); }
        }

        if (!ai.isEnabled()) return;

        // Pastes — cheap text/image summaries.
        try {
            for (const p of db.getPastesNeedingAnalysis(2)) {
                // Always mark attempted (even on failure / unsupported image formats) so a
                // paste is never retried forever.
                if (p.type === 'screenshot' && p.screenshot_path) {
                    const r = await ai.analyzeImagePaste(p.screenshot_path, p.title);
                    db.updatePasteAi(p.id, { ai_summary: (r && r.description) ? r.description : ' ', ai_tags: JSON.stringify((r && r.tags) || []) });
                } else if (p.type === 'paste' && p.content) {
                    const r = await ai.analyzeTextPaste(p.content, p.title);
                    db.updatePasteAi(p.id, { ai_summary: (r && r.description) ? r.description : ' ', ai_tags: '[]' });
                } else {
                    db.updatePasteAi(p.id, { ai_summary: ' ', ai_tags: '[]' });
                }
            }
        } catch (e) { console.warn('[AI backfill] paste:', e.message); }

        // VOD overviews (frames + audio extracted from the file; self-marks on completion).
        try { for (const v of db.getVodsNeedingOverview(1)) await ai.generateVodOverview(v); }
        catch (e) { console.warn('[AI backfill] vod:', e.message); }

        // Clip overviews + local transcripts (frames + audio; self-marks).
        try { for (const c of db.getClipsNeedingOverview(1)) await ai.generateClipOverview(c); }
        catch (e) { console.warn('[AI backfill] clip:', e.message); }
    } finally {
        _busy = false;
    }
}

function start() {
    if (_timer) return;
    _timer = setInterval(tick, 60_000);
    console.log('[AI] Backfill job started (paste summaries + VOD/clip overviews + VOD/clip transcripts)');
}

module.exports = { start, tick };
