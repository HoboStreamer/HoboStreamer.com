/**
 * HoboStreamer — Group Call Client
 * 
 * Discord-style voice/video group call alongside a live stream.
 * Full-mesh WebRTC: each participant maintains a peer connection to every other.
 * Signaling via WebSocket at /ws/call?streamId=N&token=X
 */

/* ── State ─────────────────────────────────────────────────── */
const callState = {
    ws: null,
    streamId: null,
    channelId: null,     // voice channel ID (e.g. 'public', 'stream-5', 'user-123-...')
    vcMode: false,       // true when connected via voice-channels.js Chat tab
    myPeerId: null,
    callMode: null,     // 'mic', 'mic+cam', 'cam+mic'
    isStreamer: false,
    broadcastMode: false, // true when streamer is in the call from broadcast page
    localStream: null,
    /** @type {Map<string, {pc: RTCPeerConnection, username: string, userId: number|null, isStreamer: boolean, muted: boolean, cameraOff: boolean, forceMuted: boolean, forceCameraOff: boolean, localMuted: boolean, localVolume: number, localCameraOff: boolean, audioEl: HTMLAudioElement|null, videoEl: HTMLVideoElement|null, videoStream: MediaStream|null, avatarUrl: string|null, profileColor: string|null}>} */
    peers: new Map(),
    muted: false,
    cameraOff: true,
    forceMuted: false,         // server-side force mute applied to us
    forceCameraOff: false,     // server-side force camera off applied to us
    joined: false,
    connecting: false,
    intentionalDisconnect: false,
    selectedMic: 'default',
    selectedCam: 'default',
    reconnectTimer: null,
    reconnectDelay: 3000,
    openContextMenu: null,     // currently open peer context menu peerId
    openContextMenuRect: null,
    localUsername: null,
    localAnonId: null,
    localDisplayName: null,
    localUserId: null,
    localNameFX: null,
    localAvatarUrl: null,
    localProfileColor: null,
    localSpeaking: false,
    localSpeechDetected: false,
    inputMode: 'open',
    pttKey: 'Space',
    pttPressed: false,
    vadThreshold: 32,
    audioContext: null,
    localAnalyser: null,
    localSpeechSource: null,
    analysisStream: null,
    levelInterval: null,
    speechHoldUntil: 0,
    statusPollTimer: null,
    lastSyncedCallMode: null,
    popoutPeerId: null,
    popoutWindow: null,
};

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];
const CALL_WS_MAX_BUFFERED_AMOUNT = 256 * 1024;
const CALL_AUDIO_MAX_BITRATE = 32000;
const CALL_VIDEO_MAX_BITRATE = 350000;
const CALL_VIDEO_MAX_FRAMERATE = 15;

_loadCallUserSettings();

/** Resolve element ID based on broadcast vs channel mode */
function _cid(id) {
    if (callState.broadcastMode) {
        const el = document.getElementById('bc-' + id);
        if (el) return el;
    }
    return document.getElementById(id);
}

function _loadCallUserSettings() {
    try {
        const raw = localStorage.getItem('hobo_call_settings');
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (['open', 'ptt', 'vad'].includes(saved.inputMode)) callState.inputMode = saved.inputMode;
        if (typeof saved.pttKey === 'string' && saved.pttKey) callState.pttKey = saved.pttKey;
        const threshold = Number(saved.vadThreshold);
        if (Number.isFinite(threshold)) callState.vadThreshold = Math.max(5, Math.min(80, threshold));
    } catch {}
}

function _saveCallUserSettings() {
    try {
        localStorage.setItem('hobo_call_settings', JSON.stringify({
            inputMode: callState.inputMode,
            pttKey: callState.pttKey,
            vadThreshold: callState.vadThreshold,
        }));
    } catch {}
}

function _syncCallSettingsUI() {
    const mappings = [
        ['call-input-mode', callState.inputMode],
        ['call-input-mode-switch', callState.inputMode],
        ['bc-call-input-mode-switch', callState.inputMode],
        ['vc-input-mode', callState.inputMode],
        ['vc-input-mode-switch', callState.inputMode],
        ['call-ptt-key', callState.pttKey],
        ['call-ptt-key-switch', callState.pttKey],
        ['bc-call-ptt-key-switch', callState.pttKey],
        ['vc-ptt-key', callState.pttKey],
        ['vc-ptt-key-switch', callState.pttKey],
        ['call-vad-threshold', String(callState.vadThreshold)],
        ['call-vad-threshold-switch', String(callState.vadThreshold)],
        ['bc-call-vad-threshold-switch', String(callState.vadThreshold)],
        ['vc-vad-threshold', String(callState.vadThreshold)],
        ['vc-vad-threshold-switch', String(callState.vadThreshold)],
    ];
    mappings.forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });

    ['call-vad-threshold-value', 'call-vad-threshold-value-switch', 'bc-call-vad-threshold-value-switch', 'vc-vad-value', 'vc-vad-switch-value'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = `${callState.vadThreshold}%`;
    });

    const showPtt = callState.inputMode === 'ptt';
    const showVad = callState.inputMode === 'vad';
    ['call-ptt-group', 'call-ptt-switch-group', 'bc-call-ptt-switch-group', 'vc-ptt-group', 'vc-ptt-switch-group'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showPtt ? '' : 'none';
    });
    ['call-vad-group', 'call-vad-switch-group', 'bc-call-vad-switch-group', 'vc-vad-group', 'vc-vad-switch-group'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showVad ? '' : 'none';
    });
    ['call-ptt-status', 'bc-call-ptt-status', 'vc-ptt-status'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showPtt && callState.joined ? '' : 'none';
    });
    ['call-ptt-status-key', 'bc-call-ptt-status-key', 'vc-ptt-status-key'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = _formatCallKey(callState.pttKey);
    });
}

function _formatCallKey(code) {
    const map = { Space: 'Space', KeyV: 'V', KeyT: 'T', AltLeft: 'Left Alt' };
    return map[code] || code;
}

function _resolveParticipantDisplayName(info) {
    if (!info) return 'Unknown';
    if (info.userId || info.username) return info.displayName || info.username || 'Unknown';
    if (info.anonId) return info.anonId;
    if (typeof info.displayName === 'string' && /^anon\d+$/i.test(info.displayName)) return info.displayName;
    return info.displayName || 'Unknown';
}

function _applyLocalParticipantInfo(info) {
    callState.localUsername = info?.username || currentUser?.username || null;
    callState.localAnonId = info?.anonId || null;
    callState.localDisplayName = _resolveParticipantDisplayName(info) || currentUser?.display_name || currentUser?.username || 'You';
    callState.localUserId = info?.userId || currentUser?.id || null;
    callState.localNameFX = info?.nameFX || null;
    callState.localAvatarUrl = info?.avatarUrl || currentUser?.avatar_url || null;
    callState.localProfileColor = info?.profileColor || currentUser?.profile_color || null;
}

function _mergePeerParticipantInfo(peer, info) {
    if (!peer || !info) return;
    peer.username = info.username || null;
    peer.anonId = info.anonId || null;
    peer.displayName = _resolveParticipantDisplayName(info);
    peer.userId = info.userId || null;
    peer.isStreamer = !!info.isStreamer;
    peer.muted = !!info.muted;
    peer.cameraOff = info.cameraOff !== false;
    peer.forceMuted = !!info.forceMuted;
    peer.forceCameraOff = !!info.forceCameraOff;
    peer.speaking = !!info.speaking;
    peer.nameFX = info.nameFX || null;
    peer.avatarUrl = info.avatarUrl || null;
    peer.profileColor = info.profileColor || null;
}

function _optimizeCallSender(sender, track) {
    if (!sender || !track) return;

    try {
        if (track.kind === 'audio') track.contentHint = 'speech';
        if (track.kind === 'video') track.contentHint = 'motion';
    } catch {}

    if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;

    try {
        const params = sender.getParameters() || {};
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        if (track.kind === 'audio') {
            params.encodings[0].maxBitrate = CALL_AUDIO_MAX_BITRATE;
        } else if (track.kind === 'video') {
            params.encodings[0].maxBitrate = CALL_VIDEO_MAX_BITRATE;
            params.encodings[0].maxFramerate = CALL_VIDEO_MAX_FRAMERATE;
        }
        sender.setParameters(params).catch(() => {});
    } catch {}
}

function _syncCallAuthState() {
    if (!callState.ws || callState.ws.readyState !== WebSocket.OPEN || !(callState.channelId || callState.streamId)) return;
    _sendCallMsg({ type: 'auth-update', token: _getAuthToken() || null });
}

/* ── Render Scheduling (coalesce rapid updates) ────────────── */

let _renderDirty = false;
let _renderRAF = null;

/**
 * Schedule a full UI render on the next animation frame.
 * Multiple calls within the same frame are coalesced into one render.
 */
function _scheduleRender() {
    if (_renderDirty) return;
    _renderDirty = true;
    _renderRAF = requestAnimationFrame(() => {
        _renderDirty = false;
        _renderRAF = null;
        _renderCallUI();
    });
}

/**
 * Targeted speaking-state update — avoids full grid rebuild for the most
 * frequent event (~12 updates/sec per speaking participant).
 * Returns true if the tile was found and updated in-place.
 */
function _updateTileSpeaking(peerId, speaking, muted, forceMuted) {
    const gridId = callState.vcMode ? 'vc-participants-grid' : (callState.broadcastMode ? 'bc-call-participants-grid' : 'call-participants-grid');
    const grid = document.getElementById(gridId);
    if (!grid) return false;

    const tile = grid.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
    if (!tile) return false;

    const isSpeaking = speaking && !muted && !forceMuted;
    tile.classList.toggle('is-speaking', isSpeaking);

    // Swap the audio indicator icon in-place
    const indicators = tile.querySelector('.call-indicators');
    if (indicators) {
        const existingIcon = indicators.querySelector('.call-icon-speaking');
        if (isSpeaking && !existingIcon) {
            // Only add speaking icon if not muted (muted icon takes precedence)
            if (!indicators.querySelector('.call-icon-muted') && !indicators.querySelector('.call-icon-force-muted')) {
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-wave-square call-icon-speaking';
                icon.title = 'Speaking';
                indicators.insertBefore(icon, indicators.firstChild);
            }
        } else if (!isSpeaking && existingIcon) {
            existingIcon.remove();
        }
    }

    return true;
}

/* ── Public API (called from stream page) ──────────────────── */

/**
 * Initialize the call panel UI for a stream.
 * Called when a channel page loads and the stream has call_mode set.
 */
function initCallPanel(stream) {
    const panel = document.getElementById('call-panel');
    if (!panel) return;

    callState.broadcastMode = false;

    callState.streamId = stream.id;
    callState.callMode = stream.call_mode;
    callState.lastSyncedCallMode = stream.call_mode || null;
    callState.isStreamer = !!(currentUser && stream.user_id === currentUser.id);

    _syncCallSettingsUI();
    _startViewerCallStatusSync(stream.id);

    if (!stream.call_mode) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = '';

    // Update mode display
    const modeLabel = document.getElementById('call-mode-label');
    if (modeLabel) {
        const labels = { 'mic': 'Voice Chat', 'mic+cam': 'Voice + Camera', 'cam+mic': 'Video Call' };
        modeLabel.textContent = labels[stream.call_mode] || 'Group Call';
    }

    // Update hint text based on mode
    const hint = document.getElementById('call-join-hint');
    if (hint) {
        const hints = {
            'mic': 'Join the voice chat to talk with the streamer and other viewers',
            'mic+cam': 'Join voice chat — you can optionally enable your camera',
            'cam+mic': 'Join the video call — microphone and camera required',
        };
        hint.textContent = hints[stream.call_mode] || '';
    }

    // Show/hide camera elements based on mode
    const camBtn = document.getElementById('call-btn-camera');
    if (camBtn) camBtn.style.display = stream.call_mode === 'mic' ? 'none' : '';

    const camGroup = document.getElementById('call-cam-group');
    if (camGroup) camGroup.style.display = stream.call_mode === 'mic' ? 'none' : '';

    // Reset connected badge
    const connBadge = document.getElementById('call-connected-badge');
    if (connBadge) connBadge.style.display = 'none';

    // Populate device selectors
    _populateCallDevices();

    // Fetch current participants
    _fetchCallStatus(stream.id);
}

/**
 * Initialize the call panel for the broadcast/dashboard page.
 * The streamer auto-joins the call — no join button needed.
 */
function initBroadcastCallPanel(streamId, callMode) {
    const panel = document.getElementById('bc-call-panel');
    if (!panel || !callMode) {
        if (panel) panel.style.display = 'none';
        return;
    }

    // If already in a call for this stream, skip re-init
    if ((callState.joined || callState.connecting) && callState.streamId === streamId && callState.broadcastMode && callState.callMode === callMode) return;

    // Clean up any previous call
    if (callState.joined || callState.connecting) {
        callState.joined = false;
        callState.connecting = false;
        _cleanupCall();
    }

    callState.streamId = streamId;
    callState.callMode = callMode;
    callState.lastSyncedCallMode = callMode;
    callState.isStreamer = true;
    callState.broadcastMode = true;

    // Show/hide camera elements based on mode
    const camBtn = document.getElementById('bc-call-btn-camera');
    if (camBtn) camBtn.style.display = callMode === 'mic' ? 'none' : '';
    const camSwitchGroup = document.getElementById('bc-call-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = callMode === 'mic' ? 'none' : '';

    // Populate device selectors
    _populateCallDevices();
    _syncCallSettingsUI();

    // Auto-join
    joinCall();
}

/** Leave the broadcast call (called when disabling call mode or ending stream) */
function leaveBroadcastCall() {
    if (!callState.broadcastMode) return;
    leaveCall();
    callState.broadcastMode = false;
    const panel = document.getElementById('bc-call-panel');
    if (panel) panel.style.display = 'none';
}

/** Join the group call */
async function joinCall() {
    if (callState.joined || callState.connecting || !(callState.channelId || callState.streamId)) return;

    callState.connecting = true;

    if (callState.reconnectTimer) {
        clearTimeout(callState.reconnectTimer);
        callState.reconnectTimer = null;
    }

    const mode = callState.callMode;
    const constraints = { audio: { deviceId: callState.selectedMic !== 'default' ? { exact: callState.selectedMic } : undefined } };

    // Camera: required for 'cam+mic', optional (user chooses) for 'mic+cam', disabled for 'mic'
    if (mode === 'cam+mic') {
        constraints.video = { deviceId: callState.selectedCam !== 'default' ? { exact: callState.selectedCam } : undefined, width: { ideal: 320 }, height: { ideal: 240 } };
        callState.cameraOff = false;
    } else if (mode === 'mic+cam') {
        // We'll enable mic first; user can toggle camera later
        constraints.video = false;
        callState.cameraOff = true;
    } else {
        // mic only
        constraints.video = false;
        callState.cameraOff = true;
    }

    try {
        callState.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
        callState.connecting = false;
        console.error('[Call] getUserMedia failed:', err);
        const msg = err.name === 'NotFoundError' ? 'No microphone found'
            : err.name === 'NotAllowedError' ? 'Microphone access denied'
            : `Media error: ${err.message}`;
        _callSystemMessage(msg);
        return;
    }

    _setupLocalAudioProcessing();
    _applyLocalAudioGate();

    // Show local preview
    _updateLocalPreview();

    // Connect signaling WebSocket
    _connectCallWs();
}

/** Leave the group call */
function leaveCall() {
    callState.joined = false;
    callState.connecting = false;
    _cleanupCall();
    _renderCallUI();
}

/** Internal cleanup (shared by leave, kick, ban) */
function _cleanupCall() {
    _closeCallVideoPopout();

    callState.intentionalDisconnect = true;

    // Close all peer connections
    for (const [peerId] of callState.peers) {
        _closePeer(peerId);
    }
    callState.peers.clear();

    // Stop local media
    if (callState.localStream) {
        callState.localStream.getTracks().forEach(t => t.stop());
        callState.localStream = null;
    }
    if (callState.analysisStream) {
        callState.analysisStream.getTracks().forEach(t => t.stop());
        callState.analysisStream = null;
    }
    if (callState.levelInterval) {
        clearInterval(callState.levelInterval);
        callState.levelInterval = null;
    }
    if (callState.localSpeechSource) {
        try { callState.localSpeechSource.disconnect(); } catch {}
        callState.localSpeechSource = null;
    }
    callState.localAnalyser = null;
    if (callState.audioContext) {
        try { callState.audioContext.close(); } catch {}
        callState.audioContext = null;
    }

    // Close WebSocket
    if (callState.ws) {
        try { callState.ws.close(); } catch {}
        callState.ws = null;
    }

    if (callState.reconnectTimer) {
        clearTimeout(callState.reconnectTimer);
        callState.reconnectTimer = null;
    }

    callState.myPeerId = null;
    callState.muted = false;
    callState.cameraOff = true;
    callState.forceMuted = false;
    callState.forceCameraOff = false;
    callState.connecting = false;
    _closePeerContextMenu();
    callState.localUsername = null;
    callState.localAnonId = null;
    callState.localDisplayName = null;
    callState.localUserId = null;
    callState.localNameFX = null;
    callState.localAvatarUrl = null;
    callState.localProfileColor = null;
    callState.localSpeaking = false;
    callState.localSpeechDetected = false;
    callState.pttPressed = false;
    callState.speechHoldUntil = 0;
}

/** Toggle mute */
function toggleCallMute() {
    if (callState.forceMuted) {
        _callSystemMessage('You are force-muted by the streamer');
        return;
    }
    callState.muted = !callState.muted;
    _applyLocalAudioGate();
    if (callState.muted && callState.localSpeaking) {
        callState.localSpeaking = false;
        _sendCallMsg({ type: 'speaking', speaking: false });
    }
    if (callState.ws && callState.ws.readyState === WebSocket.OPEN) {
        callState.ws.send(JSON.stringify({ type: 'mute', muted: callState.muted }));
    }
    _renderCallUI();
}

/** Toggle camera */
async function toggleCallCamera() {
    if (callState.callMode === 'mic') return;
    if (callState.forceCameraOff) {
        _callSystemMessage('Your camera is disabled by the streamer');
        return;
    }

    if (callState.cameraOff) {
        // Enable camera
        try {
            const camStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: callState.selectedCam !== 'default' ? { exact: callState.selectedCam } : undefined,
                    width: { ideal: 320 }, height: { ideal: 240 },
                },
            });
            const camTrack = camStream.getVideoTracks()[0];
            callState.localStream.addTrack(camTrack);
            callState.cameraOff = false;

            // Add video track to all existing peer connections
            for (const [peerId, peer] of callState.peers) {
                const sender = peer.pc.addTrack(camTrack, callState.localStream);
                _optimizeCallSender(sender, camTrack);
            }
        } catch (err) {
            console.warn('[Call] Camera enable failed:', err);
            _callSystemMessage('Could not enable camera');
            return;
        }
    } else {
        // Disable camera
        const videoTracks = callState.localStream.getVideoTracks();
        videoTracks.forEach(t => {
            t.stop();
            callState.localStream.removeTrack(t);
        });
        callState.cameraOff = true;

        // Remove video senders from all peer connections
        for (const [peerId, peer] of callState.peers) {
            const senders = peer.pc.getSenders();
            for (const sender of senders) {
                if (sender.track && sender.track.kind === 'video') {
                    peer.pc.removeTrack(sender);
                }
            }
        }
    }

    if (callState.ws && callState.ws.readyState === WebSocket.OPEN) {
        callState.ws.send(JSON.stringify({ type: 'camera-off', cameraOff: callState.cameraOff }));
    }
    _updateLocalPreview();
    _renderCallUI();
}

/** End the call (streamer only) */
function endCall() {
    if (!callState.isStreamer) return;
    if (callState.ws && callState.ws.readyState === WebSocket.OPEN) {
        callState.ws.send(JSON.stringify({ type: 'end-call' }));
    }
    leaveCall();
}

/** Clean up — called when leaving the channel page */
function destroyCall() {
    leaveCall();
    _stopViewerCallStatusSync();
    callState.streamId = null;
    callState.channelId = null;
    callState.vcMode = false;
    callState.callMode = null;
    callState.isStreamer = false;
    callState.broadcastMode = false;
    callState.lastSyncedCallMode = null;
}

/* ── WebSocket Signaling ───────────────────────────────────── */

function _connectCallWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = _getAuthToken();
    const channelParam = callState.channelId || callState.streamId;
    let url = `${proto}//${location.host}/ws/call?channelId=${encodeURIComponent(channelParam)}`;
    if (token) url += `&token=${token}`;

    if (callState.reconnectTimer) {
        clearTimeout(callState.reconnectTimer);
        callState.reconnectTimer = null;
    }

    callState.intentionalDisconnect = false;

    // Defensive: close any lingering WebSocket to prevent duplicate connections
    if (callState.ws) {
        const old = callState.ws;
        old.onclose = null;
        old.onerror = null;
        old.onmessage = null;
        try { old.close(); } catch {}
        callState.ws = null;
    }

    callState.ws = new WebSocket(url);

    callState.ws.onopen = () => {
        callState.reconnectDelay = 3000;
    };

    callState.ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            _handleCallMessage(msg);
        } catch {}
    };

    callState.ws.onclose = () => {
        const shouldReconnect = !callState.intentionalDisconnect && (callState.joined || callState.connecting) && (callState.channelId || callState.streamId);
        callState.ws = null;
        if (shouldReconnect) {
            // Reconnect
            callState.reconnectTimer = setTimeout(() => {
                if (!callState.intentionalDisconnect && (callState.joined || callState.connecting) && (callState.channelId || callState.streamId)) {
                    _connectCallWs();
                }
            }, callState.reconnectDelay);
            callState.reconnectDelay = Math.min(callState.reconnectDelay * 1.5, 15000);
        } else {
            callState.connecting = false;
        }
    };

    callState.ws.onerror = () => {};
}

function _handleCallMessage(msg) {
    switch (msg.type) {
        case 'welcome':
            callState.myPeerId = msg.peerId;
            callState.joined = true;
            callState.connecting = false;
            callState.isStreamer = msg.isStreamer;

            {
                const me = (msg.participants || []).find(p => p.peerId === msg.peerId);
                _applyLocalParticipantInfo(me);
            }

            // Create peer connections to all existing participants
            for (const p of msg.participants) {
                if (p.peerId !== callState.myPeerId) {
                    _createPeerConnection(p.peerId, true /* we initiate offer */, p);
                }
            }
            _renderCallUI();
            _callSystemMessage('You joined the call');
            break;

        case 'peer-joined': {
            _createPeerConnection(msg.peerId, true, msg);
            _renderCallUI();
            _callSystemMessage(`${_resolveParticipantDisplayName(msg)} joined the call`);
            break;
        }

        case 'peer-updated': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                _mergePeerParticipantInfo(peer, msg);
                _scheduleRender();
            }
            break;
        }

        case 'self-updated': {
            callState.isStreamer = !!msg.isStreamer;
            _applyLocalParticipantInfo(msg.participant);
            _scheduleRender();
            break;
        }

        case 'peer-left': {
            const leftPeer = callState.peers.get(msg.peerId);
            const leftName = leftPeer ? (leftPeer.displayName || leftPeer.username) : 'Someone';
            _closePeer(msg.peerId);
            callState.peers.delete(msg.peerId);
            _renderCallUI();
            if (msg.reason === 'kicked') {
                _callSystemMessage(`${leftName} was kicked from the call`);
            } else if (msg.reason === 'banned') {
                _callSystemMessage(`${leftName} was banned from the call`);
            }
            break;
        }

        case 'offer': {
            _handleOffer(msg);
            break;
        }

        case 'answer': {
            _handleAnswer(msg);
            break;
        }

        case 'ice-candidate': {
            _handleIceCandidate(msg);
            break;
        }

        case 'peer-muted': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.muted = msg.muted;
                if (msg.muted) peer.speaking = false;
                _scheduleRender();
            }
            break;
        }

        case 'peer-camera': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.cameraOff = msg.cameraOff;
                _scheduleRender();
            }
            break;
        }

        case 'peer-speaking': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.speaking = !!msg.speaking;
                // Targeted update — skip full grid rebuild for the hottest event
                if (!_updateTileSpeaking(msg.peerId, peer.speaking, peer.muted, peer.forceMuted)) {
                    _scheduleRender();
                }
            }
            break;
        }

        case 'peer-force-muted': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.forceMuted = msg.forceMuted;
                if (msg.forceMuted) peer.speaking = false;
                _scheduleRender();
            }
            break;
        }

        case 'peer-force-camera-off': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.forceCameraOff = msg.forceCameraOff;
                _scheduleRender();
            }
            break;
        }

        case 'force-muted': {
            // Server force-muted us
            callState.forceMuted = msg.forceMuted;
            if (msg.forceMuted) callState.muted = true;
            _applyLocalAudioGate();
            if (callState.localSpeaking) {
                callState.localSpeaking = false;
                _sendCallMsg({ type: 'speaking', speaking: false });
            }
            _callSystemMessage(msg.forceMuted ? 'The streamer muted your microphone for everyone' : 'The streamer unmuted your microphone');
            _renderCallUI();
            break;
        }

        case 'force-camera-off': {
            callState.forceCameraOff = msg.forceCameraOff;
            if (msg.forceCameraOff && callState.localStream && !callState.cameraOff) {
                // Force disable camera
                const videoTracks = callState.localStream.getVideoTracks();
                videoTracks.forEach(t => { t.stop(); callState.localStream.removeTrack(t); });
                callState.cameraOff = true;
                for (const [, peer] of callState.peers) {
                    const senders = peer.pc.getSenders();
                    for (const sender of senders) {
                        if (sender.track && sender.track.kind === 'video') peer.pc.removeTrack(sender);
                    }
                }
            }
            _callSystemMessage(msg.forceCameraOff ? 'The streamer disabled your camera for everyone' : 'The streamer re-enabled your camera permission');
            _renderCallUI();
            break;
        }

        case 'kicked': {
            _callSystemMessage('You were kicked from the call');
            callState.joined = false;
            callState.connecting = false;
            _cleanupCall();
            _renderCallUI();
            break;
        }

        case 'banned': {
            _callSystemMessage('You were banned from the call');
            callState.joined = false;
            callState.connecting = false;
            _cleanupCall();
            _renderCallUI();
            break;
        }

        case 'call-ended': {
            _callSystemMessage('The call has ended');
            leaveCall();
            if (callState.streamId && !callState.broadcastMode) {
                _fetchCallStatus(callState.streamId);
            }
            break;
        }

        case 'participant-count': {
            const badge = document.getElementById('call-count-badge');
            if (badge) badge.textContent = msg.count;
            // Also update broadcast call count elements
            ['', '-rtmp', '-jsmpeg', '-whip'].forEach(suffix => {
                const el = document.getElementById(`bc-call-count${suffix}`);
                if (el) el.textContent = `${msg.count} in call`;
            });
            // Voice channel mode — update channel list counts
            if (callState.vcMode && typeof vcUpdateParticipantCount === 'function') {
                vcUpdateParticipantCount(msg.count);
            }
            break;
        }

        case 'error': {
            _callSystemMessage(msg.message || 'Call error');
            if (!callState.joined) {
                callState.connecting = false;
                _cleanupCall();
                _renderCallUI();
            }
            break;
        }
    }
}

/* ── WebRTC Peer Connection Management ─────────────────────── */

function _createPeerConnection(peerId, initiator, peerInfo) {
    if (callState.peers.has(peerId)) {
        _closePeer(peerId);
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const peer = {
        pc,
        username: peerInfo?.username || null,
        anonId: peerInfo?.anonId || null,
        displayName: _resolveParticipantDisplayName(peerInfo),
        userId: peerInfo?.userId || null,
        isStreamer: peerInfo?.isStreamer || false,
        muted: peerInfo?.muted || false,
        cameraOff: peerInfo?.cameraOff !== false,
        forceMuted: peerInfo?.forceMuted || false,
        forceCameraOff: peerInfo?.forceCameraOff || false,
        speaking: peerInfo?.speaking || false,
        nameFX: peerInfo?.nameFX || null,
        localMuted: false,
        localVolume: 100,
        localCameraOff: false,
        avatarUrl: peerInfo?.avatarUrl || null,
        profileColor: peerInfo?.profileColor || null,
        audioEl: null,
        videoEl: null,
        mediaStream: new MediaStream(),
        videoStream: null,
    };
    callState.peers.set(peerId, peer);

    // Add local tracks to the connection
    if (callState.localStream) {
        callState.localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, callState.localStream);
            _optimizeCallSender(sender, track);
        });
    }

    // ICE candidates
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            _sendCallMsg({
                type: 'ice-candidate',
                targetPeerId: peerId,
                candidate: e.candidate,
            });
        }
    };

    // Remote tracks
    pc.ontrack = (e) => {
        if (e.track.kind === 'audio') {
            _attachPeerAudioTrack(peerId, peer, e.track);
        }

        if (e.track.kind === 'video') {
            _attachPeerVideoTrack(peerId, peer, e.track);
        }
    };

    // Connection state
    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
            _closePeer(peerId);
            callState.peers.delete(peerId);
            _scheduleRender();
        }
    };

    // Negotiation needed — the initiator creates and sends the offer
    if (initiator) {
        pc.onnegotiationneeded = async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                _sendCallMsg({
                    type: 'offer',
                    targetPeerId: peerId,
                    sdp: pc.localDescription,
                });
            } catch (err) {
                console.error('[Call] Offer creation failed:', err);
            }
        };
    }
}

async function _handleOffer(msg) {
    const peerId = msg.fromPeerId;
    if (!callState.peers.has(peerId)) {
        _createPeerConnection(peerId, false, null);
    }
    const peer = callState.peers.get(peerId);
    if (!peer) return;

    try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        _sendCallMsg({
            type: 'answer',
            targetPeerId: peerId,
            sdp: peer.pc.localDescription,
        });
    } catch (err) {
        console.error('[Call] Handle offer failed:', err);
    }
}

async function _handleAnswer(msg) {
    const peer = callState.peers.get(msg.fromPeerId);
    if (!peer) return;
    try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } catch (err) {
        console.error('[Call] Handle answer failed:', err);
    }
}

async function _handleIceCandidate(msg) {
    const peer = callState.peers.get(msg.fromPeerId);
    if (!peer) return;
    try {
        if (msg.candidate) {
            await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
    } catch (err) {
        // ICE candidate errors are common during renegotiation, ignore
    }
}

function _closePeer(peerId) {
    const peer = callState.peers.get(peerId);
    if (!peer) return;
    if (callState.popoutPeerId === peerId) {
        _closeCallVideoPopout();
    }
    if (peer.pc) {
        peer.pc.onicecandidate = null;
        peer.pc.ontrack = null;
        peer.pc.oniceconnectionstatechange = null;
        peer.pc.onnegotiationneeded = null;
        peer.pc.close();
    }
    if (peer.audioEl) {
        peer.audioEl.srcObject = null;
        peer.audioEl.remove();
    }
    if (peer.videoEl) {
        peer.videoEl.srcObject = null;
    }
    if (peer.mediaStream) {
        peer.mediaStream.getTracks().forEach(track => {
            try { peer.mediaStream.removeTrack(track); } catch {}
        });
    }
}

function _attachPeerAudioTrack(peerId, peer, track) {
    if (!peer.mediaStream.getAudioTracks().some(t => t.id === track.id)) {
        peer.mediaStream.getAudioTracks().forEach(t => peer.mediaStream.removeTrack(t));
        peer.mediaStream.addTrack(track);
    }

    if (!peer.audioEl) {
        peer.audioEl = document.createElement('audio');
        peer.audioEl.autoplay = true;
        peer.audioEl.id = `call-audio-${peerId}`;
        document.body.appendChild(peer.audioEl);
    }
    peer.audioEl.srcObject = peer.mediaStream;
    peer.audioEl.volume = (peer.localVolume / 100);
    peer.audioEl.muted = peer.localMuted;
    track.onended = () => {
        if (!callState.peers.has(peerId)) return;
        try { peer.mediaStream.removeTrack(track); } catch {}
    };
}

function _attachPeerVideoTrack(peerId, peer, track) {
    peer.mediaStream.getVideoTracks().forEach(t => {
        if (t.id !== track.id) {
            try { peer.mediaStream.removeTrack(t); } catch {}
        }
    });
    if (!peer.mediaStream.getVideoTracks().some(t => t.id === track.id)) {
        peer.mediaStream.addTrack(track);
    }
    peer.videoStream = peer.mediaStream;
    peer.cameraOff = false;
    if (peer.videoEl) {
        _bindVideoElement(peer.videoEl, peer.videoStream, false);
    }
    _syncCallVideoPopout();
    _scheduleRender();

    track.onunmute = () => {
        peer.cameraOff = false;
        _syncCallVideoPopout();
        _scheduleRender();
    };
    track.onmute = () => {
        _syncCallVideoPopout();
        _scheduleRender();
    };
    track.onended = () => {
        if (!callState.peers.has(peerId)) return;
        try { peer.mediaStream.removeTrack(track); } catch {}
        if (peer.videoStream && peer.videoStream.getVideoTracks().length === 0) {
            peer.videoStream = null;
        }
        _syncCallVideoPopout();
        _scheduleRender();
    };
}

function _peerHasActiveVideo(opts) {
    if (opts.cameraOff || opts.localCameraOff || opts.forceCameraOff) return false;
    if (opts.isLocal) {
        return !!callState.localStream?.getVideoTracks?.().some(track => track.readyState === 'live' && track.enabled !== false);
    }
    const tracks = opts.videoStream?.getVideoTracks?.() || [];
    return tracks.some(track => track.readyState === 'live' && track.muted !== true);
}

function _bindVideoElement(video, stream, muted) {
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = !!muted;
    const playPromise = video.play?.();
    if (playPromise?.catch) playPromise.catch(() => {});
}

function _openCallVideoPopout(peerId) {
    const opts = peerId === callState.myPeerId
        ? {
            peerId,
            displayName: callState.localDisplayName || callState.localAnonId || 'You',
            isLocal: true,
            videoStream: callState.localStream,
        }
        : _getPeerContextMenuOpts(peerId);
    if (!opts) return;

    const stream = opts.isLocal ? callState.localStream : opts.videoStream;
    if (!_peerHasActiveVideo({ ...opts, videoStream: stream, cameraOff: opts.isLocal ? callState.cameraOff : opts.cameraOff, forceCameraOff: opts.isLocal ? callState.forceCameraOff : opts.forceCameraOff })) {
        _callSystemMessage('No active webcam feed available to pop out');
        return;
    }

    let pop = callState.popoutWindow;
    if (!pop || pop.closed) {
        pop = window.open('', 'hobo-call-webcam-popout', 'width=520,height=420,resizable=yes');
        if (!pop) {
            _callSystemMessage('Popup blocked by the browser');
            return;
        }
        callState.popoutWindow = pop;
        pop.document.write(`<!DOCTYPE html><html><head><title>Webcam Popout</title><style>
            html,body{margin:0;background:#000;color:#fff;font-family:system-ui,sans-serif;height:100%;overflow:hidden}
            body{display:flex;flex-direction:column}
            header{padding:10px 12px;background:#111;border-bottom:1px solid #222;font-size:14px;font-weight:600;flex:0 0 auto}
            .stage{position:relative;flex:1 1 auto;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#000;min-height:0}
            video{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;object-position:center center;background:#000}
            .empty{display:flex;align-items:center;justify-content:center;position:absolute;inset:0;color:#aaa;padding:24px;text-align:center}
        </style></head><body><header id="call-popout-title">Webcam</header><div class="stage"><video id="call-popout-video" autoplay playsinline muted></video><div id="call-popout-empty" class="empty" style="display:none">Camera not available</div></div></body></html>`);
        pop.document.close();
        pop.addEventListener('beforeunload', () => {
            if (callState.popoutWindow === pop) {
                callState.popoutWindow = null;
                callState.popoutPeerId = null;
            }
        });
    }

    callState.popoutPeerId = peerId;
    _syncCallVideoPopout();
}

function _syncCallVideoPopout() {
    const pop = callState.popoutWindow;
    if (!pop || pop.closed || !callState.popoutPeerId) return;

    const isLocal = callState.popoutPeerId === callState.myPeerId;
    const peer = isLocal ? null : callState.peers.get(callState.popoutPeerId);
    const stream = isLocal ? callState.localStream : peer?.videoStream;
    const title = isLocal ? (callState.localDisplayName || 'You') : (peer?.displayName || peer?.username || 'Webcam');
    const hasVideo = isLocal
        ? _peerHasActiveVideo({ isLocal: true, videoStream: callState.localStream, cameraOff: callState.cameraOff, forceCameraOff: callState.forceCameraOff })
        : !!peer && _peerHasActiveVideo(peer);

    const titleEl = pop.document.getElementById('call-popout-title');
    const videoEl = pop.document.getElementById('call-popout-video');
    const emptyEl = pop.document.getElementById('call-popout-empty');
    if (!titleEl || !videoEl || !emptyEl) return;

    titleEl.textContent = `${title} Webcam`;
    if (hasVideo && stream) {
        emptyEl.style.display = 'none';
        videoEl.style.display = '';
        _bindVideoElement(videoEl, stream, true);
    } else {
        videoEl.style.display = 'none';
        videoEl.srcObject = null;
        emptyEl.style.display = 'flex';
    }
}

function _closeCallVideoPopout() {
    if (callState.popoutWindow && !callState.popoutWindow.closed) {
        callState.popoutWindow.close();
    }
    callState.popoutWindow = null;
    callState.popoutPeerId = null;
}

/* ── UI Rendering ──────────────────────────────────────────── */

function _renderCallUI() {
    _syncCallSettingsUI();

    // Voice channel mode — delegate rendering to voice-channels.js
    if (callState.vcMode && typeof vcRenderUI === 'function') {
        vcRenderUI();
        return;
    }

    const isBroadcast = callState.broadcastMode;
    const panel = isBroadcast ? document.getElementById('bc-call-panel') : document.getElementById('call-panel');
    if (!panel) return;

    const joinArea = isBroadcast ? null : document.getElementById('call-join-area');
    const activeArea = isBroadcast ? null : document.getElementById('call-active-area');
    const grid = isBroadcast ? document.getElementById('bc-call-participants-grid') : document.getElementById('call-participants-grid');
    const connBadge = isBroadcast ? null : document.getElementById('call-connected-badge');

    if (!callState.joined) {
        if (isBroadcast) {
            panel.style.display = 'none';
        } else {
            if (joinArea) joinArea.style.display = '';
            if (activeArea) activeArea.style.display = 'none';
            if (connBadge) connBadge.style.display = 'none';
        }
        return;
    }

    // Active call
    if (isBroadcast) {
        panel.style.display = '';
    } else {
        if (joinArea) joinArea.style.display = 'none';
        if (activeArea) activeArea.style.display = '';
        if (connBadge) connBadge.style.display = '';
    }

    // Update control buttons
    const muteBtn = _cid('call-btn-mute');
    if (muteBtn) {
        const isMuted = callState.muted || callState.forceMuted;
        muteBtn.innerHTML = isMuted
            ? '<i class="fa-solid fa-microphone-slash"></i>'
            : '<i class="fa-solid fa-microphone"></i>';
        muteBtn.classList.toggle('active', isMuted);
        muteBtn.title = callState.forceMuted ? 'Force-muted by streamer' : (callState.muted ? 'Unmute' : 'Mute');
    }

    const camBtn = _cid('call-btn-camera');
    if (camBtn && callState.callMode !== 'mic') {
        const camOff = callState.cameraOff || callState.forceCameraOff;
        camBtn.innerHTML = camOff
            ? '<i class="fa-solid fa-video-slash"></i>'
            : '<i class="fa-solid fa-video"></i>';
        camBtn.classList.toggle('active', camOff);
        camBtn.title = callState.forceCameraOff ? 'Camera disabled by streamer' : (callState.cameraOff ? 'Enable Camera' : 'Disable Camera');
    }

    // End call button — only for streamer (channel page only; broadcast has its own)
    if (!isBroadcast) {
        const endBtn = document.getElementById('call-btn-end');
        if (endBtn) endBtn.style.display = callState.isStreamer ? '' : 'none';
    }

    // Hide camera device switcher in mic-only mode
    const camSwitchGroup = _cid('call-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = callState.callMode === 'mic' ? 'none' : '';

    // Render participant grid
    if (!grid) return;
    grid.innerHTML = '';

    // Local participant tile
    grid.appendChild(_createParticipantTile({
        peerId: callState.myPeerId,
        username: callState.localUsername,
        displayName: callState.localDisplayName || (currentUser ? (currentUser.display_name || currentUser.username) : 'You'),
        anonId: callState.localAnonId,
        userId: callState.localUserId || currentUser?.id || null,
        isStreamer: callState.isStreamer,
        muted: callState.muted || callState.forceMuted,
        speaking: callState.localSpeaking,
        cameraOff: callState.cameraOff || callState.forceCameraOff,
        forceMuted: callState.forceMuted,
        forceCameraOff: callState.forceCameraOff,
        nameFX: callState.localNameFX,
        avatarUrl: callState.localAvatarUrl || currentUser?.avatar_url || null,
        profileColor: callState.localProfileColor || currentUser?.profile_color || null,
        isLocal: true,
    }));

    // Remote participants
    for (const [peerId, peer] of callState.peers) {
        grid.appendChild(_createParticipantTile({
            peerId,
            username: peer.username,
            anonId: peer.anonId,
            displayName: peer.displayName,
            userId: peer.userId,
            isStreamer: peer.isStreamer,
            muted: peer.muted,
            speaking: peer.speaking,
            cameraOff: peer.cameraOff,
            forceMuted: peer.forceMuted,
            forceCameraOff: peer.forceCameraOff,
            nameFX: peer.nameFX,
            localMuted: peer.localMuted,
            localVolume: peer.localVolume,
            localCameraOff: peer.localCameraOff,
            videoStream: peer.videoStream,
            avatarUrl: peer.avatarUrl,
            profileColor: peer.profileColor,
        }));
    }

    _syncCallVideoPopout();
    _renderFloatingPeerContextMenu();
}

function _createParticipantTile(opts) {
    const tile = document.createElement('div');
    tile.className = 'call-participant-tile';
    tile.dataset.peerId = opts.peerId;
    if (opts.isStreamer) tile.classList.add('is-streamer');
    if (opts.muted || opts.forceMuted) tile.classList.add('is-muted');
    if (opts.localMuted) tile.classList.add('is-local-muted');
    if (opts.speaking && !opts.muted && !opts.forceMuted) tile.classList.add('is-speaking');

    // Video or avatar placeholder
    const showVideo = _peerHasActiveVideo(opts);
    if (showVideo) {
        const video = opts.isLocal ? document.createElement('video') : (callState.peers.get(opts.peerId)?.videoEl || document.createElement('video'));
        video.autoplay = true;
        video.playsInline = true;
        video.className = 'call-video';
        if (opts.isLocal) {
            _bindVideoElement(video, callState.localStream, true);
        } else if (opts.videoStream) {
            const peer = callState.peers.get(opts.peerId);
            if (peer) peer.videoEl = video;
            _bindVideoElement(video, opts.videoStream, false);
        }
        tile.appendChild(video);
    } else {
        const avatar = document.createElement('div');
        avatar.className = 'call-avatar';
        const initial = (opts.displayName || opts.username || opts.anonId || '?')[0].toUpperCase();
        if (opts.avatarUrl) {
            avatar.style.backgroundImage = `url(${opts.avatarUrl})`;
            avatar.style.backgroundSize = 'cover';
            avatar.textContent = '';
        } else {
            if (opts.profileColor) avatar.style.background = opts.profileColor;
            avatar.textContent = initial;
        }
        tile.appendChild(avatar);
    }

    // Status indicators bar (top-right)
    const indicators = document.createElement('div');
    indicators.className = 'call-indicators';
    if (opts.forceMuted) indicators.innerHTML += '<i class="fa-solid fa-microphone-slash call-icon-force-muted" title="Force-muted by streamer"></i>';
    else if (opts.muted) indicators.innerHTML += '<i class="fa-solid fa-microphone-slash call-icon-muted" title="Muted"></i>';
    else if (opts.speaking) indicators.innerHTML += '<i class="fa-solid fa-wave-square call-icon-speaking" title="Speaking"></i>';
    if (opts.forceCameraOff) indicators.innerHTML += '<i class="fa-solid fa-video-slash call-icon-force-cam" title="Camera disabled by streamer"></i>';
    if (opts.localMuted) indicators.innerHTML += '<i class="fa-solid fa-volume-xmark call-icon-local-muted" title="Muted for you"></i>';
    if (opts.localVolume !== undefined && opts.localVolume < 100 && !opts.localMuted && !opts.isLocal) {
        indicators.innerHTML += `<i class="fa-solid fa-volume-low call-icon-low-vol" title="Volume ${opts.localVolume}%"></i>`;
    }
    if (indicators.innerHTML) tile.appendChild(indicators);

    // Name label (bottom)
    const label = document.createElement('div');
    label.className = 'call-participant-label';
    const nameEl = document.createElement('span');
    nameEl.className = `call-name${opts.nameFX?.cssClass ? ` ${opts.nameFX.cssClass}` : ''}${opts.username ? ' call-name-clickable' : ''}`;
    nameEl.textContent = opts.displayName || opts.anonId || opts.username || 'Unknown';
    if (!opts.nameFX?.cssClass && opts.profileColor) {
        nameEl.style.color = opts.profileColor;
    }
    _attachCallUserContextHandlers(nameEl, opts);
    label.appendChild(nameEl);
    if (opts.isStreamer) {
        const streamerIcon = document.createElement('i');
        streamerIcon.className = 'fa-solid fa-broadcast-tower call-streamer-icon';
        streamerIcon.title = 'Streamer';
        label.appendChild(streamerIcon);
    }
    if (opts.isLocal) {
        const youBadge = document.createElement('span');
        youBadge.className = 'call-you-badge';
        youBadge.textContent = '(you)';
        label.appendChild(youBadge);
    }
    tile.appendChild(label);

    // Context menu button (not for local tile)
    if (!opts.isLocal) {
        const menuBtn = document.createElement('button');
        menuBtn.className = 'call-tile-menu-btn';
        menuBtn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
        menuBtn.title = 'Options';
        menuBtn.dataset.peerId = opts.peerId;
        menuBtn.onclick = (e) => {
            e.stopPropagation();
            _togglePeerContextMenu(opts.peerId, menuBtn);
        };
        tile.appendChild(menuBtn);
    }

    if (showVideo) {
        const popoutBtn = document.createElement('button');
        popoutBtn.className = 'call-tile-popout-btn';
        popoutBtn.innerHTML = '<i class="fa-solid fa-up-right-and-down-left-from-center"></i>';
        popoutBtn.title = 'Open webcam popout';
        popoutBtn.onclick = (e) => {
            e.stopPropagation();
            _openCallVideoPopout(opts.peerId);
        };
        tile.appendChild(popoutBtn);
    }

    return tile;
}

function _togglePeerContextMenu(peerId, anchorEl) {
    if (callState.openContextMenu === peerId) {
        _closePeerContextMenu();
        return;
    }
    callState.openContextMenu = peerId;
    callState.openContextMenuRect = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    _renderCallUI();
}

function _closePeerContextMenu() {
    callState.openContextMenu = null;
    callState.openContextMenuRect = null;
    _removeFloatingPeerContextMenu();
}

function _removeFloatingPeerContextMenu() {
    const existing = document.getElementById('call-peer-menu-floating');
    if (existing) existing.remove();
}

function _getPeerContextMenuOpts(peerId) {
    const peer = callState.peers.get(peerId);
    if (!peer) return null;
    return {
        peerId,
        username: peer.username,
        anonId: peer.anonId,
        displayName: peer.displayName,
        userId: peer.userId,
        isStreamer: peer.isStreamer,
        muted: peer.muted,
        cameraOff: peer.cameraOff,
        forceMuted: peer.forceMuted,
        forceCameraOff: peer.forceCameraOff,
        nameFX: peer.nameFX,
        localMuted: peer.localMuted,
        localVolume: peer.localVolume,
        localCameraOff: peer.localCameraOff,
        videoStream: peer.videoStream,
        avatarUrl: peer.avatarUrl,
        profileColor: peer.profileColor,
    };
}

function _renderFloatingPeerContextMenu() {
    _removeFloatingPeerContextMenu();
    if (!callState.openContextMenu) return;

    const opts = _getPeerContextMenuOpts(callState.openContextMenu);
    if (!opts) {
        _closePeerContextMenu();
        return;
    }

    const menu = _buildPeerContextMenu(opts);
    menu.id = 'call-peer-menu-floating';
    menu.classList.add('call-peer-menu-floating');
    document.body.appendChild(menu);

    const anchor = document.querySelector(`.call-tile-menu-btn[data-peer-id="${opts.peerId}"]`);
    const anchorRect = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : callState.openContextMenuRect;
    _positionFloatingPeerContextMenu(menu, anchorRect);
}

function _positionFloatingPeerContextMenu(menu, anchorRect) {
    if (!menu || !anchorRect) return;

    const viewportPad = 8;
    const menuRect = menu.getBoundingClientRect();
    let top = anchorRect.bottom + 6;
    let left = anchorRect.left;

    if (left + menuRect.width > window.innerWidth - viewportPad) {
        left = Math.max(viewportPad, window.innerWidth - menuRect.width - viewportPad);
    }

    if (top + menuRect.height > window.innerHeight - viewportPad) {
        top = anchorRect.top - menuRect.height - 6;
    }

    if (top < viewportPad) {
        top = viewportPad;
    }

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
}

function _buildPeerContextMenu(opts) {
    const menu = document.createElement('div');
    menu.className = 'call-peer-menu';
    menu.onclick = (e) => e.stopPropagation();

    const peer = callState.peers.get(opts.peerId);
    if (!peer) return menu;

    // Header
    const header = document.createElement('div');
    header.className = 'call-peer-menu-header';
    header.innerHTML = `<strong>${_esc(opts.displayName || opts.username || 'Unknown')}</strong>`;
    if (opts.isStreamer) header.innerHTML += ' <i class="fa-solid fa-broadcast-tower" style="color:var(--accent);font-size:0.7rem"></i>';
    menu.appendChild(header);

    if (opts.username && typeof showChatContextMenu === 'function') {
        _addMenuItem(menu, 'fa-id-card', 'View profile', (e) => {
            _closePeerContextMenu();
            _openCallUserContextMenu(opts, e?.currentTarget || null);
        });
    }

    if (_peerHasActiveVideo(opts)) {
        _addMenuItem(menu, 'fa-up-right-and-down-left-from-center', 'Open webcam popout', () => {
            _closePeerContextMenu();
            _openCallVideoPopout(opts.peerId);
        });
    }

    // Volume slider (local)
    const volGroup = document.createElement('div');
    volGroup.className = 'call-peer-menu-item call-peer-vol-group';
    volGroup.innerHTML = `<i class="fa-solid fa-volume-high"></i><span>Volume</span>`;
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '200';
    volSlider.value = peer.localVolume;
    volSlider.className = 'call-vol-slider';
    volSlider.title = `${peer.localVolume}%`;
    volSlider.oninput = (e) => {
        e.stopPropagation();
        const vol = parseInt(volSlider.value);
        peer.localVolume = vol;
        volSlider.title = `${vol}%`;
        if (peer.audioEl) peer.audioEl.volume = Math.min(vol / 100, 1.0);
        // For volumes > 100, we'd need a gain node — keep at 1.0 max for the element
        // but store the preference
    };
    volGroup.appendChild(volSlider);
    menu.appendChild(volGroup);

    // Local mute toggle
    _addMenuItem(menu, peer.localMuted ? 'fa-volume-xmark' : 'fa-volume-high',
        peer.localMuted ? 'Unmute for me' : 'Mute for me', () => {
        peer.localMuted = !peer.localMuted;
        if (peer.audioEl) peer.audioEl.muted = peer.localMuted;
        _closePeerContextMenu();
        _renderCallUI();
    });

    // Local camera hide (if not mic-only)
    if (callState.callMode !== 'mic') {
        _addMenuItem(menu, peer.localCameraOff ? 'fa-eye' : 'fa-eye-slash',
            peer.localCameraOff ? 'Show camera for me' : 'Hide camera for me', () => {
            peer.localCameraOff = !peer.localCameraOff;
            _closePeerContextMenu();
            _renderCallUI();
        });
    }

    // Streamer-only moderation controls
    if (callState.isStreamer && !opts.isStreamer) {
        const divider = document.createElement('div');
        divider.className = 'call-peer-menu-divider';
        menu.appendChild(divider);

        const modLabel = document.createElement('div');
        modLabel.className = 'call-peer-menu-section';
        modLabel.textContent = 'Moderation';
        menu.appendChild(modLabel);

        // Force mute for everyone
        _addMenuItem(menu, peer.forceMuted ? 'fa-microphone' : 'fa-microphone-slash',
            peer.forceMuted ? 'Unmute for everyone' : 'Mute for everyone', () => {
            _sendCallMsg({ type: 'force-mute', targetPeerId: opts.peerId, forceMuted: !peer.forceMuted });
            _closePeerContextMenu();
        }, 'call-peer-menu-mod');

        // Force camera off for everyone (if not mic-only)
        if (callState.callMode !== 'mic') {
            _addMenuItem(menu, peer.forceCameraOff ? 'fa-video' : 'fa-video-slash',
                peer.forceCameraOff ? 'Enable camera for everyone' : 'Disable camera for everyone', () => {
                _sendCallMsg({ type: 'force-camera-off', targetPeerId: opts.peerId, forceCameraOff: !peer.forceCameraOff });
                _closePeerContextMenu();
            }, 'call-peer-menu-mod');
        }

        // Kick
        _addMenuItem(menu, 'fa-right-from-bracket', 'Kick from call', () => {
            _sendCallMsg({ type: 'kick', targetPeerId: opts.peerId });
            _closePeerContextMenu();
        }, 'call-peer-menu-danger');

        // Ban
        _addMenuItem(menu, 'fa-ban', 'Ban from call', () => {
            if (confirm(`Ban ${opts.username} from the call? They won't be able to rejoin.`)) {
                _sendCallMsg({ type: 'ban', targetPeerId: opts.peerId });
                _closePeerContextMenu();
            }
        }, 'call-peer-menu-danger');
    }

    return menu;
}

function _addMenuItem(parent, icon, text, onclick, extraClass) {
    const item = document.createElement('button');
    item.className = 'call-peer-menu-item' + (extraClass ? ` ${extraClass}` : '');
    item.innerHTML = `<i class="fa-solid ${icon}"></i><span>${text}</span>`;
    item.onclick = (e) => { e.stopPropagation(); onclick(e); };
    parent.appendChild(item);
}

function _attachCallUserContextHandlers(el, opts) {
    if (!el || !opts?.username || typeof showChatContextMenu !== 'function') return;
    el.dataset.username = opts.username;
    if (opts.userId) el.dataset.userId = String(opts.userId);
    el.onclick = (e) => {
        e.stopPropagation();
        _openCallUserContextMenu(opts, el);
    };
    el.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        _openCallUserContextMenu(opts, el, e.clientX, e.clientY);
    };
}

function _openCallUserContextMenu(opts, anchorEl, x, y) {
    if (!opts?.username || typeof showChatContextMenu !== 'function') return;
    if (typeof dismissContextMenu === 'function') dismissContextMenu();

    const rect = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    const clientX = x ?? (rect ? rect.left + Math.min(rect.width / 2, 80) : 24);
    const clientY = y ?? (rect ? rect.bottom + 6 : 24);
    const target = anchorEl || document.createElement('span');
    target.dataset.username = opts.username;
    if (opts.userId) target.dataset.userId = String(opts.userId);

    showChatContextMenu({
        preventDefault() {},
        stopPropagation() {},
        currentTarget: target,
        target,
        clientX,
        clientY,
    });
}

function _sendCallMsg(msg) {
    if (callState.ws && callState.ws.readyState === WebSocket.OPEN && callState.ws.bufferedAmount <= CALL_WS_MAX_BUFFERED_AMOUNT) {
        callState.ws.send(JSON.stringify(msg));
    }
}

function _updateLocalPreview() {
    // Local video preview is handled by the tile in _renderCallUI
    _renderCallUI();
}

function _callSystemMessage(text) {
    // In VC mode, log to console (no call-log element in the chat tab)
    if (callState.vcMode) {
        console.log('[VC]', text);
        return;
    }
    const log = _cid('call-log');
    if (log) {
        const el = document.createElement('div');
        el.className = 'call-log-msg';
        el.textContent = text;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        // Keep max 50 messages
        while (log.children.length > 50) log.removeChild(log.firstChild);
    }
}

function _startViewerCallStatusSync(streamId) {
    _stopViewerCallStatusSync();
    if (!streamId || callState.broadcastMode) return;

    const poll = async () => {
        try {
            const data = await api(`/streams/${streamId}/call`);
            _syncCallModeFromStatus(data.call_mode || null, data.participant_count || 0);
        } catch {}
    };

    poll();
    callState.statusPollTimer = setInterval(poll, 5000);
}

function _stopViewerCallStatusSync() {
    if (callState.statusPollTimer) {
        clearInterval(callState.statusPollTimer);
        callState.statusPollTimer = null;
    }
}

function _syncCallModeFromStatus(nextMode, participantCount = 0) {
    const badge = document.getElementById('call-count-badge');
    if (badge) badge.textContent = participantCount;

    const prevMode = callState.lastSyncedCallMode;
    callState.lastSyncedCallMode = nextMode;
    callState.callMode = nextMode;

    const panel = document.getElementById('call-panel');
    if (!panel || callState.broadcastMode) return;

    if (!nextMode) {
        if (callState.joined || callState.connecting) {
            _callSystemMessage('The streamer disabled voice chat for this stream');
            leaveCall();
        }
        panel.style.display = 'none';
        return;
    }

    panel.style.display = '';
    const labels = { 'mic': 'Voice Chat', 'mic+cam': 'Voice + Camera', 'cam+mic': 'Video Call' };
    const hints = {
        'mic': 'Join the voice chat to talk with the streamer and other viewers',
        'mic+cam': 'Join voice chat — you can optionally enable your camera',
        'cam+mic': 'Join the video call — microphone and camera required',
    };
    const modeLabel = document.getElementById('call-mode-label');
    if (modeLabel) modeLabel.textContent = labels[nextMode] || 'Group Call';
    const hint = document.getElementById('call-join-hint');
    if (hint) hint.textContent = hints[nextMode] || '';
    const camBtn = document.getElementById('call-btn-camera');
    if (camBtn) camBtn.style.display = nextMode === 'mic' ? 'none' : '';
    const camGroup = document.getElementById('call-cam-group');
    if (camGroup) camGroup.style.display = nextMode === 'mic' ? 'none' : '';
    const camSwitchGroup = document.getElementById('call-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = nextMode === 'mic' ? 'none' : '';

    if (prevMode && prevMode !== nextMode && callState.joined) {
        _callSystemMessage('The streamer changed the call mode. Please rejoin with the new settings.');
        leaveCall();
    } else {
        _renderCallUI();
    }
}

function _setupLocalAudioProcessing() {
    const audioTrack = callState.localStream?.getAudioTracks?.()[0];
    if (!audioTrack) return;

    if (callState.analysisStream) {
        callState.analysisStream.getTracks().forEach(t => t.stop());
    }
    if (callState.localSpeechSource) {
        try { callState.localSpeechSource.disconnect(); } catch {}
    }
    if (callState.audioContext) {
        try { callState.audioContext.close(); } catch {}
    }
    if (callState.levelInterval) clearInterval(callState.levelInterval);

    try {
        const analysisTrack = audioTrack.clone();
        callState.analysisStream = new MediaStream([analysisTrack]);
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        callState.audioContext = new Ctx();
        callState.localSpeechSource = callState.audioContext.createMediaStreamSource(callState.analysisStream);
        callState.localAnalyser = callState.audioContext.createAnalyser();
        callState.localAnalyser.fftSize = 512;
        callState.localAnalyser.smoothingTimeConstant = 0.7;
        callState.localSpeechSource.connect(callState.localAnalyser);
        callState.levelInterval = setInterval(_processLocalSpeechFrame, 80);
    } catch (err) {
        console.warn('[Call] Audio analysis setup failed:', err.message);
    }
}

function _processLocalSpeechFrame() {
    if (!callState.localAnalyser) return;
    const bins = new Uint8Array(callState.localAnalyser.frequencyBinCount);
    callState.localAnalyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let i = 0; i < bins.length; i++) sum += bins[i];
    const avg = bins.length ? (sum / bins.length) : 0;
    const percent = Math.round((avg / 255) * 100);
    const detected = percent >= callState.vadThreshold;
    if (detected) callState.speechHoldUntil = Date.now() + 250;
    callState.localSpeechDetected = detected || Date.now() < callState.speechHoldUntil;

    _applyLocalAudioGate();

    const speaking = _shouldBeSpeaking();
    if (speaking !== callState.localSpeaking) {
        callState.localSpeaking = speaking;
        _sendCallMsg({ type: 'speaking', speaking });
        // Targeted update for local tile — avoids full grid rebuild during speech detection
        if (!callState.myPeerId || !_updateTileSpeaking(callState.myPeerId, speaking, callState.muted || callState.forceMuted, false)) {
            _scheduleRender();
        }
    }
}

function _isPttKeyEvent(event) {
    if (!event) return false;
    return event.code === callState.pttKey || event.key === callState.pttKey;
}

function _shouldTransmitAudio() {
    if (callState.muted || callState.forceMuted) return false;
    if (callState.inputMode === 'ptt') return !!callState.pttPressed;
    if (callState.inputMode === 'vad') return !!callState.localSpeechDetected;
    return true;
}

function _shouldBeSpeaking() {
    if (callState.muted || callState.forceMuted) return false;
    if (callState.inputMode === 'ptt') return !!callState.pttPressed && !!callState.localSpeechDetected;
    if (callState.inputMode === 'vad') return !!callState.localSpeechDetected;
    return !!callState.localSpeechDetected;
}

function _applyLocalAudioGate() {
    const enabled = _shouldTransmitAudio();
    if (callState.localStream) {
        callState.localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
    }
    _syncCallSettingsUI();
}

function onCallInputModeChange(value) {
    if (!['open', 'ptt', 'vad'].includes(value)) return;
    callState.inputMode = value;
    _saveCallUserSettings();
    _syncCallSettingsUI();
    _applyLocalAudioGate();
}

function onCallPttKeyChange(value) {
    if (!value) return;
    callState.pttKey = value;
    _saveCallUserSettings();
    _syncCallSettingsUI();
}

function onCallVadThresholdChange(value) {
    const num = Math.max(5, Math.min(80, parseInt(value, 10) || 32));
    callState.vadThreshold = num;
    _saveCallUserSettings();
    _syncCallSettingsUI();
}

async function _fetchCallStatus(streamId) {
    try {
        const data = await api(`/streams/${streamId}/call`);
        _syncCallModeFromStatus(data.call_mode || null, data.participant_count || 0);
    } catch {}
}

async function _populateCallDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        // Populate both pre-join selects, in-call switcher selects, and broadcast selects
        const micSelects = [
            document.getElementById('call-mic-select'),
            document.getElementById('call-mic-switch'),
            document.getElementById('bc-call-mic-switch'),
        ].filter(Boolean);
        const camSelects = [
            document.getElementById('call-cam-select'),
            document.getElementById('call-cam-switch'),
            document.getElementById('bc-call-cam-switch'),
        ].filter(Boolean);

        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        const videoInputs = devices.filter(d => d.kind === 'videoinput');

        micSelects.forEach(sel => {
            sel.innerHTML = '<option value="default">Default Microphone</option>';
            audioInputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Microphone ${sel.options.length}`;
                sel.appendChild(opt);
            });
            if ([...sel.options].some(opt => opt.value === callState.selectedMic)) sel.value = callState.selectedMic;
            sel.onchange = () => { callState.selectedMic = sel.value; };
        });

        camSelects.forEach(sel => {
            sel.innerHTML = '<option value="default">Default Camera</option>';
            videoInputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Camera ${sel.options.length}`;
                sel.appendChild(opt);
            });
            if ([...sel.options].some(opt => opt.value === callState.selectedCam)) sel.value = callState.selectedCam;
            sel.onchange = () => { callState.selectedCam = sel.value; };
        });
        _syncCallSettingsUI();
    } catch {}
}

/** Switch microphone while in an active call */
async function switchCallMic(deviceId) {
    if (!callState.joined || !callState.localStream) return;
    callState.selectedMic = deviceId;
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: deviceId !== 'default' ? { exact: deviceId } : undefined }
        });
        const newTrack = newStream.getAudioTracks()[0];
        const oldTrack = callState.localStream.getAudioTracks()[0];

        // Replace track in local stream
        if (oldTrack) {
            callState.localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        callState.localStream.addTrack(newTrack);
        _setupLocalAudioProcessing();
        _applyLocalAudioGate();

        // Replace track in all peer connections
        for (const [, peer] of callState.peers) {
            const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (sender) await sender.replaceTrack(newTrack);
        }
        _callSystemMessage('Microphone switched');
    } catch (err) {
        console.warn('[Call] Mic switch failed:', err);
        _callSystemMessage('Failed to switch microphone');
    }
}

/** Switch camera while in an active call */
async function switchCallCam(deviceId) {
    if (!callState.joined || !callState.localStream || callState.callMode === 'mic') return;
    callState.selectedCam = deviceId;
    if (callState.cameraOff) return; // Just save preference, will use on next enable
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: deviceId !== 'default' ? { exact: deviceId } : undefined, width: { ideal: 320 }, height: { ideal: 240 } }
        });
        const newTrack = newStream.getVideoTracks()[0];
        const oldTrack = callState.localStream.getVideoTracks()[0];

        if (oldTrack) {
            callState.localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        callState.localStream.addTrack(newTrack);

        // Replace track in all peer connections
        for (const [, peer] of callState.peers) {
            const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(newTrack);
        }
        _renderCallUI();
        _callSystemMessage('Camera switched');
    } catch (err) {
        console.warn('[Call] Camera switch failed:', err);
        _callSystemMessage('Failed to switch camera');
    }
}

function _esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

/** Close call context menus when clicking outside */
document.addEventListener('click', () => {
    if (callState.openContextMenu) {
        _closePeerContextMenu();
    }
});

window.addEventListener('resize', () => {
    if (callState.openContextMenu) {
        _renderFloatingPeerContextMenu();
    }
});

document.addEventListener('scroll', () => {
    if (callState.openContextMenu) {
        _renderFloatingPeerContextMenu();
    }
}, true);

document.addEventListener('keydown', (e) => {
    if (e.repeat || callState.inputMode !== 'ptt' || !_isPttKeyEvent(e)) return;
    const target = e.target;
    const tag = target?.tagName?.toLowerCase?.();
    if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
    callState.pttPressed = true;
    _applyLocalAudioGate();
    _renderCallUI();
});

document.addEventListener('keyup', (e) => {
    if (callState.inputMode !== 'ptt' || !_isPttKeyEvent(e)) return;
    callState.pttPressed = false;
    if (callState.localSpeaking) {
        callState.localSpeaking = false;
        _sendCallMsg({ type: 'speaking', speaking: false });
    }
    _applyLocalAudioGate();
    _renderCallUI();
});

window.addEventListener('hobo-auth-changed', () => {
    if (callState.joined || callState.connecting) {
        _syncCallAuthState();
        _scheduleRender();
    }
});

function _getAuthToken() {
    // Primary auth storage is localStorage; cookie is a fallback.
    try {
        const stored = localStorage.getItem('token');
        if (stored) return stored;
        const match = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
        return match ? match[1] : null;
    } catch { return null; }
}
