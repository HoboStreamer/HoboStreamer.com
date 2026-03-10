/**
 * HoboStreamer — Group Call WebSocket Server
 * 
 * Discord-style voice/video group call alongside a live stream.
 * Uses full-mesh WebRTC peer connections (each participant ↔ every other).
 * Signaling only — no media passes through the server.
 * 
 * WebSocket path: /ws/call?streamId=N&token=X
 * 
 * Call modes (set by streamer per stream):
 *   'mic'      — Microphone only
 *   'mic+cam'  — Mic required, camera optional
 *   'cam+mic'  — Both mic and camera required
 * 
 * Message types (client → server):
 *   join        — Join the call (triggers peer negotiations)
 *   leave       — Leave the call
 *   offer       — SDP offer to a specific peer
 *   answer      — SDP answer to a specific peer
 *   ice-candidate — ICE candidate to a specific peer
 *   mute        — Toggle mute state (broadcast to all)
 *   camera-off  — Toggle camera state (broadcast to all)
 *   speaking    — Voice activity state changed
 * 
 * Message types (server → client):
 *   welcome       — Your peer ID, call state, participants list
 *   peer-joined   — New peer entered the call
 *   peer-left     — Peer left the call
 *   offer         — SDP offer from a peer
 *   answer        — SDP answer from a peer
 *   ice-candidate — ICE candidate from a peer
 *   peer-muted    — Peer mute state changed
 *   peer-camera   — Peer camera state changed
 *   peer-speaking — Peer speaking state changed
 *   call-ended    — Streamer ended the call or mode changed
 *   error         — Error message
 *   participant-count — Updated count for all in room
 */

const WebSocket = require('ws');
const db = require('../db/database');
const { verifyToken } = require('../auth/auth');
const permissions = require('../auth/permissions');
const chatServer = require('../chat/chat-server');
const cosmetics = require('../monetization/cosmetics');

const WS_HEARTBEAT_MS = 30000;

class CallServer {
    constructor() {
        this.wss = null;
        /** @type {Map<number, Map<string, {ws: WebSocket, user: Object|null, anonId: string|null, peerId: string, muted: boolean, cameraOff: boolean, forceMuted: boolean, forceCameraOff: boolean, speaking: boolean, isStreamer: boolean}>>} */
        this.rooms = new Map(); // streamId → Map<peerId, clientInfo>
        /** @type {Map<WebSocket, {streamId: number, peerId: string}>} */
        this.clients = new Map(); // ws → {streamId, peerId}
        /** @type {Map<number, Set<number>>} */
        this.callBans = new Map(); // streamId → Set<userId>
        this._nextPeerId = 1;
        this._heartbeatInterval = null;
    }

    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

        if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = setInterval(() => {
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

        this.wss.on('connection', (ws, req) => this._handleConnection(ws, req));
        console.log('[CallServer] Initialized');
    }

    handleUpgrade(req, socket, head) {
        if (!req.url.startsWith('/ws/call')) return false;
        this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req);
        });
        return true;
    }

    _generatePeerId() {
        return `call-peer-${this._nextPeerId++}-${Date.now().toString(36)}`;
    }

    _buildParticipantInfo(peerId, info) {
        let cosmeticProfile = {};
        if (info.user?.id) {
            try {
                cosmeticProfile = cosmetics.getCosmeticProfile(info.user.id) || {};
            } catch {}
        }

        return {
            peerId,
            username: info.user ? info.user.username : null,
            anonId: info.anonId || null,
            displayName: info.user ? (info.user.display_name || info.user.username) : info.anonId,
            userId: info.user ? info.user.id : null,
            avatarUrl: info.user ? info.user.avatar_url : null,
            profileColor: info.user ? info.user.profile_color : null,
            isStreamer: info.isStreamer || false,
            muted: info.muted,
            cameraOff: info.cameraOff,
            forceMuted: info.forceMuted || false,
            forceCameraOff: info.forceCameraOff || false,
            speaking: info.speaking || false,
            nameFX: cosmeticProfile.nameFX || null,
            particleFX: cosmeticProfile.particleFX || null,
            hatFX: cosmeticProfile.hatFX || null,
        };
    }

    _handleConnection(ws, req) {
        const url = new URL(req.url, 'http://localhost');
        const streamId = parseInt(url.searchParams.get('streamId'));
        const token = url.searchParams.get('token') || null;
        const ip = chatServer.normalizeIp(req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress);

        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        try { ws._socket?.setNoDelay(true); } catch {}

        if (!streamId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing streamId' }));
            ws.close();
            return;
        }

        // Verify the stream exists, is live, and has call mode enabled
        const stream = db.getStreamById(streamId);
        if (!stream || !stream.is_live) {
            ws.send(JSON.stringify({ type: 'error', message: 'Stream not found or not live' }));
            ws.close();
            return;
        }
        if (!stream.call_mode) {
            ws.send(JSON.stringify({ type: 'error', message: 'Group call is not enabled on this stream' }));
            ws.close();
            return;
        }

        // Authenticate (optional — anons can join too)
        let user = null;
        if (token) {
            try {
                const decoded = verifyToken(token);
                if (decoded && decoded.id) {
                    user = db.getUserById(decoded.id);
                }
            } catch {}
        }

        const peerId = this._generatePeerId();
        const anonId = user ? null : chatServer.getAnonIdForConnection(ip, streamId);
        const isStreamer = user && stream.user_id === user.id;

        // Check if user is banned from this stream's call
        if (user && this.callBans.has(streamId) && this.callBans.get(streamId).has(user.id)) {
            ws.send(JSON.stringify({ type: 'error', message: 'You are banned from this call' }));
            ws.close();
            return;
        }

        // Store client
        const clientInfo = {
            ws,
            user,
            anonId,
            ip,
            peerId,
            muted: false,
            cameraOff: true,
            forceMuted: false,
            forceCameraOff: false,
            speaking: false,
            isStreamer,
        };
        this.clients.set(ws, { streamId, peerId });

        // Get or create room
        if (!this.rooms.has(streamId)) {
            this.rooms.set(streamId, new Map());
        }
        const room = this.rooms.get(streamId);

        // Cap at 15 participants
        if (room.size >= 15) {
            ws.send(JSON.stringify({ type: 'error', message: 'Call is full (max 15 participants)' }));
            ws.close();
            return;
        }

        room.set(peerId, clientInfo);

        // Build participant list
        const participants = [];
        for (const [pid, info] of room) {
            participants.push(this._buildParticipantInfo(pid, info));
        }

        // Welcome the new peer
        ws.send(JSON.stringify({
            type: 'welcome',
            peerId,
            callMode: stream.call_mode,
            participants,
            isStreamer,
        }));

        // Notify existing peers about the new joiner
        const joinMsg = JSON.stringify({
            type: 'peer-joined',
            ...this._buildParticipantInfo(peerId, clientInfo),
        });
        for (const [pid, info] of room) {
            if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) {
                info.ws.send(joinMsg);
            }
        }

        // Broadcast updated count
        this._broadcastParticipantCount(streamId);

        // Handle messages
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                this._handleMessage(ws, msg, streamId, peerId);
            } catch (err) {
                // Ignore parse errors
            }
        });

        ws.on('close', () => {
            this._handleDisconnect(ws, streamId, peerId);
        });

        ws.on('error', () => {
            this._handleDisconnect(ws, streamId, peerId);
        });
    }

    _handleMessage(ws, msg, streamId, peerId) {
        const room = this.rooms.get(streamId);
        if (!room) return;

        switch (msg.type) {
            case 'offer':
            case 'answer':
            case 'ice-candidate': {
                // Relay to target peer
                const targetPeer = room.get(msg.targetPeerId);
                if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
                    targetPeer.ws.send(JSON.stringify({
                        type: msg.type,
                        fromPeerId: peerId,
                        sdp: msg.sdp,
                        candidate: msg.candidate,
                    }));
                }
                break;
            }

            case 'mute': {
                const client = room.get(peerId);
                if (client) {
                    client.muted = !!msg.muted;
                    const muteMsg = JSON.stringify({
                        type: 'peer-muted',
                        peerId,
                        muted: client.muted,
                    });
                    for (const [pid, info] of room) {
                        if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) {
                            info.ws.send(muteMsg);
                        }
                    }
                }
                break;
            }

            case 'camera-off': {
                const client = room.get(peerId);
                if (client) {
                    client.cameraOff = !!msg.cameraOff;
                    const camMsg = JSON.stringify({
                        type: 'peer-camera',
                        peerId,
                        cameraOff: client.cameraOff,
                    });
                    for (const [pid, info] of room) {
                        if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) {
                            info.ws.send(camMsg);
                        }
                    }
                }
                break;
            }

            case 'speaking': {
                const client = room.get(peerId);
                if (client) {
                    const speaking = !!msg.speaking;
                    if (client.speaking === speaking) break;
                    client.speaking = speaking;
                    const speakingMsg = JSON.stringify({ type: 'peer-speaking', peerId, speaking });
                    for (const [pid, info] of room) {
                        if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) {
                            info.ws.send(speakingMsg);
                        }
                    }
                }
                break;
            }

            case 'auth-update': {
                const client = room.get(peerId);
                if (!client) break;

                let user = null;
                const token = typeof msg.token === 'string' ? msg.token : null;
                if (token) {
                    try {
                        const decoded = verifyToken(token);
                        if (decoded?.id) user = db.getUserById(decoded.id);
                    } catch {}
                }

                if (user && this.callBans.has(streamId) && this.callBans.get(streamId).has(user.id)) {
                    if (client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({ type: 'error', message: 'You are banned from this call' }));
                        client.ws.close();
                    }
                    break;
                }

                client.user = user;
                client.anonId = user ? null : chatServer.getAnonIdForConnection(client.ip, streamId);
                client.isStreamer = !!(user && db.getStreamById(streamId)?.user_id === user.id);

                const participantInfo = this._buildParticipantInfo(peerId, client);
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(JSON.stringify({
                        type: 'self-updated',
                        isStreamer: client.isStreamer,
                        participant: participantInfo,
                    }));
                }

                const updateMsg = JSON.stringify({ type: 'peer-updated', ...participantInfo });
                for (const [pid, info] of room) {
                    if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) {
                        info.ws.send(updateMsg);
                    }
                }
                break;
            }

            /* ── Moderation commands (stream owner, channel mod, global_mod, admin) ── */

            case 'force-mute': {
                const sender = room.get(peerId);
                if (!sender || !permissions.canModerateCall(sender.user, streamId)) break;
                const target = room.get(msg.targetPeerId);
                if (!target || target.isStreamer) break;
                target.forceMuted = !!msg.forceMuted;
                // Tell the target they've been force-muted
                if (target.ws.readyState === WebSocket.OPEN) {
                    target.ws.send(JSON.stringify({
                        type: 'force-muted',
                        forceMuted: target.forceMuted,
                    }));
                }
                // Broadcast to all peers
                const fmMsg = JSON.stringify({
                    type: 'peer-force-muted',
                    peerId: msg.targetPeerId,
                    forceMuted: target.forceMuted,
                });
                for (const [pid, info] of room) {
                    if (info.ws.readyState === WebSocket.OPEN) {
                        info.ws.send(fmMsg);
                    }
                }
                break;
            }

            case 'force-camera-off': {
                const sender = room.get(peerId);
                if (!sender || !permissions.canModerateCall(sender.user, streamId)) break;
                const target = room.get(msg.targetPeerId);
                if (!target || target.isStreamer) break;
                target.forceCameraOff = !!msg.forceCameraOff;
                if (target.ws.readyState === WebSocket.OPEN) {
                    target.ws.send(JSON.stringify({
                        type: 'force-camera-off',
                        forceCameraOff: target.forceCameraOff,
                    }));
                }
                const fcMsg = JSON.stringify({
                    type: 'peer-force-camera-off',
                    peerId: msg.targetPeerId,
                    forceCameraOff: target.forceCameraOff,
                });
                for (const [pid, info] of room) {
                    if (info.ws.readyState === WebSocket.OPEN) {
                        info.ws.send(fcMsg);
                    }
                }
                break;
            }

            case 'kick': {
                const sender = room.get(peerId);
                if (!sender || !permissions.canModerateCall(sender.user, streamId)) break;
                const target = room.get(msg.targetPeerId);
                if (!target || target.isStreamer) break;
                // Tell the target they were kicked
                if (target.ws.readyState === WebSocket.OPEN) {
                    target.ws.send(JSON.stringify({ type: 'kicked' }));
                    target.ws.close();
                }
                room.delete(msg.targetPeerId);
                this.clients.delete(target.ws);
                // Notify remaining peers
                const kickMsg = JSON.stringify({ type: 'peer-left', peerId: msg.targetPeerId, reason: 'kicked' });
                for (const [pid, info] of room) {
                    if (info.ws.readyState === WebSocket.OPEN) {
                        info.ws.send(kickMsg);
                    }
                }
                this._broadcastParticipantCount(streamId);
                break;
            }

            case 'ban': {
                const sender = room.get(peerId);
                if (!sender || !permissions.canModerateCall(sender.user, streamId)) break;
                const target = room.get(msg.targetPeerId);
                if (!target || target.isStreamer) break;
                // Add to bans
                if (target.user) {
                    if (!this.callBans.has(streamId)) this.callBans.set(streamId, new Set());
                    this.callBans.get(streamId).add(target.user.id);
                }
                // Kick them
                if (target.ws.readyState === WebSocket.OPEN) {
                    target.ws.send(JSON.stringify({ type: 'banned' }));
                    target.ws.close();
                }
                room.delete(msg.targetPeerId);
                this.clients.delete(target.ws);
                const banMsg = JSON.stringify({ type: 'peer-left', peerId: msg.targetPeerId, reason: 'banned' });
                for (const [pid, info] of room) {
                    if (info.ws.readyState === WebSocket.OPEN) {
                        info.ws.send(banMsg);
                    }
                }
                this._broadcastParticipantCount(streamId);
                break;
            }

            case 'unban': {
                const sender = room.get(peerId);
                if (!sender || !permissions.canModerateCall(sender.user, streamId)) break;
                const userId = parseInt(msg.userId);
                if (userId && this.callBans.has(streamId)) {
                    this.callBans.get(streamId).delete(userId);
                }
                break;
            }

            case 'end-call': {
                // Only streamer can end the call
                const client = room.get(peerId);
                if (client && client.isStreamer) {
                    const endMsg = JSON.stringify({ type: 'call-ended' });
                    for (const [pid, info] of room) {
                        if (info.ws.readyState === WebSocket.OPEN) {
                            info.ws.send(endMsg);
                            info.ws.close();
                        }
                    }
                    this.rooms.delete(streamId);
                }
                break;
            }
        }
    }

    _handleDisconnect(ws, streamId, peerId) {
        this.clients.delete(ws);
        const room = this.rooms.get(streamId);
        if (!room) return;

        room.delete(peerId);

        // Notify remaining peers
        const leaveMsg = JSON.stringify({ type: 'peer-left', peerId });
        for (const [pid, info] of room) {
            if (info.ws.readyState === WebSocket.OPEN) {
                info.ws.send(leaveMsg);
            }
        }

        // Clean up empty rooms
        if (room.size === 0) {
            this.rooms.delete(streamId);
        }

        // Broadcast updated count
        this._broadcastParticipantCount(streamId);
    }

    _broadcastParticipantCount(streamId) {
        const room = this.rooms.get(streamId);
        const count = room ? room.size : 0;
        const countMsg = JSON.stringify({ type: 'participant-count', count });
        if (room) {
            for (const [pid, info] of room) {
                if (info.ws.readyState === WebSocket.OPEN) {
                    info.ws.send(countMsg);
                }
            }
        }
    }

    /** Get the number of participants in a stream's call */
    getParticipantCount(streamId) {
        const room = this.rooms.get(streamId);
        return room ? room.size : 0;
    }

    /** Get participants list for API */
    getParticipants(streamId) {
        const room = this.rooms.get(streamId);
        if (!room) return [];
        const list = [];
        for (const [pid, info] of room) {
            list.push({
                ...this._buildParticipantInfo(pid, info),
            });
        }
        return list;
    }

    /** Get banned user IDs for a stream */
    getCallBans(streamId) {
        const bans = this.callBans.get(streamId);
        return bans ? [...bans] : [];
    }

    /** End a call for a specific stream (called when stream ends) */
    endCall(streamId) {
        const room = this.rooms.get(streamId);
        if (!room) return;
        const endMsg = JSON.stringify({ type: 'call-ended' });
        for (const [pid, info] of room) {
            if (info.ws.readyState === WebSocket.OPEN) {
                info.ws.send(endMsg);
                info.ws.close();
            }
        }
        this.rooms.delete(streamId);
    }

    close() {
        // End all calls
        for (const [streamId] of this.rooms) {
            this.endCall(streamId);
        }
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
        if (this.wss) {
            this.wss.close();
        }
    }
}

module.exports = new CallServer();
