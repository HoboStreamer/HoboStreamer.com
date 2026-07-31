/**
 * ai-chatbot-routes.js — Per-streamer AI chatbot config API.
 *
 * GET    /api/ai-chatbot            - Load my config (token masked)
 * PUT    /api/ai-chatbot            - Save my config (token preserved when blank)
 * POST   /api/ai-chatbot/validate   - Test the AI credentials
 * POST   /api/ai-chatbot/preview    - Generate a sample bot line (no posting)
 */
'use strict';
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const aiProvider = require('../ai/ai-provider');
const aiChatbotService = require('./ai-chatbot-service');

const router = express.Router();

function sanitize(cfg) {
    const token = String(cfg.api_token || '');
    return {
        enabled: !!cfg.enabled,
        base_url: cfg.base_url || 'https://api.openai.com/v1',
        model: cfg.model || 'gpt-4o-mini',
        transcribe_enabled: !!cfg.transcribe_enabled,
        transcribe_model: cfg.transcribe_model || 'whisper-1',
        num_bots: cfg.num_bots ?? 3,
        post_interval_seconds: cfg.post_interval_seconds ?? 45,
        persona: cfg.persona || '',
        has_token: !!token,
        api_token_masked: token ? `****${token.slice(-4)}` : '',
        last_validated_at: cfg.last_validated_at || null,
    };
}

router.get('/', requireAuth, (req, res) => {
    try {
        res.json({ config: sanitize(db.getAiChatbotConfig(req.user.id)) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load AI chatbot config' });
    }
});

router.put('/', requireAuth, (req, res) => {
    try {
        const b = req.body || {};
        const fields = {};
        if (b.enabled !== undefined) fields.enabled = !!b.enabled;
        if (b.base_url !== undefined) fields.base_url = b.base_url;
        if (b.model !== undefined) fields.model = b.model;
        if (b.transcribe_enabled !== undefined) fields.transcribe_enabled = !!b.transcribe_enabled;
        if (b.transcribe_model !== undefined) fields.transcribe_model = b.transcribe_model;
        if (b.num_bots !== undefined) fields.num_bots = b.num_bots;
        if (b.post_interval_seconds !== undefined) fields.post_interval_seconds = b.post_interval_seconds;
        if (b.persona !== undefined) fields.persona = b.persona;
        // Preserve the stored token unless a non-blank new one is provided.
        if (b.api_token !== undefined && String(b.api_token).trim()) fields.api_token = String(b.api_token).trim();

        const config = db.upsertAiChatbotConfig(req.user.id, fields);

        // Apply changes to any live stream this user is currently running.
        try { aiChatbotService.reloadForUser(req.user.id); } catch { /* non-critical */ }

        res.json({ config: sanitize(config) });
    } catch (err) {
        console.error('[AI-Bots] save config error:', err);
        res.status(500).json({ error: 'Failed to save AI chatbot config' });
    }
});

router.post('/validate', requireAuth, async (req, res) => {
    try {
        const stored = db.getAiChatbotConfig(req.user.id);
        const b = req.body || {};
        const apiKey = (b.api_token && String(b.api_token).trim()) || stored.api_token;
        if (!apiKey) return res.status(400).json({ ok: false, error: 'No API token provided' });
        const result = await aiProvider.testConnection({
            baseUrl: b.base_url || stored.base_url,
            apiKey,
            model: b.model || stored.model,
        });
        if (result.ok) {
            try { db.upsertAiChatbotConfig(req.user.id, { last_validated_at: new Date().toISOString() }); } catch {}
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/preview', requireAuth, async (req, res) => {
    try {
        const stored = db.getAiChatbotConfig(req.user.id);
        const b = req.body || {};
        const apiKey = (b.api_token && String(b.api_token).trim()) || stored.api_token;
        if (!apiKey) return res.status(400).json({ error: 'Save or enter an API token first' });
        const persona = b.persona !== undefined ? String(b.persona) : stored.persona;
        const messages = [
            {
                role: 'system',
                content: [
                    'You are a live viewer typing in a Twitch-style stream chat.',
                    persona ? `The streamer wants chat viewers to behave like this: ${persona}` : 'You are a playful troll.',
                    'Write ONE short chat message (max ~20 words), casual and lowercase-ish. Be a troll or argumentative but PG-13: no slurs/hate/threats. No quotes, no name prefix. Output only the message.',
                ].filter(Boolean).join('\n'),
            },
            { role: 'user', content: 'The streamer is playing a game and chat is dead. Type your one chat message:' },
        ];
        const raw = await aiProvider.chatCompletion({
            baseUrl: b.base_url || stored.base_url,
            apiKey,
            model: b.model || stored.model,
            messages,
            temperature: 1.05,
            maxTokens: 60,
        });
        const sample = String(raw || '').replace(/\s+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').trim().slice(0, 200);
        res.json({ sample });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

module.exports = router;
