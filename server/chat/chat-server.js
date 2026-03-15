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
const { canModerateStream, isStaff } = require('../auth/permissions');
const wordFilter = require('./word-filter');
const cosmetics = require('../monetization/cosmetics');

class ChatServer {
    constructor() {
        this.wss = null;
        /** @type {Map<WebSocket, { user: object|null, anonId: string, streamId: number|null, ip: string }>} */
        this.clients = new Map();
        /** @type {Map<string, number>} IP → sequential anon number */
        this.anonMap = new Map();
        this.nextAnonId = 1;
        /** @type {Map<string, number>} IP → last message time (rate limiting) */
        this.rateLimits = new Map();
        this.RATE_LIMIT_MS = 1000; // 1 message per second
    }

    getAnonIdForIp(ip) {
        const anonKey = ip || 'unknown';
        if (!this.anonMap.has(anonKey)) {
            this.anonMap.set(anonKey, this.nextAnonId++);
        }
        return `anon${this.anonMap.get(anonKey)}`;
    }

    getAnonIdForConnection(ip, streamId = null) {
        const anonKey = ip || 'unknown';
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
        this.wss = new WebSocket.Server({ noServer: true });

        // Word filter
        wordFilter.load();

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
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
        const urlParams = new URL(req.url, 'http://localhost').searchParams;
        const token = urlParams.get('token');
        const streamId = parseInt(urlParams.get('stream')) || null;

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
            const rateLimitKey = this.getRateLimitKey(client);
            const lastMsg = this.rateLimits.get(rateLimitKey) || 0;
            if (now - lastMsg < this.getSlowmodeMs(client)) {
                this.sendTo(ws, { type: 'system', message: 'Slow down! You are sending messages too fast.' });
                return;
            }
            this.rateLimits.set(rateLimitKey, now);
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
                this.sendTo(ws, {
                    type: 'auth',
                    authenticated: !!client.user,
                    username: displayName,
                    role: client.user ? client.user.role : 'anon',
                    user_id: client.user?.id || null,
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
        if (!text) return;

        const chatSettings = this.getChatSettings(client);
        const maxLength = Math.max(50, Number(chatSettings.max_message_length || 500));
        if (text.length > maxLength) {
            this.sendTo(ws, { type: 'system', message: `Message too long. Max ${maxLength} characters.` });
            return;
        }

        if (client.streamId && !client.user && !chatSettings.allow_anonymous) {
            this.sendTo(ws, { type: 'system', message: 'This channel requires a logged-in account to chat.' });
            return;
        }
        if (client.streamId && chatSettings.links_allowed === 0 && /(https?:\/\/|www\.)/i.test(text)) {
            this.sendTo(ws, { type: 'system', message: 'Links are disabled in this channel chat.' });
            return;
        }
        if (client.streamId && chatSettings.followers_only && client.user) {
            const stream = db.getStreamById(client.streamId);
            if (stream && stream.user_id !== client.user.id && !db.isFollowing(client.user.id, stream.user_id) && !isStaff(client.user)) {
                this.sendTo(ws, { type: 'system', message: 'This chat is currently followers-only.' });
                return;
            }
        }
        if (client.streamId && chatSettings.account_age_gate_hours && client.user && !isStaff(client.user)) {
            const ageMs = Date.now() - new Date(client.user.created_at).getTime();
            if (ageMs < Number(chatSettings.account_age_gate_hours) * 3600000) {
                this.sendTo(ws, { type: 'system', message: `This chat requires accounts older than ${chatSettings.account_age_gate_hours} hour(s).` });
                return;
            }
        }
        if (client.streamId && chatSettings.caps_percentage_limit && text.length >= 8) {
            const letters = text.replace(/[^a-z]/gi, '');
            const caps = text.replace(/[^A-Z]/g, '');
            if (letters.length >= 6 && (caps.length / letters.length) * 100 > Number(chatSettings.caps_percentage_limit)) {
                this.sendTo(ws, { type: 'system', message: 'Please ease up on the all-caps.' });
                return;
            }
        }

        // ── Chat commands ────────────────────────────────────
        if (text.startsWith('/')) {
            this.handleCommand(ws, client, text);
            return;
        }

        // ── Word filter ──────────────────────────────────────
        const filterResult = wordFilter.check(text);
        if (!filterResult.safe) {
            if (client.streamId && chatSettings.aggressive_filter) {
                this.sendTo(ws, { type: 'system', message: 'Message blocked by channel moderation settings.' });
                return;
            }
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
                    message: `Commands: /help, /tts <message>, /color <#hex>, /viewers, /uptime, /w <user> <msg>, /me <action>` +
                        (this.isMod(client)
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
                    if (client.user?.id) {
                        try {
                            const cp = cosmetics.getCosmeticProfile(client.user.id);
                            if (cp.voiceFX) ttsMsg.voiceFX = cp.voiceFX;
                        } catch { /* non-critical */ }
                    }
                    this.broadcastToStream(client.streamId, ttsMsg);
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
                const targetName = argParts[0];
                const whisperMsg = argParts.slice(1).join(' ');
                if (!targetName || !whisperMsg) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /w <username> <message>' });
                    break;
                }
                const targetWs = this.findWsByUsername(targetName, client.streamId);
                if (targetWs) {
                    const senderName = client.user?.display_name || client.anonId;
                    this.sendTo(targetWs, { type: 'system', message: `[Whisper from ${senderName}]: ${whisperMsg}` });
                    this.sendTo(ws, { type: 'system', message: `[Whisper to ${targetName}]: ${whisperMsg}` });
                } else {
                    this.sendTo(ws, { type: 'system', message: `User "${targetName}" not found in chat.` });
                }
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
                if (this.isMod(client)) {
                    if (client.streamId) {
                        this.broadcastToStream(client.streamId, { type: 'clear' });
                    } else {
                        this.broadcastGlobal({ type: 'clear' });
                    }
                    this.logChatModeration(client, client.streamId ? 'clear_chat' : 'clear_global_chat');
                } else {
                    this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
                }
                break;

            case 'slow': {
                if (this.isMod(client)) {
                    const seconds = parseInt(args) || 3;
                    if (client.streamId) {
                        const stream = db.getStreamById(client.streamId);
                        const channel = stream?.channel_id ? db.getChannelById(stream.channel_id) : stream ? db.getChannelByUserId(stream.user_id) : null;
                        if (channel) {
                            db.upsertChannelModerationSettings(channel.id, { slowmode_seconds: seconds }, client.user.id);
                            this.broadcastToStream(client.streamId, {
                                type: 'system',
                                message: `Slow mode: ${seconds}s between messages`,
                            });
                            this.logChatModeration(client, 'slowmode_update', { seconds, channel_id: channel.id });
                        }
                    } else if (isStaff(client.user)) {
                        db.setSetting('chat_slowmode_seconds', seconds);
                        this.broadcastGlobal({
                            type: 'system',
                            message: `Global slow mode: ${seconds}s between messages`,
                        });
                        this.logChatModeration(client, 'global_slowmode_update', { seconds });
                    }
                } else {
                    this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
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
        if (!this.isMod(client)) {
            this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
            return;
        }

        const target = args.split(' ')[0];
        if (!target) return;

        switch (action) {
            case 'ban': {
                const targetUser = db.getUserByUsername(target);
                if (targetUser) {
                    if (isStaff(client.user) && targetUser.role === 'admin' && client.user.role !== 'admin') {
                        this.sendTo(ws, { type: 'system', message: 'You cannot ban an admin.' });
                        return;
                    }
                    db.run(
                        `INSERT INTO bans (stream_id, user_id, reason, banned_by) VALUES (?, ?, ?, ?)`,
                        [client.streamId, targetUser.id, 'Banned by moderator', client.user.id]
                    );
                    this.sendTo(ws, { type: 'system', message: `${target} has been banned.` });
                    this.broadcastToStream(client.streamId, {
                        type: 'system', message: `${target} has been banned.`
                    });
                    this.logChatModeration(client, client.streamId ? 'channel_ban' : 'site_ban', { username: targetUser.username }, targetUser.id);
                } else {
                    // Ban by anon ID
                    const anonTarget = this.findClientByAnonId(target, client.streamId);
                    if (anonTarget) {
                        db.run(
                            `INSERT INTO bans (stream_id, ip_address, anon_id, reason, banned_by) VALUES (?, ?, ?, ?, ?)`,
                            [client.streamId, anonTarget.ip, target, 'Banned by moderator', client.user.id]
                        );
                        this.sendTo(ws, { type: 'system', message: `${target} has been banned.` });
                        this.logChatModeration(client, client.streamId ? 'channel_anon_ban' : 'site_anon_ban', { anon_id: target, ip: anonTarget.ip });
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
                    this.logChatModeration(client, client.streamId ? 'channel_timeout' : 'site_timeout', { username: targetUser.username, duration }, targetUser.id);
                }
                this.sendTo(ws, { type: 'system', message: `${target} timed out for ${duration}s.` });
                break;
            }
            case 'unban': {
                const targetUser = db.getUserByUsername(target);
                if (targetUser) {
                    db.run('DELETE FROM bans WHERE user_id = ? AND (stream_id = ? OR stream_id IS NULL)',
                        [targetUser.id, client.streamId]);
                    this.logChatModeration(client, client.streamId ? 'channel_unban' : 'site_unban', { username: targetUser.username }, targetUser.id);
                }
                this.sendTo(ws, { type: 'system', message: `${target} has been unbanned.` });
                break;
            }
        }
    }

    // ── Helper methods ───────────────────────────────────────

    isMod(client) {
        if (!client.user) return false;
        if (!client.streamId) return isStaff(client.user);
        return canModerateStream(client.user, client.streamId);
    }

    getRateLimitKey(client) {
        return `${client.streamId || 'global'}:${client.user?.id || client.ip}`;
    }

    getChatSettings(client) {
        if (!client.streamId) {
            return {
                slowmode_seconds: Number(db.getSetting('chat_slowmode_seconds') || 0),
                allow_anonymous: 1,
                links_allowed: 1,
                aggressive_filter: 0,
                followers_only: 0,
                account_age_gate_hours: 0,
                caps_percentage_limit: 90,
                max_message_length: 500,
            };
        }

        const stream = db.getStreamById(client.streamId);
        const channel = stream?.channel_id ? db.getChannelById(stream.channel_id) : stream ? db.getChannelByUserId(stream.user_id) : null;
        return channel ? db.getChannelModerationSettings(channel.id) : {
            slowmode_seconds: 0,
            allow_anonymous: 1,
            links_allowed: 1,
            aggressive_filter: 0,
            followers_only: 0,
            account_age_gate_hours: 0,
            caps_percentage_limit: 70,
            max_message_length: 500,
        };
    }

    getSlowmodeMs(client) {
        const settings = this.getChatSettings(client);
        const seconds = Number(settings.slowmode_seconds || 0);
        return Math.max(1000, seconds > 0 ? seconds * 1000 : this.RATE_LIMIT_MS);
    }

    logChatModeration(client, actionType, details = {}, targetUserId = null) {
        const stream = client.streamId ? db.getStreamById(client.streamId) : null;
        const channel = stream?.channel_id ? db.getChannelById(stream.channel_id) : stream ? db.getChannelByUserId(stream.user_id) : null;
        db.logModerationAction({
            scope_type: channel ? 'channel' : 'site',
            scope_id: channel?.id || null,
            actor_user_id: client.user?.id || null,
            target_user_id: targetUserId,
            action_type: actionType,
            details: {
                stream_id: client.streamId || null,
                ...details,
            },
            ip_address: client.ip,
        });
    }

    findClientByAnonId(anonId, streamId) {
        for (const [, info] of this.clients) {
            if (info.anonId === anonId && info.streamId === streamId) {
                return info;
            }
        }
        return null;
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
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    broadcastToStream(streamId, data) {
        const msg = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (client.streamId === streamId && ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        }
    }

    broadcastGlobal(data) {
        const msg = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (!client.streamId && ws.readyState === WebSocket.OPEN) {
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
            if (!client.streamId && ws.readyState === WebSocket.OPEN) {
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

    close() {
        if (this.wss) {
            this.wss.clients.forEach(ws => ws.close());
            this.wss.close();
        }
    }
}

module.exports = new ChatServer();
