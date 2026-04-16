/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Dashboard (Streamer Panel)
   ═══════════════════════════════════════════════════════════════ */

let activeStreamData = null;
let activeStreams = [];

/**
 * Load the dashboard page.
 */
async function loadDashboard() {
    if (!currentUser) {
        toast('Login required', 'error');
        return navigate('/');
    }

    updateDashObsOverlayUrl();

    // Load channel info
    loadDashChannel();
    // Load stream key
    loadDashStreamKey();
    // Load goals
    loadDashGoals();
    // Load VODs
    loadDashVods();
    // Load funds
    loadDashFunds();
    // Load active streams list
    loadDashActiveStreams();
    // Load controls
    loadDashControls();
    // Load control configs
    loadDashConfigs();
    // Load custom emotes
    if (typeof loadDashEmotes === 'function') loadDashEmotes();
    // Load clips
    loadDashMyClips();
    loadDashStreamClips();
    // Load Hobo Coins
    loadDashCoins();
    // Load coin rewards
    if (typeof loadDashRewards === 'function') loadDashRewards();
    // Load redemption queue
    if (typeof loadDashRedemptions === 'function') loadDashRedemptions();
}

/* ── Channel Info ──────────────────────────────────────────────── */
async function loadDashChannel() {
    // No-op: stream creation is handled by the Broadcast page
}

/* ── Stream Key ───────────────────────────────────────────────── */
async function loadDashStreamKey() {
    try {
        const data = await api('/auth/stream-key');
        const key = data.streamKey || data.stream_key || '';
        document.getElementById('dash-stream-key').value = key;
    } catch { /* silent */ }
}

function toggleKeyVisibility() {
    const el = document.getElementById('dash-stream-key');
    el.type = el.type === 'password' ? 'text' : 'password';
}

function copyStreamKey() {
    const key = document.getElementById('dash-stream-key').value;
    if (!key) return toast('No stream key', 'error');
    navigator.clipboard.writeText(key).then(() => toast('Stream key copied!', 'success'));
}

function getDashObsOverlayUrl() {
    if (!currentUser?.username) return '';
    return `${window.location.origin}/obs/chat/${encodeURIComponent(currentUser.username)}`;
}

function updateDashObsOverlayUrl() {
    const input = document.getElementById('dash-obs-chat-overlay-url');
    if (!input) return;
    input.value = getDashObsOverlayUrl();
}

function copyDashObsOverlayUrl() {
    const url = getDashObsOverlayUrl();
    if (!url) return toast('Overlay URL unavailable', 'error');
    navigator.clipboard.writeText(url).then(() => toast('Overlay URL copied!', 'success'));
}

function openDashObsOverlay() {
    const url = getDashObsOverlayUrl();
    if (!url) return toast('Overlay URL unavailable', 'error');
    window.open(url, '_blank', 'noopener');
}

async function regenerateStreamKey() {
    if (!confirm('Are you sure? Your old key will stop working.')) return;
    try {
        const data = await api('/auth/stream-key/regenerate', { method: 'POST' });
        const key = data.streamKey || data.stream_key || '';
        document.getElementById('dash-stream-key').value = key;
        toast('Stream key regenerated', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Go Live / End Stream ─────────────────────────────────────── */
// Stream creation is handled by the Broadcast page (/broadcast).
// goLive() has been removed — use broadcast.js instead.

async function loadDashActiveStreams() {
    const listEl = document.getElementById('dash-active-streams');
    if (!listEl) return;
    try {
        const data = await api('/streams/mine');
        const all = data.streams || [];
        activeStreams = all.filter(s => s.is_live);

        if (!activeStreams.length) {
            listEl.innerHTML = '<p class="muted">No active streams</p>';
            activeStreamData = null;
            document.getElementById('dash-endpoint-info').style.display = 'none';
            return;
        }

        listEl.innerHTML = activeStreams.map(s => {
            const proto = (s.protocol || 'webrtc').toUpperCase();
            const icon = s.protocol === 'jsmpeg' ? 'fa-terminal' : s.protocol === 'rtmp' ? 'fa-server' : 'fa-globe';
            const raw = s.started_at || '';
            const ts = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
            const started = new Date(ts);
            const elapsed = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
            return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
                <i class="fa-solid ${icon}" style="color:var(--accent)"></i>
                <div style="flex:1;min-width:0">
                    <strong style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.title || 'Untitled')}</strong>
                    <span class="muted" style="font-size:0.8rem">${proto} · ${formatDuration(elapsed)} live</span>
                </div>
                <button class="btn btn-small" onclick="showEndpointInfoById(${s.id})"><i class="fa-solid fa-info-circle"></i></button>
                <button class="btn btn-small btn-danger" onclick="endStreamById(${s.id})"><i class="fa-solid fa-stop"></i> End</button>
            </div>`;
        }).join('');

        // Set first active stream if not already set
        if (!activeStreamData) activeStreamData = activeStreams[0];
    } catch { listEl.innerHTML = '<p class="muted">Failed to load streams</p>'; }
}

async function endStreamById(streamId) {
    try {
        await api(`/streams/${streamId}`, { method: 'DELETE' });
        toast('Stream ended', 'info');
        if (activeStreamData && activeStreamData.id === streamId) activeStreamData = null;
        activeStreams = activeStreams.filter(s => s.id !== streamId);
        loadDashActiveStreams();
        loadDashControls();
    } catch (e) { toast(e.message, 'error'); }
}

async function endStream() {
    if (!activeStreamData) return;
    await endStreamById(activeStreamData.id);
}

function showEndpointInfoById(streamId) {
    const s = activeStreams.find(x => x.id === streamId);
    if (s) showEndpointInfo(s);
}

function showEndpointInfo(stream) {
    const el = document.getElementById('dash-endpoint-info');
    el.style.display = '';

    const host = window.location.hostname;
    const proto = stream.protocol || 'jsmpeg';

    let info = '';
    if (proto === 'jsmpeg') {
            const vp = stream.endpoint?.videoPort || stream.endpoint?.video_port || 9710;
        info = `Protocol: JSMPEG\n\nFFmpeg command:\nffmpeg -i <source> \\\n  -f mpegts \\\n  -codec:v mpeg1video -b:v 800k -r 24 \\\n  -codec:a mp2 -ar 44100 -ac 1 -b:a 64k \\\n  http://${host}:${vp}/stream_key`;
    } else if (proto === 'webrtc') {
        info = `Protocol: WebRTC\n\nUse the browser "Start Broadcasting" feature.\nYour webcam/screen will be shared via Mediasoup SFU.`;
    } else if (proto === 'rtmp') {
        info = `Protocol: RTMP\n\nServer: rtmp://${host}:1935/live\nStream Key: ${stream.stream_key || '(use your stream key)'}\n\nIn OBS: Settings → Stream → Custom → paste above.`;
    }

    el.textContent = info;
}

/* ── Controls Manager ─────────────────────────────────────────── */
async function loadDashControls() {
    const list = document.getElementById('dash-controls-list');
    if (!activeStreams.length) {
        list.innerHTML = '<p class="muted">Go live first to manage controls</p>';
        return;
    }

    try {
        // Load controls for the first active stream (or the selected one)
        const streamId = activeStreamData ? activeStreamData.id : activeStreams[0].id;
        const data = await api(`/controls/${streamId}`);
        const controls = data.controls || [];
        if (!controls.length) {
            list.innerHTML = '<p class="muted">No controls configured</p>';
            return;
        }
        list.innerHTML = controls.map(c => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
                <i class="fa-solid ${esc(c.icon || 'fa-circle')}"></i>
                <span>${esc(c.label || c.command)}</span>
                <span class="muted" style="flex:1">${esc(c.command)} (${c.cooldown}s)</span>
                <button class="btn btn-small btn-danger" onclick="deleteControl('${c.id}')">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `).join('');
    } catch { list.innerHTML = '<p class="muted">Failed to load controls</p>'; }

    // Load control settings
    loadControlSettings();
}

async function loadControlSettings() {
    try {
        const data = await api('/controls/settings/channel');
        const modeEl = document.getElementById('dash-control-mode');
        const rateEl = document.getElementById('dash-control-rate-limit');
        const anonEl = document.getElementById('dash-anon-controls');
        const videoClickEl = document.getElementById('dash-video-click');
        const whitelistSection = document.getElementById('dash-control-whitelist-section');
        if (modeEl) modeEl.value = data.control_mode || 'open';
        if (rateEl) rateEl.value = data.control_rate_limit_ms || 500;
        if (anonEl) anonEl.checked = data.anon_controls_enabled !== false;
        if (videoClickEl) videoClickEl.checked = !!data.video_click_enabled;
        if (whitelistSection) whitelistSection.style.display = data.control_mode === 'whitelist' ? '' : 'none';
        if (data.control_mode === 'whitelist') loadControlWhitelist();
    } catch { /* silent — settings panel is optional */ }
}

async function updateControlSettings() {
    try {
        const mode = document.getElementById('dash-control-mode')?.value || 'open';
        const rate = parseInt(document.getElementById('dash-control-rate-limit')?.value) || 500;
        const anon = document.getElementById('dash-anon-controls')?.checked ?? true;
        const videoClick = document.getElementById('dash-video-click')?.checked ?? false;
        await api('/controls/settings/channel', {
            method: 'PUT',
            body: { control_mode: mode, anon_controls_enabled: anon, control_rate_limit_ms: rate, video_click_enabled: videoClick }
        });
        const whitelistSection = document.getElementById('dash-control-whitelist-section');
        if (whitelistSection) whitelistSection.style.display = mode === 'whitelist' ? '' : 'none';
        if (mode === 'whitelist') loadControlWhitelist();
    } catch (e) { toast(e.message, 'error'); }
}

async function loadControlWhitelist() {
    const container = document.getElementById('dash-control-whitelist');
    if (!container) return;
    try {
        const data = await api('/controls/whitelist');
        const list = data.whitelist || [];
        if (!list.length) {
            container.innerHTML = '<p class="muted" style="font-size:0.85rem">No users whitelisted</p>';
            return;
        }
        container.innerHTML = list.map(u => `
            <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
                <span>${esc(u.display_name || u.username)}</span>
                <span class="muted" style="flex:1;font-size:0.8rem">@${esc(u.username)}</span>
                <button class="btn btn-small btn-danger" onclick="removeFromControlWhitelist(${u.id})"><i class="fa-solid fa-times"></i></button>
            </div>
        `).join('');
    } catch { container.innerHTML = '<p class="muted">Failed to load whitelist</p>'; }
}

async function addToControlWhitelist() {
    const input = document.getElementById('dash-whitelist-username');
    const username = input?.value.trim();
    if (!username) return toast('Enter a username', 'error');
    try {
        await api('/controls/whitelist', { method: 'POST', body: { username } });
        toast(`${username} added to whitelist`, 'success');
        if (input) input.value = '';
        loadControlWhitelist();
    } catch (e) { toast(e.message, 'error'); }
}

async function removeFromControlWhitelist(id) {
    try {
        await api(`/controls/whitelist/${id}`, { method: 'DELETE' });
        toast('Removed from whitelist', 'success');
        loadControlWhitelist();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Control Config Management ────────────────────────────────── */

function openClonePresetModal() {
    const modal = document.getElementById('clone-preset-config-modal');
    if (!modal) return;
    modal.style.display = '';
    // Fetch presets from backend or use static list if needed
    fetch('/api/controls/presets', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(data => {
            const presets = data.presets || [];
            const select = document.getElementById('clone-preset-select');
            select.innerHTML = presets.map(p => `<option value="${p.id}" data-name="${esc(p.name)}" data-desc="${esc(p.description||'')}">${esc(p.name)}</option>`).join('');
            if (presets.length) {
                select.value = presets[0].id;
                document.getElementById('clone-preset-name').value = presets[0].name;
                document.getElementById('clone-preset-desc').value = presets[0].description || '';
            }
        });
    // Update name/desc fields on preset change
    document.getElementById('clone-preset-select').onchange = function() {
        const opt = this.options[this.selectedIndex];
        document.getElementById('clone-preset-name').value = opt.getAttribute('data-name') || '';
        document.getElementById('clone-preset-desc').value = opt.getAttribute('data-desc') || '';
    };
}

function closeModal() {
    // Hide main modal (app.js uses classList 'show')
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.remove('show');
    // Also hide clone preset modal (uses style.display)
    const cloneModal = document.getElementById('clone-preset-config-modal');
    if (cloneModal) cloneModal.style.display = 'none';
}

async function doClonePresetConfig() {
    const select = document.getElementById('clone-preset-select');
    const presetId = select?.value;
    const name = document.getElementById('clone-preset-name')?.value.trim();
    const desc = document.getElementById('clone-preset-desc')?.value.trim() || '';
    if (!presetId || !name) return toast('Select a preset and enter a name', 'error');
    try {
        // Get preset buttons
        const preset = await fetch(`/api/controls/presets/${presetId}`).then(r => r.json());
        const buttons = preset.buttons || [];
        // Create new config
        const res = await api('/controls/configs', { method: 'POST', body: { name, description: desc } });
        const newConfigId = res.id || res.config_id || res.config?.id;
        if (!newConfigId) throw new Error('Failed to create config');
        // Add all buttons
        for (const btn of buttons) {
            await api(`/controls/configs/${newConfigId}/buttons`, {
                method: 'POST',
                body: {
                    command: btn.command,
                    label: btn.label,
                    icon: btn.icon,
                    control_type: btn.control_type,
                    key_binding: btn.key_binding,
                    cooldown_ms: btn.cooldown_ms,
                    btn_color: btn.btn_color,
                    btn_bg: btn.btn_bg,
                    btn_border_color: btn.btn_border_color,
                }
            });
        }
        toast('Preset cloned!', 'success');
        closeModal();
        loadDashConfigs();
    } catch (e) { toast(e.message || 'Failed to clone preset', 'error'); }
}
let editingConfigId = null;

async function loadDashConfigs() {
    const list = document.getElementById('dash-config-list');
    if (!list) return;
    try {
        const data = await api('/controls/configs');
        const configs = data.configs || [];
        const settingsData = await api('/controls/settings/channel').catch(() => ({}));
        const activeConfigId = settingsData.active_control_config_id;

        if (!configs.length) {
            list.innerHTML = '<p class="muted" style="font-size:0.85rem">No control profiles yet. Create one to set up reusable control buttons.</p>';
            return;
        }
        list.innerHTML = configs.map(c => {
            const isActive = c.id === activeConfigId;
            return `
            <div style="display:flex;align-items:center;gap:8px;padding:8px;margin-bottom:6px;background:var(--bg-hover);border-radius:var(--radius);border:1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}">
                <div style="flex:1;min-width:0">
                    <div style="font-weight:600;font-size:0.9rem">${esc(c.name)} <span class="muted" style="font-size:0.75rem">(${c.button_count} buttons)</span></div>
                    ${c.description ? `<div class="muted" style="font-size:0.8rem">${esc(c.description)}</div>` : ''}
                </div>
                ${isActive ? '<span style="font-size:0.75rem;padding:2px 6px;background:var(--accent);color:#000;border-radius:4px;font-weight:700">ACTIVE</span>' : ''}
                <button class="btn btn-small ${isActive ? 'btn-outline' : 'btn-primary'}" onclick="${isActive ? 'deactivateConfig()' : `activateConfig(${c.id})`}" title="${isActive ? 'Deactivate' : 'Set as active'}">
                    <i class="fa-solid ${isActive ? 'fa-circle-xmark' : 'fa-circle-check'}"></i>
                </button>
                <button class="btn btn-small btn-outline" onclick="editConfig(${c.id})" title="Edit buttons">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="btn btn-small btn-danger" onclick="deleteConfig(${c.id})" title="Delete profile">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>`;
        }).join('');

        // Also populate the bridge script config selector
        const bridgeSelect = document.getElementById('dash-bridge-config-select');
        if (bridgeSelect) {
            bridgeSelect.innerHTML = '<option value="">Select a control profile...</option>' +
                configs.map(c => `<option value="${c.id}">${esc(c.name)} (${c.button_count} buttons)</option>`).join('');
        }
    } catch { list.innerHTML = '<p class="muted">Failed to load configs</p>'; }
}

async function doCreateConfig() {
    const name = document.getElementById('modal-config-name')?.value.trim();
    const desc = document.getElementById('modal-config-desc')?.value.trim() || '';
    if (!name) return toast('Profile name is required', 'error');
    try {
        await api('/controls/configs', { method: 'POST', body: { name, description: desc } });
        toast('Profile created', 'success');
        closeModal();
        loadDashConfigs();
    } catch (e) { toast(e.message, 'error'); }
}

async function activateConfig(configId) {
    try {
        const res = await api(`/controls/configs/${configId}/activate`, { method: 'POST' });
        const n = res.applied_to_streams || 0;
        toast(n > 0 ? `Profile activated & applied to ${n} live stream${n > 1 ? 's' : ''}` : 'Profile activated — will apply to your next stream', 'success');
        loadDashConfigs();
        loadDashControls();
    } catch (e) { toast(e.message, 'error'); }
}

async function deactivateConfig() {
    try {
        await api('/controls/configs/deactivate', { method: 'POST' });
        toast('Profile deactivated — controls cleared from live streams', 'success');
        loadDashConfigs();
        loadDashControls();
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteConfig(configId) {
    if (!confirm('Delete this control profile and all its buttons?')) return;
    try {
        await api(`/controls/configs/${configId}`, { method: 'DELETE' });
        toast('Profile deleted', 'success');
        if (editingConfigId === configId) closeConfigEditor();
        loadDashConfigs();
    } catch (e) { toast(e.message, 'error'); }
}

async function editConfig(configId) {
    editingConfigId = configId;
    const editor = document.getElementById('dash-config-editor');
    if (!editor) return;
    editor.style.display = '';

    try {
        const data = await api(`/controls/configs/${configId}`);
        const config = data.config;
        const buttons = data.buttons || [];

        document.getElementById('dash-config-editor-title').textContent = `Editing: ${config.name}`;

        const list = document.getElementById('dash-config-buttons-list');
        if (!buttons.length) {
            list.innerHTML = '<p class="muted" style="font-size:0.85rem">No buttons yet. Click "Add Button" to start building your control layout.</p>';
            return;
        }

        list.innerHTML = buttons.map(b => {
            const style = [];
            if (b.btn_color) style.push(`color:${b.btn_color}`);
            if (b.btn_bg) style.push(`background:${b.btn_bg}`);
            if (b.btn_border_color) style.push(`border-color:${b.btn_border_color}`);
            const styleAttr = style.length ? ` style="${style.join(';')}"` : '';
            return `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
                <span class="control-btn" style="min-width:auto;padding:6px 10px;pointer-events:none;${style.join(';')}">
                    <i class="fa-solid ${esc(b.icon || 'fa-gamepad')}"></i>
                </span>
                <div style="flex:1;min-width:0">
                    <div style="font-weight:600;font-size:0.85rem">${esc(b.label)}</div>
                    <div class="muted" style="font-size:0.75rem">${esc(b.command)} &middot; ${b.control_type} ${b.key_binding ? '&middot; [' + esc(b.key_binding.toUpperCase()) + ']' : ''} &middot; ${b.cooldown_ms}ms</div>
                </div>
                <button class="btn btn-small btn-danger" onclick="deleteConfigButton(${configId}, ${b.id})">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>`;
        }).join('');
    } catch (e) { toast(e.message, 'error'); }
}

function closeConfigEditor() {
    editingConfigId = null;
    const editor = document.getElementById('dash-config-editor');
    if (editor) editor.style.display = 'none';
}

async function doAddConfigButton() {
    if (!editingConfigId) return toast('No profile selected', 'error');
    const command = document.getElementById('modal-cfgbtn-cmd')?.value.trim();
    const label = document.getElementById('modal-cfgbtn-label')?.value.trim();
    const icon = document.getElementById('modal-cfgbtn-icon')?.value.trim() || 'fa-gamepad';
    const type = document.getElementById('modal-cfgbtn-type')?.value || 'button';
    const keybind = document.getElementById('modal-cfgbtn-keybind')?.value.trim() || '';
    const cooldown = parseFloat(document.getElementById('modal-cfgbtn-cooldown')?.value) || 0.5;
    const btnColor = document.getElementById('modal-cfgbtn-color')?.value.trim() || '';
    const btnBg = document.getElementById('modal-cfgbtn-bg')?.value.trim() || '';
    const btnBorder = document.getElementById('modal-cfgbtn-border')?.value.trim() || '';

    if (!command) return toast('Command is required', 'error');

    try {
        await api(`/controls/configs/${editingConfigId}/buttons`, {
            method: 'POST',
            body: {
                command,
                label: label || command,
                icon,
                control_type: type,
                key_binding: keybind,
                cooldown_ms: Math.round(cooldown * 1000),
                btn_color: btnColor,
                btn_bg: btnBg,
                btn_border_color: btnBorder,
            }
        });
        toast('Button added', 'success');
        closeModal();
        editConfig(editingConfigId);
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteConfigButton(configId, buttonId) {
    try {
        await api(`/controls/configs/${configId}/buttons/${buttonId}`, { method: 'DELETE' });
        toast('Button removed', 'success');
        editConfig(configId);
    } catch (e) { toast(e.message, 'error'); }
}

async function doAddControl() {
    const streamId = activeStreamData ? activeStreamData.id : (activeStreams[0] && activeStreams[0].id);
    if (!streamId) return toast('Go live first', 'error');
    const command = document.getElementById('modal-ctrl-cmd').value.trim();
    const label = document.getElementById('modal-ctrl-label').value.trim();
    const icon = document.getElementById('modal-ctrl-icon').value.trim();
    const cooldown = parseInt(document.getElementById('modal-ctrl-cooldown').value) || 1;

    if (!command) return toast('Command is required', 'error');

    try {
        await api(`/controls/${streamId}`, {
            method: 'POST',
            body: { command, label: label || command, icon, cooldown }
        });
        toast('Control added', 'success');
        closeModal();
        loadDashControls();
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteControl(controlId) {
    const streamId = activeStreamData ? activeStreamData.id : (activeStreams[0] && activeStreams[0].id);
    if (!streamId) return;
    try {
        await api(`/controls/${streamId}/${controlId}`, { method: 'DELETE' });
        toast('Control removed', 'success');
        loadDashControls();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Bridge Script Downloads ──────────────────────────────────── */
async function downloadDashBridgeScript(type) {
    const select = document.getElementById('dash-bridge-config-select');
    const configId = select?.value;
    if (!configId) return toast('Select a control profile first', 'error');
    try {
        const url = `/api/controls/configs/${configId}/bridge-script?type=${encodeURIComponent(type)}`;
        const resp = await fetch(url, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error('Download failed');
        const blob = await resp.blob();
        const filename = resp.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] || `${type}-bridge.py`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) { toast(e.message || 'Download failed', 'error'); }
}

async function downloadControlBridgeScript() {
    const select = document.getElementById('bc-control-config');
    const configId = select?.value;
    if (!configId) return toast('Select a control profile first', 'error');
    try {
        const url = `/api/controls/configs/${configId}/bridge-script?type=generic`;
        const resp = await fetch(url, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error('Download failed');
        const blob = await resp.blob();
        const filename = resp.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] || 'generic-bridge.py';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) { toast(e.message || 'Download failed', 'error'); }
}

/* ── Goals ─────────────────────────────────────────────────────── */
async function loadDashGoals() {
    if (!currentUser) return;
    const list = document.getElementById('dash-goals-list');
    try {
        const data = await api(`/funds/goals/${currentUser.id}`);
        const goals = data.goals || [];
        if (!goals.length) {
            list.innerHTML = '<p class="muted">No goals set</p>';
            return;
        }
        list.innerHTML = goals.map(g => {
            const pct = g.target_amount ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100)) : 0;
            return `
                <div style="margin-bottom:12px">
                    <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                        <strong>${esc(g.title)}</strong>
                        <span class="muted">${pct}%</span>
                    </div>
                    <div class="goal-bar">
                        <div class="goal-fill" style="width:${pct}%"></div>
                    </div>
                    <div class="muted" style="font-size:0.8rem;margin-top:2px">
                        $${g.current_amount} / $${g.target_amount} Hobo Bucks
                    </div>
                </div>
            `;
        }).join('');
    } catch { list.innerHTML = '<p class="muted">Failed to load goals</p>'; }
}

async function doAddGoal() {
    const title = document.getElementById('modal-goal-title').value.trim();
    const target = parseInt(document.getElementById('modal-goal-target').value);

    if (!title || !target) return toast('Fill in all fields', 'error');

    try {
        await api('/funds/goals', { method: 'POST', body: { title, targetAmount: target } });
        toast('Goal created!', 'success');
        closeModal();
        loadDashGoals();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── VODs ──────────────────────────────────────────────────────── */
const DASH_PAGE_SIZE = 12;
let dashVodPage = 0, dashVodTotal = 0;
let dashMyClipsPage = 0, dashMyClipsTotal = 0;
let dashStreamClipsPage = 0, dashStreamClipsTotal = 0;

function dashPaginationHtml(prefix, page, total) {
    const totalPages = Math.ceil(total / DASH_PAGE_SIZE);
    if (totalPages <= 1) return '';
    return `<div class="dash-pagination" style="margin-top:12px;display:flex;gap:8px;align-items:center;justify-content:center">
        <button class="btn btn-small btn-outline" ${page <= 0 ? 'disabled' : ''} onclick="${prefix}GoPage(${page - 1})"><i class="fa-solid fa-chevron-left"></i> Prev</button>
        <span class="muted" style="font-size:0.85rem">Page ${page + 1} of ${totalPages}</span>
        <button class="btn btn-small btn-outline" ${page >= totalPages - 1 ? 'disabled' : ''} onclick="${prefix}GoPage(${page + 1})">Next <i class="fa-solid fa-chevron-right"></i></button>
    </div>`;
}

async function loadDashVods() {
    const list = document.getElementById('dash-vods-list');
    try {
        const data = await api(`/vods/mine?limit=${DASH_PAGE_SIZE}&offset=${dashVodPage * DASH_PAGE_SIZE}`);
        const vods = data.vods || [];
        dashVodTotal = data.total ?? vods.length;
        if (!vods.length && dashVodPage === 0) {
            list.innerHTML = '<p class="muted">No recordings yet. Videos are created automatically when you stream.</p>';
            return;
        }
        list.innerHTML = vods.map(v => `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(v.thumbnail_url, 'fa-video', v.title) : '<i class="fa-solid fa-video"></i>'}
                    ${!v.is_public ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">PRIVATE</span>' : '<span class="stream-card-nsfw" style="background:var(--accent)">PUBLIC</span>'}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(v.duration_seconds || v.duration)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(v.title || 'Untitled Video')}</div>
                    <div style="display:flex;gap:6px;margin-top:6px">
                        ${!v.is_public
                            ? `<button class="btn btn-small btn-success" onclick="publishVod('${v.id}')"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="unpublishVod('${v.id}')"><i class="fa-solid fa-eye-slash"></i> Private</button>`}
                        <button class="btn btn-small" onclick="navigate('/vod/${v.id}')"><i class="fa-solid fa-play"></i></button>
                        <button class="btn btn-small btn-danger" onclick="deleteVod('${v.id}')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `).join('') + dashPaginationHtml('dashVod', dashVodPage, dashVodTotal);
    } catch { list.innerHTML = '<p class="muted">Failed to load videos</p>'; }
}

function dashVodGoPage(page) { dashVodPage = page; loadDashVods(); }

async function publishVod(vodId) {
    try {
        await api(`/vods/${vodId}/publish`, { method: 'POST' });
        toast('Video published', 'success');
        loadDashVods();
    } catch (e) { toast(e.message, 'error'); }
}

async function unpublishVod(vodId) {
    try {
        await api(`/vods/${vodId}`, { method: 'PUT', body: { is_public: false } });
        toast('Video set to private', 'info');
        loadDashVods();
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteVod(vodId) {
    if (!confirm('Delete this video forever?')) return;
    try {
        await api(`/vods/${vodId}`, { method: 'DELETE' });
        toast('Video deleted', 'success');
        loadDashVods();
    } catch (e) { toast(e.message, 'error'); }
}

async function dashBulkDeleteByAge() {
    const ageInput = document.getElementById('dash-bulk-delete-age-days');
    const vodsToggle = document.getElementById('dash-bulk-delete-vods');
    const clipsToggle = document.getElementById('dash-bulk-delete-clips');
    const olderThanDays = parseInt(ageInput?.value, 10);
    const deleteVods = !!vodsToggle?.checked;
    const deleteClips = !!clipsToggle?.checked;

    if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
        return toast('Enter a valid age in days (minimum 1)', 'error');
    }
    if (!deleteVods && !deleteClips) {
        return toast('Select VODs and/or Clips to delete', 'error');
    }

    const targets = [deleteVods ? 'VODs' : null, deleteClips ? 'clips' : null].filter(Boolean).join(' and ');
    if (!confirm(`Delete ${targets} older than ${olderThanDays} day(s)? This cannot be undone.`)) return;

    try {
        const result = await api('/vods/bulk-delete-old', {
            method: 'POST',
            body: { olderThanDays, deleteVods, deleteClips },
        });

        const deletedVods = result?.deleted?.vods || 0;
        const deletedClips = result?.deleted?.clips || 0;
        const fileErrors = result?.fileDeleteErrors || 0;
        toast(`Deleted ${deletedVods} VOD(s) and ${deletedClips} clip(s) older than ${olderThanDays} day(s)`, 'success');
        if (fileErrors > 0) {
            toast(`Deleted records, but ${fileErrors} file(s) could not be removed`, 'warning');
        }

        if (deleteVods) loadDashVods();
        if (deleteClips) {
            loadDashMyClips();
            loadDashStreamClips();
        }
    } catch (e) {
        toast(e.message || 'Bulk delete failed', 'error');
    }
}

/* ── My Clips (clips I created) ───────────────────────────────── */
async function loadDashMyClips() {
    const list = document.getElementById('dash-my-clips');
    if (!list) return;
    try {
        const data = await api(`/clips/mine?limit=${DASH_PAGE_SIZE}&offset=${dashMyClipsPage * DASH_PAGE_SIZE}`);
        const clips = data.clips || [];
        dashMyClipsTotal = data.total ?? clips.length;
        if (!clips.length && dashMyClipsPage === 0) {
            list.innerHTML = '<p class="muted">You haven\'t clipped anything yet. Use the clip button while watching a stream!</p>';
            return;
        }
        list.innerHTML = clips.map(cl => `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title) : '<i class="fa-solid fa-scissors"></i>'}
                    ${!cl.is_public ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">UNLISTED</span>' : '<span class="stream-card-nsfw" style="background:var(--accent)">PUBLIC</span>'}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Untitled Clip')}</div>
                    <div class="muted" style="font-size:0.8rem;margin-bottom:4px">${new Date(cl.created_at).toLocaleDateString()}</div>
                    <div style="display:flex;gap:6px">
                        ${!cl.is_public
                            ? `<button class="btn btn-small btn-success" onclick="dashToggleClipVisibility(${cl.id}, true, 'mine')"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="dashToggleClipVisibility(${cl.id}, false, 'mine')"><i class="fa-solid fa-eye-slash"></i> Unlist</button>`}
                        <button class="btn btn-small" onclick="navigate('/clip/${cl.id}')"><i class="fa-solid fa-play"></i></button>
                        <button class="btn btn-small btn-danger" onclick="dashDeleteClip(${cl.id}, 'mine')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `).join('') + dashPaginationHtml('dashMyClips', dashMyClipsPage, dashMyClipsTotal);
    } catch { list.innerHTML = '<p class="muted">Failed to load clips</p>'; }
}

function dashMyClipsGoPage(page) { dashMyClipsPage = page; loadDashMyClips(); }

/* ── Clips of My Stream ───────────────────────────────────────── */
async function loadDashStreamClips() {
    const list = document.getElementById('dash-stream-clips');
    if (!list) return;
    try {
        const data = await api(`/clips/my-stream?limit=${DASH_PAGE_SIZE}&offset=${dashStreamClipsPage * DASH_PAGE_SIZE}`);
        const clips = data.clips || [];
        dashStreamClipsTotal = data.total ?? clips.length;
        if (!clips.length && dashStreamClipsPage === 0) {
            list.innerHTML = '<p class="muted">No one has clipped your streams yet.</p>';
            return;
        }
        list.innerHTML = clips.map(cl => `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title) : '<i class="fa-solid fa-scissors"></i>'}
                    ${!cl.is_public ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">UNLISTED</span>' : '<span class="stream-card-nsfw" style="background:var(--accent)">PUBLIC</span>'}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Untitled Clip')}</div>
                    <div class="muted" style="font-size:0.8rem;margin-bottom:4px">
                        <i class="fa-solid fa-scissors"></i> ${esc(cl.display_name || cl.username || 'Unknown')} &bull; ${new Date(cl.created_at).toLocaleDateString()}
                    </div>
                    <div style="display:flex;gap:6px">
                        ${!cl.is_public
                            ? `<button class="btn btn-small btn-success" onclick="dashToggleClipVisibility(${cl.id}, true)"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="dashToggleClipVisibility(${cl.id}, false)"><i class="fa-solid fa-eye-slash"></i> Unlist</button>`}
                        <button class="btn btn-small" onclick="navigate('/clip/${cl.id}')"><i class="fa-solid fa-play"></i></button>
                        <button class="btn btn-small btn-danger" onclick="dashDeleteClip(${cl.id}, 'stream')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `).join('') + dashPaginationHtml('dashStreamClips', dashStreamClipsPage, dashStreamClipsTotal);
    } catch { list.innerHTML = '<p class="muted">Failed to load clips</p>'; }
}

function dashStreamClipsGoPage(page) { dashStreamClipsPage = page; loadDashStreamClips(); }

async function dashToggleClipVisibility(clipId, makePublic, source) {
    try {
        await api(`/clips/${clipId}/visibility`, {
            method: 'PUT',
            body: { is_public: makePublic }
        });
        toast(makePublic ? 'Clip published' : 'Clip unlisted', 'success');
        if (source === 'mine') loadDashMyClips();
        else loadDashStreamClips();
    } catch (e) { toast(e.message || 'Failed to update visibility', 'error'); }
}

async function dashDeleteClip(clipId, source) {
    if (!confirm('Delete this clip permanently?')) return;
    try {
        await api(`/clips/${clipId}`, { method: 'DELETE' });
        toast('Clip deleted', 'success');
        if (source === 'mine') loadDashMyClips();
        else loadDashStreamClips();
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
}

/* ── Hobo Bucks ───────────────────────────────────────────────── */
async function loadDashFunds() {
    if (!currentUser) return;
    try {
        const data = await api('/funds/balance');
        const bal = data.balance || 0;
        document.getElementById('dash-funds-amount').textContent = parseFloat(bal).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        document.getElementById('dash-funds-usd').textContent = `($${parseFloat(bal).toFixed(2)})`;
    } catch { /* silent */ }
}

/* ── Hobo Coins ─────────────────────────────────────────────── */
async function loadDashCoins() {
    if (!currentUser) return;
    try {
        const data = await api('/coins/balance');
        const bal = data.balance || 0;
        document.getElementById('dash-coins-amount').textContent = bal.toLocaleString();
    } catch { /* silent */ }
}
