'use strict';
/* ═══════════════════════════════════════════════════════════════
   broadcast-workspace.js — Managed-stream workspace UI.

   Left sidebar: list of managed stream slots.
   Right panel:  profile editor (autosave), device picker, Go Live
                 button, live-session banner, and session history.

   State separation:
     Class A (server):    title, description, category, nsfw, method,
                          resolution, fps, bitrate, control_config_id
                          → saved to managed_streams.broadcast_settings via PUT
     Class B (local):     camera deviceId, mic deviceId → broadcastState.settings
     Class C (in-memory): live session id, stream state — broadcastState.streams
   ═══════════════════════════════════════════════════════════════ */

/* ── Workspace state ─────────────────────────────────────────── */

let _wsState = {
    managedStreams: [],
    selectedId: null,       // currently selected managed stream ID
    selectedMs: null,       // the full managed stream object
    profile: {},            // broadcast_settings JSON from server
    dirty: false,
    savingProfile: false,
    autosaveTimer: null,
    history: [],
};

/* ── Init ────────────────────────────────────────────────────── */

async function initBroadcastWorkspace() {
    await _wsLoadManagedStreams();
    _wsRenderSidebar();
    if (_wsState.managedStreams.length > 0) {
        await _wsSelectStream(_wsState.managedStreams[0].id);
    } else {
        _wsShowEmpty();
    }
}

async function _wsLoadManagedStreams() {
    try {
        const data = await api('/streams/managed');
        _wsState.managedStreams = data.managed_streams || [];
    } catch {
        _wsState.managedStreams = [];
    }
}

/* ── Sidebar ─────────────────────────────────────────────────── */

function _wsRenderSidebar() {
    const list = document.getElementById('bc-ws-list');
    if (!list) return;

    if (_wsState.managedStreams.length === 0) {
        list.innerHTML = '<p class="bc-ws-empty-hint muted">No stream slots yet.<br>Click <strong>+</strong> to create one.</p>';
        return;
    }

    list.innerHTML = _wsState.managedStreams.map(ms => {
        const isSelected = ms.id === _wsState.selectedId;
        const isLive = _wsIsManagedStreamLive(ms.id);
        const proto = (ms.protocol || 'webrtc').toUpperCase();
        return `
            <div class="bc-ws-item${isSelected ? ' selected' : ''}" onclick="wsSelectStream(${ms.id})">
                <div class="bc-ws-item-status${isLive ? ' live' : ''}"></div>
                <div class="bc-ws-item-body">
                    <div class="bc-ws-item-name">${esc(ms.title || 'Untitled')}</div>
                    <div class="bc-ws-item-meta">
                        <span class="bc-ws-item-proto">${proto}</span>
                        ${ms.slug ? `<span class="bc-ws-item-slug">/${esc(ms.slug)}</span>` : ''}
                        ${isLive ? '<span class="bc-ws-live-dot"><i class="fa-solid fa-circle"></i> LIVE</span>' : ''}
                    </div>
                </div>
                <button class="bc-ws-item-del" onclick="event.stopPropagation();_wsConfirmDelete(${ms.id})" title="Delete slot">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`;
    }).join('');
}

function _wsIsManagedStreamLive(managedStreamId) {
    if (!broadcastState?.streams) return false;
    for (const [, ss] of broadcastState.streams) {
        if (ss.streamData?.managed_stream_id === managedStreamId) return true;
    }
    return false;
}

/* ── Stream selection ────────────────────────────────────────── */

// Public – called from sidebar onclick
async function wsSelectStream(managedStreamId) {
    if (_wsState.selectedId === managedStreamId) return;
    // Flush pending autosave before switching
    if (_wsState.dirty && _wsState.autosaveTimer) {
        clearTimeout(_wsState.autosaveTimer);
        _wsState.autosaveTimer = null;
        await _wsSaveProfile();
    }
    await _wsSelectStream(managedStreamId);
}

async function _wsSelectStream(managedStreamId) {
    _wsState.selectedId = managedStreamId;
    _wsState.selectedMs = _wsState.managedStreams.find(ms => ms.id === managedStreamId) || null;
    _wsRenderSidebar();
    await _wsLoadProfile(managedStreamId);
    _wsRenderPanel();
    _wsLoadHistory(managedStreamId);
}

async function _wsLoadProfile(managedStreamId) {
    try {
        const data = await api(`/streams/broadcast-settings?managed_stream_id=${managedStreamId}`);
        _wsState.profile = data.settings || {};
    } catch {
        _wsState.profile = {};
    }
    _wsState.dirty = false;
}

/* ── Panel rendering ─────────────────────────────────────────── */

function _wsShowEmpty() {
    const empty = document.getElementById('bc-ws-empty');
    const panel = document.getElementById('bc-ws-panel');
    if (empty) empty.style.display = '';
    if (panel) panel.style.display = 'none';
}

function _wsRenderPanel() {
    const empty = document.getElementById('bc-ws-empty');
    const panel = document.getElementById('bc-ws-panel');
    if (!panel) return;

    const ms = _wsState.selectedMs;
    if (!ms) { _wsShowEmpty(); return; }

    const p = _wsState.profile;
    if (empty) empty.style.display = 'none';
    panel.style.display = '';

    const isLive = _wsIsManagedStreamLive(ms.id);
    const method = p.method || ms.protocol || 'webrtc';

    // Find active session ID for this managed stream
    let liveSessionId = null;
    if (broadcastState?.streams) {
        for (const [sid, ss] of broadcastState.streams) {
            if (ss.streamData?.managed_stream_id === ms.id) { liveSessionId = sid; break; }
        }
    }

    panel.innerHTML = `
        <!-- ── Header ── -->
        <div class="bc-ws-panel-hd">
            <div class="bc-ws-panel-title">
                <h2>${esc(ms.title || 'Untitled')}</h2>
                ${ms.slug ? `<span class="bc-ws-slug muted">hobostreamer.com/${esc(ms.slug)}</span>` : ''}
            </div>
            ${isLive ? '<span class="bc-live-badge bc-ws-live-badge-hd"><i class="fa-solid fa-circle"></i> LIVE</span>' : ''}
        </div>

        <!-- ── Live session banner ── -->
        <div id="bc-ws-live-banner" style="${liveSessionId ? '' : 'display:none'}">
            <div class="bc-ws-live-banner">
                <div class="bc-ws-live-banner-left">
                    <span class="bc-live-badge"><i class="fa-solid fa-circle"></i> LIVE</span>
                    <span class="bc-ws-uptime-wrap">
                        <i class="fa-solid fa-clock"></i>
                        <span id="bc-ws-uptime">${liveSessionId ? _wsFormatUptime(getStreamState(liveSessionId)?.startedAt) : ''}</span>
                    </span>
                </div>
                <div class="bc-ws-live-banner-right">
                    <button class="btn btn-small" onclick="openViewerPreview()" title="Open viewer preview in new tab">
                        <i class="fa-solid fa-eye"></i> Preview
                    </button>
                    <button class="btn btn-small btn-danger" onclick="stopBroadcast()">
                        <i class="fa-solid fa-stop"></i> End Stream
                    </button>
                </div>
            </div>
        </div>

        <!-- ── Profile form ── -->
        <div class="bc-ws-profile-section">
            <div class="bc-ws-profile-hd">
                <h3><i class="fa-solid fa-sliders"></i> Stream Profile</h3>
                <span id="bc-ws-save-status" class="bc-ws-save-status"></span>
            </div>

            <div class="form-group">
                <label>Default Title</label>
                <input type="text" id="bc-title" class="form-input"
                    value="${esc(p.title !== undefined ? p.title : (ms.title || ''))}"
                    placeholder="What are you streaming?" maxlength="200"
                    oninput="_wsFieldChanged('title', this.value)">
                <span class="bc-field-hint">Pre-fills the title when you go live on this slot</span>
            </div>

            <div class="form-group">
                <label>Description</label>
                <textarea id="bc-description" class="form-input" rows="2"
                    placeholder="Optional description..." maxlength="500"
                    oninput="_wsFieldChanged('description', this.value)">${esc(p.description || '')}</textarea>
            </div>

            <div class="bc-ws-row">
                <div class="form-group" style="flex:2">
                    <label>Category</label>
                    <select id="bc-category" class="form-input" onchange="_wsFieldChanged('category', this.value)">
                        ${_wsRenderCategoryOptions(p.category || 'irl')}
                    </select>
                </div>
                <div class="form-group" style="flex:1;justify-content:flex-end">
                    <label>&nbsp;</label>
                    <label class="bc-toggle-label">
                        <input type="checkbox" id="bc-nsfw" ${p.nsfw ? 'checked' : ''}
                            onchange="_wsFieldChanged('nsfw', this.checked)">
                        <i class="fa-solid fa-triangle-exclamation" style="color:var(--danger)"></i> NSFW
                    </label>
                </div>
            </div>

            <!-- Streaming method -->
            <div class="form-group">
                <label>Streaming Method</label>
                <div class="bc-method-picker bc-method-picker-sm">
                    ${['webrtc', 'rtmp', 'jsmpeg'].map(m => `
                    <div class="bc-method-card-sm${method === m ? ' selected' : ''}"
                        data-wsmethod="${m}" onclick="_wsSelectMethod('${m}')">
                        <i class="fa-solid fa-${m === 'webrtc' ? 'globe' : m === 'rtmp' ? 'server' : 'terminal'}"></i>
                        <strong>${m.toUpperCase()}</strong>
                        <span class="bc-card-sm-hint">${m === 'webrtc' ? 'Browser / WHIP' : m === 'rtmp' ? 'OBS / IRL Pro' : 'FFmpeg / Pi'}</span>
                    </div>`).join('')}
                </div>
            </div>

            <!-- Quality defaults (collapsible) -->
            <details class="bc-ws-quality">
                <summary><i class="fa-solid fa-film"></i> Video Quality Defaults</summary>
                <div class="bc-ws-quality-inner bc-ws-row">
                    <div class="form-group" style="margin:0;flex:1">
                        <label style="font-size:0.82rem">Resolution</label>
                        <select class="form-input form-input-sm" onchange="_wsFieldChanged('resolution', this.value)">
                            ${['360', '480', '720', '1080', '1440'].map(r =>
                                `<option value="${r}"${(p.resolution || '720') === r ? ' selected' : ''}>${r}p</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin:0;flex:1">
                        <label style="font-size:0.82rem">FPS</label>
                        <select class="form-input form-input-sm" onchange="_wsFieldChanged('fps', this.value)">
                            ${['24', '30', '60'].map(f =>
                                `<option value="${f}"${(p.fps || '30') === f ? ' selected' : ''}>${f}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin:0;flex:2">
                        <label style="font-size:0.82rem">Bitrate (kbps)</label>
                        <input type="number" class="form-input form-input-sm"
                            value="${p.bitrate || 2500}" min="500" max="10000" step="100"
                            oninput="_wsFieldChanged('bitrate', parseInt(this.value) || 2500)">
                    </div>
                </div>
            </details>

            <!-- Control config -->
            <div class="form-group">
                <label><i class="fa-solid fa-gamepad"></i> Control Profile</label>
                <select id="bc-control-config" class="form-input form-input-sm"
                    onchange="_wsFieldChanged('control_config_id', parseInt(this.value) || null)">
                    <option value="">None (no controls)</option>
                </select>
            </div>

            <!-- Hidden elements required by createNewStream() and device selection helpers -->
            <select id="bc-managed-stream" style="display:none">
                <option value="${ms.id}" selected>${esc(ms.title || '')}</option>
            </select>
            <input type="checkbox" id="bc-screen-mic-enabled" checked style="display:none">
            <input type="checkbox" id="bc-screen-cam-enabled" style="display:none">
            <input type="checkbox" id="bc-screenPreferCurrentTab-create" style="display:none">
            <select id="bc-screenSystemAudio-create" style="display:none">
                <option value="include" selected>Include</option><option value="auto">Auto</option><option value="exclude">Exclude</option>
            </select>
            <select id="bc-screenSelfBrowser-create" style="display:none">
                <option value="exclude" selected>Exclude</option><option value="include">Include</option>
            </select>
            <select id="bc-screenSurfaceSwitching-create" style="display:none">
                <option value="include" selected>Allow</option><option value="exclude">Disallow</option>
            </select>
            <select id="bc-screen-audio" style="display:none"><option value="default">Default</option></select>
            <select id="bc-screen-camera" style="display:none"><option value="default">Default</option></select>
        </div>

        <!-- ── Go Live section (hidden when already live) ── -->
        <div class="bc-ws-golive-section" id="bc-ws-golive-section"${liveSessionId ? ' style="display:none"' : ''}>

            <!-- Device picker (WebRTC browser only) -->
            <div id="bc-ws-device-wrap"${method !== 'webrtc' ? ' style="display:none"' : ''}>
                <div id="bc-perm-request" class="bc-perm-request">
                    <p class="bc-perm-hint"><i class="fa-solid fa-shield-halved"></i>
                        Browser needs camera & mic access to stream.</p>
                    <button id="bc-perm-btn" class="btn btn-outline" type="button"
                        onclick="requestMediaPermissions()">
                        <i class="fa-solid fa-video"></i> Allow Camera & Mic
                    </button>
                    <p id="bc-perm-debug" style="display:none;font-size:0.75rem;color:var(--text-secondary);margin-top:6px"></p>
                </div>
                <div id="bc-device-selects" style="display:none">
                    <div class="bc-ws-device-row">
                        <div class="form-group" style="margin:0;flex:1">
                            <label style="font-size:0.82rem"><i class="fa-solid fa-camera"></i> Camera</label>
                            <select id="bc-create-camera" class="form-input form-input-sm">
                                <option value="default">Default</option>
                            </select>
                        </div>
                        <div class="form-group" style="margin:0;flex:1">
                            <label style="font-size:0.82rem"><i class="fa-solid fa-microphone"></i> Microphone</label>
                            <select id="bc-create-audio" class="form-input form-input-sm">
                                <option value="default">Default</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            <button class="btn btn-primary btn-lg bc-ws-golive-btn"
                onclick="goLiveFromWorkspace()" id="bc-ws-golive-btn">
                <i class="fa-solid fa-tower-broadcast"></i> Go Live
            </button>
            <p class="bc-create-reassurance" style="margin-top:6px">
                <i class="fa-solid fa-circle-info"></i>
                Your stream will be live at <strong>hobostreamer.com/${esc(ms.slug || (currentUser?.username || 'you'))}</strong>
            </p>
        </div>

        <!-- ── Session history ── -->
        <div class="bc-ws-history-section" id="bc-ws-history-section">
            <h3><i class="fa-solid fa-clock-rotate-left"></i> Recent Sessions</h3>
            <div id="bc-ws-history-list" class="bc-ws-history-list">
                <p class="muted" style="padding:12px 0"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</p>
            </div>
        </div>
    `;

    // Async post-render: populate control configs and devices
    _wsPopulateControlConfigs(p.control_config_id);
    _wsInitDevicePicker(method);
}

/* ── Category options helper ─────────────────────────────────── */

function _wsRenderCategoryOptions(selected) {
    const cats = [
        ['outdoors', 'Outdoors'], ['travel', 'Travel'], ['building', 'Building/Craft'],
        ['music', 'Music'], ['gaming', 'Gaming'], ['robot', 'Robot'],
        ['desktop', 'Desktop'], ['irl', 'IRL'], ['other', 'Other'],
    ];
    return cats.map(([v, l]) =>
        `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`
    ).join('');
}

/* ── Device picker init ──────────────────────────────────────── */

async function _wsInitDevicePicker(method) {
    const wrap = document.getElementById('bc-ws-device-wrap');
    if (wrap) wrap.style.display = method !== 'webrtc' ? 'none' : '';
    if (method !== 'webrtc') return;

    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasLabels = devices.some(d => d.label);
        const permReq = document.getElementById('bc-perm-request');
        const devSelects = document.getElementById('bc-device-selects');
        if (hasLabels) {
            if (permReq) permReq.style.display = 'none';
            if (devSelects) devSelects.style.display = '';
            _populateCreateDeviceDropdowns(devices);
        } else {
            if (permReq) permReq.style.display = '';
            if (devSelects) devSelects.style.display = 'none';
        }
    } catch (err) {
        console.warn('[Workspace] Device enumeration failed:', err.message);
    }
}

/* ── Control config population ───────────────────────────────── */

async function _wsPopulateControlConfigs(selectedId) {
    const select = document.getElementById('bc-control-config');
    if (!select) return;
    try {
        const data = await api('/controls/configs');
        const configs = data.configs || [];
        select.innerHTML = '<option value="">None (no controls)</option>';
        configs.forEach(cfg => {
            const opt = document.createElement('option');
            opt.value = cfg.id;
            opt.textContent = `${esc(cfg.name)} (${cfg.button_count || 0} buttons)`;
            if (cfg.id === selectedId) opt.selected = true;
            select.appendChild(opt);
        });
    } catch { /* leave as None */ }
}

/* ── Profile autosave ────────────────────────────────────────── */

function _wsFieldChanged(key, value) {
    _wsState.profile[key] = value;
    _wsState.dirty = true;
    _wsShowSaveStatus('Unsaved changes');
    _wsScheduleAutosave();
}

function _wsSelectMethod(method) {
    _wsFieldChanged('method', method);
    document.querySelectorAll('[data-wsmethod]').forEach(el =>
        el.classList.toggle('selected', el.dataset.wsmethod === method)
    );
    const wrap = document.getElementById('bc-ws-device-wrap');
    if (wrap) wrap.style.display = method !== 'webrtc' ? 'none' : '';
    broadcastState.selectedMethod = method;
}

function _wsScheduleAutosave() {
    if (_wsState.autosaveTimer) clearTimeout(_wsState.autosaveTimer);
    _wsState.autosaveTimer = setTimeout(_wsSaveProfile, 1000);
}

async function _wsSaveProfile() {
    _wsState.autosaveTimer = null;
    if (!_wsState.selectedId || _wsState.savingProfile) return;
    _wsState.savingProfile = true;
    _wsShowSaveStatus('Saving\u2026');
    try {
        await api('/streams/broadcast-settings', {
            method: 'PUT',
            body: { managed_stream_id: _wsState.selectedId, settings: _wsState.profile },
        });
        _wsState.dirty = false;
        _wsShowSaveStatus('Saved \u2713');
        setTimeout(() => { if (!_wsState.dirty) _wsShowSaveStatus(''); }, 2000);
    } catch {
        _wsShowSaveStatus('Save failed');
    } finally {
        _wsState.savingProfile = false;
    }
}

function _wsShowSaveStatus(msg) {
    const el = document.getElementById('bc-ws-save-status');
    if (el) el.textContent = msg;
}

/* ── Go Live ─────────────────────────────────────────────────── */

async function goLiveFromWorkspace() {
    if (!_wsState.selectedMs) {
        toast('Select a stream slot first', 'error');
        return;
    }

    // Flush any pending autosave first
    if (_wsState.dirty) {
        if (_wsState.autosaveTimer) {
            clearTimeout(_wsState.autosaveTimer);
            _wsState.autosaveTimer = null;
        }
        await _wsSaveProfile();
    }

    const p = _wsState.profile;
    const ms = _wsState.selectedMs;

    // Apply quality settings to broadcastState before createNewStream reads them
    if (p.resolution) broadcastState.settings.broadcastRes = String(p.resolution);
    if (p.fps) broadcastState.settings.broadcastFps = String(p.fps);
    if (p.bitrate) broadcastState.settings.broadcastBps = String(p.bitrate);

    // Set method state (broadcastState fields used by createNewStream)
    const method = p.method || ms.protocol || 'webrtc';
    broadcastState.selectedMethod = method;
    broadcastState.selectedWebRTCSub = 'browser';
    broadcastState.selectedBrowserSource = 'camera';

    // Sync camera/audio from workspace device dropdowns
    const camSel = document.getElementById('bc-create-camera');
    const audSel = document.getElementById('bc-create-audio');
    if (camSel && camSel.value) _syncCameraSelectionUI(camSel.value, { persist: false });
    if (audSel && audSel.value) _syncAudioSelectionUI(audSel.value, { persist: false });

    // bc-title, bc-description, bc-category, bc-nsfw, bc-managed-stream, bc-control-config
    // are already in the workspace panel DOM — createNewStream() reads them directly.
    await createNewStream();
}

/* ── Live status hooks (called from broadcast.js) ────────────── */

/** Call after any stream goes live or ends to refresh workspace badges */
function updateWorkspaceLiveStatus() {
    _wsRenderSidebar();
    if (_wsState.selectedId) {
        // Refresh the live banner and Go Live section visibility
        const liveSessionId = _wsGetLiveSessionId(_wsState.selectedId);
        const banner = document.getElementById('bc-ws-live-banner');
        const goliveSection = document.getElementById('bc-ws-golive-section');
        if (banner) banner.style.display = liveSessionId ? '' : 'none';
        if (goliveSection) goliveSection.style.display = liveSessionId ? 'none' : '';
    }
}

function _wsGetLiveSessionId(managedStreamId) {
    if (!broadcastState?.streams) return null;
    for (const [sid, ss] of broadcastState.streams) {
        if (ss.streamData?.managed_stream_id === managedStreamId) return sid;
    }
    return null;
}

/* ── Uptime helper ───────────────────────────────────────────── */

function _wsFormatUptime(startedAt) {
    if (!startedAt) return '0:00';
    const secs = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

/* ── Session history ─────────────────────────────────────────── */

async function _wsLoadHistory(managedStreamId) {
    const section = document.getElementById('bc-ws-history-section');
    const list = document.getElementById('bc-ws-history-list');
    if (!list) return;
    if (section) section.style.display = '';

    try {
        const data = await api(`/streams/managed/${managedStreamId}/history`);
        _wsState.history = data.sessions || [];
        _wsRenderHistory(_wsState.history);
    } catch {
        list.innerHTML = '<p class="muted">Could not load session history</p>';
    }
}

function _wsRenderHistory(sessions) {
    const list = document.getElementById('bc-ws-history-list');
    if (!list) return;

    if (!sessions.length) {
        list.innerHTML = '<p class="muted" style="padding:8px 0">No past sessions yet. Go live to create your first session.</p>';
        return;
    }

    list.innerHTML = sessions.map(s => {
        const date = new Date(s.started_at || s.created_at);
        const dur = _wsFormatDuration(s.duration_seconds || 0);
        const peakStr = s.peak_viewers != null
            ? `<span><i class="fa-solid fa-eye"></i> ${s.peak_viewers} peak</span>` : '';
        const vodStr = s.vod_id
            ? `<a class="btn btn-xs btn-outline" href="/vods/${s.vod_id}" target="_blank" rel="noopener">
                   <i class="fa-solid fa-film"></i> VOD</a>` : '';
        const liveStr = s.is_live
            ? '<span class="bc-live-badge" style="font-size:0.7rem"><i class="fa-solid fa-circle"></i> LIVE</span>' : '';
        return `
            <div class="bc-ws-session">
                <div class="bc-ws-session-left">
                    <div class="bc-ws-session-title">${esc(s.title || 'Untitled')} ${liveStr}</div>
                    <div class="bc-ws-session-meta">
                        <span><i class="fa-solid fa-calendar"></i> ${date.toLocaleDateString()}</span>
                        <span><i class="fa-solid fa-clock"></i> ${dur}</span>
                        ${peakStr}
                    </div>
                </div>
                <div class="bc-ws-session-right">${vodStr}</div>
            </div>`;
    }).join('');
}

function _wsFormatDuration(secs) {
    secs = Math.round(secs);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/* ── Managed stream CRUD helpers ─────────────────────────────── */

function showCreateManagedStreamModal() {
    // Reuse the create-managed-stream modal that the dashboard already has
    showModal('create-managed-stream');
}

function _wsConfirmDelete(managedStreamId) {
    const ms = _wsState.managedStreams.find(m => m.id === managedStreamId);
    if (!ms) return;
    if (!confirm(`Delete stream slot "${ms.title || 'Untitled'}"?\n\nPast sessions and VODs are not affected. This cannot be undone.`)) return;
    _wsDeleteManagedStream(managedStreamId);
}

async function _wsDeleteManagedStream(managedStreamId) {
    try {
        await api(`/streams/managed/${managedStreamId}`, { method: 'DELETE' });
        await _wsLoadManagedStreams();
        if (_wsState.selectedId === managedStreamId) {
            _wsState.selectedId = null;
            _wsState.selectedMs = null;
            _wsState.profile = {};
        }
        _wsRenderSidebar();
        if (_wsState.selectedId) {
            await _wsLoadProfile(_wsState.selectedId);
            _wsRenderPanel();
        } else {
            _wsShowEmpty();
        }
        toast('Stream slot deleted', 'success');
    } catch (err) {
        toast('Could not delete stream slot: ' + (err?.message || 'Server error'), 'error');
    }
}

/** Called after a new managed stream is created (e.g. from the dashboard modal) */
async function onManagedStreamCreated(newManagedStreamId) {
    await _wsLoadManagedStreams();
    _wsRenderSidebar();
    if (newManagedStreamId) await _wsSelectStream(newManagedStreamId);
}
