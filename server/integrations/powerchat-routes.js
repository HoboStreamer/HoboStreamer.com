/**
 * powerchat-routes.js — PowerChat integration API (mounted at /api/powerchat).
 *
 *   GET    /status                    my connection + app-config state
 *   GET    /oauth/start               begin OAuth (opened in a popup)
 *   GET    /oauth/callback            code exchange → store grant (state-cookie auth)
 *   DELETE /oauth/connection          revoke + disconnect
 *   GET    /tip-link                  attribution deep link to the streamer's tip page
 *   POST   /test-alert                fire a PowerChat test alert (alerts:trigger)
 *   POST   /webhook                   signed event receiver (no auth; HMAC verified)
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const config = require('../config');
const { requireAuth } = require('../auth/auth');
const oauth = require('./powerchat-oauth');
const webhook = require('./powerchat-webhook');

const STATE_COOKIE = 'powerchat_oauth_state';
function cookieOpts() {
    const secure = String(config.baseUrl).startsWith('https');
    return { httpOnly: true, sameSite: 'lax', secure, maxAge: 10 * 60 * 1000, path: '/api/powerchat/oauth' };
}

function resultPage(payload) {
    const data = JSON.stringify(payload);
    return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center}.ok{color:#53fc18}.err{color:#ff6b6b}</style></head>
<body><div class="box"><h2 class="${payload.ok ? 'ok' : 'err'}">${payload.ok ? '✓ Connected' : '✗ Connection failed'}</h2>
<p>${payload.ok ? 'PowerChat account linked. You can close this window.' : (payload.error || 'Something went wrong.')}</p></div>
<script>(function(){
  var msg = Object.assign({ type: 'powerchat-oauth' }, ${data});
  try { if (window.opener) window.opener.postMessage(msg, '${config.baseUrl}'); } catch(e){}
  try { var bc = new BroadcastChannel('powerchat-oauth'); bc.postMessage(msg); setTimeout(function(){try{bc.close();}catch(e){}},500); } catch(e){}
  try { localStorage.setItem('powerchat-oauth', JSON.stringify(Object.assign({ t: Date.now() }, msg))); } catch(e){}
  setTimeout(function(){ try { window.close(); } catch(e){} }, ${payload.ok ? 900 : 2500});
})();</script></body></html>`;
}

// ── GET /status ──────────────────────────────────────────────────────────────
router.get('/status', requireAuth, (req, res) => {
    try {
        const cfg = oauth.getConfig();
        const conn = db.getPowerchatConnection(req.user.id);
        const connected = !!(conn && conn.access_token);
        res.json({
            enabled: cfg.enabled,
            configured: oauth.isConfigured(),
            connected,
            username: conn ? conn.powerchat_username : null,
            tip_page_url: conn ? conn.tip_page_url : null,
            scope: conn ? conn.scope : null,
            last_error: conn ? conn.last_error : null,
            sandbox_username: cfg.sandboxUsername,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load PowerChat status' });
    }
});

// ── GET /oauth/start ─────────────────────────────────────────────────────────
router.get('/oauth/start', requireAuth, (req, res) => {
    try {
        const cfg = oauth.getConfig();
        if (!cfg.enabled) return res.status(400).send(resultPage({ ok: false, error: 'PowerChat is not enabled by the site admin yet.' }));
        if (!oauth.isConfigured()) return res.status(400).send(resultPage({ ok: false, error: 'PowerChat app credentials are not configured yet.' }));
        // The streamer's PowerChat username (their :username segment). Defaults to the
        // sandbox username so the app owner can test before approval.
        const username = String(req.query.username || cfg.sandboxUsername || '').trim();
        const { url, stateToken } = oauth.buildAuthorize({ userId: req.user.id, username });
        res.cookie(STATE_COOKIE, stateToken, cookieOpts());
        res.redirect(url);
    } catch (err) {
        res.status(400).send(resultPage({ ok: false, error: err.message }));
    }
});

// ── GET /oauth/callback ──────────────────────────────────────────────────────
router.get('/oauth/callback', async (req, res) => {
    const send = (p) => res.set('Content-Type', 'text/html').send(resultPage(p));
    try {
        const { code, state, error } = req.query;
        if (error) return send({ ok: false, error: String(error) });
        const stateData = oauth.verifyState(req.cookies ? req.cookies[STATE_COOKIE] : null);
        res.clearCookie(STATE_COOKIE, { path: '/api/powerchat/oauth' });
        if (!stateData) return send({ ok: false, error: 'OAuth session expired — please try again.' });
        if (!code || state !== stateData.nonce) return send({ ok: false, error: 'Invalid OAuth response (state mismatch).' });

        const tokens = await oauth.exchangeCode(String(code), stateData.codeVerifier);
        const userId = stateData.userId;

        // Derive the streamer's PowerChat identity from the access-token JWT — OAuth already
        // tells us who authorized, so we never ask them to type their own username. Only if
        // the token carries no usable username claim do we fall back to the sandbox username.
        const ident = oauth.identityFromToken(tokens.access_token);
        let username = ident.username || stateData.username || oauth.getConfig().sandboxUsername;

        // Store the grant first (so getValidAccessToken works), then confirm via profile.
        db.upsertPowerchatConnection(userId, {
            powerchat_username: username,
            powerchat_user_id: ident.id || null,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            token_expires_at: tokens.token_expires_at,
            scope: tokens.scope,
            last_error: null,
        });
        // Best-effort profile fetch to confirm identity + capture the canonical username +
        // tip page URL (authoritative over the JWT claim).
        try {
            const prof = await oauth.fetchProfile(userId, username);
            const p = prof.profile || prof;
            db.upsertPowerchatConnection(userId, {
                powerchat_username: p.username || username,
                powerchat_user_id: (p.id != null ? String(p.id) : ident.id) || null,
                tip_page_url: p.tipPageUrl || p.tip_page_url || null,
            });
            if (p.username) username = p.username;
        } catch (e) {
            console.warn('[PowerChat] profile fetch after connect failed:', e.message);
        }
        res.set('Content-Type', 'text/html').send(resultPage({ ok: true, username }));
    } catch (err) {
        console.error('[PowerChat] OAuth callback error:', err.message);
        send({ ok: false, error: err.message || 'Connection failed' });
    }
});

// ── DELETE /oauth/connection ─────────────────────────────────────────────────
router.delete('/oauth/connection', requireAuth, async (req, res) => {
    try {
        const conn = db.getPowerchatConnection(req.user.id);
        if (conn) {
            if (conn.refresh_token) await oauth.revokeToken(conn.refresh_token);
            else if (conn.access_token) await oauth.revokeToken(conn.access_token);
            db.deletePowerchatConnection(req.user.id);
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

// ── GET /tip-link — attribution deep link into the streamer's tip page ────────
// ?ref=<opaque>  or  ?goal_id=<id>  → app_ref="goal:<id>" so donation webhooks echo it.
router.get('/tip-link', requireAuth, (req, res) => {
    try {
        const cfg = oauth.getConfig();
        const conn = db.getPowerchatConnection(req.user.id);
        if (!conn || !conn.powerchat_username) return res.status(404).json({ error: 'PowerChat not connected' });
        let ref = req.query.ref ? String(req.query.ref) : '';
        if (!ref && req.query.goal_id) ref = `goal:${parseInt(req.query.goal_id, 10)}`;
        const params = new URLSearchParams({ app_client_id: cfg.clientId });
        if (ref) params.set('app_ref', ref);
        const url = `${cfg.baseUrl}/${encodeURIComponent(conn.powerchat_username)}/tip?${params.toString()}`;
        res.json({ url, tip_page_url: conn.tip_page_url || `${cfg.baseUrl}/${conn.powerchat_username}/tip` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to build tip link' });
    }
});

// ── POST /test-alert — fire the PowerChat dashboard test-alert (alerts:trigger) ─
router.post('/test-alert', requireAuth, async (req, res) => {
    try {
        await oauth.apiRequest(req.user.id, { method: 'POST', path: '/test-alerts', body: {} });
        res.json({ ok: true });
    } catch (err) {
        res.status(err.status === 403 ? 403 : 502).json({ error: err.message });
    }
});

// ── POST /webhook — signed event receiver ────────────────────────────────────
// No auth middleware: authenticity is the HMAC signature. Ack fast, process async.
router.post('/webhook', (req, res) => {
    try {
        const raw = req.rawBody || (req.body ? Buffer.from(JSON.stringify(req.body)) : Buffer.alloc(0));
        const check = webhook.verifySignature(raw, req.headers);
        if (!check.ok) {
            console.warn('[PowerChat] webhook rejected:', check.reason);
            return res.status(401).json({ error: 'invalid signature' });
        }
        const deliveryId = req.headers['x-powerchat-delivery-id'] || null;
        const eventType = req.headers['x-powerchat-event-type'] || (req.body && req.body.type) || null;

        // Dedupe at-least-once deliveries.
        if (deliveryId && !db.powerchatDeliveryIsNew(deliveryId, eventType)) {
            return res.status(200).json({ ok: true, deduped: true });
        }

        // Ack immediately; process off the response path.
        res.status(200).json({ ok: true });
        const envelope = req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(raw.toString('utf8')); } catch { return null; } })();
        setImmediate(() => { try { if (envelope) webhook.processEvent(envelope); } catch (e) { console.warn('[PowerChat] webhook process error:', e.message); } });
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: 'webhook error' });
    }
});

module.exports = router;
