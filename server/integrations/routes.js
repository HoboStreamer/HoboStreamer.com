const express = require('express');

const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const robotStreamerService = require('./robotstreamer-service');

const router = express.Router();

router.get('/integration', requireAuth, (req, res) => {
    try {
        res.json({ integration: robotStreamerService.getClientIntegration(req.user.id) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load RobotStreamer settings' });
    }
});

router.post('/integration/validate', requireAuth, async (req, res) => {
    try {
        const existing = db.getRobotStreamerIntegrationByUserId(req.user.id);
        const token = typeof req.body.token === 'string' && req.body.token.trim()
            ? req.body.token.trim()
            : existing?.token;
        const robotInput = req.body.robot_input || req.body.robot_id || existing?.robot_id;
        const validated = await robotStreamerService.validateConfiguration({ token, robotInput });

        res.json({
            integration: robotStreamerService.sanitizeIntegration({
                ...(existing || {}),
                enabled: existing?.enabled || 0,
                mirror_chat: existing?.mirror_chat ?? 1,
                token,
                ...validated.fields,
            }, { available_robots: validated.availableRobots }),
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to validate RobotStreamer settings' });
    }
});

router.put('/integration', requireAuth, async (req, res) => {
    try {
        const result = await robotStreamerService.upsertIntegration(req.user.id, req.body || {});
        const liveStreams = db.getLiveStreamsByUserId(req.user.id) || [];

        if (!result.row?.enabled || result.row?.mirror_chat === 0) {
            robotStreamerService.stopForUserLiveStreams(req.user.id);
        } else {
            for (const stream of liveStreams) {
                robotStreamerService.startForStream(stream).catch((err) => {
                    console.warn(`[RS] Failed to start chat bridge for stream ${stream.id}:`, err.message);
                });
            }
        }

        res.json({ integration: result.integration });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save RobotStreamer settings' });
    }
});

module.exports = router;