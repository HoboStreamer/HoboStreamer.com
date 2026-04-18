const assert = require('assert');
const config = require('../server/config');

const originalFetch = global.fetch;
global.fetch = async () => ({
    ok: true,
    json: async () => ({
        registry: {
            BASE_URL: { value: 'https://hobostreamer.com', source: 'bootstrap' },
            WEBRTC_PUBLIC_URL: { value: 'https://webrtc.hobostreamer.com', source: 'bootstrap' },
            WHIP_PUBLIC_URL: { value: 'https://whip.hobostreamer.com', source: 'admin' },
            JSMPEG_PUBLIC_URL: { value: 'https://jsmpeg.hobostreamer.com', source: 'bootstrap' },
            HOBO_TOOLS_URL: { value: 'https://hobo.tools', source: 'bootstrap' },
        }
    })
});

(async () => {
    config.internalApiKey = 'test-key';
    config.hoboToolsInternalUrl = 'http://127.0.0.1:3100';
    await config.refreshRegistry();
    assert.strictEqual(config.baseUrl, 'https://hobostreamer.com');
    assert.strictEqual(config.webrtc.publicUrl, 'https://webrtc.hobostreamer.com');
    assert.strictEqual(config.whip.publicUrl, 'https://whip.hobostreamer.com');
    assert.strictEqual(config.jsmpeg.publicUrl, 'https://jsmpeg.hobostreamer.com');
    assert.strictEqual(config.hoboToolsUrl, 'https://hobo.tools');
    console.log('✅ hobostreamer config refresh test passed');
    global.fetch = originalFetch;
})();
