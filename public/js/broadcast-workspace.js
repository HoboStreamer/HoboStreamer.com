'use strict';
/* ═══════════════════════════════════════════════════════════════
   broadcast-workspace.js — Managed-stream workspace UI.

   State model (3 explicit classes):

   A. Persistent stream profile (server-backed, per managed stream):
      Structured columns: title, description, category, is_nsfw,
        protocol, control_config_id
        Saved via: PUT /streams/managed/:id
      Broadcast settings blob: bitrate, fps, resolution
        Saved via: PUT /streams/broadcast-settings

   B. Device-local preferences (this browser only):
      camera deviceId, mic deviceId
        Stored in: broadcastState.settings (unchanged)
        Labeled clearly in UI: "This Device Only"

   C. Live-session transient state (in-memory only):
      broadcastState.streams Map — active stream state,
        tracks, connections, timers, live session id
   ═══════════════════════════════════════════════════════════════ */

/* ── Workspace state ─────────────────────────────────────────── */

let _wsState = {
    managedStreams: [],
    selectedId: null,       // currently selected managed stream ID
    selectedMs: null,       // Class A structured fields (from managed_streams table)
    streamKey: null,        // per-managed-stream key (shown in endpoint tools)
    profile: {},            // Class A blob: { bitrate, fps, resolution }
    streamDirty: false,     // dirty: structured fields changed
    profileDirty: false,    // dirty: blob settings changed
    savingStream: false,
    savingProfile: false,
    streamAutosaveTimer: null,
    profileAutosaveTimer: null,
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
        list.innerHTML = '<p class="bc-ws-empty-hint muted">No stream slots yet.<br>Click <strong>+</strong> to create your first one.</p>';
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
    await _wsFlushPendingSaves();
    await _wsSelectStream(managedStreamId);
}

async function _wsFlushPendingSaves() {
    if (_wsState.streamAutosaveTimer) {
        clearTimeout(_wsState.streamAutosaveTimer);
        _wsState.streamAutosaveTimer = null;
        if (_wsState.streamDirty) await _wsSaveStreamFields();
    }
    if (_wsState.profileAutosaveTimer) {
        clearTimeout(_wsState.profileAutosaveTimer);
        _wsState.profileAutosaveTimer = null;
        if (_wsState.profileDirty) await _wsSaveProfile();
    }
}

async function _wsSelectStream(managedStreamId) {
    _wsState.selectedId = managedStreamId;
    _wsState.selectedMs = _wsState.managedStreams.find(ms => ms.id === managedStreamId) || null;
    _wsState.streamDirty = false;
    _wsState.profileDirty = false;
    _wsRenderSidebar();

    // Show loading state while fetching profile
    const panel = document.getElementById('bc-ws-panel');
    const empty = document.getElementById('bc-ws-empty');
    if (empty) empty.style.display = 'none';
    if (panel) {
        panel.style.display = '';
        panel.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading stream profile\u2026</div>';
    }

    await _wsLoadProfile(managedStreamId);
    _wsRenderPanel();
    _wsLoadHistory(managedStreamId);
}

// Single round-trip: structured fields + broadcast settings blob
async function _wsLoadProfile(managedStreamId) {
    try {
        const data = await api(`/streams/managed/${managedStreamId}/profile`);
        // Class A structured: merge into selectedMs
        if (data.managed_stream) {
            _wsState.selectedMs = { ..._wsState.selectedMs, ...data.managed_stream };
        }
        _wsState.streamKey = data.stream_key || null;
        // Class A blob: bitrate/fps/resolution only
        _wsState.profile = data.broadcast_settings || {};
    } catch {
        _wsState.profile = {};
        _wsState.streamKey = _wsState.selectedMs?.stream_key || null;
    }
    _wsState.streamDirty = false;
    _wsState.profileDirty = false;
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

    if (empty) empty.style.display = 'none';
    panel.style.display = '';

    const p = _wsState.profile;
    const isLive = _wsIsManagedStreamLive(ms.id);
    const method = ms.protocol || 'webrtc';
    const streamKey = _wsState.streamKey || '';

    // Class C: find active session
    let liveSessionId = null;
    let liveSessionData = null;
    if (broadcastState?.streams) {
        for (const [sid, ss] of broadcastState.streams) {
            if (ss.streamData?.managed_stream_id === ms.id) {
                liveSessionId = sid;
                liveSessionData = ss;
                break;
            }
        }
    }

    panel.innerHTML = `
        <!-- ── Panel header ── -->
        <div class="bc-ws-panel-hd">
            <div class="bc-ws-panel-title">
                <h2>${esc(ms.title || 'Untitled Stream')}</h2>
                ${ms.slug
                    ? `<span class="bc-ws-slug muted"><i class="fa-solid fa-link" style="font-size:0.7rem"></i> hobostreamer.com/${esc(ms.slug)}</span>`
                    : '<span class="bc-ws-slug muted">No URL slug set</span>'}
            </div>
            ${isLive ? '<span class="bc-live-badge bc-ws-live-badge-hd"><i class="fa-solid fa-circle"></i> LIVE</span>' : ''}
        </div>

        <!-- ── Live session banner ── -->
        <div id="bc-ws-live-banner" style="${liveSessionId ? '' : 'display:none'}">
            <div class="bc-ws-live-banner">
                <div class="bc-ws-live-banner-left">
                    <span class="bc-live-badge"><i class="fa-solid fa-circle"></i> LIVE</span>
                    <div class="bc-ws-uptime-wrap">
                        <i class="fa-solid fa-clock"></i>
                        <span id="bc-ws-uptime">${liveSessionId ? _wsFormatUptime(liveSessionData?.startedAt) : ''}</span>
                    </div>
                    ${liveSessionData?.streamData
                        ? `<span class="bc-ws-live-proto-badge">${esc((liveSessionData.streamData.protocol || '').toUpperCase())}</span>`
                        : ''}
                </div>
                <div class="bc-ws-live-banner-right">
                    <button class="btn btn-small" onclick="openViewerPreview()" title="Open viewer page">
                        <i class="fa-solid fa-eye"></i> View
                    </button>
                    <button class="btn btn-small btn-danger" onclick="stopBroadcast()">
                        <i class="fa-solid fa-stop"></i> End Stream
                    </button>
                </div>
            </div>
        </div>

        <!-- ── Stream Profile (Class A structured fields) ── -->
        <div class="bc-ws-profile-section">
            <div class="bc-ws-profile-hd">
                <h3><i class="fa-solid fa-sliders"></i> Stream Profile</h3>
                <span id="bc-ws-save-status" class="bc-ws-save-status"></span>
            </div>
            <p class="bc-ws-profile-note">
                <i class="fa-solid fa-cloud"></i> Saved to your stream slot &mdash; pre-fills your session when you go live.
            </p>

            <div class="form-group">
                <label>Default Title</label>
                <input type="text" id="bc-title" class="form-input"
                    value="${esc(ms.title || '')}"
                    placeholder="What are you streaming?" maxlength="200"
                    oninput="_wsStreamFieldChanged('title', this.value)">
            </div>

            <div class="form-group">
                <label>Description</label>
                <textarea id="bc-description" class="form-input" rows="2"
                    placeholder="Optional description\u2026" maxlength="500"
                    oninput="_wsStreamFieldChanged('description', this.value)">${esc(ms.description || '')}</textarea>
            </div>

            <div class="bc-ws-row">
                <div class="form-group" style="flex:2">
                    <label>Category</label>
                    <select id="bc-category" class="form-input" onchange="_wsStreamFieldChanged('category', this.value)">
                        ${_wsRenderCategoryOptions(ms.category || 'irl')}
                    </select>
                </div>
                <div class="form-group" style="flex:1">
                    <label>&nbsp;</label>
                    <label class="bc-toggle-label">
                        <input type="checkbox" id="bc-nsfw" ${ms.is_nsfw ? 'checked' : ''}
                            onchange="_wsStreamFieldChanged('is_nsfw', this.checked)">
                        <i class="fa-solid fa-triangle-exclamation" style="color:var(--danger)"></i> NSFW
                    </label>
                </div>
            </div>

            <!-- Streaming method (sets protocol column on managed stream) -->
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

            <!-- Video quality defaults (Class A blob) -->
            <details class="bc-ws-quality">
                <summary><i class="fa-solid fa-film"></i> Video Quality Defaults</summary>
                <div class="bc-ws-quality-inner bc-ws-row">
                    <div class="form-group" style="margin:0;flex:1">
                        <label style="font-size:0.82rem">Resolution</label>
                        <select class="form-input form-input-sm" onchange="_wsProfileFieldChanged('resolution', this.value)">
                            ${['360', '480', '720', '1080', '1440'].map(r =>
                                `<option value="${r}"${(p.resolution || '720') === r ? ' selected' : ''}>${r}p</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin:0;flex:1">
                        <label style="font-size:0.82rem">FPS</label>
                        <select class="form-input form-input-sm" onchange="_wsProfileFieldChanged('fps', this.value)">
                            ${['24', '30', '60'].map(f =>
                                `<option value="${f}"${(p.fps || '30') === f ? ' selected' : ''}>${f}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin:0;flex:2">
                        <label style="font-size:0.82rem">Bitrate (kbps)</label>
                        <input type="number" class="form-input form-input-sm"
                            value="${p.bitrate || 2500}" min="500" max="10000" step="100"
                            oninput="_wsProfileFieldChanged('bitrate', parseInt(this.value) || 2500)">
                    </div>
                </div>
            </details>

            <!-- Control profile (Class A structured) -->
            <div class="form-group">
                <label><i class="fa-solid fa-gamepad"></i> Control Profile</label>
                <select id="bc-control-config" class="form-input form-input-sm"
                    onchange="_wsStreamFieldChanged('control_config_id', parseInt(this.value) || null)">
                    <option value="">None (no controls)</option>
                </select>
            </div>

            <!-- Hidden element required by createNewStream() -->
            <select id="bc-managed-stream" style="display:none">
                <option value="${ms.id}" selected>${esc(ms.title || '')}</option>
            </select>
        </div>

        <!-- ── Endpoint & Key Tools ── -->
        <div class="bc-ws-endpoint-section">
            <div class="bc-ws-endpoint-hd">
                <h3><i class="fa-solid fa-plug"></i> Stream Endpoint &amp; Key</h3>
            </div>
            <p class="bc-ws-endpoint-note">
                This key belongs to <strong>${esc(ms.title || 'this stream slot')}</strong> &mdash;
                each slot has its own stable, reusable key.
                Regenerating will immediately invalidate the current key.
            </p>
            <div class="bc-ws-key-row">
                <div class="bc-ws-key-display">
                    <input type="password" id="bc-ws-stream-key" class="form-input form-input-sm bc-ws-key-input"
                        value="${esc(streamKey)}" readonly autocomplete="off" spellcheck="false"
                        aria-label="Stream key">
                    <button class="btn btn-small btn-ghost bc-ws-key-toggle"
                        onclick="_wsToggleKeyVisibility()" title="Show / hide key">
                        <i class="fa-solid fa-eye" id="bc-ws-key-eye"></i>
                    </button>
                    <button class="btn btn-small btn-ghost"
                        onclick="_wsCopyStreamKey()" title="Copy stream key">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
                <button class="btn btn-small btn-outline bc-ws-regen-btn"
                    onclick="_wsRegenerateKey(${ms.id})">
                    <i class="fa-solid fa-arrows-rotate"></i> Regen Key
                </button>
            </div>
            <div id="bc-ws-method-endpoint">${_wsRenderMethodEndpoint(method, streamKey)}</div>
        </div>

        <!-- ── Go Live section (hidden when live) ── -->
        <div class="bc-ws-golive-section" id="bc-ws-golive-section"${liveSessionId ? ' style="display:none"' : ''}>

            <!-- Class B: Device-local preferences (this browser only) -->
            <div id="bc-ws-device-wrap"${method !== 'webrtc' ? ' style="display:none"' : ''}>
                <div class="bc-ws-device-local-label">
                    <i class="fa-solid fa-laptop"></i>
                    <strong>This Device Only</strong>
                    <span class="muted">&mdash; camera &amp; mic selection is not saved to your stream profile</span>
                </div>
                <div id="bc-perm-request" class="bc-perm-request">
                    <p class="bc-perm-hint"><i class="fa-solid fa-shield-halved"></i>
                        Browser needs camera &amp; mic access to stream.</p>
                    <button id="bc-perm-btn" class="btn btn-outline" type="button"
                        onclick="requestMediaPermissions()">
                        <i class="fa-solid fa-video"></i> Allow Camera &amp; Mic
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

            <!-- Screen-share hidden defaults (set by broadcast settings if needed) -->
            <input type="checkbox" id="bc-screen-mic-enabled" checked style="display:none">
            <input type="checkbox" id="bc-screen-cam-enabled" style="display:none">
            <input type="checkbox" id="bc-screenPreferCurrentTab-create" style="display:none">
            <select id="bc-screenSystemAudio-create" style="display:none"><option value="include" selected>Include</option><option value="auto">Auto</option><option value="exclude">Exclude</option></select>
            <select id="bc-screenSelfBrowser-create" style="display:none"><option value="exclude" selected>Exclude</option><option value="include">Include</option></select>
            <select id="bc-screenSurfaceSwitching-create" style="display:none"><option value="include" selected>Allow</option><option value="exclude">Disallow</option></select>
            <select id="bc-screen-audio" style="display:none"><option value="default">Default</option></select>
            <select id="bc-screen-camera" style="display:none"><option value="default">Default</option></select>

            <button class="btn btn-primary btn-lg bc-ws-golive-btn"
                onclick="goLiveFromWorkspace()" id="bc-ws-golive-btn">
                <i class="fa-solid fa-tower-broadcast"></i> Go Live
            </button>
            <p class="bc-create-reassurance" style="margin-top:6px;font-size:0.82rem">
                <i class="fa-solid fa-circle-info"></i>
                Live at <strong>hobostreamer.com/${esc(ms.slug || (typeof currentUser !== 'undefined' && currentUser?.username) || 'your-channel')}</strong>
            </p>
        </div>

        <!-- ── Session history ── -->
        <div class="bc-ws-history-section" id="bc-ws-history-section">
            <h3><i class="fa-solid fa-clock-rotate-left"></i> Recent Sessions</h3>
            <div id="bc-ws-history-list" class="bc-ws-history-list">
                <p class="muted" style="padding:12px 0"><i class="fa-solid fa-spinner fa-spin"></i> Loading\u2026</p>
            </div>
        </div>
    `;

    // Async post-render: populate control configs and check device permissions
    _wsPopulateControlConfigs(ms.control_config_id);
    _wsInitDevicePicker(method);
}

/* ── Category options ────────────────────────────────────────── */

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

/* ── Method-specific endpoint info ───────────────────────────── */

function _wsRenderMethodEndpoint(method, streamKey) {
    if (!streamKey) return '';

    if (method === 'rtmp') {
        const rtmpServer = 'rtmp://hobostreamer.com/live';
        return `
        <div class="bc-ws-method-info">
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">RTMP Server</span>
                <div class="bc-ws-method-info-val">
                    <code>${esc(rtmpServer)}</code>
                    <button class="btn btn-xs btn-ghost" onclick="_wsCopyText('${esc(rtmpServer)}')" title="Copy">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">Stream Key</span>
                <span class="bc-ws-method-info-note">Use the key shown above</span>
            </div>
            <p class="bc-ws-method-info-hint">OBS &rarr; Settings &rarr; Stream &rarr; Service: Custom &rarr; paste server &amp; key above.</p>
        </div>`;
    }

    if (method === 'webrtc') {
        const whipUrl = `https://whip.hobostreamer.com/whip/${streamKey}`;
        return `
        <div class="bc-ws-method-info">
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">Browser</span>
                <span class="bc-ws-method-info-note">Use the Go Live button below &mdash; no extra config needed.</span>
            </div>
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">WHIP (OBS)</span>
                <div class="bc-ws-method-info-val">
                    <code>${esc(whipUrl)}</code>
                    <button class="btn btn-xs btn-ghost" onclick="_wsCopyText('${esc(whipUrl)}')" title="Copy WHIP URL">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
            <p class="bc-ws-method-info-hint">OBS &rarr; Settings &rarr; Stream &rarr; Service: WHIP &rarr; paste URL above. No separate key needed for WHIP.</p>
        </div>`;
    }

    if (method === 'jsmpeg') {
        return `
        <div class="bc-ws-method-info">
            <p class="bc-ws-method-info-hint">
                jsmpeg streams use dynamic ports assigned per session. Start the stream first, then
                copy the full FFmpeg command from the live control panel.
            </p>
        </div>`;
    }

    return '';
}

/* ── Device picker init (Class B) ────────────────────────────── */

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
            await populateCreateFormDevices();
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
            opt.textContent = `${cfg.name} (${cfg.button_count || 0} buttons)`;
            if (cfg.id === selectedId) opt.selected = true;
            select.appendChild(opt);
        });
    } catch { /* leave as None */ }
}

/* ── Stream key tools ────────────────────────────────────────── */

function _wsToggleKeyVisibility() {
    const input = document.getElementById('bc-ws-stream-key');
    const eye = document.getElementById('bc-ws-key-eye');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    if (eye) {
        eye.classList.toggle('fa-eye', input.type === 'password');
        eye.classList.toggle('fa-eye-slash', input.type === 'text');
    }
}

function _wsCopyStreamKey() {
    const key = _wsState.streamKey;
    if (!key) { toast('No stream key available', 'error'); return; }
    _wsCopyText(key, 'Stream key copied');
}

function _wsCopyText(text, message) {
    navigator.clipboard.writeText(text).then(() => {
        toast(message || 'Copied!', 'success');
    }).catch(() => {
        prompt('Copy the value manually:', text);
    });
}

async function _wsRegenerateKey(managedStreamId) {
    if (!confirm('Regenerate stream key?\n\nThis will immediately invalidate the current key. Any active connections using the old key will be disconnected.')) return;
    try {
        const data = await api(`/streams/managed/${managedStreamId}/regenerate-key`, { method: 'POST' });
        _wsState.streamKey = data.stream_key;
        const input = document.getElementById('bc-ws-stream-key');
        if (input) input.value = data.stream_key;
        // Refresh method endpoint (WHIP URL contains the key)
        const methodEl = document.getElementById('bc-ws-method-endpoint');
        if (methodEl && _wsState.selectedMs) {
            methodEl.innerHTML = _wsRenderMethodEndpoint(_wsState.selectedMs.protocol || 'webrtc', data.stream_key);
        }
        toast('Stream key regenerated', 'success');
    } catch (err) {
        toast(err?.message || 'Failed to regenerate key', 'error');
    }
}

/* ── Class A: Structured stream field save ───────────────────── */
// title, description, category, is_nsfw, protocol, control_config_id
// → PUT /streams/managed/:id

function _wsStreamFieldChanged(key, value) {
    if (!_wsState.selectedMs) return;
    if (key === 'is_nsfw') value = value ? 1 : 0;
    _wsState.selectedMs[key] = value;
    _wsState.streamDirty = true;
    _wsShowSaveStatus('Unsaved\u2026');
    _wsScheduleStreamAutosave();
}

function _wsSelectMethod(method) {
    _wsStreamFieldChanged('protocol', method);
    document.querySelectorAll('[data-wsmethod]').forEach(el =>
        el.classList.toggle('selected', el.dataset.wsmethod === method)
    );
    const wrap = document.getElementById('bc-ws-device-wrap');
    if (wrap) wrap.style.display = method !== 'webrtc' ? 'none' : '';
    const methodEl = document.getElementById('bc-ws-method-endpoint');
    if (methodEl) methodEl.innerHTML = _wsRenderMethodEndpoint(method, _wsState.streamKey || '');
    broadcastState.selectedMethod = method;
    _wsInitDevicePicker(method);
}

function _wsScheduleStreamAutosave() {
    if (_wsState.streamAutosaveTimer) clearTimeout(_wsState.streamAutosaveTimer);
    _wsState.streamAutosaveTimer = setTimeout(_wsSaveStreamFields, 1200);
}

async function _wsSaveStreamFields() {
    _wsState.streamAutosaveTimer = null;
    if (!_wsState.selectedId || _wsState.savingStream || !_wsState.streamDirty) return;
    _wsState.savingStream = true;
    _wsShowSaveStatus('Saving\u2026');
    const ms = _wsState.selectedMs;
    try {
        const updated = await api(`/streams/managed/${_wsState.selectedId}`, {
            method: 'PUT',
            body: {
                title: ms.title,
                description: ms.description,
                category: ms.category,
                is_nsfw: ms.is_nsfw ? 1 : 0,
                protocol: ms.protocol,
                control_config_id: ms.control_config_id || null,
            },
        });
        if (updated.managed_stream) {
            _wsState.selectedMs = { ..._wsState.selectedMs, ...updated.managed_stream };
            const idx = _wsState.managedStreams.findIndex(m => m.id === _wsState.selectedId);
            if (idx !== -1) _wsState.managedStreams[idx] = { ..._wsState.managedStreams[idx], ...updated.managed_stream };
            _wsRenderSidebar();
        }
        _wsState.streamDirty = false;
        _wsShowSaveStatus('Saved \u2713');
        setTimeout(() => { if (!_wsState.streamDirty && !_wsState.profileDirty) _wsShowSaveStatus(''); }, 2000);
    } catch {
        _wsShowSaveStatus('Save failed');
    } finally {
        _wsState.savingStream = false;
    }
}

/* ── Class A: Broadcast settings blob save ───────────────────── */
// bitrate, fps, resolution
// → PUT /streams/broadcast-settings

function _wsProfileFieldChanged(key, value) {
    _wsState.profile[key] = value;
    _wsState.profileDirty = true;
    _wsShowSaveStatus('Unsaved\u2026');
    _wsScheduleProfileAutosave();
}

function _wsScheduleProfileAutosave() {
    if (_wsState.profileAutosaveTimer) clearTimeout(_wsState.profileAutosaveTimer);
    _wsState.profileAutosaveTimer = setTimeout(_wsSaveProfile, 1200);
}

async function _wsSaveProfile() {
    _wsState.profileAutosaveTimer = null;
    if (!_wsState.selectedId || _wsState.savingProfile || !_wsState.profileDirty) return;
    _wsState.savingProfile = true;
    _wsShowSaveStatus('Saving\u2026');
    try {
        await api('/streams/broadcast-settings', {
            method: 'PUT',
            body: { managed_stream_id: _wsState.selectedId, settings: _wsState.profile },
        });
        _wsState.profileDirty = false;
        _wsShowSaveStatus('Saved \u2713');
        setTimeout(() => { if (!_wsState.streamDirty && !_wsState.profileDirty) _wsShowSaveStatus(''); }, 2000);
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
    await _wsFlushPendingSaves();

    const p = _wsState.profile;
    const ms = _wsState.selectedMs;

    // Apply quality defaults from saved profile into broadcastState
    if (p.resolution) broadcastState.settings.broadcastRes = String(p.resolution);
    if (p.fps) broadcastState.settings.broadcastFps = String(p.fps);
    if (p.bitrate) broadcastState.settings.broadcastBps = String(p.bitrate);

    const method = ms.protocol || 'webrtc';
    broadcastState.selectedMethod = method;
    broadcastState.selectedWebRTCSub = 'browser';
    broadcastState.selectedBrowserSource = 'camera';

    // Class B: sync local device selection
    const camSel = document.getElementById('bc-create-camera');
    const audSel = document.getElementById('bc-create-audio');
    if (camSel && camSel.value) _syncCameraSelectionUI(camSel.value, { persist: false });
    if (audSel && audSel.value) _syncAudioSelectionUI(audSel.value, { persist: false });

    // bc-title, bc-description, bc-category, bc-nsfw, bc-managed-stream, bc-control-config
    // are already in the workspace panel DOM — createNewStream() reads them directly.
    await createNewStream();
}

/* ── Live status refresh (called from broadcast.js) ─────────── */

function updateWorkspaceLiveStatus() {
    _wsRenderSidebar();
    if (!_wsState.selectedId) return;
    const liveSessionId = _wsGetLiveSessionId(_wsState.selectedId);
    const banner = document.getElementById('bc-ws-live-banner');
    const goliveSection = document.getElementById('bc-ws-golive-section');
    if (banner) banner.style.display = liveSessionId ? '' : 'none';
    if (goliveSection) goliveSection.style.display = liveSessionId ? 'none' : '';
}

function _wsGetLiveSessionId(managedStreamId) {
    if (!broadcastState?.streams) return null;
    for (const [sid, ss] of broadcastState.streams) {
        if (ss.streamData?.managed_stream_id === managedStreamId) return sid;
    }
    return null;
}

/* ── Uptime ──────────────────────────────────────────────────── */

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
    const list = document.getElementById('bc-ws-history-list');
    if (!list) return;

    try {
        const data = await api(`/streams/managed/${managedStreamId}/history`);
        _wsState.history = data.sessions || [];
        _wsRenderHistory(_wsState.history);
    } catch {
        list.innerHTML = '<p class="muted">Could not load session history.</p>';
    }
}

function _wsRenderHistory(sessions) {
    const list = document.getElementById('bc-ws-history-list');
    if (!list) return;

    if (!sessions.length) {
        list.innerHTML = '<p class="muted" style="padding:8px 0">No past sessions yet. Go live to start your first session.</p>';
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
        const proto = s.protocol ? `<span class="bc-ws-item-proto">${esc(s.protocol.toUpperCase())}</span>` : '';
        return `
            <div class="bc-ws-session">
                <div class="bc-ws-session-left">
                    <div class="bc-ws-session-title">${esc(s.title || 'Untitled')} ${liveStr}</div>
                    <div class="bc-ws-session-meta">
                        ${proto}
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
    showModal('create-managed-stream');
}

function _wsConfirmDelete(managedStreamId) {
    const ms = _wsState.managedStreams.find(m => m.id === managedStreamId);
    if (!ms) return;
    if (_wsIsManagedStreamLive(managedStreamId)) {
        toast('Cannot delete a live stream slot. End the stream first.', 'error');
        return;
    }
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
            _wsState.streamKey = null;
            _wsState.profile = {};
        }
        _wsRenderSidebar();
        if (_wsState.managedStreams.length > 0) {
            await _wsSelectStream(_wsState.managedStreams[0].id);
        } else {
            _wsShowEmpty();
        }
        toast('Stream slot deleted', 'success');
    } catch (err) {
        toast('Could not delete: ' + (err?.message || 'Server error'), 'error');
    }
}

/** Called after a new managed stream is created (e.g. from the create modal) */
async function onManagedStreamCreated(newManagedStreamId) {
    await _wsLoadManagedStreams();
    _wsRenderSidebar();
    if (newManagedStreamId) await _wsSelectStream(newManagedStreamId);
}
