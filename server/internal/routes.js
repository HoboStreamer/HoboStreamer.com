'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');

function requireInternalKey(req, res, next) {
    const key = req.headers['x-internal-key'];
    if (!key || key !== config.internalApiKey) {
        return res.status(403).json({ error: 'Invalid or missing internal key' });
    }
    next();
}

router.use(requireInternalKey);

router.post('/url-registry/refresh', async (req, res) => {
    try {
        await config.refreshRegistry();
        console.log('[Internal] URL registry refresh requested');
        return res.json({ ok: true, message: 'URL registry refreshed' });
    } catch (err) {
        console.error('[Internal] url-registry/refresh error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
