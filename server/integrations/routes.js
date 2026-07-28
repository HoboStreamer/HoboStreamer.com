const express = require('express');

const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const robotStreamerService = require('./robotstreamer-service');

const router = express.Router();

/**
 * Resolve + authorize an optional managed_stream_id (stream slot) parameter.
 * Returns: null (no slot requested), a positive integer slot id, or false
 * (invalid/unauthorized — response already sent).
 */
function resolveSlotId(req, res) {
    const raw = req.query.managed_stream_id ?? req.body?.managed_stream_id;
    if (raw === undefined || raw === null || raw === '') return null;
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid managed_stream_id' });
        return false;
    }
    const ms = db.getManagedStreamById(id);
    if (!ms || ms.user_id !== req.user.id) {
        res.status(403).json({ error: 'Not your stream slot' });
        return false;
    }
    return id;
}

/**
 * Live streams whose effective RS config is the given row (slot or default).
 * For a slot row: only streams on that slot. For the default row: only streams
 * that do NOT have their own slot-specific config.
 */
function liveStreamsForConfig(userId, slotId) {
    const liveStreams = db.getLiveStreamsByUserId(userId) || [];
    if (slotId) return liveStreams.filter(s => s.managed_stream_id === slotId);
    return liveStreams.filter(s => !s.managed_stream_id || !db.getRobotStreamerIntegrationBySlot(userId, s.managed_stream_id));
}

router.get('/integration', requireAuth, async (req, res) => {
    try {
        const slotId = resolveSlotId(req, res);
        if (slotId === false) return;

        const row = slotId
            ? db.getRobotStreamerIntegrationBySlot(req.user.id, slotId)
            : db.getRobotStreamerIntegrationByUserId(req.user.id);
        let availableRobots = [];

        // If a saved token + robot exists, re-fetch available robots so the dropdown populates on reload
        if (row?.token && row?.robot_id) {
            try {
                const pageData = await robotStreamerService.robotPageLoad(row.token, row.robot_id);
                availableRobots = robotStreamerService.extractAvailableRobots(pageData);
            } catch {
                // Non-fatal — dropdown just stays empty, user can re-validate
            }
        }

        res.json({
            integration: robotStreamerService.sanitizeIntegration(row, { available_robots: availableRobots }),
            exists: !!row,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load RobotStreamer settings' });
    }
});

router.post('/integration/validate', requireAuth, async (req, res) => {
    try {
        const slotId = resolveSlotId(req, res);
        if (slotId === false) return;

        const existing = (slotId ? db.getRobotStreamerIntegrationBySlot(req.user.id, slotId) : null)
            || db.getRobotStreamerIntegrationByUserId(req.user.id);
        const token = typeof req.body.token === 'string' && req.body.token.trim()
            ? req.body.token.trim()
            : existing?.token;
        const robotInput = req.body.robot_input || req.body.robot_id || existing?.robot_id;
        const validated = await robotStreamerService.validateConfiguration({ token, robotInput });

        // Cache RS viewer count for this user's active robot
        const robotId = robotStreamerService.normalizeRobotInput(robotInput);
        const activeRobot = validated.availableRobots.find(r => String(r.robot_id) === String(robotId));
        if (activeRobot) {
            robotStreamerService.setRsViewerCount(req.user.id, activeRobot.viewers);
        }

        res.json({
            integration: robotStreamerService.sanitizeIntegration({
                ...(existing || {}),
                managed_stream_id: slotId,
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
        const slotId = resolveSlotId(req, res);
        if (slotId === false) return;

        const result = await robotStreamerService.upsertIntegration(req.user.id, req.body || {}, slotId);
        const affected = liveStreamsForConfig(req.user.id, slotId);

        if (!result.row?.enabled || result.row?.mirror_chat === 0) {
            for (const stream of affected) {
                robotStreamerService.stopForStream(stream.id);
            }
        } else {
            for (const stream of affected) {
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

// Remove a slot-specific RS config (the slot falls back to the account default)
router.delete('/integration', requireAuth, (req, res) => {
    try {
        const slotId = resolveSlotId(req, res);
        if (slotId === false) return;
        if (!slotId) return res.status(400).json({ error: 'managed_stream_id is required' });

        for (const stream of liveStreamsForConfig(req.user.id, slotId)) {
            robotStreamerService.stopForStream(stream.id);
        }
        db.deleteRobotStreamerIntegrationForSlot(req.user.id, slotId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to remove RobotStreamer settings' });
    }
});

module.exports = router;
