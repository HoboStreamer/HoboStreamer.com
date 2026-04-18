const assert = require('assert');
const http = require('http');
const path = require('path');

async function withServer(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (err) => err ? reject(err) : resolve()));
    try {
        await handler.portReady;
    } catch {}
    return server;
}

(async () => {
    process.env.INTERNAL_API_KEY = 'test-refresh-key';

    const server = http.createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== '/internal/url-registry/resolved') {
            res.statusCode = 404;
            return res.end('not found');
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, registry: {
            BASE_URL: { value: 'https://hobostreamer.com', source: 'bootstrap' },
            WEBRTC_PUBLIC_URL: { value: 'https://hobostreamer.com', source: 'bootstrap' },
            WHIP_PUBLIC_URL: { value: 'https://hobostreamer.com', source: 'bootstrap' },
            HOBO_TOOLS_URL: { value: 'https://hobo.tools', source: 'bootstrap' },
        } }));
    });

    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (err) => err ? reject(err) : resolve()));
    const port = server.address().port;
    process.env.HOBO_TOOLS_INTERNAL_URL = `http://127.0.0.1:${port}`;
    process.env.NODE_ENV = 'production';

    const config = require('../server/config');
    await config.refreshRegistry();

    assert.strictEqual(config.baseUrl, 'https://hobostreamer.com');
    assert.strictEqual(config.webrtc.publicUrl, 'https://hobostreamer.com');
    assert.strictEqual(config.whip.publicUrl, 'https://hobostreamer.com');
    assert.strictEqual(config.hoboToolsUrl, 'https://hobo.tools');

    server.close();

    const routes = require('../server/streaming/routes');
    assert(routes, 'Streaming routes should load without syntax errors');

    console.log('✅ HoboStreamer config refresh and streaming route syntax test passed');
})();
