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

function normalizeOrigin(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

function buildWhipResourceUrl(req, streamId, resourceId) {
    const baseUrl = normalizeOrigin(config.whip?.publicUrl || config.webrtc?.publicUrl || config.baseUrl) || `${req.protocol}://${req.get('host')}`;
    try {
        return new URL(`/whip/${streamId}/${resourceId}`, baseUrl).toString();
    } catch {
        return `/whip/${streamId}/${resourceId}`;
    }
}

function buildWhipResponseHeaders(req, streamId, resourceId) {
    return {
        Location: buildWhipResourceUrl(req, streamId, resourceId),
        'Access-Control-Expose-Headers': 'Location',
    };
}

function sendWhipError(res, status, code, message) {
    res.status(status)
        .set('X-WHIP-ERROR', code)
        .json({ error: message, error_code: code });
}

function logWhipStage(stage, streamId, info = {}) {
    const details = Object.entries(info)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    console.log(`[WHIP] [${stage}] stream=${streamId} ${details}`);
}

function findSessionsByStreamId(streamId) {
    const matches = [];
    for (const [resourceId, session] of sessions.entries()) {
        if (session.streamId === streamId) matches.push({ resourceId, session });
    }
    return matches;
}

function cleanupExistingSessionsForStream(streamId) {
    for (const { resourceId } of findSessionsByStreamId(streamId)) {
        console.log(`[WHIP] Cleaning existing WHIP session ${resourceId} for stream ${streamId}`);
        cleanupSession(resourceId);
    }
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
function extractRtpParameters(media, routerCapabilities, mediaIndex = 0) {
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

        if (offered.mimeType.toLowerCase().endsWith('/rtx')) continue;

        const match = routerCodecs.find(rc => {
            if (rc.mimeType.toLowerCase() !== offered.mimeType.toLowerCase()) return false;
            if (rc.clockRate !== offered.clockRate) return false;
            if (offered.channels && rc.channels && offered.channels !== rc.channels) return false;
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
        if (offered.mimeType.toLowerCase() === `${media.type}/rtx` && offered.parameters?.apt === primaryCodec.payloadType) {
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

    function getSsrcEntries() {
        if (Array.isArray(media.ssrcs)) return media.ssrcs.filter(Boolean);
        if (media.ssrc) return [media.ssrc];
        return [];
    }

    function normalizeSsrc(value) {
        if (value === undefined || value === null) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : String(value);
    }

    const ssrcCandidates = getSsrcEntries();
    const mainSsrc = ssrcCandidates.find(s => s.attribute === 'cname')?.id || ssrcCandidates[0]?.id;
    let encoding = null;

    if (mainSsrc) {
        encoding = { ssrc: normalizeSsrc(mainSsrc) };
        const fidGroup = (media.ssrcGroups || []).find(g => g.semantics === 'FID' || g.semantics === 'fid');
        if (fidGroup && typeof fidGroup.ssrcs === 'string') {
            const parts = fidGroup.ssrcs.split(' ').map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2 && String(normalizeSsrc(parts[0])) === String(encoding.ssrc)) {
                encoding.rtx = { ssrc: normalizeSsrc(parts[1]) };
            }
        }
    } else if (Array.isArray(media.rids) && media.rids.length > 0) {
        const ridValue = media.rids[0]?.id || media.rids[0];
        if (ridValue) encoding = { rid: String(ridValue) };
    } else if (media.rid) {
        encoding = { rid: String(media.rid) };
    }

    if (!encoding) {
        const error = new Error('No RTP encoding found in SDP media section');
        error.code = 'invalid_rtp_encoding';
        error.mediaType = media.type;
        error.mid = media.mid != null ? String(media.mid) : String(mediaIndex);
        throw error;
    }

    encodings.push(encoding);

    const rtpParameters = { codecs, headerExtensions, encodings };
    rtpParameters.mid = media.mid != null ? String(media.mid) : String(mediaIndex);
    return rtpParameters;
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
        return sendWhipError(res, 503, 'whip_unavailable', 'WHIP not available (sdp-transform not installed)');
    }

    try {
        // Auth via Bearer token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).set('WWW-Authenticate', 'Bearer').set('X-WHIP-ERROR', 'authentication_required').json({ error: 'Bearer token required', error_code: 'authentication_required' });
        }
        const token = authHeader.slice(7);
        const decoded = verifyToken(token);
        if (!decoded) return sendWhipError(res, 401, 'invalid_token', 'Invalid or expired token');
        const user = resolveHoboToolsUser(decoded);
        if (!user) return sendWhipError(res, 401, 'user_not_found', 'User not found');
        logWhipStage('auth', 'unknown', { user_id: user.id });

        // Stream validation
        const streamId = parseInt(req.params.streamId, 10);
        if (!streamId || isNaN(streamId)) return sendWhipError(res, 400, 'invalid_stream_id', 'Invalid stream ID');

        const stream = db.getStreamById(streamId);
        if (!stream) return sendWhipError(res, 404, 'stream_not_found', 'Stream not found');
        if (stream.user_id !== user.id && user.role !== 'admin') {
            return sendWhipError(res, 403, 'not_your_stream', 'Not your stream');
        }
        if (!stream.is_live) return sendWhipError(res, 409, 'stream_not_live', 'Stream is not live — go live first');
        if (stream.protocol !== 'webrtc') return sendWhipError(res, 409, 'wrong_protocol', 'Stream protocol must be webrtc for WHIP');
        if (!webrtcSFU.ready) return sendWhipError(res, 503, 'sfu_unavailable', 'WebRTC SFU unavailable');
        logWhipStage('stream_validation', streamId, { protocol: stream.protocol, live: stream.is_live });

        cleanupExistingSessionsForStream(streamId);

        // Parse SDP offer
        const offerSdpStr = req.body;
        if (!offerSdpStr || typeof offerSdpStr !== 'string') {
            return sendWhipError(res, 400, 'missing_sdp', 'Missing SDP offer in request body');
        }

        let offerSdp;
        try {
            offerSdp = sdpTransform.parse(offerSdpStr);
        } catch (err) {
            console.warn('[WHIP] Invalid SDP offer:', err.message);
            return sendWhipError(res, 400, 'invalid_sdp', 'Invalid SDP offer');
        }

        const roomId = `stream-${streamId}`;
        const room = await webrtcSFU.getOrCreateRoom(roomId);
        logWhipStage('room_creation', streamId, { roomId });

        const resourceId = generateResourceId();
        const peerId = `whip-${resourceId}`;

        const session = {
            streamId,
            roomId,
            peerId,
            transportId: null,
            producerIds: [],
            userId: user.id,
        };
        sessions.set(resourceId, session);

        let transportInfo;
        try {
            transportInfo = await webrtcSFU.createTransport(roomId, peerId);
        } catch (err) {
            console.warn('[WHIP] Transport creation failed for stream', streamId, err.message);
            cleanupSession(resourceId);
            logWhipStage('transport_creation', streamId, { success: false, error: err.message });
            return sendWhipError(res, 502, 'transport_creation_failed', 'WHIP transport creation failed');
        }

        session.transportId = transportInfo.id;
        const transport = room.transports.get(`${peerId}-${transportInfo.id}`);
        if (!transport) {
            console.error(`[WHIP] Transport missing after createTransport for stream ${streamId}, transport ${transportInfo.id}`);
            cleanupSession(resourceId);
            return sendWhipError(res, 502, 'transport_creation_failed', 'WHIP transport creation failed');
        }
        logWhipStage('transport_creation', streamId, { transportId: transportInfo.id });

        try {
            const dtlsParams = extractDtlsParameters(offerSdp);
            await webrtcSFU.connectTransport(roomId, peerId, transportInfo.id, dtlsParams);
            console.log(`[WHIP] DTLS connected for stream ${streamId}, transport ${transportInfo.id}`);
        } catch (err) {
            console.warn('[WHIP] DTLS negotiation failed for stream', streamId, err.message);
            cleanupSession(resourceId);
            logWhipStage('dtls_connect', streamId, { success: false, error: err.message });
            return sendWhipError(res, 502, 'dtls_negotiation_failed', 'DTLS negotiation failed');
        }
        logWhipStage('dtls_connect', streamId, { transportId: transportInfo.id });

        const routerCaps = room.router.rtpCapabilities;
        const producersByKind = {};

        for (const [mediaIndex, media] of (offerSdp.media || []).entries()) {
            if (media.port === 0) continue;

            let rtpParams;
            try {
                rtpParams = extractRtpParameters(media, routerCaps, mediaIndex);
            } catch (err) {
                if (err.code === 'invalid_rtp_encoding') {
                    console.warn('[WHIP] Invalid RTP encoding in SDP:', err.message);
                    logWhipStage('rtp_parse', streamId, { kind: media.type, mid: err.mid, error: err.message });
                    cleanupSession(resourceId);
                    return sendWhipError(res, 400, 'invalid_rtp_encoding', `Invalid RTP encoding for ${media.type}`);
                }
                throw err;
            }

            if (!rtpParams || rtpParams.codecs.length === 0) {
                console.warn(`[WHIP] No compatible codec for ${media.type} in stream ${streamId}`);
                logWhipStage('rtp_parse', streamId, { kind: media.type, success: false });
                continue;
            }
            logWhipStage('rtp_parse', streamId, { kind: media.type, mid: rtpParams.mid, encodings: JSON.stringify(rtpParams.encodings) });

            let producer;
            try {
                producer = await transport.produce({ kind: media.type, rtpParameters: rtpParams });
            } catch (err) {
                console.warn(`[WHIP] Producer creation failed for ${media.type} in stream ${streamId}:`, err.message);
                logWhipStage('producer_creation', streamId, { kind: media.type, success: false, error: err.message });
                cleanupSession(resourceId);
                return sendWhipError(res, 502, 'producer_creation_failed', 'Failed to create media producer');
            }
            logWhipStage('producer_creation', streamId, { kind: media.type, success: true, producerId: producer.id });

            room.producers.set(producer.id, { producer, peerId, transportId: transportInfo.id });
            producersByKind[media.type] = producer;
            session.producerIds.push(producer.id);

            producer.on('transportclose', () => {
                room.producers.delete(producer.id);
                webrtcSFU.emit('producer-removed', { roomId, producerId: producer.id, kind: media.type });
            });

            webrtcSFU.emit('producer-added', { roomId, producerId: producer.id, kind: media.type, peerId });
            console.log(`[WHIP] Producer created: ${producer.id} (${media.type}) for stream ${streamId}`);
        }

        if (session.producerIds.length === 0) {
            cleanupSession(resourceId);
            return sendWhipError(res, 406, 'no_compatible_codecs', 'No compatible codecs — router supports VP8, H264, Opus');
        }

        let answerSdp;
        try {
            answerSdp = buildSdpAnswer(transport, offerSdp, producersByKind);
        } catch (err) {
            console.error('[WHIP] SDP answer generation failed:', err.message);
            cleanupSession(resourceId);
            logWhipStage('answer_generation', streamId, { success: false, error: err.message });
            return sendWhipError(res, 500, 'answer_generation_failed', 'Failed to generate SDP answer');
        }
        logWhipStage('answer_generation', streamId, { producers: session.producerIds.length });

        transport.on('dtlsstatechange', (state) => {
            if (state === 'closed' || state === 'failed') {
                console.log(`[WHIP] Transport DTLS ${state} for stream ${streamId}`);
                cleanupSession(resourceId);
            }
        });

        console.log(`[WHIP] Session ${resourceId} created for stream ${streamId} (${session.producerIds.length} producer(s))`);
        logWhipStage('response_send', streamId, { resourceId, status: 201 });

        res.status(201)
            .set('Content-Type', 'application/sdp')
            .set(buildWhipResponseHeaders(req, streamId, resourceId))
            .send(answerSdp);

    } catch (err) {
        console.error('[WHIP] POST error:', err.message || err);
        sendWhipError(res, 500, 'internal_server_error', 'WHIP negotiation failed');
    }
}

/**
 * PATCH /whip/:streamId/:resourceId — ICE trickle
 */
function handleWhipPatch(req, res) {
    const { resourceId } = req.params;
    const session = sessions.get(resourceId);
    if (!session) return sendWhipError(res, 404, 'session_not_found', 'Session not found');

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
        .set('Access-Control-Expose-Headers', 'Location')
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
    buildWhipResourceUrl,
    buildWhipResponseHeaders,
    hasSfuProducers,
    sessions,
    cleanupSession,
    available: !!sdpTransform,
    _extractRtpParameters: extractRtpParameters,
};
