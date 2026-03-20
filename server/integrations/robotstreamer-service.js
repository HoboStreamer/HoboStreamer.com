const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');

const db = require('../db/database');
const chatServer = require('../chat/chat-server');
const { authenticateWs } = require('../auth/auth');

const API_HOST = 'api.robotstreamer.com';
const API_PORT = 443;
const RS_ORIGIN = 'https://robotstreamer.com';

function safeJsonParse(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined) return fallback;
    return value === true || value === 1 || value === '1' || value === 'true';
}

// Minimum interval between RS Publish connections for the same stream (prevents rapid reconnect loops)
const RS_PUBLISH_MIN_INTERVAL_MS = 5000;
// Upstream WebSocket keepalive interval — prevents NAT/firewall idle timeout on the SFU connection
const RS_UPSTREAM_PING_INTERVAL_MS = 25000;
// Skip refreshIntegration() if last validation was within this window (avoids 870KB API call on every reconnect)
const RS_REFRESH_CACHE_MS = 5 * 60 * 1000;

class RobotStreamerService {
    constructor() {
        this.chatBridges = new Map();
        /** @type {Map<number, { ws: WebSocket, upstream: WebSocket|null, connectedAt: number }>} streamId → active publish session */
        this._activePublish = new Map();
        /** @type {Map<number, { count: number, fetchedAt: number }>} userId → cached RS viewer count */
        this._rsViewerCounts = new Map();
        this.publishProxy = new WebSocket.Server({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
        this.publishProxy.on('connection', (ws, req, ctx) => this._handlePublishConnection(ws, req, ctx));
    }

    /**
     * Cache a RobotStreamer viewer count for a user.
     * Called from the validate endpoint when the broadcaster polls.
     */
    setRsViewerCount(userId, count) {
        this._rsViewerCounts.set(userId, { count: Number(count) || 0, fetchedAt: Date.now() });
    }

    /**
     * Get cached RS viewer count for a user.
     * Returns count if fresh (<120s), otherwise 0.
     */
    getRsViewerCount(userId) {
        const cached = this._rsViewerCounts.get(userId);
        if (!cached || Date.now() - cached.fetchedAt > 120000) return 0;
        return cached.count;
    }

    sanitizeIntegration(row, extras = {}) {
        if (!row) {
            return {
                enabled: false,
                mirror_chat: true,
                has_token: false,
                robot_id: '',
                owner_id: '',
                chat_url: '',
                control_url: '',
                rtc_sfu_url: '',
                stream_name: '',
                owner_name: '',
                last_validated_at: null,
                available_robots: [],
                ...extras,
            };
        }

        return {
            enabled: !!row.enabled,
            mirror_chat: row.mirror_chat !== 0,
            has_token: !!row.token,
            robot_id: row.robot_id || '',
            owner_id: row.owner_id || '',
            chat_url: row.chat_url || '',
            control_url: row.control_url || '',
            rtc_sfu_url: row.rtc_sfu_url || '',
            stream_name: row.stream_name || '',
            owner_name: row.owner_name || '',
            last_validated_at: row.last_validated_at || null,
            available_robots: extras.available_robots || [],
        };
    }

    getClientIntegration(userId) {
        return this.sanitizeIntegration(db.getRobotStreamerIntegrationByUserId(userId));
    }

    normalizeRobotInput(input) {
        const raw = String(input || '').trim();
        if (!raw) return '';

        const urlMatch = raw.match(/robot\/(\d+)/i);
        if (urlMatch) return urlMatch[1];

        const idMatch = raw.match(/^(\d{1,12})$/);
        if (idMatch) return idMatch[1];

        return raw.replace(/[^0-9]/g, '');
    }

    decodeToken(token) {
        const parts = String(token || '').split('.');
        if (parts.length < 2) return null;
        try {
            const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
            return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
        } catch {
            return null;
        }
    }

    extractAvailableRobots(pageData) {
        const robots = [];
        const seen = new Set();
        for (const owner of pageData?.robots || []) {
            for (const robot of owner?.robots || []) {
                const robotId = String(robot.robot_id || '').trim();
                if (!robotId || seen.has(robotId)) continue;
                seen.add(robotId);
                robots.push({
                    robot_id: robotId,
                    robot_name: robot.robot_name || `Robot ${robotId}`,
                    status: robot.status || 'offline',
                    viewers: Number(robot.viewers || 0),
                });
            }
        }
        return robots;
    }

    parseEndpoints(pageData) {
        const endpoints = {};
        if (pageData?.chat_service) {
            endpoints.chat_url = `wss://${pageData.chat_service.host}:${pageData.chat_service.port}/`;
        } else if (pageData?.chat_ssl) {
            endpoints.chat_url = `wss://${pageData.chat_ssl.host}:${pageData.chat_ssl.port}/`;
        }
        if (pageData?.control_service) {
            endpoints.control_url = `wss://${pageData.control_service.host}:${pageData.control_service.port}/echo`;
        }
        if (pageData?.rtc_sfu) {
            endpoints.rtc_sfu_url = `wss://${pageData.rtc_sfu.host}:${pageData.rtc_sfu.port}/`;
        }
        return endpoints;
    }

    async robotPageLoad(token, robotId) {
        const body = JSON.stringify({
            token,
            robot_id: robotId,
            referrer: `${RS_ORIGIN}/robot/${robotId}`,
        });

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: API_HOST,
                port: API_PORT,
                path: '/v1/robot_page_load',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Origin': RS_ORIGIN,
                    'Referer': `${RS_ORIGIN}/`,
                },
                timeout: 15000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`RobotStreamer API returned ${res.statusCode}`));
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(new Error(`RobotStreamer API parse error: ${err.message}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy(new Error('RobotStreamer API timed out'));
            });
            req.write(body);
            req.end();
        });
    }

    async validateConfiguration({ token, robotInput }) {
        const resolvedToken = String(token || '').trim();
        const robotId = this.normalizeRobotInput(robotInput);
        if (!resolvedToken) throw new Error('RobotStreamer token is required');
        if (!robotId) throw new Error('RobotStreamer robot ID or stream URL is required');

        const pageData = await this.robotPageLoad(resolvedToken, robotId);
        const tokenPayload = this.decodeToken(resolvedToken) || {};
        const endpoints = this.parseEndpoints(pageData);
        const titleData = pageData?.title_data || {};

        return {
            fields: {
                token: resolvedToken,
                robot_id: robotId,
                owner_id: String(titleData.owner_id || tokenPayload.user_id || '').trim(),
                stream_name: titleData.robot_name || '',
                owner_name: titleData.owner_name || tokenPayload.user_name || '',
                chat_url: endpoints.chat_url || '',
                control_url: endpoints.control_url || '',
                rtc_sfu_url: endpoints.rtc_sfu_url || '',
                last_validated_at: new Date().toISOString(),
            },
            availableRobots: this.extractAvailableRobots(pageData),
        };
    }

    async upsertIntegration(userId, payload = {}) {
        const existing = db.getRobotStreamerIntegrationByUserId(userId);
        const updates = {
            enabled: normalizeBoolean(payload.enabled, existing ? !!existing.enabled : false) ? 1 : 0,
            mirror_chat: normalizeBoolean(payload.mirror_chat, existing ? existing.mirror_chat !== 0 : true) ? 1 : 0,
        };

        const providedToken = typeof payload.token === 'string' ? payload.token.trim() : '';
        const providedRobot = this.normalizeRobotInput(payload.robot_input || payload.robot_id || '');
        const needsValidation = !!providedToken
            || !!providedRobot
            || (!existing && updates.enabled)
            || (!!updates.enabled && (!existing?.token || !existing?.robot_id));

        let availableRobots = [];
        if (needsValidation) {
            const validated = await this.validateConfiguration({
                token: providedToken || existing?.token,
                robotInput: providedRobot || existing?.robot_id,
            });
            Object.assign(updates, validated.fields);
            availableRobots = validated.availableRobots;
        }

        const row = db.upsertRobotStreamerIntegration(userId, updates);
        return {
            row,
            integration: this.sanitizeIntegration(row, { available_robots: availableRobots }),
        };
    }

    async refreshIntegration(userId) {
        const existing = db.getRobotStreamerIntegrationByUserId(userId);
        if (!existing?.token || !existing?.robot_id) return existing;
        const validated = await this.validateConfiguration({ token: existing.token, robotInput: existing.robot_id });
        return db.upsertRobotStreamerIntegration(userId, {
            ...validated.fields,
            enabled: existing.enabled,
            mirror_chat: existing.mirror_chat,
        });
    }

    async startForStream(stream) {
        if (!stream?.id || !stream?.user_id) return;

        const existingBridge = this.chatBridges.get(stream.id);
        if (existingBridge) return existingBridge;

        let integration = db.getRobotStreamerIntegrationByUserId(stream.user_id);
        if (!integration?.enabled || integration.mirror_chat === 0 || !integration.token || !integration.robot_id) {
            return null;
        }

        if (!integration.chat_url) {
            try {
                integration = await this.refreshIntegration(stream.user_id);
            } catch (err) {
                console.warn(`[RS] Failed refreshing integration for stream ${stream.id}:`, err.message);
                return null;
            }
        }

        const bridge = {
            streamId: stream.id,
            userId: stream.user_id,
            token: integration.token,
            robotId: String(integration.robot_id),
            ownerId: String(integration.owner_id || ''),
            chatUrl: integration.chat_url,
            stopped: false,
            ws: null,
            reconnectDelay: 3000,
            reconnectTimer: null,
        };

        const connect = () => {
            if (bridge.stopped) return;

            bridge.ws = new WebSocket(bridge.chatUrl, {
                headers: { Origin: RS_ORIGIN },
            });

            bridge.ws.on('open', () => {
                bridge.reconnectDelay = 3000;
                bridge.ws.send(JSON.stringify({
                    type: 'connect',
                    message: 'joined',
                    token: bridge.token,
                    robot_id: bridge.robotId,
                    owner_id: bridge.ownerId,
                }));
                chatServer.broadcastToStream(stream.id, {
                    type: 'system',
                    message: 'RobotStreamer chat mirror connected',
                    timestamp: new Date().toISOString(),
                });
            });

            bridge.ws.on('message', (raw) => {
                const data = safeJsonParse(raw.toString());
                if (!data) return;

                if (data.type === 'history' || data.type === 'privileges') return;

                if (data.username === '[RS BOT]') {
                    chatServer.broadcastToStream(stream.id, {
                        type: 'system',
                        message: `[RS BOT] ${data.message}`,
                        timestamp: new Date().toISOString(),
                    });
                    return;
                }

                if (data.message === undefined) return;
                if (data.robot_id && String(data.robot_id) !== bridge.robotId) return;

                const timestamp = Number.isFinite(Number(data.timestamp))
                    ? new Date(Number(data.timestamp)).toISOString()
                    : new Date().toISOString();
                const username = `[RS] ${String(data.username || 'anon')}`;
                const mirrored = {
                    type: 'chat',
                    username,
                    user_id: null,
                    anon_id: null,
                    role: 'external',
                    message: String(data.message || ''),
                    stream_id: stream.id,
                    is_global: false,
                    avatar_url: data.avatar || null,
                    profile_color: '#7dd3fc',
                    timestamp,
                    source_platform: 'robotstreamer',
                };

                try {
                    db.saveChatMessage({
                        stream_id: stream.id,
                        user_id: null,
                        anon_id: null,
                        username,
                        message: mirrored.message,
                        message_type: 'chat',
                        is_global: 0,
                    });
                } catch {}

                chatServer.broadcastToStream(stream.id, mirrored);
            });

            bridge.ws.on('close', () => {
                if (bridge.stopped) return;
                chatServer.broadcastToStream(stream.id, {
                    type: 'system',
                    message: 'RobotStreamer chat mirror disconnected — retrying',
                    timestamp: new Date().toISOString(),
                });
                clearTimeout(bridge.reconnectTimer);
                bridge.reconnectTimer = setTimeout(connect, bridge.reconnectDelay);
                bridge.reconnectDelay = Math.min(bridge.reconnectDelay * 1.5, 30000);
            });

            bridge.ws.on('error', (err) => {
                console.warn(`[RS] Chat bridge error for stream ${stream.id}:`, err.message);
            });
        };

        bridge.disconnect = () => {
            bridge.stopped = true;
            clearTimeout(bridge.reconnectTimer);
            if (bridge.ws) {
                try { bridge.ws.close(1000); } catch {}
                bridge.ws = null;
            }
        };

        this.chatBridges.set(stream.id, bridge);
        connect();
        return bridge;
    }

    stopForStream(streamId) {
        const bridge = this.chatBridges.get(streamId);
        if (bridge) {
            bridge.disconnect();
            this.chatBridges.delete(streamId);
        }
    }

    stopForUserLiveStreams(userId) {
        for (const [streamId, bridge] of this.chatBridges) {
            if (bridge.userId === userId) {
                bridge.disconnect();
                this.chatBridges.delete(streamId);
            }
        }
    }

    handleUpgrade(req, socket, head) {
        if (!req.url.startsWith('/ws/robotstreamer-publish')) return false;

        const params = new URL(req.url, 'http://localhost').searchParams;
        const authToken = params.get('token');
        const streamId = parseInt(params.get('streamId') || '', 10);
        const user = authenticateWs(authToken);
        const stream = Number.isFinite(streamId) ? db.getStreamById(streamId) : null;

        if (!user || !stream || stream.user_id !== user.id) {
            socket.destroy();
            return true;
        }

        const integration = db.getRobotStreamerIntegrationByUserId(user.id);
        if (!integration?.enabled || !integration?.token || !integration?.robot_id) {
            socket.destroy();
            return true;
        }

        this.publishProxy.handleUpgrade(req, socket, head, (ws) => {
            this.publishProxy.emit('connection', ws, req, { user, stream, integration });
        });

        return true;
    }


    async _handlePublishConnection(ws, req, ctx) {
        let integration = ctx.integration;
        const streamId = ctx.stream.id;

        // ── Single-connection-per-stream guard ──────────────────────
        // Close any existing publish session for this stream before starting a new one.
        // This prevents multiple overlapping upstream connections to the RS SFU.
        const existing = this._activePublish.get(streamId);
        if (existing) {
            const age = Date.now() - existing.connectedAt;
            console.log(`[RS Publish] Replacing existing session for stream ${streamId} (age: ${age}ms)`);

            // Rate-limit: if the previous connection was created very recently,
            // delay the new one to prevent rapid reconnect loops.
            if (age < RS_PUBLISH_MIN_INTERVAL_MS) {
                const wait = RS_PUBLISH_MIN_INTERVAL_MS - age;
                console.log(`[RS Publish] Rate-limiting new connection — waiting ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
                // Client may have disconnected during the wait
                if (ws.readyState !== WebSocket.OPEN) {
                    console.log('[RS Publish] Client disconnected during rate-limit wait');
                    return;
                }
            }

            try { existing.upstream?.close(1000); } catch {}
            try { existing.ws?.close(1000); } catch {}
            this._activePublish.delete(streamId);
        }

        // Track this connection
        const publishEntry = { ws, upstream: null, connectedAt: Date.now() };
        this._activePublish.set(streamId, publishEntry);

        // ── Buffer client messages IMMEDIATELY ──────────────────────
        // Client sends RPC requests as soon as its WS opens, but we need
        // to do async work (refreshIntegration + upstream WS connect)
        // before we can relay. Buffer everything now, flush later.
        const earlyMessages = [];
        let hasUpstream = false;
        let upstream = null;
        let upstreamReady = false;
        const outboundQueue = [];
        let upstreamPingInterval = null;

        const processAndRelay = (raw) => {
            const msg = safeJsonParse(raw);
            let outgoing = raw;

            if (msg?.request && typeof msg.method === 'string') {
                if (msg.method === 'createWebRtcTransport') {
                    msg.data = {
                        producing: true,
                        consuming: false,
                        streamkey: integration.token,
                    };
                    outgoing = JSON.stringify(msg);
                } else if (msg.method === 'join') {
                    msg.data = {
                        ...(msg.data || {}),
                        token: integration.token,
                    };
                    outgoing = JSON.stringify(msg);
                }
                console.log(`[RS Publish] Client → SFU: ${msg.method} (id=${msg.id}) | upstream ready: ${upstreamReady} | queued: ${outboundQueue.length}`);
            }

            if (!upstreamReady) outboundQueue.push(outgoing);
            else if (upstream) upstream.send(outgoing);
        };

        ws.on('message', (payload) => {
            const raw = payload.toString();
            if (!hasUpstream) {
                earlyMessages.push(raw);
                console.log('[RS Publish] Buffered early message (upstream not created yet), count:', earlyMessages.length);
            } else {
                processAndRelay(raw);
            }
        });

        ws.on('close', () => {
            if (upstreamPingInterval) { clearInterval(upstreamPingInterval); upstreamPingInterval = null; }
            if (upstream) { try { upstream.close(1000); } catch {} }
            // Clean up tracking — only if we're still the active session for this stream
            if (this._activePublish.get(streamId) === publishEntry) {
                this._activePublish.delete(streamId);
            }
        });

        ws.on('error', () => {
            if (upstream) { try { upstream.close(1011); } catch {} }
        });

        // ── Refresh integration (registers session with RS API) ─────
        // Skip if the integration was recently validated to avoid an expensive
        // 870KB+ API call on every client reconnect (which can also invalidate
        // the previous session). Only force-refresh if data is stale.
        const lastValidated = integration.last_validated_at ? new Date(integration.last_validated_at).getTime() : 0;
        const needsRefresh = !lastValidated || (Date.now() - lastValidated) > RS_REFRESH_CACHE_MS;

        if (needsRefresh) {
            console.log('[RS Publish] Refreshing integration for user', ctx.user.id, '(last validated:', integration.last_validated_at || 'never', ')');
            try {
                integration = await this.refreshIntegration(ctx.user.id);
                console.log('[RS Publish] Refreshed integration:', {
                    robot_id: integration.robot_id,
                    rtc_sfu_url: integration.rtc_sfu_url,
                    owner_id: integration.owner_id,
                    hasToken: !!integration.token,
                    tokenLen: integration.token?.length,
                });
            } catch (err) {
                console.warn('[RS Publish] Refresh failed:', err.message);
                if (!integration?.rtc_sfu_url) {
                    ws.close(1011, `refresh failed: ${err.message}`);
                    return;
                }
            }
        } else {
            console.log('[RS Publish] Using cached integration for user', ctx.user.id, '(validated', Math.round((Date.now() - lastValidated) / 1000), 's ago)');
        }

        if (!integration?.rtc_sfu_url) {
            console.warn('[RS Publish] No SFU URL available after refresh');
            ws.close(1011, 'no SFU URL available');
            return;
        }

        if (ws.readyState !== WebSocket.OPEN) {
            console.warn('[RS Publish] Client disconnected during refresh');
            return;
        }

        let upstreamUrl;
        try {
            const rtcUrl = new URL(integration.rtc_sfu_url);
            const peerId = `p:${crypto.randomBytes(3).toString('hex')}`;
            rtcUrl.searchParams.set('roomId', String(integration.robot_id));
            rtcUrl.searchParams.set('peerId', peerId);
            upstreamUrl = rtcUrl.toString();
        } catch {
            ws.close(1011, 'invalid rtc url');
            return;
        }

        console.log('[RS Publish] Connecting upstream:', upstreamUrl);
        console.log('[RS Publish] Early messages buffered:', earlyMessages.length);

        const upstreamConnectStart = Date.now();
        upstream = new WebSocket(upstreamUrl, ['protoo'], {
            headers: {
                Origin: RS_ORIGIN,
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
            maxPayload: 512 * 1024,
            rejectUnauthorized: false,
            handshakeTimeout: 15000,
        });
        publishEntry.upstream = upstream;

        // Now that upstream exists, drain buffered messages through processAndRelay
        hasUpstream = true;
        console.log('[RS Publish] Draining', earlyMessages.length, 'early messages into outbound queue');
        while (earlyMessages.length) {
            processAndRelay(earlyMessages.shift());
        }

        // ── Upstream event handlers ─────────────────────────────────
        upstream.on('open', () => {
            console.log('[RS Publish] Upstream connected in', Date.now() - upstreamConnectStart, 'ms | subprotocol:', upstream.protocol || '(none)');
            upstreamReady = true;
            console.log('[RS Publish] Flushing', outboundQueue.length, 'queued messages to SFU');
            while (outboundQueue.length) {
                upstream.send(outboundQueue.shift());
            }

            // Start WebSocket ping keepalive to prevent NAT/firewall idle timeout.
            // Without this, connections die after 60-300s of no data flow.
            upstreamPingInterval = setInterval(() => {
                if (upstream.readyState === WebSocket.OPEN) {
                    try { upstream.ping(); } catch {}
                } else {
                    clearInterval(upstreamPingInterval);
                    upstreamPingInterval = null;
                }
            }, RS_UPSTREAM_PING_INTERVAL_MS);
        });

        upstream.on('message', (payload) => {
            const raw = payload.toString();
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(raw);
            }
            const parsed = safeJsonParse(raw);
            if (parsed?.response) {
                const status = parsed.ok === false ? 'ERROR' : 'OK';
                console.log(`[RS Publish] SFU → client: response id=${parsed.id} ${status}`, parsed.ok === false ? JSON.stringify({ error: parsed.error, reason: parsed.reason }) : '');
            } else if (parsed?.request) {
                console.log(`[RS Publish] SFU → client: request method=${parsed.method}`);
            } else if (parsed?.notification) {
                console.log(`[RS Publish] SFU → client: notification method=${parsed.method}`);
            }
        });

        upstream.on('close', (code, reason) => {
            const reasonStr = reason?.toString() || 'upstream closed';
            const sessionAge = Date.now() - publishEntry.connectedAt;
            console.warn(`[RS Publish] Upstream closed: code=${code} reason=${reasonStr} (session age: ${sessionAge}ms)`);
            if (upstreamPingInterval) { clearInterval(upstreamPingInterval); upstreamPingInterval = null; }
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(code || 1006, reasonStr);
            }
        });

        upstream.on('error', (err) => {
            console.error('[RS Publish] Upstream error:', err.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(1011, `upstream error: ${err.message}`);
            }
        });

        upstream.on('unexpected-response', (req, res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                console.error(`[RS Publish] Upstream rejected: HTTP ${res.statusCode} ${res.statusMessage} | body: ${body.slice(0, 500)}`);
                console.error('[RS Publish] Response headers:', JSON.stringify(res.headers));
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close(1011, `upstream rejected: HTTP ${res.statusCode}`);
                }
            });
        });
    }
}

module.exports = new RobotStreamerService();
