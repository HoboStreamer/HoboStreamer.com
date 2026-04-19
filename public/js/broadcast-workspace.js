'use strict';
/* ═══════════════════════════════════════════════════════════════
   broadcast-workspace.js — Managed-stream workspace UI.

   State model (3 explicit classes):

   A. Persistent stream profile (server-backed, per managed stream):
      Structured columns: title, description, category, is_nsfw,
        protocol, control_config_id, slug
        Saved via: PUT /streams/managed/:id  (manual Save button)
      Broadcast settings blob: bitrate, fps, resolution, browserMode,
        micOnlyImage, screenShareOpts
        Saved via: PUT /streams/broadcast-settings  (manual Save button)

   B. Device-local preferences (this browser only):
      camera deviceId, mic deviceId, screen audio prefs
        Stored in: localStorage
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
    profile: {},            // Class A blob: { bitrate, fps, resolution, browserMode, ... }
    dirty: false,           // any unsaved change (stream fields or profile blob)
    saving: false,
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
        const proto = _wsMethodLabel(ms.streaming_method || ms.protocol);
        return `
            <div class="bc-ws-item${isSelected ? ' selected' : ''}" onclick="wsSelectStream(${ms.id})">
                <div class="bc-ws-item-status${isLive ? ' live' : ''}"></div>
                <div class="bc-ws-item-body">
                    <div class="bc-ws-item-name">${esc(ms.title || 'Untitled')}</div>
                    <div class="bc-ws-item-meta">
                        <span class="bc-ws-item-proto">${esc(proto)}</span>
                        ${ms.slug ? `<span class="bc-ws-item-slug">/${esc(ms.slug)}</span>` : `<span class="bc-ws-item-slug">#${ms.id}</span>`}
                        ${isLive ? '<span class="bc-ws-live-dot"><i class="fa-solid fa-circle"></i> LIVE</span>' : ''}
                    </div>
                </div>
                <button class="bc-ws-item-del" onclick="event.stopPropagation();_wsConfirmDelete(${ms.id})" title="Delete slot">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`;
    }).join('');
}

/** Human-readable method label for sidebar/panel */
function _wsMethodLabel(method) {
    if (method === 'browser') return 'Browser';
    if (method === 'whip') return 'WHIP';
    if (method === 'rtmp') return 'RTMP';
    if (method === 'cli') return 'CLI / FFmpeg';
    // Legacy protocol fallback
    if (method === 'webrtc') return 'Browser';
    if (method === 'jsmpeg') return 'CLI / FFmpeg';
    return (method || 'browser').toUpperCase();
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
    if (_wsState.dirty) {
        if (!confirm('You have unsaved changes. Discard them?')) return;
    }
    await _wsSelectStream(managedStreamId);
}

async function _wsSelectStream(managedStreamId) {
    _wsState.selectedId = managedStreamId;
    _wsState.selectedMs = _wsState.managedStreams.find(ms => ms.id === managedStreamId) || null;
    _wsState.dirty = false;
    _wsRenderSidebar();

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

async function _wsLoadProfile(managedStreamId) {
    try {
        const data = await api(`/streams/managed/${managedStreamId}/profile`);
        if (data.managed_stream) {
            _wsState.selectedMs = { ..._wsState.selectedMs, ...data.managed_stream };
        }
        _wsState.streamKey = data.stream_key || null;
        _wsState.profile = data.broadcast_settings || {};
        _wsState.whipUrlBase = data.whip_url_base || null;
        _wsState.whipUrlSource = data.whip_url_source || null;
        _wsState.whipUrlWarning = data.whip_url_warning || null;
    } catch {
        _wsState.profile = {};
        _wsState.streamKey = _wsState.selectedMs?.stream_key || null;
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

    if (empty) empty.style.display = 'none';
    panel.style.display = '';

    const p = _wsState.profile;
    const isLive = _wsIsManagedStreamLive(ms.id);
    const method = ms.streaming_method || 'browser';
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

    // Determine browser submode from managed stream or profile
    const browserMode = ms.browser_mode || p.browserMode || 'camera';

    panel.innerHTML = `
        <!-- ── Panel header ── -->
        <div class="bc-ws-panel-hd">
            <div class="bc-ws-panel-title">
                <h2>${esc(ms.title || 'Untitled Stream')}</h2>
                <span class="bc-ws-slug muted">
                    ${currentUser?.username
                        ? `<i class="fa-solid fa-link" style="font-size:0.7rem"></i> hobostreamer.com${channelPath(currentUser.username, ms.slug || ms.id)}`
                        : ms.slug
                            ? `<i class="fa-solid fa-link" style="font-size:0.7rem"></i> hobostreamer.com/${esc(ms.slug)}`
                            : `<i class="fa-solid fa-hashtag" style="font-size:0.7rem"></i> Stream #${ms.id}`}
                </span>
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
                        ? `<span class="bc-ws-live-proto-badge">${esc(_wsMethodLabel(liveSessionData.streamData.protocol))}</span>`
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

        <!-- ── Stream Profile (Class A) ── -->
        <div class="bc-ws-profile-section">
            <div class="bc-ws-profile-hd">
                <h3><i class="fa-solid fa-sliders"></i> Stream Profile</h3>
                <div class="bc-ws-save-row">
                    <span id="bc-ws-save-status" class="bc-ws-save-status"></span>
                    <button class="btn btn-primary btn-small bc-ws-save-btn" id="bc-ws-save-btn"
                        onclick="_wsSaveAll()" disabled>
                        <i class="fa-solid fa-floppy-disk"></i> Save
                    </button>
                </div>
            </div>

            <div class="form-group">
                <label>Title</label>
                <input type="text" id="bc-title" class="form-input"
                    value="${esc(ms.title || '')}"
                    placeholder="What are you streaming?" maxlength="200"
                    oninput="_wsMarkDirty()">
            </div>

            <div class="form-group">
                <label>Description</label>
                <textarea id="bc-description" class="form-input" rows="2"
                    placeholder="Optional description\u2026" maxlength="500"
                    oninput="_wsMarkDirty()">${esc(ms.description || '')}</textarea>
            </div>

            <div class="bc-ws-row">
                <div class="form-group" style="flex:2">
                    <label>Category</label>
                    <select id="bc-category" class="form-input" onchange="_wsMarkDirty()">
                        ${_wsRenderCategoryOptions(ms.category || 'irl')}
                    </select>
                </div>
                <div class="form-group" style="flex:1">
                    <label>&nbsp;</label>
                    <label class="bc-toggle-label">
                        <input type="checkbox" id="bc-nsfw" ${ms.is_nsfw ? 'checked' : ''}
                            onchange="_wsMarkDirty()">
                        <i class="fa-solid fa-triangle-exclamation" style="color:var(--danger)"></i> NSFW
                    </label>
                </div>
            </div>

            <!-- URL Slug -->
            <div class="form-group">
                <label>URL Slug <span class="muted">(optional, for display URL)</span></label>
                <div style="display:flex;align-items:center;gap:6px">
                    <span class="muted" style="font-size:0.82rem;white-space:nowrap">hobostreamer.com/@${esc(currentUser?.username || '')}/</span>
                    <input type="text" id="bc-slug" class="form-input form-input-sm"
                        value="${esc(ms.slug || '')}" placeholder="my-stream" maxlength="32"
                        oninput="_wsMarkDirty()">
                </div>
                <small class="muted">2-32 chars, starts with a letter. Numeric ID #${ms.id} is always valid.</small>
            </div>

            <!-- ═══ Streaming Method ═══ -->
            <div class="form-group">
                <label>Streaming Method</label>
                <div class="bc-method-picker bc-method-picker-sm" id="bc-ws-method-picker">
                    ${_wsRenderMethodCards(method)}
                </div>
            </div>

            <!-- ═══ Browser Sub-mode (only when method is browser) ═══ -->
            <div id="bc-ws-browser-submodes" style="${method === 'browser' ? '' : 'display:none'}">
                <div class="form-group">
                    <label>Browser Capture Mode</label>
                    <div class="bc-method-picker bc-method-picker-sm" id="bc-ws-browser-mode-picker">
                        ${_wsRenderBrowserModeCards(browserMode)}
                    </div>
                </div>

                <!-- Microphone Only: image upload -->
                <div id="bc-ws-mic-only-opts" style="${browserMode === 'mic_only' ? '' : 'display:none'}">
                    <div class="form-group">
                        <label><i class="fa-solid fa-image"></i> Placeholder Image</label>
                        <p class="muted" style="font-size:0.82rem;margin-bottom:6px">
                            Displayed to viewers instead of video. Recommended: square, 400\u00d7400+.
                        </p>
                        <input type="file" id="bc-ws-mic-image" accept="image/*" class="form-input form-input-sm"
                            onchange="_wsMicImageChanged(this)">
                        <div id="bc-ws-mic-image-preview" class="bc-ws-mic-image-preview">
                            ${p.micOnlyImage ? `<img src="${esc(p.micOnlyImage)}" alt="Mic-only placeholder">` : ''}
                        </div>
                    </div>
                </div>

                <!-- Screen Share options -->
                <div id="bc-ws-screen-opts" style="${browserMode === 'screen' ? '' : 'display:none'}">
                    <p class="muted" style="font-size:0.82rem;margin-bottom:8px">
                        <i class="fa-solid fa-circle-info"></i>
                        Available capture options depend on your browser and OS.
                        Chrome/Edge support tab audio and system audio capture.
                        Firefox supports window/screen but not tab audio.
                        Mobile browsers have limited screen capture support.
                    </p>
                    <div class="bc-ws-row">
                        <label class="bc-toggle-label" style="flex:1">
                            <input type="checkbox" id="bc-ws-screen-mic" checked onchange="_wsMarkDirty()">
                            <i class="fa-solid fa-microphone"></i> Microphone
                        </label>
                        <label class="bc-toggle-label" style="flex:1">
                            <input type="checkbox" id="bc-ws-screen-cam" onchange="_wsMarkDirty()">
                            <i class="fa-solid fa-video"></i> Camera PiP
                        </label>
                    </div>
                    <div class="bc-ws-row" style="margin-top:8px">
                        <label class="bc-toggle-label" style="flex:1">
                            <input type="checkbox" id="bc-ws-screen-sysaudio" checked onchange="_wsMarkDirty()">
                            <i class="fa-solid fa-volume-high"></i> System/Tab Audio
                        </label>
                    </div>
                </div>
            </div>

            <!-- Video quality defaults (Class A blob) -->
            <details class="bc-ws-quality">
                <summary><i class="fa-solid fa-film"></i> Video Quality Defaults</summary>
                <div class="bc-ws-quality-inner bc-ws-row">
                    <div class="form-group" style="margin:0;flex:1">
                        <label style="font-size:0.82rem">Resolution</label>
                        <select id="bc-ws-resolution" class="form-input form-input-sm" onchange="_wsMarkDirty()">
                            ${['360', '480', '720', '1080', '1440'].map(r =>
                                `<option value="${r}"${(p.resolution || '720') === r ? ' selected' : ''}>${r}p</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin:0;flex:1">
                        <label style="font-size:0.82rem">FPS</label>
                        <select id="bc-ws-fps" class="form-input form-input-sm" onchange="_wsMarkDirty()">
                            ${['24', '30', '60'].map(f =>
                                `<option value="${f}"${(p.fps || '30') === f ? ' selected' : ''}>${f}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin:0;flex:2">
                        <label style="font-size:0.82rem">Bitrate (kbps)</label>
                        <input type="number" id="bc-ws-bitrate" class="form-input form-input-sm"
                            value="${p.bitrate || 2500}" min="500" max="10000" step="100"
                            oninput="_wsMarkDirty()">
                    </div>
                </div>
            </details>

            <!-- Control profile (Class A structured) -->
            <div class="form-group">
                <label><i class="fa-solid fa-gamepad"></i> Control Profile</label>
                <select id="bc-control-config" class="form-input form-input-sm"
                    onchange="_wsMarkDirty()">
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
                This key belongs to <strong>${esc(ms.title || 'this stream slot')}</strong>.
                Each slot has its own stable key. Regenerating invalidates the current key immediately.
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
            <div id="bc-ws-method-endpoint">${_wsRenderMethodEndpoint(method, streamKey, ms.id)}</div>
        </div>

        <!-- ── Go Live section (hidden when live) ── -->
        <div class="bc-ws-golive-section" id="bc-ws-golive-section"${liveSessionId ? ' style="display:none"' : ''}>

            <!-- Class B: Device-local preferences (browser/webrtc only) -->
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
                        <div class="form-group" style="margin:0;flex:1" id="bc-ws-camera-group">
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

            <!-- Screen-share hidden defaults -->
            <input type="checkbox" id="bc-screen-mic-enabled" checked style="display:none">
            <input type="checkbox" id="bc-screen-cam-enabled" style="display:none">
            <input type="checkbox" id="bc-screenPreferCurrentTab-create" style="display:none">
            <select id="bc-screenSystemAudio-create" style="display:none"><option value="include" selected>Include</option><option value="auto">Auto</option><option value="exclude">Exclude</option></select>
            <select id="bc-screenSelfBrowser-create" style="display:none"><option value="exclude" selected>Exclude</option><option value="include">Include</option></select>
            <select id="bc-screenSurfaceSwitching-create" style="display:none"><option value="include" selected>Allow</option><option value="exclude">Disallow</option></select>
            <select id="bc-screen-audio" style="display:none"><option value="default">Default</option></select>
            <select id="bc-screen-camera" style="display:none"><option value="default">Default</option></select>

            <!-- ═══ Slot-Level Settings ═══ -->
            <details class="bc-ws-slot-settings">
                <summary><i class="fa-solid fa-gear"></i> Stream Slot Settings</summary>
                <div class="bc-ws-slot-settings-inner">
                    <div class="bc-ws-row">
                        <div class="form-group" style="flex:1">
                            <label>Default VOD Visibility</label>
                            <select id="bc-ws-vod-visibility" class="form-input" onchange="_wsSlotSettingChanged()">
                                <option value="public" ${(ms.default_vod_visibility || 'public') === 'public' ? 'selected' : ''}>Public</option>
                                <option value="private" ${ms.default_vod_visibility === 'private' ? 'selected' : ''}>Private</option>
                            </select>
                        </div>
                        <div class="form-group" style="flex:1">
                            <label>Default Clip Visibility</label>
                            <select id="bc-ws-clip-visibility" class="form-input" onchange="_wsSlotSettingChanged()">
                                <option value="public" ${(ms.default_clip_visibility || 'public') === 'public' ? 'selected' : ''}>Public</option>
                                <option value="private" ${ms.default_clip_visibility === 'private' ? 'selected' : ''}>Private</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="bc-toggle-label">
                            <input type="checkbox" id="bc-ws-vod-recording" ${ms.slot_vod_recording_enabled !== 0 ? 'checked' : ''}
                                onchange="_wsSlotSettingChanged()">
                            <i class="fa-solid fa-circle-dot"></i> VOD Recording Enabled
                        </label>
                    </div>
                    <div class="bc-ws-row">
                        <div class="form-group" style="flex:2">
                            <label><i class="fa-solid fa-cloud-sun"></i> Weather Zip/Location</label>
                            <input type="text" id="bc-ws-weather-zip" class="form-input form-input-sm"
                                value="${esc(ms.weather_zip || '')}" placeholder="e.g. 90210"
                                maxlength="20" oninput="_wsSlotSettingChanged()">
                        </div>
                        <div class="form-group" style="flex:1">
                            <label>Detail Level</label>
                            <select id="bc-ws-weather-detail" class="form-input" onchange="_wsSlotSettingChanged()">
                                <option value="basic" ${(ms.weather_detail || 'basic') === 'basic' ? 'selected' : ''}>Basic</option>
                                <option value="detailed" ${ms.weather_detail === 'detailed' ? 'selected' : ''}>Detailed</option>
                                <option value="off" ${ms.weather_detail === 'off' ? 'selected' : ''}>Off</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="bc-toggle-label">
                            <input type="checkbox" id="bc-ws-weather-location" ${ms.weather_show_location ? 'checked' : ''}
                                onchange="_wsSlotSettingChanged()">
                            <i class="fa-solid fa-map-marker-alt"></i> Show Location on Stream
                        </label>
                    </div>
                </div>
            </details>

            ${method === 'browser' ? `
            <button class="btn btn-primary btn-lg bc-ws-golive-btn"
                onclick="goLiveFromWorkspace()" id="bc-ws-golive-btn">
                <i class="fa-solid fa-tower-broadcast"></i> Go Live
            </button>
            ` : `
            <button class="btn btn-primary btn-lg bc-ws-golive-btn"
                onclick="goLiveFromWorkspace()" id="bc-ws-golive-btn">
                <i class="fa-solid fa-tower-broadcast"></i> Start Stream Session
            </button>
            `}
            <p class="bc-create-reassurance" style="margin-top:6px;font-size:0.82rem">
                <i class="fa-solid fa-circle-info"></i>
                Live at <strong>hobostreamer.com${channelPath(currentUser?.username || 'your-channel', ms.slug || ms.id)}</strong>
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
    _wsInitDevicePicker(method, browserMode);
    _wsSyncScreenShareHiddenDefaults(browserMode);
}

/* ── Method cards ────────────────────────────────────────────── */

function _wsRenderMethodCards(selected) {
    const methods = [
        { id: 'browser', icon: 'globe', label: 'Browser', hint: 'Camera, mic, or screen from your browser' },
        { id: 'whip', icon: 'satellite-dish', label: 'WHIP', hint: 'OBS WHIP encoder / external WebRTC' },
        { id: 'rtmp', icon: 'server', label: 'RTMP', hint: 'OBS / Streamlabs / IRL Pro' },
        { id: 'cli', icon: 'terminal', label: 'CLI / FFmpeg', hint: 'FFmpeg, Pi, RTSP cameras' },
    ];
    return methods.map(m => `
        <div class="bc-method-card-sm${selected === m.id ? ' selected' : ''}"
            data-wsmethod="${m.id}" onclick="_wsSelectMethod('${m.id}')">
            <i class="fa-solid fa-${m.icon}"></i>
            <strong>${m.label}</strong>
            <span class="bc-card-sm-hint">${m.hint}</span>
        </div>`).join('');
}

function _wsRenderBrowserModeCards(selected) {
    const modes = [
        { id: 'camera', icon: 'video', label: 'Camera & Mic', hint: 'Webcam + microphone' },
        { id: 'camera_only', icon: 'camera', label: 'Camera Only', hint: 'Video only, no audio' },
        { id: 'mic_only', icon: 'microphone', label: 'Mic Only', hint: 'Audio-only with image' },
        { id: 'screen', icon: 'display', label: 'Screen Share', hint: 'Tab, window, or display' },
    ];
    return modes.map(m => `
        <div class="bc-method-card-sm${selected === m.id ? ' selected' : ''}"
            data-wsbrowsermode="${m.id}" onclick="_wsSelectBrowserMode('${m.id}')">
            <i class="fa-solid fa-${m.icon}"></i>
            <strong>${m.label}</strong>
            <span class="bc-card-sm-hint">${m.hint}</span>
        </div>`).join('');
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

function _wsRenderMethodEndpoint(method, streamKey, managedStreamId) {
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
            <p class="bc-ws-method-info-hint">
                <strong>OBS:</strong> Settings &rarr; Stream &rarr; Service: Custom &rarr; paste server &amp; key above.<br>
                <strong>Streamlabs / IRL Pro:</strong> Use Custom RTMP with the same server &amp; key.
            </p>
        </div>`;
    }

    if (method === 'browser') {
        return `
        <div class="bc-ws-method-info">
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">Browser Streaming</span>
                <span class="bc-ws-method-info-note">Use the Go Live button below &mdash; no extra config needed.</span>
            </div>
            <p class="bc-ws-method-info-hint">
                Your browser will capture camera, microphone, and/or screen depending on your selected capture mode above.
                Make sure to allow permissions when prompted.
            </p>
        </div>`;
    }

    if (method === 'whip') {
        const whipBaseUrl = (_wsState.whipUrlBase || window.location.origin).replace(/\/$/, '');
        const whipUrl = `${whipBaseUrl}/whip/${managedStreamId || streamKey}`;
        return `
        <div class="bc-ws-method-info">
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">WHIP URL</span>
                <div class="bc-ws-method-info-val">
                    <code style="word-break:break-all">${esc(whipUrl)}</code>
                    <button class="btn btn-xs btn-ghost" onclick="_wsCopyText('${esc(whipUrl)}')" title="Copy WHIP URL">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">Bearer Token</span>
                <span class="bc-ws-method-info-note">Use the stream key shown above as the Bearer Token in OBS.</span>
            </div>
            <p class="bc-ws-method-info-hint">
                <strong>OBS WHIP setup:</strong> Settings &rarr; Stream &rarr; Service: WHIP &rarr; paste URL above.
                Set Bearer Token to your stream key. Click "Start Stream Session" here first, then start OBS.
            </p>
        </div>`;
    }

    if (method === 'cli') {
        return `
        <div class="bc-ws-method-info">
            <h4 style="margin:8px 0 4px"><i class="fa-solid fa-terminal"></i> CLI / FFmpeg Streaming</h4>
            <p class="bc-ws-method-info-hint" style="margin-bottom:12px">
                Start a stream session first, then copy the FFmpeg command from the live control panel.
                The endpoint ports are assigned dynamically per session.
            </p>

            <details class="bc-ws-cli-examples">
                <summary><i class="fa-solid fa-book"></i> FFmpeg Examples &amp; Commands</summary>
                <div class="bc-ws-cli-examples-inner">
                    <h5>jsmpeg (Lowest Latency)</h5>
                    <p class="muted" style="font-size:0.82rem">Ports are shown after you click "Start Stream Session".</p>
                    <pre class="bc-ws-cli-code">ffmpeg -f v4l2 -framerate 24 -i /dev/video0 \\
  -f alsa -i default \\
  -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k \\
  -codec:a mp2 -b:a 96k -ar 44100 \\
  http://hobostreamer.com:PORT/STREAM_KEY/640/480/</pre>

                    <h5>RTMP via FFmpeg</h5>
                    <pre class="bc-ws-cli-code">ffmpeg -f v4l2 -i /dev/video0 -f alsa -i default \\
  -c:v libx264 -preset veryfast -b:v 2500k \\
  -c:a aac -b:a 128k \\
  -f flv rtmp://hobostreamer.com/live/${esc(streamKey)}</pre>

                    <h5>Screen Capture (Linux X11)</h5>
                    <pre class="bc-ws-cli-code">ffmpeg -f x11grab -s 1920x1080 -r 30 -i :0.0 \\
  -f pulse -i default \\
  -c:v libx264 -preset veryfast -b:v 3000k \\
  -c:a aac -b:a 128k \\
  -f flv rtmp://hobostreamer.com/live/${esc(streamKey)}</pre>

                    <h5>MP4 / File Loop</h5>
                    <pre class="bc-ws-cli-code">ffmpeg -re -stream_loop -1 -i video.mp4 \\
  -c:v libx264 -preset veryfast -b:v 2500k \\
  -c:a aac -b:a 128k \\
  -f flv rtmp://hobostreamer.com/live/${esc(streamKey)}</pre>

                    <h5>RTSP / IP Camera</h5>
                    <pre class="bc-ws-cli-code">ffmpeg -rtsp_transport tcp -i rtsp://user:pass@192.168.1.100:554/stream \\
  -c:v libx264 -preset veryfast -b:v 2000k \\
  -c:a aac -b:a 96k \\
  -f flv rtmp://hobostreamer.com/live/${esc(streamKey)}</pre>

                    <h5>Raspberry Pi Camera</h5>
                    <pre class="bc-ws-cli-code"># Pi Camera v2 / libcamera
rpicam-vid -t 0 --width 1280 --height 720 --framerate 30 \\
  --codec h264 --bitrate 2000000 -o - | \\
  ffmpeg -f h264 -i - -c:v copy -an \\
  -f flv rtmp://hobostreamer.com/live/${esc(streamKey)}</pre>
                </div>
            </details>
        </div>`;
    }

    return '';
}

/* ── Device picker init (Class B) ────────────────────────────── */

async function _wsInitDevicePicker(method, browserMode) {
    const wrap = document.getElementById('bc-ws-device-wrap');
    if (wrap) wrap.style.display = method !== 'browser' ? 'none' : '';
    if (method !== 'browser') return;

    // Hide camera selector in mic-only mode
    const camGroup = document.getElementById('bc-ws-camera-group');
    if (camGroup) camGroup.style.display = (browserMode === 'mic_only') ? 'none' : '';

    // Hide audio selector in camera-only mode
    const audioGroup = document.getElementById('bc-ws-audio-group');
    if (audioGroup) audioGroup.style.display = (browserMode === 'camera_only') ? 'none' : '';

    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasLabels = devices.some(d => d.label);
        const permReq = document.getElementById('bc-perm-request');
        const devSelects = document.getElementById('bc-device-selects');
        if (hasLabels) {
            if (permReq) permReq.style.display = 'none';
            if (devSelects) devSelects.style.display = '';
            if (typeof populateCreateFormDevices === 'function') await populateCreateFormDevices();
        } else {
            if (permReq) permReq.style.display = '';
            if (devSelects) devSelects.style.display = 'none';
        }
    } catch (err) {
        console.warn('[Workspace] Device enumeration failed:', err.message);
    }
}

/** Sync hidden screen-share checkbox defaults from profile blob */
function _wsSyncScreenShareHiddenDefaults(browserMode) {
    const micEl = document.getElementById('bc-screen-mic-enabled');
    const camEl = document.getElementById('bc-screen-cam-enabled');
    const syaEl = document.getElementById('bc-screenSystemAudio-create');
    if (micEl) micEl.checked = document.getElementById('bc-ws-screen-mic')?.checked ?? true;
    if (camEl) camEl.checked = document.getElementById('bc-ws-screen-cam')?.checked ?? false;
    if (syaEl) syaEl.value = document.getElementById('bc-ws-screen-sysaudio')?.checked ? 'include' : 'exclude';
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
        const methodEl = document.getElementById('bc-ws-method-endpoint');
        if (methodEl && _wsState.selectedMs) {
            methodEl.innerHTML = _wsRenderMethodEndpoint(_wsState.selectedMs.protocol || 'webrtc', data.stream_key, _wsState.selectedMs.id);
        }
        toast('Stream key regenerated', 'success');
    } catch (err) {
        toast(err?.message || 'Failed to regenerate key', 'error');
    }
}

/* ── Dirty state / Manual Save ───────────────────────────────── */

function _wsMarkDirty() {
    _wsState.dirty = true;
    _wsUpdateSaveButton();
}

function _wsUpdateSaveButton() {
    const btn = document.getElementById('bc-ws-save-btn');
    const status = document.getElementById('bc-ws-save-status');
    if (btn) btn.disabled = !_wsState.dirty;
    if (status) {
        if (_wsState.dirty) {
            status.textContent = 'Unsaved changes';
            status.className = 'bc-ws-save-status bc-ws-dirty';
        } else {
            status.textContent = '';
            status.className = 'bc-ws-save-status';
        }
    }
}

function _wsShowSaveStatus(msg, cls) {
    const el = document.getElementById('bc-ws-save-status');
    if (el) {
        el.textContent = msg;
        el.className = 'bc-ws-save-status' + (cls ? ' ' + cls : '');
    }
}

/** Save all changes (structured fields + profile blob) */
async function _wsSaveAll() {
    if (!_wsState.selectedId || _wsState.saving || !_wsState.dirty) return;
    _wsState.saving = true;
    const btn = document.getElementById('bc-ws-save-btn');
    if (btn) btn.disabled = true;
    _wsShowSaveStatus('Saving\u2026', 'bc-ws-saving');

    try {
        // Read current values from DOM
        const ms = _wsState.selectedMs;
        const streamFields = {
            title: document.getElementById('bc-title')?.value.trim() || ms.title,
            description: document.getElementById('bc-description')?.value.trim() || '',
            category: document.getElementById('bc-category')?.value || 'irl',
            is_nsfw: document.getElementById('bc-nsfw')?.checked ? 1 : 0,
            protocol: ms.protocol,
            streaming_method: ms.streaming_method || 'browser',
            browser_mode: ms.browser_mode || _wsState.profile.browserMode || 'camera',
            control_config_id: parseInt(document.getElementById('bc-control-config')?.value) || null,
            slug: document.getElementById('bc-slug')?.value.trim().toLowerCase() || null,
            // Slot-level settings
            default_vod_visibility: ms.default_vod_visibility || 'public',
            default_clip_visibility: ms.default_clip_visibility || 'public',
            slot_vod_recording_enabled: ms.slot_vod_recording_enabled !== undefined ? ms.slot_vod_recording_enabled : 1,
            weather_zip: ms.weather_zip || null,
            weather_detail: ms.weather_detail || 'basic',
            weather_show_location: ms.weather_show_location || 0,
        };

        const profileBlob = {
            resolution: document.getElementById('bc-ws-resolution')?.value || '720',
            fps: document.getElementById('bc-ws-fps')?.value || '30',
            bitrate: parseInt(document.getElementById('bc-ws-bitrate')?.value) || 2500,
            browserMode: ms.browser_mode || _wsState.profile.browserMode || 'camera',
            micOnlyImage: _wsState.profile.micOnlyImage || null,
        };

        // Save structured fields
        const updated = await api(`/streams/managed/${_wsState.selectedId}`, {
            method: 'PUT',
            body: streamFields,
        });

        // Save profile blob
        await api('/streams/broadcast-settings', {
            method: 'PUT',
            body: { managed_stream_id: _wsState.selectedId, settings: profileBlob },
        });

        // Update local state
        if (updated.managed_stream) {
            _wsState.selectedMs = { ..._wsState.selectedMs, ...updated.managed_stream };
            const idx = _wsState.managedStreams.findIndex(m => m.id === _wsState.selectedId);
            if (idx !== -1) _wsState.managedStreams[idx] = { ..._wsState.managedStreams[idx], ...updated.managed_stream };
        }
        _wsState.profile = profileBlob;
        _wsState.dirty = false;

        _wsRenderSidebar();
        _wsShowSaveStatus('Saved \u2713', 'bc-ws-saved');
        setTimeout(() => { if (!_wsState.dirty) _wsShowSaveStatus(''); }, 2500);

        // Update sidebar method display
        const methodToProtocol = { browser: 'webrtc', whip: 'webrtc', cli: 'jsmpeg', rtmp: 'rtmp' };
        broadcastState.selectedMethod = methodToProtocol[streamFields.streaming_method] || streamFields.protocol;
    } catch (err) {
        _wsShowSaveStatus('Save failed: ' + (err?.message || 'unknown error'), 'bc-ws-save-error');
    } finally {
        _wsState.saving = false;
        _wsUpdateSaveButton();
    }
}

/* ── Method/mode selection ───────────────────────────────────── */

function _wsSelectMethod(method) {
    if (!_wsState.selectedMs) return;

    // Map user-facing method to protocol
    const methodToProtocol = { browser: 'webrtc', whip: 'webrtc', cli: 'jsmpeg', rtmp: 'rtmp' };
    const protocol = methodToProtocol[method] || 'webrtc';

    _wsState.selectedMs.streaming_method = method;
    _wsState.selectedMs.protocol = protocol;
    _wsMarkDirty();

    document.querySelectorAll('[data-wsmethod]').forEach(el =>
        el.classList.toggle('selected', el.dataset.wsmethod === method)
    );

    // Show/hide browser submodes (only for 'browser' method)
    const submodesEl = document.getElementById('bc-ws-browser-submodes');
    if (submodesEl) submodesEl.style.display = method === 'browser' ? '' : 'none';

    // Show/hide device picker (only for 'browser' method)
    const wrap = document.getElementById('bc-ws-device-wrap');
    if (wrap) wrap.style.display = method !== 'browser' ? 'none' : '';

    // Update endpoint info
    const methodEl = document.getElementById('bc-ws-method-endpoint');
    if (methodEl) methodEl.innerHTML = _wsRenderMethodEndpoint(method, _wsState.streamKey || '', _wsState.selectedMs?.id);

    broadcastState.selectedMethod = protocol;
    _wsInitDevicePicker(method, _wsState.profile.browserMode || 'camera');
}

function _wsSelectBrowserMode(mode) {
    _wsState.profile.browserMode = mode;
    if (_wsState.selectedMs) _wsState.selectedMs.browser_mode = mode;
    _wsMarkDirty();

    document.querySelectorAll('[data-wsbrowsermode]').forEach(el =>
        el.classList.toggle('selected', el.dataset.wsbrowsermode === mode)
    );

    // Show/hide sub-mode options
    const micOpts = document.getElementById('bc-ws-mic-only-opts');
    const screenOpts = document.getElementById('bc-ws-screen-opts');
    if (micOpts) micOpts.style.display = mode === 'mic_only' ? '' : 'none';
    if (screenOpts) screenOpts.style.display = mode === 'screen' ? '' : 'none';

    // Hide camera selector for mic-only
    const camGroup = document.getElementById('bc-ws-camera-group');
    if (camGroup) camGroup.style.display = mode === 'mic_only' ? 'none' : '';

    // Hide audio selector for camera-only
    const audioGroup = document.getElementById('bc-ws-audio-group');
    if (audioGroup) audioGroup.style.display = mode === 'camera_only' ? 'none' : '';

    _wsSyncScreenShareHiddenDefaults(mode);
}

/** Handle slot-level settings changes — sync to managed stream state */
function _wsSlotSettingChanged() {
    if (!_wsState.selectedMs) return;
    const ms = _wsState.selectedMs;
    ms.default_vod_visibility = document.getElementById('bc-ws-vod-visibility')?.value || 'public';
    ms.default_clip_visibility = document.getElementById('bc-ws-clip-visibility')?.value || 'public';
    ms.slot_vod_recording_enabled = document.getElementById('bc-ws-vod-recording')?.checked ? 1 : 0;
    ms.weather_zip = document.getElementById('bc-ws-weather-zip')?.value.trim() || null;
    ms.weather_detail = document.getElementById('bc-ws-weather-detail')?.value || 'basic';
    ms.weather_show_location = document.getElementById('bc-ws-weather-location')?.checked ? 1 : 0;
    _wsMarkDirty();
}

/** Handle mic-only placeholder image selection */
function _wsMicImageChanged(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    if (file.size > 2 * 1024 * 1024) {
        toast('Image too large (max 2MB)', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        _wsState.profile.micOnlyImage = e.target.result;
        const preview = document.getElementById('bc-ws-mic-image-preview');
        if (preview) preview.innerHTML = `<img src="${e.target.result}" alt="Mic-only placeholder">`;
        _wsMarkDirty();
    };
    reader.readAsDataURL(file);
}

/* ── Go Live ─────────────────────────────────────────────────── */

async function goLiveFromWorkspace() {
    if (!_wsState.selectedMs) {
        toast('Select a stream slot first', 'error');
        return;
    }

    // Prompt to save if dirty
    if (_wsState.dirty) {
        if (confirm('You have unsaved changes. Save before going live?')) {
            await _wsSaveAll();
        }
    }

    const p = _wsState.profile;
    const ms = _wsState.selectedMs;
    const browserMode = ms.browser_mode || p.browserMode || 'camera';
    const streamingMethod = ms.streaming_method || 'browser';

    // Apply quality defaults from saved profile into broadcastState
    if (p.resolution) broadcastState.settings.broadcastRes = String(p.resolution);
    if (p.fps) broadcastState.settings.broadcastFps = String(p.fps);
    if (p.bitrate) broadcastState.settings.broadcastBps = String(p.bitrate);

    // Map streaming_method to protocol for broadcastState
    const methodToProtocol = { browser: 'webrtc', whip: 'webrtc', cli: 'jsmpeg', rtmp: 'rtmp' };
    const protocol = methodToProtocol[streamingMethod] || ms.protocol || 'webrtc';
    broadcastState.selectedMethod = protocol;

    if (streamingMethod === 'browser') {
        broadcastState.selectedWebRTCSub = 'browser';
        if (browserMode === 'screen') {
            broadcastState.selectedBrowserSource = 'screen';
            broadcastState.settings.screenShare = true;
        } else if (browserMode === 'mic_only') {
            broadcastState.selectedBrowserSource = 'camera';
            broadcastState.settings.micOnly = true;
            broadcastState.settings.screenShare = false;
        } else if (browserMode === 'camera_only') {
            broadcastState.selectedBrowserSource = 'camera';
            broadcastState.settings.cameraOnly = true;
            broadcastState.settings.screenShare = false;
        } else {
            broadcastState.selectedBrowserSource = 'camera';
            broadcastState.settings.screenShare = false;
            broadcastState.settings.micOnly = false;
            broadcastState.settings.cameraOnly = false;
        }
    } else if (streamingMethod === 'whip') {
        broadcastState.selectedWebRTCSub = 'whip';
    }

    // Class B: sync local device selection
    const camSel = document.getElementById('bc-create-camera');
    const audSel = document.getElementById('bc-create-audio');
    if (camSel && camSel.value) _syncCameraSelectionUI(camSel.value, { persist: false });
    if (audSel && audSel.value) _syncAudioSelectionUI(audSel.value, { persist: false });

    // Sync screen-share hidden defaults
    _wsSyncScreenShareHiddenDefaults(browserMode);

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
        const proto = s.protocol ? `<span class="bc-ws-item-proto">${esc(_wsMethodLabel(s.protocol))}</span>` : '';
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
