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

const MAX_MSG_LEN = 200;
const MAX_TRANSCRIPT_CHARS = 1600;
const TRANSCRIBE_INTERVAL_MS = 20000;   // capture cadence when transcription is on
const AUDIO_CHUNK_SECONDS = 14;
const VISION_INTERVAL_MS = 35000;       // screenshot cadence when vision is on
const MAX_CONSECUTIVE_ERRORS = 5;       // disable a worker after this many API failures

// Distinct bot characters so a pool of N feels like different people.
const BOT_CHARACTERS = [
    'a condescending contrarian who disagrees with everything the streamer says',
    'an over-the-top hype troll who ironically overreacts to everything',
    'a doomer who insists the stream is dead and nobody is watching',
    'a smug "expert" who backseats and says they could do it better',
    'a chaotic shitposter who changes the subject to something random',
    'a bait-y concern troll who pretends to be helpful but is annoying',
    'a rival-streamer fanboy who keeps comparing this stream to someone better',
    'a deadpan skeptic who doubts everything is real',
    'an easily-offended drama-starter looking for a reaction',
    'a lowkey supporter who still can\'t resist a little jab',
];

const NAME_ADJ = ['xX', 'lil', 'big', 'the', 'dark', 'toxic', 'based', 'grim', 'mad', 'sneaky', 'silent', 'lazy', 'salty', 'epic', 'raw'];
const NAME_NOUN = ['gamer', 'goblin', 'wizard', 'shark', 'ninja', 'raptor', 'trucker', 'wolf', 'ghost', 'baron', 'hobo', 'yapper', 'menace', 'clown', 'oracle'];
const NAME_SUFFIX = ['', '', '69', '420', '_tv', 'XD', '99', '_ttv', '2k', '_irl', '88', 'xd'];
const COLORS = ['#e06c75', '#98c379', '#61afef', '#c678dd', '#e5c07b', '#56b6c2', '#d19a66', '#ff7ac6', '#7dd3fc', '#f6c177', '#9ece6a', '#bb9af7'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rint(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function makeUsername() {
    // Mixed styles: gamertag, or plain lowercase anon-ish handle
    if (Math.random() < 0.25) return `anon${rint(10, 990)}`;
    const cap = Math.random() < 0.5;
    let adj = pick(NAME_ADJ), noun = pick(NAME_NOUN);
    if (cap) { adj = adj.charAt(0).toUpperCase() + adj.slice(1); noun = noun.charAt(0).toUpperCase() + noun.slice(1); }
    return `${adj}${noun}${pick(NAME_SUFFIX)}`;
}

class AiChatbotService {
    constructor() {
        /** @type {Map<number, object>} streamId → worker */
        this.workers = new Map();
    }

    _buildBots(count) {
        const chars = [...BOT_CHARACTERS].sort(() => Math.random() - 0.5);
        const bots = [];
        const usedNames = new Set();
        for (let i = 0; i < count; i++) {
            let name = makeUsername();
            let guard = 0;
            while (usedNames.has(name.toLowerCase()) && guard++ < 8) name = makeUsername();
            usedNames.add(name.toLowerCase());
            bots.push({
                username: name,
                color: pick(COLORS),
                character: chars[i % chars.length],
            });
        }
        return bots;
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
                transcript: '',
                visualContext: '',
                recentBotLines: [],
                errorCount: 0,
                stopped: false,
                postTimer: null,
                transcribeTimer: null,
                visionTimer: null,
                capturing: false,
                describing: false,
                generating: false,
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
        } catch (err) {
            console.error('[AI-Bots] startForStream error:', err.message);
        }
    }

    stopForStream(streamId) {
        const worker = this.workers.get(streamId);
        if (!worker) return;
        worker.stopped = true;
        if (worker.postTimer) clearTimeout(worker.postTimer);
        if (worker.transcribeTimer) clearInterval(worker.transcribeTimer);
        if (worker.visionTimer) clearInterval(worker.visionTimer);
        this.workers.delete(streamId);
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
        try {
            const bot = pick(worker.bots);
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

    _buildMessages(worker, bot) {
        const s = worker.stream;
        const title = s.title || 'Untitled Stream';
        const category = s.category || 'IRL';
        const streamer = s.display_name || s.username || 'the streamer';
        const persona = String(worker.config.persona || '').trim();
        let tags = [];
        try { tags = Array.isArray(s.tags) ? s.tags : JSON.parse(s.tags || '[]'); } catch { tags = []; }

        const system = [
            `You are "${bot.username}", a live viewer typing in ${streamer}'s Twitch-style stream chat.`,
            `Your character: you are ${bot.character}.`,
            persona ? `The streamer's requested vibe for chat viewers like you: ${persona}` : '',
            `Write ONE short chat message (max ~20 words) as this viewer would actually type it.`,
            `React to what is happening RIGHT NOW — reference what the streamer just said/did (from the transcript) or reply to something in recent chat when it fits. Stay on-topic with the stream, don't be generic.`,
            `Be casual, lowercase-ish, like real chat. You can be a troll, argumentative, provocative, or start dumb arguments, but keep it PG-13: no slurs, no hate, no real threats, nothing sexual about real people, no doxxing.`,
            `Do NOT repeat things already said in chat. Do NOT use quotation marks. Do NOT prefix your name. Do NOT explain yourself. Output ONLY the chat message text.`,
        ].filter(Boolean).join('\n');

        const contextParts = [
            `STREAM INFO:\n- Streamer: ${streamer}\n- Title: ${title}\n- Category/game: ${category}${tags.length ? `\n- Tags: ${tags.join(', ')}` : ''}${s.viewer_count != null ? `\n- Viewers: ${s.viewer_count}` : ''}`,
        ];
        if (worker.visualContext && worker.visualContext.trim()) {
            contextParts.push(`WHAT'S ON SCREEN RIGHT NOW (from a live screenshot): ${worker.visualContext}`);
        }
        if (worker.transcript && worker.transcript.trim()) {
            contextParts.push(`WHAT THE STREAMER HAS BEEN SAYING (live transcribed audio, most recent last):\n"${worker.transcript.slice(-1400)}"`);
        } else if (!worker.visualContext) {
            contextParts.push(`(No audio/screen context yet — infer what's happening from the title, category, and chat.)`);
        }
        const recent = this._recentChatLines(worker.streamId);
        if (recent.length) {
            contextParts.push(`RECENT CHAT (oldest first):\n${recent.join('\n')}`);
        } else {
            contextParts.push(`RECENT CHAT: (chat is dead — nobody is talking, get something started)`);
        }
        if (worker.recentBotLines && worker.recentBotLines.length) {
            contextParts.push(`Do NOT repeat or paraphrase these recent lines:\n- ${worker.recentBotLines.slice(-6).join('\n- ')}`);
        }
        contextParts.push(`Now type ${bot.username}'s single chat message reacting to what's happening on stream right now:`);

        return [
            { role: 'system', content: system },
            { role: 'user', content: contextParts.join('\n\n') },
        ];
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

    async _generateAndPost(worker, bot) {
        if (worker.stopped || worker.generating) return;
        worker.generating = true;
        try {
            const messages = this._buildMessages(worker, bot);
            const raw = await aiProvider.chatCompletion({
                baseUrl: worker.config.base_url,
                apiKey: worker.config.api_token,
                model: worker.config.model,
                messages,
                temperature: 1.05,
                maxTokens: 60,
            });
            worker.errorCount = 0;
            const message = this._sanitizeMessage(raw);
            if (!message) return;
            if (worker.stopped || !this.workers.has(worker.streamId)) return;
            worker.recentBotLines.push(message);
            if (worker.recentBotLines.length > 10) worker.recentBotLines.shift();
            this._inject(worker, bot, message);
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
        } catch (err) {
            console.warn('[AI-Bots] broadcast failed:', err.message);
        }
    }

    async _captureAndTranscribe(worker) {
        if (worker.stopped || worker.capturing) return;
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
                worker.transcript = (worker.transcript + ' ' + clean).slice(-MAX_TRANSCRIPT_CHARS);
                console.log(`[AI-Hear] stream ${worker.streamId}: +${clean.length} chars ("${clean.slice(0, 80)}...")`);
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
                            { type: 'text', text: 'This is a still frame from a live stream. In one short sentence, describe what is happening on screen (game being played, app/desktop, what the person is doing, notable on-screen text). Be concrete and specific. If it is just a webcam, describe the person/scene briefly.' },
                            { type: 'image_url', image_url: { url: dataUrl } },
                        ],
                    },
                ],
            });
            const clean = String(desc || '').replace(/\s+/g, ' ').trim();
            if (clean && clean.length > 3) {
                worker.visualContext = clean.slice(0, 400);
                console.log(`[AI-See] stream ${worker.streamId}: "${worker.visualContext.slice(0, 90)}"`);
            }
        } catch (err) {
            console.warn(`[AI-See] describe failed (stream ${worker.streamId}):`, err.message);
        } finally {
            worker.describing = false;
        }
    }
}

module.exports = new AiChatbotService();
