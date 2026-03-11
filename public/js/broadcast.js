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
        viewerReconnectTimers: new Map(),
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
        vodSegmentId: 0,
        // Per-stream signaling reconnect state
        signalingReconnectTimer: null,
        signalingIntentionalClose: false,
        signalingReconnectDelay: 3000,
        mediaRecoveryTimer: null,
        mediaRecoveryAttempts: 0,
        mediaRecoveryInProgress: false,
        lastThumbnailAt: 0,
        thumbnailCanvas: null,
        thumbnailCtx: null,
        statsPollPending: false,
        robotStreamer: null,
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
        ttsMode: 'site-wide', ttsVolume: 800, ttsPitch: 100, ttsRate: 10, ttsVoice: '', ttsDuration: 10, ttsNames: 'off', ttsQueue: 5,
        notificationVolume: 800, forceAudio: 'default', autoGain: true, echoCancellation: true, noiseSuppression: true,
        manualGainEnabled: false, manualGain: 100, force48kSampleRate: false,
        forceCamera: 'default', broadcastRes: '720', broadcastFps: '30', broadcastCodec: 'auto',
        broadcastBps: '2500', broadcastBpsMin: '500', broadcastLimit: 'restart', screenShare: false,
        allowSounds: 'false', soundVolume: 800,
    },
    robotStreamer: {
        loaded: false,
        enabled: false,
        mirrorChat: true,
        hasToken: false,
        robotId: '',
        ownerId: '',
        streamName: '',
        ownerName: '',
        availableRobots: [],
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

function clearViewerReconnectTimer(ss, viewerPeerId) {
    const timer = ss?.viewerReconnectTimers?.get(viewerPeerId);
    if (timer) clearTimeout(timer);
    ss?.viewerReconnectTimers?.delete(viewerPeerId);
}

function scheduleViewerReconnect(streamId, viewerPeerId, delay = 2000) {
    const ss = getStreamState(streamId);
    if (!ss || !viewerPeerId) return;
    clearViewerReconnectTimer(ss, viewerPeerId);
    ss.viewerReconnectTimers.set(viewerPeerId, setTimeout(() => {
        clearViewerReconnectTimer(ss, viewerPeerId);
        if (!broadcastState.streams.has(streamId)) return;
        if (!ss.localStream) return;
        if (!ss.signalingWs || ss.signalingWs.readyState !== WebSocket.OPEN) return;
        createViewerConnection(streamId, viewerPeerId).catch((err) => {
            console.warn(`[Broadcast] Viewer reconnect failed for ${viewerPeerId}:`, err.message);
        });
    }, delay));
}

function attachLocalStreamRecoveryHandlers(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream) return;
    const currentStream = ss.localStream;
    const onMediaLost = (reason) => {
        if (getStreamState(streamId)?.localStream !== currentStream) return;
        scheduleMediaRecovery(streamId, reason);
    };
    currentStream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => onMediaLost(`${track.kind} track ended`), { once: true });
    });
    if (typeof currentStream.addEventListener === 'function') {
        currentStream.addEventListener('inactive', () => onMediaLost('media stream inactive'), { once: true });
    }
}

function scheduleMediaRecovery(streamId, reason = 'media interrupted') {
    const ss = getStreamState(streamId);
    if (!ss || ss.mediaRecoveryInProgress || ss.mediaRecoveryTimer || !broadcastState.streams.has(streamId)) return;

    if (broadcastState.settings.broadcastLimit === 'stop') {
        toast(`Broadcast input lost (${reason}). Stream stopping.`, 'error');
        api(`/streams/${streamId}`, { method: 'DELETE' }).catch(() => {}).finally(() => cleanupStream(streamId));
        return;
    }

    const delay = Math.min(2000 * (ss.mediaRecoveryAttempts + 1), 10000);
    ss.mediaRecoveryAttempts += 1;
    if (broadcastState.activeStreamId === streamId) {
        updateBroadcastStatus('checking');
        toast(`Broadcast interrupted — attempting recovery (${reason})`, 'warning');
    }
    ss.mediaRecoveryTimer = setTimeout(() => {
        ss.mediaRecoveryTimer = null;
        recoverStreamMedia(streamId, reason).catch((err) => {
            console.warn('[Broadcast] Media recovery failed:', err.message);
            const latest = getStreamState(streamId);
            if (!latest) return;
            latest.mediaRecoveryInProgress = false;
            if (latest.mediaRecoveryAttempts < 4) {
                scheduleMediaRecovery(streamId, err.message || reason);
            } else if (broadcastState.activeStreamId === streamId) {
                updateBroadcastStatus('error');
                toast('Broadcast recovery failed — please restart the stream', 'error');
            }
        });
    }, delay);
}

async function recoverStreamMedia(streamId, reason = 'media interrupted') {
    const ss = getStreamState(streamId);
    if (!ss || ss.mediaRecoveryInProgress) return;
    ss.mediaRecoveryInProgress = true;

    const viewerPeerIds = [...ss.viewerConnections.keys()];
    await uploadVodRecording(streamId, { finalizeStream: false });

    // Stop the RS restream BEFORE nulling localStream — prevents the
    // "localStream lost before join" race if an RS start is in-flight.
    const hadRsRestream = !!ss.robotStreamer?.active;
    await stopRobotStreamerRestream(streamId, { quiet: true }).catch(() => {});

    if (ss.localStream) {
        try { ss.localStream.getTracks().forEach((track) => track.stop()); } catch {}
        ss.localStream = null;
    }

    await startMediaCapture(streamId);
    startVodRecording(streamId);

    if (!ss.signalingWs || ss.signalingWs.readyState !== WebSocket.OPEN) {
        connectSignaling(streamId);
    } else {
        for (const peerId of viewerPeerIds) {
            await createViewerConnection(streamId, peerId);
        }
    }

    // Full RS restart after new media is acquired — old producers are dead
    // after a track-ended event so replaceTrack won't work.
    if (hadRsRestream || canUseRobotStreamerRestream()) {
        startRobotStreamerRestream(streamId).catch((err) => {
            console.warn('[RS Restream] Restart after media recovery failed:', err.message);
        });
    }

    ss.mediaRecoveryAttempts = 0;
    ss.mediaRecoveryInProgress = false;
    if (broadcastState.activeStreamId === streamId) {
        updateBroadcastStatusFromConnections(streamId);
        toast(`Broadcast recovered after ${reason}`, 'success');
    }
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

function setRobotStreamerStatus(message, tone = 'info', targetId = 'bc-rsStatus') {
    const el = document.getElementById(targetId);
    if (!el) return;
    const colors = {
        success: 'var(--success, #22c55e)',
        error: 'var(--danger, #ef4444)',
        warning: 'var(--warning, #f59e0b)',
        info: 'var(--text-muted, #9ca3af)',
    };
    el.textContent = message;
    el.style.color = colors[tone] || colors.info;
}

function populateRobotStreamerSelect(robots = [], selectedRobotId = '') {
    const select = document.getElementById('bc-rsRobotSelect');
    if (!select) return;
    const items = Array.isArray(robots) ? robots : [];
    select.innerHTML = '<option value="">Validate to load your RobotStreamer streams</option>';
    items.forEach((robot) => {
        const option = document.createElement('option');
        option.value = robot.robot_id;
        const viewers = Number(robot.viewers || 0);
        option.textContent = `${robot.robot_name || `Robot ${robot.robot_id}`} (${robot.robot_id}) • ${robot.status || 'offline'} • ${viewers} viewer${viewers === 1 ? '' : 's'}`;
        select.appendChild(option);
    });
    if (selectedRobotId) select.value = String(selectedRobotId);
}

function syncRobotStreamerUI() {
    const rs = broadcastState.robotStreamer;
    const setCheck = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };
    const setVal = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };

    setCheck('bc-rsEnabled', rs.enabled);
    setCheck('bc-rsMirrorChat', rs.mirrorChat);
    setVal('bc-rsRobotInput', rs.robotId);
    populateRobotStreamerSelect(rs.availableRobots, rs.robotId);

    const tokenEl = document.getElementById('bc-rsToken');
    if (tokenEl) tokenEl.placeholder = rs.hasToken
        ? 'Saved token on file — paste a new one only if you want to replace it'
        : 'Paste your robotstreamer-token cookie or JWT';

    const summary = rs.ownerName || rs.streamName
        ? `Configured for ${rs.streamName || `Robot ${rs.robotId}`} as ${rs.ownerName || rs.ownerId || 'unknown owner'}.`
        : 'RobotStreamer restreaming works with browser WebRTC broadcasting. Paste your RobotStreamer token, validate a robot, then go live.';
    setRobotStreamerStatus(summary, rs.hasToken ? 'success' : 'info', 'bc-rsStatus');

    // Update live status based on current state
    const liveStatusEl = document.getElementById('bc-rsLiveStatus');
    if (liveStatusEl) {
        // Don't overwrite active status messages from ongoing restream
        const currentText = liveStatusEl.textContent;
        const isActiveStatus = currentText.includes('live') || currentText.includes('connecting') || currentText.includes('reconnect');
        if (!isActiveStatus) {
            if (rs.enabled && rs.hasToken && rs.robotId) {
                setRobotStreamerStatus('RobotStreamer restream ready — will start when you go live.', 'info', 'bc-rsLiveStatus');
            } else if (!rs.enabled) {
                setRobotStreamerStatus('RobotStreamer restream is disabled.', 'info', 'bc-rsLiveStatus');
            } else {
                setRobotStreamerStatus('RobotStreamer needs configuration — validate settings above.', 'info', 'bc-rsLiveStatus');
            }
        }
    }
}

async function loadRobotStreamerIntegration() {
    const doLoad = async () => {
        try {
            const data = await api('/robotstreamer/integration');
            const integration = data.integration || {};
            broadcastState.robotStreamer = {
                loaded: true,
                enabled: !!integration.enabled,
                mirrorChat: integration.mirror_chat !== false,
                hasToken: !!integration.has_token,
                robotId: integration.robot_id || '',
                ownerId: integration.owner_id || '',
                streamName: integration.stream_name || '',
                ownerName: integration.owner_name || '',
                availableRobots: integration.available_robots || [],
            };
            console.log('[Broadcast] RS integration loaded:', { enabled: integration.enabled, hasToken: !!integration.has_token, robotId: integration.robot_id });
            syncRobotStreamerUI();
        } catch (err) {
            broadcastState.robotStreamer.loaded = true; // Mark loaded even on error so we don't block forever
            setRobotStreamerStatus(err.message || 'Failed to load RobotStreamer settings', 'error');
        }
    };
    _robotStreamerIntegrationPromise = doLoad();
    return _robotStreamerIntegrationPromise;
}

function getRobotStreamerFormData() {
    const selectRobot = document.getElementById('bc-rsRobotSelect')?.value || '';
    const inputRobot = document.getElementById('bc-rsRobotInput')?.value.trim() || '';
    return {
        enabled: !!document.getElementById('bc-rsEnabled')?.checked,
        mirror_chat: !!document.getElementById('bc-rsMirrorChat')?.checked,
        token: document.getElementById('bc-rsToken')?.value.trim() || '',
        robot_input: selectRobot || inputRobot,
    };
}

async function validateRobotStreamerIntegration() {
    const payload = getRobotStreamerFormData();
    setRobotStreamerStatus('Validating RobotStreamer settings…', 'info');
    try {
        const data = await api('/robotstreamer/integration/validate', { method: 'POST', body: payload });
        const integration = data.integration || {};
        broadcastState.robotStreamer = {
            ...broadcastState.robotStreamer,
            loaded: true,
            hasToken: !!integration.has_token || !!payload.token,
            robotId: integration.robot_id || payload.robot_input || '',
            ownerId: integration.owner_id || '',
            streamName: integration.stream_name || '',
            ownerName: integration.owner_name || '',
            availableRobots: integration.available_robots || [],
        };
        syncRobotStreamerUI();
        setRobotStreamerStatus(`Validated ${integration.stream_name || `robot ${integration.robot_id}`}.`, 'success');
        toast('RobotStreamer settings validated', 'success');
    } catch (err) {
        setRobotStreamerStatus(err.message || 'RobotStreamer validation failed', 'error');
        toast(err.message || 'RobotStreamer validation failed', 'error');
    }
}

async function saveRobotStreamerIntegration() {
    const payload = getRobotStreamerFormData();
    setRobotStreamerStatus('Saving RobotStreamer settings…', 'info');
    try {
        const data = await api('/robotstreamer/integration', { method: 'PUT', body: payload });
        const integration = data.integration || {};
        broadcastState.robotStreamer = {
            ...broadcastState.robotStreamer,
            loaded: true,
            enabled: !!integration.enabled,
            mirrorChat: integration.mirror_chat !== false,
            hasToken: !!integration.has_token,
            robotId: integration.robot_id || '',
            ownerId: integration.owner_id || '',
            streamName: integration.stream_name || '',
            ownerName: integration.owner_name || '',
            availableRobots: integration.available_robots || broadcastState.robotStreamer.availableRobots || [],
        };
        const tokenEl = document.getElementById('bc-rsToken');
        if (tokenEl) tokenEl.value = '';
        syncRobotStreamerUI();
        setRobotStreamerStatus('RobotStreamer settings saved.', 'success');
        const restreamTargets = [...broadcastState.streams.entries()]
            .filter(([, state]) => state?.localStream)
            .map(([streamId]) => streamId);
        for (const streamId of restreamTargets) {
            if (broadcastState.robotStreamer.enabled) {
                stopRobotStreamerRestream(streamId, { quiet: true })
                    .catch(() => {})
                    .finally(() => startRobotStreamerRestream(streamId).catch(() => {}));
            } else {
                stopRobotStreamerRestream(streamId).catch(() => {});
            }
        }
        toast('RobotStreamer settings saved', 'success');
    } catch (err) {
        setRobotStreamerStatus(err.message || 'Failed to save RobotStreamer settings', 'error');
        toast(err.message || 'Failed to save RobotStreamer settings', 'error');
    }
}

/* ── Broadcast Chat Helper ───────────────────────────────────── */
/**
 * Single entry point for broadcast-page chat. Shows the sidebar and
 * ensures a chat WebSocket is connected for the given stream.
 * Idempotent — safe to call multiple times for the same stream.
 */
function ensureBroadcastChat(streamId) {
    const sidebar = document.getElementById('bc-chat-sidebar');
    if (sidebar) sidebar.style.display = '';
    if (typeof initChat === 'function' && streamId) initChat(streamId);
}

/* ── Initialize Broadcast Page ───────────────────────────────── */
async function loadBroadcastPage() {
    loadBroadcastSettings();
    loadRobotStreamerIntegration().catch(() => {});

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
            ensureBroadcastChat(ss.streamData.id);
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
    } catch (e) { console.warn('Failed to load live streams:', e); }

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
        ensureBroadcastChat(streamId);
        if (!ss.robotStreamer?.active) startRobotStreamerRestream(streamId).catch(() => {});
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
        ensureBroadcastChat(stream.id);
        if (!ss.robotStreamer?.active) startRobotStreamerRestream(stream.id).catch(() => {});
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
            ensureBroadcastChat(stream.id);
            startGlobalDisplayTimers();
            if (!existing.robotStreamer?.active) startRobotStreamerRestream(stream.id).catch(() => {});
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
        ensureBroadcastChat(stream.id);
        startHeartbeat(stream.id);
        await startMediaCapture(stream.id); connectSignaling(stream.id); startRobotStreamerRestream(stream.id).catch(() => {}); startVodRecording(stream.id);
        startGlobalDisplayTimers();
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
        ensureBroadcastChat(stream.id);
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
        ensureBroadcastChat(stream.id);
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
            ensureBroadcastChat(streamData.id);
            await startMediaCapture(streamData.id, { cameraId: createCamera, audioId: createAudio });
            connectSignaling(streamData.id);
            startRobotStreamerRestream(streamData.id).catch(() => {});
            startHeartbeat(streamData.id); startVodRecording(streamData.id);
            startGlobalDisplayTimers();
            showBroadcastCallControls(); updateBroadcastCallUI();
            toast('You are now LIVE!', 'success');
        } else if (method === 'webrtc' && broadcastState.selectedWebRTCSub === 'obs') {
            showWHIPInstructions(streamData); startHeartbeat(streamData.id);
            ensureBroadcastChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            toast('Stream created — configure OBS with the details below', 'success');
        } else if (method === 'rtmp') {
            showRTMPInstructions(streamData); startHeartbeat(streamData.id);
            ensureBroadcastChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            toast('Stream created — configure your streaming software', 'success');
        } else if (method === 'jsmpeg') {
            showJSMPEGInstructions(streamData); startHeartbeat(streamData.id);
            ensureBroadcastChat(streamData.id);
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
        // Try to get a temp stream for permission/label enumeration.
        // On Android, combined audio+video can fail — fall back to separate requests.
        let tempStream = null;
        try {
            tempStream = await _getUserMediaWithTimeout({ audio: true, video: true }, 8000);
        } catch {
            // Separate fallback for Android
            try {
                tempStream = new MediaStream();
                const vs = await _getUserMediaWithTimeout({ video: true }, 6000).catch(() => null);
                const as = await _getUserMediaWithTimeout({ audio: true }, 6000).catch(() => null);
                if (vs) vs.getTracks().forEach(t => tempStream.addTrack(t));
                if (as) as.getTracks().forEach(t => tempStream.addTrack(t));
            } catch {}
        }
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
 * Helper: call getUserMedia with a timeout to avoid indefinite hangs on mobile.
 * Also handles Android-specific quirks:
 *  - Some Android devices need the previous track fully stopped before re-acquiring
 *  - OverconstrainedError gets retried with relaxed constraints
 */
function _getUserMediaWithTimeout(constraints, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Camera/mic request timed out — try tapping Allow in the browser prompt')), timeoutMs);
        navigator.mediaDevices.getUserMedia(constraints).then(stream => {
            clearTimeout(timer);
            resolve(stream);
        }).catch(err => {
            clearTimeout(timer);
            // On OverconstrainedError, retry with relaxed constraints
            if (err.name === 'OverconstrainedError') {
                const relaxed = {};
                if (constraints.video) relaxed.video = typeof constraints.video === 'object' ? { facingMode: constraints.video.facingMode || 'user' } : true;
                if (constraints.audio) relaxed.audio = typeof constraints.audio === 'object' ? { echoCancellation: true } : true;
                console.warn('[Broadcast] OverconstrainedError, retrying with relaxed constraints:', relaxed);
                navigator.mediaDevices.getUserMedia(relaxed).then(resolve).catch(reject);
                return;
            }
            reject(err);
        });
    });
}

/**
 * User clicked "Allow Camera & Mic" — request permissions, then populate lists.
 * On mobile Android, requesting audio+video together can silently fail,
 * so we try combined first, then individually.
 */
async function requestMediaPermissions() {
    console.log('[Broadcast] requestMediaPermissions() called');
    const permReq = document.getElementById('bc-perm-request');
    const devSelects = document.getElementById('bc-device-selects');
    const btn = document.getElementById('bc-perm-btn') || permReq?.querySelector('button');
    const dbg = document.getElementById('bc-perm-debug');
    const btnOrigText = btn?.innerHTML;

    // Immediate visual feedback — if user doesn't see spinner, the function isn't reached
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Requesting access...';
    }
    if (dbg) { dbg.style.display = ''; dbg.textContent = 'Requesting permissions...'; }

    // Feature detection
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const msg = 'Camera/mic API not available — make sure you\'re using HTTPS';
        console.warn('[Broadcast]', msg);
        if (dbg) dbg.textContent = msg;
        toast(msg, 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = btnOrigText; }
        return;
    }

    try {
        let tempStream;
        // Strategy 1: combined audio+video
        try {
            if (dbg) dbg.textContent = 'Requesting camera + mic...';
            tempStream = await _getUserMediaWithTimeout({ audio: true, video: true });
        } catch (firstErr) {
            console.warn('[Broadcast] Combined getUserMedia failed:', firstErr.message, '— trying separately');
            // Strategy 2: separate requests (common on Android)
            if (dbg) dbg.textContent = 'Combined failed, trying separately...';
            let vidStream, audStream;
            try { vidStream = await _getUserMediaWithTimeout({ video: { facingMode: 'user' } }, 10000); } catch (ve) {
                console.warn('[Broadcast] Video facingMode failed:', ve.message);
                // Strategy 2b: bare minimum video
                try { vidStream = await _getUserMediaWithTimeout({ video: true }, 10000); } catch (ve2) {
                    console.warn('[Broadcast] Video-only getUserMedia failed:', ve2.message);
                }
            }
            try { audStream = await _getUserMediaWithTimeout({ audio: true }, 10000); } catch (ae) { console.warn('[Broadcast] Audio-only getUserMedia failed:', ae.message); }
            if (!vidStream && !audStream) throw new Error('No camera or microphone available');
            tempStream = new MediaStream();
            if (vidStream) vidStream.getTracks().forEach(t => { tempStream.addTrack(t); });
            if (audStream) audStream.getTracks().forEach(t => { tempStream.addTrack(t); });
        }
        tempStream.getTracks().forEach(t => t.stop());
        if (dbg) dbg.textContent = 'Enumerating devices...';
        const devices = await navigator.mediaDevices.enumerateDevices();
        _populateCreateDeviceDropdowns(devices);
        if (permReq) permReq.style.display = 'none';
        if (devSelects) devSelects.style.display = '';
        toast('Camera & microphone access granted', 'success');
    } catch (err) {
        console.warn('[Broadcast] Permission request failed:', err.message, err.name);
        const errDetail = `${err.name || 'Error'}: ${err.message}`;
        if (dbg) { dbg.style.display = ''; dbg.textContent = errDetail; }
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            toast('Camera/mic permission denied — check your browser settings or tap the lock icon in the address bar', 'error');
        } else if (err.name === 'NotFoundError') {
            toast('No camera or microphone found on this device', 'error');
        } else if (err.name === 'NotReadableError') {
            toast('Camera/mic in use by another app — close other camera/video apps and try again', 'error');
        } else if (err.name === 'OverconstrainedError') {
            toast('Camera does not support the requested settings — try a different camera', 'error');
        } else {
            toast('Could not access camera/mic: ' + err.message, 'error');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = btnOrigText;
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
    syncRobotStreamerUI();
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
    stopRobotStreamerRestream(streamId, { quiet: true }).catch(() => {});

    // Close viewer connections
    for (const [, pc] of ss.viewerConnections) { try { pc.close(); } catch {} }
    ss.viewerConnections.clear();
    for (const [, timer] of ss.viewerReconnectTimers) clearTimeout(timer);
    ss.viewerReconnectTimers.clear();

    // Close signaling WS
    ss.signalingIntentionalClose = true;
    ss.signalingReconnectDelay = 3000;
    if (ss.signalingReconnectTimer) { clearTimeout(ss.signalingReconnectTimer); ss.signalingReconnectTimer = null; }
    if (ss.mediaRecoveryTimer) { clearTimeout(ss.mediaRecoveryTimer); ss.mediaRecoveryTimer = null; }
    ss.mediaRecoveryAttempts = 0;
    ss.mediaRecoveryInProgress = false;
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
    if (ss.vodRecorder && ss.vodRecorder.state !== 'inactive') return;
    try {
        const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
        if (!mimeType) { console.warn('[VOD] No supported codec'); return; }

        ss.vodChunks = [];          // pending chunks queue
        ss.vodUploading = false;    // upload lock
        ss.vodFinalized = false;    // prevent double finalize on actual stream end
        ss.vodSegmentId = (ss.vodSegmentId || 0) + 1;
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
        console.log('[VOD] Incremental recording started for stream', streamId, 'segment', ss.vodSegmentId);
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
        fd.append('segmentId', String(ss.vodSegmentId || 1));

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
async function uploadVodRecording(streamId, { finalizeStream = true } = {}) {
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
    if (finalizeStream && ss.streamData && !ss.vodFinalized) {
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
    if (finalizeStream) ss.vodSegmentId = 0;
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
                    fd.append('segmentId', String(ss.vodSegmentId || 1));
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
        try { audioStream = await _getUserMediaWithTimeout({ audio: audioConstraints, video: false }); } catch { audioStream = null; }
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
        // Use soft deviceId (not exact) — Android often invalidates device IDs between sessions
        if (forceCamera && forceCamera !== 'default') videoConstraints.deviceId = forceCamera;
        audioConstraints = buildAudioConstraints(s, forceAudio);
        try {
            ss.localStream = await _getUserMediaWithTimeout({ video: videoConstraints, audio: audioConstraints });
        } catch (firstErr) {
            // Fallback 1: drop deviceId, use facingMode (common mobile fix)
            console.warn('[Broadcast] getUserMedia failed, trying facingMode fallback:', firstErr.message);
            try {
                const fallbackVideo = { facingMode: 'user', width: { ideal: res.w }, height: { ideal: res.h } };
                const fallbackAudio = buildAudioConstraints(s, 'default');
                ss.localStream = await _getUserMediaWithTimeout({ video: fallbackVideo, audio: fallbackAudio });
            } catch (secondErr) {
                // Fallback 2: bare minimum — just {video: true, audio: true}
                console.warn('[Broadcast] facingMode fallback failed, trying bare minimum:', secondErr.message);
                try {
                    ss.localStream = await _getUserMediaWithTimeout({ video: true, audio: true });
                } catch (thirdErr) {
                    // Fallback 3: video and audio separately
                    console.warn('[Broadcast] Combined bare failed, trying separate:', thirdErr.message);
                    let vStream, aStream;
                    try { vStream = await _getUserMediaWithTimeout({ video: true }); } catch {}
                    try { aStream = await _getUserMediaWithTimeout({ audio: true }); } catch {}
                    if (!vStream && !aStream) throw new Error('Could not access any camera or microphone');
                    ss.localStream = new MediaStream();
                    if (vStream) vStream.getTracks().forEach(t => ss.localStream.addTrack(t));
                    if (aStream) aStream.getTracks().forEach(t => ss.localStream.addTrack(t));
                }
            }
        }
    }

    optimizeOutgoingStream(streamId);
    applyManualGain(streamId);
    attachLocalStreamRecoveryHandlers(streamId);

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
    // Use soft deviceId (not exact) — Android often invalidates device IDs between sessions
    if (audioDevice && audioDevice !== 'default') audio.deviceId = audioDevice;
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

/* ── RobotStreamer Restream ─────────────────────────────────── */

let _robotStreamerMediasoupModulePromise = null;
let _robotStreamerIntegrationPromise = null;
const RS_RECONNECT_BASE_DELAY = 3000;
const RS_RECONNECT_MAX_DELAY = 30000;

function canUseRobotStreamerRestream() {
    const rs = broadcastState.robotStreamer;
    return !!(rs?.enabled && rs?.hasToken && rs?.robotId);
}

/** Wait for the RS integration to finish loading (resolves immediately if already loaded). */
async function ensureRobotStreamerLoaded() {
    if (broadcastState.robotStreamer.loaded) return;
    if (_robotStreamerIntegrationPromise) {
        await _robotStreamerIntegrationPromise;
    }
}

function getRobotStreamerPublishUrl(streamId) {
    const host = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const portSuffix = window.location.port ? `:${window.location.port}` : '';
    const token = localStorage.getItem('token');
    return `${protocol}://${host}${portSuffix}/ws/robotstreamer-publish?token=${encodeURIComponent(token || '')}&streamId=${encodeURIComponent(streamId)}`;
}

function buildRobotStreamerDeviceDescriptor(device, stream) {
    return {
        name: 'HoboStreamer',
        handlerName: device.handlerName || 'browser',
        loaded: true,
        canProduceAudio: !!stream?.getAudioTracks?.().length,
        canProduceVideo: !!stream?.getVideoTracks?.().length,
    };
}

function createRobotStreamerRpc(ws) {
    let nextId = 1;
    const pending = new Map();
    const RPC_TIMEOUT_MS = 15000;

    ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg?.response || !pending.has(msg.id)) return;
        const deferred = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(deferred.timer);
        if (msg.ok === false) {
            console.warn('[RS RPC] Error response for', deferred.method, ':', msg.error || msg.reason);
            deferred.reject(new Error(msg.error || msg.reason || 'RobotStreamer request failed'));
        } else {
            console.log('[RS RPC] Response OK for', deferred.method);
            deferred.resolve(msg.data);
        }
    });

    const rejectAll = (error) => {
        for (const deferred of pending.values()) { clearTimeout(deferred.timer); deferred.reject(error); }
        pending.clear();
    };

    ws.addEventListener('close', (ev) => {
        const detail = ev.reason ? ` (${ev.code}: ${ev.reason})` : ev.code ? ` (code ${ev.code})` : '';
        rejectAll(new Error(`RobotStreamer publish connection closed${detail}`));
    });
    ws.addEventListener('error', () => rejectAll(new Error('RobotStreamer publish connection failed')));

    return {
        async request(method, data = {}) {
            if (ws.readyState !== WebSocket.OPEN) throw new Error('RobotStreamer publish connection is not open');
            const id = nextId++;
            const payload = { request: true, id, method, data };
            console.log('[RS RPC] Sending:', method, '(id:', id + ')');
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (pending.has(id)) {
                        pending.delete(id);
                        console.error('[RS RPC] Timeout after', RPC_TIMEOUT_MS, 'ms for', method, '(id:', id + ')');
                        reject(new Error(`RobotStreamer RPC timeout: ${method} (no response in ${RPC_TIMEOUT_MS / 1000}s)`));
                    }
                }, RPC_TIMEOUT_MS);
                pending.set(id, { resolve, reject, timer, method });
                ws.send(JSON.stringify(payload));
            });
        },
    };
}

async function loadRobotStreamerMediasoup() {
    if (!_robotStreamerMediasoupModulePromise) {
        _robotStreamerMediasoupModulePromise = import('https://esm.sh/mediasoup-client@3.18.7');
    }
    return _robotStreamerMediasoupModulePromise;
}

async function startRobotStreamerRestream(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream) { console.log('[RS Restream] No localStream, skipping'); return null; }

    // Wait for integration settings to load first (fixes race condition on page load)
    await ensureRobotStreamerLoaded();

    if (!canUseRobotStreamerRestream()) {
        const rs = broadcastState.robotStreamer;
        console.log('[RS Restream] Cannot start — enabled:', rs.enabled, 'hasToken:', rs.hasToken, 'robotId:', rs.robotId);
        if (!rs.enabled) setRobotStreamerStatus('RobotStreamer restream is disabled.', 'info', 'bc-rsLiveStatus');
        return null;
    }
    if (ss.robotStreamer?.active) return ss.robotStreamer;

    // Guard against concurrent startRobotStreamerRestream calls
    if (ss._rsRestreamStarting) {
        console.log('[RS Restream] Already starting for stream', streamId, '— skipping duplicate');
        return null;
    }
    ss._rsRestreamStarting = true;

    /** Check localStream availability — if media recovery is in progress, abort gracefully
     *  (recovery flow will restart RS restream when done). */
    const requireLocalStream = (step) => {
        if (!getStreamState(streamId)) throw new _RSAbortError('stream state gone');
        if (ss.localStream) return true;
        if (ss.mediaRecoveryInProgress || ss.mediaRecoveryTimer) {
            console.log(`[RS Restream] localStream null at ${step} — media recovery active, aborting gracefully`);
            throw new _RSAbortError('media recovery in progress');
        }
        console.log(`[RS Restream] localStream null at ${step} — no recovery active, will retry`);
        return false;
    };

    setRobotStreamerStatus('Connecting RobotStreamer restream…', 'info', 'bc-rsLiveStatus');
    console.log('[RS Restream] Starting for stream', streamId);

    let ws = null;
    try {
        console.log('[RS Restream] Step 1/7: Loading mediasoup-client…');
        setRobotStreamerStatus('Loading mediasoup library…', 'info', 'bc-rsLiveStatus');
        const mod = await loadRobotStreamerMediasoup();
        const Device = mod.Device || mod.default?.Device;
        if (!Device) throw new Error('mediasoup-client failed to load');
        console.log('[RS Restream] Step 1/7 done: mediasoup-client loaded');

        console.log('[RS Restream] Step 2/7: Opening WebSocket to proxy…');
        setRobotStreamerStatus('Connecting to RobotStreamer proxy…', 'info', 'bc-rsLiveStatus');
        const wsUrl = getRobotStreamerPublishUrl(streamId);
        console.log('[RS Restream] WS URL:', wsUrl.replace(/token=[^&]+/, 'token=***'));
        ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', () => reject(new Error('RobotStreamer publish websocket failed')), { once: true });
            ws.addEventListener('close', (ev) => reject(new Error(`RobotStreamer publish websocket closed (${ev.code})`)), { once: true });
        });
        console.log('[RS Restream] Step 2/7 done: WebSocket open');

        const rpc = createRobotStreamerRpc(ws);

        console.log('[RS Restream] Step 3/7: Getting router RTP capabilities…');
        setRobotStreamerStatus('Negotiating RobotStreamer capabilities…', 'info', 'bc-rsLiveStatus');
        const routerRtpCapabilities = await rpc.request('getRouterRtpCapabilities', {});
        console.log('[RS Restream] Step 3/7 done: Got', routerRtpCapabilities?.codecs?.length || 0, 'codecs');

        const device = new Device();
        await device.load({ routerRtpCapabilities });
        console.log('[RS Restream] Device loaded, handler:', device.handlerName);

        console.log('[RS Restream] Step 4/7: Creating WebRTC transport…');
        setRobotStreamerStatus('Creating RobotStreamer transport…', 'info', 'bc-rsLiveStatus');
        const transportInfo = await rpc.request('createWebRtcTransport', { producing: true, consuming: false });
        console.log('[RS Restream] Step 4/7 done: Transport ID:', transportInfo?.id);

        console.log('[RS Restream] Step 5/7: Joining room…');
        setRobotStreamerStatus('Joining RobotStreamer room…', 'info', 'bc-rsLiveStatus');
        if (!requireLocalStream('join')) throw new Error('localStream unavailable for join');
        await rpc.request('join', {
            device: buildRobotStreamerDeviceDescriptor(device, ss.localStream),
            rtpCapabilities: device.rtpCapabilities,
        });
        console.log('[RS Restream] Step 5/7 done: Joined');

        console.log('[RS Restream] Step 6/7: Creating send transport…');
        const transport = device.createSendTransport(transportInfo);
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            rpc.request('connectWebRtcTransport', { transportId: transport.id, dtlsParameters })
                .then(() => callback())
                .catch(errback);
        });
        transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
            rpc.request('produce', { transportId: transport.id, kind, rtpParameters, appData })
                .then((data) => callback({ id: data?.id }))
                .catch(errback);
        });
        transport.on('connectionstatechange', (state) => {
            console.log('[RS Restream] Transport state:', state);
            if (state === 'connected') setRobotStreamerStatus('RobotStreamer restream is live.', 'success', 'bc-rsLiveStatus');
            else if (state === 'connecting') setRobotStreamerStatus('RobotStreamer restream is connecting…', 'info', 'bc-rsLiveStatus');
            else if (state === 'failed') {
                setRobotStreamerStatus('RobotStreamer restream connection failed — will retry.', 'error', 'bc-rsLiveStatus');
                scheduleRobotStreamerReconnect(streamId);
            }
        });

        const session = {
            active: true,
            ws,
            rpc,
            device,
            transport,
            videoProducer: null,
            audioProducer: null,
            reconnectDelay: RS_RECONNECT_BASE_DELAY,
            reconnectTimer: null,
            intentionalClose: false,
        };
        ss.robotStreamer = session;

        console.log('[RS Restream] Step 7/7: Producing tracks…');
        setRobotStreamerStatus('Sending media to RobotStreamer…', 'info', 'bc-rsLiveStatus');
        if (!requireLocalStream('produce')) {
            // Clean up partially-built session
            try { transport.close(); } catch {}
            try { ws.close(1000); } catch {}
            ss.robotStreamer = null;
            throw new Error('localStream unavailable for produce');
        }
        const videoTrack = ss.localStream.getVideoTracks()[0] || null;
        const audioTrack = ss.localStream.getAudioTracks()[0] || null;
        console.log('[RS Restream] Tracks — video:', !!videoTrack, 'audio:', !!audioTrack);
        if (videoTrack) {
            session.videoProducer = await transport.produce({ track: videoTrack });
            console.log('[RS Restream] Video producer ID:', session.videoProducer.id);
        }
        if (audioTrack) {
            session.audioProducer = await transport.produce({ track: audioTrack });
            console.log('[RS Restream] Audio producer ID:', session.audioProducer.id);
        }

        ws.addEventListener('close', (ev) => {
            if (ss.robotStreamer === session) {
                session.active = false;
                if (!session.intentionalClose) {
                    console.warn('[RS Restream] WebSocket closed unexpectedly — code:', ev.code, 'reason:', ev.reason || '(none)');
                    const detail = ev.reason ? ` — ${ev.reason}` : '';
                    setRobotStreamerStatus(`RobotStreamer restream disconnected${detail} — reconnecting…`, 'warning', 'bc-rsLiveStatus');
                    scheduleRobotStreamerReconnect(streamId);
                }
            }
        });

        console.log('[RS Restream] Live! stream:', streamId);
        setRobotStreamerStatus('RobotStreamer restream is live.', 'success', 'bc-rsLiveStatus');
        ss._rsRestreamStarting = false;
        return session;
    } catch (err) {
        ss._rsRestreamStarting = false;
        // If this was a graceful abort (media recovery active), don't schedule reconnect —
        // the recovery flow will restart RS restream when it's done.
        if (err instanceof _RSAbortError) {
            console.log('[RS Restream] Gracefully aborted:', err.message);
            // Clean up WS if it was opened
            if (ws && ws.readyState === WebSocket.OPEN) { try { ws.close(1000); } catch {} }
            ss.robotStreamer = null;
            return null;
        }
        ss.robotStreamer = null;
        setRobotStreamerStatus(err.message || 'RobotStreamer restream failed — will retry.', 'error', 'bc-rsLiveStatus');
        console.warn('[RS Restream] Failed:', err.message);
        scheduleRobotStreamerReconnect(streamId);
        return null;
    }
}

/** Sentinel error class for graceful RS restream aborts (no reconnect needed) */
class _RSAbortError extends Error { constructor(msg) { super(msg); this.name = '_RSAbortError'; } }

function scheduleRobotStreamerReconnect(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream || !canUseRobotStreamerRestream()) return;

    const session = ss.robotStreamer;
    const delay = session?.reconnectDelay || RS_RECONNECT_BASE_DELAY;
    const nextDelay = Math.min(delay * 1.5, RS_RECONNECT_MAX_DELAY);

    // Dedup: clear any previously scheduled reconnect for this stream
    // Check both storage locations to prevent dual-reconnect race
    if (ss._rsReconnectTimer) { clearTimeout(ss._rsReconnectTimer); ss._rsReconnectTimer = null; }
    if (session?.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }

    const timer = setTimeout(async () => {
        ss._rsReconnectTimer = null;
        // Only reconnect if local stream is still live and RS is still enabled
        const currSs = getStreamState(streamId);
        if (!currSs?.localStream || !canUseRobotStreamerRestream()) return;
        console.log('[RS Restream] Attempting reconnect for stream', streamId);

        // Clean up old session
        await stopRobotStreamerRestream(streamId, { quiet: true }).catch(() => {});

        // Start fresh
        const newSession = await startRobotStreamerRestream(streamId);
        // Carry over escalated delay if it failed again
        if (!newSession && currSs.robotStreamer) {
            currSs.robotStreamer.reconnectDelay = nextDelay;
        }
    }, delay);

    // Store timer on BOTH stream state and session for reliable dedup
    ss._rsReconnectTimer = timer;
    if (session) {
        session.reconnectTimer = timer;
        session.reconnectDelay = nextDelay;
    }
}

async function syncRobotStreamerTracks(streamId) {
    const ss = getStreamState(streamId);
    const session = ss?.robotStreamer;
    if (!session?.active || !ss?.localStream) return;
    const videoTrack = ss.localStream.getVideoTracks()[0] || null;
    const audioTrack = ss.localStream.getAudioTracks()[0] || null;

    // Check if producers are still usable — when a track ends, mediasoup closes
    // the producer and replaceTrack() will fail. Detect this and do a full restart.
    const isProducerDead = (p) => {
        if (!p) return false;
        try { return p.closed || p.track?.readyState === 'ended'; } catch { return true; }
    };

    if (isProducerDead(session.videoProducer) || isProducerDead(session.audioProducer)) {
        console.warn('[RS Restream] Producer(s) dead after track change — full restart needed');
        setRobotStreamerStatus('RobotStreamer restream restarting after track change…', 'warning', 'bc-rsLiveStatus');
        stopRobotStreamerRestream(streamId, { quiet: true })
            .catch(() => {})
            .then(() => startRobotStreamerRestream(streamId).catch(() => {}));
        return;
    }

    try {
        if (session.videoProducer && videoTrack) await session.videoProducer.replaceTrack({ track: videoTrack });
        else if (!session.videoProducer && videoTrack) session.videoProducer = await session.transport.produce({ track: videoTrack });

        if (session.audioProducer && audioTrack) await session.audioProducer.replaceTrack({ track: audioTrack });
        else if (!session.audioProducer && audioTrack) session.audioProducer = await session.transport.produce({ track: audioTrack });
    } catch (err) {
        console.warn('[RS Restream] Track sync failed:', err.message, '— restarting');
        setRobotStreamerStatus('RobotStreamer restream restarting…', 'warning', 'bc-rsLiveStatus');
        stopRobotStreamerRestream(streamId, { quiet: true })
            .catch(() => {})
            .then(() => startRobotStreamerRestream(streamId).catch(() => {}));
    }
}

async function stopRobotStreamerRestream(streamId, { quiet = false } = {}) {
    const ss = getStreamState(streamId);
    const session = ss?.robotStreamer;

    // Cancel any pending reconnect timer
    if (session?.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
    if (ss?._rsReconnectTimer) { clearTimeout(ss._rsReconnectTimer); ss._rsReconnectTimer = null; }

    // Clear the "starting" guard so a fresh start can proceed
    if (ss) ss._rsRestreamStarting = false;

    if (!session) return;

    session.intentionalClose = true;
    try { session.videoProducer?.close?.(); } catch {}
    try { session.audioProducer?.close?.(); } catch {}
    try { session.transport?.close?.(); } catch {}
    try { session.ws?.close?.(1000); } catch {}
    ss.robotStreamer = null;

    if (!quiet) setRobotStreamerStatus('RobotStreamer restream stopped.', 'info', 'bc-rsLiveStatus');
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
        const iceState = pc.iceConnectionState;
        console.log(`[Broadcast] Stream ${streamId} viewer ${viewerPeerId} ICE state: ${iceState}`);
        if (iceState === 'connected' || iceState === 'completed') clearViewerReconnectTimer(ss, viewerPeerId);
        if (iceState === 'failed' || iceState === 'disconnected') {
            scheduleViewerReconnect(streamId, viewerPeerId, iceState === 'failed' ? 1500 : 4000);
        }
        if (iceState === 'closed') {
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
    clearViewerReconnectTimer(ss, viewerPeerId);
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
async function flipCamera() {
    const ss = getActiveStreamState();
    if (!ss || !ss.localStream) return;
    const videoTrack = ss.localStream.getVideoTracks()[0]; if (!videoTrack) return;
    const facingMode = videoTrack.getSettings().facingMode;
    const newFacing = (facingMode === 'user') ? 'environment' : 'user';
    // Android requires stopping the old camera BEFORE acquiring the new one
    // (concurrent camera access is often blocked on mobile)
    const oldSettings = videoTrack.getSettings();
    videoTrack.stop();
    ss.localStream.removeTrack(videoTrack);
    try {
        let newStream;
        try {
            // Try with ideal resolution matching the old track
            newStream = await _getUserMediaWithTimeout({ video: {
                facingMode: { ideal: newFacing },
                width: { ideal: oldSettings.width || 1280 },
                height: { ideal: oldSettings.height || 720 }
            } });
        } catch {
            // Bare minimum fallback
            newStream = await _getUserMediaWithTimeout({ video: { facingMode: newFacing } });
        }
        const newTrack = newStream.getVideoTracks()[0];
        ss.localStream.addTrack(newTrack);
        for (const [, pc] of ss.viewerConnections) { const sender = pc.getSenders().find(s => s.track?.kind === 'video'); if (sender) sender.replaceTrack(newTrack); }
        syncRobotStreamerTracks(broadcastState.activeStreamId).catch(() => {});
        const preview = document.getElementById('bc-video-preview'); if (preview) preview.srcObject = ss.localStream;
        toast('Camera flipped', 'success');
    } catch (err) {
        // Failed to get new camera — try to re-acquire the original
        console.error('[Broadcast] flipCamera failed:', err);
        try {
            const recovery = await _getUserMediaWithTimeout({ video: { facingMode: { ideal: facingMode || 'user' } } });
            ss.localStream.addTrack(recovery.getVideoTracks()[0]);
            const preview = document.getElementById('bc-video-preview'); if (preview) preview.srcObject = ss.localStream;
        } catch { /* truly stuck — no video track */ }
        toast('Could not flip camera: ' + err.message, 'error');
    }
}

async function toggleScreenShare() {
    broadcastState.settings.screenShare = !broadcastState.settings.screenShare; saveBroadcastSettings();
    const el = document.getElementById('bc-screenShare'); if (el) el.checked = broadcastState.settings.screenShare;
    const ss = getActiveStreamState();
    const streamId = broadcastState.activeStreamId;
    if (ss && ss.localStream && streamId) {
        try {
            await uploadVodRecording(streamId, { finalizeStream: false });
            ss.localStream.getTracks().forEach(t => t.stop()); await startMediaCapture(streamId);
            startVodRecording(streamId);
            const nvt = ss.localStream.getVideoTracks()[0]; const nat = ss.localStream.getAudioTracks()[0];
            for (const [, pc] of ss.viewerConnections) {
                const vs = pc.getSenders().find(s => s.track?.kind === 'video'); if (vs && nvt) vs.replaceTrack(nvt);
                const as = pc.getSenders().find(s => s.track?.kind === 'audio'); if (as && nat) as.replaceTrack(nat);
            }
            syncRobotStreamerTracks(streamId).catch(() => {});
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
let _bcTtsAudioQueue = [];
let _bcTtsAudioPlaying = false;

function testTTS() {
    const mode = broadcastState.settings.ttsMode || 'site-wide';
    if (mode === 'self') {
        speakBroadcastTTS('This is a TTS test message from HoboStreamer');
    } else {
        // For site-wide, play a test via the server
        speakBroadcastTTS('This is a TTS test message from HoboStreamer');
    }
}
function cancelTTS() {
    speechSynthesis.cancel(); ttsQueue = []; ttsSpeaking = false;
    _bcTtsAudioQueue = []; _bcTtsAudioPlaying = false;
    toast('TTS reset', 'info');
}

function speakBroadcastTTS(text, username) {
    const s = broadcastState.settings;
    if (s.ttsMode === 'off') return;
    const maxQueue = parseInt(s.ttsQueue) || 0;
    if (maxQueue > 0 && ttsQueue.length >= maxQueue) return;
    const fullText = s.ttsNames === 'on' && username ? `${username} says: ${text}` : text;
    ttsQueue.push(fullText); processTTSQueue();
}

/** Play server-synthesized TTS audio on the broadcast page (site-wide mode) */
function playBroadcastTTSAudio(msg) {
    const s = broadcastState.settings;
    if (s.ttsMode !== 'site-wide') return;
    if (!msg.audio || !msg.mimeType) return;
    const maxQueue = parseInt(s.ttsQueue) || 0;
    if (maxQueue > 0 && _bcTtsAudioQueue.length >= maxQueue) return;
    _bcTtsAudioQueue.push(msg);
    _processBcTtsAudioQueue();
}

function _processBcTtsAudioQueue() {
    if (_bcTtsAudioPlaying || _bcTtsAudioQueue.length === 0) return;
    _bcTtsAudioPlaying = true;
    const msg = _bcTtsAudioQueue.shift();
    try {
        const binaryStr = atob(msg.audio);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: msg.mimeType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const s = broadcastState.settings;
        audio.volume = (s.ttsVolume || 800) / 1000;
        audio.onended = () => { URL.revokeObjectURL(url); _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); };
        audio.onerror = () => { URL.revokeObjectURL(url); _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); };
        audio.play().catch(() => { URL.revokeObjectURL(url); _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); });
    } catch {
        _bcTtsAudioPlaying = false;
        _processBcTtsAudioQueue();
    }
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
    ['ttsDuration', 'ttsNames', 'ttsQueue', 'ttsMode', 'broadcastLimit', 'broadcastBps', 'broadcastBpsMin',
     'broadcastRes', 'broadcastFps', 'broadcastCodec', 'forceCamera', 'forceAudio', 'allowSounds', 'ttsVoice'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => updateBroadcastSetting(key, el.value));
    });
    ['autoGain', 'echoCancellation', 'noiseSuppression', 'manualGainEnabled', 'force48kSampleRate', 'screenShare'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => updateBroadcastSetting(key, el.checked));
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initBroadcastSettingsListeners();

    const robotSelect = document.getElementById('bc-rsRobotSelect');
    if (robotSelect) {
        robotSelect.addEventListener('change', () => {
            const input = document.getElementById('bc-rsRobotInput');
            if (input && robotSelect.value) input.value = robotSelect.value;
        });
    }

    // Programmatic click handler for permission button — more reliable than inline onclick on mobile
    const permBtn = document.getElementById('bc-perm-btn');
    if (permBtn) {
        let _permTouchHandled = false;
        permBtn.addEventListener('click', (e) => {
            if (_permTouchHandled) { _permTouchHandled = false; return; }
            e.preventDefault();
            requestMediaPermissions();
        });
        // Belt-and-suspenders: also handle touch directly for mobile browsers
        permBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            _permTouchHandled = true;
            requestMediaPermissions();
        }, { passive: false });
    }
});
