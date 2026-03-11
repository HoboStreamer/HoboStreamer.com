/**
 * HoboStreamer — Voice Channel WebSocket Server
 *
 * Discord-style voice/video channels accessible from the Chat tab.
 * Uses full-mesh WebRTC peer connections (each participant ↔ every other).
 * Signaling only — no media passes through the server.
 *
 * A permanent "Public" lobby channel always exists. Users can create
 * temporary channels. Stream-linked channels are auto-created when a
 * streamer enables voice on their stream.
 *
 * WebSocket path: /ws/call?channelId=<id>&token=X
 *
 * Channel modes:
 *   'mic'      — Microphone only
 *   'mic+cam'  — Mic + optional camera
 *   'cam+mic'  — Both mic and camera
 */

const WebSocket = require('ws');
const db = require('../db/database');
const { verifyToken } = require('../auth/auth');
const permissions = require('../auth/permissions');
const chatServer = require('../chat/chat-server');
const cosmetics = require('../monetization/cosmetics');

const WS_HEARTBEAT_MS = 30000;
const MAX_PARTICIPANTS = 15;
const PUBLIC_CHANNEL_ID = 'public';

class CallServer {
    constructor() {
        this.wss = null;
        /** channelId → Map<peerId, clientInfo> */
        this.rooms = new Map();
        /** ws → { channelId, peerId } */
        this.clients = new Map();
        /** channelId → Set<userId> */
        this.callBans = new Map();
        /** channelId → channel metadata { id, name, mode, createdBy, streamId?, permanent, createdAt, maxParticipants } */
        this.channels = new Map();
        this._nextPeerId = 1;
        this._heartbeatInterval = null;

        // Seed the permanent Public channel
        this.channels.set(PUBLIC_CHANNEL_ID, {
            id: PUBLIC_CHANNEL_ID, name: 'Public', mode: 'mic+cam', createdBy: null,
            streamId: null, permanent: true, createdAt: Date.now(), maxParticipants: MAX_PARTICIPANTS,
        });
    }

    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
        if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = setInterval(() => {
            if (!this.wss) return;
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
                ws.isAlive = false;
                try { ws.ping(); } catch {}
            });
        }, WS_HEARTBEAT_MS);
        this.wss.on('connection', (ws, req) => this._handleConnection(ws, req));
        console.log('[CallServer] Voice channels initialized');
    }

    handleUpgrade(req, socket, head) {
        if (!req.url.startsWith('/ws/call')) return false;
        this.wss.handleUpgrade(req, socket, head, (ws) => { this.wss.emit('connection', ws, req); });
        return true;
    }

    /* ── Channel management ──────────────────────────────────── */

    listChannels() {
        const result = [];
        for (const [id, ch] of this.channels) {
            const room = this.rooms.get(id);
            const participants = [];
            if (room) { for (const [pid, info] of room) participants.push(this._buildParticipantInfo(pid, info)); }
            result.push({ ...ch, participantCount: room ? room.size : 0, participants });
        }
        return result;
    }

    getChannel(channelId) {
        const ch = this.channels.get(channelId);
        if (!ch) return null;
        const room = this.rooms.get(channelId);
        const participants = [];
        if (room) { for (const [pid, info] of room) participants.push(this._buildParticipantInfo(pid, info)); }
        return { ...ch, participantCount: room ? room.size : 0, participants };
    }

    createChannel({ name, mode, createdBy, maxParticipants }) {
        const id = `user-${createdBy}-${Date.now().toString(36)}`;
        const ch = {
            id, name: String(name || 'Voice Channel').slice(0, 40),
            mode: ['mic', 'mic+cam', 'cam+mic'].includes(mode) ? mode : 'mic+cam',
            createdBy, streamId: null, permanent: false, createdAt: Date.now(),
            maxParticipants: Math.min(Math.max(Number(maxParticipants) || MAX_PARTICIPANTS, 2), MAX_PARTICIPANTS),
        };
        this.channels.set(id, ch);
        return ch;
    }

    createStreamChannel(streamId, mode, streamerId) {
        const id = `stream-${streamId}`;
        const existing = this.channels.get(id);
        if (existing) { const old = existing.mode; existing.mode = mode; if (old !== mode) this.endCall(id); return existing; }
        const stream = db.getStreamById(streamId);
        const ch = {
            id, name: stream ? (stream.title || `Stream ${streamId}`) : `Stream ${streamId}`,
            mode: ['mic', 'mic+cam', 'cam+mic'].includes(mode) ? mode : 'mic',
            createdBy: streamerId, streamId, permanent: false, createdAt: Date.now(), maxParticipants: MAX_PARTICIPANTS,
        };
        this.channels.set(id, ch);
        return ch;
    }

    removeStreamChannel(streamId) {
        const id = `stream-${streamId}`;
        this.endCall(id);
        this.channels.delete(id);
    }

    deleteChannel(channelId, userId) {
        const ch = this.channels.get(channelId);
        if (!ch || ch.permanent) return false;
        if (ch.createdBy !== userId) {
            const user = db.getUserById(userId);
            if (!user || (user.role !== 'admin' && user.role !== 'global_mod')) return false;
        }
        this.endCall(channelId);
        this.channels.delete(channelId);
        return true;
    }

    /* ── WebRTC signaling ──────────────────────────────────────── */

    _generatePeerId() { return `call-peer-${this._nextPeerId++}-${Date.now().toString(36)}`; }

    _buildParticipantInfo(peerId, info) {
        let cosmeticProfile = {};
        if (info.user?.id) { try { cosmeticProfile = cosmetics.getCosmeticProfile(info.user.id) || {}; } catch {} }
        return {
            peerId, username: info.user ? info.user.username : null,
            anonId: info.anonId || null,
            displayName: info.user ? (info.user.display_name || info.user.username) : info.anonId,
            userId: info.user ? info.user.id : null,
            avatarUrl: info.user ? info.user.avatar_url : null,
            profileColor: info.user ? info.user.profile_color : null,
            isChannelCreator: info.isChannelCreator || false,
            isStreamer: info.isStreamer || false,
            muted: info.muted, cameraOff: info.cameraOff,
            forceMuted: info.forceMuted || false, forceCameraOff: info.forceCameraOff || false,
            speaking: info.speaking || false,
            nameFX: cosmeticProfile.nameFX || null, particleFX: cosmeticProfile.particleFX || null, hatFX: cosmeticProfile.hatFX || null,
        };
    }

    _handleConnection(ws, req) {
        const url = new URL(req.url, 'http://localhost');
        const channelId = url.searchParams.get('channelId') || url.searchParams.get('streamId');
        const token = url.searchParams.get('token') || null;
        const ip = chatServer.normalizeIp(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress);

        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        try { ws._socket?.setNoDelay(true); } catch {}

        if (!channelId) { ws.send(JSON.stringify({ type: 'error', message: 'Missing channelId' })); ws.close(); return; }

        // Legacy: bare number → stream-<N>
        const resolvedId = /^\d+$/.test(channelId) ? `stream-${channelId}` : channelId;

        const channel = this.channels.get(resolvedId);
        if (!channel) { ws.send(JSON.stringify({ type: 'error', message: 'Voice channel not found' })); ws.close(); return; }

        // If stream-linked, verify stream is live
        if (channel.streamId) {
            const stream = db.getStreamById(channel.streamId);
            if (!stream || !stream.is_live) { ws.send(JSON.stringify({ type: 'error', message: 'Stream not live' })); ws.close(); return; }
        }

        let user = null;
        if (token) { try { const d = verifyToken(token); if (d?.id) user = db.getUserById(d.id); } catch {} }

        const peerId = this._generatePeerId();
        const anonId = user ? null : chatServer.getAnonIdForConnection(ip, resolvedId);
        const isChannelCreator = user && channel.createdBy === user.id;
        const isStreamer = channel.streamId ? (user && db.getStreamById(channel.streamId)?.user_id === user.id) : false;

        if (user && this.callBans.has(resolvedId) && this.callBans.get(resolvedId).has(user.id)) {
            ws.send(JSON.stringify({ type: 'error', message: 'You are banned from this voice channel' })); ws.close(); return;
        }

        if (!this.rooms.has(resolvedId)) this.rooms.set(resolvedId, new Map());
        const room = this.rooms.get(resolvedId);
        const maxP = channel.maxParticipants || MAX_PARTICIPANTS;
        if (room.size >= maxP) { ws.send(JSON.stringify({ type: 'error', message: `Channel full (max ${maxP})` })); ws.close(); return; }

        const clientInfo = { ws, user, anonId, ip, peerId, muted: false, cameraOff: true, forceMuted: false, forceCameraOff: false, speaking: false, isChannelCreator, isStreamer };
        this.clients.set(ws, { channelId: resolvedId, peerId });
        room.set(peerId, clientInfo);

        const participants = [];
        for (const [pid, info] of room) participants.push(this._buildParticipantInfo(pid, info));

        ws.send(JSON.stringify({ type: 'welcome', peerId, channelId: resolvedId, channelName: channel.name, callMode: channel.mode, participants, isStreamer: isStreamer || isChannelCreator }));

        const joinMsg = JSON.stringify({ type: 'peer-joined', ...this._buildParticipantInfo(peerId, clientInfo) });
        for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(joinMsg); }
        this._broadcastParticipantCount(resolvedId);

        ws.on('message', (data) => { try { this._handleMessage(ws, JSON.parse(data), resolvedId, peerId); } catch {} });
        ws.on('close', () => this._handleDisconnect(ws, resolvedId, peerId));
        ws.on('error', () => this._handleDisconnect(ws, resolvedId, peerId));
    }

    _canModerate(user, channelId) {
        if (!user) return false;
        if (user.role === 'admin' || user.role === 'global_mod') return true;
        const ch = this.channels.get(channelId);
        if (ch?.createdBy === user.id) return true;
        if (ch?.streamId) return permissions.canModerateCall(user, ch.streamId);
        return false;
    }

    _handleMessage(ws, msg, channelId, peerId) {
        const room = this.rooms.get(channelId);
        if (!room) return;

        switch (msg.type) {
            case 'offer': case 'answer': case 'ice-candidate': {
                const tp = room.get(msg.targetPeerId);
                if (tp && tp.ws.readyState === WebSocket.OPEN) tp.ws.send(JSON.stringify({ type: msg.type, fromPeerId: peerId, sdp: msg.sdp, candidate: msg.candidate }));
                break;
            }
            case 'mute': {
                const c = room.get(peerId); if (!c) break;
                c.muted = !!msg.muted;
                const m = JSON.stringify({ type: 'peer-muted', peerId, muted: c.muted });
                for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                break;
            }
            case 'camera-off': {
                const c = room.get(peerId); if (!c) break;
                c.cameraOff = !!msg.cameraOff;
                const m = JSON.stringify({ type: 'peer-camera', peerId, cameraOff: c.cameraOff });
                for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                break;
            }
            case 'speaking': {
                const c = room.get(peerId); if (!c) break;
                const s = !!msg.speaking; if (c.speaking === s) break; c.speaking = s;
                const m = JSON.stringify({ type: 'peer-speaking', peerId, speaking: s });
                for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                break;
            }
            case 'auth-update': {
                const c = room.get(peerId); if (!c) break;
                let user = null;
                if (typeof msg.token === 'string') { try { const d = verifyToken(msg.token); if (d?.id) user = db.getUserById(d.id); } catch {} }
                if (user && this.callBans.has(channelId) && this.callBans.get(channelId).has(user.id)) {
                    if (c.ws.readyState === WebSocket.OPEN) { c.ws.send(JSON.stringify({ type: 'error', message: 'Banned' })); c.ws.close(); } break;
                }
                const ch = this.channels.get(channelId);
                c.user = user; c.anonId = user ? null : chatServer.getAnonIdForConnection(c.ip, channelId);
                c.isChannelCreator = !!(user && ch?.createdBy === user.id);
                c.isStreamer = ch?.streamId ? !!(user && db.getStreamById(ch.streamId)?.user_id === user.id) : false;
                const pInfo = this._buildParticipantInfo(peerId, c);
                if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'self-updated', isStreamer: c.isStreamer || c.isChannelCreator, participant: pInfo }));
                const u = JSON.stringify({ type: 'peer-updated', ...pInfo });
                for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(u); }
                break;
            }
            case 'force-mute': {
                const sender = room.get(peerId); if (!sender || !this._canModerate(sender.user, channelId)) break;
                const target = room.get(msg.targetPeerId); if (!target || target.isChannelCreator || target.isStreamer) break;
                target.forceMuted = !!msg.forceMuted;
                if (target.ws.readyState === WebSocket.OPEN) target.ws.send(JSON.stringify({ type: 'force-muted', forceMuted: target.forceMuted }));
                const m = JSON.stringify({ type: 'peer-force-muted', peerId: msg.targetPeerId, forceMuted: target.forceMuted });
                for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                break;
            }
            case 'force-camera-off': {
                const sender = room.get(peerId); if (!sender || !this._canModerate(sender.user, channelId)) break;
                const target = room.get(msg.targetPeerId); if (!target || target.isChannelCreator || target.isStreamer) break;
                target.forceCameraOff = !!msg.forceCameraOff;
                if (target.ws.readyState === WebSocket.OPEN) target.ws.send(JSON.stringify({ type: 'force-camera-off', forceCameraOff: target.forceCameraOff }));
                const m = JSON.stringify({ type: 'peer-force-camera-off', peerId: msg.targetPeerId, forceCameraOff: target.forceCameraOff });
                for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                break;
            }
            case 'kick': {
                const sender = room.get(peerId); if (!sender || !this._canModerate(sender.user, channelId)) break;
                const target = room.get(msg.targetPeerId); if (!target || target.isChannelCreator || target.isStreamer) break;
                if (target.ws.readyState === WebSocket.OPEN) { target.ws.send(JSON.stringify({ type: 'kicked' })); target.ws.close(); }
                room.delete(msg.targetPeerId); this.clients.delete(target.ws);
                const m = JSON.stringify({ type: 'peer-left', peerId: msg.targetPeerId, reason: 'kicked' });
                for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                this._broadcastParticipantCount(channelId);
                break;
            }
            case 'ban': {
                const sender = room.get(peerId); if (!sender || !this._canModerate(sender.user, channelId)) break;
                const target = room.get(msg.targetPeerId); if (!target || target.isChannelCreator || target.isStreamer) break;
                if (target.user) { if (!this.callBans.has(channelId)) this.callBans.set(channelId, new Set()); this.callBans.get(channelId).add(target.user.id); }
                if (target.ws.readyState === WebSocket.OPEN) { target.ws.send(JSON.stringify({ type: 'banned' })); target.ws.close(); }
                room.delete(msg.targetPeerId); this.clients.delete(target.ws);
                const m = JSON.stringify({ type: 'peer-left', peerId: msg.targetPeerId, reason: 'banned' });
                for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                this._broadcastParticipantCount(channelId);
                break;
            }
            case 'unban': {
                const sender = room.get(peerId); if (!sender || !this._canModerate(sender.user, channelId)) break;
                const uid = parseInt(msg.userId); if (uid && this.callBans.has(channelId)) this.callBans.get(channelId).delete(uid);
                break;
            }
            case 'end-call': case 'end-channel': {
                const c = room.get(peerId); if (!c) break;
                const ch = this.channels.get(channelId);
                const canEnd = (ch?.createdBy && c.user?.id === ch.createdBy) || c.isStreamer || (c.user && (c.user.role === 'admin' || c.user.role === 'global_mod'));
                if (canEnd) { this.endCall(channelId); if (ch && !ch.permanent) this.channels.delete(channelId); }
                break;
            }
        }
    }

    _handleDisconnect(ws, channelId, peerId) {
        this.clients.delete(ws);
        const room = this.rooms.get(channelId);
        if (!room) return;
        room.delete(peerId);
        const m = JSON.stringify({ type: 'peer-left', peerId });
        for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
        if (room.size === 0) {
            this.rooms.delete(channelId);
            const ch = this.channels.get(channelId);
            if (ch && !ch.permanent && !ch.streamId) this.channels.delete(channelId);
        }
        this._broadcastParticipantCount(channelId);
    }

    _broadcastParticipantCount(channelId) {
        const room = this.rooms.get(channelId);
        const count = room ? room.size : 0;
        const m = JSON.stringify({ type: 'participant-count', count, channelId });
        if (room) { for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); } }
    }

    /* ── Public helpers ────────────────────────────────────────── */

    getParticipantCount(channelId) { const r = this.rooms.get(channelId); return r ? r.size : 0; }

    getParticipants(channelId) {
        const r = this.rooms.get(channelId); if (!r) return [];
        const l = []; for (const [pid, info] of r) l.push(this._buildParticipantInfo(pid, info)); return l;
    }

    getCallBans(channelId) { const b = this.callBans.get(channelId); return b ? [...b] : []; }

    endCall(channelId) {
        const r = this.rooms.get(channelId); if (!r) return;
        const m = JSON.stringify({ type: 'call-ended' });
        for (const [pid, info] of r) { if (info.ws.readyState === WebSocket.OPEN) { info.ws.send(m); info.ws.close(); } }
        this.rooms.delete(channelId);
    }

    /** Legacy compat: end call by stream ID */
    endStreamCall(streamId) { this.endCall(`stream-${streamId}`); }

    close() {
        for (const [cid] of this.rooms) this.endCall(cid);
        if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
        if (this.wss) this.wss.close();
    }
}

module.exports = new CallServer();
