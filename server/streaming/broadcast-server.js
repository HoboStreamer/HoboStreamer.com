/**
 * HoboStreamer — Broadcast WebSocket Server
 * 
 * Handles browser-based broadcasting via WebRTC signaling.
 * 
 * Flow:
 *   1. Broadcaster connects with JWT token + streamId
 *   2. Viewer connects with streamId
 *   3. Viewer sends 'watch' → server sends broadcaster's offer or triggers renegotiation
 *   4. WebRTC signaling: offer/answer/ice-candidate relayed between peers
 * 
 * Each stream has ONE broadcaster and MANY viewers.
 * The server acts as a signaling relay (not an SFU).
 */
const WebSocket = require('ws');
const { authenticateWs } = require('../auth/auth');
const db = require('../db/database');
const webrtcSFU = require('./webrtc-sfu');

const WS_HEARTBEAT_MS = 30000;
const MAX_SEND_BACKPRESSURE = 512 * 1024;

class BroadcastServer {
    constructor() {
        this.wss = null;
        /** @type {Map<number, { broadcaster: WebSocket, viewers: Map<string, WebSocket> }>} streamId → room */
        this.rooms = new Map();
        /** @type {Map<WebSocket, { user: object|null, streamId: number, role: string, peerId: string }>} */
        this.clients = new Map();
        this.nextPeerId = 1;
        this.heartbeatInterval = null;
    }

    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            if (!this.wss) return;
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

        console.log('[Broadcast] WebSocket broadcast server initialized');
        return this.wss;
    }

    handleUpgrade(req, socket, head) {
        if (req.url.startsWith('/ws/broadcast')) {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
            return true;
        }
        return false;
    }

    handleConnection(ws, req) {
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token');
        const streamId = parseInt(url.searchParams.get('streamId'));
        const role = url.searchParams.get('role') || 'viewer'; // 'broadcaster' or 'viewer'

        if (role !== 'broadcaster' && role !== 'viewer') {
            ws.close(4004, 'Invalid role');
            return;
        }

        if (!streamId || isNaN(streamId)) {
            ws.close(4001, 'Missing streamId');
            return;
        }

        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        try { ws._socket?.setNoDelay(true); } catch {}

        // Authenticate
        const user = authenticateWs(token);

        // Broadcaster must be authenticated and own the stream
        if (role === 'broadcaster') {
            if (!user) {
                ws.close(4002, 'Authentication required for broadcasting');
                return;
            }
            const stream = db.getStreamById(streamId);
            if (!stream || stream.user_id !== user.id) {
                ws.close(4003, 'Not your stream');
                return;
            }
        }

        const peerId = `peer-${this.nextPeerId++}`;

        const clientInfo = { user, streamId, role, peerId };
        this.clients.set(ws, clientInfo);

        // Set up room
        if (!this.rooms.has(streamId)) {
            this.rooms.set(streamId, { broadcaster: null, viewers: new Map() });
        }
        const room = this.rooms.get(streamId);

        if (role === 'broadcaster') {
            // Cancel any pending disconnect timer
            if (room._disconnectTimer) {
                clearTimeout(room._disconnectTimer);
                room._disconnectTimer = null;
            }
            // Close old broadcaster if any
            if (room.broadcaster) {
                const oldWs = room.broadcaster;
                this.clients.delete(oldWs);
                try { oldWs.close(4010, 'Replaced by new broadcaster'); } catch {}
            }
            room.broadcaster = ws;
            console.log(`[Broadcast] Broadcaster connected: stream ${streamId} (${user.username})`);

            // Notify existing viewers to re-negotiate
            for (const [viewerPeerId, viewerWs] of room.viewers) {
                this.safeSend(viewerWs, { type: 'broadcaster-ready', peerId: viewerPeerId });
            }
        } else {
            room.viewers.set(peerId, ws);
            console.log(`[Broadcast] Viewer connected: stream ${streamId} (${peerId})`);

            // If broadcaster is already connected, notify viewer
            if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                this.safeSend(ws, { type: 'broadcaster-ready', peerId });
            }
        }

        // Send welcome
        this.safeSend(ws, {
            type: 'welcome',
            peerId,
            role,
            streamId,
            viewerCount: room.viewers.size,
        });

        // Broadcast viewer count
        this.broadcastViewerCount(streamId);

        // Handle messages
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                this.handleMessage(ws, msg);
            } catch (err) {
                console.error('[Broadcast] Invalid message:', err.message);
            }
        });

        ws.on('close', () => {
            this.handleDisconnect(ws);
        });

        ws.on('error', (err) => {
            console.error('[Broadcast] WS error:', err.message);
            this.handleDisconnect(ws);
        });
    }

    handleMessage(ws, msg) {
        const client = this.clients.get(ws);
        if (!client) return;

        const room = this.rooms.get(client.streamId);
        if (!room) return;

        switch (msg.type) {
            case 'offer':
            case 'answer':
            case 'ice-candidate':
                // Relay signaling messages between broadcaster and viewers
                this.relaySignaling(ws, client, room, msg);
                break;

            case 'watch':
                // Viewer requests to watch — tell broadcaster to create offer for this viewer
                if (client.role === 'viewer' && room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                    this.safeSend(room.broadcaster, {
                        type: 'viewer-joined',
                        peerId: client.peerId,
                    });
                }
                break;

            case 'stats':
                // Broadcaster reporting stats — relay to room or store
                if (client.role === 'broadcaster') {
                    // Could store stats, for now just track
                }
                break;

            case 'chat-tts':
                // TTS message from chat to broadcaster
                if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                    this.safeSend(room.broadcaster, {
                        type: 'chat-tts',
                        text: msg.text,
                        username: msg.username,
                    });
                }
                break;

            default:
                break;
        }
    }

    relaySignaling(ws, client, room, msg) {
        if (client.role === 'broadcaster') {
            // Broadcaster sending to a specific viewer
            const targetPeerId = msg.targetPeerId;
            if (targetPeerId && room.viewers.has(targetPeerId)) {
                const viewerWs = room.viewers.get(targetPeerId);
                if (viewerWs.readyState === WebSocket.OPEN) {
                    this.safeSend(viewerWs, {
                        type: msg.type,
                        sdp: msg.sdp,
                        candidate: msg.candidate,
                        fromPeerId: 'broadcaster',
                    });
                }
            }
        } else {
            // Viewer sending to broadcaster
            if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                this.safeSend(room.broadcaster, {
                    type: msg.type,
                    sdp: msg.sdp,
                    candidate: msg.candidate,
                    fromPeerId: client.peerId,
                });
            }
        }
    }

    handleDisconnect(ws) {
        const client = this.clients.get(ws);
        if (!client) return;

        const room = this.rooms.get(client.streamId);
        if (room) {
            if (client.role === 'broadcaster') {
                room.broadcaster = null;
                console.log(`[Broadcast] Broadcaster disconnected: stream ${client.streamId}`);

                // Start a grace timer — if broadcaster doesn't reconnect, end the stream cleanly
                if (room._disconnectTimer) clearTimeout(room._disconnectTimer);
                room._disconnectTimer = setTimeout(() => {
                    // Check if broadcaster reconnected
                    const currentRoom = this.rooms.get(client.streamId);
                    if (currentRoom && !currentRoom.broadcaster) {
                        console.log(`[Broadcast] Broadcaster did not reconnect, ending stream ${client.streamId}`);
                        try {
                            db.endStream(client.streamId);
                            const vodRoutes = require('../vod/routes');
                            vodRoutes.finalizeVodRecording(client.streamId).catch((err) => {
                                console.warn(`[Broadcast] Failed to finalize VOD for stale stream ${client.streamId}:`, err.message);
                            });
                            webrtcSFU.closeRoom(`stream-${client.streamId}`);
                        } catch (err) {
                            console.error('[Broadcast] Failed to end stale stream:', err.message);
                        }
                        // Notify all viewers
                        for (const [, vWs] of (currentRoom.viewers || new Map())) {
                            this.safeSend(vWs, { type: 'stream-ended' });
                        }
                    }
                }, 60000);

                // Notify all viewers (they may get a reconnection)
                for (const [peerId, viewerWs] of room.viewers) {
                    this.safeSend(viewerWs, { type: 'broadcaster-disconnected' });
                }
            } else {
                room.viewers.delete(client.peerId);
                console.log(`[Broadcast] Viewer disconnected: stream ${client.streamId} (${client.peerId})`);

                // Notify broadcaster
                if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
                    this.safeSend(room.broadcaster, {
                        type: 'viewer-left',
                        peerId: client.peerId,
                    });
                }
            }

            this.broadcastViewerCount(client.streamId);

            // Clean up empty room
            if (!room.broadcaster && room.viewers.size === 0) {
                this.rooms.delete(client.streamId);
            }
        }

        this.clients.delete(ws);
    }

    broadcastViewerCount(streamId) {
        const room = this.rooms.get(streamId);
        if (!room) return;

        const count = room.viewers.size;
        const msg = { type: 'viewer-count', count };

        if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
            this.safeSend(room.broadcaster, msg);
        }
        for (const [, viewerWs] of room.viewers) {
            if (viewerWs.readyState === WebSocket.OPEN) {
                this.safeSend(viewerWs, msg);
            }
        }
    }

    safeSend(ws, data) {
        try {
            if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(JSON.stringify(data));
            }
        } catch {}
    }

    getViewerCount(streamId) {
        const room = this.rooms.get(streamId);
        return room ? room.viewers.size : 0;
    }

    getTotalConnections() {
        return this.clients.size;
    }

    close() {
        if (this.wss) {
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            for (const ws of this.clients.keys()) {
                try { ws.close(); } catch {}
            }
            this.clients.clear();
            this.rooms.clear();
        }
    }
}

module.exports = new BroadcastServer();
