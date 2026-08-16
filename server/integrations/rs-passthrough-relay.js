/**
 * HoboStreamer — RobotStreamer RAW passthrough relay (zero re-encode).
 *
 * The old native publisher decodes the stream and RE-ENCODES it to RobotStreamer
 * (ffmpeg + libwebrtc), and browser broadcasters publish to RS from the browser as a
 * SECOND encode. Both waste CPU and soften the picture. This relay instead forwards
 * goosely's ALREADY-ENCODED RTP straight through:
 *
 *   our mediasoup SFU (goosely's producer, NACK-protected)
 *     → DirectTransport consumer (in-process, lossless, encoded RTP)
 *     → werift MediaStreamTrack.writeRtp (packets unchanged, no decode/encode)
 *     → werift RTCPeerConnection (DTLS-SRTP, its own ICE) joined to RS's mediasoup SFU
 *     → RobotStreamer (bit-exact original video, their low-latency WebRTC path)
 *
 * RTCP: RS's PLI/keyframe requests are relayed back to the source via
 * consumer.requestKeyFrame(). No transcode anywhere; RS gets the original bytes.
 *
 * The werift↔mediasoup bridge (hand-rolled SDP answer from RS's transport params) is
 * validated end-to-end in scratch/werift-ms-harness.js. RS's SFU is mediasoup, so the
 * same bridge applies. Gated behind config.robotstreamer.passthrough (default off) with
 * the transcode publisher kept as fallback.
 */
const WebSocket = require('ws');
const https = require('node:https');
const crypto = require('node:crypto');
const dgram = require('node:dgram');

let werift = null;
try { werift = require('werift'); } catch { /* optional dep — relay disabled if absent */ }

const RS_API_HOST = 'api.robotstreamer.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) HoboStreamer-RelayPassthrough';

function log(streamId, ...a) { console.log(`[RS Passthrough ${streamId}]`, ...a); }

// ── RS HTTP API (robot_page_load → rtc_sfu host/port) ────────────────────
function postJson(host, path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request({
            host, port: 443, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': UA },
            timeout: 15000, rejectUnauthorized: false,
        }, res => {
            let raw = '';
            res.on('data', d => raw += d);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
                try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('RS API timeout')));
        req.write(payload); req.end();
    });
}

// ── protoo peer (mediasoup signaling over WS) ────────────────────────────
class ProtooPeer {
    constructor(url, robotId, onClose) {
        this.url = url; this.robotId = robotId; this.onClose = onClose;
        this.ws = null; this.nextId = Math.floor(Math.random() * 9000000) + 100000; this.pending = new Map();
    }
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url, ['protoo'], {
                headers: { Origin: 'https://robotstreamer.com', Referer: `https://robotstreamer.com/robot/${this.robotId}`, 'User-Agent': UA },
                rejectUnauthorized: false, handshakeTimeout: 15000, perMessageDeflate: false,
            });
            const timer = setTimeout(() => reject(new Error('RS SFU ws timeout')), 15000);
            this.ws.on('open', () => { clearTimeout(timer); resolve(); });
            this.ws.on('message', d => this._onMessage(d.toString()));
            this.ws.on('error', err => { clearTimeout(timer); reject(err); });
            this.ws.on('close', (code) => {
                for (const { reject: rej } of this.pending.values()) rej(new Error(`ws closed ${code}`));
                this.pending.clear();
                if (this.onClose) this.onClose(code);
            });
        });
    }
    _onMessage(raw) {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (msg.response && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id); this.pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.errorReason || msg.errorCode || `request ${msg.id} failed`));
            return;
        }
        // RS may push notifications/requests (e.g. keepalive) — ack requests so it stays happy.
        if (msg.request) { try { this.ws.send(JSON.stringify({ response: true, id: msg.id, ok: true, data: {} })); } catch {} }
    }
    request(method, data = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try { this.ws.send(JSON.stringify({ request: true, id, method, data })); }
            catch (e) { this.pending.delete(id); return reject(e); }
            setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`request timeout: ${method}`)); } }, 15000);
        });
    }
    close() { try { this.ws?.close(1000); } catch {} }
}

// ── SDP bridge (werift offer ↔ mediasoup transport params) ───────────────
// Parse werift's local offer into per-m-line media info + session fingerprint.
function parseOffer(sdp) {
    const out = { fingerprint: null, media: [] };
    let cur = null;
    for (const l of sdp.split(/\r?\n/)) {
        if (l.startsWith('a=fingerprint:') && !out.fingerprint) out.fingerprint = l.slice(14).trim();
        else if (l.startsWith('m=')) {
            const kind = l.slice(2).split(' ')[0];
            cur = { kind, pts: [], rtpmap: {}, fmtp: {}, ext: [], ssrc: null, cname: null, mid: null };
            out.media.push(cur);
        } else if (cur) {
            let m;
            if (l.startsWith('a=mid:')) cur.mid = l.slice(6).trim();
            else if ((m = l.match(/^a=rtpmap:(\d+) ([^/]+)\/(\d+)(?:\/(\d+))?/))) { cur.rtpmap[m[1]] = { name: m[2], clock: +m[3], channels: m[4] ? +m[4] : undefined }; if (!cur.pts.includes(m[1])) cur.pts.push(m[1]); }
            else if ((m = l.match(/^a=fmtp:(\d+) (.+)/))) cur.fmtp[m[1]] = m[2];
            else if ((m = l.match(/^a=extmap:(\d+)(?:\/\w+)? (\S+)/))) cur.ext.push({ id: +m[1], uri: m[2] });
            else if ((m = l.match(/^a=ssrc:(\d+) cname:(\S+)/))) { cur.ssrc = +m[1]; cur.cname = m[2]; }
            else if (!cur.ssrc && (m = l.match(/^a=ssrc:(\d+)/))) cur.ssrc = +m[1];
        }
    }
    return out;
}

// Build an SDP answer from RS's WebRtcTransport params. RS is ice-lite + DTLS server,
// so setup:passive → werift becomes DTLS client. One transport, BUNDLE over all m-lines.
function buildAnswer(transportInfo, offer) {
    const fp = (transportInfo.dtlsParameters.fingerprints.find(f => f.algorithm === 'sha-256') || transportInfo.dtlsParameters.fingerprints[0]);
    const ice = transportInfo.iceParameters;
    const mids = offer.media.map(m => m.mid).join(' ');
    const lines = [
        'v=0', 'o=robotstreamer 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0',
        `a=group:BUNDLE ${mids}`, 'a=msid-semantic: WMS *',
    ];
    for (const md of offer.media) {
        const pt = md.pts[0];
        const rm = md.rtpmap[pt];
        const isVideo = md.kind === 'video';
        lines.push(`m=${md.kind} 7 UDP/TLS/RTP/SAVPF ${pt}`);
        lines.push('c=IN IP4 127.0.0.1');
        lines.push('a=rtcp:9 IN IP4 0.0.0.0');
        lines.push(`a=ice-ufrag:${ice.usernameFragment}`);
        lines.push(`a=ice-pwd:${ice.password}`);
        lines.push('a=ice-lite');
        lines.push(`a=fingerprint:sha-256 ${fp.value}`);
        lines.push('a=setup:passive');
        lines.push(`a=mid:${md.mid}`);
        lines.push('a=recvonly');
        lines.push('a=rtcp-mux');
        lines.push('a=rtcp-rsize');
        lines.push(`a=rtpmap:${pt} ${rm.name}/${rm.clock}${rm.channels ? '/' + rm.channels : ''}`);
        if (md.fmtp[pt]) lines.push(`a=fmtp:${pt} ${md.fmtp[pt]}`);
        if (isVideo) {
            lines.push(`a=rtcp-fb:${pt} nack`);
            lines.push(`a=rtcp-fb:${pt} nack pli`);
            lines.push(`a=rtcp-fb:${pt} ccm fir`);
            lines.push(`a=rtcp-fb:${pt} goog-remb`);
        }
    }
    // ICE candidates apply to the whole bundle; attach to first m-line only is fine for werift.
    let candLines = '';
    for (const cand of transportInfo.iceCandidates) {
        candLines += `a=candidate:${cand.foundation} 1 ${cand.protocol} ${cand.priority} ${cand.ip} ${cand.port} typ ${cand.type}${cand.tcpType ? ' tcptype ' + cand.tcpType : ''}\r\n`;
    }
    // insert candidates after the first m-line's attributes (append to whole sdp; werift tolerates)
    return lines.join('\r\n') + '\r\n' + candLines + 'a=end-of-candidates\r\n';
}

// mediasoup produce rtpParameters mirroring exactly what werift will send on this m-line.
function buildProduceParams(md) {
    const pt = +md.pts[0];
    const rm = md.rtpmap[md.pts[0]];
    const codec = {
        mimeType: `${md.kind}/${rm.name}`,
        payloadType: pt,
        clockRate: rm.clock,
        parameters: {},
        rtcpFeedback: md.kind === 'video'
            ? [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'goog-remb' }]
            : [],
    };
    if (rm.channels) codec.channels = rm.channels;
    if (md.fmtp[md.pts[0]]) {
        for (const kv of md.fmtp[md.pts[0]].split(';')) {
            const [k, v] = kv.trim().split('=');
            if (k) codec.parameters[k] = /^\d+$/.test(v) ? +v : v;
        }
    }
    return {
        mid: md.mid,
        codecs: [codec],
        headerExtensions: [], // forwarded packets are stripped of extensions → declare none
        encodings: [{ ssrc: md.ssrc }],
        rtcp: { cname: md.cname || 'hobo-relay', reducedSize: true },
    };
}

// Open a lossless in-process ingest for a producer: a mediasoup PlainTransport consumer
// pipes the producer's ENCODED RTP to a localhost UDP socket we read. (DirectTransport's
// consumer 'rtp' event does not fire in this mediasoup build, so we use the same
// PlainTransport→UDP mechanism the transcode publisher uses — proven to deliver RTP.)
async function openPlainIngest(sfu, roomId, producerId) {
    const socket = dgram.createSocket('udp4');
    await new Promise((res, rej) => {
        socket.once('error', rej);
        socket.bind(0, '127.0.0.1', () => { socket.removeListener('error', rej); res(); });
    });
    try { socket.setRecvBufferSize?.(4 * 1024 * 1024); } catch { /* best effort */ }
    const port = socket.address().port;
    const info = await sfu.createPlainConsumer(roomId, producerId, '127.0.0.1', port, port + 1);
    return { socket, port, transportId: info.transportId, consumerId: info.consumerId, payloadType: info.payloadType, kind: info.kind };
}

// ── Relay ────────────────────────────────────────────────────────────────
class RsPassthroughRelay {
    constructor() {
        /** @type {Map<number, object>} streamId → session */
        this.sessions = new Map();
    }

    available() { return !!werift; }
    isActive(streamId) { return this.sessions.has(streamId); }

    async start(stream, integration) {
        if (!werift) { log(stream.id, 'werift not installed — cannot start passthrough'); return false; }
        if (this.sessions.has(stream.id)) return true;
        const session = { streamId: stream.id, robotId: integration.robot_id, token: integration.token, stopped: false, peer: null, pc: null, ingests: [], roomId: `stream-${stream.id}`, restartTimer: null };
        this.sessions.set(stream.id, session);
        this._run(session).catch(err => {
            log(stream.id, 'run error:', err.message);
            this._teardown(session);
            this._scheduleRestart(session, stream, integration);
        });
        return true;
    }

    stop(streamId) {
        const s = this.sessions.get(streamId);
        if (!s) return;
        s.stopped = true;
        if (s.restartTimer) clearTimeout(s.restartTimer);
        this._teardown(s);
        this.sessions.delete(streamId);
        log(streamId, 'stopped');
    }

    _scheduleRestart(session, stream, integration) {
        if (session.stopped || session.restartTimer) return;
        session.restartTimer = setTimeout(() => {
            session.restartTimer = null;
            if (session.stopped) return;
            this.sessions.delete(session.streamId);
            log(session.streamId, 'restarting passthrough…');
            this.start(stream, integration);
        }, 4000);
    }

    _teardown(session) {
        if (session.statsTimer) { clearInterval(session.statsTimer); session.statsTimer = null; }
        const sfu = require('../streaming/webrtc-sfu');
        for (const ing of session.ingests) {
            try { ing.socket.removeAllListeners('message'); ing.socket.close(); } catch {}
            try { sfu.closePlainConsumer(session.roomId, ing.transportId); } catch {}
        }
        session.ingests = [];
        try { session.pc?.close(); } catch {}
        try { session.peer?.close(); } catch {}
        session.pc = null; session.peer = null;
    }

    async _run(session) {
        const { RTCPeerConnection, MediaStreamTrack, RtpPacket } = werift;
        const sfu = require('../streaming/webrtc-sfu');
        if (!sfu.ready) throw new Error('mediasoup SFU not ready');
        const sid = session.streamId;

        // 1) Source producers on our SFU (wait for video; audio optional).
        const videoProd = await sfu.waitForProducer(session.roomId, 'video', 30000);
        const audioProd = sfu.findProducerByKind(session.roomId, 'audio');
        log(sid, `source producers: video=${videoProd.id}${audioProd ? ` audio=${audioProd.id}` : ' (no audio)'}`);

        // 2) Encoded-RTP ingest (PlainTransport → localhost UDP socket).
        const videoIn = await openPlainIngest(sfu, session.roomId, videoProd.id);
        session.ingests.push(videoIn);
        let audioIn = null;
        if (audioProd) { audioIn = await openPlainIngest(sfu, session.roomId, audioProd.id); session.ingests.push(audioIn); }

        // 3) Connect to RS: discover SFU, open protoo.
        const page = await postJson(RS_API_HOST, '/v1/robot_page_load', { token: session.token, robot_id: session.robotId, referrer: `https://robotstreamer.com/robot/${session.robotId}` });
        if (!page?.rtc_sfu?.host || !page?.rtc_sfu?.port) throw new Error('robot_page_load missing rtc_sfu');
        const peerId = `p:${crypto.randomBytes(3).toString('hex')}`;
        const wsUrl = `wss://${page.rtc_sfu.host}:${page.rtc_sfu.port}/?roomId=${encodeURIComponent(session.robotId)}&peerId=${encodeURIComponent(peerId)}`;
        const peer = new ProtooPeer(wsUrl, session.robotId, (code) => {
            if (session.stopped) return;
            log(sid, `RS ws closed (${code}) — will restart`);
            const st = { id: sid }; const integ = { robot_id: session.robotId, token: session.token };
            this._teardown(session); this._scheduleRestart(session, st, integ);
        });
        session.peer = peer;
        await peer.connect();
        log(sid, 'RS protoo connected');

        const routerRtpCapabilities = await peer.request('getRouterRtpCapabilities');

        // 4) Create RS send transport.
        const transportInfo = await peer.request('createWebRtcTransport', { producing: true, consuming: false, streamkey: session.token });

        // 5) Build werift peer: one sendonly transceiver per source track.
        const pc = new RTCPeerConnection({});
        session.pc = pc;
        pc.connectionStateChange.subscribe(() => {
            log(sid, 'werift conn', pc.connectionState);
            if ((pc.connectionState === 'failed' || pc.connectionState === 'disconnected') && !session.stopped) {
                const st = { id: sid }; const integ = { robot_id: session.robotId, token: session.token };
                this._teardown(session); this._scheduleRestart(session, st, integ);
            }
        });

        const videoTrack = new MediaStreamTrack({ kind: 'video' });
        const videoTx = pc.addTransceiver(videoTrack, { direction: 'sendonly' });
        let audioTrack = null, audioTx = null;
        if (audioCon) { audioTrack = new MediaStreamTrack({ kind: 'audio' }); audioTx = pc.addTransceiver(audioTrack, { direction: 'sendonly' }); }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const parsed = parseOffer(pc.localDescription.sdp);
        const vMedia = parsed.media.find(m => m.kind === 'video');
        const aMedia = parsed.media.find(m => m.kind === 'audio');
        if (!vMedia?.ssrc || !vMedia?.pts.length) throw new Error('werift offer missing video ssrc/pt');

        // 6) Answer from RS transport params → werift connects ICE+DTLS as client.
        await pc.setRemoteDescription({ type: 'answer', sdp: buildAnswer(transportInfo, parsed) });

        // 7) Hand RS our DTLS fingerprint (role client) + join.
        const [fpAlg, fpVal] = parsed.fingerprint.split(' ');
        await peer.request('connectWebRtcTransport', { transportId: transportInfo.id, dtlsParameters: { role: 'client', fingerprints: [{ algorithm: fpAlg, value: fpVal }] } });
        await peer.request('join', { displayName: 'HoboStreamer', device: { flag: 'hobo-relay', name: 'werift', version: '1' }, rtpCapabilities: routerRtpCapabilities, token: session.token });
        log(sid, 'RS transport connected + joined');

        // 8) Produce (video, then audio) with rtpParameters matching what werift sends.
        const vProd = await peer.request('produce', { transportId: transportInfo.id, kind: 'video', rtpParameters: buildProduceParams(vMedia), appData: { source: 'hobo-passthrough' } });
        log(sid, 'RS video producer', vProd.id);
        if (aMedia?.ssrc) {
            const aProd = await peer.request('produce', { transportId: transportInfo.id, kind: 'audio', rtpParameters: buildProduceParams(aMedia), appData: { source: 'hobo-passthrough' } });
            log(sid, 'RS audio producer', aProd.id);
        }

        // 9) Forward encoded RTP straight through (strip our-router ext ids, match declared PT).
        //    Each UDP datagram from the PlainTransport consumer is one RTP packet.
        const stats = { v: 0, a: 0, pli: 0 };
        const vPt = +vMedia.pts[0];
        videoIn.socket.on('message', (buf) => {
            try { const p = RtpPacket.deSerialize(buf); p.header.payloadType = vPt; p.header.extensions = []; videoTrack.writeRtp(p); stats.v++; } catch { /* drop malformed */ }
        });
        if (audioIn && aMedia) {
            const aPt = +aMedia.pts[0];
            audioIn.socket.on('message', (buf) => {
                try { const p = RtpPacket.deSerialize(buf); p.header.payloadType = aPt; p.header.extensions = []; audioTrack.writeRtp(p); stats.a++; } catch { /* */ }
            });
        }

        // 10) Relay RS keyframe requests (PLI/FIR) back to the source encoder.
        const vSender = videoTx.sender;
        const reqKey = () => { stats.pli++; sfu.requestConsumerKeyFrame(session.roomId, videoIn.consumerId).catch?.(() => {}); };
        vSender.onPictureLossIndication?.subscribe(reqKey);

        // Throughput heartbeat so a live stream shows media actually flowing (not just connected).
        let lastV = 0, lastA = 0;
        session.statsTimer = setInterval(() => {
            log(sid, `flow: video ${Math.round((stats.v - lastV) / 10)}/s audio ${Math.round((stats.a - lastA) / 10)}/s (total v=${stats.v} a=${stats.a}) pli=${stats.pli} werift=${pc.connectionState}`);
            lastV = stats.v; lastA = stats.a;
        }, 10000);
        session.statsTimer.unref?.();
        vSender.onGenericNack?.subscribe(() => { /* werift retransmits from its own buffer; keyframe as backstop for heavy loss */ });
        for (const d of [250, 800, 2000]) setTimeout(reqKey, d); // ensure RS gets an early keyframe

        log(sid, '✅ raw passthrough live (zero re-encode)');
    }
}

module.exports = new RsPassthroughRelay();
// Exposed for the offline bridge test harness.
module.exports._internals = { parseOffer, buildAnswer, buildProduceParams };
