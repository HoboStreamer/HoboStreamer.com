/**
 * powerchat-webhook.js — verify + process PowerChat webhook deliveries.
 *
 * Deliveries are signed and at-least-once. We:
 *   1. Verify the HMAC-SHA256 signature over "<timestamp>.<raw body>" (timing-safe).
 *   2. Reject timestamps older than 15 minutes.
 *   3. Dedupe on X-PowerChat-Delivery-Id.
 *   4. Ack 2xx fast; process async.
 *
 * `donation.completed` is mapped onto HoboStreamer's existing donation pipeline: it credits
 * the streamer's active donation goal and fires the same live chat event + alert sound +
 * goal-reached celebration that an on-site Hobo Bucks donation does.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db/database');
const powerchatOAuth = require('./powerchat-oauth');

const MAX_SKEW_MS = 15 * 60 * 1000;

// ── Signature verification ───────────────────────────────────────────────────
// Returns { ok, reason }. rawBody must be the exact bytes received (Buffer or string).
function verifySignature(rawBody, headers) {
    const secret = powerchatOAuth.getConfig().webhookSecret;
    if (!secret) return { ok: false, reason: 'webhook secret not configured' };

    const sigHeader = headers['x-powerchat-signature'] || '';
    const tsHeader = headers['x-powerchat-timestamp'] || '';
    if (!sigHeader || !tsHeader) return { ok: false, reason: 'missing signature/timestamp headers' };

    // Timestamp is unix ms; reject stale deliveries (replay protection).
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
        return { ok: false, reason: 'timestamp outside allowed window' };
    }

    const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
    const expected = 'sha256=' + crypto.createHmac('sha256', secret)
        .update(String(tsHeader) + '.').update(bodyBuf).digest('hex');

    const a = Buffer.from(sigHeader);
    const bexp = Buffer.from(expected);
    if (a.length !== bexp.length) return { ok: false, reason: 'signature mismatch' };
    if (!crypto.timingSafeEqual(a, bexp)) return { ok: false, reason: 'signature mismatch' };
    return { ok: true };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function publicGoal(g) {
    if (!g) return null;
    return {
        id: g.id, user_id: g.user_id, title: g.title,
        target_amount: g.target_amount, current_amount: g.current_amount,
        is_active: g.is_active, reached_at: g.reached_at || null,
        image_url: g.image_url || null, media_type: g.media_type || null,
        sort_order: g.sort_order || 0,
    };
}

// Resolve the HoboStreamer user who owns the PowerChat account this event is for.
function _resolveStreamerUserId(streamer) {
    if (!streamer) return null;
    let conn = null;
    if (streamer.id) conn = db.getPowerchatConnectionByPcUserId(String(streamer.id));
    if (!conn && streamer.username) conn = db.getPowerchatConnectionByUsername(streamer.username);
    return conn ? conn.user_id : null;
}

// app_ref may encode a target goal, e.g. "goal:12" (see the checkout-attribution link).
function _goalIdFromRef(ref) {
    if (!ref || typeof ref !== 'string') return null;
    const m = ref.match(/(?:^|[:_-])goal[:_-]?(\d+)/i);
    return m ? Number(m[1]) : null;
}

// ── Donation handling — mirrors POST /api/funds/donate ───────────────────────
function _handleDonation(userId, data) {
    const chatServer = require('../chat/chat-server');
    const alerts = require('../monetization/alerts');
    const hoboBucks = require('../monetization/hobo-bucks');

    // PowerChat amounts are in cents; amountUsdCents is the normalized-to-USD value.
    const cents = Number(data.amountUsdCents || data.amountCents || 0);
    const amount = Math.max(0, Math.round(cents / 100)); // Hobo Bucks goals are whole dollars
    const donor = String(data.donorName || 'Someone').slice(0, 80);
    const message = String(data.message || '').slice(0, 500);
    const goalId = _goalIdFromRef(data.appExternalRef);
    const ts = new Date().toISOString();

    // If the streamer is live, attach to the live session so it lands in that slot too.
    let streamId = null;
    try { const live = db.getLiveStreamsByUserId(userId) || []; if (live.length) streamId = live[0].id; } catch { /* */ }

    // Credit a goal (donor's chosen one via app_ref, else the sole active goal).
    let goalResult = null;
    try { goalResult = hoboBucks.applyDonationToGoal(userId, amount, goalId); } catch { /* */ }

    // 1) Donation chat event — live + persisted to channel history.
    chatServer.broadcastToChannelRoom(userId, streamId, {
        type: 'donation', username: donor, user_id: null, avatar_url: null,
        amount, message, source: 'powerchat', timestamp: ts,
    });
    try {
        db.saveChatMessage({
            stream_id: streamId, channel_user_id: userId, user_id: null, username: donor,
            message: `${donor} tipped $${amount}${message ? ': ' + message : ''} (PowerChat)`,
            message_type: 'donation',
            metadata: { kind: 'donation', amount, message, username: donor, source: 'powerchat' },
        });
    } catch { /* */ }

    // 2) Donation sound.
    try { alerts.playAlertSound(chatServer, userId, streamId, 'donation'); } catch { /* */ }

    // 3) Goal progress + 4) goal reached.
    if (goalResult && goalResult.goal) {
        chatServer.broadcastToChannelRoom(userId, streamId, { type: 'goal-update', goal: publicGoal(goalResult.goal) });
    }
    if (goalResult && goalResult.reached) {
        const g = goalResult.goal;
        chatServer.broadcastToChannelRoom(userId, streamId, { type: 'goal-reached', goal: publicGoal(g), by: donor, timestamp: ts });
        try {
            db.saveChatMessage({
                stream_id: streamId, channel_user_id: userId, user_id: null, username: 'Donation Goal',
                message: `🎉 Goal reached: ${g.title} ($${g.target_amount})`,
                message_type: 'donation',
                metadata: { kind: 'goal-reached', goal_id: g.id, title: g.title, target: g.target_amount, image: g.image_url || null, media_type: g.media_type || null, by: donor },
            });
        } catch { /* */ }
        try { alerts.playAlertSound(chatServer, userId, streamId, 'goal'); } catch { /* */ }
    }

    console.log(`[PowerChat] Donation: $${amount} to user ${userId} from ${donor}${goalResult && goalResult.reached ? ' (goal reached!)' : ''}`);
}

// A membership/sub — surface as a chat event (no HoboStreamer sub system to credit).
function _handleSubscription(userId, data) {
    const chatServer = require('../chat/chat-server');
    const name = String(data.subscriberName || data.donorName || 'Someone').slice(0, 80);
    const ts = new Date().toISOString();
    chatServer.broadcastToChannelRoom(userId, null, { type: 'donation', username: name, amount: 0, message: 'subscribed via PowerChat', source: 'powerchat-sub', timestamp: ts });
    try {
        db.saveChatMessage({
            stream_id: null, channel_user_id: userId, user_id: null, username: name,
            message: `${name} subscribed (PowerChat)`, message_type: 'donation',
            metadata: { kind: 'donation', amount: 0, username: name, source: 'powerchat-sub' },
        });
    } catch { /* */ }
}

// ── Entry point: process a verified, deduped envelope ────────────────────────
function processEvent(envelope) {
    if (!envelope || !envelope.type) return;
    const userId = _resolveStreamerUserId(envelope.streamer);
    if (!userId) { console.warn(`[PowerChat] webhook ${envelope.type} for unknown streamer`, envelope.streamer); return; }
    const data = envelope.data || {};
    try {
        switch (envelope.type) {
            case 'donation.completed':
                // The authoritative money event. paid_message.created is a subset of this
                // (a tip that carried a message) — we DON'T credit on it to avoid double-count.
                _handleDonation(userId, data);
                break;
            case 'subscription.created':
                _handleSubscription(userId, data);
                break;
            // goal.updated / goal.completed reflect PowerChat's own goals; HoboStreamer runs
            // its own goals credited by donations above, so we intentionally ignore them.
            default:
                break;
        }
    } catch (err) {
        console.warn(`[PowerChat] processEvent(${envelope.type}) failed:`, err.message);
    }
}

module.exports = { verifySignature, processEvent, publicGoal };
