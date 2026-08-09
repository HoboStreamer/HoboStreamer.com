/**
 * HoboStreamer — AI analysis
 *
 * Vision + text analysis used for: paste description/tags, paste text overviews,
 * and periodic live-stream "memories". Provider (Anthropic Claude by default, or
 * any OpenAI-compatible endpoint) + key + model are configured in
 * hobo.tools/admin → AI. Everything is gated by the `ai_enabled` master switch and
 * an optional daily USD budget cap. Token usage + estimated cost are recorded to
 * `ai_usage` for the admin cost breakdown.
 */
const fs = require('fs');
const db = require('../db/database');

function s(k) { return (db.getSetting(k) || '').toString().trim(); }
function b(k) { const v = db.getSetting(k); return v === true || v === 'true' || v === 1 || v === '1'; }
function num(k, d) { const v = parseFloat(db.getSetting(k)); return Number.isFinite(v) ? v : d; }

function isEnabled() { return b('ai_enabled') && !!s('ai_api_key'); }
function pasteAnalysisEnabled() { return isEnabled() && b('ai_paste_analysis_enabled'); }
function streamMemoryEnabled() { return isEnabled() && b('ai_stream_memory_enabled'); }
function captureIntervalSec() { return Math.max(30, num('ai_stream_capture_interval_sec', 120)); }
function model() { return s('ai_model') || (s('ai_provider') === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-5'); }

function withinBudget() {
    const cap = num('ai_max_cost_usd_per_day', 0);
    if (!cap || cap <= 0) return true;
    try { return db.getAiCostToday() < cap; } catch { return true; }
}
function estimateCost(inTok, outTok) {
    return (inTok / 1e6) * num('ai_input_cost_per_mtok', 3) + (outTok / 1e6) * num('ai_output_cost_per_mtok', 15);
}

// Normalize an image input (data URL, raw base64, or file path) → {base64, mediaType}.
function _normImage(image) {
    if (!image) return null;
    if (typeof image === 'string' && image.startsWith('data:')) {
        const m = image.match(/^data:([^;]+);base64,(.*)$/);
        if (m) return { base64: m[2], mediaType: m[1] };
    }
    if (typeof image === 'string' && /^[A-Za-z0-9+/=]+$/.test(image.slice(0, 40))) {
        return { base64: image, mediaType: 'image/jpeg' };
    }
    // treat as a file path
    try {
        const buf = fs.readFileSync(image);
        const ext = String(image).toLowerCase();
        const mediaType = ext.endsWith('.png') ? 'image/png' : ext.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        return { base64: buf.toString('base64'), mediaType };
    } catch { return null; }
}

// ── Provider calls (return { text, input_tokens, output_tokens }) ──
async function _anthropic(prompt, img, maxTokens) {
    const content = [{ type: 'text', text: prompt }];
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': s('ai_api_key'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: model(), max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || `anthropic ${res.status}`);
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const u = j.usage || {};
    return { text, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 };
}
async function _openai(prompt, img, maxTokens) {
    const base = (s('ai_base_url') || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const m = model();
    const content = [{ type: 'text', text: prompt }];
    if (img) content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
    const body = { model: m, messages: [{ role: 'user', content }] };
    // GPT-5 / o-series are reasoning models: they reject `max_tokens` (need
    // `max_completion_tokens`) and spend hidden reasoning tokens, so give the
    // output headroom and keep reasoning effort low for these short tasks —
    // otherwise the whole budget is consumed by reasoning and content is empty.
    if (/^(gpt-5|o\d)/i.test(m)) {
        body.max_completion_tokens = Math.max(maxTokens, 256) + 512;
        body.reasoning_effort = /^gpt-5/i.test(m) ? 'minimal' : 'low';
    } else {
        body.max_tokens = maxTokens;
    }
    const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s('ai_api_key')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || `openai ${res.status}`);
    const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    const u = j.usage || {};
    return { text, input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 };
}

/** Core call: dispatches by provider, records usage/cost. Returns text or null. */
async function _complete({ prompt, image = null, maxTokens = 400, kind }) {
    if (!isEnabled() || !withinBudget()) return null;
    const img = image ? _normImage(image) : null;
    if (image && !img) return null;
    const provider = s('ai_provider') === 'openai' ? _openai : _anthropic;
    let r;
    try { r = await provider(prompt, img, maxTokens); }
    catch (e) { console.warn('[AI] analysis failed:', e.message); return null; }
    try { db.recordAiUsage({ kind, model: model(), input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: estimateCost(r.input_tokens, r.output_tokens) }); } catch { /* */ }
    return r.text || null;
}

function _parseJson(text) {
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

// ── Public analysis functions ──

/** Describe an image paste → { description, tags }. */
async function analyzeImagePaste(image, title) {
    const prompt = `You are describing an uploaded image/screenshot for a paste titled "${(title || '').slice(0, 120)}".
Reply ONLY with compact JSON: {"description":"1-2 sentence description of what the image shows","tags":["3-6","short","lowercase","tags"]}.`;
    const text = await _complete({ prompt, image, maxTokens: 300, kind: 'paste_image' });
    const j = _parseJson(text);
    if (j) return { description: String(j.description || '').slice(0, 600), tags: Array.isArray(j.tags) ? j.tags.slice(0, 8).map(String) : [] };
    return text ? { description: text.slice(0, 600), tags: [] } : null;
}

/** Summarize a text paste → { description }. */
async function analyzeTextPaste(content, title) {
    const snippet = String(content || '').slice(0, 6000);
    const prompt = `Summarize what this pasted text is about in one short sentence (max 200 chars), plainly. Title: "${(title || '').slice(0, 120)}".\n\n---\n${snippet}`;
    const text = await _complete({ prompt, maxTokens: 120, kind: 'paste_text' });
    return text ? { description: text.slice(0, 300), tags: [] } : null;
}

/** Analyze a live-stream frame → { description, tags }. */
async function analyzeStreamFrame(image) {
    const prompt = `This is a frame from a live stream. Reply ONLY with compact JSON: {"description":"one concise sentence describing what is happening on screen right now","tags":["2-5","short","tags"]}.`;
    const text = await _complete({ prompt, image, maxTokens: 200, kind: 'stream_memory' });
    const j = _parseJson(text);
    if (j) return { description: String(j.description || '').slice(0, 400), tags: Array.isArray(j.tags) ? j.tags.slice(0, 6).map(String) : [] };
    return text ? { description: text.slice(0, 400), tags: [] } : null;
}

/** Condense a stream's memories into a one-line "AI Overview" for the home card. */
async function summarizeStreamMemories(memories) {
    // Use observations from across the whole session (capped for token budget) so the
    // overview reflects the entire stream since it started, not just the latest frame.
    const lines = (memories || []).slice(-80).map(m => `- ${m.description}`).join('\n');
    if (!lines) return null;
    const prompt = `These are timestamped observations from a live stream, in order since it started. Give a thorough overview (2-6 sentences) of what this stream has been about overall — the main activities, topics, and vibe across the whole session (not just the latest moment):\n${lines}`;
    const text = await _complete({ prompt, maxTokens: 500, kind: 'stream_memory' });
    return text ? text.slice(0, 2000) : null;
}

/**
 * Build (and store) an AI overview of a streamer, aggregating signals across all
 * their streams (memories), VODs, and pastes. Returns the overview text or null.
 */
async function generateStreamerOverview(userId) {
    if (!isEnabled() || !withinBudget()) return null;
    const user = db.getUserById(userId);
    if (!user) return null;
    const channel = (typeof db.getChannelByUserId === 'function') ? db.getChannelByUserId(userId) : null;

    const memories = (db.getStreamMemoriesByUser ? db.getStreamMemoriesByUser(userId, 60) : []) || [];
    const memLines = memories.slice(0, 40).map(m => `- ${m.description}`).filter(l => l.length > 2);

    const vods = (db.getVodsByUser ? db.getVodsByUser(userId, false, 20, 0) : []) || [];
    const vodLines = vods.map(v => `- ${v.title || 'Untitled VOD'}${v.category ? ` [${v.category}]` : ''}`);

    const pastes = (db.getUserPastesForAi ? db.getUserPastesForAi(userId, 25) : []) || [];
    const pasteLines = pastes.filter(p => p.ai_summary).map(p => `- "${p.title || 'paste'}": ${p.ai_summary}`);

    if (!memLines.length && !vodLines.length && !pasteLines.length) return null;

    const ctx = [
        `Streamer: ${user.display_name || user.username} (@${user.username})`,
        (channel?.bio || user.bio) ? `Bio: ${(channel?.bio || user.bio).slice(0, 400)}` : '',
        channel?.category ? `Usual category: ${channel.category}` : '',
        memLines.length ? `\nLive-stream observations (across sessions):\n${memLines.join('\n')}` : '',
        vodLines.length ? `\nRecent VODs:\n${vodLines.join('\n')}` : '',
        pasteLines.length ? `\nPaste summaries:\n${pasteLines.join('\n')}` : '',
    ].filter(Boolean).join('\n');

    const prompt = `You are building an internal profile of a livestreamer for site staff, using aggregated signals across their streams, VODs, and pastes. Write a concise overview (4-8 sentences) covering: what they stream / their content niche, recurring themes or activities, tone/vibe, and anything notable for moderation. Be factual and neutral; do NOT invent specifics that aren't supported by the signals below.\n\n${ctx}`;

    const text = await _complete({ prompt, maxTokens: 550, kind: 'streamer_overview' });
    if (!text) return null;
    const overview = text.slice(0, 4000);
    try {
        db.upsertStreamerOverview(userId, {
            overview,
            model: model(),
            sources: JSON.stringify({ memories: memories.length, vods: vods.length, pastes: pasteLines.length }),
        });
    } catch (e) { console.warn('[AI] overview store failed:', e.message); }
    return overview;
}

/** Report AI config + optionally live-probe the provider. */
async function testStatus({ probe = true } = {}) {
    const cfg = {
        enabled: isEnabled(),
        provider: s('ai_provider') || 'anthropic',
        model: model(),
        has_key: !!s('ai_api_key'),
        base_url: s('ai_base_url') || null,
        paste_analysis: pasteAnalysisEnabled(),
        stream_memory: streamMemoryEnabled(),
        budget_cap_usd_per_day: num('ai_max_cost_usd_per_day', 0),
        within_budget: withinBudget(),
    };
    try { cfg.cost_today = db.getAiCostToday(); } catch { cfg.cost_today = null; }
    if (!cfg.enabled) return { ...cfg, ok: false, error: cfg.has_key ? 'AI is disabled (ai_enabled=false)' : 'No API key set' };
    if (!probe) return { ...cfg, ok: true, probed: false };
    const started = Date.now();
    const reply = await _complete({ prompt: 'Reply with exactly: OK', maxTokens: 8, kind: 'status_check' });
    return { ...cfg, ok: !!reply, probed: true, reply: reply || null, latency_ms: Date.now() - started, error: reply ? null : 'Provider returned no response (check key/model/base URL)' };
}

module.exports = {
    isEnabled, pasteAnalysisEnabled, streamMemoryEnabled, captureIntervalSec,
    analyzeImagePaste, analyzeTextPaste, analyzeStreamFrame, summarizeStreamMemories,
    generateStreamerOverview, testStatus,
};
