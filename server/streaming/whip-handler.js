/**
 * HoboStreamer — WHIP (WebRTC-HTTP Ingestion Protocol) Handler
 *
 * Implements WHIP endpoint for OBS and other WHIP-compatible encoders.
 * RFC 9725 compliant: POST (offer→answer), PATCH (trickle), DELETE (terminate).
 *
 * Also provides SDP ↔ Mediasoup bridging utilities for SFU viewer consumption
 * so web viewers can watch WHIP streams through the standard broadcast signaling.
 */

const crypto = require('crypto');
const config = require('../config');
const webrtcSFU = require('./webrtc-sfu');
const { verifyToken, resolveHoboToolsUser } = require('../auth/auth');
const db = require('../db/database');

let sdpTransform;
try {
    sdpTransform = require('sdp-transform');
} catch {
    console.warn('[WHIP] sdp-transform not installed — WHIP endpoint disabled');
}

// Active WHIP ingestion sessions: resourceId → session info
const sessions = new Map();

function generateResourceId() {
    return crypto.randomBytes(16).toString('hex');
}

// ── SDP Parsing Utilities ────────────────────────────────────

/**
 * Extract DTLS parameters from a parsed SDP object.
 */
function extractDtlsParameters(sdpObj) {
    let fingerprint = sdpObj.fingerprint;
    let setup = null;

    for (const media of sdpObj.media || []) {
        if (!fingerprint && media.fingerprint) fingerprint = media.fingerprint;
        if (!setup && media.setup) setup = media.setup;
    }

    if (!fingerprint) throw new Error('No DTLS fingerprint in SDP');

    // Map SDP setup attribute to mediasoup DTLS role:
    // offer actpass → we are server (answer passive)
    // offer active  → we are client
    let role = 'server';
    if (setup === 'active') role = 'client';

    return {
        role,
        fingerprints: [{
            algorithm: fingerprint.type,
            value: fingerprint.hash,
        }],
    };
}

/**
 * Extract RTP parameters from an SDP media section.
 * Matches codecs against the Mediasoup router's capabilities.
 */
function extractRtpParameters(media, routerCapabilities) {
    if (!media || !media.type) return null;

    const routerCodecs = routerCapabilities.codecs || [];
    const codecs = [];
    const headerExtensions = [];
    const encodings = [];

    // Build rtpmap lookup: payloadType → codec info
    const rtpmaps = {};
    for (const rtp of media.rtp || []) {
        rtpmaps[rtp.payload] = {
            mimeType: `${media.type}/${rtp.codec}`,
            payloadType: rtp.payload,
            clockRate: rtp.rate,
            channels: rtp.encoding || undefined,
            parameters: {},
            rtcpFeedback: [],
        };
    }

    // Parse fmtp parameters
    for (const fmtp of media.fmtp || []) {
        if (rtpmaps[fmtp.payload] && fmtp.config) {
            const params = {};
            for (const part of fmtp.config.split(';')) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                    const key = trimmed.slice(0, eqIdx).trim();
                    const val = trimmed.slice(eqIdx + 1).trim();
                    // Keep certain params as strings, parse integers for others
                    if (key === 'profile-level-id' || key === 'sprop-parameter-sets' || key === 'level-asymmetry-allowed') {
                        params[key] = val;
                    } else {
                        params[key] = /^\d+$/.test(val) ? parseInt(val, 10) : val;
                    }
                }
            }
            rtpmaps[fmtp.payload].parameters = params;
        }
    }

    // Parse rtcp-fb
    for (const fb of media.rtcpFb || []) {
        if (rtpmaps[fb.payload]) {
            rtpmaps[fb.payload].rtcpFeedback.push({
                type: fb.type,
                parameter: fb.subtype || '',
            });
        }
    }

    // Match offered codecs against router capabilities
    const payloads = (media.payloads || '').toString().split(' ').map(Number).filter(n => !isNaN(n));
    let primaryCodec = null;

    for (const pt of payloads) {
        const offered = rtpmaps[pt];
        if (!offered) continue;

        // Skip RTX — handled separately after primary codec
        if (offered.mimeType.toLowerCase().endsWith('/rtx')) continue;

        const match = routerCodecs.find(rc => {
            if (rc.mimeType.toLowerCase() !== offered.mimeType.toLowerCase()) return false;
            if (rc.clockRate !== offered.clockRate) return false;
            if (offered.channels && rc.channels && offered.channels !== rc.channels) return false;
            // H264 profile matching: compare first 4 chars of profile-level-id
            if (rc.mimeType.toLowerCase() === 'video/h264') {
                const rcProfile = (rc.parameters?.['profile-level-id'] || '').toString().toLowerCase();
                const offProfile = (offered.parameters?.['profile-level-id'] || '').toString().toLowerCase();
                if (rcProfile && offProfile && rcProfile.slice(0, 4) !== offProfile.slice(0, 4)) return false;
            }
            return true;
        });

        if (match) {
            primaryCodec = offered;
            codecs.push(offered);
            break;
        }
    }

    if (!primaryCodec) return null;

    // Add RTX codec if present for the primary codec
    for (const pt of payloads) {
        const offered = rtpmaps[pt];
        if (!offered) continue;
        if (offered.mimeType.toLowerCase() === `${media.type}/rtx` &&
            offered.parameters?.apt === primaryCodec.payloadType) {
            codecs.push(offered);
            break;
        }
    }

    // Header extensions: match against router capabilities
    for (const ext of media.ext || []) {
        const routerExt = (routerCapabilities.headerExtensions || []).find(re =>
            re.uri === ext.uri && (re.kind === media.type || !re.kind)
        );
        if (routerExt) {
            headerExtensions.push({
                uri: ext.uri,
                id: ext.value,
                encrypt: false,
                parameters: {},
            });
        }
    }

    // Encodings (SSRC)
    const ssrcs = media.ssrc || [];
    const ssrcGroups = media.ssrcGroups || [];
    const mainSsrc = ssrcs.find(s => s.attribute === 'cname')?.id;

    if (mainSsrc) {
        const encoding = { ssrc: mainSsrc };
        const fidGroup = ssrcGroups.find(g => g.semantics === 'FID');
        if (fidGroup) {
            const parts = fidGroup.ssrcs.split(' ').map(Number);
            if (parts.length >= 2 && parts[0] === mainSsrc) {
                encoding.rtx = { ssrc: parts[1] };
            }
        }
        encodings.push(encoding);
    } else {
        // No SSRC in offer — some encoders omit it; mediasoup can still handle this
        encodings.push({});
    }

    return { codecs, headerExtensions, encodings };
}

// ── SDP Answer/Offer Building ────────────────────────────────

/**
 * Build an SDP answer for a WHIP ingestion (server recvonly).
 */
function buildSdpAnswer(transport, offerSdp, producersByKind) {
    const { iceParameters, iceCandidates, dtlsParameters } = transport;
    const fingerprint = dtlsParameters.fingerprints[dtlsParameters.fingerprints.length - 1];
    const mids = [];

    const sdpObj = {
        version: 0,
        origin: { username: '-', sessionId: String(Date.now()), sessionVersion: 2, netType: 'IN', ipVer: 4, address: '127.0.0.1' },
        name: 'HoboStreamer',
        timing: { start: 0, stop: 0 },
        icelite: 'ice-lite',
        groups: [],
        msidSemantic: { semantic: 'WMS', token: '*' },
        media: [],
    };

    for (const offerMedia of offerSdp.media || []) {
        const mid = offerMedia.mid != null ? String(offerMedia.mid) : String(mids.length);
        mids.push(mid);

        const producer = producersByKind[offerMedia.type];
        if (!producer) {
            sdpObj.media.push({
                type: offerMedia.type,
                port: 0,
                protocol: offerMedia.protocol || 'UDP/TLS/RTP/SAVPF',
                payloads: '0',
                mid,
                direction: 'inactive',
            });
            continue;
        }

        const answerMedia = {
            type: offerMedia.type,
            port: 7,
            protocol: offerMedia.protocol || 'UDP/TLS/RTP/SAVPF',
            payloads: '',
            connection: { ip: '127.0.0.1', version: 4 },
            mid,
            iceUfrag: iceParameters.usernameFragment,
            icePwd: iceParameters.password,
            fingerprint: { type: fingerprint.algorithm, hash: fingerprint.value },
            setup: 'passive',
            direction: 'recvonly',
            rtcpMux: 'rtcp-mux',
            rtp: [],
            fmtp: [],
            rtcpFb: [],
            ext: [],
            candidates: iceCandidates.map(c => {
                const cand = {
                    foundation: c.foundation,
                    component: 1,
                    transport: c.protocol.toLowerCase(),
                    priority: c.priority,
                    ip: c.ip,
                    port: c.port,
                    type: c.type,
                };
                if (c.tcpType) cand.tcptype = c.tcpType;
                return cand;
            }),
        };

        const pts = [];
        for (const codec of producer.rtpParameters.codecs) {
            pts.push(codec.payloadType);
            answerMedia.rtp.push({
                payload: codec.payloadType,
                codec: codec.mimeType.split('/')[1],
                rate: codec.clockRate,
                encoding: codec.channels,
            });
            if (codec.parameters && Object.keys(codec.parameters).length > 0) {
                answerMedia.fmtp.push({
                    payload: codec.payloadType,
                    config: Object.entries(codec.parameters).map(([k, v]) => `${k}=${v}`).join(';'),
                });
            }
            for (const fb of codec.rtcpFeedback || []) {
                answerMedia.rtcpFb.push({
                    payload: codec.payloadType,
                    type: fb.type,
                    subtype: fb.parameter || undefined,
                });
            }
        }
        answerMedia.payloads = pts.join(' ');

        for (const ext of producer.rtpParameters.headerExtensions || []) {
            answerMedia.ext.push({ value: ext.id, uri: ext.uri });
        }

        sdpObj.media.push(answerMedia);
    }

    if (mids.length > 0) {
        sdpObj.groups.push({ type: 'BUNDLE', mids: mids.join(' ') });
    }

    return sdpTransform.write(sdpObj);
}

// ── WHIP HTTP Handlers ───────────────────────────────────────

/**
 * POST /whip/:streamId — WHIP offer → answer
 */
async function handleWhipPost(req, res) {
    if (!sdpTransform) {
        return res.status(503).json({ error: 'WHIP not available (sdp-transform not installed)' });
    }

    try {
        // Auth via Bearer token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Bearer token required' });
        }
        const token = authHeader.slice(7);
        const decoded = verifyToken(token);
        if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });
        const user = resolveHoboToolsUser(decoded);
        if (!user) return res.status(401).json({ error: 'User not found' });

        // Stream validation
        const streamId = parseInt(req.params.streamId);
        if (!streamId || isNaN(streamId)) return res.status(400).json({ error: 'Invalid stream ID' });

        const stream = db.getStreamById(streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== user.id && user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) return res.status(409).json({ error: 'Stream is not live — go live first' });
        if (stream.protocol !== 'webrtc') return res.status(409).json({ error: 'Stream protocol must be webrtc for WHIP' });

        // Parse SDP offer
        const offerSdpStr = req.body;
        if (!offerSdpStr || typeof offerSdpStr !== 'string') {
            return res.status(400).json({ error: 'Missing SDP offer in request body' });
        }
        const offerSdp = sdpTransform.parse(offerSdpStr);

        // Create Mediasoup room and transport
        const roomId = `stream-${streamId}`;
        const room = await webrtcSFU.getOrCreateRoom(roomId);
        const resourceId = generateResourceId();
        const peerId = `whip-${resourceId}`;

        const transport = await room.router.createWebRtcTransport({
            listenIps: [{ ip: config.mediasoup.listenIp, announcedIp: config.mediasoup.announcedIp }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate: 10000000,
        });

        room.transports.set(`${peerId}-${transport.id}`, transport);

        // Connect transport with offer's DTLS parameters
        const dtlsParams = extractDtlsParameters(offerSdp);
        await transport.connect({ dtlsParameters: dtlsParams });

        // Create producers for each media section
        const routerCaps = room.router.rtpCapabilities;
        const producersByKind = {};
        const producerIds = [];

        for (const media of offerSdp.media || []) {
            if (media.port === 0) continue;

            const rtpParams = extractRtpParameters(media, routerCaps);
            if (!rtpParams || rtpParams.codecs.length === 0) {
                console.warn(`[WHIP] No compatible codec for ${media.type} in stream ${streamId}`);
                continue;
            }

            const producer = await transport.produce({
                kind: media.type,
                rtpParameters: rtpParams,
            });

            room.producers.set(producer.id, { producer, peerId, transportId: transport.id });
            producersByKind[media.type] = producer;
            producerIds.push(producer.id);

            producer.on('transportclose', () => {
                room.producers.delete(producer.id);
                webrtcSFU.emit('producer-removed', { roomId, producerId: producer.id, kind: media.type });
            });

            webrtcSFU.emit('producer-added', { roomId, producerId: producer.id, kind: media.type, peerId });
            console.log(`[WHIP] Producer created: ${producer.id} (${media.type}) for stream ${streamId}`);
        }

        if (producerIds.length === 0) {
            transport.close();
            room.transports.delete(`${peerId}-${transport.id}`);
            return res.status(406).json({ error: 'No compatible codecs — router supports VP8, H264, Opus' });
        }

        // Build SDP answer
        const answerSdp = buildSdpAnswer(transport, offerSdp, producersByKind);

        // Store session
        sessions.set(resourceId, {
            streamId,
            roomId,
            peerId,
            transportId: transport.id,
            producerIds,
            userId: user.id,
        });

        // Auto-cleanup on transport close
        transport.on('dtlsstatechange', (state) => {
            if (state === 'closed' || state === 'failed') {
                console.log(`[WHIP] Transport DTLS ${state} for stream ${streamId}`);
                cleanupSession(resourceId);
            }
        });

        console.log(`[WHIP] Session ${resourceId} created for stream ${streamId} (${producerIds.length} producer(s))`);

        res.status(201)
            .set('Content-Type', 'application/sdp')
            .set('Location', `/whip/${streamId}/${resourceId}`)
            .set('Access-Control-Expose-Headers', 'Location, Link')
            .send(answerSdp);

    } catch (err) {
        console.error('[WHIP] POST error:', err);
        res.status(500).json({ error: 'WHIP negotiation failed' });
    }
}

/**
 * PATCH /whip/:streamId/:resourceId — ICE trickle
 */
function handleWhipPatch(req, res) {
    const { resourceId } = req.params;
    const session = sessions.get(resourceId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Mediasoup handles ICE internally — acknowledge
    res.status(204).end();
}

/**
 * DELETE /whip/:streamId/:resourceId — End WHIP session
 */
function handleWhipDelete(req, res) {
    const { resourceId } = req.params;
    cleanupSession(resourceId);
    res.status(200).end();
}

/**
 * OPTIONS /whip/* — CORS/discovery
 */
function handleWhipOptions(req, res) {
    res.status(204)
        .set('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS')
        .set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        .set('Access-Control-Expose-Headers', 'Location, Link')
        .end();
}

/**
 * Clean up a WHIP ingestion session.
 */
function cleanupSession(resourceId) {
    const session = sessions.get(resourceId);
    if (!session) return;

    sessions.delete(resourceId);

    try {
        const room = webrtcSFU.rooms?.get(session.roomId);
        if (room) {
            for (const pid of session.producerIds) {
                const entry = room.producers.get(pid);
                if (entry) {
                    try { entry.producer.close(); } catch {}
                    room.producers.delete(pid);
                }
            }
            const transportKey = `${session.peerId}-${session.transportId}`;
            const transport = room.transports.get(transportKey);
            if (transport) {
                try { transport.close(); } catch {}
                room.transports.delete(transportKey);
            }
        }
        console.log(`[WHIP] Session ${resourceId} cleaned up (stream ${session.streamId})`);
    } catch (err) {
        console.error(`[WHIP] Cleanup error for ${resourceId}:`, err.message);
    }
}

// ── SFU Viewer Support ───────────────────────────────────────
// Viewer consumption is now handled via mediasoup-client signaling in
// broadcast-server.js. The hand-built SDP approach (buildViewerSdpOffer,
// createSfuViewerOffer, handleSfuViewerAnswer, cleanupSfuViewer) has been
// removed in favor of proper Device/RecvTransport on the viewer client.

/**
 * Check if SFU has producers for a given stream.
 */
function hasSfuProducers(streamId) {
    const roomId = `stream-${streamId}`;
    return webrtcSFU.hasProducers(roomId);
}

module.exports = {
    handleWhipPost,
    handleWhipPatch,
    handleWhipDelete,
    handleWhipOptions,
    hasSfuProducers,
    sessions,
    cleanupSession,
    available: !!sdpTransform,
};
