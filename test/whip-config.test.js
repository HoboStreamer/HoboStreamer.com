const assert = require('assert');

process.env.BASE_URL = 'https://example.com';
process.env.WEBRTC_PUBLIC_URL = '';
process.env.MEDIASOUP_ANNOUNCED_IP = '';

const config = require('../server/config');

assert.strictEqual(config.baseUrl, 'https://example.com');
assert.strictEqual(config.webrtc.publicUrl, 'https://example.com');
assert.strictEqual(config.mediasoup.announcedIp, 'example.com');

console.log('✅ WHIP config defaults regression test passed');
