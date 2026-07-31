/**
 * stream-audio.js — Capture a short audio chunk from a LIVE stream to a wav file,
 * for feeding into speech-to-text. Supports both ingest paths:
 *   - RTMP:  pull the HTTP-FLV output (http://127.0.0.1:<flvPort>/live/<key>.flv)
 *   - WHIP:  create a mediasoup PlainRTP consumer off the live audio producer
 *            (mirrors the thumbnail service's video grabber).
 *
 * Returns a path to a 16kHz mono wav on success, or null. Caller deletes the file.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const db = require('../db/database');

const FLV_PORT = (config.rtmp?.port || 1935) + 8000;

function tmpWav(streamId) {
    return path.join(os.tmpdir(), `hobo-aihear-${streamId}-${Date.now()}.wav`);
}

function resolveStreamKey(stream) {
    if (stream.managed_stream_key) return stream.managed_stream_key;
    try { return db.getUserById(stream.user_id)?.stream_key || null; } catch { return null; }
}

function runFfmpeg(args, killMs) {
    return new Promise((resolve) => {
        let ff;
        try { ff = spawn('ffmpeg', args, { stdio: 'ignore' }); }
        catch { return resolve(false); }
        const killTimer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, killMs);
        ff.on('close', (code) => { clearTimeout(killTimer); resolve(code === 0); });
        ff.on('error', () => { clearTimeout(killTimer); resolve(false); });
    });
}

async function captureRtmp(stream, seconds) {
    const streamKey = resolveStreamKey(stream);
    if (!streamKey) return null;
    const out = tmpWav(stream.id);
    const url = `http://127.0.0.1:${FLV_PORT}/live/${streamKey}.flv`;
    const ok = await runFfmpeg([
        '-y',
        '-rw_timeout', '10000000',
        '-analyzeduration', '3000000', '-probesize', '2000000',
        '-i', url,
        '-t', String(seconds),
        '-vn', '-ac', '1', '-ar', '16000',
        '-f', 'wav', out,
    ], (seconds + 10) * 1000);
    if (ok && fs.existsSync(out) && fs.statSync(out).size > 1024) return out;
    try { fs.existsSync(out) && fs.unlinkSync(out); } catch {}
    return null;
}

async function captureWebrtc(stream, seconds) {
    let webrtcSFU;
    try { webrtcSFU = require('../streaming/webrtc-sfu'); } catch { return null; }
    const roomId = `stream-${stream.id}`;

    let audioProducer;
    try { audioProducer = await webrtcSFU.waitForProducer(roomId, 'audio', 5000); }
    catch { return null; }
    if (!audioProducer) return null;

    // RTP port range distinct from recorder (25100) and thumbnail (26100)
    const rtpPort = 26300 + (stream.id % 100) * 2;
    const rtcpPort = rtpPort + 1;

    let consumer;
    try {
        consumer = await webrtcSFU.createPlainConsumer(roomId, audioProducer.id, '127.0.0.1', rtpPort, rtcpPort);
    } catch { return null; }

    const pt = consumer.payloadType;
    const codecName = (consumer.mimeType || 'audio/opus').split('/')[1] || 'opus';
    const clockRate = consumer.clockRate || 48000;
    const channels = consumer.channels || 2;
    const sdpLines = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=HoboStreamer AI Hear',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        `m=audio ${rtpPort} RTP/AVP ${pt}`,
        `a=rtpmap:${pt} ${codecName}/${clockRate}/${channels}`,
        'a=recvonly',
        '',
    ];
    if (consumer.ssrc) sdpLines.splice(-1, 0, `a=ssrc:${consumer.ssrc} cname:aihear-audio`);
    const sdpContent = sdpLines.join('\r\n');
    const sdpPath = path.join(os.tmpdir(), `hobo-aihear-${stream.id}-${Date.now()}.sdp`);
    const out = tmpWav(stream.id);

    const cleanup = () => {
        try { webrtcSFU.closePlainConsumer(roomId, consumer.transportId); } catch {}
        try { fs.existsSync(sdpPath) && fs.unlinkSync(sdpPath); } catch {}
    };

    try { fs.writeFileSync(sdpPath, sdpContent, 'utf8'); }
    catch { cleanup(); return null; }

    const ok = await runFfmpeg([
        '-y',
        '-protocol_whitelist', 'file,rtp,udp',
        '-thread_queue_size', '512',
        '-analyzeduration', '3000000', '-probesize', '1000000',
        '-use_wallclock_as_timestamps', '1',
        '-fflags', '+genpts+discardcorrupt+nobuffer+igndts',
        '-err_detect', 'ignore_err',
        '-i', sdpPath,
        '-t', String(seconds),
        '-vn', '-ac', '1', '-ar', '16000',
        '-f', 'wav', out,
    ], (seconds + 10) * 1000);

    cleanup();
    if (ok && fs.existsSync(out) && fs.statSync(out).size > 1024) return out;
    try { fs.existsSync(out) && fs.unlinkSync(out); } catch {}
    return null;
}

/**
 * Capture ~`seconds` of the stream's audio to a 16kHz mono wav.
 * Picks the ingest path from the stream protocol, with a fallback.
 * @returns {Promise<string|null>} wav path (caller unlinks) or null.
 */
async function captureAudioChunk(stream, seconds = 12) {
    if (!stream) return null;
    const proto = String(stream.protocol || '').toLowerCase();
    try {
        if (proto === 'rtmp') {
            return await captureRtmp(stream, seconds);
        }
        // webrtc/whip (and jsmpeg, which also flows through the SFU room) → try SFU first
        const viaSfu = await captureWebrtc(stream, seconds);
        if (viaSfu) return viaSfu;
        // Fallback: some setups still expose an FLV mirror
        return await captureRtmp(stream, seconds);
    } catch (err) {
        console.warn(`[AI-Hear] audio capture failed for stream ${stream.id}:`, err.message);
        return null;
    }
}

module.exports = { captureAudioChunk };
