/**
 * transcribe.js — free, LOCAL speech-to-text via whisper.cpp (no API, runs on the
 * server CPU with a small model). Used to add audio transcripts to live-stream
 * memories and clip analysis. Degrades to no-op if whisper isn't installed.
 *
 * Install (server): build whisper.cpp + download ggml-base.en.bin. Paths can be
 * overridden with WHISPER_BIN / WHISPER_MODEL env vars.
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

let _binCache;
function whisperBin() {
    if (_binCache !== undefined) return _binCache;
    _binCache = CANDIDATE_BINS.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
    return _binCache;
}
function available() {
    try { return !!whisperBin() && fs.existsSync(MODEL); } catch { return false; }
}

/** Transcribe a 16kHz mono WAV → plain text (''=nothing/unavailable). */
function transcribeWav(wavPath, { timeoutMs = 120000, threads = 4 } = {}) {
    return new Promise((resolve) => {
        const bin = whisperBin();
        if (!bin || !available() || !wavPath || !fs.existsSync(wavPath)) return resolve('');
        const outBase = `${wavPath}.out`;
        const args = ['-m', MODEL, '-f', wavPath, '-otxt', '-of', outBase, '-nt', '-t', String(threads), '-l', 'en'];
        let ff;
        try { ff = spawn(bin, args, { stdio: 'ignore' }); }
        catch { return resolve(''); }
        let done = false;
        const finish = (txt) => {
            if (done) return; done = true;
            clearTimeout(timer);
            try { fs.existsSync(`${outBase}.txt`) && fs.unlinkSync(`${outBase}.txt`); } catch { /* */ }
            resolve((txt || '').replace(/\s+/g, ' ').trim());
        };
        const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } finish(''); }, timeoutMs);
        ff.on('close', () => {
            let txt = '';
            try { txt = fs.readFileSync(`${outBase}.txt`, 'utf8'); } catch { /* */ }
            finish(txt);
        });
        ff.on('error', () => finish(''));
    });
}

/** Extract audio from ANY media file to a temp 16kHz mono WAV, then transcribe. */
function transcribeMedia(mediaPath, { seconds = 0, timeoutMs = 240000 } = {}) {
    return new Promise((resolve) => {
        if (!available() || !mediaPath || !fs.existsSync(mediaPath)) return resolve('');
        const wav = path.join(os.tmpdir(), `hobo-tx-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
        const args = ['-y', '-i', mediaPath];
        if (seconds > 0) args.push('-t', String(seconds));
        args.push('-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav);
        let ff;
        try { ff = spawn('ffmpeg', args, { stdio: 'ignore' }); }
        catch { return resolve(''); }
        const cleanup = () => { try { fs.existsSync(wav) && fs.unlinkSync(wav); } catch { /* */ } };
        ff.on('close', async () => {
            let txt = '';
            try { txt = await transcribeWav(wav, { timeoutMs }); } catch { /* */ }
            cleanup();
            resolve(txt);
        });
        ff.on('error', () => { cleanup(); resolve(''); });
    });
}

module.exports = { available, transcribeWav, transcribeMedia };
