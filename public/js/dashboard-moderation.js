const originalLoadDashboard = window.loadDashboard;
let dashModerationChannels = [];

function ensureDashModerationCard() {
    const grid = document.querySelector('#page-dashboard .dash-grid');
    if (!grid) return null;

    let card = document.getElementById('dash-moderation-card');
    if (!card) {
        card = document.createElement('div');
        card.id = 'dash-moderation-card';
        card.className = 'dash-card dash-card-wide';
        card.innerHTML = `
            <h3><i class="fa-solid fa-shield-halved"></i> Channel Moderation</h3>
            <p class="muted">Owner and channel-mod tools for managing chat, moderators, and logs.</p>
            <div id="dash-moderation-body"><p class="muted">Loading moderation tools...</p></div>
        `;
        grid.appendChild(card);
    }

    return document.getElementById('dash-moderation-body');
}

function dashModerationTitle(channel) {
    return channel.title || channel.display_name || channel.username || `Channel #${channel.id}`;
}

function dashModerationRole(channel) {
    if (channel.user_id === currentUser?.id) return 'Owner';
    return 'Moderator';
}

function dashFormatModerationDate(value) {
    if (!value) return '-';
    const normalized = value.includes('T') || value.endsWith('Z')
        ? value
        : value.replace(' ', 'T') + 'Z';
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function dashSummarizeModerationAction(action) {
    const details = action.details || {};
    const parts = [];
    if (details.reason) parts.push(details.reason);
    if (details.username) parts.push(`user ${details.username}`);
    if (details.stream_id) parts.push(`stream #${details.stream_id}`);
    if (details.count) parts.push(`${details.count} items`);
    return parts.join(' - ') || 'No details';
}

function renderDashModerationChannels(channels) {
    const body = ensureDashModerationCard();
    if (!body) return;

    if (!channels.length) {
        body.innerHTML = '<p class="muted">You do not have channel moderation assignments yet.</p>';
        return;
    }

    body.innerHTML = channels.map((channel) => {
        const settings = channel.moderation_settings || {};
        const moderators = channel.moderators || [];
        return `
            <section class="dash-mod-channel">
                <div class="dash-mod-header">
                    <div>
                        <h4>${esc(dashModerationTitle(channel))}</h4>
                        <p class="muted">${esc(dashModerationRole(channel))} access for channel #${channel.id}</p>
                    </div>
                </div>

                <div class="dash-mod-grid">
                    <div class="dash-mod-section">
                        <h5><i class="fa-solid fa-user-shield"></i> Moderators</h5>
                        <div class="staff-toolbar">
                            <input type="text" id="dash-mod-add-${channel.id}" class="form-input" placeholder="Username to add">
                            <button class="btn btn-outline" onclick="dashAddChannelModerator(${channel.id})"><i class="fa-solid fa-plus"></i> Add</button>
                        </div>
                        <div class="dash-mod-list">
                            ${moderators.length ? moderators.map((moderator) => `
                                <div class="dash-mod-list-row">
                                    <div>
                                        <strong>${esc(moderator.display_name || moderator.username)}</strong>
                                        <div class="muted">@${esc(moderator.username)}</div>
                                    </div>
                                    <button class="btn btn-small" onclick="dashRemoveChannelModerator(${channel.id}, ${moderator.id}, '${esc(moderator.username)}')">
                                        <i class="fa-solid fa-user-minus"></i> Remove
                                    </button>
                                </div>
                            `).join('') : '<p class="muted">No channel moderators yet.</p>'}
                        </div>
                    </div>

                    <div class="dash-mod-section">
                        <h5><i class="fa-solid fa-sliders"></i> Chat Settings</h5>
                        <div class="dash-mod-settings">
                            <label><span>Slowmode Seconds</span><input type="number" id="dash-mod-slow-${channel.id}" class="form-input" value="${Number(settings.slowmode_seconds || 0)}"></label>
                            <label><span>Max Message Length</span><input type="number" id="dash-mod-maxlen-${channel.id}" class="form-input" value="${Number(settings.max_message_length || 500)}"></label>
                            <label><span>Account Age Gate (hours)</span><input type="number" id="dash-mod-age-${channel.id}" class="form-input" value="${Number(settings.account_age_gate_hours || 0)}"></label>
                            <label><span>Caps Limit (%)</span><input type="number" id="dash-mod-caps-${channel.id}" class="form-input" value="${Number(settings.caps_percentage_limit || 70)}"></label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-anon-${channel.id}" ${settings.allow_anonymous !== false ? 'checked' : ''}> Allow Anonymous</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-links-${channel.id}" ${settings.links_allowed !== false ? 'checked' : ''}> Allow Links</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-filter-${channel.id}" ${settings.aggressive_filter ? 'checked' : ''}> Aggressive Filter</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-followers-${channel.id}" ${settings.followers_only ? 'checked' : ''}> Followers Only</label>
                        </div>
                        <button class="btn btn-primary" onclick="dashSaveChannelModerationSettings(${channel.id})"><i class="fa-solid fa-floppy-disk"></i> Save Settings</button>
                    </div>
                </div>

                <div class="dash-mod-grid">
                    <div class="dash-mod-section">
                        <h5><i class="fa-solid fa-clipboard-list"></i> Recent Actions</h5>
                        <div id="dash-mod-logs-${channel.id}" class="dash-mod-log-list"><p class="muted">Loading moderation log...</p></div>
                    </div>

                    <div class="dash-mod-section">
                        <h5><i class="fa-solid fa-comments"></i> Search Channel Chat</h5>
                        <div class="staff-toolbar">
                            <input type="text" id="dash-mod-search-${channel.id}" class="form-input" placeholder="Search messages..." onkeydown="if(event.key==='Enter')dashSearchChannelChat(${channel.id})">
                            <input type="text" id="dash-mod-search-user-${channel.id}" class="form-input staff-toolbar-small" placeholder="User ID" onkeydown="if(event.key==='Enter')dashSearchChannelChat(${channel.id})">
                            <button class="btn btn-outline" onclick="dashSearchChannelChat(${channel.id})"><i class="fa-solid fa-search"></i> Search</button>
                        </div>
                        <div id="dash-mod-search-results-${channel.id}" class="dash-mod-search-results"><p class="muted">Search this channel's chat history.</p></div>
                    </div>
                </div>
            </section>
        `;
    }).join('');

    channels.forEach((channel) => {
        dashLoadChannelModerationLogs(channel.id);
    });
}

async function loadDashModeration() {
    const body = ensureDashModerationCard();
    if (!body) return;

    if (!currentUser || !hasCapability('can_manage_channels')) {
        body.innerHTML = '<p class="muted">Channel moderation tools appear here for owners and channel mods.</p>';
        return;
    }

    body.innerHTML = '<p class="muted">Loading moderation tools...</p>';

    try {
        const data = await api('/channels/moderation/mine');
        dashModerationChannels = data.channels || [];
        renderDashModerationChannels(dashModerationChannels);
    } catch (err) {
        body.innerHTML = `<p class="muted">Failed to load channel moderation tools: ${esc(err.message || 'Unknown error')}</p>`;
    }
}

async function dashReloadModeration() {
    await loadDashModeration();
}

async function dashLoadChannelModerationLogs(channelId) {
    const target = document.getElementById(`dash-mod-logs-${channelId}`);
    if (!target) return;

    try {
        const data = await api(`/channels/${channelId}/moderation/logs?limit=12`);
        const actions = data.actions || [];
        target.innerHTML = actions.length ? actions.map((action) => `
            <div class="dash-mod-log-entry">
                <strong>${esc(action.action_type || 'action')}</strong>
                <span class="muted">${dashFormatModerationDate(action.created_at)}</span>
                <div class="muted">${esc(dashSummarizeModerationAction(action))}</div>
            </div>
        `).join('') : '<p class="muted">No channel moderation actions yet.</p>';
    } catch (err) {
        target.innerHTML = '<p class="muted">Failed to load channel log.</p>';
    }
}

window.dashAddChannelModerator = async function dashAddChannelModerator(channelId) {
    const input = document.getElementById(`dash-mod-add-${channelId}`);
    const username = input?.value?.trim();
    if (!username) return toast('Enter a username to add.', 'error');

    try {
        await api(`/channels/${channelId}/moderators`, {
            method: 'POST',
            body: { username },
        });
        toast(`${username} added as a channel moderator`, 'success');
        await dashReloadModeration();
    } catch (err) {
        toast(err.message || 'Failed to add moderator', 'error');
    }
};

window.dashRemoveChannelModerator = async function dashRemoveChannelModerator(channelId, userId, username) {
    if (!confirm(`Remove ${username} as a channel moderator?`)) return;

    try {
        await api(`/channels/${channelId}/moderators/${userId}`, { method: 'DELETE' });
        toast(`${username} removed`, 'success');
        await dashReloadModeration();
    } catch (err) {
        toast(err.message || 'Failed to remove moderator', 'error');
    }
};

window.dashSaveChannelModerationSettings = async function dashSaveChannelModerationSettings(channelId) {
    try {
        await api(`/channels/${channelId}/moderation/settings`, {
            method: 'PUT',
            body: {
                slowmode_seconds: Number(document.getElementById(`dash-mod-slow-${channelId}`)?.value || 0),
                max_message_length: Number(document.getElementById(`dash-mod-maxlen-${channelId}`)?.value || 500),
                account_age_gate_hours: Number(document.getElementById(`dash-mod-age-${channelId}`)?.value || 0),
                caps_percentage_limit: Number(document.getElementById(`dash-mod-caps-${channelId}`)?.value || 70),
                allow_anonymous: !!document.getElementById(`dash-mod-anon-${channelId}`)?.checked,
                links_allowed: !!document.getElementById(`dash-mod-links-${channelId}`)?.checked,
                aggressive_filter: !!document.getElementById(`dash-mod-filter-${channelId}`)?.checked,
                followers_only: !!document.getElementById(`dash-mod-followers-${channelId}`)?.checked,
            },
        });
        toast('Channel moderation settings saved', 'success');
        await dashReloadModeration();
    } catch (err) {
        toast(err.message || 'Failed to save moderation settings', 'error');
    }
};

window.dashSearchChannelChat = async function dashSearchChannelChat(channelId) {
    const resultTarget = document.getElementById(`dash-mod-search-results-${channelId}`);
    if (!resultTarget) return;

    resultTarget.innerHTML = '<p class="muted">Searching channel chat...</p>';

    try {
        const params = new URLSearchParams({ limit: '20' });
        const query = document.getElementById(`dash-mod-search-${channelId}`)?.value?.trim();
        const userId = document.getElementById(`dash-mod-search-user-${channelId}`)?.value?.trim();
        if (query) params.set('q', query);
        if (userId) params.set('user_id', userId);

        const data = await api(`/channels/${channelId}/moderation/chat-search?${params}`);
        const messages = data.messages || [];

        resultTarget.innerHTML = messages.length ? messages.map((message) => `
            <div class="dash-mod-log-entry">
                <strong>${esc(message.display_name || message.username || 'Anonymous')}</strong>
                <span class="muted">${dashFormatModerationDate(message.timestamp)}</span>
                <div>${esc(message.message || '')}</div>
                <button class="btn btn-small" onclick="dashDeleteChannelMessage(${channelId}, ${message.id || message.message_id})">
                    <i class="fa-solid fa-trash"></i> Delete Message
                </button>
            </div>
        `).join('') : '<p class="muted">No channel messages matched.</p>';
    } catch (err) {
        resultTarget.innerHTML = `<p class="muted">Search failed: ${esc(err.message || 'Unknown error')}</p>`;
    }
};

window.dashDeleteChannelMessage = async function dashDeleteChannelMessage(channelId, messageId) {
    if (!confirm('Delete this chat message?')) return;

    try {
        await api(`/channels/${channelId}/moderation/messages/${messageId}/delete`, { method: 'POST' });
        toast('Message deleted', 'success');
        await dashLoadChannelModerationLogs(channelId);
        await window.dashSearchChannelChat(channelId);
    } catch (err) {
        toast(err.message || 'Failed to delete message', 'error');
    }
};

window.loadDashboard = async function loadDashboardWithModeration() {
    if (typeof originalLoadDashboard === 'function') {
        await originalLoadDashboard();
    }
    await loadDashModeration();
};

loadDashboard = window.loadDashboard;
