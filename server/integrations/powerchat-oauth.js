/**
 * powerchat-oauth.js — PowerChat OAuth 2.0 (authorization-code + PKCE) + token management
 * + a thin authenticated REST client.
 *
 * PowerChat is a streamer donations/alerts service. HoboStreamer registers ONE confidential
 * OAuth app (client_id/secret configured by the owner in admin); each streamer then grants it
 * access to their own PowerChat account. We use the INTEGRATION direction (receive donations
 * via webhooks + attribute tip checkouts), so the requested scopes are read-focused.
 *
 * Security invariants (per the PowerChat docs):
 *  - Access tokens are ~10-min JWTs; refresh tokens ROTATE on every use. Reusing an old
 *    refresh token revokes the entire token family — so we persist the newest pair
 *    atomically and never replay an old one.
 *  - PKCE (S256) is used in addition to the client secret.
 *  - OAuth `state` is a signed, short-lived cookie (double-submit CSRF), same as the
 *    restream platform-OAuth flow.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');

const JWT_SECRET = process.env.JWT_SECRET || 'hobostreamer-dev-secret';
const STATE_TTL_MS = 10 * 60 * 1000;

function s(k) { return String(db.getSetting(k) || '').trim(); }
function b(k) { const v = db.getSetting(k); return v === true || v === 'true' || v === 1 || v === '1'; }

// ── App-level config (from admin site_settings) ──────────────────────────────
function getConfig() {
    const baseUrl = (s('powerchat_base_url') || 'https://powerchatlive.dev').replace(/\/+$/, '');
    return {
        enabled: b('powerchat_enabled'),
        baseUrl,
        clientId: s('powerchat_client_id'),
        clientSecret: s('powerchat_client_secret'),
        webhookSecret: s('powerchat_webhook_secret'),
        scopes: s('powerchat_scopes') || 'profile:read webhooks:events checkout:attribute paid_messages:read',
        sandboxUsername: s('powerchat_sandbox_username') || 'n8admin',
        authorizeUrl: `${baseUrl}/oauth/authorize`,
        tokenUrl: `${baseUrl}/oauth/token`,
        revokeUrl: `${baseUrl}/oauth/revoke`,
        apiBase: `${baseUrl}/api/dev/v1`,
    };
}
// True once the owner has entered the client id + secret (webhook secret optional but
// required for webhooks to be accepted).
function isConfigured() {
    const c = getConfig();
    return !!(c.clientId && c.clientSecret);
}
function redirectUri() {
    return `${String(config.baseUrl).replace(/\/+$/, '')}/api/powerchat/oauth/callback`;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────
function generatePkce() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
}

// ── Signed state cookie (CSRF) ───────────────────────────────────────────────
function signState(payload) {
    const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url');
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
}
function verifyState(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    } catch { return null; }
    let data;
    try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!data || !data.ts || (Date.now() - data.ts) > STATE_TTL_MS) return null;
    return data;
}

// ── Authorize URL ────────────────────────────────────────────────────────────
// Returns { url, stateToken } — stateToken goes in the httpOnly cookie; the URL `state`
// param is just the nonce (double-submit check on callback).
function buildAuthorize({ userId, username }) {
    const c = getConfig();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const { codeVerifier, codeChallenge } = generatePkce();
    const params = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: c.scopes,
        state: nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });
    const stateToken = signState({ userId, username: username || '', nonce, codeVerifier });
    return { url: `${c.authorizeUrl}?${params.toString()}`, stateToken };
}

// ── Token endpoint helpers ───────────────────────────────────────────────────
function normalizeToken(json) {
    const expiresIn = Number(json.expires_in) || 600;
    return {
        access_token: json.access_token,
        refresh_token: json.refresh_token || null,
        token_expires_at: Date.now() + expiresIn * 1000,
        scope: json.scope || null,
    };
}

async function _postToken(form) {
    const c = getConfig();
    const res = await fetch(c.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error((json.error_description || json.error || `token endpoint ${res.status}`));
        err.oauthError = json.error || `http_${res.status}`;
        err.status = res.status;
        throw err;
    }
    return json;
}

async function exchangeCode(code, codeVerifier) {
    const c = getConfig();
    return normalizeToken(await _postToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code_verifier: codeVerifier,
    }));
}

async function refreshToken(refresh_token) {
    const c = getConfig();
    return normalizeToken(await _postToken({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: c.clientId,
        client_secret: c.clientSecret,
    }));
}

async function revokeToken(token) {
    const c = getConfig();
    try {
        await fetch(c.revokeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token, client_id: c.clientId, client_secret: c.clientSecret }).toString(),
        });
    } catch { /* best-effort */ }
}

// ── Valid access token (auto-refresh at use, atomic rotation) ────────────────
// Returns a usable access token for the streamer, refreshing + persisting the rotated
// pair when near expiry. On a reuse/invalid_grant failure the family is dead → we clear
// the tokens so the streamer is prompted to re-authorize. Throws on unrecoverable states.
async function getValidAccessToken(userId) {
    const conn = db.getPowerchatConnection(userId);
    if (!conn || !conn.access_token) throw new Error('PowerChat not connected');
    if (conn.token_expires_at && (conn.token_expires_at - Date.now()) > 60000) {
        return conn.access_token;
    }
    if (!conn.refresh_token) throw new Error('PowerChat token expired — reconnect required');
    let t;
    try {
        t = await refreshToken(conn.refresh_token);
    } catch (err) {
        // invalid_grant almost always means the refresh token was already rotated/revoked
        // (family killed) or the streamer revoked consent → force a reconnect.
        if (err.oauthError === 'invalid_grant' || err.status === 400 || err.status === 401) {
            db.setPowerchatConnectionError(userId, `Reconnect needed: ${err.oauthError || err.message}`);
            db.updatePowerchatTokens(userId, { access_token: null, refresh_token: null, token_expires_at: null, scope: conn.scope });
        }
        throw err;
    }
    // Persist the NEW pair atomically before using it.
    db.updatePowerchatTokens(userId, t);
    return t.access_token;
}

// ── Authenticated REST client ────────────────────────────────────────────────
// path is relative to /streamers/:username, e.g. '/profile'. `username` defaults to the
// streamer's stored PowerChat username (sandbox: the app owner's).
async function apiRequest(userId, { method = 'GET', path, username, body, query } = {}) {
    const c = getConfig();
    const conn = db.getPowerchatConnection(userId);
    const uname = username || (conn && conn.powerchat_username) || c.sandboxUsername;
    const token = await getValidAccessToken(userId);
    let url = `${c.apiBase}/streamers/${encodeURIComponent(uname)}${path}`;
    if (query) { const qs = new URLSearchParams(query).toString(); if (qs) url += `?${qs}`; }
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const e = new Error((json.error && json.error.message) || `PowerChat API ${res.status}`);
        e.status = res.status;
        e.code = json.error && json.error.code;
        throw e;
    }
    return json;
}

// Public profile + live status + tipPageUrl (scope profile:read).
async function fetchProfile(userId, username) {
    return apiRequest(userId, { method: 'GET', path: '/profile', username });
}

module.exports = {
    getConfig, isConfigured, redirectUri,
    buildAuthorize, verifyState, exchangeCode, refreshToken, revokeToken,
    getValidAccessToken, apiRequest, fetchProfile, normalizeToken,
};
