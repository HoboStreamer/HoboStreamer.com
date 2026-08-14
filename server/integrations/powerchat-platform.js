/**
 * powerchat-platform.js — PLATFORM direction (HoboStreamer sends data INTO PowerChat).
 *
 * When a streamer has connected PowerChat with the relevant scopes, HoboStreamer acts
 * like a streaming platform feeding PowerChat's unified overlays:
 *   - chat:write       → real HoboStreamer chat merges into the unified chat overlay
 *   - viewcount:write  → HoboStreamer's viewer count shows as its own branded chip
 *   - currency:write   → channel-point redemptions fire PowerChat alerts + leaderboards
 *
 * Everything is best-effort and scope-gated: a missing scope / sandbox restriction just
 * makes the call a no-op (PowerChat also checks scopes live and 403s, which we swallow).
 */
'use strict';
const db = require('../db/database');
const oauth = require('./powerchat-oauth');

// The virtual-currency key the app declares in the PowerChat dashboard for channel points.
const CURRENCY_KEY = 'hobo_points';

// Only a real OAuth app connection (has tokens) with the needed scope may push.
function _connFor(userId, scopeNeeded) {
    try {
        if (!oauth.getConfig().enabled) return null;
        const conn = db.getPowerchatConnection(userId);
        if (!conn || !conn.access_token || !conn.refresh_token) return null;
        if (scopeNeeded && conn.scope && !String(conn.scope).split(/\s+/).includes(scopeNeeded)) return null;
        return conn;
    } catch { return null; }
}

// ── chat:write ───────────────────────────────────────────────
const _chatBuckets = new Map(); // userId → { count, resetAt }  (~120/min limit; we cap at 100)
async function forwardChat(streamerUserId, { chatterName, externalChatterId, message, avatarUrl, isModerator } = {}) {
    if (!message || !chatterName) return;
    const conn = _connFor(streamerUserId, 'chat:write');
    if (!conn) return;
    const now = Date.now();
    let b = _chatBuckets.get(streamerUserId);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60000 }; _chatBuckets.set(streamerUserId, b); }
    if (b.count >= 100) return;
    b.count++;
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/chat',
            // Field caps match the PowerChat schema (chatterName 1-48, externalChatterId
            // 1-128, message 1-500) — over-long values 400 with VALIDATION_ERROR.
            body: {
                chatterName: String(chatterName).slice(0, 48),
                externalChatterId: String(externalChatterId || chatterName).slice(0, 128),
                message: String(message).slice(0, 500),
                ...(avatarUrl ? { avatarUrl } : {}),
                ...(isModerator ? { isModerator: true } : {}),
            },
        });
    } catch { /* scope/sandbox/rate — silent */ }
}

// ── follows:write ────────────────────────────────────────────
async function forwardFollow(streamerUserId, { followerName, externalId } = {}) {
    if (!followerName) return;
    const conn = _connFor(streamerUserId, 'follows:write');
    if (!conn) return;
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/follows',
            body: {
                followerName: String(followerName).slice(0, 48),
                ...(externalId ? { externalId: String(externalId).slice(0, 128) } : {}),
            },
        });
    } catch { /* silent */ }
}

// ── viewcount:write ──────────────────────────────────────────
const _lastViewCount = new Map(); // userId → last count sent
async function sendViewCount(streamerUserId, count) {
    const conn = _connFor(streamerUserId, 'viewcount:write');
    if (!conn) return;
    if (_lastViewCount.get(streamerUserId) === count) return; // only on change
    _lastViewCount.set(streamerUserId, count);
    try {
        await oauth.apiRequest(streamerUserId, { method: 'POST', path: '/view-count', body: { count } });
    } catch { /* silent */ }
}

// Periodic sweeper: push each connected live streamer's viewer count; push null once
// when they go offline so PowerChat drops the chip.
let _vcTimer = null;
function startViewerCountSweeper() {
    if (_vcTimer) return;
    const seenLive = new Set();
    _vcTimer = setInterval(() => {
        try {
            if (!oauth.getConfig().enabled) return;
            const live = db.getLiveStreams() || [];
            const liveOwners = new Map(); // userId → summed viewer count
            for (const s of live) {
                if (!s.user_id) continue;
                liveOwners.set(s.user_id, (liveOwners.get(s.user_id) || 0) + (s.viewer_count || 0));
            }
            for (const [userId, count] of liveOwners) { seenLive.add(userId); sendViewCount(userId, count); }
            // Owners that were live last tick but aren't now → send null (stream ended).
            for (const userId of Array.from(seenLive)) {
                if (!liveOwners.has(userId)) {
                    seenLive.delete(userId);
                    if (_connFor(userId, 'viewcount:write')) {
                        _lastViewCount.delete(userId);
                        oauth.apiRequest(userId, { method: 'POST', path: '/view-count', body: { count: null } }).catch(() => {});
                    }
                }
            }
        } catch (e) { /* silent */ }
    }, 30000);
    if (_vcTimer.unref) _vcTimer.unref();
    console.log('[PowerChat] viewer-count sweeper started');
}

// ── currency:write ───────────────────────────────────────────
async function sendCurrencyRedemption(streamerUserId, { amount, redeemerName, rewardName, message, externalId } = {}) {
    const conn = _connFor(streamerUserId, 'currency:write');
    if (!conn) return;
    const amt = Math.round(Number(amount) || 0);
    if (amt < 1) return; // schema requires amount 1-1000000000
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/currency-events',
            // Caps match the schema: redeemerName 1-48, rewardName ≤64, message ≤250,
            // externalId 1-128. Requires the CURRENCY_KEY declared in the PowerChat dashboard.
            body: {
                currency: CURRENCY_KEY,
                amount: amt,
                redeemerName: String(redeemerName || 'viewer').slice(0, 48),
                ...(rewardName ? { rewardName: String(rewardName).slice(0, 64) } : {}),
                ...(message ? { message: String(message).slice(0, 250) } : {}),
                ...(externalId ? { externalId: String(externalId).slice(0, 128) } : {}),
            },
        });
    } catch { /* silent */ }
}

// Fire a display-only custom alert on PowerChat (used by "Send test tip" so the
// streamer sees it render on their real PowerChat overlay). Needs alerts:trigger.
async function sendCustomAlert(streamerUserId, { actorName, message, amountCents } = {}) {
    const conn = _connFor(streamerUserId, 'alerts:trigger');
    if (!conn) return false;
    try {
        await oauth.apiRequest(streamerUserId, {
            method: 'POST', path: '/alerts/custom',
            // Schema: actorName 1-32, message ≤250, amountCents 0-100000000.
            body: {
                actorName: String(actorName || 'Test').slice(0, 32),
                ...(message ? { message: String(message).slice(0, 250) } : {}),
                ...(amountCents ? { amountCents: Math.round(amountCents) } : {}),
            },
        });
        return true;
    } catch { return false; }
}

module.exports = {
    CURRENCY_KEY,
    forwardChat, forwardFollow, sendViewCount, startViewerCountSweeper,
    sendCurrencyRedemption, sendCustomAlert,
};
