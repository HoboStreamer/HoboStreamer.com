'use strict';

/**
 * Shared notification helpers for HoboStreamer.
 * Pushes notifications to hobo-tools via internal API.
 */

const HOBO_TOOLS_INTERNAL_URL = process.env.HOBO_TOOLS_INTERNAL_URL || 'http://127.0.0.1:3100';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.HOBO_INTERNAL_KEY || '';

/**
 * Push a single notification to a user via hobo-tools internal API.
 * Fire-and-forget — does not block or throw.
 * @param {Object} payload - Notification fields (user_id required)
 */
function pushNotification(payload) {
    if (!payload?.user_id) return;

    fetch(`${HOBO_TOOLS_INTERNAL_URL}/internal/notifications/push`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': INTERNAL_API_KEY,
        },
        body: JSON.stringify({ ...payload, service: payload.service || 'hobostreamer' }),
    }).then(r => {
        if (!r.ok) console.warn(`[Notify] Push failed: ${r.status}`);
    }).catch(err => {
        console.warn('[Notify] Push error:', err.message);
    });
}

/**
 * Push bulk notifications to multiple users.
 * @param {number[]} userIds - Array of user IDs
 * @param {Object} data - Notification fields (without user_id)
 */
function pushBulkNotification(userIds, data) {
    if (!userIds?.length) return;

    fetch(`${HOBO_TOOLS_INTERNAL_URL}/internal/notifications/push-bulk`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': INTERNAL_API_KEY,
        },
        body: JSON.stringify({ user_ids: userIds, ...data, service: data.service || 'hobostreamer' }),
    }).then(r => {
        if (!r.ok) console.warn(`[Notify] Bulk push failed: ${r.status}`);
        else console.log(`[Notify] Bulk sent to ${userIds.length} users`);
    }).catch(err => {
        console.warn('[Notify] Bulk push error:', err.message);
    });
}

/**
 * Build sender info object from a user row.
 */
function actorInfo(user, fallback = 'Someone') {
    return {
        sender_id: user?.id || null,
        sender_name: user ? (user.display_name || user.username) : fallback,
        sender_avatar: user?.avatar_url || null,
    };
}

module.exports = { pushNotification, pushBulkNotification, actorInfo };
