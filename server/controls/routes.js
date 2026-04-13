/**
 * HoboStreamer — Controls API Routes
 * 
 * Config Profiles:
 * GET    /api/controls/configs              - List user's control configs
 * POST   /api/controls/configs              - Create a control config
 * GET    /api/controls/configs/:id          - Get config with buttons
 * PUT    /api/controls/configs/:id          - Update config name/description
 * DELETE /api/controls/configs/:id          - Delete config
 * POST   /api/controls/configs/:id/buttons  - Add button to config
 * PUT    /api/controls/configs/:id/buttons/:btnId - Update button
 * DELETE /api/controls/configs/:id/buttons/:btnId - Delete button
 * POST   /api/controls/configs/:id/activate - Activate config on channel
 * POST   /api/controls/configs/:id/apply/:streamId - Copy config to live stream
 * 
 * Per-Stream Controls (legacy):
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

// ── CSS Value Sanitization (prevent injection) ───────────────
const CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)|[a-zA-Z]{1,30}|var\(--[a-zA-Z0-9-]+\)|)$/;
function sanitizeCssColor(val) {
    if (!val || typeof val !== 'string') return '';
    const trimmed = val.trim().slice(0, 60);
    return CSS_COLOR_RE.test(trimmed) ? trimmed : '';
}

function generateCozmoScript(user, protocol, host) {
    return `#!/usr/bin/env python3
"""
HoboStreamer — Cozmo Hardware Bridge (v2)
Auto-generated for: ${user.username}

Connects your Cozmo robot to HoboStreamer so viewers can control it.
Supports: button commands, keyboard hold (key_down/key_up), video click (x,y).

Requirements:
    pip install pycozmo websocket-client

Usage:
    python3 cozmo-bridge.py
"""
import json
import time
import threading

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
DRIVE_SPEED = 100
TURN_SPEED = 80

# Commands that support continuous driving (key_down -> drive, key_up -> stop)
CONTINUOUS_COMMANDS = {
    'forward':    (DRIVE_SPEED, DRIVE_SPEED),
    'backward':   (-DRIVE_SPEED, -DRIVE_SPEED),
    'turn_left':  (-TURN_SPEED, TURN_SPEED),
    'turn_right': (TURN_SPEED, -TURN_SPEED),
}

def execute_command(cli, cmd):
    """Execute a one-shot command (button press)."""
    if cli is None:
        print(f"[DRY RUN] {cmd}")
        return
    movements = {
        'forward':    lambda: cli.drive_wheels(DRIVE_SPEED, DRIVE_SPEED, duration=0.5),
        'backward':   lambda: cli.drive_wheels(-DRIVE_SPEED, -DRIVE_SPEED, duration=0.5),
        'turn_left':  lambda: cli.drive_wheels(-TURN_SPEED, TURN_SPEED, duration=0.4),
        'turn_right': lambda: cli.drive_wheels(TURN_SPEED, -TURN_SPEED, duration=0.4),
        'lift_up':    lambda: cli.set_lift_height(1.0),
        'lift_down':  lambda: cli.set_lift_height(0.0),
        'head_up':    lambda: cli.set_head_angle(pycozmo.MAX_HEAD_ANGLE if pycozmo else 0.4),
        'head_down':  lambda: cli.set_head_angle(pycozmo.MIN_HEAD_ANGLE if pycozmo else -0.2),
        'stop':       lambda: cli.drive_wheels(0, 0),
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
        self.held_keys = set()  # Currently held commands
        self._drive_thread = None
        self._drive_lock = threading.Lock()

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

    def _continuous_drive_loop(self):
        """Background loop: while keys are held, keep sending drive commands."""
        while self.running:
            with self._drive_lock:
                keys = set(self.held_keys)
            if not keys:
                time.sleep(0.05)
                continue
            # Pick the most recent held key for driving
            for cmd in keys:
                if cmd in CONTINUOUS_COMMANDS:
                    left, right = CONTINUOUS_COMMANDS[cmd]
                    if self.cozmo_cli:
                        try:
                            self.cozmo_cli.drive_wheels(left, right, duration=0.2)
                        except Exception:
                            pass
                    else:
                        print(f"[DRY RUN] continuous {cmd}")
                    break
            time.sleep(0.15)

    def handle_key_down(self, msg):
        cmd = msg.get('command', '')
        user = msg.get('from_user', '?')
        print(f"[Key Down] {user} -> {cmd}")
        with self._drive_lock:
            self.held_keys.add(cmd)
        # Also handle non-continuous commands as one-shot
        if cmd not in CONTINUOUS_COMMANDS:
            execute_command(self.cozmo_cli, cmd)

    def handle_key_up(self, msg):
        cmd = msg.get('command', '')
        user = msg.get('from_user', '?')
        print(f"[Key Up] {user} -> {cmd}")
        with self._drive_lock:
            self.held_keys.discard(cmd)
        # If no more keys held, stop driving
        with self._drive_lock:
            remaining = set(self.held_keys)
        if not any(k in CONTINUOUS_COMMANDS for k in remaining):
            if self.cozmo_cli:
                try:
                    self.cozmo_cli.drive_wheels(0, 0)
                except Exception:
                    pass
            else:
                print("[DRY RUN] stop")

    def handle_video_click(self, msg):
        x = msg.get('x', 0.5)
        y = msg.get('y', 0.5)
        user = msg.get('from_user', '?')
        print(f"[Click] {user} -> ({x:.2f}, {y:.2f})")
        # Simple click-to-drive: turn toward click then drive forward
        if self.cozmo_cli is None:
            print(f"[DRY RUN] navigate to ({x:.2f}, {y:.2f})")
            return
        try:
            # x < 0.4 = turn left, x > 0.6 = turn right, else straight
            if x < 0.4:
                self.cozmo_cli.drive_wheels(-TURN_SPEED, TURN_SPEED, duration=0.3)
            elif x > 0.6:
                self.cozmo_cli.drive_wheels(TURN_SPEED, -TURN_SPEED, duration=0.3)
            time.sleep(0.1)
            # y < 0.4 = further away (drive more), y > 0.6 = closer (drive less)
            drive_time = 0.3 + (1.0 - y) * 0.7
            self.cozmo_cli.drive_wheels(DRIVE_SPEED, DRIVE_SPEED, duration=drive_time)
        except Exception as e:
            print(f"[Cozmo] Click navigate error: {e}")

    def on_message(self, ws, message):
        try:
            msg = json.loads(message)
            msg_type = msg.get('type', '')
            if msg_type == 'command':
                print(f"[Control] {msg.get('from_user','?')} -> {msg.get('command','')}")
                execute_command(self.cozmo_cli, msg.get('command', ''))
            elif msg_type == 'key_down':
                self.handle_key_down(msg)
            elif msg_type == 'key_up':
                self.handle_key_up(msg)
            elif msg_type == 'video_click':
                self.handle_video_click(msg)
        except Exception as e:
            print(f"[WS] Error: {e}")

    def on_open(self, ws):
        print("[WS] Connected to HoboStreamer!")

    def on_close(self, ws, code, reason):
        print(f"[WS] Disconnected ({code})")
        # Stop driving on disconnect
        with self._drive_lock:
            self.held_keys.clear()

    def on_error(self, ws, error):
        print(f"[WS] Error: {error}")

    def run(self):
        self.connect_cozmo()
        # Start continuous drive thread
        self._drive_thread = threading.Thread(target=self._continuous_drive_loop, daemon=True)
        self._drive_thread.start()
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
        bridge.running = False
        if bridge.cozmo_cli:
            bridge.cozmo_cli.stop()
        print("Bye!")
`;
}

// ══════════════════════════════════════════════════════════════
//  CONTROL CONFIGS (Reusable per-channel profiles)
// ══════════════════════════════════════════════════════════════

// ── List configs ─────────────────────────────────────────────
router.get('/configs', requireAuth, (req, res) => {
    try {
        const configs = db.getControlConfigs(req.user.id);
        // Attach button count to each config
        const result = configs.map(c => ({
            ...c,
            button_count: db.getConfigButtons(c.id).length,
        }));
        res.json({ configs: result });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list configs' });
    }
});

// ── Create config ────────────────────────────────────────────
router.post('/configs', requireAuth, (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Config name is required' });
        }
        const cleanName = String(name).replace(/<[^>]*>/g, '').slice(0, 60);
        const cleanDesc = description ? String(description).replace(/<[^>]*>/g, '').slice(0, 200) : '';

        // Limit to 20 configs per user
        const existing = db.getControlConfigs(req.user.id);
        if (existing.length >= 20) {
            return res.status(400).json({ error: 'Maximum 20 control configs allowed' });
        }

        const result = db.createControlConfig({ user_id: req.user.id, name: cleanName, description: cleanDesc });
        const config = db.getControlConfig(result.lastInsertRowid);
        res.status(201).json({ config });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create config' });
    }
});

// ── Get config with buttons ──────────────────────────────────
router.get('/configs/:id', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const buttons = db.getConfigButtons(config.id);
        res.json({ config, buttons });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get config' });
    }
});

// ── Update config ────────────────────────────────────────────
router.put('/configs/:id', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const { name, description } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = String(name).replace(/<[^>]*>/g, '').slice(0, 60);
        if (description !== undefined) updates.description = String(description).replace(/<[^>]*>/g, '').slice(0, 200);
        db.updateControlConfig(config.id, updates);
        const updated = db.getControlConfig(config.id);
        res.json({ config: updated });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update config' });
    }
});

// ── Delete config ────────────────────────────────────────────
router.delete('/configs/:id', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        // Clear active config reference if it was active
        const channel = db.getChannelByUserId(req.user.id);
        if (channel && channel.active_control_config_id === config.id) {
            db.updateChannel(req.user.id, { active_control_config_id: null });
        }
        db.deleteControlConfig(config.id);
        res.json({ message: 'Config deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete config' });
    }
});

// ── Add button to config ─────────────────────────────────────
router.post('/configs/:id/buttons', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const { label, command, icon, control_type, key_binding, cooldown_ms, btn_color, btn_bg, btn_border_color } = req.body;
        if (!label || !command) {
            return res.status(400).json({ error: 'Label and command required' });
        }

        // Limit to 50 buttons per config
        const existing = db.getConfigButtons(config.id);
        if (existing.length >= 50) {
            return res.status(400).json({ error: 'Maximum 50 buttons per config' });
        }

        const cleanIcon = icon || 'fa-gamepad';
        if (!/^fa-[a-z0-9-]+$/.test(cleanIcon)) {
            return res.status(400).json({ error: 'Invalid icon class' });
        }

        const validTypes = ['button', 'toggle', 'dpad', 'keyboard'];
        const cleanType = validTypes.includes(control_type) ? control_type : 'button';

        db.createConfigButton({
            config_id: config.id,
            label: String(label).replace(/<[^>]*>/g, '').slice(0, 50),
            command: String(command).replace(/[<>"'`\\]/g, '').slice(0, 100),
            icon: cleanIcon,
            control_type: cleanType,
            key_binding: key_binding ? String(key_binding).slice(0, 20) : null,
            cooldown_ms: Math.max(0, Math.min(30000, parseInt(cooldown_ms) || 500)),
            sort_order: existing.length,
            btn_color: sanitizeCssColor(btn_color),
            btn_bg: sanitizeCssColor(btn_bg),
            btn_border_color: sanitizeCssColor(btn_border_color),
        });

        const buttons = db.getConfigButtons(config.id);
        res.status(201).json({ buttons });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add button' });
    }
});

// ── Update button ────────────────────────────────────────────
router.put('/configs/:id/buttons/:btnId', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const { label, command, icon, control_type, key_binding, cooldown_ms, sort_order, btn_color, btn_bg, btn_border_color, is_enabled } = req.body;
        const updates = {};

        if (label !== undefined) updates.label = String(label).replace(/<[^>]*>/g, '').slice(0, 50);
        if (command !== undefined) updates.command = String(command).replace(/[<>"'`\\]/g, '').slice(0, 100);
        if (icon !== undefined) {
            if (!/^fa-[a-z0-9-]+$/.test(icon)) return res.status(400).json({ error: 'Invalid icon class' });
            updates.icon = icon;
        }
        if (control_type !== undefined) {
            const validTypes = ['button', 'toggle', 'dpad', 'keyboard'];
            updates.control_type = validTypes.includes(control_type) ? control_type : 'button';
        }
        if (key_binding !== undefined) updates.key_binding = key_binding ? String(key_binding).slice(0, 20) : null;
        if (cooldown_ms !== undefined) updates.cooldown_ms = Math.max(0, Math.min(30000, parseInt(cooldown_ms) || 500));
        if (sort_order !== undefined) updates.sort_order = parseInt(sort_order) || 0;
        if (btn_color !== undefined) updates.btn_color = sanitizeCssColor(btn_color);
        if (btn_bg !== undefined) updates.btn_bg = sanitizeCssColor(btn_bg);
        if (btn_border_color !== undefined) updates.btn_border_color = sanitizeCssColor(btn_border_color);
        if (is_enabled !== undefined) updates.is_enabled = is_enabled ? 1 : 0;

        db.updateConfigButton(parseInt(req.params.btnId), updates);
        const buttons = db.getConfigButtons(config.id);
        res.json({ buttons });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update button' });
    }
});

// ── Delete button ────────────────────────────────────────────
router.delete('/configs/:id/buttons/:btnId', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        db.deleteConfigButton(parseInt(req.params.btnId));
        const buttons = db.getConfigButtons(config.id);
        res.json({ buttons });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete button' });
    }
});

// ── Activate config on channel ───────────────────────────────
router.post('/configs/:id/activate', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        db.updateChannel(req.user.id, { active_control_config_id: config.id });
        res.json({ message: 'Config activated', config_id: config.id });
    } catch (err) {
        res.status(500).json({ error: 'Failed to activate config' });
    }
});

// ── Deactivate config (clear active) ─────────────────────────
router.post('/configs/deactivate', requireAuth, (req, res) => {
    try {
        db.updateChannel(req.user.id, { active_control_config_id: null });
        res.json({ message: 'Config deactivated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to deactivate config' });
    }
});

// ── Apply config to live stream ──────────────────────────────
router.post('/configs/:id/apply/:streamId', requireAuth, (req, res) => {
    try {
        const config = db.getControlConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        if (config.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || (stream.user_id !== req.user.id && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const applied = db.applyConfigToStream(config.id, stream.id);
        const controls = db.getStreamControls(stream.id);
        res.json({ applied, controls });
    } catch (err) {
        res.status(500).json({ error: 'Failed to apply config' });
    }
});

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
            active_control_config_id: channel.active_control_config_id || null,
            video_click_enabled: !!channel.video_click_enabled,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get control settings' });
    }
});

router.put('/settings/channel', requireAuth, (req, res) => {
    try {
        const { control_mode, anon_controls_enabled, control_rate_limit_ms, video_click_enabled } = req.body;
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
        if (video_click_enabled !== undefined) {
            updates.video_click_enabled = video_click_enabled ? 1 : 0;
        }
        if (Object.keys(updates).length > 0) {
            db.updateChannel(req.user.id, updates);
        }
        const channel = db.getChannelByUserId(req.user.id);
        res.json({
            control_mode: channel.control_mode || 'open',
            anon_controls_enabled: !!channel.anon_controls_enabled,
            control_rate_limit_ms: channel.control_rate_limit_ms || 500,
            active_control_config_id: channel.active_control_config_id || null,
            video_click_enabled: !!channel.video_click_enabled,
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
        // Attach channel settings for the controls UI
        const stream = db.getStreamById(req.params.streamId);
        let settings = {};
        if (stream) {
            const channel = db.getChannelByUserId(stream.user_id);
            if (channel) {
                settings = {
                    video_click_enabled: !!channel.video_click_enabled,
                    control_mode: channel.control_mode || 'open',
                };
            }
        }
        res.json({ controls, settings });
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

        const { label, command, icon, control_type, key_binding, cooldown_ms, btn_color, btn_bg, btn_border_color } = req.body;
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
            btn_color: sanitizeCssColor(btn_color),
            btn_bg: sanitizeCssColor(btn_bg),
            btn_border_color: sanitizeCssColor(btn_border_color),
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

        const { label, command, icon, control_type, key_binding, cooldown_ms, is_enabled, sort_order, btn_color, btn_bg, btn_border_color } = req.body;
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
        if (btn_color !== undefined) { updates.push('btn_color = ?'); params.push(sanitizeCssColor(btn_color)); }
        if (btn_bg !== undefined) { updates.push('btn_bg = ?'); params.push(sanitizeCssColor(btn_bg)); }
        if (btn_border_color !== undefined) { updates.push('btn_border_color = ?'); params.push(sanitizeCssColor(btn_border_color)); }

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
