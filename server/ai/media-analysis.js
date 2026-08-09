/**
 * media-analysis.js — extract a spread of video FRAMES + sampled AUDIO from a media
 * file (local path OR presigned B2/R2 URL, via ffmpeg range requests) and turn them
 * into stream memories + an AI overview. This is what gives pre-existing VODs and
 * clips (which never had live memories) real AI overviews, combining vision + local
 * whisper transcription.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/database');

function _tmp(ext) {
    return path.join(os.tmpdir(), `hobo-ma-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
}

function _runFf(bin, args, killMs) {
    return new Promise((resolve) => {
        let ff;
        try { ff = spawn(bin, args, { stdio: 'ignore' }); } catch { return resolve(false); }
        const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, killMs);
        ff.on('close', (c) => { clearTimeout(t); resolve(c === 0); });
        ff.on('error', () => { clearTimeout(t); resolve(false); });
    });
}

function _ffprobeDuration(src) {
    return new Promise((resolve) => {
        let out = '';
        let ff;
        try { ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src], { stdio: ['ignore', 'pipe', 'ignore'] }); }
        catch { return resolve(0); }
        ff.stdout.on('data', (d) => { out += d; });
        const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } resolve(0); }, 45000);
        ff.on('close', () => { clearTimeout(t); const n = parseFloat(String(out).trim()); resolve(Number.isFinite(n) ? n : 0); });
        ff.on('error', () => { clearTimeout(t); resolve(0); });
    });
}

async function _extractFrame(src, t) {
    const out = _tmp('jpg');
    // -ss before -i = fast seek (HTTP range for remote URLs).
    const ok = await _runFf('ffmpeg', ['-y', '-ss', String(Math.max(0, t)), '-i', src, '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '5', out], 60000);
    if (ok && fs.existsSync(out) && fs.statSync(out).size > 512) return out;
    try { fs.existsSync(out) && fs.unlinkSync(out); } catch { /* */ }
    return null;
}

// Transcribe the audio: full for short media, else 3 spread 60s windows.
async function _transcribeSpan(src, duration) {
    const transcribe = require('./transcribe');
    if (!transcribe.available()) return '';
    if (duration > 0 && duration <= 200) {
        return await transcribe.transcribeMedia(src, { seconds: 0, timeoutMs: 240000 });
    }
    const parts = [];
    for (const frac of [0.1, 0.45, 0.8]) {
        const start = Math.floor((duration || 0) * frac);
        const wav = _tmp('wav');
        const ok = await _runFf('ffmpeg', ['-y', '-ss', String(start), '-i', src, '-t', '60', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], 120000);
        if (ok) { const txt = await transcribe.transcribeWav(wav, { timeoutMs: 120000 }); if (txt) parts.push(txt); }
        try { fs.existsSync(wav) && fs.unlinkSync(wav); } catch { /* */ }
    }
    return parts.join(' … ');
}

/**
 * Analyze a media source (ffmpeg-consumable path or URL): spread frames → vision
 * descriptions (optionally stored as memories) + sampled transcript → overview.
 * @returns {{ overview, transcript, frames, duration }}
 */
async function analyzeMedia(src, { streamId = null, userId = null, numFrames = 5, storeMemories = false, offsetBase = 0 } = {}) {
    const ai = require('./ai-analysis');
    if (!src) return { overview: null, transcript: '', frames: [], duration: 0 };
    const duration = await _ffprobeDuration(src);
    const n = Math.max(1, numFrames);
    const frames = [];
    for (let i = 0; i < n; i++) {
        const t = duration > 2 ? Math.max(1, Math.floor(duration * (i + 0.5) / n)) : 1;
        const fp = await _extractFrame(src, t);
        if (!fp) { if (duration <= 2) break; continue; }
        let r = null;
        try { r = await ai.analyzeStreamFrame(fp); } catch { /* */ }
        try { fs.unlinkSync(fp); } catch { /* */ }
        if (r && r.description) {
            frames.push({ t, description: r.description, tags: r.tags });
            if (storeMemories && streamId) {
                try {
                    db.addStreamMemory({
                        stream_id: streamId, user_id: userId,
                        offset_seconds: Math.round(offsetBase + t),
                        description: r.description, tags: r.tags, thumbnail_url: null,
                    });
                } catch { /* */ }
            }
        }
        if (duration <= 2) break;
    }

    const transcript = await _transcribeSpan(src, duration);

    let overview = null;
    if (frames.length || transcript) {
        const parts = [];
        if (frames.length) parts.push('Visual observations across the video (in order):\n' + frames.map(f => `- ${f.description}`).join('\n'));
        if (transcript) parts.push('Audio transcript (sampled from the recording):\n"' + transcript.slice(0, 4000) + '"');
        const prompt = `You are writing an AI overview of a recorded video. Using ONLY the signals below (be concrete, don't invent), summarize what the video is about in 2-5 sentences — the main activities, topics, and vibe.\n\n${parts.join('\n\n')}`;
        overview = await ai.summarizeText(prompt, 400, 'media_overview');
        if (overview) overview = overview.slice(0, 2000);
    }
    return { overview: overview || null, transcript: transcript || '', frames, duration };
}

/**
 * Transcript-only: probe duration then whisper-transcribe (FREE local, no vision).
 * @returns {Promise<string>} transcript text ('' if unavailable/empty).
 */
async function transcribeOnly(src) {
    if (!src) return '';
    const duration = await _ffprobeDuration(src);
    try { return await _transcribeSpan(src, duration); } catch { return ''; }
}

module.exports = { analyzeMedia, transcribeOnly };
