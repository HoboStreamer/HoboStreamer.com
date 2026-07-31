/**
 * ai-provider.js — Minimal OpenAI-compatible AI client.
 *
 * Works with any provider exposing the OpenAI REST shape:
 *   - Chat:          POST {baseUrl}/chat/completions
 *   - Transcription: POST {baseUrl}/audio/transcriptions   (Whisper-style)
 *
 * That covers OpenAI, OpenRouter, Groq, Together, local llama.cpp / LM Studio /
 * Ollama (OpenAI-compat mode), etc. Callers supply baseUrl + apiKey + model.
 * No SDK dependency — uses global fetch/FormData/Blob (Node 18+).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function normalizeBaseUrl(baseUrl) {
    let u = String(baseUrl || DEFAULT_BASE_URL).trim();
    if (!u) u = DEFAULT_BASE_URL;
    return u.replace(/\/+$/, '');
}

/**
 * Chat completion. Returns the assistant message text (string).
 * @param {{baseUrl?:string, apiKey:string, model:string, messages:Array, temperature?:number, maxTokens?:number, timeoutMs?:number}} opts
 */
async function chatCompletion(opts) {
    const {
        baseUrl, apiKey, model, messages,
        temperature = 1.0, maxTokens = 160, timeoutMs = 20000,
    } = opts;
    if (!apiKey) throw new Error('AI API key not configured');
    if (!model) throw new Error('AI model not configured');

    const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages,
                temperature,
                max_tokens: maxTokens,
            }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`AI HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        return typeof text === 'string' ? text.trim() : '';
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Transcribe an audio file. Returns the transcript text (string, possibly '').
 * @param {{baseUrl?:string, apiKey:string, model?:string, filePath:string, language?:string, timeoutMs?:number}} opts
 */
async function transcribe(opts) {
    const {
        baseUrl, apiKey, model = 'whisper-1', filePath,
        language, timeoutMs = 30000,
    } = opts;
    if (!apiKey) throw new Error('AI API key not configured');
    if (!filePath || !fs.existsSync(filePath)) throw new Error('Transcription audio file missing');

    const url = `${normalizeBaseUrl(baseUrl)}/audio/transcriptions`;
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(filePath));
    form.append('model', model);
    form.append('response_format', 'text');
    if (language) form.append('language', language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
            signal: controller.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Transcribe HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
        // response_format=text returns raw text; some providers still return JSON.
        const raw = await res.text();
        try {
            const j = JSON.parse(raw);
            return String(j.text || j.transcript || '').trim();
        } catch {
            return String(raw || '').trim();
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Lightweight connectivity/credential check — a 1-token chat call.
 * Returns { ok:true } or { ok:false, error }.
 */
async function testConnection(opts) {
    try {
        await chatCompletion({
            ...opts,
            messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
            maxTokens: 5,
            temperature: 0,
            timeoutMs: 15000,
        });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = { chatCompletion, transcribe, testConnection, normalizeBaseUrl, DEFAULT_BASE_URL };
