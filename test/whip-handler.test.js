const assert = require('assert');
const { _extractRtpParameters } = require('../server/streaming/whip-handler');
const config = require('../server/config');

const routerCaps = {
    codecs: config.mediasoup.mediaCodecs,
    headerExtensions: [],
};

const audioMedia = {
    type: 'audio',
    payloads: '111 0',
    rtp: [
        { payload: 111, codec: 'opus', rate: 48000, encoding: 2 },
        { payload: 0, codec: 'PCMU', rate: 8000 },
    ],
    fmtp: [
        { payload: 111, config: 'minptime=10;useinbandfec=1' },
    ],
    rtcpFb: [
        { payload: 111, type: 'transport-cc' },
    ],
    ext: [
        { uri: 'urn:ietf:params:rtp-hdrext:sdes:mid', value: 1 },
    ],
    ssrcs: [
        { id: '12345678', attribute: 'cname', value: 'test-opus' },
        { id: '12345678', attribute: 'msid', value: 'audio-stream audio-track' },
    ],
    mid: '0',
};

const rtpParameters = _extractRtpParameters(audioMedia, routerCaps, 0);
assert.ok(rtpParameters, 'Expected RTP parameters to be extracted');
assert.strictEqual(rtpParameters.mid, '0');
assert.ok(Array.isArray(rtpParameters.encodings), 'Encodings must be an array');
assert.strictEqual(rtpParameters.encodings.length, 1);
assert.strictEqual(rtpParameters.encodings[0].ssrc, 12345678);
assert.strictEqual(rtpParameters.codecs[0].mimeType, 'audio/opus');
assert.notDeepStrictEqual(rtpParameters.encodings[0], {}, 'Encoding object must not be empty');

console.log('✅ WHIP handler RTP encoding regression test passed');

const { buildWhipResponseHeaders, handleWhipOptions } = require('../server/streaming/whip-handler');

const req = {
    protocol: 'https',
    get: () => 'whip.example.com',
};

const headers = buildWhipResponseHeaders(req, '123', 'resource-abc');
assert.strictEqual(headers.Location, 'http://localhost:3000/whip/123/resource-abc');
assert.strictEqual(headers['Access-Control-Expose-Headers'], 'Location');
assert.ok(!Object.prototype.hasOwnProperty.call(headers, 'Link'));

const res = {
    statusCode: null,
    headers: {},
    ended: false,
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    end() { this.ended = true; },
};

handleWhipOptions({}, res);
assert.strictEqual(res.statusCode, 204);
assert.strictEqual(res.headers['Access-Control-Expose-Headers'], 'Location');
assert.ok(!('Link' in res.headers));
assert.strictEqual(res.ended, true);

console.log('✅ WHIP handler response header regression test passed');
