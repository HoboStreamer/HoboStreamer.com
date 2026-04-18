const assert = require('assert');

process.env.BASE_URL = 'https://example.com';
process.env.WEBRTC_PUBLIC_URL = '';
process.env.WHIP_PUBLIC_URL = 'https://whip.example.com';
process.env.WHIP_PUBLIC_URL_ENABLED = 'false';
process.env.MEDIASOUP_ANNOUNCED_IP = '';

const config = require('../server/config');

assert.strictEqual(config.baseUrl, 'https://example.com');
assert.strictEqual(config.webrtc.publicUrl, 'https://example.com');
assert.strictEqual(config.whip.publicUrl, 'https://whip.example.com');
assert.strictEqual(config.whip.enabled, false);
assert.strictEqual(config.mediasoup.announcedIp, 'example.com');

console.log('✅ WHIP config defaults regression test passed');
