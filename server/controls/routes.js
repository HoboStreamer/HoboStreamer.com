/**
 * HoboStreamer — Controls API Routes
 * 
 * GET    /api/controls/:streamId        - Get controls for a stream
 * POST   /api/controls/:streamId        - Add a control button
 * PUT    /api/controls/:streamId/:id    - Update a control
 * DELETE /api/controls/:streamId/:id    - Delete a control
 * POST   /api/controls/api-key          - Generate API key
 * GET    /api/controls/api-keys         - List user's API keys  
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');

const router = express.Router();

// ── Generate API Key (must be before :streamId routes) ────────
router.post('/api-key', requireAuth, (req, res) => {
    try {
        const { label, permissions } = req.body;

        // Generate a random API key
        const rawKey = crypto.randomBytes(32).toString('hex');
        const keyHash = bcrypt.hashSync(rawKey, 10);

        db.createApiKey({
            user_id: req.user.id,
            key_hash: keyHash,
            label: label || 'Default',
            permissions: permissions || ['control', 'stream'],
        });

        // Return the raw key ONCE (it's hashed in the DB)
        res.status(201).json({
            api_key: rawKey,
            label: label || 'Default',
            message: 'Save this key — it cannot be retrieved again!',
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate API key' });
    }
});

// ── List API Keys (must be before :streamId routes) ──────────
router.get('/api-keys', requireAuth, (req, res) => {
    try {
        const keys = db.all(
            'SELECT id, label, permissions, last_used, is_active, created_at FROM api_keys WHERE user_id = ?',
            [req.user.id]
        );
        res.json({ api_keys: keys });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list API keys' });
    }
});

// ── Get Controls for a Stream ────────────────────────────────
router.get('/:streamId', (req, res) => {
    try {
        const controls = db.getStreamControls(req.params.streamId);
        res.json({ controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get controls' });
    }
});

// ── Add Control Button ───────────────────────────────────────
router.post('/:streamId', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }

        const { label, command, icon, control_type, key_binding, cooldown_ms } = req.body;
        if (!label || !command) {
            return res.status(400).json({ error: 'Label and command required' });
        }
        const cleanIcon = icon || 'fa-gamepad';
        if (!/^fa-[a-z0-9-]+$/.test(cleanIcon)) {
            return res.status(400).json({ error: 'Invalid icon class' });
        }
        const cleanLabel = String(label).replace(/<[^>]*>/g, '').slice(0, 50);
        const cleanCommand = String(command).replace(/[<>"'`\\]/g, '').slice(0, 100);

        db.createControl({
            stream_id: parseInt(req.params.streamId),
            label: cleanLabel,
            command: cleanCommand,
            icon: cleanIcon,
            control_type: control_type || 'button',
            key_binding,
            cooldown_ms: cooldown_ms || 500,
        });

        const controls = db.getStreamControls(req.params.streamId);
        res.status(201).json({ controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add control' });
    }
});

// ── Update Control ───────────────────────────────────────────
router.put('/:streamId/:id', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || (stream.user_id !== req.user.id && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const { label, command, icon, control_type, key_binding, cooldown_ms, is_enabled, sort_order } = req.body;
        const updates = [];
        const params = [];

        if (label !== undefined) { updates.push('label = ?'); params.push(String(label).replace(/<[^>]*>/g, '').slice(0, 50)); }
        if (command !== undefined) { updates.push('command = ?'); params.push(String(command).replace(/[<>"'`\\]/g, '').slice(0, 100)); }
        if (icon !== undefined) {
            if (!/^fa-[a-z0-9-]+$/.test(icon)) {
                return res.status(400).json({ error: 'Invalid icon class' });
            }
            updates.push('icon = ?'); params.push(icon);
        }
        if (control_type !== undefined) { updates.push('control_type = ?'); params.push(control_type); }
        if (key_binding !== undefined) { updates.push('key_binding = ?'); params.push(key_binding); }
        if (cooldown_ms !== undefined) { updates.push('cooldown_ms = ?'); params.push(cooldown_ms); }
        if (is_enabled !== undefined) { updates.push('is_enabled = ?'); params.push(is_enabled ? 1 : 0); }
        if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }

        if (updates.length > 0) {
            params.push(req.params.id);
            db.run(`UPDATE stream_controls SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        const controls = db.getStreamControls(req.params.streamId);
        res.json({ controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update control' });
    }
});

// ── Delete Control ───────────────────────────────────────────
router.delete('/:streamId/:id', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || (stream.user_id !== req.user.id && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        db.run('DELETE FROM stream_controls WHERE id = ? AND stream_id = ?',
            [req.params.id, req.params.streamId]);

        res.json({ message: 'Control deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete control' });
    }
});

// ── Cozmo Presets ────────────────────────────────────────────
const { applyCozmoPresets, removeCozmoPresets } = require('../integrations/cozmo-presets');

router.post('/:streamId/presets/cozmo', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || (stream.user_id !== req.user.id && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const result = applyCozmoPresets(parseInt(req.params.streamId));
        const controls = db.getStreamControls(req.params.streamId);
        res.json({ ...result, controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to apply Cozmo presets' });
    }
});

router.delete('/:streamId/presets/cozmo', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || (stream.user_id !== req.user.id && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const removed = removeCozmoPresets(parseInt(req.params.streamId));
        const controls = db.getStreamControls(req.params.streamId);
        res.json({ removed, controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove Cozmo presets' });
    }
});

module.exports = router;
