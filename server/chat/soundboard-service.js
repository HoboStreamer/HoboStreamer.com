/**
 * HoboStreamer — 101Soundboards Integration
 *
 * Detects 101soundboards.com links in chat messages, fetches the audio,
 * caches it locally, and returns base64-encoded audio for playback.
 *
 * Chat syntax:
 *   https://www.101soundboards.com/sounds/58675-airhorn
 *   !sb 58675            (shorthand by ID)
 *   !sb 58675 1.5p       (pitch modifier: 1.5x)
 *   !sb 58675 0.8s       (speed modifier: 0.8x)
 *   !sb 58675 1.5p 0.8s  (both)
 */
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'soundboard-cache');
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Match 101soundboards URLs or !sb command with sound ID
const URL_REGEX = /(?:https?:\/\/)?(?:www\.)?101soundboards\.com\/sounds\/(\d+)(?:[^\s]*)/i;
const CMD_REGEX = /^!sb\s+(\d+)(?:\s+(.+))?$/i;

// Parse pitch/speed modifiers from arguments string
function parseModifiers(args) {
    const mods = { pitch: 1.0, speed: 1.0 };
    if (!args) return mods;
    const parts = args.trim().split(/\s+/);
    for (const p of parts) {
        const pitchMatch = p.match(/^([\d.]+)p$/i);
        const speedMatch = p.match(/^([\d.]+)s$/i);
        if (pitchMatch) mods.pitch = Math.max(0.25, Math.min(4.0, parseFloat(pitchMatch[1])));
        if (speedMatch) mods.speed = Math.max(0.25, Math.min(4.0, parseFloat(speedMatch[1])));
    }
    return mods;
}

// Extract sound ID + modifiers from a chat message
function parseSoundboardMessage(text) {
    // Try !sb command first
    const cmdMatch = text.match(CMD_REGEX);
    if (cmdMatch) {
        return { soundId: cmdMatch[1], ...parseModifiers(cmdMatch[2]) };
    }
    // Try URL match
    const urlMatch = text.match(URL_REGEX);
    if (urlMatch) {
        return { soundId: urlMatch[1], pitch: 1.0, speed: 1.0 };
    }
    return null;
}

// Ensure cache directory exists
function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

// Check if cached file is still valid
function getCachedAudio(soundId) {
    const cached = path.join(CACHE_DIR, `${soundId}.mp3`);
    try {
        const stat = fs.statSync(cached);
        if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
            return fs.readFileSync(cached);
        }
        // Expired — remove
        fs.unlinkSync(cached);
    } catch { /* not cached */ }
    return null;
}

// Fetch the sound page and extract the audio URL from the HTML
function fetchSoundPageUrl(soundId) {
    return new Promise((resolve, reject) => {
        const url = `https://www.101soundboards.com/sounds/${soundId}`;
        const req = https.get(url, { headers: { 'User-Agent': 'HoboStreamer/1.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return resolve(null); // Sound doesn't exist or redirect
            }
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(null);
            }
            let html = '';
            res.on('data', (chunk) => { html += chunk; });
            res.on('end', () => {
                // Look for the audio source URL in the HTML
                // Common patterns: <source src="...mp3"> or <audio src="...mp3">
                const srcMatch = html.match(/<(?:source|audio)[^>]+src=["']([^"']+\.mp3[^"']*?)["']/i);
                if (srcMatch) return resolve(srcMatch[1]);

                // Also check for data attributes or JS variables holding audio URL
                const dataMatch = html.match(/data-(?:audio|sound|src)=["']([^"']+\.mp3[^"']*?)["']/i);
                if (dataMatch) return resolve(dataMatch[1]);

                // Check for direct MP3 link in onclick or play handlers
                const jsMatch = html.match(/["'](https?:\/\/[^"']+\.mp3[^"']*?)["']/i);
                if (jsMatch) return resolve(jsMatch[1]);

                // Extract title for logging
                const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
                const title = titleMatch ? titleMatch[1].trim() : `Sound ${soundId}`;
                console.warn(`[Soundboard] Could not find audio URL for ${title} (${soundId})`);
                resolve(null);
            });
        });
        req.on('error', (err) => {
            console.error(`[Soundboard] Fetch error for ${soundId}:`, err.message);
            resolve(null);
        });
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    });
}

// Download audio from URL, return Buffer
function downloadAudio(audioUrl) {
    return new Promise((resolve, reject) => {
        const getter = audioUrl.startsWith('https') ? https : http;
        const req = getter.get(audioUrl, { headers: { 'User-Agent': 'HoboStreamer/1.0' } }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(null);
            }
            const chunks = [];
            let size = 0;
            const MAX_SIZE = 5 * 1024 * 1024; // 5MB limit
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_SIZE) { res.destroy(); return resolve(null); }
                chunks.push(chunk);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    });
}

// Extract title from the 101soundboards page
function fetchSoundTitle(soundId) {
    return new Promise((resolve) => {
        const url = `https://www.101soundboards.com/sounds/${soundId}`;
        const req = https.get(url, { headers: { 'User-Agent': 'HoboStreamer/1.0' } }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return resolve(`Sound ${soundId}`); }
            let html = '';
            res.on('data', (chunk) => { html += chunk; });
            res.on('end', () => {
                const match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
                resolve(match ? match[1].trim() : `Sound ${soundId}`);
            });
        });
        req.on('error', () => resolve(`Sound ${soundId}`));
        req.setTimeout(5000, () => { req.destroy(); resolve(`Sound ${soundId}`); });
    });
}

/**
 * Get soundboard audio for a given sound ID.
 * Returns { audio: base64, mimeType, title, soundId } or null.
 */
async function getSoundboardAudio(soundId) {
    ensureCacheDir();

    // Check cache first
    let audioBuffer = getCachedAudio(soundId);
    if (audioBuffer) {
        return {
            audio: audioBuffer.toString('base64'),
            mimeType: 'audio/mpeg',
            soundId,
            title: `Sound ${soundId}`, // Title not cached, just use ID
        };
    }

    // Fetch audio URL from the page
    const audioUrl = await fetchSoundPageUrl(soundId);
    if (!audioUrl) return null;

    // Download the audio
    audioBuffer = await downloadAudio(audioUrl);
    if (!audioBuffer || audioBuffer.length < 100) return null;

    // Cache it
    try {
        const cachePath = path.join(CACHE_DIR, `${soundId}.mp3`);
        fs.writeFileSync(cachePath, audioBuffer);
    } catch (err) {
        console.error('[Soundboard] Cache write error:', err.message);
    }

    // Try to get title (non-blocking — we already have the audio)
    let title = `Sound ${soundId}`;

    return {
        audio: audioBuffer.toString('base64'),
        mimeType: 'audio/mpeg',
        soundId,
        title,
    };
}

/**
 * Is the soundboard feature enabled?
 */
function isEnabled() {
    return db.getSetting('soundboard_enabled') !== false;
}

/**
 * Clean up expired cache files (call on startup or periodically)
 */
function cleanupCache() {
    ensureCacheDir();
    try {
        const files = fs.readdirSync(CACHE_DIR);
        const now = Date.now();
        for (const file of files) {
            const full = path.join(CACHE_DIR, file);
            try {
                const stat = fs.statSync(full);
                if (now - stat.mtimeMs > CACHE_TTL_MS) fs.unlinkSync(full);
            } catch { /* skip */ }
        }
    } catch { /* skip */ }
}

// Run cleanup on load
cleanupCache();

module.exports = {
    parseSoundboardMessage,
    getSoundboardAudio,
    isEnabled,
    cleanupCache,
    URL_REGEX,
    CMD_REGEX,
};
