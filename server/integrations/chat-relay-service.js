/**
 * HoboStreamer — External Chat Relay Service
 *
 * Relays chat from Twitch (IRC), Kick (Pusher WebSocket), and YouTube (scrape/API)
 * into HoboStreamer stream chat. Uses anonymous read-only connections — no auth tokens
 * needed for Twitch or Kick. YouTube requires either an API key or scraping.
 *
 * Architecture:
 *   - Each active restream destination with `chat_relay=1` and a `channel_url` gets a bridge
 *   - Bridges are keyed by `${streamId}:${destId}` to avoid duplicates
 *   - Messages are transformed to HoboStreamer chat format with `role: 'external'`
 *   - Bridges auto-reconnect with exponential backoff on disconnect
 *   - All bridges are cleaned up when the stream ends
 *
 * Uses the same pattern as robotstreamer-service.js chat bridges.
 */
const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const db = require('../db/database');
const chatServer = require('../chat/chat-server');

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

// Platform-specific colors for chat display
const PLATFORM_COLORS = {
    twitch: '#9146ff',
    kick: '#53fc18',
    youtube: '#ff0000',
};

const PLATFORM_LABELS = {
    twitch: 'TTV',
    kick: 'Kick',
    youtube: 'YT',
};

function safeJsonParse(str, fallback = null) {
    try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Extract platform and channel name from a URL.
 * @param {string} url - Channel URL (e.g. https://twitch.tv/username)
 * @returns {{ platform: string, channelName: string } | null}
 */
function parseChannelUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase().replace('www.', '');
        const pathParts = u.pathname.split('/').filter(Boolean);

        if (host.includes('twitch.tv') && pathParts[0]) {
            return { platform: 'twitch', channelName: pathParts[0].toLowerCase() };
        }
        if (host.includes('kick.com') && pathParts[0]) {
            const result = { platform: 'kick', channelName: pathParts[0].toLowerCase() };
            // Support ?chatroom=ID for bypassing Kick's Cloudflare-blocked API
            const chatroomParam = u.searchParams.get('chatroom');
            if (chatroomParam && /^\d+$/.test(chatroomParam)) {
                result.chatroomId = parseInt(chatroomParam, 10);
            }
            return result;
        }
        if (host.includes('youtube.com')) {
            // Handle youtube.com/live/VIDEO_ID, youtube.com/watch?v=VIDEO_ID, youtube.com/@channel
            if (pathParts[0] === 'live' && pathParts[1]) {
                return { platform: 'youtube', channelName: pathParts[1] };
            }
            if (pathParts[0] === 'watch') {
                const v = u.searchParams.get('v');
                if (v) return { platform: 'youtube', channelName: v };
            }
            if (pathParts[0]?.startsWith('@')) {
                return { platform: 'youtube', channelName: pathParts[0] };
            }
            if (pathParts[0] === 'channel' && pathParts[1]) {
                return { platform: 'youtube', channelName: pathParts[1] };
            }
        }
        if (host.includes('youtu.be') && pathParts[0]) {
            return { platform: 'youtube', channelName: pathParts[0] };
        }
    } catch {}
    return null;
}

class ChatRelayService {
    constructor() {
        /** @type {Map<string, object>} key = `${streamId}:${destId}` → bridge object */
        this.bridges = new Map();
    }

    /**
     * Start chat relay for all eligible restream destinations of a stream.
     * Called when a stream goes live or restream starts.
     */
    async startForStream(stream) {
        if (!stream?.id || !stream?.user_id) return;

        const destinations = db.getRestreamDestinationsByUserId(stream.user_id) || [];
        for (const dest of destinations) {
            if (!dest.enabled || !dest.chat_relay || !dest.channel_url) continue;
            this.startBridge(stream.id, dest);
        }
    }

    /**
     * Start a single chat relay bridge for a destination.
     */
    startBridge(streamId, dest) {
        const key = `${streamId}:${dest.id}`;
        if (this.bridges.has(key)) return; // already running

        const parsed = parseChannelUrl(dest.channel_url);
        if (!parsed) {
            console.warn(`[ChatRelay] Cannot parse channel URL for dest ${dest.id}: ${dest.channel_url}`);
            return;
        }

        const bridge = {
            key,
            streamId,
            destId: dest.id,
            platform: parsed.platform,
            channelName: parsed.channelName,
            chatroomId: parsed.chatroomId || null, // Kick chatroom ID from URL query
            channelUrl: dest.channel_url,
            destName: dest.name || PLATFORM_LABELS[parsed.platform] || parsed.platform,
            stopped: false,
            ws: null,
            pollTimer: null,
            reconnectDelay: RECONNECT_BASE_MS,
            reconnectTimer: null,
            disconnect: null,
        };

        this.bridges.set(key, bridge);

        switch (parsed.platform) {
            case 'twitch':
                this._connectTwitch(bridge);
                break;
            case 'kick':
                this._connectKick(bridge);
                break;
            case 'youtube':
                this._connectYouTube(bridge);
                break;
            default:
                console.warn(`[ChatRelay] Unsupported platform: ${parsed.platform}`);
                this.bridges.delete(key);
        }
    }

    /**
     * Stop all chat relay bridges for a stream.
     */
    stopForStream(streamId) {
        for (const [key, bridge] of this.bridges) {
            if (bridge.streamId === streamId) {
                this._teardown(bridge);
                this.bridges.delete(key);
            }
        }
    }

    /**
     * Stop a specific bridge by stream + destination ID.
     */
    stopBridge(streamId, destId) {
        const key = `${streamId}:${destId}`;
        const bridge = this.bridges.get(key);
        if (bridge) {
            this._teardown(bridge);
            this.bridges.delete(key);
        }
    }

    /**
     * Stop all bridges for a user's streams.
     */
    stopForUser(userId) {
        const streams = db.getLiveStreamsByUserId(userId) || [];
        for (const stream of streams) {
            this.stopForStream(stream.id);
        }
    }

    /**
     * Check if a relay bridge is active for a given stream + destination.
     */
    hasBridge(streamId, destId) {
        return this.bridges.has(`${streamId}:${destId}`);
    }

    /**
     * Sync relay bridges for a user after destination settings change.
     * Stops bridges for destinations that no longer have relay enabled,
     * starts bridges for newly enabled ones on all live streams.
     */
    syncForUser(userId) {
        const liveStreams = db.getLiveStreamsByUserId(userId) || [];
        if (!liveStreams.length) return;

        const destinations = db.getRestreamDestinationsByUserId(userId) || [];

        for (const stream of liveStreams) {
            // Stop bridges for disabled/removed relay destinations
            for (const [key, bridge] of this.bridges) {
                if (bridge.streamId !== stream.id) continue;
                const dest = destinations.find(d => d.id === bridge.destId);
                if (!dest || !dest.enabled || !dest.chat_relay || !dest.channel_url) {
                    console.log(`[ChatRelay] Stopping bridge ${key} — relay disabled or destination removed`);
                    this._teardown(bridge);
                    this.bridges.delete(key);
                }
            }

            // Start bridges for newly enabled destinations
            for (const dest of destinations) {
                if (!dest.enabled || !dest.chat_relay || !dest.channel_url) continue;
                if (!this.hasBridge(stream.id, dest.id)) {
                    console.log(`[ChatRelay] Starting new bridge for dest ${dest.id} (${dest.platform}) on stream ${stream.id}`);
                    this.startBridge(stream.id, dest);
                }
            }
        }
    }

    /**
     * Get active relay info for a stream (for the channel API).
     */
    getRelayInfo(streamId) {
        const relays = [];
        for (const [, bridge] of this.bridges) {
            if (bridge.streamId === streamId) {
                relays.push({
                    destId: bridge.destId,
                    platform: bridge.platform,
                    channelName: bridge.channelName,
                    channelUrl: bridge.channelUrl,
                    destName: bridge.destName,
                });
            }
        }
        return relays;
    }

    // ── Internal: teardown ────────────────────────────────────

    _teardown(bridge) {
        bridge.stopped = true;
        clearTimeout(bridge.reconnectTimer);
        clearTimeout(bridge.pollTimer);
        if (bridge.ws) {
            try { bridge.ws.close(1000); } catch {}
            bridge.ws = null;
        }
        if (typeof bridge.disconnect === 'function') {
            bridge.disconnect();
        }
    }

    _scheduleReconnect(bridge, connectFn) {
        if (bridge.stopped) return;
        clearTimeout(bridge.reconnectTimer);
        const delay = bridge.reconnectDelay;
        bridge.reconnectDelay = Math.min(bridge.reconnectDelay * 1.5, RECONNECT_MAX_MS);
        bridge.reconnectTimer = setTimeout(() => {
            if (!bridge.stopped) connectFn(bridge);
        }, delay);
    }

    _broadcastMessage(bridge, username, message, extras = {}) {
        const label = PLATFORM_LABELS[bridge.platform] || bridge.platform;
        const color = PLATFORM_COLORS[bridge.platform] || '#888';
        const prefixedUsername = `[${label}] ${username}`;

        const chatMsg = {
            type: 'chat',
            username: prefixedUsername,
            user_id: null,
            anon_id: null,
            role: 'external',
            message: String(message || ''),
            stream_id: bridge.streamId,
            is_global: false,
            avatar_url: extras.avatar_url || null,
            profile_color: color,
            timestamp: extras.timestamp || new Date().toISOString(),
            source_platform: bridge.platform,
        };

        try {
            db.saveChatMessage({
                stream_id: bridge.streamId,
                user_id: null,
                anon_id: null,
                username: prefixedUsername,
                message: chatMsg.message,
                message_type: 'chat',
                is_global: 0,
            });
        } catch {}

        chatServer.broadcastToStream(bridge.streamId, chatMsg);
    }

    // ── Twitch IRC ────────────────────────────────────────────

    _connectTwitch(bridge) {
        if (bridge.stopped) return;

        const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
        bridge.ws = ws;

        ws.on('open', () => {
            bridge.reconnectDelay = RECONNECT_BASE_MS;
            // Anonymous read-only connection
            ws.send('NICK justinfan' + Math.floor(Math.random() * 99999 + 1));
            ws.send('CAP REQ :twitch.tv/tags');
            ws.send(`JOIN #${bridge.channelName}`);
            console.log(`[ChatRelay] Twitch: Connected to #${bridge.channelName} for stream ${bridge.streamId}`);
        });

        ws.on('message', (raw) => {
            const data = raw.toString();
            const lines = data.split('\r\n').filter(Boolean);

            for (const line of lines) {
                // Respond to PING to stay connected
                if (line.startsWith('PING')) {
                    ws.send('PONG :tmi.twitch.tv');
                    continue;
                }

                // Parse PRIVMSG (with optional tags prefix)
                const match = line.match(
                    /^(?:@(\S+)\s)?:(\w+)!\w+@\w+\.tmi\.twitch\.tv\s+PRIVMSG\s+#(\w+)\s+:(.+)$/
                );
                if (match) {
                    const [, tagsStr, username, , message] = match;

                    // Parse display-name from tags if available
                    let displayName = username;
                    if (tagsStr) {
                        const dnMatch = tagsStr.match(/display-name=([^;]*)/);
                        if (dnMatch && dnMatch[1]) displayName = dnMatch[1];
                    }

                    this._broadcastMessage(bridge, displayName, message);
                }
            }
        });

        ws.on('close', () => {
            if (bridge.stopped) return;
            console.log(`[ChatRelay] Twitch: Disconnected from #${bridge.channelName} — reconnecting`);
            this._scheduleReconnect(bridge, (b) => this._connectTwitch(b));
        });

        ws.on('error', (err) => {
            console.warn(`[ChatRelay] Twitch error for #${bridge.channelName}:`, err.message);
        });

        bridge.disconnect = () => {
            bridge.stopped = true;
            clearTimeout(bridge.reconnectTimer);
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                try { ws.close(1000); } catch {}
            }
            bridge.ws = null;
        };
    }

    // ── Kick (Pusher Protocol) ────────────────────────────────

    async _connectKick(bridge) {
        if (bridge.stopped) return;

        // Step 1: Resolve chatroom ID — use pre-parsed from URL, or try API, or fall back to channel slug
        let chatroomId = bridge.chatroomId;
        if (!chatroomId) {
            try {
                chatroomId = await this._getKickChatroomId(bridge.channelName);
                bridge.chatroomId = chatroomId; // cache for reconnects
            } catch (err) {
                // Kick API is Cloudflare-blocked from servers — fall back to channel slug
                // This subscribes to `chatrooms.{slug}.v2` which may or may not work
                console.warn(`[ChatRelay] Kick: API blocked for ${bridge.channelName} (${err.message}) — using channel slug as chatroom ID`);
                chatroomId = bridge.channelName; // will produce `chatrooms.channelname.v2`
            }
        }

        if (bridge.stopped) return;

        // Step 2: Connect to Pusher
        const PUSHER_KEY = '32cbd69e4b950bf97679';
        const wsUrl = `wss://ws-us2.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.4.0-rc2&flash=false`;
        const ws = new WebSocket(wsUrl);
        bridge.ws = ws;

        let pingInterval = null;

        ws.on('open', () => {
            bridge.reconnectDelay = RECONNECT_BASE_MS;
        });

        ws.on('message', (raw) => {
            const msg = safeJsonParse(raw.toString());
            if (!msg) return;

            switch (msg.event) {
                case 'pusher:connection_established': {
                    // Subscribe to the chatroom
                    ws.send(JSON.stringify({
                        event: 'pusher:subscribe',
                        data: { channel: `chatrooms.${chatroomId}.v2` },
                    }));
                    console.log(`[ChatRelay] Kick: Connected to ${bridge.channelName} (room ${chatroomId}) for stream ${bridge.streamId}`);

                    // Keep-alive pings
                    const connData = safeJsonParse(msg.data);
                    const timeout = connData?.activity_timeout || 120;
                    pingInterval = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
                        }
                    }, (timeout - 10) * 1000);
                    break;
                }

                case 'App\\Events\\ChatMessageEvent': {
                    const payload = safeJsonParse(msg.data);
                    if (!payload?.sender?.username || !payload?.content) break;

                    this._broadcastMessage(bridge, payload.sender.username, payload.content);
                    break;
                }
            }
        });

        ws.on('close', () => {
            clearInterval(pingInterval);
            if (bridge.stopped) return;
            console.log(`[ChatRelay] Kick: Disconnected from ${bridge.channelName} — reconnecting`);
            this._scheduleReconnect(bridge, (b) => this._connectKick(b));
        });

        ws.on('error', (err) => {
            console.warn(`[ChatRelay] Kick error for ${bridge.channelName}:`, err.message);
        });

        bridge.disconnect = () => {
            bridge.stopped = true;
            clearInterval(pingInterval);
            clearTimeout(bridge.reconnectTimer);
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                try { ws.close(1000); } catch {}
            }
            bridge.ws = null;
        };
    }

    /**
     * Fetch the chatroom ID for a Kick channel.
     * @param {string} channelName - Kick channel slug
     * @returns {Promise<number>} chatroom ID
     */
    _getKickChatroomId(channelName) {
        return new Promise((resolve, reject) => {
            const req = https.get(`https://kick.com/api/v2/channels/${channelName}`, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
                timeout: 10000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        return reject(new Error(`Kick API returned ${res.statusCode}`));
                    }
                    const parsed = safeJsonParse(data);
                    if (!parsed?.chatroom?.id) {
                        return reject(new Error('No chatroom ID found in Kick API response'));
                    }
                    resolve(parsed.chatroom.id);
                });
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('Kick API request timed out')));
        });
    }

    // ── YouTube Live Chat (Scraping approach — no API key needed) ──

    async _connectYouTube(bridge) {
        if (bridge.stopped) return;

        // YouTube chat relay uses internal API scraping (no API key required).
        // The channel_url can be a video URL or a channel URL.
        // For live streams, we need the video ID to fetch the live chat.
        try {
            const videoId = await this._resolveYouTubeVideoId(bridge.channelName, bridge.channelUrl);
            if (!videoId) {
                console.warn(`[ChatRelay] YouTube: Could not resolve video ID for ${bridge.channelName}`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
                return;
            }

            if (bridge.stopped) return;

            const chatPageUrl = `https://www.youtube.com/live_chat?v=${videoId}&pbj=1`;
            const html = await this._httpGet(chatPageUrl, {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            });

            if (bridge.stopped) return;

            // Extract ytInitialData
            const match = html.match(/ytInitialData\s*=\s*({.+?});\s*<\/script>/s);
            if (!match) {
                console.warn(`[ChatRelay] YouTube: Could not extract ytInitialData for video ${videoId}`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
                return;
            }

            const ytData = safeJsonParse(match[1]);
            const chatContents = ytData?.contents?.liveChatRenderer;
            if (!chatContents) {
                console.warn(`[ChatRelay] YouTube: No liveChatRenderer found — stream may not be live`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
                return;
            }

            // Get initial continuation token
            const cont = chatContents.continuations?.[0];
            const continuationToken = cont?.invalidationContinuationData?.continuation
                || cont?.timedContinuationData?.continuation;

            if (!continuationToken) {
                console.warn(`[ChatRelay] YouTube: No continuation token found`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
                return;
            }

            console.log(`[ChatRelay] YouTube: Connected to video ${videoId} for stream ${bridge.streamId}`);
            bridge.reconnectDelay = RECONNECT_BASE_MS;

            // Start polling
            this._pollYouTubeChat(bridge, continuationToken);

        } catch (err) {
            console.warn(`[ChatRelay] YouTube: Setup failed for ${bridge.channelName}:`, err.message);
            this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
        }
    }

    async _pollYouTubeChat(bridge, continuationToken) {
        if (bridge.stopped || !continuationToken) return;

        try {
            const res = await this._httpPost('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false', {
                context: {
                    client: { clientName: 'WEB', clientVersion: '2.20250101.00.00' },
                },
                continuation: continuationToken,
            });

            const data = safeJsonParse(res);
            if (!data || bridge.stopped) return;

            const chatActions = data.continuationContents?.liveChatContinuation?.actions || [];
            for (const action of chatActions) {
                const renderer = action.addChatItemAction?.item?.liveChatTextMessageRenderer;
                if (!renderer) continue;

                const username = renderer.authorName?.simpleText || 'YouTube User';
                const messageParts = renderer.message?.runs?.map(r => r.text || '').join('') || '';
                if (messageParts) {
                    this._broadcastMessage(bridge, username, messageParts);
                }
            }

            // Get next continuation
            const nextCont = data.continuationContents?.liveChatContinuation?.continuations?.[0];
            const nextToken = nextCont?.invalidationContinuationData?.continuation
                || nextCont?.timedContinuationData?.continuation;
            const timeoutMs = nextCont?.timedContinuationData?.timeoutMs || 6000;

            if (nextToken && !bridge.stopped) {
                bridge.pollTimer = setTimeout(() => this._pollYouTubeChat(bridge, nextToken), timeoutMs);
            } else if (!bridge.stopped) {
                console.warn(`[ChatRelay] YouTube: Lost continuation token — reconnecting`);
                this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
            }
        } catch (err) {
            if (bridge.stopped) return;
            console.warn(`[ChatRelay] YouTube: Poll error:`, err.message);
            this._scheduleReconnect(bridge, (b) => this._connectYouTube(b));
        }
    }

    /**
     * Resolve a YouTube video ID from various URL formats.
     * If the input looks like a video ID already, use it directly.
     * If it's a channel handle (@name), try to find their live stream.
     */
    async _resolveYouTubeVideoId(channelName, channelUrl) {
        // If channelName is already a video ID (11 chars alphanumeric + dash/underscore)
        if (/^[a-zA-Z0-9_-]{11}$/.test(channelName)) {
            return channelName;
        }

        // Try fetching the channel page to find a live stream
        try {
            const url = channelUrl.includes('/watch') || channelUrl.includes('/live')
                ? channelUrl
                : channelUrl.replace(/\/?$/, '/live');
            const html = await this._httpGet(url, {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            });
            // Look for canonical video URL in the page
            const videoMatch = html.match(/\"videoId\":\"([a-zA-Z0-9_-]{11})\"/);
            if (videoMatch) return videoMatch[1];
            // Also try og:url meta tag
            const ogMatch = html.match(/content="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
            if (ogMatch) return ogMatch[1];
        } catch {}

        return null;
    }

    // ── HTTP Helpers ──────────────────────────────────────────

    _httpGet(url, headers = {}) {
        return new Promise((resolve, reject) => {
            const mod = url.startsWith('https') ? https : http;
            const req = mod.get(url, { headers, timeout: 15000 }, (res) => {
                // Follow redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(this._httpGet(res.headers.location, headers));
                }
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('HTTP request timed out')));
        });
    }

    _httpPost(url, body) {
        return new Promise((resolve, reject) => {
            const jsonBody = JSON.stringify(body);
            const mod = url.startsWith('https') ? https : http;
            const urlObj = new URL(url);
            const req = mod.request({
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(jsonBody),
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
                timeout: 15000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('HTTP request timed out')));
            req.write(jsonBody);
            req.end();
        });
    }
}

module.exports = new ChatRelayService();
