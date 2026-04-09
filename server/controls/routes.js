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

function generateCozmoScript(user, protocol, host) {
    return `#!/usr/bin/env python3
"""
HoboStreamer — Cozmo Hardware Bridge
Auto-generated for: ${user.username}

Connects your Cozmo robot to HoboStreamer so viewers can control it.

Requirements:
    pip install pycozmo websocket-client

Usage:
    python3 cozmo-bridge.py
"""
import json
import time

try:
    import websocket
except ImportError:
    print("Missing websocket-client: pip install websocket-client")
    exit(1)

try:
    import pycozmo
except ImportError:
    pycozmo = None
    print("[Cozmo] pycozmo not installed — running in DRY RUN mode")

WS_URL = "${protocol}://${host}/ws/control?mode=hardware&stream_key=${user.stream_key}"
RECONNECT_DELAY = 5

def execute_command(cli, cmd):
    if cli is None:
        print(f"[DRY RUN] {cmd}")
        return
    movements = {
        'forward':    lambda: cli.drive_wheels(100, 100, duration=0.5),
        'backward':   lambda: cli.drive_wheels(-100, -100, duration=0.5),
        'turn_left':  lambda: cli.drive_wheels(-80, 80, duration=0.4),
        'turn_right': lambda: cli.drive_wheels(80, -80, duration=0.4),
        'lift_up':    lambda: cli.set_lift_height(1.0),
        'lift_down':  lambda: cli.set_lift_height(0.0),
        'head_up':    lambda: cli.set_head_angle(pycozmo.MAX_HEAD_ANGLE),
        'head_down':  lambda: cli.set_head_angle(pycozmo.MIN_HEAD_ANGLE),
    }
    if cmd in movements:
        try:
            movements[cmd]()
            print(f"[Cozmo] {cmd}")
        except Exception as e:
            print(f"[Cozmo] Error: {e}")
    elif cmd.startswith('anim_'):
        try:
            cli.play_anim_trigger(getattr(pycozmo.anim.Triggers, cmd[5:]))
        except AttributeError:
            print(f"[Cozmo] Unknown anim: {cmd}")
    else:
        print(f"[Cozmo] Unknown: {cmd}")

class CozmoBridge:
    def __init__(self):
        self.cozmo_cli = None
        self.running = True

    def connect_cozmo(self):
        if pycozmo is None:
            return
        try:
            self.cozmo_cli = pycozmo.Client()
            self.cozmo_cli.start()
            self.cozmo_cli.wait_for_robot()
            print("[Cozmo] Connected!")
        except Exception as e:
            print(f"[Cozmo] Failed: {e}")

    def on_message(self, ws, message):
        try:
            msg = json.loads(message)
            if msg.get('type') == 'command':
                print(f"[Control] {msg.get('from_user','?')} -> {msg.get('command','')}")
                execute_command(self.cozmo_cli, msg.get('command', ''))
        except Exception as e:
            print(f"[WS] Error: {e}")

    def on_open(self, ws):
        print("[WS] Connected to HoboStreamer!")

    def on_close(self, ws, code, reason):
        print(f"[WS] Disconnected ({code})")

    def on_error(self, ws, error):
        print(f"[WS] Error: {error}")

    def run(self):
        self.connect_cozmo()
        while self.running:
            try:
                ws = websocket.WebSocketApp(WS_URL,
                    on_message=self.on_message, on_open=self.on_open,
                    on_close=self.on_close, on_error=self.on_error)
                ws.run_forever(ping_interval=30)
            except Exception as e:
                print(f"[WS] {e}")
            if self.running:
                print(f"Reconnecting in {RECONNECT_DELAY}s...")
                time.sleep(RECONNECT_DELAY)

if __name__ == '__main__':
    bridge = CozmoBridge()
    try:
        bridge.run()
    except KeyboardInterrupt:
        if bridge.cozmo_cli:
            bridge.cozmo_cli.stop()
        print("Bye!")
`;
}

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

// ── Control Settings (MUST be before /:streamId routes) ──────

// Get control settings for the current user's channel
router.get('/settings/channel', requireAuth, (req, res) => {
    try {
        const channel = db.getChannelByUserId(req.user.id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        res.json({
            control_mode: channel.control_mode || 'open',
            anon_controls_enabled: !!channel.anon_controls_enabled,
            control_rate_limit_ms: channel.control_rate_limit_ms || 500,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get control settings' });
    }
});

router.put('/settings/channel', requireAuth, (req, res) => {
    try {
        const { control_mode, anon_controls_enabled, control_rate_limit_ms } = req.body;
        const updates = {};
        if (control_mode !== undefined) {
            if (!['open', 'whitelist', 'disabled'].includes(control_mode)) {
                return res.status(400).json({ error: 'Invalid control_mode' });
            }
            updates.control_mode = control_mode;
        }
        if (anon_controls_enabled !== undefined) {
            updates.anon_controls_enabled = anon_controls_enabled ? 1 : 0;
        }
        if (control_rate_limit_ms !== undefined) {
            const ms = parseInt(control_rate_limit_ms);
            if (isNaN(ms) || ms < 100 || ms > 30000) {
                return res.status(400).json({ error: 'Rate limit must be 100-30000ms' });
            }
            updates.control_rate_limit_ms = ms;
        }
        if (Object.keys(updates).length > 0) {
            db.updateChannel(req.user.id, updates);
        }
        const channel = db.getChannelByUserId(req.user.id);
        res.json({
            control_mode: channel.control_mode || 'open',
            anon_controls_enabled: !!channel.anon_controls_enabled,
            control_rate_limit_ms: channel.control_rate_limit_ms || 500,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update control settings' });
    }
});

// ── Control Whitelist ────────────────────────────────────────

router.get('/whitelist', requireAuth, (req, res) => {
    try {
        const channel = db.getChannelByUserId(req.user.id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        const whitelist = db.all(
            `SELECT cw.id, cw.user_id, u.username, u.display_name, cw.created_at
             FROM control_whitelist cw JOIN users u ON cw.user_id = u.id
             WHERE cw.channel_id = ? ORDER BY cw.created_at DESC`,
            [channel.id]
        );
        res.json({ whitelist });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get whitelist' });
    }
});

router.post('/whitelist', requireAuth, (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Username required' });
        const channel = db.getChannelByUserId(req.user.id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        const targetUser = db.getUserByUsername(username);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        db.run(
            'INSERT OR IGNORE INTO control_whitelist (channel_id, user_id, added_by) VALUES (?, ?, ?)',
            [channel.id, targetUser.id, req.user.id]
        );
        res.json({ message: `${username} added to control whitelist` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add to whitelist' });
    }
});

router.delete('/whitelist/:id', requireAuth, (req, res) => {
    try {
        const channel = db.getChannelByUserId(req.user.id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        db.run('DELETE FROM control_whitelist WHERE id = ? AND channel_id = ?',
            [req.params.id, channel.id]);
        res.json({ message: 'Removed from whitelist' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove from whitelist' });
    }
});

// ── Cozmo Script Generator ──────────────────────────────────

router.get('/cozmo-script', requireAuth, (req, res) => {
    try {
        const user = req.user;
        const host = req.get('host') || 'hobostreamer.com';
        const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';

        const script = generateCozmoScript(user, protocol, host);

        res.set('Content-Type', 'text/x-python');
        res.set('Content-Disposition', `attachment; filename="cozmo-bridge-${user.username}.py"`);
        res.send(script);
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate script' });
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
