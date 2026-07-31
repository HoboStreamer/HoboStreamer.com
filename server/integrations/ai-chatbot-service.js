/**
 * ai-chatbot-service.js — AI "fake viewers" that keep a stream's chat alive.
 *
 * Per streamer (opt-in, bring-your-own AI API key), spins up a small pool of
 * bot personas that periodically post short, in-character troll/argumentative
 * chat messages. If transcription is enabled, it periodically grabs a chunk of
 * the live audio, transcribes it, and feeds that as context so the bots react
 * to what's actually happening on stream.
 *
 * Modeled on chat-relay-service.js: singleton with startForStream / stopForStream
 * keyed by streamId, wired into the same lifecycle call sites.
 */
'use strict';
const fs = require('fs');
const db = require('../db/database');
const aiProvider = require('../ai/ai-provider');
const streamAudio = require('../ai/stream-audio');
const streamVision = require('../ai/stream-vision');
const ttsEngine = require('../chat/tts-engine');

const MAX_MSG_LEN = 200;
const TRANSCRIBE_INTERVAL_MS = 15000;   // capture cadence when transcription is on
const AUDIO_CHUNK_SECONDS = 13;
const VISION_INTERVAL_MS = 25000;       // screenshot cadence when vision is on
const MAX_CONSECUTIVE_ERRORS = 5;       // disable a worker after this many API failures
// Context freshness — old speech/screens decay so bots don't harp on a topic
// after the streamer has moved on.
const TRANSCRIPT_WINDOW_MS = 75000;     // only feed speech from the last ~75s
const TRANSCRIPT_MAX_CHARS = 900;       // hard cap on fed transcript
const VISION_STALE_MS = 65000;          // ignore a screenshot description older than this
const MENTION_COOLDOWN_MS = 9000;       // min gap between direct replies from the same bot
const DIRECTOR_MIN_GAP_MS = 11000;      // throttle for the "is the streamer engaging chat?" call
const HYPE_BURST_COOLDOWN_MS = 16000;   // min gap between reaction bursts
const VIEWER_REPLY_COOLDOWN_MS = 9000;  // min gap between bots replying to viewer chat
const PERSONALITY_EVOLVE_MS = 140000;   // how often each bot's personality note updates
const LIVENESS_CHECK_MS = 12000;        // each worker self-checks the stream is still live
const ORPHAN_SWEEP_MS = 30000;          // service-wide sweep to kill workers for dead streams
const LIVE_CACHE_MS = 4000;             // cache is_live lookups briefly

// Distinct bot characters so a pool of N feels like different people.
// Kept grounded: they REACT to the real stream — they don't invent fake people
// or lore to obsess over.
const BOT_CHARACTERS = [
    'a condescending contrarian who disagrees with whatever the streamer just said or did',
    'an over-the-top hype troll who ironically overreacts to what\'s happening on screen',
    'a doomer who keeps saying the stream/gameplay is dead or mid',
    'a smug backseater who insists they\'d do what\'s on screen better',
    'a chaotic shitposter who riffs on whatever the streamer is doing right now',
    'a concern troll who gives fake-helpful bad advice about what the streamer is doing',
    'a hard-to-impress viewer who says they\'ve seen better, reacting to THIS stream',
    'a deadpan skeptic who doubts what the streamer is saying or doing',
    'a drama-starter who twists the streamer\'s words to bait a reaction',
    'a lowkey supporter who hypes the streamer up but still sneaks in a jab',
];

// Stopwords for detecting a topic that chat has beaten to death.
const TOPIC_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'this', 'that', 'it', 'its', 'you', 'your', 'im', 'i', 'to', 'of', 'in', 'on', 'for', 'with', 'so', 'no', 'yes', 'not', 'lol', 'lmao', 'lmfao', 'bro', 'bruh', 'just', 'like', 'what', 'why', 'how', 'who', 'when', 'prob', 'probably', 'fr', 'ngl', 'ong', 'about', 'they', 'them', 'his', 'her', 'she', 'he', 'we', 'us', 'my', 'me', 'be', 'got', 'get', 'up', 'out', 'if', 'all', 'even', 'gonna', 'wanna', 'yeah', 'nah', 'ok', 'okay', 'stream', 'chat', 'guys', 'yall', 'dont', 'cant', 'thats', 'idk', 'tbh', 'actually', 'literally', 'still', 'now', 'here', 'there', 'some', 'any', 'one', 'do', 'does', 'did', 'can', 'will']);

const NAME_ADJ = ['xX', 'lil', 'big', 'the', 'dark', 'toxic', 'based', 'grim', 'mad', 'sneaky', 'silent', 'lazy', 'salty', 'epic', 'raw'];
const NAME_NOUN = ['gamer', 'goblin', 'wizard', 'shark', 'ninja', 'raptor', 'trucker', 'wolf', 'ghost', 'baron', 'hobo', 'yapper', 'menace', 'clown', 'oracle'];
const NAME_SUFFIX = ['', '', '69', '420', '_tv', 'XD', '99', '_ttv', '2k', '_irl', '88', 'xd'];
const COLORS = ['#e06c75', '#98c379', '#61afef', '#c678dd', '#e5c07b', '#56b6c2', '#d19a66', '#ff7ac6', '#7dd3fc', '#f6c177', '#9ece6a', '#bb9af7'];

// How each bot TYPES — a persistent quirk so each one has a recognizable voice.
const TYPING_STYLES = [
    'types in all lowercase, no punctuation, super casual',
    'GOES ALL CAPS when hyped, otherwise short',
    'spams emotes and 1-2 word reactions, barely uses full sentences',
    'dry deadpan one-liners, never more than a few words',
    'overuses "lol" "lmao" "bruh" and trails off with ...',
    'zoomer slang: "fr" "ngl" "ong" "lowkey" "it\'s giving" "cooked"',
    'the "erm actually" corrector, smug and nitpicky but brief',
    'hypebeast, spams "W" "L" "LETS GOOO" "no shot"',
    'types fast with typos and no caps, run-on but short',
    'ironic and detached, quotes the streamer back at them',
];

// Common chat emotes that render on HoboStreamer (7TV/BTTV/FFZ globals) — bots
// sprinkle these in like real chat. Channel-specific emotes get added at runtime.
const COMMON_EMOTES = ['LUL', 'LULW', 'KEKW', 'OMEGALUL', 'Pog', 'PogChamp', 'Sadge', 'Copium', 'EZ', 'Clap', 'monkaS', 'PepeLaugh', 'catJAM', 'peepoHappy', 'WeirdChamp', 'Pepega', '5Head', 'Bruh', 'FeelsBadMan', 'Prayge', 'Aware', 'ratJAM', 'D:', 'yikes', 'GIGACHAD'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rint(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function makeUsername() {
    // Mixed styles: gamertag, or plain lowercase anon-ish handle.
    // Returns { username, words } where words are the real component words used
    // to build it — used later to detect when the streamer says the name aloud
    // (Whisper mangles concatenated gamertags, but hears the underlying words).
    if (Math.random() < 0.25) {
        const num = rint(10, 990);
        return { username: `anon${num}`, words: ['anon', String(num)] };
    }
    const cap = Math.random() < 0.5;
    const adj = pick(NAME_ADJ), noun = pick(NAME_NOUN);
    const dispAdj = cap ? adj.charAt(0).toUpperCase() + adj.slice(1) : adj;
    const dispNoun = cap ? noun.charAt(0).toUpperCase() + noun.slice(1) : noun;
    return { username: `${dispAdj}${dispNoun}${pick(NAME_SUFFIX)}`, words: [adj, noun] };
}

class AiChatbotService {
    constructor() {
        /** @type {Map<number, object>} streamId → worker */
        this.workers = new Map();
        /** @type {Map<number, {isLive:boolean, ts:number}>} short is_live cache */
        this._liveCache = new Map();
        // Service-wide safety net: kill any worker whose stream is no longer live,
        // no matter which teardown path (or none) fired. Prevents bots from
        // posting to an offline channel forever.
        this._sweepTimer = setInterval(() => this._sweepOrphans(), ORPHAN_SWEEP_MS);
        if (this._sweepTimer.unref) this._sweepTimer.unref();
    }

    _sweepOrphans() {
        for (const [id, w] of [...this.workers]) {
            try {
                const s = db.getStreamById(id);
                if (!s || !s.is_live) {
                    console.log(`[AI-Bots] Sweep: stream ${id} is offline — stopping orphaned bots`);
                    this.stopForStream(id);
                }
            } catch { /* ignore */ }
        }
    }

    /** Is this worker's stream still live? Briefly cached to avoid hammering the DB. */
    _isLive(streamId) {
        const cached = this._liveCache.get(streamId);
        const now = Date.now();
        if (cached && (now - cached.ts) < LIVE_CACHE_MS) return cached.isLive;
        let isLive = false;
        let row = null;
        try { row = db.getStreamById(streamId); isLive = !!(row && row.is_live); } catch { isLive = false; }
        this._liveCache.set(streamId, { isLive, ts: now, row });
        return isLive;
    }

    /** Stop the worker if its stream has gone offline. Returns true if stopped.
     * Always reads fresh (this is the safety gate that must never post to a dead stream). */
    _stopIfOffline(worker) {
        if (worker.stopped) return true;
        this._liveCache.delete(worker.streamId);
        if (!this._isLive(worker.streamId)) {
            this.stopForStream(worker.streamId);
            return true;
        }
        return false;
    }

    _buildBots(count) {
        const chars = [...BOT_CHARACTERS].sort(() => Math.random() - 0.5);
        const styles = [...TYPING_STYLES].sort(() => Math.random() - 0.5);
        const bots = [];
        const usedNames = new Set();
        const usedVoices = new Set(); // base-voice variants already taken, so the pool sounds distinct
        const usedNouns = new Set();  // so each bot is uniquely addressable by name-word
        for (let i = 0; i < count; i++) {
            let gen = makeUsername();
            let guard = 0;
            // Regenerate to avoid duplicate names, duplicate addressable name-words,
            // AND (where possible) duplicate base TTS voices.
            while (guard++ < 30) {
                const lname = gen.username.toLowerCase();
                const noun = (gen.words[gen.words.length - 1] || '').toLowerCase();
                if (usedNames.has(lname)) { gen = makeUsername(); continue; }
                if (noun && usedNouns.has(noun) && usedNouns.size < NAME_NOUN.length) { gen = makeUsername(); continue; }
                let voice;
                try { voice = ttsEngine.deriveUserVoiceParams(this._voiceKey(gen.username)).voice; } catch { voice = null; }
                if (voice && usedVoices.has(voice) && usedVoices.size < 13) { gen = makeUsername(); continue; }
                if (voice) usedVoices.add(voice);
                if (noun) usedNouns.add(noun);
                break;
            }
            usedNames.add(gen.username.toLowerCase());
            bots.push({
                username: gen.username,
                color: pick(COLORS),
                character: chars[i % chars.length],
                style: styles[i % styles.length],   // persistent typing quirk
                arc: '',                            // evolving personality note (grows over the stream)
                ownLines: [],                       // this bot's own recent messages (self-consistency)
                // Distinctive words (len>=4) the streamer might say to address this
                // bot. Anon-style handles aren't voice-addressable (bare "anon" is
                // ambiguous), so leave their matchWords empty.
                matchWords: (gen.words[0] === 'anon')
                    ? []
                    : (gen.words || []).map((w) => String(w).toLowerCase()).filter((w) => w.length >= 4),
            });
        }
        return bots;
    }

    /**
     * Detect which bots the streamer just addressed by name in a transcript
     * snippet. Whisper won't reproduce "BasedMenace69", but it will hear the
     * underlying words ("based", "menace"), so match on those. Returns an array
     * of bots (usually 0 or 1).
     */
    _detectAddressedBots(worker, text) {
        const norm = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
        if (norm.length < 3) return [];
        const hits = [];
        for (const bot of worker.bots) {
            const words = bot.matchWords || [];
            if (!words.length) continue;
            // The distinctive noun (2nd word) alone is enough; for the adjective
            // require the noun too (adjectives like "big"/"the" are too common).
            const noun = words[words.length - 1];
            if (noun && norm.includes(` ${noun} `)) { hits.push(bot); continue; }
            // Full de-camelCased name spoken ("based menace")
            if (words.length >= 2 && norm.includes(` ${words.join(' ')} `)) hits.push(bot);
        }
        return hits;
    }

    /** Stable identity string used to derive a bot's TTS voice. */
    _voiceKey(username) { return `aibot:${String(username).toLowerCase()}`; }

    /** Emote codes the bots can use — this channel's custom emotes first, then commons. */
    _loadEmotes(userId) {
        const codes = [];
        try { for (const e of db.getChannelEmotes(userId)) if (e.code) codes.push(e.code); } catch { /* ignore */ }
        try { for (const e of db.getGlobalEmotes()) if (e.code) codes.push(e.code); } catch { /* ignore */ }
        return [...new Set([...codes.slice(0, 14), ...COMMON_EMOTES])].slice(0, 30);
    }

    async startForStream(stream) {
        try {
            if (!stream || !stream.id || !stream.user_id) return;
            if (this.workers.has(stream.id)) return;

            const config = db.getAiChatbotConfig(stream.user_id);
            if (!config || !config.enabled || !String(config.api_token || '').trim()) return;

            const numBots = Math.min(12, Math.max(1, config.num_bots || 3));
            const worker = {
                streamId: stream.id,
                userId: stream.user_id,
                stream,
                config,
                bots: this._buildBots(numBots),
                emotes: this._loadEmotes(stream.user_id),
                transcriptChunks: [],   // [{ text, ts }] — decays over time
                visual: null,           // { text, ts }
                recentBotLines: [],
                replyQueue: [],          // [{ bot, text, ts, mode }] — reactive replies to speech
                replyCooldown: new Map(), // bot.username → last reactive-reply ts
                lastSpeechSig: '',       // dedupe repeated detection of the same sentence
                lastDirectorAt: 0,       // throttle the director call
                lastBurstAt: 0,          // throttle hype reaction bursts
                lastViewerReplyAt: 0,    // throttle replies to non-streamer viewers
                lastRealInput: null,     // { username, text, isStreamer, ts }
                lastActiveBot: null,     // username of the bot that most recently posted
                errorCount: 0,
                stopped: false,
                postTimer: null,
                transcribeTimer: null,
                visionTimer: null,
                livenessTimer: null,
                personalityTimer: null,
                capturing: false,
                describing: false,
                generating: false,
                directing: false,
                evolving: false,
            };
            this.workers.set(stream.id, worker);
            console.log(`[AI-Bots] Started for stream ${stream.id} (${numBots} bots, transcription=${config.transcribe_enabled ? 'on' : 'off'}, vision=${config.vision_enabled ? 'on' : 'off'})`);

            // First posts staggered so they don't all fire at once
            this._scheduleNextPost(worker, rint(6000, 16000));

            if (config.transcribe_enabled) {
                worker.transcribeTimer = setInterval(() => this._captureAndTranscribe(worker), TRANSCRIBE_INTERVAL_MS);
                setTimeout(() => this._captureAndTranscribe(worker), 3000);
            }
            if (config.vision_enabled) {
                worker.visionTimer = setInterval(() => this._captureAndDescribe(worker), VISION_INTERVAL_MS);
                setTimeout(() => this._captureAndDescribe(worker), 5000);
            }
            // Self-terminate if the stream goes offline (belt-and-suspenders vs the
            // external stop paths) and refresh the stream row for fresh context.
            worker.livenessTimer = setInterval(() => this._checkLiveness(worker), LIVENESS_CHECK_MS);
            // Personalities evolve over the stream.
            worker.personalityTimer = setInterval(() => this._evolvePersonalities(worker), PERSONALITY_EVOLVE_MS);
        } catch (err) {
            console.error('[AI-Bots] startForStream error:', err.message);
        }
    }

    _checkLiveness(worker) {
        if (worker.stopped) return;
        this._liveCache.delete(worker.streamId); // force a fresh DB read
        let row = null;
        try { row = db.getStreamById(worker.streamId); } catch { /* ignore */ }
        if (!row || !row.is_live) {
            console.log(`[AI-Bots] stream ${worker.streamId} no longer live — stopping bots`);
            this.stopForStream(worker.streamId);
            return;
        }
        worker.stream = row; // keep title/category/viewer_count current
    }

    stopForStream(streamId) {
        const worker = this.workers.get(streamId);
        if (!worker) return;
        worker.stopped = true;
        if (worker.postTimer) clearTimeout(worker.postTimer);
        if (worker.transcribeTimer) clearInterval(worker.transcribeTimer);
        if (worker.visionTimer) clearInterval(worker.visionTimer);
        if (worker.livenessTimer) clearInterval(worker.livenessTimer);
        if (worker.personalityTimer) clearInterval(worker.personalityTimer);
        this.workers.delete(streamId);
        this._liveCache.delete(streamId);
        console.log(`[AI-Bots] Stopped for stream ${streamId}`);
    }

    stopForUser(userId) {
        for (const [id, w] of this.workers) {
            if (w.userId === userId) this.stopForStream(id);
        }
    }

    /**
     * Called when a streamer saves/changes config. Starts, restarts, or stops
     * bots for ALL of the user's currently-live streams to match the new config
     * (so enabling bots mid-stream starts them without a server restart).
     */
    applyConfigForUser(userId) {
        let liveStreams = [];
        try { liveStreams = db.getLiveStreamsByUserId(userId) || []; } catch { liveStreams = []; }
        const config = db.getAiChatbotConfig(userId);
        const wantEnabled = !!(config && config.enabled && String(config.api_token || '').trim());
        for (const stream of liveStreams) {
            const running = this.workers.has(stream.id);
            if (wantEnabled) {
                // Restart to pick up new settings (bot count, persona, interval, transcription)
                if (running) this.stopForStream(stream.id);
                this.startForStream(stream);
            } else if (running) {
                this.stopForStream(stream.id);
            }
        }
    }

    /** Back-compat alias. */
    reloadForUser(userId) { this.applyConfigForUser(userId); }

    hasWorker(streamId) { return this.workers.has(streamId); }

    _scheduleNextPost(worker, delayMs) {
        if (worker.stopped) return;
        const base = (worker.config.post_interval_seconds || 45) * 1000;
        // Divide the base cadence across the pool so total chatter ≈ base per bot,
        // then jitter ±40% so it feels organic.
        const perTick = Math.max(6000, base / Math.max(1, worker.bots.length));
        const jittered = delayMs != null ? delayMs : Math.round(perTick * (0.6 + Math.random() * 0.8));
        worker.postTimer = setTimeout(() => this._tick(worker), jittered);
    }

    async _tick(worker) {
        if (worker.stopped) return;
        if (this._stopIfOffline(worker)) return;   // stream ended — don't post to a dead channel
        // Let real conversation take priority — if a reply is pending or the
        // streamer just gave input, skip this ambient filler post.
        const sinceInput = Date.now() - (worker.lastRealInput?.ts || 0);
        if (worker.replyQueue.length || sinceInput < 6000) {
            this._scheduleNextPost(worker);
            return;
        }
        try {
            // Prefer a bot that hasn't spoken most recently, so it's not always the same voice.
            const candidates = worker.bots.filter((b) => b.username !== worker.lastActiveBot);
            const bot = pick(candidates.length ? candidates : worker.bots);
            await this._generateAndPost(worker, bot);
        } catch (err) {
            worker.errorCount++;
            console.warn(`[AI-Bots] generate error (stream ${worker.streamId}, ${worker.errorCount}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);
            if (worker.errorCount >= MAX_CONSECUTIVE_ERRORS) {
                console.warn(`[AI-Bots] Disabling stream ${worker.streamId} after repeated errors.`);
                this.stopForStream(worker.streamId);
                return;
            }
        }
        this._scheduleNextPost(worker);
    }

    _recentChatLines(streamId, limit = 15) {
        try {
            const rows = db.all(
                `SELECT username, message FROM chat_messages
                 WHERE stream_id = ? AND is_deleted = 0 AND message_type = 'chat'
                 ORDER BY id DESC LIMIT ?`,
                [streamId, limit]
            );
            return rows.reverse().map((r) => `${r.username}: ${r.message}`);
        } catch { return []; }
    }

    /** Pick a length + occasional intent for an ambient message, biased to SHORT. */
    _pickBeat() {
        const r = Math.random();
        let len;
        if (r < 0.5) len = 'VERY short — 1 to 4 words, a quick reaction (e.g. "lol", "no shot", "he\'s cooked", "clip that", "actual W", "nah"). It can be just an emote.';
        else if (r < 0.8) len = 'short — under 10 words, one casual line';
        else if (r < 0.95) len = 'a normal chat message, under 18 words';
        else len = 'a slightly longer take, under 30 words but still casual chat';
        let intent = '';
        const ir = Math.random();
        if (ir < 0.22) intent = 'reply to or clown on something another chatter just said (see recent chat), not the streamer';
        else if (ir < 0.32) intent = 'ask the streamer or chat a dumb or loaded question';
        else if (ir < 0.40) intent = 'pick a petty fight with another viewer in chat';
        return { len, intent };
    }

    _buildMessages(worker, bot, opts = {}) {
        const s = worker.stream;
        const title = s.title || 'Untitled Stream';
        const category = s.category || 'IRL';
        const streamer = s.display_name || s.username || 'the streamer';
        const persona = String(worker.config.persona || '').trim();
        let tags = [];
        try { tags = Array.isArray(s.tags) ? s.tags : JSON.parse(s.tags || '[]'); } catch { tags = []; }

        const visual = this._currentVisual(worker);
        const transcript = this._currentTranscript(worker);

        const addressed = opts && opts.addressedText ? String(opts.addressedText).trim() : '';
        const direct = addressed && opts.direct;   // streamer literally said this bot's name
        const fromStreamer = !!opts.fromStreamer;
        const fromViewer = opts.fromViewer || null;
        const channel = opts.channel || 'mic';      // 'mic' | 'chat'

        // Length/intent "beat" — real chat is mostly ultra-short; vary it hard.
        const beat = opts.beat || (addressed
            ? { len: (Math.random() < 0.65 ? 'VERY short, 1-6 words' : 'short, under 14 words'), intent: '' }
            : this._pickBeat());

        // A rotating handful of real emotes this bot can sprinkle in.
        const emoteSample = [...(worker.emotes || [])].sort(() => Math.random() - 0.5).slice(0, 10);
        const dead = this._dominantTopics(worker);

        // Who/what this reply is answering (so the bot actually engages it).
        let replyInstruction = '';
        if (direct) {
            replyInstruction = `${streamer} (the STREAMER) just said YOUR name and is talking to YOU. Answer/react to exactly what they said.`;
        } else if (fromStreamer) {
            replyInstruction = `The STREAMER just ${channel === 'chat' ? 'typed this in chat' : 'said this on mic'} to chat${opts.answering ? ' — they asked/addressed chat' : ''}. REPLY to what THEY actually said — answer their question or engage their point directly. This matters more than any running chat bit.`;
        } else if (fromViewer) {
            replyInstruction = `Another viewer "${fromViewer}" just ${channel === 'chat' ? 'typed this in chat' : 'said this'}. React to or clap back at THEM specifically.`;
        }

        const system = [
            `You are "${bot.username}", ONE real-feeling viewer in ${streamer}'s live Twitch-style chat. You're watching the stream right now.`,
            `Your personality: ${bot.character}.`,
            `How you type: ${bot.style}. Keep this voice consistent.`,
            bot.arc ? `Your vibe so far this stream (stay consistent, let it grow): ${bot.arc}` : '',
            persona ? `The streamer wants viewers like you to lean into this: ${persona}` : '',
            replyInstruction || `Post a spontaneous chat message reacting to what's happening on stream RIGHT NOW.`,
            `LENGTH: make this ${beat.len}. Real chat is mostly tiny reactions — do NOT write a neat full sentence every time. No proper caps/punctuation unless your style calls for it.`,
            beat.intent && !addressed ? `THIS MESSAGE: ${beat.intent}` : '',
            emoteSample.length ? `You may use these chat emotes when they fit (a message can be JUST an emote): ${emoteSample.join(' ')}. Don't force them.` : '',
            `GROUND YOURSELF IN REALITY: react to the actual streamer, the real screen, and real viewers. Do NOT invent fake people, fake backstories, or a running meme and obsess over it. If chat started a dumb bit, don't beat it into the ground.`,
            dead.length ? `Chat has BEATEN THESE TO DEATH — do NOT mention them again, move on: ${dead.join(', ')}.` : '',
            `You are WATCHING — react like a viewer, never describe the screen or say "the screen shows".`,
            `PG-13: no slurs, hate, real threats, nothing sexual about real people, no doxxing. Trolling/arguing/roasting is fine.`,
            `Output ONLY the raw chat message text — no quotes, no name prefix, no explanation.`,
        ].filter(Boolean).join('\n');

        const contextParts = [];
        if (addressed) {
            const label = direct ? `${streamer} (STREAMER) → YOU`
                : fromStreamer ? `${streamer} (STREAMER)${channel === 'chat' ? ' typed' : ' on mic'}`
                : `viewer ${fromViewer || ''}`.trim();
            contextParts.push(`>>> REPLY TO THIS — ${label}: "${addressed}"`);
        }
        // Freshest signal.
        if (visual) {
            contextParts.push(`HAPPENING ON STREAM NOW (you can see it): ${visual}\n(React like a viewer — don't describe it.)`);
        }
        if (transcript) {
            contextParts.push(`STREAMER'S MIC lately (auto-transcribed, may be misheard — react to the gist, don't quote it): "${transcript}"`);
        }
        if (!visual && !transcript && !addressed) {
            contextParts.push(`(No live audio/screen right now — go off the recent chat and the category.)`);
        }
        contextParts.push(`(context) ${streamer} is streaming "${title}" — ${category}${tags.length ? ` [${tags.join(', ')}]` : ''}${s.viewer_count != null ? `, ${s.viewer_count} watching` : ''}. Don't keep commenting on the title.`);
        const recent = this._recentChatLines(worker.streamId, 12);
        if (recent.length) {
            contextParts.push(`RECENT CHAT (newest last — play off it, don't copy it, and don't dogpile one topic):\n${recent.join('\n')}`);
        } else {
            contextParts.push(`RECENT CHAT: dead silent — get something going off what's on stream.`);
        }
        if (bot.ownLines && bot.ownLines.length) {
            contextParts.push(`(your own recent lines — stay consistent but don't repeat them: ${bot.ownLines.slice(-4).join(' | ')})`);
        }
        contextParts.push(addressed
            ? `Now type ${bot.username}'s reply:`
            : `Now type ${bot.username}'s message:`);

        return [
            { role: 'system', content: system },
            { role: 'user', content: contextParts.join('\n\n') },
        ];
    }

    /** Speech from the last TRANSCRIPT_WINDOW_MS, joined newest-last, length-capped. */
    _currentTranscript(worker) {
        const cutoff = Date.now() - TRANSCRIPT_WINDOW_MS;
        const chunks = (worker.transcriptChunks || []).filter((c) => c.ts >= cutoff);
        if (!chunks.length) return '';
        let joined = chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
        if (joined.length > TRANSCRIPT_MAX_CHARS) joined = joined.slice(-TRANSCRIPT_MAX_CHARS);
        return joined;
    }

    /** Latest screenshot description, only if fresh enough. */
    _currentVisual(worker) {
        const v = worker.visual;
        if (v && v.text && (Date.now() - v.ts) <= VISION_STALE_MS) return v.text;
        return '';
    }

    /**
     * Entry point when the streamer says something (fresh transcript). Decides
     * whether — and which — bot should reply, so it feels like a real back-and-forth:
     *  1) If the streamer said a bot's name → that bot replies directly (fast path).
     *  2) Otherwise ask a cheap "director" if the streamer is engaging chat/reacting
     *     to a viewer, and if so have the right bot reply. This is what makes the
     *     bots respond when you talk back to them without naming anyone.
     */
    _onFreshSpeech(worker, text) {
        if (worker.stopped) return;
        const sig = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(-140);
        if (sig && sig === worker.lastSpeechSig) return;
        worker.lastSpeechSig = sig;
        worker.lastRealInput = { username: worker.stream.display_name || worker.stream.username || 'streamer', text: String(text).slice(-300), isStreamer: true, ts: Date.now() };

        // 1) Direct name callout → highest priority.
        const named = this._detectAddressedBots(worker, text);
        if (named.length) {
            let queued = 0;
            for (const bot of named) {
                if (this._queueReply(worker, bot, text, { direct: true, fromStreamer: true, channel: 'mic' })) queued++;
            }
            if (queued) {
                console.log(`[AI-Bots] stream ${worker.streamId}: streamer named ${named.map((b) => b.username).join(', ')} — direct reply`);
                setTimeout(() => this._flushReplies(worker), rint(900, 2400));
            }
            return;
        }

        // 2) Streamer asked chat something / is clearly addressing chat → a bot ANSWERS it.
        //    This is the "streamer says 'who is max' and a viewer actually replies" case.
        if (this._looksDirectedAtChat(text)) {
            const bot = this._pickResponder(worker);
            if (this._queueReply(worker, bot, text, { fromStreamer: true, channel: 'mic', answering: true })) {
                console.log(`[AI-Bots] stream ${worker.streamId}: streamer addressing chat — ${bot.username} answers`);
                setTimeout(() => this._flushReplies(worker), rint(900, 2400));
            }
            return;
        }

        // 3) Streamer sounds hyped/reacting → spike chat with a quick burst.
        if (this._looksHype(text) && (Date.now() - worker.lastBurstAt) > HYPE_BURST_COOLDOWN_MS) {
            console.log(`[AI-Bots] stream ${worker.streamId}: hype moment — reaction burst`);
            this._hypeBurst(worker);
            return;
        }

        // 4) Otherwise let the director decide if it's worth engaging.
        const cleaned = String(text).trim();
        if (cleaned.length < 12) return;
        this._maybeDirect(worker, cleaned);
    }

    /** Heuristic: is the streamer talking TO chat / asking a question (vs narrating)? */
    _looksDirectedAtChat(text) {
        const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9'? ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
        if (t.includes('?')) return true;
        return /( who is | what is | whats | what's | wheres | where's | you guys | y'?all | anyone | does anyone | do you | what do you | how do you | should i | you think | you think\? | right\? | am i | are we | chat | vote | tell me | explain | which one | wdyt | thoughts | chat what )/.test(t);
    }

    /** Pick a bot to respond — prefer one that isn't the one who just spoke. */
    _pickResponder(worker) {
        const candidates = worker.bots.filter((b) => b.username !== worker.lastActiveBot);
        return pick(candidates.length ? candidates : worker.bots);
    }

    /** A real human typed in chat — react like real chat would (esp. to the streamer). */
    onRealChatMessage(streamId, { username, message, userId }) {
        const worker = this.workers.get(streamId);
        if (!worker || worker.stopped) return;
        const text = String(message || '').trim();
        if (!text) return;
        // Ignore our own bots (safety — they shouldn't reach this path anyway).
        const uname = String(username || '').toLowerCase();
        if (worker.bots.some((b) => b.username.toLowerCase() === uname)) return;

        const isStreamer = !!(userId && userId === worker.userId);
        worker.lastRealInput = { username, text: text.slice(-300), isStreamer, ts: Date.now() };

        if (isStreamer) {
            // The streamer typed — always engage them, promptly, and interrupt filler.
            const named = this._detectAddressedBots(worker, text);
            const bot = named[0] || this._pickResponder(worker);
            if (this._queueReply(worker, bot, text, { fromStreamer: true, channel: 'chat', direct: !!named[0], answering: this._looksDirectedAtChat(text) })) {
                console.log(`[AI-Bots] stream ${streamId}: streamer typed — ${bot.username} replies`);
                setTimeout(() => this._flushReplies(worker), rint(900, 2600));
            }
            return;
        }

        // A regular viewer typed — reply sometimes (more often if it's a question or
        // aimed at chat), throttled so bots don't dogpile every message.
        const now = Date.now();
        if (now - worker.lastViewerReplyAt < VIEWER_REPLY_COOLDOWN_MS) return;
        const engaging = this._looksDirectedAtChat(text) || text.length > 40;
        const chance = engaging ? 0.7 : 0.28;
        if (Math.random() > chance) return;
        worker.lastViewerReplyAt = now;
        const named = this._detectAddressedBots(worker, text);
        const bot = named[0] || this._pickResponder(worker);
        if (this._queueReply(worker, bot, text, { fromViewer: username, channel: 'chat', direct: !!named[0] })) {
            setTimeout(() => this._flushReplies(worker), rint(1400, 4200));
        }
    }

    /** Words chat has beaten to death (appear across many recent lines) — bots are told to drop them. */
    _dominantTopics(worker) {
        const lines = [];
        for (const l of (worker.recentBotLines || [])) lines.push(String(l).replace(/^[^:]+:\s*/, ''));
        try { for (const r of this._recentChatLines(worker.streamId, 10)) lines.push(String(r).replace(/^[^:]+:\s*/, '')); } catch { /* ignore */ }
        if (lines.length < 4) return [];
        const docCount = new Map();
        for (const line of lines) {
            const seen = new Set();
            for (const w of String(line).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/)) {
                const word = w.replace(/'/g, '');
                if (word.length < 3 || TOPIC_STOPWORDS.has(word) || seen.has(word)) continue;
                seen.add(word);
                docCount.set(word, (docCount.get(word) || 0) + 1);
            }
        }
        const threshold = Math.max(3, Math.ceil(lines.length * 0.35));
        return [...docCount.entries()].filter(([, c]) => c >= threshold).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
    }

    /** Heuristic: does the streamer's speech sound like an exciting/reacting moment? */
    _looksHype(text) {
        const raw = String(text || '');
        const t = ' ' + raw.toLowerCase() + ' ';
        let score = 0;
        const excl = (raw.match(/!/g) || []).length;
        if (excl >= 2) score += 2; else if (excl === 1) score += 1;
        const capsWords = (raw.match(/\b[A-Z]{3,}\b/g) || []).length;
        score += Math.min(2, capsWords);
        if (/(haha|hehe|lmao|lmfao|jaja|\blol\b)/.test(t)) score += 1;
        if (/( no way | no shot | oh my | let'?s go | lets go | what the | holy | oh no | oh god | gg | clutch | insane | are you serious | wait what | he'?s cooked | actual | bruh | dude | yooo| woah | whoa )/.test(t)) score += 1;
        return score >= 2;
    }

    async _maybeDirect(worker, text) {
        if (worker.stopped || worker.directing) return;
        const now = Date.now();
        if (now - worker.lastDirectorAt < DIRECTOR_MIN_GAP_MS) return;
        worker.lastDirectorAt = now;
        worker.directing = true;
        try {
            const decision = await this._directorDecide(worker, text);
            if (!decision || !decision.engage) return;
            let bot = worker.bots.find((b) => b.username.toLowerCase() === String(decision.username || '').toLowerCase());
            if (!bot) {
                // Director wants a reply but didn't pick a valid bot → prefer the last
                // active bot (continues that thread), else a random one.
                bot = worker.bots.find((b) => b.username === worker.lastActiveBot) || pick(worker.bots);
            }
            if (this._queueReply(worker, bot, text, { fromStreamer: true, channel: 'mic' })) {
                console.log(`[AI-Bots] stream ${worker.streamId}: streamer engaging chat (${decision.why || ''}) — ${bot.username} replies`);
                setTimeout(() => this._flushReplies(worker), rint(1200, 3200));
            }
        } catch (err) {
            console.warn(`[AI-Bots] director failed (stream ${worker.streamId}):`, err.message);
        } finally {
            worker.directing = false;
        }
    }

    /** Ask the model whether the streamer is engaging chat and who should reply. */
    async _directorDecide(worker, speech) {
        const recent = this._recentChatLines(worker.streamId, 8);
        const names = worker.bots.map((b) => b.username).join(', ');
        const sys = 'You direct fake troll "viewers" in a livestream chat. Decide if one should reply to the streamer RIGHT NOW. Only engage when the streamer is talking TO chat, answering/reacting to a viewer, asking chat something, or clearly playing off chat — NOT when just narrating gameplay or talking to themselves. Reply with ONLY compact JSON.';
        const user = [
            `Streamer "${worker.stream.display_name || worker.stream.username || 'streamer'}" just said out loud (transcribed, may be rough): "${String(speech).slice(-400)}"`,
            recent.length ? `Recent chat (newest last):\n${recent.join('\n')}` : 'Chat is quiet.',
            `Fake viewers who could reply: ${names}`,
            `JSON: {"engage": true|false, "username": "<viewer who should reply — prefer whoever the streamer is reacting to; else empty>", "why": "<=6 words"}`,
        ].join('\n\n');
        const raw = await aiProvider.chatCompletion({
            baseUrl: worker.config.base_url,
            apiKey: worker.config.api_token,
            model: worker.config.model,
            temperature: 0.2,
            maxTokens: 60,
            messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        });
        return this._parseDirectorJson(raw);
    }

    _parseDirectorJson(raw) {
        if (!raw) return null;
        let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        const m = s.match(/\{[\s\S]*\}/);
        if (m) s = m[0];
        try {
            const o = JSON.parse(s);
            return { engage: !!o.engage, username: String(o.username || '').trim(), why: String(o.why || '').slice(0, 40) };
        } catch { return null; }
    }

    /** Queue a reactive reply from a bot (respecting per-bot cooldown + dedupe). */
    _queueReply(worker, bot, text, meta = {}) {
        if (!bot) return false;
        const now = Date.now();
        const last = worker.replyCooldown.get(bot.username) || 0;
        if (now - last < MENTION_COOLDOWN_MS) return false;
        if (worker.replyQueue.some((m) => m.bot.username === bot.username)) return false;
        worker.replyCooldown.set(bot.username, now);
        worker.replyQueue.push({ bot, text: String(text).slice(-300), ts: now, meta });
        return true;
    }

    async _flushReplies(worker, attempt = 0) {
        if (worker.stopped || !this.workers.has(worker.streamId)) return;
        if (this._stopIfOffline(worker)) return;
        if (!worker.replyQueue.length) return;
        if (worker.generating) {
            if (attempt < 6) setTimeout(() => this._flushReplies(worker, attempt + 1), 1400);
            return;
        }
        const item = worker.replyQueue.shift();
        if (!item) return;
        const m = item.meta || {};
        try {
            await this._generateAndPost(worker, item.bot, {
                addressedText: item.text,
                direct: !!m.direct,
                fromStreamer: !!m.fromStreamer,
                fromViewer: m.fromViewer || null,
                channel: m.channel || 'mic',
                answering: !!m.answering,
            });
        } catch (err) {
            console.warn(`[AI-Bots] reactive reply failed (stream ${worker.streamId}):`, err.message);
        }
        if (worker.replyQueue.length) setTimeout(() => this._flushReplies(worker), rint(1500, 4000));
    }

    _sanitizeMessage(text) {
        let t = String(text || '').replace(/\s+/g, ' ').trim();
        // Strip wrapping quotes, then a leading "name:" the model may have added,
        // then wrapping quotes again (order-independent cleanup).
        t = t.replace(/^["'“”]+|["'“”]+$/g, '').trim();
        t = t.replace(/^[a-z0-9_]{2,20}:\s*/i, '').trim();
        t = t.replace(/^["'“”]+|["'“”]+$/g, '').trim();
        if (t.length > MAX_MSG_LEN) t = t.slice(0, MAX_MSG_LEN).trim();
        return t;
    }

    async _generateAndPost(worker, bot, opts = {}) {
        if (worker.stopped || worker.generating) return;
        worker.generating = true;
        try { await this._generateOnce(worker, bot, opts); }
        finally { worker.generating = false; }
    }

    /** Generate + post one message. Does NOT touch the `generating` guard, so a
     * burst can drive several of these in quick sequence. */
    async _generateOnce(worker, bot, opts = {}) {
        if (worker.stopped) return;
        const messages = this._buildMessages(worker, bot, opts);
        const raw = await aiProvider.chatCompletion({
            baseUrl: worker.config.base_url,
            apiKey: worker.config.api_token,
            model: worker.config.model,
            messages,
            temperature: opts.addressedText ? 0.95 : 1.1,
            maxTokens: 60,
        });
        worker.errorCount = 0;
        const message = this._sanitizeMessage(raw);
        if (!message) return;
        if (worker.stopped || !this.workers.has(worker.streamId)) return;
        if (this._stopIfOffline(worker)) return; // stream ended mid-generation — don't post
        worker.recentBotLines.push(`${bot.username}: ${message}`);
        if (worker.recentBotLines.length > 12) worker.recentBotLines.shift();
        bot.ownLines = bot.ownLines || [];
        bot.ownLines.push(message);
        if (bot.ownLines.length > 8) bot.ownLines.shift();
        worker.lastActiveBot = bot.username;
        this._inject(worker, bot, message);
    }

    /**
     * Periodically update each bot's personality "arc" so viewers grow over the
     * stream — developing running bits, opinions, and a stance toward the streamer.
     * One cheap call updates the whole pool.
     */
    async _evolvePersonalities(worker) {
        if (worker.stopped || worker.evolving) return;
        // Only bother once bots have actually said things.
        const active = worker.bots.filter((b) => (b.ownLines || []).length >= 2);
        if (active.length < 1) return;
        if (this._stopIfOffline(worker)) return;
        worker.evolving = true;
        try {
            const streamer = worker.stream.display_name || worker.stream.username || 'the streamer';
            const roster = active.map((b) => `- ${b.username} (${b.character}${b.arc ? `; currently: ${b.arc}` : ''}): ${(b.ownLines || []).slice(-5).join(' | ')}`).join('\n');
            const sys = 'You track fake chat "viewers" in a livestream so each one grows a consistent, evolving personality over time (running bits, opinions, stance toward the streamer, in-jokes). Keep each note SHORT (<=14 words), grounded in what they actually said, and evolve it a bit. Reply ONLY with a compact JSON array.';
            const user = [
                `Streamer: ${streamer}. Category: ${worker.stream.category || 'IRL'}.`,
                `Viewers and their recent messages:\n${roster}`,
                `Return JSON: [{"username":"...","arc":"<short evolving personality/bit note>"}] for each viewer.`,
            ].join('\n\n');
            const raw = await aiProvider.chatCompletion({
                baseUrl: worker.config.base_url, apiKey: worker.config.api_token, model: worker.config.model,
                temperature: 0.7, maxTokens: 220,
                messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
            });
            const arr = this._parseArcJson(raw);
            if (Array.isArray(arr)) {
                for (const item of arr) {
                    const bot = worker.bots.find((b) => b.username.toLowerCase() === String(item.username || '').toLowerCase());
                    if (bot && item.arc) bot.arc = String(item.arc).slice(0, 160);
                }
                console.log(`[AI-Bots] stream ${worker.streamId}: personalities evolved`);
            }
        } catch (err) {
            console.warn(`[AI-Bots] personality evolve failed (stream ${worker.streamId}):`, err.message);
        } finally {
            worker.evolving = false;
        }
    }

    _parseArcJson(raw) {
        if (!raw) return null;
        let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        const m = s.match(/\[[\s\S]*\]/);
        if (m) s = m[0];
        try { const a = JSON.parse(s); return Array.isArray(a) ? a : null; } catch { return null; }
    }

    /**
     * A cluster of quick short reactions from a few different bots — mimics the
     * way real chat spikes when something notable/hype happens on stream.
     */
    async _hypeBurst(worker) {
        if (worker.stopped || worker.generating) return;
        worker.lastBurstAt = Date.now();
        worker.generating = true;
        try {
            const chosen = [...worker.bots].sort(() => Math.random() - 0.5).slice(0, rint(2, 3));
            for (const bot of chosen) {
                if (worker.stopped || this._stopIfOffline(worker)) break;
                try {
                    await this._generateOnce(worker, bot, {
                        beat: { len: 'VERY short, 1-4 words — a pure hype/spam reaction to what just happened (like "LMAOO", "NO WAY", "he cooked", "OMG", "clip it", "actual W")', intent: '' },
                    });
                } catch (err) {
                    worker.errorCount++;
                }
                await new Promise((r) => setTimeout(r, rint(500, 1500)));
            }
        } finally {
            worker.generating = false;
        }
    }

    _inject(worker, bot, message) {
        const streamId = worker.streamId;
        const chatMsg = {
            type: 'chat',
            username: bot.username,
            core_username: null,
            user_id: null,
            anon_id: bot.username.startsWith('anon') ? bot.username : null,
            role: bot.username.startsWith('anon') ? 'anon' : 'user',
            message,
            stream_id: streamId,
            is_global: false,
            avatar_url: null,
            profile_color: bot.color,
            filtered: false,
            timestamp: new Date().toISOString(),
        };
        try {
            const result = db.saveChatMessage({
                stream_id: streamId,
                user_id: null,
                anon_id: chatMsg.anon_id,
                username: bot.username,
                message,
                message_type: 'chat',
                is_global: false,
            });
            if (result?.lastInsertRowid) chatMsg.id = Number(result.lastInsertRowid);
        } catch { /* non-critical */ }

        try {
            const chatServer = require('../chat/chat-server');
            chatServer.broadcastToStream(streamId, chatMsg);
            chatServer.forwardToGlobal(streamId, chatMsg);
            // Give the bot a TTS voice like any viewer. No cosmetic voice → the
            // per-user derived voice keyed on the bot's stable voice id, so each
            // bot in the pool sounds distinct. Non-blocking; respects the global
            // TTS setting and each viewer's TTS toggle.
            chatServer.synthesizeAndBroadcastTTS(streamId, bot.username, message, null, null, this._voiceKey(bot.username));
        } catch (err) {
            console.warn('[AI-Bots] broadcast failed:', err.message);
        }
    }

    async _captureAndTranscribe(worker) {
        if (worker.stopped || worker.capturing) return;
        if (this._stopIfOffline(worker)) return;
        worker.capturing = true;
        let wavPath = null;
        try {
            wavPath = await streamAudio.captureAudioChunk(worker.stream, AUDIO_CHUNK_SECONDS);
            if (!wavPath) return;
            const text = await aiProvider.transcribe({
                baseUrl: worker.config.base_url,
                apiKey: worker.config.api_token,
                model: worker.config.transcribe_model || 'whisper-1',
                filePath: wavPath,
            });
            const clean = this._cleanTranscript(text);
            if (clean && clean.length > 1) {
                worker.transcriptChunks.push({ text: clean, ts: Date.now() });
                // Prune anything older than the window (keep a couple extra as backstop)
                const cutoff = Date.now() - TRANSCRIPT_WINDOW_MS;
                worker.transcriptChunks = worker.transcriptChunks.filter((c) => c.ts >= cutoff).slice(-12);
                console.log(`[AI-Hear] stream ${worker.streamId}: +${clean.length} chars ("${clean.slice(0, 80)}...")`);
                this._onFreshSpeech(worker, clean);
            } else {
                console.log(`[AI-Hear] stream ${worker.streamId}: transcript empty this cycle (quiet/no speech)`);
            }
        } catch (err) {
            console.warn(`[AI-Hear] transcription failed (stream ${worker.streamId}):`, err.message);
        } finally {
            if (wavPath) { try { fs.unlinkSync(wavPath); } catch {} }
            worker.capturing = false;
        }
    }

    /** Strip common Whisper hallucinations on silence (e.g. "you", "thank you", "."). */
    _cleanTranscript(text) {
        let t = String(text || '').replace(/\s+/g, ' ').trim();
        const junk = new Set(['you', '.', 'thank you', 'thanks for watching', 'thank you.', 'you.', 'bye', 'okay', '...', 'thanks for watching!']);
        if (junk.has(t.toLowerCase())) return '';
        return t;
    }

    async _captureAndDescribe(worker) {
        if (worker.stopped || worker.describing) return;
        if (this._stopIfOffline(worker)) return;
        worker.describing = true;
        try {
            const dataUrl = await streamVision.captureFrame(worker.stream);
            if (!dataUrl) return;
            const desc = await aiProvider.chatCompletion({
                baseUrl: worker.config.base_url,
                apiKey: worker.config.api_token,
                model: worker.config.model,
                temperature: 0.4,
                maxTokens: 90,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'This is a live stream frame. In 8-16 words, say what is actually HAPPENING right now — the action, the moment, anything funny/surprising/notable, plus the game or app if relevant. Like telling a friend who just walked in. Do NOT start with "the screen shows/displays"; just say what\'s going on.' },
                            { type: 'image_url', image_url: { url: dataUrl } },
                        ],
                    },
                ],
            });
            const clean = String(desc || '').replace(/\s+/g, ' ').trim();
            if (clean && clean.length > 3) {
                worker.visual = { text: clean.slice(0, 400), ts: Date.now() };
                console.log(`[AI-See] stream ${worker.streamId}: "${clean.slice(0, 90)}"`);
            }
        } catch (err) {
            console.warn(`[AI-See] describe failed (stream ${worker.streamId}):`, err.message);
        } finally {
            worker.describing = false;
        }
    }
}

module.exports = new AiChatbotService();
