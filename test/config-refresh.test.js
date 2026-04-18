const assert = require('assert');
const config = require('../server/config');

const originalFetch = global.fetch;
global.fetch = async () => ({ ok: true, json: async () => ({ registry: { WHIP_PUBLIC_URL: { value: 'https://webrtc.example.com', source: 'admin' } } }) });

(async () => {
    config.internalApiKey = 'test-key';
    config.hoboToolsInternalUrl = 'http://127.0.0.1:3100';
    await config.refreshRegistry();
    assert.strictEqual(config.whip.publicUrl, 'https://webrtc.example.com');
    console.log('✅ hobostreamer config refresh test passed');
    global.fetch = originalFetch;
})();
