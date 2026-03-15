const db = require('../db/database');

function isAdmin(user) {
    return !!user && user.role === 'admin';
}

function isGlobalMod(user) {
    return !!user && (user.role === 'mod' || user.role === 'global_mod');
}

function isStaff(user) {
    return isAdmin(user) || isGlobalMod(user);
}

function canStream(user) {
    return !!user && ['streamer', 'admin'].includes(user.role);
}

function getStaffRole(user) {
    if (isAdmin(user)) return 'admin';
    if (isGlobalMod(user)) return 'global_mod';
    return null;
}

function getOwnedChannel(user) {
    if (!user?.id) return null;
    return db.getChannelByUserId(user.id) || null;
}

function getModeratedChannels(user) {
    if (!user?.id) return [];
    return db.getChannelsByModerator(user.id) || [];
}

function canManageChannel(user, channelId) {
    if (!user?.id || !channelId) return false;
    if (isStaff(user)) return true;
    const channel = db.getChannelById(channelId);
    if (!channel) return false;
    return channel.user_id === user.id || db.isChannelModerator(channelId, user.id);
}

function canModerateStream(user, streamId) {
    if (!user?.id || !streamId) return false;
    if (isStaff(user)) return true;
    const stream = db.getStreamById(streamId);
    if (!stream) return false;
    if (stream.user_id === user.id) return true;
    const channel = stream.channel_id ? db.getChannelById(stream.channel_id) : db.getChannelByUserId(stream.user_id);
    return !!channel && db.isChannelModerator(channel.id, user.id);
}

function buildCapabilities(user) {
    if (!user) {
        return {
            is_authenticated: false,
            staff_role: null,
            can_access_staff_console: false,
            can_manage_users: false,
            can_manage_settings: false,
            can_manage_global_mods: false,
            can_manage_verification_keys: false,
            can_review_vpn_queue: false,
            can_view_site_stats: false,
            can_moderate_site_chat: false,
            can_manage_canvas: false,
            can_manage_canvas_settings: false,
            can_manage_channels: false,
            owned_channel_id: null,
            moderated_channel_ids: [],
        };
    }

    const ownedChannel = getOwnedChannel(user);
    const moderatedChannels = getModeratedChannels(user);
    const isAdminUser = isAdmin(user);
    const isGlobalModUser = isGlobalMod(user);
    const staffRole = getStaffRole(user);

    return {
        is_authenticated: true,
        staff_role: staffRole,
        is_admin: isAdminUser,
        is_global_mod: isGlobalModUser,
        can_access_staff_console: !!staffRole,
        can_manage_users: isAdminUser,
        can_manage_settings: isAdminUser,
        can_manage_global_mods: isAdminUser,
        can_manage_verification_keys: isAdminUser,
        can_review_vpn_queue: isAdminUser,
        can_view_site_stats: !!staffRole,
        can_moderate_site_chat: !!staffRole,
        can_manage_canvas: !!staffRole,
        can_manage_canvas_settings: isAdminUser,
        can_manage_channels: !!ownedChannel || moderatedChannels.length > 0 || !!staffRole,
        owned_channel_id: ownedChannel?.id || null,
        moderated_channel_ids: moderatedChannels.map((channel) => channel.id),
    };
}

module.exports = {
    isAdmin,
    isGlobalMod,
    isStaff,
    canStream,
    canManageChannel,
    canModerateStream,
    buildCapabilities,
    getStaffRole,
};
