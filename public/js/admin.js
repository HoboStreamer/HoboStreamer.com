/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Admin Panel
   ═══════════════════════════════════════════════════════════════ */

let currentAdminTab = 'users';

/**
 * Load admin panel.
 */
async function loadAdmin() {
    if (!currentUser || currentUser.role !== 'admin') {
        toast('Admin access required', 'error');
        return navigate('home');
    }

    await loadAdminStats();
    switchAdminTab('users');
}

/* ── Stats ─────────────────────────────────────────────────────── */
async function loadAdminStats() {
    const container = document.getElementById('admin-stats');
    try {
        const data = await api('/admin/stats');
        const s = data.stats || data;
        container.innerHTML = [
            { label: 'Total Users', value: s.totalUsers || s.users?.total || 0, icon: 'fa-users' },
            { label: 'Active Streams', value: s.activeStreams || s.streams?.live || 0, icon: 'fa-broadcast-tower' },
            { label: 'Total Streams', value: s.totalStreams || s.streams?.total || 0, icon: 'fa-video' },
            { label: 'Hobo Bucks in Circulation', value: s.totalFunds || s.hoboBucks?.totalCirculating || 0, icon: 'fa-coins' },
            { label: 'Pending Cashouts', value: s.pendingCashouts || s.hoboBucks?.pendingCashouts || 0, icon: 'fa-money-bill-transfer' },
            { label: 'Active Bans', value: s.activeBans || s.users?.banned || 0, icon: 'fa-ban' },
        ].map(stat => `
            <div class="admin-stat">
                <div class="admin-stat-value">${typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}</div>
                <div class="admin-stat-label"><i class="fa-solid ${stat.icon}"></i> ${stat.label}</div>
            </div>
        `).join('');
    } catch (e) {
        container.innerHTML = '<p class="muted">Failed to load stats</p>';
    }
}

/* ── Tab switching ─────────────────────────────────────────────── */
function switchAdminTab(tab) {
    currentAdminTab = tab;
    document.querySelectorAll('.admin-tabs .tab-btn').forEach(b =>
        b.classList.toggle('active', b.getAttribute('onclick')?.includes(`'${tab}'`))
    );

    switch (tab) {
        case 'users': loadAdminUsers(); break;
        case 'moderators': loadAdminModerators(); break;
        case 'chat-logs': loadAdminChatLogs(); break;
        case 'settings': loadAdminSettings(); break;
        case 'verification': loadAdminVerificationKeys(); break;
        case 'streams': loadAdminStreams(); break;
        case 'cashouts': loadAdminCashouts(); break;
        case 'bans': loadAdminBans(); break;
        case 'vpn': loadAdminVPN(); break;
    }
}

/* ── Chat Logs (Admin) ─────────────────────────────────────────── */
let adminLogsOffset = 0;
let adminLogsQuery = '';
let adminLogsUserId = '';

async function loadAdminChatLogs() {
    const c = document.getElementById('admin-content');
    c.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
            <input type="text" id="admin-log-search" placeholder="Search messages..."
                value="${esc(adminLogsQuery)}"
                onkeydown="if(event.key==='Enter')adminSearchLogs()"
                style="flex:1;min-width:200px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
            <input type="text" id="admin-log-userid" placeholder="User ID (optional)"
                value="${esc(adminLogsUserId)}"
                onkeydown="if(event.key==='Enter')adminSearchLogs()"
                style="width:140px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
            <button class="btn btn-primary" onclick="adminSearchLogs()">
                <i class="fa-solid fa-search"></i> Search
            </button>
        </div>
        <div id="admin-logs-results"><p class="muted">Enter a search query or user ID</p></div>
        <div id="admin-logs-pager" style="display:flex;gap:8px;align-items:center;justify-content:center;margin-top:12px"></div>
    `;
}

async function adminSearchLogs() {
    const q = document.getElementById('admin-log-search')?.value?.trim() || '';
    const uid = document.getElementById('admin-log-userid')?.value?.trim() || '';
    adminLogsQuery = q;
    adminLogsUserId = uid;
    adminLogsOffset = 0;
    await fetchAdminLogs();
}

async function fetchAdminLogs() {
    const results = document.getElementById('admin-logs-results');
    const pager = document.getElementById('admin-logs-pager');
    if (!results) return;
    results.innerHTML = '<p class="muted">Loading...</p>';

    try {
        const params = new URLSearchParams({ limit: '50', offset: String(adminLogsOffset) });
        if (adminLogsQuery) params.set('q', adminLogsQuery);
        if (adminLogsUserId) params.set('user_id', adminLogsUserId);

        const data = await api(`/chat/search?${params}`);
        const msgs = data.messages || [];
        const total = data.total || 0;

        if (!msgs.length) {
            results.innerHTML = '<p class="muted">No messages found</p>';
            if (pager) pager.innerHTML = '';
            return;
        }

        results.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>Time</th><th>User</th><th>Message</th><th>Stream</th>
                </tr></thead>
                <tbody>${msgs.map(m => {
                    const ts = m.timestamp ? new Date(m.timestamp.replace(' ', 'T') + (m.timestamp.includes('Z') ? '' : 'Z')).toLocaleString() : '';
                    return `<tr>
                        <td style="white-space:nowrap;font-size:0.8rem">${ts}</td>
                        <td style="white-space:nowrap">
                            <span style="color:${m.profile_color || '#999'};cursor:pointer" onclick="showChatContextMenu(event)" data-username="${esc(m.display_name || m.username || 'anon')}" data-user-id="${m.user_id || ''}">${esc(m.display_name || m.username || 'anon')}</span>
                        </td>
                        <td style="word-break:break-word">${esc(m.message)}</td>
                        <td style="font-size:0.8rem">${m.stream_id || '-'}</td>
                    </tr>`;
                }).join('')}</tbody>
            </table>`;

        // Pagination
        const pages = Math.ceil(total / 50);
        const curPage = Math.floor(adminLogsOffset / 50) + 1;
        if (pager) {
            pager.innerHTML = pages > 1 ? `
                <button class="btn btn-sm" ${adminLogsOffset <= 0 ? 'disabled' : ''} onclick="adminLogsOffset=Math.max(0,adminLogsOffset-50);fetchAdminLogs()"><i class="fa-solid fa-chevron-left"></i></button>
                <span class="muted" style="font-size:0.85rem">Page ${curPage} / ${pages} (${total} results)</span>
                <button class="btn btn-sm" ${curPage >= pages ? 'disabled' : ''} onclick="adminLogsOffset+=50;fetchAdminLogs()"><i class="fa-solid fa-chevron-right"></i></button>
            ` : `<span class="muted" style="font-size:0.85rem">${total} results</span>`;
        }
    } catch (e) {
        results.innerHTML = `<p class="muted">Error: ${e.message}</p>`;
        if (pager) pager.innerHTML = '';
    }
}

/* ── Users ─────────────────────────────────────────────────────── */
async function loadAdminUsers() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/users');
        const users = data.users || [];
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>Username</th><th>Email</th><th>Role</th><th>Created</th><th>Actions</th>
                </tr></thead>
                <tbody>${users.map(u => `
                    <tr>
                        <td>${esc(u.username)}</td>
                        <td>${esc(u.email || '-')}</td>
                        <td>${esc(u.role)}</td>
                        <td>${new Date(u.created_at).toLocaleDateString()}</td>
                        <td>
                            <select onchange="changeUserRole('${u.id}', this.value)" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:2px 4px;border-radius:4px">
                                ${['user','streamer','mod','admin'].map(r =>
                                    `<option value="${r}" ${r===u.role?'selected':''}>${r}</option>`
                                ).join('')}
                            </select>
                            <button class="btn btn-small btn-danger" onclick="banUser('${u.id}', '${esc(u.username)}')" title="Ban">
                                <i class="fa-solid fa-ban"></i>
                            </button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${e.message}</p>`; }
}

async function changeUserRole(userId, role) {
    try {
        await api(`/admin/users/${userId}`, { method: 'PUT', body: { role } });
        toast(`Role updated to ${role}`, 'success');
    } catch (e) { toast(e.message, 'error'); loadAdminUsers(); }
}

async function banUser(userId, username) {
    const reason = prompt(`Ban ${username}? Enter reason:`);
    if (reason === null) return;
    try {
        await api(`/admin/users/${userId}/ban`, { method: 'POST', body: { reason, duration: 0 } });
        toast(`${username} banned`, 'success');
        loadAdminUsers();
        loadAdminStats();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Moderators ───────────────────────────────────────────────── */
async function loadAdminModerators() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/moderators');
        const mods = data.moderators || [];
        c.innerHTML = `
            <div class="admin-section-header" style="display:flex;gap:8px;margin-bottom:16px;align-items:center">
                <input type="text" id="mod-username-input" placeholder="Username to promote..."
                    style="flex:1;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
                <button class="btn btn-primary" onclick="promoteModerator()">
                    <i class="fa-solid fa-shield-halved"></i> Promote to Mod
                </button>
            </div>
            ${mods.length ? `
                <table class="admin-table">
                    <thead><tr>
                        <th>Username</th><th>Display Name</th><th>Last Seen</th><th>Actions</th>
                    </tr></thead>
                    <tbody>${mods.map(m => `
                        <tr>
                            <td>${esc(m.username)}</td>
                            <td>${esc(m.display_name || m.username)}</td>
                            <td>${m.last_seen ? new Date(m.last_seen).toLocaleString() : 'Never'}</td>
                            <td>
                                <button class="btn btn-small btn-danger" onclick="demoteModerator('${m.id}', '${esc(m.username)}')">
                                    <i class="fa-solid fa-user-minus"></i> Demote
                                </button>
                            </td>
                        </tr>
                    `).join('')}</tbody>
                </table>
            ` : '<p class="muted">No global moderators yet</p>'}`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${e.message}</p>`; }
}

async function promoteModerator() {
    const input = document.getElementById('mod-username-input');
    const username = input?.value.trim();
    if (!username) return toast('Enter a username', 'error');
    try {
        await api('/admin/moderators', { method: 'POST', body: { username } });
        toast(`${username} promoted to moderator`, 'success');
        loadAdminModerators();
    } catch (e) { toast(e.message, 'error'); }
}

async function demoteModerator(id, username) {
    if (!confirm(`Demote ${username} from moderator?`)) return;
    try {
        await api(`/admin/moderators/${id}`, { method: 'DELETE' });
        toast(`${username} demoted`, 'success');
        loadAdminModerators();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Site Settings ────────────────────────────────────────────── */
async function loadAdminSettings() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/settings');
        const settings = data.settings || [];

        c.innerHTML = `
            <form id="admin-settings-form" onsubmit="saveAdminSettings(event)" style="display:grid;gap:12px;max-width:700px">
                ${settings.map(s => {
                    const id = `setting-${s.key}`;
                    if (s.type === 'boolean') {
                        return `
                            <div class="setting-row" style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)">
                                <label style="flex:1;cursor:pointer" for="${id}">
                                    <strong>${esc(s.key)}</strong>
                                    <br><small class="muted">${esc(s.description || '')}</small>
                                </label>
                                <input type="checkbox" id="${id}" data-key="${esc(s.key)}" data-type="boolean"
                                    ${s.value === 'true' ? 'checked' : ''}
                                    style="width:18px;height:18px;cursor:pointer">
                            </div>`;
                    }
                    if (s.type === 'number') {
                        return `
                            <div class="setting-row" style="padding:8px 0;border-bottom:1px solid var(--border)">
                                <label for="${id}">
                                    <strong>${esc(s.key)}</strong>
                                    <br><small class="muted">${esc(s.description || '')}</small>
                                </label>
                                <input type="number" id="${id}" data-key="${esc(s.key)}" data-type="number"
                                    value="${esc(s.value)}"
                                    style="margin-top:4px;width:200px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                            </div>`;
                    }
                    return `
                        <div class="setting-row" style="padding:8px 0;border-bottom:1px solid var(--border)">
                            <label for="${id}">
                                <strong>${esc(s.key)}</strong>
                                <br><small class="muted">${esc(s.description || '')}</small>
                            </label>
                            <input type="text" id="${id}" data-key="${esc(s.key)}" data-type="string"
                                value="${esc(s.value)}"
                                style="margin-top:4px;width:100%;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                        </div>`;
                }).join('')}
                <button type="submit" class="btn btn-primary" style="justify-self:start;margin-top:8px">
                    <i class="fa-solid fa-floppy-disk"></i> Save Settings
                </button>
            </form>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${e.message}</p>`; }
}

async function saveAdminSettings(e) {
    e.preventDefault();
    const inputs = document.querySelectorAll('#admin-settings-form [data-key]');
    const settings = {};
    inputs.forEach(input => {
        const key = input.dataset.key;
        if (input.dataset.type === 'boolean') {
            settings[key] = input.checked ? 'true' : 'false';
        } else {
            settings[key] = input.value;
        }
    });
    try {
        await api('/admin/settings', { method: 'PUT', body: { settings } });
        toast('Settings saved', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Verification Keys ────────────────────────────────────────── */
async function loadAdminVerificationKeys() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/verification-keys');
        const keys = data.keys || [];
        c.innerHTML = `
            <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap">
                <input type="text" id="vkey-username-input" placeholder="RS-Companion username to reserve..."
                    style="flex:1;min-width:200px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
                <input type="text" id="vkey-note-input" placeholder="Note (optional)"
                    style="flex:1;min-width:150px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
                <button class="btn btn-primary" onclick="generateVerificationKey()">
                    <i class="fa-solid fa-key"></i> Generate Key
                </button>
            </div>
            ${keys.length ? `
                <table class="admin-table">
                    <thead><tr>
                        <th>Key</th><th>Reserved Username</th><th>Status</th><th>Note</th><th>Created</th><th>Actions</th>
                    </tr></thead>
                    <tbody>${keys.map(k => `
                        <tr>
                            <td><code style="background:var(--bg-input);padding:2px 6px;border-radius:4px;font-size:12px;user-select:all">${esc(k.key)}</code></td>
                            <td><strong>${esc(k.target_username)}</strong></td>
                            <td><span class="badge badge-${k.status === 'active' ? 'success' : k.status === 'used' ? 'info' : 'danger'}">${esc(k.status)}</span></td>
                            <td>${esc(k.note || '-')}</td>
                            <td>${new Date(k.created_at).toLocaleDateString()}</td>
                            <td>
                                ${k.status === 'active' ? `
                                    <button class="btn btn-small btn-outline" onclick="copyVerificationKey('${esc(k.key)}')" title="Copy key">
                                        <i class="fa-solid fa-copy"></i>
                                    </button>
                                    <button class="btn btn-small btn-danger" onclick="revokeVerificationKey('${k.id}')" title="Revoke">
                                        <i class="fa-solid fa-trash"></i>
                                    </button>
                                ` : k.status === 'used' ? `<span class="muted">Used by ${esc(k.used_by_name || '?')}</span>` : '<span class="muted">Revoked</span>'}
                            </td>
                        </tr>
                    `).join('')}</tbody>
                </table>
            ` : '<p class="muted">No verification keys generated yet</p>'}`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${e.message}</p>`; }
}

async function generateVerificationKey() {
    const usernameInput = document.getElementById('vkey-username-input');
    const noteInput = document.getElementById('vkey-note-input');
    const target_username = usernameInput?.value.trim();
    const note = noteInput?.value.trim();
    if (!target_username) return toast('Enter a username to reserve', 'error');
    try {
        const data = await api('/admin/verification-keys', {
            method: 'POST',
            body: { target_username, note }
        });
        const key = data.key;
        toast(`Key generated: ${key.key}`, 'success');
        usernameInput.value = '';
        noteInput.value = '';
        loadAdminVerificationKeys();
    } catch (e) { toast(e.message, 'error'); }
}

async function copyVerificationKey(key) {
    try {
        await navigator.clipboard.writeText(key);
        toast('Key copied to clipboard', 'success');
    } catch {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = key;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('Key copied', 'success');
    }
}

async function revokeVerificationKey(id) {
    if (!confirm('Revoke this verification key?')) return;
    try {
        await api(`/admin/verification-keys/${id}`, { method: 'DELETE' });
        toast('Key revoked', 'success');
        loadAdminVerificationKeys();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Streams ──────────────────────────────────────────────────── */
async function loadAdminStreams() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/streams');
        const streams = data.streams || [];
        if (!streams.length) { c.innerHTML = '<p class="muted">No active streams</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>Title</th><th>Streamer</th><th>Protocol</th><th>Viewers</th><th>Started</th><th>Actions</th>
                </tr></thead>
                <tbody>${streams.map(s => `
                    <tr>
                        <td>${esc(s.title || 'Untitled')}</td>
                        <td>${esc(s.username || '-')}</td>
                        <td>${esc(s.protocol)}</td>
                        <td>${s.viewer_count || 0}</td>
                        <td>${new Date(s.started_at).toLocaleString()}</td>
                        <td>
                            <button class="btn btn-small btn-danger" onclick="forceEndStream('${s.id}')">
                                <i class="fa-solid fa-stop"></i> End
                            </button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${e.message}</p>`; }
}

async function forceEndStream(streamId) {
    if (!confirm('Force end this stream?')) return;
    try {
        await api(`/admin/streams/${streamId}`, { method: 'DELETE' });
        toast('Stream ended', 'success');
        loadAdminStreams();
        loadAdminStats();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Cashouts ─────────────────────────────────────────────────── */
async function loadAdminCashouts() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/funds/cashouts/pending');
        const cashouts = data.cashouts || [];
        if (!cashouts.length) { c.innerHTML = '<p class="muted">No pending cashouts</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>User</th><th>Amount</th><th>USD</th><th>PayPal</th><th>Requested</th><th>Actions</th>
                </tr></thead>
                <tbody>${cashouts.map(co => `
                    <tr>
                        <td>${esc(co.username || '-')}</td>
                        <td>${co.amount} CF</td>
                        <td>$${(co.amount * 0.01).toFixed(2)}</td>
                        <td>${esc(co.paypal_email || '-')}</td>
                        <td>${new Date(co.created_at).toLocaleString()}</td>
                        <td>
                            <button class="btn btn-small btn-success" onclick="approveCashout('${co.id}')">
                                <i class="fa-solid fa-check"></i>
                            </button>
                            <button class="btn btn-small btn-danger" onclick="denyCashout('${co.id}')">
                                <i class="fa-solid fa-times"></i>
                            </button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${e.message}</p>`; }
}

async function approveCashout(cashoutId) {
    try {
        await api(`/funds/cashout/${cashoutId}/approve`, { method: 'POST' });
        toast('Cashout approved', 'success');
        loadAdminCashouts();
    } catch (e) { toast(e.message, 'error'); }
}

async function denyCashout(cashoutId) {
    const reason = prompt('Denial reason:');
    if (reason === null) return;
    try {
        await api(`/funds/cashout/${cashoutId}/deny`, { method: 'POST', body: { reason } });
        toast('Cashout denied & refunded', 'info');
        loadAdminCashouts();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Bans ──────────────────────────────────────────────────────── */
async function loadAdminBans() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/bans');
        const bans = data.bans || [];
        if (!bans.length) { c.innerHTML = '<p class="muted">No active bans</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>User</th><th>Reason</th><th>Banned At</th><th>Expires</th><th>Actions</th>
                </tr></thead>
                <tbody>${bans.map(b => `
                    <tr>
                        <td>${esc(b.username || b.user_id)}</td>
                        <td>${esc(b.reason || '-')}</td>
                        <td>${new Date(b.created_at).toLocaleString()}</td>
                        <td>${b.expires_at ? new Date(b.expires_at).toLocaleString() : 'Permanent'}</td>
                        <td>
                            <button class="btn btn-small btn-outline" onclick="unbanUser('${b.user_id}')">
                                <i class="fa-solid fa-user-check"></i> Unban
                            </button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${e.message}</p>`; }
}

async function unbanUser(userId) {
    try {
        await api(`/admin/users/${userId}/ban`, { method: 'DELETE' });
        toast('User unbanned', 'success');
        loadAdminBans();
        loadAdminStats();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── VPN Queue ────────────────────────────────────────────────── */
async function loadAdminVPN() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/vpn-queue');
        const queue = data.queue || [];
        if (!queue.length) { c.innerHTML = '<p class="muted">VPN approval queue empty</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>User</th><th>IP</th><th>Reason</th><th>Status</th><th>Actions</th>
                </tr></thead>
                <tbody>${queue.map(q => `
                    <tr>
                        <td>${esc(q.username || q.user_id)}</td>
                        <td>${esc(q.ip_address || '-')}</td>
                        <td>${esc(q.reason || '-')}</td>
                        <td>${esc(q.status)}</td>
                        <td>
                            ${q.status === 'pending' ? `
                                <button class="btn btn-small btn-success" onclick="approveVPN('${q.id}')">
                                    <i class="fa-solid fa-check"></i>
                                </button>
                                <button class="btn btn-small btn-danger" onclick="denyVPN('${q.id}')">
                                    <i class="fa-solid fa-times"></i>
                                </button>
                            ` : esc(q.status)}
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${e.message}</p>`; }
}

async function approveVPN(id) {
    try {
        await api(`/admin/vpn-queue/${id}`, { method: 'PUT', body: { status: 'approved' } });
        toast('VPN approved', 'success');
        loadAdminVPN();
    } catch (e) { toast(e.message, 'error'); }
}

async function denyVPN(id) {
    try {
        await api(`/admin/vpn-queue/${id}`, { method: 'PUT', body: { status: 'denied' } });
        toast('VPN denied', 'info');
        loadAdminVPN();
    } catch (e) { toast(e.message, 'error'); }
}
