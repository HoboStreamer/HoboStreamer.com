/**
 * HoboStreamer — Capability & Scope Permission Layer
 *
 * Roles answer "who are you globally?"
 *   user, streamer, global_mod, admin
 *
 * Scope answers "where do you have power?"
 *   channel_moderators table for per-channel assignments
 *
 * Capability answers "what can you do?"
 *   This module exports every check so routes/WS never do raw role comparisons.
 *
 * UI never decides authority — the server does.
 */

const db = require('../db/database');

// ── Role hierarchy (higher = more power) ─────────────────────
const ROLE_RANK = {
    user: 0,
    streamer: 1,
    global_mod: 2,
    admin: 3,
};

function roleRank(role) {
    return ROLE_RANK[role] ?? 0;
}

// ── Core role checks ─────────────────────────────────────────

function isAdmin(user) {
    return user?.role === 'admin';
}

function isGlobalMod(user) {
    return user?.role === 'global_mod';
}

function isGlobalModOrAbove(user) {
    return roleRank(user?.role) >= ROLE_RANK.global_mod;
}

function isStreamer(user) {
    return roleRank(user?.role) >= ROLE_RANK.streamer;
}

// ── Channel mod checks ──────────────────────────────────────

/**
 * Is this user a channel moderator for the given channel?
 */
function isChannelMod(user, channelId) {
    if (!user?.id || !channelId) return false;
    return !!db.isChannelModerator(user.id, channelId);
}

/**
 * Is this user the owner of the given channel?
 */
function isChannelOwner(user, channelId) {
    if (!user?.id || !channelId) return false;
    const channel = db.getChannelById(channelId);
    return channel?.user_id === user.id;
}

/**
 * Does a stream belong to this user?
 */
function isStreamOwner(user, streamId) {
    if (!user?.id || !streamId) return false;
    const stream = db.getStreamById(streamId);
    return stream?.user_id === user.id;
}

/**
 * Get the channel_id for a given stream.
 */
function getChannelIdForStream(streamId) {
    if (!streamId) return null;
    const stream = db.getStreamById(streamId);
    return stream?.channel_id || null;
}

// ── Capability checks ────────────────────────────────────────

/**
 * Can this user access the admin panel? (admin + global_mod)
 * Global mods see a subset of tabs (chat logs, bans).
 */
function canAccessAdminPanel(user) {
    return isGlobalModOrAbove(user);
}

/**
 * Can this user manage users (role changes, bans, etc.)? (admin only)
 */
function canManageUsers(user) {
    return isAdmin(user);
}

/**
 * Can this user manage (promote/demote) global mods? (admin only)
 */
function canManageGlobalMods(user) {
    return isAdmin(user);
}

/**
 * Can this user manage site settings? (admin only)
 */
function canManageSiteSettings(user) {
    return isAdmin(user);
}

/**
 * Can this user review cashouts? (admin only)
 */
function canReviewCashouts(user) {
    return isAdmin(user);
}

/**
 * Can this user review VPN queue? (admin only)
 */
function canReviewVpn(user) {
    return isAdmin(user);
}

/**
 * Can this user manage site-wide bans? (admin + global_mod)
 */
function canManageSiteBans(user) {
    return isGlobalModOrAbove(user);
}

/**
 * Can this user moderate a specific channel's chat?
 *
 * True for: admin, global_mod, channel owner, channel mod
 */
function canModerateChannel(user, channelId) {
    if (!user) return false;
    if (isGlobalModOrAbove(user)) return true;
    if (isChannelOwner(user, channelId)) return true;
    return isChannelMod(user, channelId);
}

/**
 * Can this user moderate a specific stream's chat?
 *
 * Resolves stream → channel, then checks channel moderation.
 */
function canModerateStream(user, streamId) {
    if (!user) return false;
    if (isGlobalModOrAbove(user)) return true;
    if (isStreamOwner(user, streamId)) return true;
    const channelId = getChannelIdForStream(streamId);
    if (channelId && isChannelMod(user, channelId)) return true;
    return false;
}

/**
 * Can this user moderate a call on a specific stream?
 * Same rules as chat moderation.
 */
function canModerateCall(user, streamId) {
    return canModerateStream(user, streamId);
}

/**
 * Can this user view chat logs?
 *
 * - admin / global_mod: all logs
 * - channel_mod: logs for their channels only (handled at route level)
 * - user: own logs only
 */
function canViewChatLogs(user, scope = 'own') {
    if (!user) return false;
    if (isGlobalModOrAbove(user)) return true;
    return scope === 'own';
}

/**
 * Can this user view another user's chat logs?
 */
function canViewOtherUserLogs(user) {
    return isGlobalModOrAbove(user);
}

/**
 * Can this user assign channel mods?
 *
 * Channel owner or admin.
 */
function canAssignChannelMods(user, channelId) {
    if (!user) return false;
    if (isAdmin(user)) return true;
    return isChannelOwner(user, channelId);
}

/**
 * Can this user manage their own stream/channel?
 */
function canManageOwnChannel(user) {
    return isStreamer(user);
}

/**
 * Can this user force-end any stream? (admin only)
 */
function canForceEndStreams(user) {
    return isAdmin(user);
}

// ── Capability map (returned to frontend via /api/auth/me) ───

/**
 * Build a capabilities object to send to the client.
 * The frontend gates UI based on this, never raw roles.
 */
function getCapabilities(user) {
    if (!user) {
        return {
            admin_panel: false,
            moderate_global: false,
            manage_users: false,
            manage_global_mods: false,
            manage_site_settings: false,
            manage_site_bans: false,
            review_cashouts: false,
            review_vpn: false,
            view_all_logs: false,
            manage_own_channel: false,
            force_end_streams: false,
        };
    }
    return {
        admin_panel: canAccessAdminPanel(user),
        moderate_global: isGlobalModOrAbove(user),
        manage_users: canManageUsers(user),
        manage_global_mods: canManageGlobalMods(user),
        manage_site_settings: canManageSiteSettings(user),
        manage_site_bans: canManageSiteBans(user),
        review_cashouts: canReviewCashouts(user),
        review_vpn: canReviewVpn(user),
        view_all_logs: canViewOtherUserLogs(user),
        manage_own_channel: canManageOwnChannel(user),
        force_end_streams: canForceEndStreams(user),
    };
}

// ── Express middleware factories ─────────────────────────────

/**
 * Middleware: require admin role.
 */
function requireAdmin(req, res, next) {
    if (!isAdmin(req.user)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

/**
 * Middleware: require global_mod or admin role.
 */
function requireGlobalMod(req, res, next) {
    if (!isGlobalModOrAbove(req.user)) {
        return res.status(403).json({ error: 'Moderator access required' });
    }
    next();
}

/**
 * Middleware: require streamer or above.
 */
function requireStreamer(req, res, next) {
    if (!isStreamer(req.user)) {
        return res.status(403).json({ error: 'Streamer access required' });
    }
    next();
}

module.exports = {
    // Role checks
    isAdmin,
    isGlobalMod,
    isGlobalModOrAbove,
    isStreamer,
    isChannelMod,
    isChannelOwner,
    isStreamOwner,
    roleRank,

    // Capability checks
    canAccessAdminPanel,
    canManageUsers,
    canManageGlobalMods,
    canManageSiteSettings,
    canReviewCashouts,
    canReviewVpn,
    canManageSiteBans,
    canModerateChannel,
    canModerateStream,
    canModerateCall,
    canViewChatLogs,
    canViewOtherUserLogs,
    canAssignChannelMods,
    canManageOwnChannel,
    canForceEndStreams,
    getCapabilities,

    // Middleware
    requireAdmin,
    requireGlobalMod,
    requireStreamer,
};
