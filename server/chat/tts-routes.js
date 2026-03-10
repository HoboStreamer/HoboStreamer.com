/**
 * HoboStreamer — TTS API Routes
 *
 * Public routes (authenticated users):
 *   GET  /api/tts/voices          — List available voices
 *   GET  /api/tts/settings        — Get TTS config for client
 *
 * Admin routes:
 *   GET  /api/tts/admin/settings  — Full TTS config with API keys
 *   PUT  /api/tts/admin/settings  — Update TTS config
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth/auth');
const ttsEngine = require('./tts-engine');
const db = require('../db/database');

// ── Public: Get available voices ──────────────────────────────
router.get('/voices', (req, res) => {
    try {
        const voices = ttsEngine.getAvailableVoices();
        res.json({ voices });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Public: Get TTS settings for client ───────────────────────
router.get('/settings', (req, res) => {
    try {
        const settings = ttsEngine.getTTSSettings();
        // Don't expose API keys to the client
        res.json({
            enabled: settings.enabled,
            provider: settings.provider,
            googleConfigured: !!(settings.googleApiKey || settings.googleServiceAccount),
            pollyConfigured: !!settings.awsAccessKeyId,
            espeakAvailable: !!ttsEngine.detectEspeak(),
            maxLength: settings.maxLength,
            maxQueuePerUser: settings.maxQueuePerUser,
            maxQueueGlobal: settings.maxQueueGlobal,
            defaultVoice: settings.defaultVoice,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Get full TTS config ────────────────────────────────
router.get('/admin/settings', requireAuth, requireAdmin, (req, res) => {
    try {
        const settings = ttsEngine.getTTSSettings();
        res.json({ settings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Update TTS config ──────────────────────────────────
router.put('/admin/settings', requireAuth, requireAdmin, (req, res) => {
    try {
        const allowed = [
            'tts_enabled', 'tts_provider',
            'tts_google_api_key', 'tts_google_service_account',
            'tts_aws_access_key_id', 'tts_aws_secret_access_key', 'tts_aws_region',
            'tts_max_length', 'tts_max_queue_per_user', 'tts_max_queue_global',
            'tts_default_voice',
        ];
        const updates = req.body.settings || req.body;
        let count = 0;
        for (const [key, value] of Object.entries(updates)) {
            if (allowed.includes(key)) {
                db.setSetting(key, value);
                count++;
            }
        }
        ttsEngine.invalidateSettingsCache();
        res.json({ success: true, updated: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Test voice synthesis ───────────────────────────────
router.post('/admin/test', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { voiceId, text } = req.body;
        const result = await ttsEngine.synthesize(text || 'This is a TTS test from HoboStreamer', voiceId);
        if (!result) return res.status(400).json({ error: 'Voice unavailable or TTS disabled' });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
