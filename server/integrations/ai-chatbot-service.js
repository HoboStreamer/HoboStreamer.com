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
const CONVO_WINDOW_MS = 55000;          // how long a back-and-forth "sticks" to one bot
const SITUATION_MIN_GAP_MS = 6000;      // throttle the audio/visual "what's the streamer doing" digest
const SCENE_REACT_MIN_GAP_MS = 20000;   // min gap between bots reacting to on-screen game action
const LIVENESS_CHECK_MS = 12000;        // each worker self-checks the stream is still live
const ORPHAN_SWEEP_MS = 30000;          // service-wide sweep to kill workers for dead streams

// ── Output pacing ──────────────────────────────────────────────────────────
// ALL messages funnel through one pacer so chat comes out one-at-a-time with
// natural gaps — never a clump of bot messages at once.
const GLOBAL_MIN_GAP_MS = 3400;         // hard floor between ANY two bot messages
const HYPE_MIN_GAP_MS = 1800;           // tighter floor during a hype moment
const ACTIVE_GAP_MS = [3800, 8500];     // target gap range when chat is engaged
const IDLE_GAP_MS = [12000, 26000];     // target gap range when it's quiet
const REPLY_TYPING_MS = [1100, 3200];   // human "typing" delay before a reply appears
const HYPE_WINDOW_MS = 8000;            // how long a hype moment elevates the pace
const ACTIVE_INPUT_MS = 22000;          // "engaged" if real input arrived within this
const AMBIENT_PROB_ACTIVE = 0.7;        // chance an ambient filler actually fires when due (engaged)
const AMBIENT_PROB_IDLE = 0.45;         // ...when quiet (leaves natural silences)
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
                // For TYPED addressing (chat): the full username and the core
                // adj+noun, both glued & lowercased — so "toxicwizard_ttv",
                // "@ToxicWizard", or "toxicwizard" all match.
                nameNorm: gen.username.toLowerCase().replace(/[^a-z0-9]/g, ''),
                coreNorm: (gen.words || []).join('').toLowerCase().replace(/[^a-z0-9]/g, ''),
            });
        }
        return bots;
    }

    /**
     * Detect which bots were addressed by name. Handles BOTH:
     *  - TYPED chat: the streamer types the actual username, glued together
     *    ("toxicwizard_ttv", "@ToxicWizard", "toxicwizard") — match the glued
     *    username / core name as a substring.
     *  - VOICE: Whisper won't reproduce "ToxicWizard", but hears the words
     *    ("toxic wizard") — match the spaced words.
     * Returns an array of bots (usually 0 or 1).
     */
    _detectAddressedBots(worker, text) {
        const spaced = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
        const glued = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (spaced.length < 3 && glued.length < 3) return [];
        const hits = [];
        for (const bot of worker.bots) {
            // TYPED: full username or core adj+noun appears glued in the text.
            if (bot.nameNorm && bot.nameNorm.length >= 4 && glued.includes(bot.nameNorm)) { hits.push(bot); continue; }
            if (bot.coreNorm && bot.coreNorm.length >= 6 && glued.includes(bot.coreNorm)) { hits.push(bot); continue; }
            // VOICE: distinctive noun word, or the full spaced name.
            const words = bot.matchWords || [];
            if (!words.length) continue;
            const noun = words[words.length - 1];
            if (noun && spaced.includes(` ${noun} `)) { hits.push(bot); continue; }
            if (words.length >= 2 && spaced.includes(` ${words.join(' ')} `)) hits.push(bot);
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
                transcriptChunks: [],   // [{ text, ts }] — RAW (echo+streamer+media), decays
                visual: null,           // { text, ts }
                situation: null,         // digest: { streamerSaid, watching, scene, addressingChat, ts }
                lastSituationAt: 0,      // throttle the digest LLM call
                situating: false,
                digestSeenTs: 0,         // ts of last transcript chunk fed to the digest
                lastStreamerSaid: '',    // last streamer utterance acted on (fuzzy dedup)
                lastStreamerSig: '',     // last streamer utterance acted on (exact dedup)
                lastSceneReacted: '',    // last scene a bot reacted to (dedup game reactions)
                lastSceneReactAt: 0,     // throttle scene reactions
                realViewers: new Map(),  // lowercased real-human username → last-seen ts
                recentBotLines: [],
                intents: [],             // pending message requests: [{ kind:'reply'|'hype', bot, opts, prio, ts }]
                replyCooldown: new Map(), // bot.username → last reactive-reply ts
                lastSpeechSig: '',       // dedupe repeated detection of the same sentence
                lastDirectorAt: 0,       // throttle the director call
                lastViewerReplyAt: 0,    // throttle replies to non-streamer viewers
                lastRealInput: null,     // { username, text, isStreamer, ts }
                convo: null,             // { bot, ts } — bot currently in a back-and-forth w/ streamer
                lastActiveBot: null,     // username of the bot that most recently posted
                recentPosters: [],       // last few posters, to stop one bot dominating
                lastPostAt: 0,           // when the last message actually went out (pacing floor)
                hypeUntil: 0,            // pace stays elevated until this time
                errorCount: 0,
                stopped: false,
                paceTimer: null,
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

            // Single output pacer — everything emits through here, one at a time.
            this._scheduleTick(worker, rint(5000, 12000));

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
        if (worker.paceTimer) clearTimeout(worker.paceTimer);
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

    // ── Output pacer ─────────────────────────────────────────────────────────
    // The ONLY place messages are emitted. Everything else just enqueues intents
    // or elevates the pace; this loop emits at most one message per tick and
    // enforces a global minimum gap, so chat never dumps several at once.

    _scheduleTick(worker, delayMs) {
        if (worker.stopped) return;
        if (worker.paceTimer) clearTimeout(worker.paceTimer);
        worker.paceTimer = setTimeout(() => this._paceTick(worker), Math.max(250, delayMs));
    }

    /** Nudge the pacer to fire sooner (e.g. a reply just got queued), but never
     * closer than the global gap allows. */
    _wakePacer(worker, delayMs) {
        if (worker.stopped) return;
        const sinceLast = Date.now() - worker.lastPostAt;
        const floor = (worker.hypeUntil > Date.now() ? HYPE_MIN_GAP_MS : GLOBAL_MIN_GAP_MS) - sinceLast;
        this._scheduleTick(worker, Math.max(delayMs, floor, 250));
    }

    _isActive(worker) {
        return worker.hypeUntil > Date.now()
            || (Date.now() - (worker.lastRealInput?.ts || 0)) < ACTIVE_INPUT_MS
            || worker.intents.length > 0;
    }

    /** Delay until the next pacer tick — short when there's pending work, longer when idle. */
    _nextTickDelay(worker) {
        if (worker.intents.length || worker.hypeUntil > Date.now()) return rint(700, 1800);
        return this._isActive(worker) ? rint(...ACTIVE_GAP_MS) : rint(...IDLE_GAP_MS);
    }

    async _paceTick(worker) {
        if (worker.stopped) return;
        if (this._stopIfOffline(worker)) return;
        try {
            await this._emitIfDue(worker);
        } catch (err) {
            worker.errorCount++;
            console.warn(`[AI-Bots] emit error (stream ${worker.streamId}, ${worker.errorCount}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);
            if (worker.errorCount >= MAX_CONSECUTIVE_ERRORS) {
                console.warn(`[AI-Bots] Disabling stream ${worker.streamId} after repeated errors.`);
                this.stopForStream(worker.streamId);
                return;
            }
        }
        this._scheduleTick(worker, this._nextTickDelay(worker));
    }

    /** Emit at most ONE message, if the global gap allows and something's due. */
    async _emitIfDue(worker) {
        if (worker.generating) return;
        const now = Date.now();
        const minGap = worker.hypeUntil > now ? HYPE_MIN_GAP_MS : GLOBAL_MIN_GAP_MS;
        if (now - worker.lastPostAt < minGap) return;   // hold the line — no clumping

        // Priority: queued replies (reply/hype intents) → then maybe an ambient filler.
        let bot, opts;
        const intent = this._takeIntent(worker);
        if (intent) {
            bot = intent.bot;
            opts = intent.opts || {};
        } else {
            // Ambient filler — only sometimes, so there are natural silences.
            const due = (now - worker.lastPostAt) >= this._ambientTarget(worker);
            const prob = this._isActive(worker) ? AMBIENT_PROB_ACTIVE : AMBIENT_PROB_IDLE;
            if (!due || Math.random() > prob) return;
            bot = this._pickResponder(worker);
            opts = {};
        }
        if (!bot) return;
        await this._generateAndPost(worker, bot, opts);
        worker.errorCount = 0;
        worker.lastPostAt = Date.now();
    }

    _ambientTarget(worker) {
        // Roughly honor the streamer's post_interval, spread across the pool, but
        // never so tight that a small pool feels spammy.
        const base = (worker.config.post_interval_seconds || 45) * 1000;
        const perBot = base / Math.max(1, worker.bots.length);
        return Math.max(GLOBAL_MIN_GAP_MS, this._isActive(worker) ? perBot * 0.8 : perBot * 1.6);
    }

    /** Has this bot been posting too much lately (2+ of the last 3 messages)? */
    _overexposed(worker, username) {
        const last3 = worker.recentPosters.slice(-3);
        return last3.filter((u) => u === username).length >= 2;
    }

    /** Pop the highest-priority pending intent, preferring a bot that isn't
     * dominating chat (so an argument doesn't become one bot's monologue). */
    _takeIntent(worker) {
        if (!worker.intents.length) return null;
        worker.intents.sort((a, b) => (b.prio - a.prio) || (a.ts - b.ts));
        // Prefer a fresh voice: not the last poster, not over-exposed.
        let idx = worker.intents.findIndex((i) => i.bot.username !== worker.lastActiveBot && !this._overexposed(worker, i.bot.username));
        if (idx < 0) idx = worker.intents.findIndex((i) => i.bot.username !== worker.lastActiveBot);
        if (idx < 0) idx = 0;
        return worker.intents.splice(idx, 1)[0];
    }

    /** Enqueue a message request. One pending intent per bot — a higher-priority
     * request (e.g. a reply) replaces a lower one (e.g. a hype). Wakes the pacer. */
    _enqueueIntent(worker, kind, bot, opts, prio, wakeMs) {
        if (!bot || worker.stopped) return false;
        const existingIdx = worker.intents.findIndex((i) => i.bot.username === bot.username);
        if (existingIdx >= 0) {
            if (worker.intents[existingIdx].prio >= prio) return false; // keep the higher one
            worker.intents.splice(existingIdx, 1);                       // replace with this higher one
        }
        if (worker.intents.length > 6) worker.intents.shift(); // never let a backlog build
        worker.intents.push({ kind, bot, opts: opts || {}, prio, ts: Date.now() });
        this._wakePacer(worker, wakeMs != null ? wakeMs : rint(...REPLY_TYPING_MS));
        return true;
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
        if (ir < 0.25) intent = 'ask the streamer a dumb or loaded question about what they\'re doing';
        else if (ir < 0.40) intent = 'roast or backseat the streamer\'s gameplay/decision';
        // (No "reply to another chatter" intent — that made bots talk to each other.)
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

        // Prefer the fused situation digest (streamer's own words + scene, echo &
        // watched-media already separated). Fall back to raw signals if no digest yet.
        const sit = (worker.situation && (Date.now() - worker.situation.ts) <= VISION_STALE_MS) ? worker.situation : null;
        const scene = sit?.scene || this._currentVisual(worker);
        const streamerSaid = sit?.streamerSaid || '';
        const watching = sit?.watching || '';

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

        // The bot's OWN recent line — so when the streamer replies to it, it can
        // defend/continue its specific point instead of firing a random roast.
        const myLastLine = (bot.ownLines && bot.ownLines.length) ? bot.ownLines[bot.ownLines.length - 1] : '';

        // Who/what this reply is answering (so the bot actually engages it).
        let replyInstruction = '';
        if (direct) {
            replyInstruction = `${streamer} (the STREAMER) just said YOUR name and is talking to YOU (${bot.username})${myLastLine ? `, replying to your line "${myLastLine}"` : ''}. Answer/clap back at exactly what they said, in your voice.`;
        } else if (fromStreamer && opts.answering) {
            replyInstruction = `${streamer} (the STREAMER) just ${channel === 'chat' ? 'typed to chat' : 'asked/told chat'}: react to it directly and answer them — like a viewer replying to the streamer.`;
        } else if (fromStreamer) {
            // Proactive: goosely is just talking; chat clowns on THEM.
            replyInstruction = `${streamer} (the STREAMER) just said/did the thing below. React to ${streamer} SPECIFICALLY — clown on them for it, quote them back, roast their take, or hype/agree with a twist. Make it obviously about what ${streamer} just said. Do NOT pretend they were talking to you, and do NOT just comment on the general topic.`;
        } else if (opts.fromScene) {
            replyInstruction = `React to what's HAPPENING ON SCREEN in ${streamer}'s game right now (below) — like a viewer backseating or clowning on their gameplay. Be specific to the moment, not generic.`;
        } else if (fromViewer) {
            replyInstruction = `Another viewer "${fromViewer}" just ${channel === 'chat' ? 'typed this in chat' : 'said this'}. React to or clap back at THEM specifically.`;
        }

        const system = [
            `You are "${bot.username}", ONE real viewer in ${streamer}'s live Twitch-style chat. You are WATCHING ${streamer}'s stream.`,
            `ROLE (critical): ${streamer} is the STREAMER — they are broadcasting/performing, they are NOT watching anything. YOU are the viewer watching THEM. Never tell ${streamer} they're "watching" something, never call them a viewer, never accuse them of a bad view/eyeballs — if you're gonna complain, complain about THEIR stream, gameplay, audio, or takes.`,
            `Your personality: ${bot.character}.`,
            `How you type: ${bot.style}. Keep this voice consistent.`,
            bot.arc ? `Your vibe so far this stream (stay consistent, let it grow): ${bot.arc}` : '',
            persona ? `The streamer wants viewers like you to lean into this: ${persona}` : '',
            replyInstruction || `Post a spontaneous chat message reacting to what's happening on stream RIGHT NOW.`,
            `LENGTH: make this ${beat.len}. Real chat is mostly tiny reactions — do NOT write a neat full sentence every time. No proper caps/punctuation unless your style calls for it.`,
            beat.intent && !addressed ? `THIS MESSAGE: ${beat.intent}` : '',
            emoteSample.length ? `You may use these chat emotes when they fit (a message can be JUST an emote): ${emoteSample.join(' ')}. Don't force them.` : '',
            `GROUND YOURSELF IN REALITY: react to the actual streamer, the real screen, and real viewers. Do NOT invent fake people, fake backstories, or a running meme and obsess over it. If chat started a dumb bit, don't beat it into the ground.`,
            `Your focus is the STREAMER (${streamer}) and the stream. Do NOT talk ABOUT other chatters or single them out by name, and NEVER narrate what another chatter is "doing" (e.g. "look what BigTrucker is doing") — chatters are just typing, they aren't doing anything you can see. Only reply to another person if they clearly said something TO chat/you.`,
            `Do NOT reuse your own catchphrase/sign-off every message (e.g. don't end everything with "LET'S GOOO"). Vary how you talk.`,
            dead.length ? `Chat has BEATEN THESE TO DEATH — do NOT mention them again, move on: ${dead.join(', ')}.` : '',
            `You are WATCHING — react like a viewer, never describe the screen or say "the screen shows".`,
            `PG-13: no slurs, hate, real threats, nothing sexual about real people, no doxxing. Trolling/arguing/roasting is fine.`,
            `Output ONLY the raw chat message text — no quotes, no name prefix, no explanation.`,
        ].filter(Boolean).join('\n');

        const contextParts = [];
        // Scene reactions get their target from the WHAT'S HAPPENING line below, not
        // a "reply to X" block. Only show the reply block for person-directed replies.
        if (addressed && !opts.fromScene) {
            const label = direct ? `${streamer} (STREAMER) → YOU`
                : fromStreamer ? `${streamer} (STREAMER)${channel === 'chat' ? ' typed' : ' on mic'}`
                : `viewer ${fromViewer || ''}`.trim();
            contextParts.push(`>>> REPLY TO THIS — ${label}: "${addressed}"`);
        }
        // Fused situation (echo + watched-media already separated from the streamer).
        if (scene) {
            contextParts.push(`WHAT'S HAPPENING ON STREAM NOW: ${scene}\n(React like a viewer — don't describe it, riff on it.)`);
        }
        if (streamerSaid && !addressed) {
            contextParts.push(`${streamer} (the STREAMER) just said/did: "${streamerSaid}" — this is THEM, not chat. React to it.`);
        }
        if (watching) {
            contextParts.push(`(${streamer} is reacting to: ${watching} — you can clown on their reaction, not narrate the video.)`);
        }
        if (!scene && !streamerSaid && !addressed) {
            contextParts.push(`(No live audio/screen read yet — go off the recent chat and the category.)`);
        }
        contextParts.push(`(context) ${streamer} is streaming "${title}" — ${category}${tags.length ? ` [${tags.join(', ')}]` : ''}${s.viewer_count != null ? `, ${s.viewer_count} watching` : ''}. Don't keep commenting on the title.`);
        // Recent chat, with the bot pool anonymized to generic "someone" so bots
        // don't single each other out by name; REAL viewers keep their name (★).
        const botNames = new Set(worker.bots.map((b) => b.username.toLowerCase()));
        const realSet = worker.realViewers || new Map();
        const recent = this._recentChatLines(worker.streamId, 12).map((line) => {
            const m = String(line).match(/^([^:]+):\s*(.*)$/);
            if (!m) return line;
            const name = m[1].trim();
            const low = name.toLowerCase().replace(/^\[[^\]]+\]\s*/, '');
            if (realSet.has(low)) return `★${name}: ${m[2]}`;   // real viewer — you CAN reply to them
            if (botNames.has(low)) return `someone: ${m[2]}`;    // fellow bot — crowd noise, don't name them
            return `${name}: ${m[2]}`;
        });
        if (recent.length) {
            contextParts.push(`RECENT CHAT (newest last; ★ = a REAL viewer you can reply to by name; "someone" = background crowd, do NOT address them by name):\n${recent.join('\n')}`);
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
     * The heart of "actually understanding the stream". The raw transcript is a
     * mess: it mixes (a) the streamer's own voice, (b) the chat bots' TTS read
     * aloud on the streamer's system (echo of our OWN messages), and (c) audio
     * from videos/games the streamer is watching. This runs a cheap LLM pass that
     * separates those sources and fuses them with the on-screen visual into one
     * coherent picture — so the bots react to what the STREAMER is actually doing
     * and saying, not to their own echo or a YouTube video's narrator.
     */
    async _updateSituation(worker) {
        if (worker.stopped || worker.situating) return;
        const now = Date.now();
        if (now - worker.lastSituationAt < SITUATION_MIN_GAP_MS) return;
        worker.lastSituationAt = now;
        worker.situating = true;
        try {
            // Feed only the NEW audio since the last digest (usually the last ~15s
            // chunk) so streamer_said is the streamer's LATEST utterance, not an
            // ever-growing summary that makes bots re-react to the same line.
            const fresh = (worker.transcriptChunks || []).filter((c) => c.ts > (worker.digestSeenTs || 0));
            const rawNew = fresh.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim().slice(-500);
            const priorText = this._currentTranscript(worker).slice(-300); // brief context only
            const visual = this._currentVisual(worker);
            if (!rawNew && !visual) return;
            if (fresh.length) worker.digestSeenTs = fresh[fresh.length - 1].ts;
            const streamer = worker.stream.display_name || worker.stream.username || 'the streamer';
            const botLines = (worker.recentBotLines || []).slice(-10).map((l) => String(l).replace(/^[^:]+:\s*/, ''));

            const sys = [
                `You are the "ears and eyes" for chat bots on ${streamer}'s livestream. Turn messy live signals into a clean picture of what the STREAMER is doing RIGHT NOW.`,
                `The AUDIO is unreliable and mixes THREE sources you must separate:`,
                `  1) ${streamer}'s OWN voice — THIS is what matters. Report only their MOST RECENT thought, verbatim-ish, not a summary of the last minute.`,
                `  2) The chat bots' text-to-speech read aloud on ${streamer}'s system — an ECHO of messages chat just posted; IGNORE it. The "recent chat lines" below ARE that echo; anything in the audio matching them is NOT the streamer.`,
                `  3) Audio from a video/game ${streamer} is watching/playing (ads, YouTube narrators, game dialogue) — attribute to "watching", NOT to the streamer. If unsure whether a line is the streamer or the video, prefer "watching".`,
                `Fuse the streamer's voice with what's ON SCREEN. Reply ONLY with compact JSON.`,
            ].join('\n');
            const user = [
                rawNew ? `NEWEST AUDIO (~15s, what to focus on):\n"${rawNew}"` : `NEWEST AUDIO: (silent)`,
                priorText ? `(slightly earlier audio, context only): "${priorText}"` : '',
                visual ? `ON SCREEN NOW: ${visual}` : `ON SCREEN: (unknown)`,
                botLines.length ? `RECENT CHAT LINES (bot-TTS echo to ignore in the audio):\n- ${botLines.join('\n- ')}` : `RECENT CHAT: (none)`,
                `Stream: "${worker.stream.title || ''}" — ${worker.stream.category || 'IRL'}.`,
                `JSON: {"streamer_said":"<${streamer}'s LATEST own words/action only (from the newest audio), excluding echo and watched-media; empty if they were silent or only the video was talking>","watching":"<video/game/content they're reacting to, if any; else empty>","addressing_chat":<true ONLY if they directly ask chat something or talk to chat/a viewer; false for narrating/reacting to their video>,"scene":"<ONE vivid line a viewer would react to & troll>"}`,
            ].filter(Boolean).join('\n\n');

            const rawOut = await aiProvider.chatCompletion({
                baseUrl: worker.config.base_url, apiKey: worker.config.api_token, model: worker.config.model,
                temperature: 0.2, maxTokens: 200,
                messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
            });
            const d = this._parseSituationJson(rawOut);
            if (!d) return;
            worker.situation = {
                streamerSaid: String(d.streamer_said || '').trim(),
                watching: String(d.watching || '').trim(),
                scene: String(d.scene || '').trim(),
                addressingChat: !!d.addressing_chat,
                ts: Date.now(),
            };
            const said = worker.situation.streamerSaid;
            if (said) {
                console.log(`[AI-Situation] stream ${worker.streamId}: streamer="${said.slice(0, 70)}"${worker.situation.watching ? ` | watching="${worker.situation.watching.slice(0, 40)}"` : ''}`);
                this._onStreamerInput(worker, said, { addressingChat: worker.situation.addressingChat });
            } else if (worker.situation.scene) {
                console.log(`[AI-Situation] stream ${worker.streamId}: scene="${worker.situation.scene.slice(0, 70)}" (streamer quiet)`);
            }
            // Whether or not the streamer talked, keep chat alive during gameplay by
            // occasionally reacting to what's happening ON SCREEN (the game itself).
            this._maybeReactToScene(worker);
        } catch (err) {
            console.warn(`[AI-Situation] digest failed (stream ${worker.streamId}):`, err.message);
        } finally {
            worker.situating = false;
        }
    }

    _parseSituationJson(raw) {
        if (!raw) return null;
        let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        const m = s.match(/\{[\s\S]*\}/);
        if (m) s = m[0];
        try { return JSON.parse(s); } catch { return null; }
    }

    /**
     * Called with the streamer's CLEAN speech (from the situation digest — bot echo
     * and watched-media already separated out). Decides whether/which bot replies:
     *  1) named a bot → that bot replies directly
     *  2) addressing chat / asking → a bot answers
     *  3) hyped → quick reactions
     *  4) else → director decides if it's worth engaging
     */
    _onStreamerInput(worker, text, opts = {}) {
        if (worker.stopped) return;
        const sig = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(-140);
        if (sig && sig === worker.lastStreamerSig) return;
        // Fuzzy dedup: if this utterance mostly overlaps the last one we acted on,
        // it's the same rambling re-extracted — don't re-trigger a reply.
        if (worker.lastStreamerSaid && this._overlapRatio(text, worker.lastStreamerSaid) >= 0.6) return;
        worker.lastStreamerSig = sig;
        worker.lastStreamerSaid = String(text);
        worker.lastRealInput = { username: worker.stream.display_name || worker.stream.username || 'streamer', text: String(text).slice(-300), isStreamer: true, ts: Date.now() };

        // 1) Direct name callout → highest priority.
        const named = this._detectAddressedBots(worker, text);
        if (named.length) {
            let queued = 0;
            for (const bot of named) {
                if (this._queueReply(worker, bot, text, { direct: true, fromStreamer: true, channel: 'mic' })) queued++;
            }
            if (queued) console.log(`[AI-Bots] stream ${worker.streamId}: streamer named ${named.map((b) => b.username).join(', ')} — direct reply`);
            return;
        }

        // 2) Addressing chat / asking → a bot ANSWERS it (digest hint OR heuristic).
        if (opts.addressingChat || this._looksDirectedAtChat(text)) {
            const bot = this._pickReplyBot(worker, this._conversationPartner(worker));
            if (bot && this._queueReply(worker, bot, text, { fromStreamer: true, channel: 'mic', answering: true })) {
                console.log(`[AI-Bots] stream ${worker.streamId}: streamer addressing chat — ${bot.username} answers`);
            }
            return;
        }

        // 3) Hyped/reacting → quick reactions (paced, not dumped).
        if (this._looksHype(text) && (Date.now() - worker.hypeUntil) > HYPE_BURST_COOLDOWN_MS) {
            console.log(`[AI-Bots] stream ${worker.streamId}: hype moment — quick reactions`);
            this._triggerHype(worker);
            return;
        }

        // 4) Otherwise a bot proactively clowns on what the streamer's doing (~60%
        //    so not every utterance gets a reply). Rotate a FRESH bot (not the sticky
        //    convo partner) so one bot doesn't monologue with its catchphrase.
        if (String(text).trim().length < 8) return;
        if (Math.random() < 0.6) {
            const bot = this._pickReplyBot(worker, null);
            if (bot && this._queueReply(worker, bot, text, { fromStreamer: true, channel: 'mic' })) {
                console.log(`[AI-Bots] stream ${worker.streamId}: engaging streamer — ${bot.username}`);
            }
        }
    }

    /**
     * Keep chat alive during gameplay: when the on-screen scene is fresh/changed,
     * occasionally have a bot react to what's HAPPENING in the game — not just when
     * the streamer talks. Throttled + deduped so it's lively, not spammy.
     */
    _maybeReactToScene(worker) {
        if (worker.stopped) return;
        const scene = worker.situation?.scene;
        if (!scene || scene.length < 8) return;
        const now = Date.now();
        if (now - worker.lastSceneReactAt < SCENE_REACT_MIN_GAP_MS) return;
        // Don't react to essentially the same scene twice.
        if (worker.lastSceneReacted && this._overlapRatio(scene, worker.lastSceneReacted) >= 0.6) return;
        // Skip if the streamer just talked (a reply is already handling this beat)
        // or a reply is already queued.
        if (worker.intents.length) return;
        if ((now - (worker.lastRealInput?.ts || 0)) < 5000) return;
        // React ~65% of the time so there are still natural lulls.
        if (Math.random() > 0.65) return;
        worker.lastSceneReactAt = now;
        worker.lastSceneReacted = scene;
        const bot = this._pickReplyBot(worker, null);
        if (bot && this._queueReply(worker, bot, scene, { fromScene: true, channel: 'scene' })) {
            console.log(`[AI-Bots] stream ${worker.streamId}: reacting to gameplay — ${bot.username}`);
        }
    }

    /** Fraction of `a`'s content words that also appear in `b` (0..1). */
    _overlapRatio(a, b) {
        const toks = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
            .filter((w) => w.length >= 3 && !TOPIC_STOPWORDS.has(w));
        const A = toks(a); if (!A.length) return 0;
        const B = new Set(toks(b));
        let m = 0; for (const w of A) if (B.has(w)) m++;
        return m / A.length;
    }

    /** Heuristic: is the streamer talking TO chat / asking a question (vs narrating)? */
    _looksDirectedAtChat(text) {
        const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9'? ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
        if (t.includes('?')) return true;
        return /( who is | what is | whats | what's | wheres | where's | you guys | y'?all | anyone | does anyone | do you | what do you | how do you | should i | you think | you think\? | right\? | am i | are we | chat | vote | tell me | explain | which one | wdyt | thoughts | chat what )/.test(t);
    }

    /** Pick a bot to respond to a spontaneous prompt — prefer a fresh, non-dominating voice. */
    _pickResponder(worker) {
        let candidates = worker.bots.filter((b) => b.username !== worker.lastActiveBot && !this._overexposed(worker, b.username));
        if (!candidates.length) candidates = worker.bots.filter((b) => b.username !== worker.lastActiveBot);
        return pick(candidates.length ? candidates : worker.bots);
    }

    /** Pick a bot to REPLY with. Prefers `preferred` (e.g. the convo partner) but
     * only if it's off cooldown and not dominating; otherwise rotates to another
     * available bot so replies keep flowing and no single bot monologues. */
    _pickReplyBot(worker, preferred) {
        const off = (b) => (Date.now() - (worker.replyCooldown.get(b.username) || 0)) >= MENTION_COOLDOWN_MS;
        if (preferred && off(preferred) && !this._overexposed(worker, preferred.username)) return preferred;
        let pool = worker.bots.filter((b) => off(b) && !this._overexposed(worker, b.username) && b.username !== worker.lastActiveBot);
        if (!pool.length) pool = worker.bots.filter((b) => off(b) && b.username !== worker.lastActiveBot);
        if (!pool.length) pool = worker.bots.filter((b) => off(b));
        return pool.length ? pick(pool) : null;
    }

    /** Does a message address the streamer directly (2nd person)? */
    _msgAddressesStreamer(text) {
        return /\b(you|your|youre|you're|ur|u|urself|yourself|ya|bro|dude|man)\b/i.test(String(text || ''));
    }

    /**
     * Who is the streamer replying to? For a coherent back-and-forth, the bot the
     * streamer is arguing with should be the one to answer — not a random bot.
     * Uses the sticky convo partner, else the last bot who talked AT the streamer.
     */
    _conversationPartner(worker) {
        const c = worker.convo;
        if (c && (Date.now() - c.ts) < CONVO_WINDOW_MS) {
            const bot = worker.bots.find((b) => b.username === c.bot);
            // If the partner has been dominating, let someone else jump into the
            // argument (~60% of the time) so it doesn't become a monologue.
            if (bot && !(this._overexposed(worker, bot.username) && Math.random() < 0.6)) return bot;
        }
        for (const line of [...(worker.recentBotLines || [])].reverse()) {
            const m = String(line).match(/^([^:]+):\s*(.*)$/);
            if (!m) continue;
            const bot = worker.bots.find((b) => b.username.toLowerCase() === m[1].trim().toLowerCase());
            if (bot && this._msgAddressesStreamer(m[2])) return bot;
        }
        return null;
    }

    /** Remember which bot is trading barbs with the streamer, for thread continuity. */
    _touchConvo(worker, botUsername) {
        worker.convo = { bot: botUsername, ts: Date.now() };
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
            // Route the reply to whoever they're actually arguing with, so the
            // back-and-forth stays coherent (not a random bot).
            const named = this._detectAddressedBots(worker, text);
            const bot = named[0] || this._pickReplyBot(worker, this._conversationPartner(worker));
            if (bot && this._queueReply(worker, bot, text, { fromStreamer: true, channel: 'chat', direct: !!named[0], answering: this._looksDirectedAtChat(text) })) {
                console.log(`[AI-Bots] stream ${streamId}: streamer typed → ${bot.username} (${named[0] ? 'named' : (worker.convo ? 'convo' : 'picked')})`);
            }
            return;
        }

        // A REAL viewer typed — remember them (so bots engage humans, not each other)
        // and reply readily. Real viewers should get engaged MORE than bots engage
        // each other.
        const now = Date.now();
        worker.realViewers.set(uname, now);
        for (const [k, ts] of worker.realViewers) if (now - ts > 300000) worker.realViewers.delete(k);

        const named = this._detectAddressedBots(worker, text);
        // A viewer naming a bot always gets a reply; otherwise throttle a bit.
        if (!named[0] && now - worker.lastViewerReplyAt < VIEWER_REPLY_COOLDOWN_MS) return;
        const engaging = this._looksDirectedAtChat(text) || text.length > 30;
        const chance = named[0] ? 1 : (engaging ? 0.85 : 0.5);
        if (Math.random() > chance) return;
        worker.lastViewerReplyAt = now;
        const bot = named[0] || this._pickReplyBot(worker, null);
        if (bot) this._queueReply(worker, bot, text, { fromViewer: username, channel: 'chat', direct: !!named[0] });
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
            const picked = worker.bots.find((b) => b.username.toLowerCase() === String(decision.username || '').toLowerCase());
            // Prefer the director's pick, but fall back / rotate if it's busy or dominating.
            const bot = this._pickReplyBot(worker, picked || this._conversationPartner(worker));
            if (bot && this._queueReply(worker, bot, text, { fromStreamer: true, channel: 'mic' })) {
                console.log(`[AI-Bots] stream ${worker.streamId}: streamer engaging chat (${decision.why || ''}) — ${bot.username} replies`);
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

    /** Request a reactive reply from a bot — enqueues an intent for the pacer to
     * emit (respecting the per-bot cooldown + global pacing). Never posts directly. */
    _queueReply(worker, bot, text, meta = {}) {
        if (!bot) return false;
        const now = Date.now();
        const last = worker.replyCooldown.get(bot.username) || 0;
        // A direct name-callout always gets a response, even if the bot just spoke.
        if (!meta.direct && now - last < MENTION_COOLDOWN_MS) return false;
        worker.replyCooldown.set(bot.username, now);
        const opts = {
            addressedText: String(text).slice(-300),
            direct: !!meta.direct,
            fromStreamer: !!meta.fromStreamer,
            fromViewer: meta.fromViewer || null,
            fromScene: !!meta.fromScene,
            channel: meta.channel || 'mic',
            answering: !!meta.answering,
        };
        // streamer replies (3) > viewer replies (2) > scene reactions (1)
        const prio = meta.fromStreamer ? 3 : (meta.fromScene ? 1 : 2);
        return this._enqueueIntent(worker, meta.fromScene ? 'scene' : 'reply', bot, opts, prio);
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
        worker.recentPosters.push(bot.username);
        if (worker.recentPosters.length > 5) worker.recentPosters.shift();
        // Keep the back-and-forth on this bot if it's now engaging the streamer.
        if (opts.fromStreamer || opts.direct || this._msgAddressesStreamer(message)) {
            this._touchConvo(worker, bot.username);
        }
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
     * A hype moment: elevate the pace for a few seconds and enqueue 1-2 quick
     * short reactions from different bots. The pacer still emits them one at a
     * time (spaced by HYPE_MIN_GAP), so it reads like a real chat spike, not a
     * simultaneous dump.
     */
    _triggerHype(worker) {
        if (worker.stopped) return;
        worker.hypeUntil = Date.now() + HYPE_WINDOW_MS;
        const hypeBeat = { len: 'VERY short, 1-4 words — a pure hype/spam reaction to what just happened (like "LMAOO", "NO WAY", "he cooked", "OMG", "clip it", "actual W")', intent: '' };
        const chosen = [...worker.bots].sort(() => Math.random() - 0.5).slice(0, rint(1, 2));
        for (const bot of chosen) {
            this._enqueueIntent(worker, 'hype', bot, { beat: hypeBeat }, 2, rint(500, 1600));
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
            // TTS setting and each viewer's TTS toggle. (Emotes read aloud is fine —
            // the situation digest separates that echo from the streamer's own voice.)
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
                // Keep the RAW chunk (may contain bot-TTS echo + streamer + watched
                // media all mixed). The situation digest untangles the sources.
                worker.transcriptChunks.push({ text: clean, ts: Date.now() });
                const cutoff = Date.now() - TRANSCRIPT_WINDOW_MS;
                worker.transcriptChunks = worker.transcriptChunks.filter((c) => c.ts >= cutoff).slice(-14);
                console.log(`[AI-Hear] stream ${worker.streamId}: +${clean.length} chars ("${clean.slice(0, 80)}...")`);
                this._updateSituation(worker);
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

    /** Strip common Whisper hallucinations on silence and wordless noise. Keeps the
     * text otherwise RAW (echo + streamer + watched-media) — the situation digest
     * is what separates those sources. */
    _cleanTranscript(text) {
        let t = String(text || '').replace(/\s+/g, ' ').trim();
        const junk = new Set(['you', '.', 'thank you', 'thanks for watching', 'thank you.', 'you.', 'bye', 'okay', '...', 'thanks for watching!']);
        if (junk.has(t.toLowerCase())) return '';
        const letters = t.replace(/[^a-z]/gi, '');
        const hasWord = /[a-z]{3,}/i.test(t);
        if (letters.length < 3 || !hasWord) return '';
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
