/**
 * HoboStreamer — WebSocket Chat Server
 * 
 * Features:
 * - Anonymous chat with sequential numbering (anon12345)  
 * - Global chat + per-stream chat
 * - Word filtering (safe/unsafe mode)
 * - Anti-VPN approval queue
 * - Streamer moderation (ban, timeout, delete)
 * - Chat commands (/help, /tts, /color, etc.)
 * - Rate limiting
 */
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { authenticateWs } = require('../auth/auth');
const permissions = require('../auth/permissions');
const wordFilter = require('./word-filter');
const cosmetics = require('../monetization/cosmetics');
const ttsEngine = require('./tts-engine');

const WS_HEARTBEAT_MS = 30000;
const MAX_SEND_BACKPRESSURE = 256 * 1024;
const RATE_LIMIT_CACHE_TTL_MS = 10 * 60 * 1000;

class ChatServer {
    constructor() {
        this.wss = null;
        /** @type {Map<WebSocket, { user: object|null, anonId: string, streamId: number|null, ip: string }>} */
        this.clients = new Map();
        /** @type {Map<string, number>} IP → sequential anon number */
        this.anonMap = new Map();
        this.nextAnonId = 1;
        /** @type {Map<string, number>} `${ip}:${streamId}` → last message time (rate limiting) */
        this.rateLimits = new Map();
        this.DEFAULT_RATE_LIMIT_MS = 1000; // 1 message per second
        /** @type {Map<number, number>} streamId → slow mode ms (0 = off, default rate limit applies) */
        this.slowModeByStream = new Map();
        this.heartbeatInterval = null;
        /** @type {Map<number, number>} streamId → current TTS queue size */
        this.ttsQueueSize = new Map();
        /** @type {Map<string, number>} `${streamId}:${userId}` → user's TTS queue count */
        this.ttsUserCounts = new Map();
    }

    normalizeIp(ip) {
        let normalized = String(ip || 'unknown').trim();
        if (!normalized) normalized = 'unknown';
        if (normalized === '::1') return '127.0.0.1';
        if (normalized.startsWith('::ffff:')) return normalized.slice(7);
        return normalized;
    }

    /**
     * Extract the real client IP from Express/WS request.
     * Prefers CF-Connecting-IP (set by Cloudflare, unforgeable through proxy),
     * then X-Forwarded-For first entry, then socket remote address.
     */
    getClientIp(req) {
        const raw = req.headers?.['cf-connecting-ip']
            || req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress
            || req.connection?.remoteAddress
            || 'unknown';
        return this.normalizeIp(raw);
    }

    getAnonIdForIp(ip) {
        const anonKey = this.normalizeIp(ip);
        if (!this.anonMap.has(anonKey)) {
            this.anonMap.set(anonKey, this.nextAnonId++);
        }
        return `anon${this.anonMap.get(anonKey)}`;
    }

    getAnonIdForConnection(ip, streamId = null) {
        const anonKey = this.normalizeIp(ip);
        for (const [, info] of this.clients) {
            if (info.ip !== anonKey || !info.anonId) continue;
            if (streamId == null || info.streamId === streamId) {
                return info.anonId;
            }
        }
        return this.getAnonIdForIp(anonKey);
    }

    /**
     * Attach to an existing HTTP server for WebSocket upgrade
     */
    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

        // Word filter
        wordFilter.load();

        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            if (!this.wss) return;

            const now = Date.now();
            for (const [ip, lastSeen] of this.rateLimits.entries()) {
                if ((now - lastSeen) > RATE_LIMIT_CACHE_TTL_MS) {
                    this.rateLimits.delete(ip);
                }
            }

            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    try { ws.terminate(); } catch {}
                    return;
                }
                ws.isAlive = false;
                try { ws.ping(); } catch {}
            });
        }, WS_HEARTBEAT_MS);

        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        console.log('[Chat] WebSocket chat server initialized');
        return this.wss;
    }

    /**
     * Handle WebSocket upgrade for chat connections
     */
    handleUpgrade(req, socket, head) {
        if (req.url.startsWith('/ws/chat')) {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
            return true;
        }
        return false;
    }

    /**
     * Handle a new chat connection
     */
    handleConnection(ws, req) {
        const ip = this.getClientIp(req);
        const urlParams = new URL(req.url, 'http://localhost').searchParams;
        const token = urlParams.get('token');
        const streamId = parseInt(urlParams.get('stream')) || null;

        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        try { ws._socket?.setNoDelay(true); } catch {}

        // Authenticate (optional — anon if no token)
        const user = authenticateWs(token);

        // Generate or reuse anon ID for this IP
        const anonId = user ? null : this.getAnonIdForConnection(ip, streamId);

        const clientInfo = {
            user,
            anonId,
            streamId,
            ip,
            joinedAt: Date.now(),
        };
        this.clients.set(ws, clientInfo);

        // Send welcome message
        this.sendTo(ws, {
            type: 'system',
            message: `Welcome${user ? `, ${user.display_name}` : ` ${anonId}`}. Use /help for help.${streamId ? ` You joined stream chat ${streamId}.` : ' You joined global chat.'}`,
            timestamp: new Date().toISOString(),
        });

        // Send user count update
        this.broadcastUserCount(streamId);

        // ── Message handler ──────────────────────────────────
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(ws, msg);
            } catch {
                // Ignore malformed messages
            }
        });

        ws.on('close', () => {
            this.clients.delete(ws);
            this.broadcastUserCount(streamId);
        });

        ws.on('error', () => {
            this.clients.delete(ws);
        });
    }

    /**
     * Handle incoming chat message
     */
    handleMessage(ws, msg) {
        const client = this.clients.get(ws);
        if (!client) return;

        // Rate limiting (only for chat messages, not join/leave)
        if (msg.type === 'chat') {
            const now = Date.now();
            const rateKey = `${client.ip}:${client.streamId || 'global'}`;
            const lastMsg = this.rateLimits.get(rateKey) || 0;
            const streamSlowMs = this.slowModeByStream.get(client.streamId) || 0;
            const effectiveLimit = Math.max(this.DEFAULT_RATE_LIMIT_MS, streamSlowMs);
            if (now - lastMsg < effectiveLimit) {
                this.sendTo(ws, { type: 'system', message: 'Slow down! You are sending messages too fast.' });
                return;
            }
            this.rateLimits.set(rateKey, now);
        }

        switch (msg.type) {
            case 'chat':
                this.handleChatMessage(ws, client, msg);
                break;
            case 'join':
            case 'join_stream': {
                // (Re-)authenticate if a token is provided
                if (msg.token) {
                    const user = authenticateWs(msg.token);
                    if (user) {
                        client.user = user;
                        client.anonId = null; // no longer anonymous
                    }
                }
                const oldStream = client.streamId;
                client.streamId = parseInt(msg.streamId || msg.stream_id) || null;
                // Update viewer counts for old and new streams
                if (oldStream !== client.streamId) {
                    if (oldStream) this.broadcastUserCount(oldStream);
                    this.broadcastUserCount(client.streamId);
                }
                // Send identity confirmation so the client knows who it is
                const displayName = client.user ? (client.user.display_name || client.user.username) : client.anonId;
                const streamSlowSec = client.streamId ? Math.round((this.slowModeByStream.get(client.streamId) || 0) / 1000) : 0;
                this.sendTo(ws, {
                    type: 'auth',
                    authenticated: !!client.user,
                    username: displayName,
                    role: client.user ? client.user.role : 'anon',
                    user_id: client.user?.id || null,
                    slowmode_seconds: streamSlowSec,
                });
                break;
            }
            case 'leave_stream':
                client.streamId = null;
                break;
            default:
                break;
        }
    }

    /**
     * Handle a chat message
     */
    handleChatMessage(ws, client, msg) {
        let text = (msg.message || '').trim();
        if (!text || text.length > 500) return;

        // ── Chat commands ────────────────────────────────────
        if (text.startsWith('/')) {
            this.handleCommand(ws, client, text);
            return;
        }

        // ── Word filter ──────────────────────────────────────
        const filterResult = wordFilter.check(text);
        if (!filterResult.safe) {
            text = filterResult.filtered;
        }

        // ── Spam check ───────────────────────────────────────
        if (wordFilter.isSpam(text)) {
            this.sendTo(ws, { type: 'system', message: 'Message blocked: detected as spam.' });
            return;
        }

        // ── Ban check ────────────────────────────────────────
        if (client.user && db.isUserBanned(client.user.id, client.streamId)) {
            this.sendTo(ws, { type: 'system', message: 'You are banned from this chat.' });
            return;
        }
        if (db.isIpBanned(client.ip, client.streamId)) {
            this.sendTo(ws, { type: 'system', message: 'You are banned from this chat.' });
            return;
        }

        const username = client.user ? client.user.display_name : client.anonId;
        const role = client.user ? client.user.role : 'anon';

        const chatMsg = {
            type: 'chat',
            username,
            user_id: client.user?.id || null,
            anon_id: client.anonId,
            role,
            message: text,
            stream_id: client.streamId,
            is_global: !client.streamId,
            avatar_url: client.user?.avatar_url || null,
            profile_color: client.user?.profile_color || '#999',
            filtered: !filterResult.safe,
            timestamp: new Date().toISOString(),
        };

        // Attach cosmetic data for chat rendering
        if (client.user?.id) {
            try {
                const cosmeticProfile = cosmetics.getCosmeticProfile(client.user.id);
                if (cosmeticProfile.nameFX) chatMsg.nameFX = cosmeticProfile.nameFX;
                if (cosmeticProfile.particleFX) chatMsg.particleFX = cosmeticProfile.particleFX;
                if (cosmeticProfile.hatFX) chatMsg.hatFX = cosmeticProfile.hatFX;
                if (cosmeticProfile.voiceFX) chatMsg.voiceFX = cosmeticProfile.voiceFX;
            } catch { /* non-critical */ }

            // Attach equipped tag for chat rendering
            try {
                const tags = require('../game/tags');
                const tagProfile = tags.getTagProfile(client.user.id);
                if (tagProfile) chatMsg.tag = tagProfile;
            } catch { /* non-critical */ }
        }

        // Save to database
        try {
            db.saveChatMessage({
                stream_id: client.streamId || null,
                user_id: client.user?.id,
                anon_id: client.anonId,
                username,
                message: text,
                message_type: 'chat',
                is_global: !client.streamId,
            });
        } catch { /* non-critical */ }

        // Award Hobo Coins for chatting (logged-in users only)
        if (client.user?.id && client.streamId) {
            try {
                const hoboCoins = require('../monetization/hobo-coins');
                const coinResult = hoboCoins.awardChat(client.user.id, client.streamId);
                if (coinResult) {
                    this.sendTo(ws, {
                        type: 'coin_earned',
                        coins: coinResult.coins,
                        total: coinResult.total,
                        reason: 'Chat bonus',
                    });
                }
            } catch { /* non-critical */ }
        }

        // Broadcast to appropriate audience
        if (client.streamId) {
            // Stream-specific chat
            this.broadcastToStream(client.streamId, chatMsg);
            // Also forward to global chat clients so the global feed sees all activity
            this.forwardToGlobal(client.streamId, chatMsg);

            // Trigger server-side TTS synthesis (async, non-blocking)
            this.synthesizeAndBroadcastTTS(
                client.streamId,
                username,
                text,
                chatMsg.voiceFX
            );
        } else {
            // Global chat
            this.broadcastGlobal(chatMsg);
        }
    }

    /**
     * Handle chat commands
     */
    handleCommand(ws, client, text) {
        const parts = text.slice(1).split(' ');
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ');
        const argParts = parts.slice(1);

        switch (cmd) {
            case 'help':
                this.sendTo(ws, {
                    type: 'system',
                    message: `Commands: /help, /tts <message>, /color <#hex>, /viewers, /uptime, /me <action>, /paste <content>` +
                        (this.canModerate(client)
                            ? `\nMod: /ban <user>, /unban <user>, /timeout <user> [seconds], /clear, /slow <seconds>`
                            : ''),
                });
                break;

            case 'tts':
                if (!args) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /tts <message>' });
                    return;
                }
                {
                    const ttsMsg = {
                        type: 'tts',
                        username: client.user?.display_name || client.anonId,
                        message: args,
                        timestamp: new Date().toISOString(),
                    };
                    // Attach voice cosmetic if equipped
                    let voiceFX = null;
                    if (client.user?.id) {
                        try {
                            const cp = cosmetics.getCosmeticProfile(client.user.id);
                            if (cp.voiceFX) {
                                ttsMsg.voiceFX = cp.voiceFX;
                                voiceFX = cp.voiceFX;
                            }
                        } catch { /* non-critical */ }
                    }
                    this.broadcastToStream(client.streamId, ttsMsg);

                    // Also synthesize server-side TTS for site-wide mode
                    this.synthesizeAndBroadcastTTS(
                        client.streamId,
                        ttsMsg.username,
                        args,
                        voiceFX
                    );
                }
                break;

            case 'color':
                if (!client.user) {
                    this.sendTo(ws, { type: 'system', message: 'You must be logged in to change color.' });
                } else if (!args || !/^#[0-9a-fA-F]{6}$/.test(args)) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /color #ff00ff (hex color code)' });
                } else {
                    db.run('UPDATE users SET profile_color = ? WHERE id = ?', [args, client.user.id]);
                    client.user.profile_color = args;
                    this.sendTo(ws, { type: 'system', message: `Color set to ${args}` });
                }
                break;

            case 'viewers': {
                const count = this.getStreamViewerCount(client.streamId);
                this.sendTo(ws, { type: 'system', message: `${count} viewer(s) in chat` });
                break;
            }

            case 'uptime': {
                if (!client.streamId) {
                    this.sendTo(ws, { type: 'system', message: 'Not in a stream chat.' });
                    break;
                }
                try {
                    const stream = db.getStreamById(client.streamId);
                    if (stream && stream.started_at) {
                        const start = new Date(stream.started_at.replace(' ', 'T') + 'Z').getTime();
                        const elapsed = Date.now() - start;
                        const hours = Math.floor(elapsed / 3600000);
                        const minutes = Math.floor((elapsed % 3600000) / 60000);
                        const seconds = Math.floor((elapsed % 60000) / 1000);
                        const parts = [];
                        if (hours > 0) parts.push(`${hours}h`);
                        parts.push(`${minutes}m`);
                        parts.push(`${seconds}s`);
                        this.sendTo(ws, { type: 'system', message: `Stream uptime: ${parts.join(' ')}` });
                    } else {
                        this.sendTo(ws, { type: 'system', message: 'Stream is offline.' });
                    }
                } catch {
                    this.sendTo(ws, { type: 'system', message: 'Could not determine uptime.' });
                }
                break;
            }

            case 'w':
            case 'whisper':
            case 'msg': {
                this.sendTo(ws, { type: 'system', message: 'Whispers have been replaced by DMs! Click the message icon in the navbar to open Messenger.' });
                break;
            }

            case 'me': {
                if (!args) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /me <action>' });
                    break;
                }
                const username = client.user?.display_name || client.anonId;
                this.broadcastToStream(client.streamId, {
                    type: 'chat',
                    username,
                    role: client.user?.role || 'anon',
                    message: `* ${username} ${args}`,
                    is_action: true,
                    timestamp: new Date().toISOString(),
                });
                break;
            }

            case 'ban':
                this.handleModAction(ws, client, 'ban', args);
                break;

            case 'unban':
                this.handleModAction(ws, client, 'unban', args);
                break;

            case 'timeout':
                this.handleModAction(ws, client, 'timeout', args);
                break;

            case 'clear':
                if (this.canModerate(client)) {
                    this.broadcastToStream(client.streamId, { type: 'clear' });
                } else {
                    this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
                }
                break;

            case 'slow': {
                if (this.canModerate(client)) {
                    let seconds;
                    if (args === 'off' || args === 'disable' || args === '0') {
                        seconds = 0;
                    } else {
                        seconds = parseInt(args);
                        if (!Number.isFinite(seconds) || seconds < 0) seconds = 3;
                    }
                    // Per-stream slow mode (not global)
                    if (client.streamId) {
                        this.slowModeByStream.set(client.streamId, seconds > 0 ? seconds * 1000 : 0);
                        // Persist to DB
                        try {
                            const stream = db.getStreamById(client.streamId);
                            if (stream?.channel_id) {
                                db.upsertChannelModerationSettings(stream.channel_id, { slow_mode_seconds: seconds });
                            }
                        } catch { /* non-critical */ }
                    }
                    // Dedicated slowmode event so clients can show/hide UI
                    this.broadcastToStream(client.streamId, {
                        type: 'slowmode',
                        seconds,
                    });
                    const msg = seconds > 0
                        ? `Slow mode enabled: ${seconds}s between messages`
                        : 'Slow mode disabled.';
                    this.broadcastToStream(client.streamId, {
                        type: 'system',
                        message: msg,
                    });
                } else {
                    this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
                }
                break;
            }

            case 'paste': {
                // /paste <content> — create a quick paste from chat
                if (!args.trim()) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /paste <content to share>' });
                    break;
                }
                try {
                    const crypto = require('crypto');
                    const slug = crypto.randomBytes(6).toString('base64url').slice(0, 8);
                    const title = `Chat paste by ${client.username || client.displayName || 'anon'}`;
                    const userId = client.userId || null;
                    db.createPaste({
                        slug,
                        userId,
                        type: 'paste',
                        title,
                        content: args.trim(),
                        language: 'auto',
                        visibility: 'public',
                        streamId: client.streamId || null,
                        ipAddress: client.ip || null,
                    });
                    const siteUrl = process.env.SITE_URL || '';
                    const pasteUrl = `${siteUrl}/p/${slug}`;
                    // Show link to everyone in stream
                    this.broadcastToStream(client.streamId, {
                        type: 'system',
                        message: `📋 ${client.displayName || client.username || 'Anonymous'} shared a paste: ${pasteUrl}`,
                    });
                } catch (err) {
                    console.error('[Chat] /paste error:', err);
                    this.sendTo(ws, { type: 'system', message: 'Failed to create paste.' });
                }
                break;
            }

            default:
                this.sendTo(ws, { type: 'system', message: `Unknown command: /${cmd}. Type /help for a list.` });
        }
    }

    /**
     * Handle mod actions (ban, unban, timeout)
     */
    handleModAction(ws, client, action, args) {
        if (!this.canModerate(client)) {
            this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
            return;
        }

        const target = args.split(' ')[0];
        if (!target) return;

        switch (action) {
            case 'ban': {
                const targetUser = db.getUserByUsername(target);
                if (targetUser) {
                    db.run(
                        `INSERT INTO bans (stream_id, user_id, reason, banned_by) VALUES (?, ?, ?, ?)`,
                        [client.streamId, targetUser.id, 'Banned by moderator', client.user.id]
                    );
                    this.sendTo(ws, { type: 'system', message: `${target} has been banned.` });
                    this.broadcastToStream(client.streamId, {
                        type: 'system', message: `${target} has been banned.`
                    });
                } else {
                    // Ban by anon ID
                    const anonTarget = this.findClientByAnonId(target, client.streamId);
                    if (anonTarget) {
                        db.run(
                            `INSERT INTO bans (stream_id, ip_address, anon_id, reason, banned_by) VALUES (?, ?, ?, ?, ?)`,
                            [client.streamId, anonTarget.ip, target, 'Banned by moderator', client.user.id]
                        );
                        this.sendTo(ws, { type: 'system', message: `${target} has been banned.` });
                    }
                }
                break;
            }
            case 'timeout': {
                const duration = parseInt(args.split(' ')[1]) || 300; // Default 5 min
                const targetUser = db.getUserByUsername(target);
                const expires = new Date(Date.now() + duration * 1000).toISOString();
                if (targetUser) {
                    db.run(
                        `INSERT INTO bans (stream_id, user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
                        [client.streamId, targetUser.id, `Timeout ${duration}s`, client.user.id, expires]
                    );
                }
                this.sendTo(ws, { type: 'system', message: `${target} timed out for ${duration}s.` });
                break;
            }
            case 'unban': {
                const targetUser = db.getUserByUsername(target);
                if (targetUser) {
                    db.run('DELETE FROM bans WHERE user_id = ? AND (stream_id = ? OR stream_id IS NULL)',
                        [targetUser.id, client.streamId]);
                }
                this.sendTo(ws, { type: 'system', message: `${target} has been unbanned.` });
                break;
            }
        }
    }

    // ── Helper methods ───────────────────────────────────────
    /**
     * Synthesize TTS audio for a chat message and broadcast to stream.
     * Runs asynchronously — does not block message delivery.
     */
    async synthesizeAndBroadcastTTS(streamId, username, text, voiceFX) {
        try {
            const settings = ttsEngine.getTTSSettings();
            if (!settings.enabled) return;

            // Queue limit checks
            const limits = ttsEngine.getQueueLimits();
            const globalCount = this.ttsQueueSize.get(streamId) || 0;
            if (globalCount >= limits.maxGlobal) return;

            // Determine voice ID from equipped cosmetic
            let voiceId = settings.defaultVoice;
            if (voiceFX?.itemId) {
                // Check if this cosmetic voice exists in the TTS engine catalog
                if (ttsEngine.VOICE_CATALOG[voiceFX.itemId]) {
                    voiceId = voiceFX.itemId;
                }
            }

            // Increment queue counter
            this.ttsQueueSize.set(streamId, globalCount + 1);

            const result = await ttsEngine.synthesize(text, voiceId);

            // Decrement queue counter
            const current = this.ttsQueueSize.get(streamId) || 1;
            this.ttsQueueSize.set(streamId, Math.max(0, current - 1));

            if (!result) return;

            // Broadcast TTS audio to all clients in the stream
            this.broadcastToStream(streamId, {
                type: 'tts-audio',
                username,
                message: text,
                audio: result.audio,
                mimeType: result.mimeType,
                engine: result.engine,
                voiceName: result.voiceName,
                voiceId: result.voiceId,
                fallback: result.fallback || false,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            // Ensure queue counter is decremented on error
            const current = this.ttsQueueSize.get(streamId) || 1;
            this.ttsQueueSize.set(streamId, Math.max(0, current - 1));
            console.error('[TTS] Synthesis broadcast error:', err.message);
        }
    }
    /**
     * Can this client moderate their current stream's chat?
     * Uses the permission layer: admin, global_mod, stream owner, or channel mod.
     * Streamers do NOT get mod powers in other people's chats.
     */
    canModerate(client) {
        if (!client.user) return false;
        return permissions.canModerateStream(client.user, client.streamId);
    }

    /** @deprecated Use canModerate(client) — kept temporarily for any external callers */
    isMod(client) {
        return this.canModerate(client);
    }

    findClientByAnonId(anonId, streamId) {
        for (const [, info] of this.clients) {
            if (info.anonId === anonId && info.streamId === streamId) {
                return info;
            }
        }
        return null;
    }

    /**
     * Find the IP address of a connected user by user ID.
     * Returns the IP from their most recent connection, or null if not connected.
     */
    getConnectedUserIp(userId) {
        for (const [, info] of this.clients) {
            if (info.user?.id === userId) return info.ip;
        }
        return null;
    }

    /**
     * Disconnect all WebSocket clients for a given user ID or IP.
     * Used after banning to immediately kick them.
     */
    disconnectUser({ userId, ip, streamId } = {}) {
        for (const [ws, info] of this.clients) {
            const matchUser = userId && info.user?.id === userId;
            const matchIp = ip && info.ip === ip;
            const matchStream = streamId ? info.streamId === streamId : true;
            if ((matchUser || matchIp) && matchStream) {
                this.sendTo(ws, { type: 'system', message: 'You have been banned.' });
                try { ws.close(1000, 'banned'); } catch {}
            }
        }
    }

    findWsByUsername(name, streamId) {
        const nameLower = name.toLowerCase();
        for (const [ws, info] of this.clients) {
            if (info.streamId !== streamId) continue;
            const uname = info.user?.display_name || info.user?.username || info.anonId;
            if (uname && uname.toLowerCase() === nameLower) return ws;
        }
        return null;
    }

    sendTo(ws, data) {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
            ws.send(JSON.stringify(data));
        }
    }

    broadcastToStream(streamId, data) {
        const msg = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (client.streamId === streamId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(msg);
            }
        }
    }

    broadcastGlobal(data) {
        const msg = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (!client.streamId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(msg);
            }
        }
    }

    /**
     * Forward a stream message to all global-connected clients
     * so the global chat feed shows activity from every stream.
     */
    forwardToGlobal(streamId, data) {
        // Look up stream owner username (cached per stream in a simple Map)
        if (!this._streamNameCache) this._streamNameCache = new Map();
        let streamUsername = this._streamNameCache.get(streamId);
        if (!streamUsername) {
            try {
                const stream = db.getStreamById(streamId);
                streamUsername = stream?.username || `stream-${streamId}`;
                this._streamNameCache.set(streamId, streamUsername);
                // Auto-expire cache after 5 min
                setTimeout(() => this._streamNameCache.delete(streamId), 300000);
            } catch {
                streamUsername = `stream-${streamId}`;
            }
        }
        const globalMsg = JSON.stringify({ ...data, stream_channel: streamUsername });
        for (const [ws, client] of this.clients) {
            if (!client.streamId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(globalMsg);
            }
        }
    }

    broadcastUserCount(streamId) {
        const count = this.getStreamViewerCount(streamId);
        const data = JSON.stringify({ type: 'user-count', count, stream_id: streamId });
        for (const [ws, client] of this.clients) {
            if (client.streamId === streamId && ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        }
        // Persist to DB so the /api/streams endpoint returns real counts
        if (streamId) {
            try { db.updateViewerCount(streamId, count); } catch {}
        }
    }

    /**
     * Count unique IPs watching a stream (not raw connections).
     * Multiple tabs from the same IP count as one viewer.
     */
    getStreamViewerCount(streamId) {
        const ips = new Set();
        for (const [, client] of this.clients) {
            if (client.streamId === streamId && client.ip) {
                ips.add(client.ip);
            }
        }
        return ips.size;
    }

    getTotalConnections() {
        return this.clients.size;
    }

    /**
     * Send a DM payload to all WebSocket connections belonging to a given user ID.
     * Used by the DM REST API for real-time delivery.
     */
    sendDm(userId, data) {
        const payload = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (client.user?.id === userId && ws.readyState === WebSocket.OPEN) {
                try {
                    if (ws.bufferedAmount < MAX_SEND_BACKPRESSURE) {
                        ws.send(payload);
                    }
                } catch { /* non-critical */ }
            }
        }
    }

    close() {
        if (this.wss) {
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            this.wss.clients.forEach(ws => ws.close());
            this.wss.close();
        }
    }
}

module.exports = new ChatServer();
