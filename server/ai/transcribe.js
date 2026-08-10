/**
 * transcribe.js — free, LOCAL speech-to-text via whisper.cpp (no API, runs on the
 * server CPU). Used for live-stream memories and VOD/clip transcripts.
 *
 * Reliability features:
 *   - JSON output (-oj) → per-segment timestamps (ms) we keep as contextual data.
 *   - Beam search for steadier decoding.
 *   - Post-filter that drops whisper's well-known hallucinations on silence/music
 *     ("you", "Thanks for watching!", "[MUSIC]", …) and collapses looped repeats.
 *
 * Install (server): build whisper.cpp + download a ggml model. Paths/threads/beam
 * can be overridden with WHISPER_BIN / WHISPER_MODEL / WHISPER_THREADS / WHISPER_BEAM.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const CANDIDATE_BINS = [
    process.env.WHISPER_BIN,
    path.join(HOME, 'whisper.cpp/build/bin/whisper-cli'),
    path.join(HOME, 'whisper.cpp/build/bin/main'),
    path.join(HOME, 'whisper.cpp/main'),
].filter(Boolean);
const MODEL = process.env.WHISPER_MODEL || path.join(HOME, 'whisper.cpp/models/ggml-base.en.bin');
const THREADS = Math.max(2, Math.min(8, parseInt(process.env.WHISPER_THREADS, 10) || 4));
// Default to greedy decoding (whisper.cpp default) — proven to transcribe speech
// reliably here. Beam search (WHISPER_BEAM>1) sometimes collapses real speech into a
// non-speech tag like "[Crowd noise]", so it's opt-in only.
const BEAM = Math.max(1, Math.min(8, parseInt(process.env.WHISPER_BEAM, 10) || 1));

let _binCache;
function whisperBin() {
    if (_binCache !== undefined) return _binCache;
    _binCache = CANDIDATE_BINS.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
    return _binCache;
}
function available() {
    try { return !!whisperBin() && fs.existsSync(MODEL); } catch { return false; }
}

// Phrases whisper commonly hallucinates over silence / music / non-speech.
const HALLUCINATIONS = new Set([
    'you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
    'thanks for watching.', 'please subscribe', 'subscribe', 'like and subscribe',
    'bye', 'bye.', 'bye bye', 'okay', 'ok', 'oh', 'uh', 'um', 'hmm', 'mm', 'mhm',
    'the', 'so', 'yeah', '.', '...', 'thank you for watching', 'thank you very much',
    'thank you so much', 'i\'m sorry', 'silence', 'music', 'applause',
]);
function _isNoise(t) {
    const s = (t || '').replace(/\s+/g, ' ').trim();
    if (!s) return true;
    // bracketed/parenthetical cues, music notes, or pure punctuation
    if (/^[\s.\-–—_*]+$/.test(s)) return true;
    if (/^[\[(♪].*[\])♪]?$/.test(s)) return true;
    if (/^♪/.test(s) || /♪$/.test(s)) return true;
    const norm = s.toLowerCase().replace(/[.!?,…]+$/g, '').trim();
    return HALLUCINATIONS.has(norm);
}

// Clean a raw segment list: drop noise + collapse immediate repeats.
function _cleanSegments(segsRaw) {
    const out = [];
    let last = '';
    for (const seg of segsRaw) {
        const text = (seg.text || '').replace(/\s+/g, ' ').trim();
        if (_isNoise(text)) continue;
        const norm = text.toLowerCase();
        if (norm === last) continue; // whisper loops the same line — drop the dupes
        last = norm;
        out.push({ start: Math.round(seg.start * 100) / 100, end: Math.round(seg.end * 100) / 100, text });
    }
    return out;
}
function _joinSegments(segments) {
    return segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Detailed transcription of a 16kHz mono WAV.
 * @returns {Promise<{text:string, segments:Array<{start:number,end:number,text:string}>}>}
 *          start/end in seconds (shifted by opts.offsetSec).
 */
function transcribeWavDetailed(wavPath, { timeoutMs = 180000, offsetSec = 0 } = {}) {
    return new Promise((resolve) => {
        const bin = whisperBin();
        if (!bin || !available() || !wavPath || !fs.existsSync(wavPath)) return resolve({ text: '', segments: [] });
        const outBase = `${wavPath}.out`;
        const jsonPath = `${outBase}.json`;
        const args = ['-m', MODEL, '-f', wavPath, '-oj', '-of', outBase, '-t', String(THREADS), '-l', 'en'];
        if (BEAM > 1) args.push('-bs', String(BEAM));
        let ff;
        try { ff = spawn(bin, args, { stdio: 'ignore' }); }
        catch { return resolve({ text: '', segments: [] }); }
        let done = false;
        const finish = (result) => {
            if (done) return; done = true;
            clearTimeout(timer);
            try { fs.existsSync(jsonPath) && fs.unlinkSync(jsonPath); } catch { /* */ }
            resolve(result);
        };
        const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } finish({ text: '', segments: [] }); }, timeoutMs);
        ff.on('close', () => {
            let parsed;
            try { parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return finish({ text: '', segments: [] }); }
            const items = Array.isArray(parsed && parsed.transcription) ? parsed.transcription : [];
            const segsRaw = items.map(it => ({
                start: offsetSec + ((it.offsets && it.offsets.from) || 0) / 1000,
                end: offsetSec + ((it.offsets && it.offsets.to) || 0) / 1000,
                text: it.text || '',
            }));
            const segments = _cleanSegments(segsRaw);
            finish({ text: _joinSegments(segments), segments });
        });
        ff.on('error', () => finish({ text: '', segments: [] }));
    });
}

/** Backward-compatible plain-text transcription of a WAV. */
async function transcribeWav(wavPath, opts = {}) {
    const r = await transcribeWavDetailed(wavPath, opts);
    return r.text;
}

/**
 * Extract audio from ANY media (local file OR http(s) URL) → temp wav → detailed
 * transcription. @returns {Promise<{text, segments}>}
 */
function transcribeMediaDetailed(mediaPath, { seconds = 0, offsetSec = 0, timeoutMs = 300000 } = {}) {
    return new Promise((resolve) => {
        const isUrl = /^https?:/i.test(mediaPath || '');
        if (!available() || !mediaPath || (!isUrl && !fs.existsSync(mediaPath))) return resolve({ text: '', segments: [] });
        const wav = path.join(os.tmpdir(), `hobo-tx-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
        const args = ['-y', '-i', mediaPath];
        if (seconds > 0) args.push('-t', String(seconds));
        args.push('-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav);
        let ff;
        try { ff = spawn('ffmpeg', args, { stdio: 'ignore' }); }
        catch { return resolve({ text: '', segments: [] }); }
        const cleanup = () => { try { fs.existsSync(wav) && fs.unlinkSync(wav); } catch { /* */ } };
        ff.on('close', async () => {
            let r = { text: '', segments: [] };
            try { r = await transcribeWavDetailed(wav, { timeoutMs, offsetSec }); } catch { /* */ }
            cleanup();
            resolve(r);
        });
        ff.on('error', () => { cleanup(); resolve({ text: '', segments: [] }); });
    });
}

/** Backward-compatible plain-text transcription of a media file/URL. */
async function transcribeMedia(mediaPath, opts = {}) {
    const r = await transcribeMediaDetailed(mediaPath, opts);
    return r.text;
}

module.exports = { available, transcribeWav, transcribeWavDetailed, transcribeMedia, transcribeMediaDetailed };
