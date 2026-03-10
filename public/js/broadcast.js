/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Broadcast (Go Live)
   Supports WebRTC (browser + OBS), RTMP, and JSMPEG methods.
   Multiple simultaneous WebRTC browser streams with different devices.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Per-stream state — one entry per active broadcast stream.
 */
function createStreamState(streamData) {
    return {
        streamData,
        localStream: null,
        /** @type {Map<string, RTCPeerConnection>} peerId → PC */
        viewerConnections: new Map(),
        signalingWs: null,
        heartbeatInterval: null,
        startedAt: streamData?.started_at || null,
        lastStatBytes: 0,
        lastStatTime: 0,
        gainNode: null,
        audioContext: null,
        vodRecorder: null,
        vodChunks: [],
        vodUploading: false,
        vodFinalized: false,
        vodId: null,
        // Per-stream signaling reconnect state
        signalingReconnectTimer: null,
        signalingIntentionalClose: false,
        signalingReconnectDelay: 3000,
        lastThumbnailAt: 0,
        thumbnailCanvas: null,
        thumbnailCtx: null,
        statsPollPending: false,
    };
}

    const BROADCAST_SIGNALING_MAX_BUFFERED_AMOUNT = 512 * 1024;
    const BROADCAST_THUMBNAIL_INTERVAL_MS = 115000;

function getBroadcastFrameRate() {
    const fps = parseInt(broadcastState.settings.broadcastFps, 10);
    return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

function getTargetVideoBitrate() {
    const kbps = parseInt(broadcastState.settings.broadcastBps, 10);
    return (Number.isFinite(kbps) && kbps > 0 ? kbps : 2500) * 1000;
}

function getSuggestedScaleDown(settings) {
    const res = String(settings.broadcastRes || '720');
    const kbps = parseInt(settings.broadcastBps, 10) || 2500;
    if (res === '1440' && kbps < 5500) return 2;
    if (res === '1080' && kbps < 3500) return 1.5;
    if (res === '720' && kbps < 1200) return 1.25;
    return 1;
}

function optimizeOutgoingStream(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.localStream) return;

    const settings = broadcastState.settings;
    const videoTrack = ss.localStream.getVideoTracks()[0] || null;
    const audioTrack = ss.localStream.getAudioTracks()[0] || null;

    if (videoTrack) {
        try { videoTrack.contentHint = settings.screenShare ? 'detail' : 'motion'; } catch {}
    }
    if (audioTrack) {
        try { audioTrack.contentHint = 'speech'; } catch {}
    }
}

let broadcastState = {
    /** @type {Map<number, object>} streamId → per-stream state */
    streams: new Map(),
    /** Which stream's preview is currently shown */
    activeStreamId: null,
    selectedMethod: 'webrtc',
    selectedWebRTCSub: 'browser',

    // Settings (persisted to localStorage) — global across all streams
    settings: {
        ttsVolume: 800, ttsPitch: 100, ttsRate: 10, ttsVoice: '', ttsDuration: 10, ttsNames: 'off', ttsQueue: 5,
        notificationVolume: 800, forceAudio: 'default', autoGain: true, echoCancellation: true, noiseSuppression: true,
        manualGainEnabled: false, manualGain: 100, force48kSampleRate: false,
        forceCamera: 'default', broadcastRes: '720', broadcastFps: '30', broadcastCodec: 'auto',
        broadcastBps: '2500', broadcastBpsMin: '500', broadcastLimit: 'restart', screenShare: false,
        allowSounds: 'false', soundVolume: 800,
    },
};

// Global display timers (stats + uptime) — always show active stream info
let _globalStatsInterval = null;
let _globalUptimeInterval = null;

function sendBroadcastSignal(ss, msg) {
    if (!ss?.signalingWs || ss.signalingWs.readyState !== WebSocket.OPEN) return false;
    if (ss.signalingWs.bufferedAmount > BROADCAST_SIGNALING_MAX_BUFFERED_AMOUNT) return false;
    ss.signalingWs.send(JSON.stringify(msg));
    return true;
}

/** Get the active stream's state, or null */
function getActiveStreamState() {
    return broadcastState.activeStreamId != null ? broadcastState.streams.get(broadcastState.activeStreamId) || null : null;
}

/** Get specific stream state by ID */
function getStreamState(streamId) {
    return broadcastState.streams.get(streamId) || null;
}

/** Whether any streams are currently active */
function isStreaming() {
    return broadcastState.streams.size > 0;
}

/* ── Load/Save Settings ──────────────────────────────────────── */
function loadBroadcastSettings() {
    try {
        const saved = localStorage.getItem('hobo_broadcast_settings');
        if (saved) broadcastState.settings = { ...broadcastState.settings, ...JSON.parse(saved) };
    } catch { /* ignore */ }
}
function saveBroadcastSettings() {
    try { localStorage.setItem('hobo_broadcast_settings', JSON.stringify(broadcastState.settings)); } catch {}
}

/* ── Initialize Broadcast Page ───────────────────────────────── */
async function loadBroadcastPage() {
    loadBroadcastSettings();

    // If we have active browser WebRTC streams, restore the active one's live UI
    if (broadcastState.streams.size > 0 && broadcastState.activeStreamId != null) {
        const ss = getActiveStreamState();
        if (ss && ss.streamData?.protocol === 'webrtc' && ss.localStream) {
            await buildBroadcastTabs(broadcastState.activeStreamId);
            showBrowserBroadcast();
            const preview = document.getElementById('bc-video-preview');
            if (preview) { preview.srcObject = ss.localStream; preview.muted = true; preview.play().catch(() => {}); }
            const ph = document.getElementById('bc-video-placeholder');
            if (ph) ph.style.display = 'none';
            if (typeof chatWs !== 'undefined' && (!chatWs || chatWs.readyState !== WebSocket.OPEN)) {
                if (typeof initChat === 'function') initChat(ss.streamData.id);
            }
            startGlobalDisplayTimers();
            return;
        }
    }

    // Check for any live streams — if any exist, show tabs
    try {
        const data = await api('/streams/mine');
        const liveStreams = (data.streams || []).filter(s => s.is_live);
        if (liveStreams.length > 0) {
            const firstLive = liveStreams[0];
            await buildBroadcastTabs(firstLive.id);
            await resumeStreamView(firstLive);
            return;
        }
    } catch {}

    // No live streams — show the full stream manager
    hideBroadcastTabs();
    showStreamManager();
    loadExistingStreams();
}

/* ── Stream Manager (Step 0) ─────────────────────────────────── */
function showStreamManager() {
    const ids = ['bc-stream-manager', 'bc-browser-broadcast', 'bc-rtmp-instructions', 'bc-jsmpeg-instructions', 'bc-webrtc-obs-instructions'];
    ids.forEach((id, i) => { const el = document.getElementById(id); if (el) el.style.display = i === 0 ? '' : 'none'; });
    const chat = document.getElementById('bc-chat-sidebar'); if (chat) chat.style.display = 'none';
    const info = document.getElementById('bc-info-bar'); if (info) info.style.display = 'none';
}

/* ── Broadcast Stream Tabs ───────────────────────────────────── */

/**
 * Build/rebuild the broadcast tab bar from the user's active streams.
 * @param {number|null} activeStreamId - Stream to mark active, or null for [+] tab
 */
async function buildBroadcastTabs(activeStreamId) {
    const bar = document.getElementById('bc-tabs-bar');
    const scroll = document.getElementById('bc-tabs-scroll');
    if (!bar || !scroll) return;

    let liveStreams = [];
    try {
        const data = await api('/streams/mine');
        liveStreams = (data.streams || []).filter(s => s.is_live);
    } catch {}

    if (liveStreams.length === 0 && !activeStreamId) {
        hideBroadcastTabs();
        return;
    }

    bar.style.display = '';

    // Mark [+] add button active state
    const addBtn = bar.querySelector('.bc-tab-add');
    if (addBtn) addBtn.classList.toggle('active', activeStreamId === null);

    scroll.innerHTML = liveStreams.map(s => {
        const isActive = s.id === activeStreamId;
        const title = esc(s.title || 'Untitled');
        const truncTitle = title.length > 25 ? title.slice(0, 23) + '…' : title;
        const proto = (s.protocol || 'webrtc').toUpperCase();
        // Show a broadcasting indicator if this stream has active media state
        const hasBrowserState = broadcastState.streams.has(s.id) && broadcastState.streams.get(s.id).localStream;
        const dotClass = hasBrowserState ? 'bc-tab-dot bc-tab-dot-broadcasting' : 'bc-tab-dot';
        return `<button class="bc-tab ${isActive ? 'active' : ''}"
                    onclick="switchBroadcastTab(${s.id})"
                    data-stream-id="${s.id}" title="${title}">
            <span class="${dotClass}"></span>
            <span>${truncTitle}</span>
            <span class="bc-tab-protocol">${proto}</span>
            <span class="bc-tab-viewers"><i class="fa-solid fa-eye"></i> ${s.viewer_count || 0}</span>
            <span class="bc-tab-close" onclick="event.stopPropagation();endBroadcastTab(${s.id})" title="End stream"><i class="fa-solid fa-xmark"></i></span>
        </button>`;
    }).join('');
}

function hideBroadcastTabs() {
    const bar = document.getElementById('bc-tabs-bar');
    if (bar) bar.style.display = 'none';
}

/**
 * Switch to a live stream's controls view when its tab is clicked.
 */
async function switchBroadcastTab(streamId) {
    // Update tab highlight
    const scroll = document.getElementById('bc-tabs-scroll');
    if (scroll) scroll.querySelectorAll('.bc-tab').forEach(t => t.classList.toggle('active', parseInt(t.dataset.streamId) === streamId));
    const addBtn = document.querySelector('.bc-tab-add');
    if (addBtn) addBtn.classList.remove('active');

    // If we have active state for this stream, just switch the preview (no teardown)
    const ss = getStreamState(streamId);
    if (ss && ss.localStream) {
        broadcastState.activeStreamId = streamId;
        showBrowserBroadcast();
        const preview = document.getElementById('bc-video-preview');
        if (preview) { preview.srcObject = ss.localStream; preview.muted = true; preview.play().catch(() => {}); }
        const ph = document.getElementById('bc-video-placeholder');
        if (ph) ph.style.display = 'none';
        startGlobalDisplayTimers();
        updateBroadcastStatusFromConnections(streamId);
        if (typeof initChat === 'function') initChat(streamId);
        return;
    }

    // No active state — load stream data and resume
    try {
        const data = await api(`/streams/${streamId}`);
        const stream = data.stream;
        if (!stream || !stream.is_live) {
            toast('Stream is no longer live', 'error');
            await buildBroadcastTabs(null);
            showStreamManager();
            loadExistingStreams();
            return;
        }
        await resumeStreamView(stream);
    } catch (e) {
        toast(e.message || 'Failed to load stream', 'error');
    }
}

/**
 * Show the create-stream form from the [+] button.
 * Keeps tabs visible so user can switch back to active streams.
 */
async function showCreateStreamPanel() {
    // Mark [+] as active, deactivate stream tabs
    const scroll = document.getElementById('bc-tabs-scroll');
    if (scroll) scroll.querySelectorAll('.bc-tab').forEach(t => t.classList.remove('active'));
    const addBtn = document.querySelector('.bc-tab-add');
    if (addBtn) addBtn.classList.add('active');

    // Don't tear down active browser streams — just hide the panels
    const ids = ['bc-browser-broadcast', 'bc-rtmp-instructions', 'bc-jsmpeg-instructions', 'bc-webrtc-obs-instructions'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    const chat = document.getElementById('bc-chat-sidebar'); if (chat) chat.style.display = 'none';
    const info = document.getElementById('bc-info-bar'); if (info) info.style.display = 'none';

    // Show just the create section (hide existing streams panel since tabs replace it)
    const mgr = document.getElementById('bc-stream-manager');
    if (mgr) mgr.style.display = '';
    const existingEl = document.getElementById('bc-existing-streams');
    if (existingEl) existingEl.style.display = 'none';
    const createEl = document.getElementById('bc-create-section');
    if (createEl) createEl.style.display = '';

    // Reset form fields
    const titleEl = document.getElementById('bc-title');
    if (titleEl) titleEl.value = '';
    const descEl = document.getElementById('bc-description');
    if (descEl) descEl.value = '';

    // Populate device selectors for the create form
    await populateCreateFormDevices();
}

/**
 * End a stream directly from its tab's close button (×).
 */
async function endBroadcastTab(streamId) {
    if (!confirm('End this stream?')) return;
    try {
        // Clean up this stream's state if we have it
        const ss = getStreamState(streamId);
        if (ss) {
            await uploadVodRecording(streamId);
            cleanupStream(streamId);
        }
        await api(`/streams/${streamId}`, { method: 'DELETE' });
        toast('Stream ended', 'info');

        // Rebuild tabs — if other streams exist, show the first one
        const data = await api('/streams/mine');
        const remaining = (data.streams || []).filter(s => s.is_live);
        if (remaining.length > 0) {
            // Prefer a stream we have active state for
            const withState = remaining.find(s => broadcastState.streams.has(s.id));
            const nextStream = withState || remaining[0];
            await buildBroadcastTabs(nextStream.id);
            await switchOrResumeStream(nextStream);
        } else {
            hideBroadcastTabs();
            clearGlobalDisplayTimers();
            setNavLiveIndicator(false);
            showStreamManager();
            loadExistingStreams();
        }
    } catch (e) {
        toast(e.message || 'Failed to end stream', 'error');
    }
}

/**
 * Switch to a stream — if we have active state, just swap preview; otherwise resume fully.
 */
async function switchOrResumeStream(stream) {
    const ss = getStreamState(stream.id);
    if (ss && ss.localStream) {
        broadcastState.activeStreamId = stream.id;
        showBrowserBroadcast();
        const preview = document.getElementById('bc-video-preview');
        if (preview) { preview.srcObject = ss.localStream; preview.muted = true; preview.play().catch(() => {}); }
        const ph = document.getElementById('bc-video-placeholder');
        if (ph) ph.style.display = 'none';
        startGlobalDisplayTimers();
        updateBroadcastStatusFromConnections(stream.id);
        if (typeof initChat === 'function') initChat(stream.id);
    } else {
        await resumeStreamView(stream);
    }
}

/**
 * Show the appropriate UI for a stream without re-creating the stream session.
 * Called when switching tabs or loading the page with active streams.
 */
async function resumeStreamView(stream) {
    // Hide all panels first
    const ids = ['bc-stream-manager', 'bc-browser-broadcast', 'bc-rtmp-instructions', 'bc-jsmpeg-instructions', 'bc-webrtc-obs-instructions'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

    // Fetch and sync call mode from server
    try {
        const callData = await api(`/streams/${stream.id}/call`);
        _broadcastCallMode = callData.call_mode || null;
    } catch { _broadcastCallMode = null; }

    if (stream.protocol === 'webrtc') {
        // Check if we already have active state for this stream
        const existing = getStreamState(stream.id);
        if (existing && existing.localStream) {
            // Already broadcasting — just switch preview
            broadcastState.activeStreamId = stream.id;
            showBrowserBroadcast();
            const preview = document.getElementById('bc-video-preview');
            if (preview) { preview.srcObject = existing.localStream; preview.muted = true; preview.play().catch(() => {}); }
            const ph = document.getElementById('bc-video-placeholder');
            if (ph) ph.style.display = 'none';
            startGlobalDisplayTimers();
            showBroadcastCallControls(); updateBroadcastCallUI();
            return;
        }
        // Not yet broadcasting — create per-stream state and start capture
        const ss = createStreamState(stream);
        ss.startedAt = stream.started_at || new Date().toISOString();
        broadcastState.streams.set(stream.id, ss);
        broadcastState.activeStreamId = stream.id;
        setNavLiveIndicator(true);
        showBrowserBroadcast();
        populateDeviceLists(); populateTTSVoices(); syncSettingsUI();
        startHeartbeat(stream.id);
        await startMediaCapture(stream.id); connectSignaling(stream.id); startVodRecording(stream.id);
        startGlobalDisplayTimers();
        if (typeof initChat === 'function') initChat(stream.id);
        showBroadcastCallControls(); updateBroadcastCallUI();
    } else if (stream.protocol === 'rtmp') {
        const ss = createStreamState(stream);
        ss.startedAt = stream.started_at || new Date().toISOString();
        broadcastState.streams.set(stream.id, ss);
        broadcastState.activeStreamId = stream.id;
        setNavLiveIndicator(true);
        showRTMPInstructions(stream);
        startHeartbeat(stream.id);
        startGlobalDisplayTimers();
        if (typeof initChat === 'function') initChat(stream.id);
        showBroadcastCallControls(); updateBroadcastCallUI();
    } else if (stream.protocol === 'jsmpeg') {
        const ss = createStreamState(stream);
        ss.startedAt = stream.started_at || new Date().toISOString();
        broadcastState.streams.set(stream.id, ss);
        broadcastState.activeStreamId = stream.id;
        setNavLiveIndicator(true);
        showJSMPEGInstructions(stream);
        startHeartbeat(stream.id);
        startGlobalDisplayTimers();
        if (typeof initChat === 'function') initChat(stream.id);
        showBroadcastCallControls(); updateBroadcastCallUI();
    }
}

async function loadExistingStreams() {
    const listEl = document.getElementById('bc-streams-list');
    if (!listEl) return;
    try {
        // Use the /mine endpoint to get all user's streams
        const data = await api('/streams/mine');
        const all = data.streams || [];

        if (!all.length) {
            listEl.innerHTML = `
                <div class="bc-welcome">
                    <i class="fa-solid fa-campground fa-3x" style="margin-bottom:12px;color:var(--accent)"></i>
                    <h3>Welcome to HoboStreamer!</h3>
                    <p>You haven't streamed yet. Create your first stream below to get started.</p>
                    <div class="bc-welcome-tips">
                        <div class="bc-welcome-tip"><i class="fa-solid fa-globe"></i> <strong>WebRTC</strong> — Stream from your browser camera/screen, or via OBS WHIP</div>
                        <div class="bc-welcome-tip"><i class="fa-solid fa-server"></i> <strong>RTMP</strong> — Classic OBS/Streamlabs/FFmpeg streaming</div>
                        <div class="bc-welcome-tip"><i class="fa-solid fa-terminal"></i> <strong>JSMPEG</strong> — Lightweight FFmpeg pipeline, great for Raspberry Pi</div>
                    </div>
                    <p class="muted" style="margin-top:12px"><i class="fa-solid fa-circle-info"></i> Your stream URL will be <strong>hobostreamer.com/${esc(currentUser?.username || 'you')}</strong> — it stays the same for every stream.</p>
                </div>`;
            return;
        }

        // Separate live and past streams
        const live = all.filter(s => s.is_live);
        const past = all.filter(s => !s.is_live);

        let html = '';
        if (live.length) {
            html += '<div class="bc-streams-section"><h4 style="margin:0 0 8px;color:var(--accent)"><i class="fa-solid fa-circle live-dot"></i> Active Streams</h4>';
            html += live.map(s => renderStreamItem(s)).join('');
            html += '</div>';
        }
        if (past.length) {
            html += '<div class="bc-streams-section"><h4 style="margin:12px 0 8px;color:var(--text-muted)"><i class="fa-solid fa-clock-rotate-left"></i> Past Streams</h4>';
            html += past.slice(0, 10).map(s => renderStreamItem(s)).join('');
            if (past.length > 10) html += `<p class="muted" style="text-align:center;padding:8px">+${past.length - 10} more streams in Settings → My Streams</p>`;
            html += '</div>';
        }
        listEl.innerHTML = html;
    } catch (err) {
        console.error('[Broadcast] Failed to load streams:', err);
        listEl.innerHTML = `
            <div class="bc-welcome">
                <i class="fa-solid fa-campground fa-3x" style="margin-bottom:12px;color:var(--accent)"></i>
                <h3>Welcome to HoboStreamer!</h3>
                <p>Create your first stream below to start broadcasting.</p>
                <div class="bc-welcome-tips">
                    <div class="bc-welcome-tip"><i class="fa-solid fa-globe"></i> <strong>WebRTC</strong> — Stream from your browser or OBS</div>
                    <div class="bc-welcome-tip"><i class="fa-solid fa-server"></i> <strong>RTMP</strong> — Classic OBS streaming</div>
                    <div class="bc-welcome-tip"><i class="fa-solid fa-terminal"></i> <strong>JSMPEG</strong> — FFmpeg lightweight pipeline</div>
                </div>
            </div>`;
    }
}

function renderStreamItem(s) {
    const badge = s.is_live ? '<span class="badge badge-live">LIVE</span>' : '<span class="badge badge-offline">Ended</span>';
    const time = s.started_at ? new Date(s.started_at.replace(' ', 'T') + 'Z').toLocaleString() : '';
    const duration = s.duration_seconds ? formatDuration(s.duration_seconds) : '';
    return `<div class="bc-stream-item ${s.is_live ? 'bc-stream-live' : ''}">
        <div class="bc-stream-info">
            <strong>${esc(s.title || 'Untitled')}</strong>
            <span class="muted">${(s.protocol || 'webrtc').toUpperCase()} · ${time}${duration ? ' · ' + duration : ''}</span>
        </div>
        <div class="bc-stream-actions">
            ${s.is_live ? `<button class="btn btn-small btn-primary" onclick="resumeStream(${s.id})"><i class="fa-solid fa-play"></i> Resume</button> <button class="btn btn-small btn-danger" onclick="endExistingStream(${s.id})"><i class="fa-solid fa-stop"></i> End</button>` : ''}
            ${badge}
        </div>
    </div>`;
}

async function resumeStream(streamId) {
    try {
        const data = await api(`/streams/${streamId}`);
        const stream = data.stream;
        if (!stream || !stream.is_live) { toast('Stream is no longer live', 'error'); return loadExistingStreams(); }

        // Build tabs and activate this stream
        await buildBroadcastTabs(stream.id);
        await resumeStreamView(stream);
    } catch (e) { toast(e.message || 'Failed to resume stream', 'error'); }
}

async function endExistingStream(streamId) {
    try {
        const ss = getStreamState(streamId);
        if (ss) {
            await uploadVodRecording(streamId);
            cleanupStream(streamId);
        }
        await api(`/streams/${streamId}`, { method: 'DELETE' });
        toast('Stream ended', 'info');
        if (!isStreaming()) setNavLiveIndicator(false);
        loadExistingStreams();
    } catch (e) { toast(e.message || 'Failed to end stream', 'error'); }
}

/* ── Method Selection ────────────────────────────────────────── */
function selectStreamMethod(method) {
    broadcastState.selectedMethod = method;
    document.querySelectorAll('.bc-method-card').forEach(el => el.classList.toggle('selected', el.dataset.method === method));
    const sub = document.getElementById('bc-webrtc-sub');
    if (sub) sub.style.display = method === 'webrtc' ? 'block' : 'none';
    // Show/hide device pickers (only for WebRTC Browser)
    const devicesEl = document.getElementById('bc-create-devices');
    if (devicesEl) devicesEl.style.display = (method === 'webrtc' && broadcastState.selectedWebRTCSub === 'browser') ? 'block' : 'none';
}
function selectWebRTCSub(sub) {
    broadcastState.selectedWebRTCSub = sub;
    document.querySelectorAll('.bc-method-card-sm').forEach(el => el.classList.toggle('selected', el.dataset.sub === sub));
    const devicesEl = document.getElementById('bc-create-devices');
    if (devicesEl) devicesEl.style.display = sub === 'browser' ? 'block' : 'none';
}

/* ── Create New Stream ───────────────────────────────────────── */
async function createNewStream() {
    const title = document.getElementById('bc-title')?.value.trim();
    const description = document.getElementById('bc-description')?.value.trim() || '';
    const category = document.getElementById('bc-category')?.value || 'irl';
    const method = broadcastState.selectedMethod;
    if (!title) return toast('Stream title is required', 'error');

    // Restore existing-streams panel visibility for next time
    const existingEl = document.getElementById('bc-existing-streams');
    if (existingEl) existingEl.style.display = '';

    // Read device selection from create form
    const createCamera = document.getElementById('bc-create-camera')?.value || 'default';
    const createAudio = document.getElementById('bc-create-audio')?.value || 'default';

    try {
        const data = await api('/streams', { method: 'POST', body: { title, description, protocol: method, category, nsfw: false } });
        const streamData = data.stream || data;

        // Create per-stream state
        const ss = createStreamState(streamData);
        ss.startedAt = new Date().toISOString();
        broadcastState.streams.set(streamData.id, ss);
        broadcastState.activeStreamId = streamData.id;
        setNavLiveIndicator(true);

        // Init call controls (disabled by default, streamer enables after going live)
        _broadcastCallMode = null;

        // Build/refresh tabs with new stream active
        await buildBroadcastTabs(streamData.id);

        if (method === 'webrtc' && broadcastState.selectedWebRTCSub === 'browser') {
            showBrowserBroadcast(); populateDeviceLists(); populateTTSVoices(); syncSettingsUI();
            await startMediaCapture(streamData.id, { cameraId: createCamera, audioId: createAudio });
            connectSignaling(streamData.id);
            startHeartbeat(streamData.id); startVodRecording(streamData.id);
            startGlobalDisplayTimers();
            if (typeof initChat === 'function') initChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            toast('You are now LIVE!', 'success');
        } else if (method === 'webrtc' && broadcastState.selectedWebRTCSub === 'obs') {
            showWHIPInstructions(streamData); startHeartbeat(streamData.id);
            if (typeof initChat === 'function') initChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            toast('Stream created — configure OBS with the details below', 'success');
        } else if (method === 'rtmp') {
            showRTMPInstructions(streamData); startHeartbeat(streamData.id);
            if (typeof initChat === 'function') initChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            toast('Stream created — configure your streaming software', 'success');
        } else if (method === 'jsmpeg') {
            showJSMPEGInstructions(streamData); startHeartbeat(streamData.id);
            if (typeof initChat === 'function') initChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            toast('Stream created — start FFmpeg with the command below', 'success');
        }
    } catch (e) {
        toast(e.message || 'Failed to create stream', 'error');
    }
}

/* ── Show Method-Specific Panels ─────────────────────────────── */
function showBrowserBroadcast() {
    document.getElementById('bc-stream-manager').style.display = 'none';
    document.getElementById('bc-browser-broadcast').style.display = '';
    document.getElementById('bc-rtmp-instructions').style.display = 'none';
    document.getElementById('bc-jsmpeg-instructions').style.display = 'none';
    document.getElementById('bc-webrtc-obs-instructions').style.display = 'none';
    document.getElementById('bc-chat-sidebar').style.display = '';
    const lb = document.getElementById('bc-live-badge'); if (lb) lb.style.display = '';
    const ib = document.getElementById('bc-info-bar'); if (ib) ib.style.display = '';
    // Set protocol badge from active stream
    const ss = getActiveStreamState();
    const proto = ss && ss.streamData && ss.streamData.protocol ? ss.streamData.protocol : 'webrtc';
    const pb = document.getElementById('bc-protocol-badge');
    if (pb && typeof protocolBadge === 'function') pb.innerHTML = protocolBadge(proto);
}

let _rtmpStatusPollTimer = null;

async function showRTMPInstructions(stream) {
    document.getElementById('bc-stream-manager').style.display = 'none';
    document.getElementById('bc-browser-broadcast').style.display = 'none';
    document.getElementById('bc-rtmp-instructions').style.display = '';
    document.getElementById('bc-jsmpeg-instructions').style.display = 'none';
    document.getElementById('bc-webrtc-obs-instructions').style.display = 'none';
    document.getElementById('bc-chat-sidebar').style.display = '';
    const ib = document.getElementById('bc-info-bar'); if (ib) ib.style.display = '';
    const pb = document.getElementById('bc-protocol-badge');
    if (pb && typeof protocolBadge === 'function') pb.innerHTML = protocolBadge('rtmp');
    try {
        const data = await api(`/streams/${stream.id}/endpoint`);
        const ep = data.endpoint || {};
        document.getElementById('bc-rtmp-url').textContent = ep.rtmpUrl || `rtmp://${location.hostname}:1935/live`;
        document.getElementById('bc-rtmp-key').textContent = ep.streamKey || data.stream_key || 'N/A';
    } catch {
        document.getElementById('bc-rtmp-url').textContent = `rtmp://${location.hostname}:1935/live`;
        document.getElementById('bc-rtmp-key').textContent = 'Error loading key';
    }
    // Start polling RTMP feed status
    startRtmpStatusPoll(stream.id);
}

function startRtmpStatusPoll(streamId) {
    stopRtmpStatusPoll();
    setRtmpStatusUI(false);
    const poll = async () => {
        try {
            const data = await api(`/streams/${streamId}/rtmp-status`);
            setRtmpStatusUI(data.receiving);
        } catch { /* ignore */ }
    };
    poll();
    _rtmpStatusPollTimer = setInterval(poll, 3000);
}

function stopRtmpStatusPoll() {
    if (_rtmpStatusPollTimer) { clearInterval(_rtmpStatusPollTimer); _rtmpStatusPollTimer = null; }
}

function setRtmpStatusUI(receiving) {
    const wrap = document.getElementById('bc-rtmp-status');
    if (!wrap) return;
    const spinner = document.getElementById('bc-rtmp-status-spinner');
    const ok = document.getElementById('bc-rtmp-status-ok');
    const label = document.getElementById('bc-rtmp-status-label');
    const detail = document.getElementById('bc-rtmp-status-detail');
    if (receiving) {
        wrap.className = 'bc-rtmp-status receiving';
        spinner.style.display = 'none';
        ok.style.display = '';
        label.textContent = 'Receiving feed from OBS';
        detail.textContent = 'Your RTMP stream is live and connected';
    } else {
        wrap.className = 'bc-rtmp-status waiting';
        spinner.style.display = '';
        ok.style.display = 'none';
        label.textContent = 'Waiting for OBS...';
        detail.textContent = 'Start streaming in OBS to connect';
    }
}

async function showJSMPEGInstructions(stream) {
    document.getElementById('bc-stream-manager').style.display = 'none';
    document.getElementById('bc-browser-broadcast').style.display = 'none';
    document.getElementById('bc-rtmp-instructions').style.display = 'none';
    document.getElementById('bc-jsmpeg-instructions').style.display = '';
    document.getElementById('bc-webrtc-obs-instructions').style.display = 'none';
    document.getElementById('bc-chat-sidebar').style.display = '';
    const ib = document.getElementById('bc-info-bar'); if (ib) ib.style.display = '';
    const pb = document.getElementById('bc-protocol-badge');
    if (pb && typeof protocolBadge === 'function') pb.innerHTML = protocolBadge('jsmpeg');
    try {
        const data = await api(`/streams/${stream.id}/endpoint`);
        const ep = data.endpoint || {};
        const host = location.hostname;
        const baseUrl = `http://${host}:${ep.videoPort || 9710}/${data.stream_key}/640/480/`;
        const audioUrl = `http://${host}:${ep.audioPort || 9711}/${data.stream_key}/`;
        const hdUrl = `http://${host}:${ep.videoPort || 9710}/${data.stream_key}/1280/720/`;

        // Video + Audio
        document.getElementById('bc-jsmpeg-cmd').textContent = ep.ffmpegCommand || `ffmpeg -f v4l2 -i /dev/video0 -f alsa -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 ${baseUrl}`;
        // Video only
        const videoOnlyEl = document.getElementById('bc-jsmpeg-cmd-videoonly');
        if (videoOnlyEl) videoOnlyEl.textContent = ep.ffmpegVideoOnly || `ffmpeg -f v4l2 -i /dev/video0 -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -bf 0 -muxdelay 0.001 ${baseUrl}`;
        // Screen capture
        const screenEl = document.getElementById('bc-jsmpeg-cmd-screen');
        if (screenEl) screenEl.textContent = ep.ffmpegScreen || `ffmpeg -f x11grab -s 1920x1080 -r 24 -i :0.0 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 500k -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 ${baseUrl}`;
        // OBS Virtual Camera
        const obsEl = document.getElementById('bc-jsmpeg-cmd-obs');
        if (obsEl) obsEl.textContent = ep.ffmpegOBS || `ffmpeg -f v4l2 -i /dev/video2 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 500k -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 ${baseUrl}`;
        // Audio only
        const audioEl = document.getElementById('bc-jsmpeg-cmd-audioonly');
        if (audioEl) audioEl.textContent = ep.ffmpegAudioOnly || `ffmpeg -f alsa -i default -f mpegts -codec:a mp2 -b:a 128k -ar 44100 -ac 1 ${audioUrl}`;
        // HD 720p
        const hdEl = document.getElementById('bc-jsmpeg-cmd-hd');
        if (hdEl) hdEl.textContent = ep.ffmpegHD || `ffmpeg -f v4l2 -video_size 1280x720 -framerate 30 -i /dev/video0 -f alsa -i default -f mpegts -codec:v mpeg1video -s 1280x720 -b:v 1200k -r 30 -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 2 -muxdelay 0.001 ${hdUrl}`;
    } catch { document.getElementById('bc-jsmpeg-cmd').textContent = 'Error loading command'; }
}

async function showWHIPInstructions(stream) {
    document.getElementById('bc-stream-manager').style.display = 'none';
    document.getElementById('bc-browser-broadcast').style.display = 'none';
    document.getElementById('bc-rtmp-instructions').style.display = 'none';
    document.getElementById('bc-jsmpeg-instructions').style.display = 'none';
    document.getElementById('bc-webrtc-obs-instructions').style.display = '';
    document.getElementById('bc-chat-sidebar').style.display = '';
    const ib = document.getElementById('bc-info-bar'); if (ib) ib.style.display = '';
    const pb = document.getElementById('bc-protocol-badge');
    if (pb && typeof protocolBadge === 'function') pb.innerHTML = protocolBadge('webrtc');
    document.getElementById('bc-whip-url').textContent = `${location.origin}/whip/${stream.id}`;
    document.getElementById('bc-whip-token').textContent = localStorage.getItem('token') || 'N/A';
}

/* ── End Setup Stream (for non-browser methods) ──────────────── */
async function endSetupStream() {
    stopRtmpStatusPoll();
    const ss = getActiveStreamState();
    const endingStreamId = ss?.streamData?.id || broadcastState.activeStreamId;
    try { if (endingStreamId) await api(`/streams/${endingStreamId}`, { method: 'DELETE' }); } catch {}
    if (endingStreamId) cleanupStream(endingStreamId);

    // Check if other streams are still live
    try {
        const data = await api('/streams/mine');
        const remaining = (data.streams || []).filter(s => s.is_live);
        if (remaining.length > 0) {
            const withState = remaining.find(s => broadcastState.streams.has(s.id));
            const nextStream = withState || remaining[0];
            await buildBroadcastTabs(nextStream.id);
            await switchOrResumeStream(nextStream);
            toast('Stream ended', 'info');
            return;
        }
    } catch {}

    hideBroadcastTabs();
    clearGlobalDisplayTimers();
    if (!isStreaming()) setNavLiveIndicator(false);
    showStreamManager(); loadExistingStreams(); toast('Stream ended', 'info');
}

/* ── Device Enumeration ──────────────────────────────────────── */
async function populateDeviceLists() {
    try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => null);
        const devices = await navigator.mediaDevices.enumerateDevices();
        const camSelect = document.getElementById('bc-forceCamera');
        const audioSelect = document.getElementById('bc-forceAudio');
        if (!camSelect || !audioSelect) return;
        camSelect.innerHTML = '<option value="default">Default</option>';
        audioSelect.innerHTML = '<option value="default">Default</option>';
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Device ${d.deviceId.slice(0, 8)}`;
            if (d.kind === 'videoinput') camSelect.appendChild(opt);
            if (d.kind === 'audioinput') audioSelect.appendChild(opt.cloneNode(true));
        });
        if (broadcastState.settings.forceCamera !== 'default') camSelect.value = broadcastState.settings.forceCamera;
        if (broadcastState.settings.forceAudio !== 'default') audioSelect.value = broadcastState.settings.forceAudio;
        if (tempStream) tempStream.getTracks().forEach(t => t.stop());
    } catch (err) { console.warn('Could not enumerate devices:', err.message); }
}

/**
 * Check if we already have media permissions (devices have labels).
 * If so, show the device selects. Otherwise show the Request Permissions button.
 */
async function populateCreateFormDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasLabels = devices.some(d => d.label);
        const permReq = document.getElementById('bc-perm-request');
        const devSelects = document.getElementById('bc-device-selects');
        if (hasLabels) {
            // Already have permissions — show dropdowns directly
            if (permReq) permReq.style.display = 'none';
            if (devSelects) devSelects.style.display = '';
            _populateCreateDeviceDropdowns(devices);
        } else {
            // No permissions yet — show the request button
            if (permReq) permReq.style.display = '';
            if (devSelects) devSelects.style.display = 'none';
        }
    } catch (err) { console.warn('Could not enumerate devices for create form:', err.message); }
}

/**
 * User clicked "Allow Camera & Mic" — request permissions, then populate lists.
 */
async function requestMediaPermissions() {
    const permReq = document.getElementById('bc-perm-request');
    const devSelects = document.getElementById('bc-device-selects');
    try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        tempStream.getTracks().forEach(t => t.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        _populateCreateDeviceDropdowns(devices);
        if (permReq) permReq.style.display = 'none';
        if (devSelects) devSelects.style.display = '';
        toast('Camera & microphone access granted', 'success');
    } catch (err) {
        console.warn('Permission request failed:', err.message);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            toast('Camera/mic permission denied — check your browser settings', 'error');
        } else {
            toast('Could not access camera/mic: ' + err.message, 'error');
        }
    }
}

function _populateCreateDeviceDropdowns(devices) {
    const camSelect = document.getElementById('bc-create-camera');
    const audioSelect = document.getElementById('bc-create-audio');
    if (camSelect) {
        camSelect.innerHTML = '<option value="default">Default</option>';
        devices.filter(d => d.kind === 'videoinput').forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Camera ${d.deviceId.slice(0, 8)}`;
            camSelect.appendChild(opt);
        });
    }
    if (audioSelect) {
        audioSelect.innerHTML = '<option value="default">Default</option>';
        devices.filter(d => d.kind === 'audioinput').forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Mic ${d.deviceId.slice(0, 8)}`;
            audioSelect.appendChild(opt);
        });
    }
}

/* ── TTS Voice Population ─────────────────────────────────────── */
function populateTTSVoices() {
    const select = document.getElementById('bc-ttsVoice');
    if (!select) return;
    const loadVoices = () => {
        const voices = speechSynthesis.getVoices();
        select.innerHTML = '';
        voices.forEach((v, i) => {
            const opt = document.createElement('option'); opt.value = i;
            opt.textContent = `${v.name} (${v.lang})`; select.appendChild(opt);
        });
        if (broadcastState.settings.ttsVoice) select.value = broadcastState.settings.ttsVoice;
    };
    loadVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = loadVoices;
}

/* ── Sync Settings UI ────────────────────────────────────────── */
function syncSettingsUI() {
    const s = broadcastState.settings;
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
    setVal('bc-ttsVolume', s.ttsVolume); setVal('bc-ttsPitch', s.ttsPitch); setVal('bc-ttsRate', s.ttsRate);
    setVal('bc-ttsDuration', s.ttsDuration); setVal('bc-ttsNames', s.ttsNames); setVal('bc-ttsQueue', s.ttsQueue);
    setVal('bc-notificationVolume', s.notificationVolume); setVal('bc-manualGain', s.manualGain);
    setCheck('bc-autoGain', s.autoGain); setCheck('bc-echoCancellation', s.echoCancellation);
    setCheck('bc-noiseSuppression', s.noiseSuppression); setCheck('bc-manualGainEnabled', s.manualGainEnabled);
    setCheck('bc-force48kSampleRate', s.force48kSampleRate);
    setVal('bc-broadcastRes', s.broadcastRes); setVal('bc-broadcastFps', s.broadcastFps);
    setVal('bc-broadcastCodec', s.broadcastCodec); setVal('bc-broadcastBps', s.broadcastBps);
    setVal('bc-broadcastBpsMin', s.broadcastBpsMin); setVal('bc-broadcastLimit', s.broadcastLimit);
    setVal('bc-allowSounds', s.allowSounds); setVal('bc-soundVolume', s.soundVolume);
    setCheck('bc-screenShare', s.screenShare);
}

function updateBroadcastSetting(key, value) {
    broadcastState.settings[key] = value; saveBroadcastSettings();
}

/* ── Stop Broadcasting ───────────────────────────────────────── */
async function stopBroadcast() {
    const activeId = broadcastState.activeStreamId;
    if (activeId) await uploadVodRecording(activeId);
    try { if (activeId) await api(`/streams/${activeId}`, { method: 'DELETE' }); } catch {}
    if (activeId) cleanupStream(activeId);

    // Check if other streams are still live
    try {
        const data = await api('/streams/mine');
        const remaining = (data.streams || []).filter(s => s.is_live);
        if (remaining.length > 0) {
            const withState = remaining.find(s => broadcastState.streams.has(s.id));
            const nextStream = withState || remaining[0];
            await buildBroadcastTabs(nextStream.id);
            await switchOrResumeStream(nextStream);
            toast('Stream ended', 'info');
            return;
        }
    } catch {}

    hideBroadcastTabs();
    clearGlobalDisplayTimers();
    if (!isStreaming()) setNavLiveIndicator(false);
    showStreamManager(); loadExistingStreams(); toast('Stream ended', 'info');
}

/**
 * Clean up a single stream's state (media, signaling, timers).
 */
function cleanupStream(streamId) {
    const ss = broadcastState.streams.get(streamId);
    if (!ss) return;

    // Leave the broadcast call if we're in one for this stream
    if (callState.broadcastMode && callState.streamId === streamId) {
        leaveBroadcastCall();
    }

    // Stop media tracks
    if (ss.localStream) { ss.localStream.getTracks().forEach(t => t.stop()); ss.localStream = null; }

    // Close viewer connections
    for (const [, pc] of ss.viewerConnections) { try { pc.close(); } catch {} }
    ss.viewerConnections.clear();

    // Close signaling WS
    ss.signalingIntentionalClose = true;
    ss.signalingReconnectDelay = 3000;
    if (ss.signalingReconnectTimer) { clearTimeout(ss.signalingReconnectTimer); ss.signalingReconnectTimer = null; }
    if (ss.signalingWs) { try { ss.signalingWs.close(); } catch {} ss.signalingWs = null; }

    // Close audio context
    if (ss.audioContext) { ss.audioContext.close().catch(() => {}); ss.audioContext = null; }

    // Stop VOD recording (chunks already safely on server)
    if (ss.vodRecorder && ss.vodRecorder.state !== 'inactive') { try { ss.vodRecorder.stop(); } catch {} }
    ss.vodRecorder = null; ss.vodChunks = []; ss.vodUploading = false;

    // Clear per-stream timers
    clearInterval(ss.heartbeatInterval);
    ss.heartbeatInterval = null;

    // Remove from map
    broadcastState.streams.delete(streamId);

    // If this was the active stream, clear the preview and switch to another if possible
    if (broadcastState.activeStreamId === streamId) {
        broadcastState.activeStreamId = null;
        const preview = document.getElementById('bc-video-preview'); if (preview) preview.srcObject = null;

        if (broadcastState.streams.size > 0) {
            const [nextId, nextSs] = [...broadcastState.streams.entries()][0];
            broadcastState.activeStreamId = nextId;
            if (nextSs.localStream) {
                const p = document.getElementById('bc-video-preview');
                if (p) { p.srcObject = nextSs.localStream; p.muted = true; p.play().catch(() => {}); }
            }
        }
    }

    if (!isStreaming()) {
        setNavLiveIndicator(false);
        clearGlobalDisplayTimers();
    }
}

/**
 * Clean up ALL streams (full teardown).
 */
function cleanupAllStreams() {
    for (const streamId of [...broadcastState.streams.keys()]) {
        cleanupStream(streamId);
    }
    clearGlobalDisplayTimers();
    broadcastState.activeStreamId = null;
    setNavLiveIndicator(false);
}

function setNavLiveIndicator(isLive) {
    const el = document.getElementById('nav-live-indicator');
    if (el) el.style.display = isLive ? '' : 'none';
}

/* ── Global Display Timers (Stats + Uptime) ──────────────────── */

function startGlobalDisplayTimers() {
    // Stats polling — reads from active stream
    clearInterval(_globalStatsInterval);
    _globalStatsInterval = setInterval(async () => {
        const ss = getActiveStreamState();
        if (!ss || ss.statsPollPending) return;
        ss.statsPollPending = true;
        let totalBytesSent = 0, frameRate = 0, resolution = '', connState = 'waiting', codec = '';
        try {
            if (ss.viewerConnections.size === 0) {
                if (ss.localStream) {
                    const vt = ss.localStream.getVideoTracks()[0];
                    if (vt) { const st = vt.getSettings(); resolution = `${st.width || '?'}x${st.height || '?'}`; frameRate = st.frameRate || 0; }
                    connState = ss.signalingWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
                }
            } else {
                for (const [, pc] of ss.viewerConnections) {
                    try {
                        connState = pc.iceConnectionState;
                        const stats = await pc.getStats();
                        stats.forEach(r => {
                            if (r.type === 'outbound-rtp' && r.kind === 'video') { totalBytesSent = r.bytesSent || 0; frameRate = r.framesPerSecond || 0; if (r.frameWidth && r.frameHeight) resolution = `${r.frameWidth}x${r.frameHeight}`; }
                            if (r.type === 'codec' && r.mimeType?.startsWith('video/')) codec = r.mimeType.replace('video/', '');
                        }); break;
                    } catch {}
                }
            }
            const now = Date.now(); let bitrateKbps = 0;
            if (ss.lastStatTime > 0 && totalBytesSent > 0) { const db = totalBytesSent - ss.lastStatBytes; const dm = now - ss.lastStatTime; if (dm > 0 && db >= 0) bitrateKbps = Math.round((db * 8) / dm); }
            ss.lastStatBytes = totalBytesSent; ss.lastStatTime = now;
            const setT = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
            setT('bc-stat-bitrate', ss.viewerConnections.size > 0 ? `${bitrateKbps} kbps` : 'no viewers');
            setT('bc-stat-fps', `${Math.round(frameRate)} fps`); setT('bc-stat-resolution', resolution || '--');
            setT('bc-stat-status', connState); setT('bc-stat-codec', codec || '--');
        } finally {
            if (ss) ss.statsPollPending = false;
        }
    }, 6000);

    // Uptime — reads from active stream
    clearInterval(_globalUptimeInterval);
    _globalUptimeInterval = setInterval(() => {
        const ss = getActiveStreamState();
        if (!ss || !ss.startedAt) return;
        let raw = ss.startedAt;
        if (typeof raw === 'string' && !raw.includes('T')) raw = raw.replace(' ', 'T') + 'Z';
        const start = new Date(raw).getTime();
        if (isNaN(start)) return;
        const d = Date.now() - start;
        const h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000), sec = Math.floor((d % 60000) / 1000);
        const el = document.getElementById('bc-uptime');
        if (el) el.textContent = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }, 1000);
}

function clearGlobalDisplayTimers() {
    clearInterval(_globalStatsInterval); _globalStatsInterval = null;
    clearInterval(_globalUptimeInterval); _globalUptimeInterval = null;
}

/* ── Per-Stream Heartbeat ────────────────────────────────────── */

function startHeartbeat(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.streamData) return;
    clearInterval(ss.heartbeatInterval);
    const sid = ss.streamData.id;
    ss.heartbeatInterval = setInterval(() => {
        api(`/streams/${sid}/heartbeat`, { method: 'POST' }).catch(() => {});
        // Only capture thumbnail if this is the active stream (has the preview element)
        if (broadcastState.activeStreamId === streamId) captureLiveThumbnail(streamId);
    }, 30000);
}

function captureLiveThumbnail(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.streamData) return;
    if (document.hidden) return;
    if (Date.now() - (ss.lastThumbnailAt || 0) < BROADCAST_THUMBNAIL_INTERVAL_MS) return;
    const sid = ss.streamData.id;
    const video = document.getElementById('bc-video-preview');
    if (!video || !video.videoWidth) return;
    try {
        const canvas = ss.thumbnailCanvas || document.createElement('canvas');
        ss.thumbnailCanvas = canvas;
        ss.thumbnailCtx = ss.thumbnailCtx || canvas.getContext('2d', { alpha: false });
        const ctx = ss.thumbnailCtx;
        if (!ctx) return;
        const scale = 320 / Math.max(video.videoWidth, 1);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        ss.lastThumbnailAt = Date.now();
        api(`/thumbnails/live/${sid}`, { method: 'POST', body: { image: dataUrl } }).catch(() => {});
    } catch {}
}

/* ── Per-Stream VOD Recording (Incremental Chunk Upload) ─────── */

/**
 * Start recording a stream and incrementally uploading chunks to the server.
 * Every 30 seconds a chunk is captured and uploaded, so:
 *  - VOD is viewable while the stream is still live
 *  - If the browser/stream dies unexpectedly, the VOD is preserved
 */
function startVodRecording(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.localStream) return;
    try {
        const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
        if (!mimeType) { console.warn('[VOD] No supported codec'); return; }

        ss.vodChunks = [];          // pending chunks queue
        ss.vodUploading = false;    // upload lock
        ss.vodFinalized = false;    // prevent double finalize
        ss.vodRecorder = new MediaRecorder(ss.localStream, {
            mimeType,
            videoBitsPerSecond: Math.max(600000, Math.round(getTargetVideoBitrate() * 0.85)),
            audioBitsPerSecond: 128000,
        });

        ss.vodRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                ss.vodChunks.push(e.data);
                uploadVodChunk(streamId);   // try to flush immediately
            }
        };

        // Capture chunks every 30 seconds
        ss.vodRecorder.start(30000);
        console.log('[VOD] Incremental recording started for stream', streamId);
    } catch (err) { console.warn('[VOD] Failed to start:', err); }
}

/**
 * Upload the next pending VOD chunk to the server.
 * Sequential — only one upload at a time per stream to maintain chunk order.
 */
async function uploadVodChunk(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || ss.vodUploading || !ss.vodChunks.length || !ss.streamData) return;

    ss.vodUploading = true;
    try {
        // Drain all pending chunks into one blob for this upload
        const blob = new Blob(ss.vodChunks.splice(0), { type: 'video/webm' });
        if (blob.size < 100) { ss.vodUploading = false; return; }

        const fd = new FormData();
        fd.append('chunk', blob, `chunk-${streamId}-${Date.now()}.webm`);

        const resp = await fetch(`/api/vods/stream/${ss.streamData.id}/chunk`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
            body: fd,
        });

        if (resp.ok) {
            const data = await resp.json();
            if (data.vodId) ss.vodId = data.vodId;
        } else {
            console.warn('[VOD] Chunk upload HTTP error:', resp.status);
        }
    } catch (err) {
        console.warn('[VOD] Chunk upload failed:', err.message);
    }
    ss.vodUploading = false;

    // If more chunks arrived while we were uploading, flush again
    if (ss.vodChunks.length > 0) uploadVodChunk(streamId);
}

/**
 * Stop recording and finalize the VOD.
 * Flushes remaining chunks and tells the server to remux for seeking.
 */
async function uploadVodRecording(streamId) {
    const ss = getStreamState(streamId);
    if (!ss) return;

    // Stop the MediaRecorder (triggers final ondataavailable)
    if (ss.vodRecorder && ss.vodRecorder.state !== 'inactive') {
        try { ss.vodRecorder.stop(); } catch {}
        await new Promise(r => setTimeout(r, 500)); // wait for final chunk
    }

    // Flush any remaining chunks
    if (ss.vodChunks && ss.vodChunks.length > 0) {
        await uploadVodChunk(streamId);
        // Wait for upload to complete
        let retries = 0;
        while (ss.vodUploading && retries++ < 20) await new Promise(r => setTimeout(r, 300));
    }

    // Tell server to finalize (remux for seeking, update duration)
    if (ss.streamData && !ss.vodFinalized) {
        ss.vodFinalized = true;
        try {
            await fetch(`/api/vods/stream/${ss.streamData.id}/finalize`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`,
                    'Content-Type': 'application/json',
                },
            });
            console.log('[VOD] Finalized for stream', streamId);
        } catch (err) {
            console.warn('[VOD] Finalize request failed (server will auto-finalize):', err.message);
        }
    }

    ss.vodChunks = [];
    ss.vodRecorder = null;
}

// Upload last chunk on page unload as best-effort
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        for (const [streamId, ss] of broadcastState.streams) {
            if (ss.vodChunks && ss.vodChunks.length > 0 && ss.streamData) {
                // Use sendBeacon for reliable last-chance upload
                const blob = new Blob(ss.vodChunks.splice(0), { type: 'video/webm' });
                if (blob.size > 100) {
                    const fd = new FormData();
                    fd.append('chunk', blob, `chunk-${streamId}-final.webm`);
                    navigator.sendBeacon(`/api/vods/stream/${ss.streamData.id}/chunk?token=${localStorage.getItem('token')}`, fd);
                }
            }
        }
    });
}

/* ── Per-Stream Media Capture ────────────────────────────────── */

/**
 * Start media capture for a specific stream.
 * @param {number} streamId
 * @param {object} [opts] - Optional device overrides
 * @param {string} [opts.cameraId] - Camera device ID (overrides global setting)
 * @param {string} [opts.audioId] - Audio device ID (overrides global setting)
 */
async function startMediaCapture(streamId, opts = {}) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    const s = broadcastState.settings;
    const forceCamera = opts.cameraId || s.forceCamera;
    const forceAudio = opts.audioId || s.forceAudio;
    const resMap = { '360': { w: 640, h: 360 }, '480': { w: 854, h: 480 }, '720': { w: 1280, h: 720 }, '1080': { w: 1920, h: 1080 }, '1440': { w: 2560, h: 1440 } };
    const res = resMap[s.broadcastRes] || resMap['720'];
    let videoConstraints, audioConstraints;

    if (s.screenShare) {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: res.w }, height: { ideal: res.h }, frameRate: { ideal: getBroadcastFrameRate() } }, audio: true });
        videoConstraints = null;
        audioConstraints = buildAudioConstraints(s, forceAudio);
        let audioStream;
        try { audioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false }); } catch { audioStream = null; }
        const combined = new MediaStream();
        screenStream.getVideoTracks().forEach(t => combined.addTrack(t));
        if (audioStream) audioStream.getAudioTracks().forEach(t => combined.addTrack(t));
        else screenStream.getAudioTracks().forEach(t => combined.addTrack(t));
        ss.localStream = combined;
    } else {
        videoConstraints = {
            width: { ideal: res.w },
            height: { ideal: res.h },
            frameRate: { ideal: getBroadcastFrameRate() },
        };
        if (forceCamera && forceCamera !== 'default') videoConstraints.deviceId = { exact: forceCamera };
        audioConstraints = buildAudioConstraints(s, forceAudio);
        try {
            ss.localStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
        } catch (firstErr) {
            // Fallback: drop exact deviceId and max constraints (fixes mobile "Could not start video source")
            console.warn('[Broadcast] getUserMedia failed, retrying with relaxed constraints:', firstErr.message);
            const fallbackVideo = { facingMode: 'user', width: { ideal: res.w }, height: { ideal: res.h }, frameRate: { ideal: getBroadcastFrameRate() } };
            const fallbackAudio = buildAudioConstraints(s, 'default');
            ss.localStream = await navigator.mediaDevices.getUserMedia({ video: fallbackVideo, audio: fallbackAudio });
        }
    }

    optimizeOutgoingStream(streamId);
    applyManualGain(streamId);

    // Only attach to preview if this is the active stream
    if (broadcastState.activeStreamId === streamId) {
        const preview = document.getElementById('bc-video-preview');
        if (preview) { preview.srcObject = ss.localStream; preview.muted = true; preview.play().catch(() => {}); }
        const ph = document.getElementById('bc-video-placeholder'); if (ph) ph.style.display = 'none';
    }
}

function buildAudioConstraints(s, forceAudio) {
    const audio = {};
    const audioDevice = forceAudio || s.forceAudio;
    if (audioDevice && audioDevice !== 'default') audio.deviceId = { exact: audioDevice };
    audio.autoGainControl = !!s.autoGain; audio.echoCancellation = !!s.echoCancellation; audio.noiseSuppression = !!s.noiseSuppression;
    if (s.force48kSampleRate) audio.sampleRate = 48000;
    return audio;
}

function applyManualGain(streamId) {
    const ss = getStreamState(streamId);
    if (!broadcastState.settings.manualGainEnabled || !ss || !ss.localStream) return;
    try {
        const audioTrack = ss.localStream.getAudioTracks()[0]; if (!audioTrack) return;
        const ctx = new AudioContext(); const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
        const gain = ctx.createGain(); gain.gain.value = broadcastState.settings.manualGain / 100;
        source.connect(gain); const dest = ctx.createMediaStreamDestination(); gain.connect(dest);
        ss.localStream.removeTrack(audioTrack); ss.localStream.addTrack(dest.stream.getAudioTracks()[0]);
        ss.audioContext = ctx; ss.gainNode = gain;
    } catch (err) { console.warn('[Broadcast] Manual gain failed:', err); }
}

/* ── Per-Stream Signaling ────────────────────────────────────── */

function connectSignaling(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.streamData || !ss.localStream) return;

    // Clear any pending reconnect
    if (ss.signalingReconnectTimer) { clearTimeout(ss.signalingReconnectTimer); ss.signalingReconnectTimer = null; }

    // Close existing WS cleanly before creating a new one
    if (ss.signalingWs) {
        ss.signalingIntentionalClose = true;
        try { ss.signalingWs.close(); } catch {}
        ss.signalingWs = null;
    }

    const host = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const portSuffix = window.location.port ? `:${window.location.port}` : '';
    const token = localStorage.getItem('token');
    const wsUrl = `${protocol}://${host}${portSuffix}/ws/broadcast?token=${token}&streamId=${ss.streamData.id}&role=broadcaster`;
    const ws = new WebSocket(wsUrl);
    ss.signalingWs = ws;
    ss.signalingIntentionalClose = false;

    ws.onopen = () => {
        console.log(`[Broadcast] Signaling connected for stream ${streamId}`);
        ss.signalingReconnectDelay = 3000; // reset backoff on successful connect
        if (broadcastState.activeStreamId === streamId) updateBroadcastStatus('connected');
    };

    ws.onmessage = async (e) => {
        try { await handleSignalingMessage(streamId, JSON.parse(e.data)); }
        catch (err) { console.error('[Broadcast] Signaling message error:', err); }
    };

    ws.onerror = (err) => {
        console.error(`[Broadcast] Signaling error for stream ${streamId}`);
        if (broadcastState.activeStreamId === streamId) updateBroadcastStatus('error');
    };

    ws.onclose = (ev) => {
        console.log(`[Broadcast] Signaling closed for stream ${streamId} (code=${ev.code}, intentional=${ss.signalingIntentionalClose})`);
        // Only reconnect if this was NOT an intentional close and the stream is still active
        if (ss.signalingIntentionalClose) return;
        if (broadcastState.activeStreamId === streamId) updateBroadcastStatus('disconnected');
        if (broadcastState.streams.has(streamId) && ss.streamData) {
            const delay = ss.signalingReconnectDelay;
            ss.signalingReconnectDelay = Math.min(ss.signalingReconnectDelay * 1.5, 30000);
            console.log(`[Broadcast] Reconnecting signaling for stream ${streamId} in ${Math.round(delay)}ms`);
            ss.signalingReconnectTimer = setTimeout(() => {
                ss.signalingReconnectTimer = null;
                if (broadcastState.streams.has(streamId)) connectSignaling(streamId);
            }, delay);
        }
    };
}

async function createViewerConnection(streamId, viewerPeerId) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    if (ss.viewerConnections.has(viewerPeerId)) closeViewerConnection(streamId, viewerPeerId);
    const s = broadcastState.settings;
    const maxBitrate = getTargetVideoBitrate();
    const maxFrameRate = getBroadcastFrameRate();
    const scaleDownBy = getSuggestedScaleDown(s);
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
    ss.viewerConnections.set(viewerPeerId, pc);
    ss.localStream.getTracks().forEach(track => {
        try {
            track.contentHint = track.kind === 'audio' ? 'speech' : (s.screenShare ? 'detail' : 'motion');
        } catch {}
        pc.addTrack(track, ss.localStream);
    });

    pc.getTransceivers().forEach(t => {
        if (t.sender?.track?.kind === 'video') {
            try { t.direction = 'sendonly'; } catch {}
            try { t.setCodecPreferences?.((RTCRtpReceiver.getCapabilities('video')?.codecs || []).filter(Boolean)); } catch {}
        }
    });

    const codec = s.broadcastCodec || 'auto';
    if (codec !== 'auto' && pc.getTransceivers) {
        const vt = pc.getTransceivers().find(t => t.sender?.track?.kind === 'video');
        if (vt && typeof vt.setCodecPreferences === 'function') {
            try {
                const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
                const mimeMap = { vp8: 'video/VP8', vp9: 'video/VP9', h264: 'video/H264' };
                const pref = codecs.filter(c => c.mimeType === mimeMap[codec]);
                const rest = codecs.filter(c => c.mimeType !== mimeMap[codec]);
                if (pref.length) vt.setCodecPreferences([...pref, ...rest]);
            } catch {}
        }
    }

    pc.getSenders().forEach(sender => {
        if (sender.track?.kind === 'video') {
            const params = sender.getParameters(); if (!params.encodings) params.encodings = [{}];
            params.encodings[0].maxBitrate = maxBitrate;
            params.encodings[0].maxFramerate = maxFrameRate;
            params.encodings[0].scaleResolutionDownBy = scaleDownBy;
            params.encodings[0].priority = 'high';
            const minBps = parseInt(s.broadcastBpsMin); if (minBps > 50) params.encodings[0].minBitrate = minBps * 1000;
            params.degradationPreference = s.screenShare ? 'maintain-resolution' : 'balanced';
            sender.setParameters(params).catch(() => {});
        } else if (sender.track?.kind === 'audio') {
            const params = sender.getParameters();
            if (!params.encodings) params.encodings = [{}];
            params.encodings[0].priority = 'high';
            sender.setParameters(params).catch(() => {});
        }
    });

    pc.onicecandidate = (e) => { if (e.candidate) sendBroadcastSignal(ss, { type: 'ice-candidate', candidate: e.candidate, targetPeerId: viewerPeerId }); };
    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log(`[Broadcast] Stream ${streamId} viewer ${viewerPeerId} ICE state: ${state}`);
        if (state === 'failed' || state === 'closed') {
            closeViewerConnection(streamId, viewerPeerId);
        }
        if (broadcastState.activeStreamId === streamId) updateBroadcastStatusFromConnections(streamId);
    };

    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    sendBroadcastSignal(ss, { type: 'offer', sdp: pc.localDescription, targetPeerId: viewerPeerId });
}

function closeViewerConnection(streamId, viewerPeerId) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    const pc = ss.viewerConnections.get(viewerPeerId);
    if (pc) { try { pc.close(); } catch {} ss.viewerConnections.delete(viewerPeerId); }
}

function updateBroadcastStatusFromConnections(streamId) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    if (broadcastState.activeStreamId !== streamId) return; // Only update UI for active stream
    if (ss.viewerConnections.size === 0) { updateBroadcastStatus(ss.signalingWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'); return; }
    let hasConnected = false;
    for (const [, pc] of ss.viewerConnections) { const s = pc.iceConnectionState; if (s === 'connected' || s === 'completed') hasConnected = true; }
    updateBroadcastStatus(hasConnected ? 'connected' : 'checking');
}

async function handleSignalingMessage(streamId, msg) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    switch (msg.type) {
        case 'viewer-joined':
            if (msg.peerId && ss.localStream) {
                // Skip re-negotiation if the existing peer connection is still healthy
                const existingPc = ss.viewerConnections.get(msg.peerId);
                if (existingPc) {
                    const state = existingPc.iceConnectionState;
                    if (state === 'connected' || state === 'completed') {
                        console.log(`[Broadcast] Stream ${streamId} viewer ${msg.peerId} already connected (ICE: ${state}), skipping re-negotiate`);
                        break;
                    }
                }
                await createViewerConnection(streamId, msg.peerId);
            }
            break;
        case 'viewer-left': if (msg.peerId) closeViewerConnection(streamId, msg.peerId); break;
        case 'answer': { const pc = ss.viewerConnections.get(msg.fromPeerId); if (pc && msg.sdp) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)); break; }
        case 'ice-candidate': { const pc = ss.viewerConnections.get(msg.fromPeerId); if (pc && msg.candidate) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); break; }
        case 'viewer-count': if (broadcastState.activeStreamId === streamId) updateViewerCountBroadcast(msg.count); break;
        case 'welcome': console.log(`[Broadcast] Stream ${streamId} welcome:`, msg); break;
        case 'error': toast(msg.message || 'Broadcast error', 'error'); break;
    }
}

/* ── UI Updates ──────────────────────────────────────────────── */
function updateBroadcastStatus(state) {
    const el = document.getElementById('bc-connection-status'); if (!el) return;
    const map = { connected: { text: 'Connected', cls: 'bc-status-good' }, checking: { text: 'Connecting...', cls: 'bc-status-warn' }, completed: { text: 'Connected', cls: 'bc-status-good' }, disconnected: { text: 'Disconnected', cls: 'bc-status-bad' }, failed: { text: 'Failed', cls: 'bc-status-bad' }, error: { text: 'Error', cls: 'bc-status-bad' }, new: { text: 'Starting...', cls: 'bc-status-warn' } };
    const s = map[state] || { text: state, cls: '' };
    el.textContent = s.text; el.className = 'bc-connection-status ' + s.cls;
}

function updateViewerCountBroadcast(count) { const el = document.getElementById('bc-viewer-count'); if (el) el.textContent = count || 0; }

/* ── Broadcaster Controls ─────────────────────────────────────── */
function flipCamera() {
    const ss = getActiveStreamState();
    if (!ss || !ss.localStream) return;
    const videoTrack = ss.localStream.getVideoTracks()[0]; if (!videoTrack) return;
    const facingMode = videoTrack.getSettings().facingMode;
    const newFacing = (facingMode === 'user') ? 'environment' : 'user';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: newFacing } } }).then(newStream => {
        const newTrack = newStream.getVideoTracks()[0];
        ss.localStream.removeTrack(videoTrack); ss.localStream.addTrack(newTrack); videoTrack.stop();
        for (const [, pc] of ss.viewerConnections) { const sender = pc.getSenders().find(s => s.track?.kind === 'video'); if (sender) sender.replaceTrack(newTrack); }
        const preview = document.getElementById('bc-video-preview'); if (preview) preview.srcObject = ss.localStream;
        toast('Camera flipped', 'success');
    }).catch(err => toast('Could not flip camera: ' + err.message, 'error'));
}

async function toggleScreenShare() {
    broadcastState.settings.screenShare = !broadcastState.settings.screenShare; saveBroadcastSettings();
    const el = document.getElementById('bc-screenShare'); if (el) el.checked = broadcastState.settings.screenShare;
    const ss = getActiveStreamState();
    const streamId = broadcastState.activeStreamId;
    if (ss && ss.localStream && streamId) {
        try {
            ss.localStream.getTracks().forEach(t => t.stop()); await startMediaCapture(streamId);
            const nvt = ss.localStream.getVideoTracks()[0]; const nat = ss.localStream.getAudioTracks()[0];
            for (const [, pc] of ss.viewerConnections) {
                const vs = pc.getSenders().find(s => s.track?.kind === 'video'); if (vs && nvt) vs.replaceTrack(nvt);
                const as = pc.getSenders().find(s => s.track?.kind === 'audio'); if (as && nat) as.replaceTrack(nat);
            }
            toast(broadcastState.settings.screenShare ? 'Screen share on' : 'Camera on', 'success');
        } catch (err) { toast('Failed to switch: ' + err.message, 'error'); broadcastState.settings.screenShare = !broadcastState.settings.screenShare; saveBroadcastSettings(); }
    }
}

function toggleBroadcastStats() { const el = document.getElementById('bc-stats-overlay'); if (el) el.style.display = el.style.display === 'none' ? 'flex' : 'none'; }

/* ── Group Call Controls (broadcaster — shared across all methods) ─ */
let _broadcastCallMode = null;
let _broadcastCallPollTimer = null;

/** Show the call controls section for the current streaming method */
function showBroadcastCallControls() {
    // Show the main call controls (for browser WebRTC panel)
    const mainCtrl = document.getElementById('bc-call-controls');
    if (mainCtrl) mainCtrl.style.display = '';

    // Show method-specific call controls (for RTMP/JSMPEG/WHIP instruction panels)
    ['rtmp', 'jsmpeg', 'whip'].forEach(m => {
        const el = document.getElementById(`bc-call-controls-${m}`);
        if (el) el.style.display = '';
    });

    // Start polling participant count
    _startCallStatusPoll();
}

function hideBroadcastCallControls() {
    const mainCtrl = document.getElementById('bc-call-controls');
    if (mainCtrl) mainCtrl.style.display = 'none';
    ['rtmp', 'jsmpeg', 'whip'].forEach(m => {
        const el = document.getElementById(`bc-call-controls-${m}`);
        if (el) el.style.display = 'none';
    });
    // Hide the participant panel
    const callPanel = document.getElementById('bc-call-panel');
    if (callPanel) callPanel.style.display = 'none';
    _stopCallStatusPoll();
}

function updateBroadcastCallUI() {
    const mode = _broadcastCallMode;
    const labels = { 'mic': 'Voice Chat', 'mic+cam': 'Voice + Camera', 'cam+mic': 'Video Call' };
    const statusText = mode ? `${labels[mode]} — Active` : 'Voice Chat — Off';

    // Update all instances (main + method-specific panels)
    ['', '-rtmp', '-jsmpeg', '-whip'].forEach(suffix => {
        const statusEl = document.getElementById(`bc-call-status-text${suffix}`);
        if (statusEl) {
            statusEl.textContent = statusText;
            statusEl.style.color = mode ? 'var(--success, #22c55e)' : '';
        }
        const sel = document.getElementById(`bc-call-mode-select${suffix}`);
        if (sel) sel.value = mode || '';
        const endBtn = document.getElementById(`bc-call-end-btn${suffix}`);
        if (endBtn) endBtn.style.display = mode ? '' : 'none';
    });
}

async function onCallModeChange(mode) {
    const streamId = broadcastState.activeStreamId;
    if (!streamId) return toast('No active stream', 'error');

    try {
        await api(`/streams/${streamId}/call`, { method: 'PUT', body: { call_mode: mode || null } });
        _broadcastCallMode = mode || null;
        updateBroadcastCallUI();
        toast(mode ? `Group call enabled: ${mode}` : 'Group call disabled', mode ? 'success' : 'info');

        // Auto-join/leave the call as streamer
        if (mode) {
            initBroadcastCallPanel(streamId, mode);
        } else {
            leaveBroadcastCall();
        }
    } catch (e) { toast(e.message, 'error'); }
}

async function endBroadcastCall() {
    const streamId = broadcastState.activeStreamId;
    if (!streamId) return;

    // Leave the WebSocket call first
    leaveBroadcastCall();

    try {
        await api(`/streams/${streamId}/call`, { method: 'PUT', body: { call_mode: null } });
        _broadcastCallMode = null;
        updateBroadcastCallUI();
        toast('Group call ended', 'info');
    } catch (e) { toast(e.message, 'error'); }
}

function _startCallStatusPoll() {
    _stopCallStatusPoll();
    const poll = async () => {
        const streamId = broadcastState.activeStreamId;
        if (!streamId) return;
        try {
            const data = await api(`/streams/${streamId}/call`);
            const count = data.participant_count || 0;
            ['', '-rtmp', '-jsmpeg', '-whip'].forEach(suffix => {
                const el = document.getElementById(`bc-call-count${suffix}`);
                if (el) el.textContent = `${count} in call`;
            });
            // Sync mode from server in case it changed
            if (data.call_mode !== undefined) {
                const newMode = data.call_mode || null;
                const oldMode = _broadcastCallMode;
                _broadcastCallMode = newMode;
                updateBroadcastCallUI();

                // Auto-join if call mode became active and we're not yet in the call
                if (newMode && !callState.joined && !callState.connecting) {
                    initBroadcastCallPanel(streamId, newMode);
                } else if (!newMode && callState.broadcastMode) {
                    leaveBroadcastCall();
                }
            }
        } catch {}
    };
    poll();
    _broadcastCallPollTimer = setInterval(poll, 5000);
}

function _stopCallStatusPoll() {
    if (_broadcastCallPollTimer) {
        clearInterval(_broadcastCallPollTimer);
        _broadcastCallPollTimer = null;
    }
}

/* ── Clipboard Helper ─────────────────────────────────────────── */
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard!', 'success')).catch(() => {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        toast('Copied!', 'success');
    });
}

/* ── TTS System ──────────────────────────────────────────────── */
let ttsQueue = [];
let ttsSpeaking = false;
function testTTS() { speakBroadcastTTS('This is a TTS test message from HoboStreamer'); }
function cancelTTS() { speechSynthesis.cancel(); ttsQueue = []; ttsSpeaking = false; toast('TTS reset', 'info'); }

function speakBroadcastTTS(text, username) {
    const s = broadcastState.settings;
    const maxQueue = parseInt(s.ttsQueue) || 0;
    if (maxQueue > 0 && ttsQueue.length >= maxQueue) return;
    const fullText = s.ttsNames === 'on' && username ? `${username} says: ${text}` : text;
    ttsQueue.push(fullText); processTTSQueue();
}

function processTTSQueue() {
    if (ttsSpeaking || ttsQueue.length === 0) return;
    ttsSpeaking = true;
    const text = ttsQueue.shift(); const s = broadcastState.settings;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = s.ttsVolume / 1000; utterance.pitch = s.ttsPitch / 100; utterance.rate = s.ttsRate / 10;
    const voices = speechSynthesis.getVoices(); const voiceIdx = parseInt(s.ttsVoice);
    if (!isNaN(voiceIdx) && voices[voiceIdx]) utterance.voice = voices[voiceIdx];
    const dur = parseInt(s.ttsDuration) || 0; let timeout = null;
    if (dur > 0) timeout = setTimeout(() => speechSynthesis.cancel(), dur * 1000);
    utterance.onend = () => { if (timeout) clearTimeout(timeout); ttsSpeaking = false; processTTSQueue(); };
    utterance.onerror = () => { if (timeout) clearTimeout(timeout); ttsSpeaking = false; processTTSQueue(); };
    speechSynthesis.speak(utterance);
}

function cancelSounds() { toast('Sounds reset', 'info'); }

/* ── Settings Change Handlers ─────────────────────────────────── */
function initBroadcastSettingsListeners() {
    ['ttsVolume', 'ttsPitch', 'ttsRate', 'notificationVolume', 'soundVolume', 'manualGain'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('input', () => updateBroadcastSetting(key, parseInt(el.value)));
    });
    ['ttsDuration', 'ttsNames', 'ttsQueue', 'broadcastLimit', 'broadcastBps', 'broadcastBpsMin',
     'broadcastRes', 'broadcastFps', 'broadcastCodec', 'forceCamera', 'forceAudio', 'allowSounds', 'ttsVoice'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => updateBroadcastSetting(key, el.value));
    });
    ['autoGain', 'echoCancellation', 'noiseSuppression', 'manualGainEnabled', 'force48kSampleRate', 'screenShare'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => updateBroadcastSetting(key, el.checked));
    });
}

document.addEventListener('DOMContentLoaded', () => { initBroadcastSettingsListeners(); });
