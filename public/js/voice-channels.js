/**
 * HoboStreamer — Voice Channels Client
 *
 * Discord-style voice channel UI for the Chat tab.
 * Manages channel list, device setup preview, joining/leaving, and renders
 * participant grids. Delegates actual WebRTC signaling to call.js.
 *
 * Loaded after call.js — uses callState and call.js functions directly.
 */

/* ── VC State ──────────────────────────────────────────────── */
const vcState = {
    channels: [],
    selectedChannelId: null,
    /** @type {MediaStream|null} Preview stream for setup panel */
    previewStream: null,
    previewAudioCtx: null,
    previewAnalyser: null,
    previewSource: null,
    previewLevelInterval: null,
    previewTestNode: null,
    testing: false,
    settingsOpen: false,
    pollTimer: null,
    pollInterval: 4000,
    lastJoinedChannelId: null,
};

/* ── Channel List ──────────────────────────────────────────── */

async function vcFetchChannels() {
    try {
        const resp = await fetch('/api/streams/voice-channels');
        if (!resp.ok) return;
        vcState.channels = await resp.json();
        vcRenderChannelList();
    } catch {}
}

function vcRenderChannelList() {
    const list = document.getElementById('vc-channel-list');
    if (!list) return;
    list.innerHTML = '';

    const joinedId = callState.joined ? (callState.channelId || null) : null;

    for (const ch of vcState.channels) {
        const item = document.createElement('div');
        item.className = 'vc-channel-item' + (ch.id === vcState.selectedChannelId ? ' selected' : '') + (ch.id === joinedId ? ' joined' : '');
        item.dataset.channelId = ch.id;

        // Icon
        const icon = document.createElement('span');
        icon.className = 'vc-channel-icon';
        if (ch.streamId) {
            icon.innerHTML = '<i class="fa-solid fa-broadcast-tower"></i>';
            icon.title = 'Stream channel';
        } else if (ch.permanent) {
            icon.innerHTML = '<i class="fa-solid fa-globe"></i>';
            icon.title = 'Public channel';
        } else {
            icon.innerHTML = '<i class="fa-solid fa-headset"></i>';
        }

        // Name + mode badge
        const nameRow = document.createElement('div');
        nameRow.className = 'vc-channel-name-row';
        const name = document.createElement('span');
        name.className = 'vc-channel-name';
        name.textContent = ch.name;
        nameRow.appendChild(name);

        const mode = document.createElement('span');
        mode.className = 'vc-channel-mode';
        mode.textContent = ch.mode === 'mic' ? 'Voice' : ch.mode === 'cam+mic' ? 'Video' : 'Voice+Cam';
        nameRow.appendChild(mode);

        // Participant count
        const count = document.createElement('span');
        count.className = 'vc-channel-count';
        const pc = ch.participantCount || 0;
        count.innerHTML = `<i class="fa-solid fa-user"></i> ${pc}`;
        if (pc >= (ch.maxParticipants || 15)) count.classList.add('full');

        // Participant avatar stack (show up to 4)
        const avatarStack = document.createElement('div');
        avatarStack.className = 'vc-avatar-stack';
        if (ch.participants && ch.participants.length) {
            const shown = ch.participants.slice(0, 4);
            shown.forEach(p => {
                const av = document.createElement('div');
                av.className = 'vc-avatar-mini';
                av.title = p.displayName || p.username || p.anonId || 'Anonymous';
                if (p.avatarUrl) {
                    av.style.backgroundImage = `url(${p.avatarUrl})`;
                } else {
                    const initial = (p.displayName || p.username || p.anonId || '?')[0].toUpperCase();
                    if (p.profileColor) av.style.background = p.profileColor;
                    av.textContent = initial;
                }
                avatarStack.appendChild(av);
            });
            if (ch.participants.length > 4) {
                const more = document.createElement('div');
                more.className = 'vc-avatar-mini vc-avatar-more';
                more.textContent = `+${ch.participants.length - 4}`;
                avatarStack.appendChild(more);
            }
        }

        item.appendChild(icon);

        const body = document.createElement('div');
        body.className = 'vc-channel-body';
        body.appendChild(nameRow);
        body.appendChild(avatarStack);
        item.appendChild(body);
        item.appendChild(count);

        item.onclick = () => vcSelectChannel(ch.id);
        list.appendChild(item);
    }
}

function vcSelectChannel(channelId) {
    // If already connected to a different channel, leave first
    if (callState.joined && callState.channelId && callState.channelId !== channelId) {
        vcLeave();
    }

    // If already connected to this channel, just toggle highlight
    if (callState.joined && callState.channelId === channelId) {
        return;
    }

    vcState.selectedChannelId = channelId;
    vcRenderChannelList();

    const ch = vcState.channels.find(c => c.id === channelId);
    if (ch) {
        vcShowSetup(ch);
    }
}

/* ── Device Setup Panel ────────────────────────────────────── */

async function vcShowSetup(channel) {
    const panel = document.getElementById('vc-setup-panel');
    const connected = document.getElementById('vc-connected-panel');
    if (!panel) return;
    if (connected) connected.style.display = 'none';

    const title = document.getElementById('vc-setup-title');
    if (title) title.textContent = `Join "${channel.name}"`;

    // Show/hide camera selector based on mode
    const camGroup = document.getElementById('vc-cam-group');
    if (camGroup) camGroup.style.display = channel.mode === 'mic' ? 'none' : '';

    // Set current input mode from callState (persisted settings)
    const inputMode = document.getElementById('vc-input-mode');
    if (inputMode) inputMode.value = callState.inputMode;
    vcOnInputModeChange(callState.inputMode);

    const pttKey = document.getElementById('vc-ptt-key');
    if (pttKey) pttKey.value = callState.pttKey;

    const vadThreshold = document.getElementById('vc-vad-threshold');
    if (vadThreshold) vadThreshold.value = callState.vadThreshold;
    const vadValue = document.getElementById('vc-vad-value');
    if (vadValue) vadValue.textContent = `${callState.vadThreshold}%`;

    panel.style.display = '';

    // Enumerate devices
    await vcEnumerateDevices(channel.mode);

    // Start mic preview
    await vcStartPreview(channel.mode);
}

async function vcEnumerateDevices(mode) {
    try {
        // Request a temp stream to get labeled devices
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach(t => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        const videoInputs = devices.filter(d => d.kind === 'videoinput');

        const micSelects = ['vc-mic-select', 'vc-mic-switch'].map(id => document.getElementById(id)).filter(Boolean);
        const camSelects = ['vc-cam-select', 'vc-cam-switch'].map(id => document.getElementById(id)).filter(Boolean);

        micSelects.forEach(sel => {
            sel.innerHTML = '<option value="default">Default Microphone</option>';
            audioInputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Microphone ${sel.options.length}`;
                sel.appendChild(opt);
            });
            if ([...sel.options].some(o => o.value === callState.selectedMic)) sel.value = callState.selectedMic;
        });

        camSelects.forEach(sel => {
            sel.innerHTML = '<option value="default">Default Camera</option>';
            videoInputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Camera ${sel.options.length}`;
                sel.appendChild(opt);
            });
            if ([...sel.options].some(o => o.value === callState.selectedCam)) sel.value = callState.selectedCam;
        });
    } catch (err) {
        console.warn('[VC] Device enumeration failed:', err.message);
    }
}

async function vcStartPreview(mode) {
    vcStopPreview();

    try {
        const constraints = {
            audio: { deviceId: callState.selectedMic !== 'default' ? { exact: callState.selectedMic } : undefined }
        };
        if (mode !== 'mic') {
            constraints.video = {
                deviceId: callState.selectedCam !== 'default' ? { exact: callState.selectedCam } : undefined,
                width: { ideal: 240 }, height: { ideal: 180 },
            };
        }

        vcState.previewStream = await navigator.mediaDevices.getUserMedia(constraints);

        // Show video preview in avatar area
        const avatarEl = document.getElementById('vc-setup-avatar');
        if (avatarEl && mode !== 'mic') {
            const existingVideo = avatarEl.querySelector('video');
            if (existingVideo) existingVideo.remove();
            const video = document.createElement('video');
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.className = 'vc-preview-video';
            video.srcObject = vcState.previewStream;
            avatarEl.insertBefore(video, avatarEl.firstChild);
        } else if (avatarEl) {
            // Show user avatar / initial
            const existingVideo = avatarEl.querySelector('video');
            if (existingVideo) existingVideo.remove();
            const av = avatarEl.querySelector('.vc-setup-avatar-img');
            if (!av) {
                const d = document.createElement('div');
                d.className = 'vc-setup-avatar-img';
                if (typeof currentUser !== 'undefined' && currentUser?.avatar_url) {
                    d.style.backgroundImage = `url(${currentUser.avatar_url})`;
                } else {
                    d.textContent = (typeof currentUser !== 'undefined' && currentUser?.username || 'U')[0].toUpperCase();
                }
                avatarEl.insertBefore(d, avatarEl.firstChild);
            }
        }

        // Setup mic level meter
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
            vcState.previewAudioCtx = new Ctx();
            vcState.previewSource = vcState.previewAudioCtx.createMediaStreamSource(vcState.previewStream);
            vcState.previewAnalyser = vcState.previewAudioCtx.createAnalyser();
            vcState.previewAnalyser.fftSize = 512;
            vcState.previewAnalyser.smoothingTimeConstant = 0.7;
            vcState.previewSource.connect(vcState.previewAnalyser);

            vcState.previewLevelInterval = setInterval(() => {
                if (!vcState.previewAnalyser) return;
                const bins = new Uint8Array(vcState.previewAnalyser.frequencyBinCount);
                vcState.previewAnalyser.getByteFrequencyData(bins);
                let sum = 0;
                for (let i = 0; i < bins.length; i++) sum += bins[i];
                const avg = bins.length ? sum / bins.length : 0;
                const percent = Math.round((avg / 255) * 100);

                const bar = document.getElementById('vc-meter-bar');
                if (bar) bar.style.width = `${percent}%`;

                const ring = document.getElementById('vc-mic-level');
                if (ring) {
                    ring.classList.toggle('active', percent > callState.vadThreshold);
                }
            }, 60);
        }
    } catch (err) {
        console.warn('[VC] Preview stream failed:', err.message);
    }
}

function vcStopPreview() {
    if (vcState.previewLevelInterval) {
        clearInterval(vcState.previewLevelInterval);
        vcState.previewLevelInterval = null;
    }
    if (vcState.previewSource) {
        try { vcState.previewSource.disconnect(); } catch {}
        vcState.previewSource = null;
    }
    if (vcState.previewTestNode) {
        try { vcState.previewTestNode.disconnect(); } catch {}
        vcState.previewTestNode = null;
    }
    vcState.previewAnalyser = null;
    if (vcState.previewAudioCtx) {
        try { vcState.previewAudioCtx.close(); } catch {}
        vcState.previewAudioCtx = null;
    }
    if (vcState.previewStream) {
        vcState.previewStream.getTracks().forEach(t => t.stop());
        vcState.previewStream = null;
    }
    vcState.testing = false;

    const avatarEl = document.getElementById('vc-setup-avatar');
    if (avatarEl) {
        const video = avatarEl.querySelector('video');
        if (video) { video.srcObject = null; video.remove(); }
    }

    const bar = document.getElementById('vc-meter-bar');
    if (bar) bar.style.width = '0%';

    const testBtn = document.getElementById('vc-test-btn');
    if (testBtn) testBtn.innerHTML = '<i class="fa-solid fa-play"></i> Test Mic';
}

function vcCancelSetup() {
    vcStopPreview();
    vcState.selectedChannelId = null;

    const panel = document.getElementById('vc-setup-panel');
    if (panel) panel.style.display = 'none';
    vcRenderChannelList();
}

function vcToggleTest() {
    if (!vcState.previewStream || !vcState.previewAudioCtx) return;

    if (vcState.testing) {
        // Stop test
        if (vcState.previewTestNode) {
            try { vcState.previewTestNode.disconnect(); } catch {}
            vcState.previewTestNode = null;
        }
        vcState.testing = false;
        const btn = document.getElementById('vc-test-btn');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i> Test Mic';
    } else {
        // Start test — route mic to speakers
        try {
            if (!vcState.previewSource) return;
            const dest = vcState.previewAudioCtx.destination;
            vcState.previewTestNode = vcState.previewAudioCtx.createGain();
            vcState.previewTestNode.gain.value = 0.8;
            vcState.previewSource.connect(vcState.previewTestNode);
            vcState.previewTestNode.connect(dest);
            vcState.testing = true;
            const btn = document.getElementById('vc-test-btn');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop Test';
        } catch (err) {
            console.warn('[VC] Test mic failed:', err.message);
        }
    }
}

/* ── Input Mode Handlers ───────────────────────────────────── */

function vcOnInputModeChange(value) {
    if (!['open', 'ptt', 'vad'].includes(value)) return;
    callState.inputMode = value;
    _saveCallUserSettings();

    // Sync both setup and in-call selects
    ['vc-input-mode', 'vc-input-mode-switch'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });

    // Show/hide PTT / VAD groups in setup
    const showPtt = value === 'ptt';
    const showVad = value === 'vad';
    ['vc-ptt-group', 'vc-ptt-switch-group'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showPtt ? '' : 'none';
    });
    ['vc-vad-group', 'vc-vad-switch-group'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showVad ? '' : 'none';
    });

    // PTT status in connected panel
    const pttStatus = document.getElementById('vc-ptt-status');
    if (pttStatus) pttStatus.style.display = (showPtt && callState.joined) ? '' : 'none';

    if (callState.joined) {
        _applyLocalAudioGate();
    }
}

function vcOnPttKeyChange(value) {
    if (!value) return;
    callState.pttKey = value;
    _saveCallUserSettings();

    ['vc-ptt-key', 'vc-ptt-key-switch'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });

    const keyDisplay = document.getElementById('vc-ptt-status-key');
    if (keyDisplay) {
        const map = { Space: 'Space', KeyV: 'V', KeyT: 'T', AltLeft: 'Left Alt' };
        keyDisplay.textContent = map[value] || value;
    }
}

function vcOnVadChange(value) {
    const num = Math.max(5, Math.min(80, parseInt(value, 10) || 32));
    callState.vadThreshold = num;
    _saveCallUserSettings();

    ['vc-vad-threshold', 'vc-vad-threshold-switch'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = num;
    });
    ['vc-vad-value', 'vc-vad-switch-value'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = `${num}%`;
    });
}

/* ── Join / Leave ──────────────────────────────────────────── */

async function vcJoinFromSetup() {
    const channelId = vcState.selectedChannelId;
    if (!channelId) return;

    const ch = vcState.channels.find(c => c.id === channelId);
    if (!ch) return;

    // Save selected devices from setup panel
    const micSelect = document.getElementById('vc-mic-select');
    if (micSelect) callState.selectedMic = micSelect.value;
    const camSelect = document.getElementById('vc-cam-select');
    if (camSelect) callState.selectedCam = camSelect.value;

    // Stop preview audio (we'll get a fresh stream in joinCall)
    vcStopPreview();

    // Configure callState for channel-based join
    callState.channelId = channelId;
    callState.streamId = channelId; // Backward compat with call.js internals
    callState.callMode = ch.mode;
    callState.isStreamer = false;
    callState.broadcastMode = false;
    callState.vcMode = true;

    vcState.lastJoinedChannelId = channelId;

    // Hide setup, show connected
    const setupPanel = document.getElementById('vc-setup-panel');
    if (setupPanel) setupPanel.style.display = 'none';

    const connPanel = document.getElementById('vc-connected-panel');
    if (connPanel) connPanel.style.display = '';

    const channelLabel = document.getElementById('vc-connected-channel');
    if (channelLabel) channelLabel.textContent = ch.name;

    // Show/hide camera button based on mode
    const camBtn = document.getElementById('vc-btn-camera');
    if (camBtn) camBtn.style.display = ch.mode === 'mic' ? 'none' : '';
    const camSwitchGroup = document.getElementById('vc-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = ch.mode === 'mic' ? 'none' : '';

    // Populate in-call device switchers
    await vcEnumerateDevices(ch.mode);

    // Sync in-call input mode settings
    const inputModeSwitch = document.getElementById('vc-input-mode-switch');
    if (inputModeSwitch) inputModeSwitch.value = callState.inputMode;
    vcOnInputModeChange(callState.inputMode);

    // Join the actual call via call.js
    joinCall();

    vcRenderChannelList();
}

function vcLeave() {
    leaveCall();
    callState.channelId = null;
    callState.vcMode = false;
    vcState.lastJoinedChannelId = null;
    vcState.settingsOpen = false;

    const connPanel = document.getElementById('vc-connected-panel');
    if (connPanel) connPanel.style.display = 'none';

    const settingsPanel = document.getElementById('vc-incall-settings');
    if (settingsPanel) settingsPanel.style.display = 'none';

    vcState.selectedChannelId = null;
    vcRenderChannelList();
}

/* ── Controls ──────────────────────────────────────────────── */

function vcToggleMute() {
    toggleCallMute();
    vcUpdateControlButtons();
}

function vcToggleCamera() {
    toggleCallCamera();
    // toggleCallCamera is async, update after a tick
    setTimeout(vcUpdateControlButtons, 50);
}

function vcToggleScreenShare() {
    // Future feature placeholder
    console.log('[VC] Screen share not yet implemented');
}

function vcToggleSettings() {
    vcState.settingsOpen = !vcState.settingsOpen;
    const panel = document.getElementById('vc-incall-settings');
    if (panel) panel.style.display = vcState.settingsOpen ? '' : 'none';

    const btn = document.getElementById('vc-btn-settings');
    if (btn) btn.classList.toggle('active', vcState.settingsOpen);
}

function vcSwitchMic(deviceId) {
    callState.selectedMic = deviceId;
    switchCallMic(deviceId);
}

function vcSwitchCam(deviceId) {
    callState.selectedCam = deviceId;
    switchCallCam(deviceId);
}

function vcUpdateControlButtons() {
    const muteBtn = document.getElementById('vc-btn-mute');
    if (muteBtn) {
        const muted = callState.muted || callState.forceMuted;
        muteBtn.innerHTML = muted
            ? '<i class="fa-solid fa-microphone-slash"></i>'
            : '<i class="fa-solid fa-microphone"></i>';
        muteBtn.classList.toggle('active', muted);
        muteBtn.title = callState.forceMuted ? 'Force-muted' : (callState.muted ? 'Unmute' : 'Mute');
    }

    const camBtn = document.getElementById('vc-btn-camera');
    if (camBtn && callState.callMode !== 'mic') {
        const camOff = callState.cameraOff || callState.forceCameraOff;
        camBtn.innerHTML = camOff
            ? '<i class="fa-solid fa-video-slash"></i>'
            : '<i class="fa-solid fa-video"></i>';
        camBtn.classList.toggle('active', camOff);
    }
}

/* ── Participant Grid Rendering ────────────────────────────── */

/**
 * Called from the patched _renderCallUI when callState.vcMode is true.
 * Renders participants into the vc-participants-grid.
 */
function vcRenderUI() {
    if (!callState.joined) {
        // Disconnected (kicked, banned, call ended, etc.)
        const connPanel = document.getElementById('vc-connected-panel');
        if (connPanel) connPanel.style.display = 'none';
        // Reset VC state
        callState.vcMode = false;
        callState.channelId = null;
        vcState.lastJoinedChannelId = null;
        vcState.settingsOpen = false;
        vcRenderChannelList();
        return;
    }

    vcUpdateControlButtons();

    const grid = document.getElementById('vc-participants-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Local tile
    grid.appendChild(_createParticipantTile({
        peerId: callState.myPeerId,
        username: callState.localUsername,
        displayName: callState.localDisplayName || (typeof currentUser !== 'undefined' ? (currentUser?.display_name || currentUser?.username) : 'You'),
        anonId: callState.localAnonId,
        userId: callState.localUserId || (typeof currentUser !== 'undefined' ? currentUser?.id : null),
        isStreamer: callState.isStreamer,
        muted: callState.muted || callState.forceMuted,
        speaking: callState.localSpeaking,
        cameraOff: callState.cameraOff || callState.forceCameraOff,
        forceMuted: callState.forceMuted,
        forceCameraOff: callState.forceCameraOff,
        nameFX: callState.localNameFX,
        avatarUrl: callState.localAvatarUrl || (typeof currentUser !== 'undefined' ? currentUser?.avatar_url : null),
        profileColor: callState.localProfileColor || (typeof currentUser !== 'undefined' ? currentUser?.profile_color : null),
        isLocal: true,
    }));

    // Remote tiles
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

    // Hide camera switch in mic-only mode
    const camSwitchGroup = document.getElementById('vc-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = callState.callMode === 'mic' ? 'none' : '';

    // PTT status
    const pttStatus = document.getElementById('vc-ptt-status');
    if (pttStatus) pttStatus.style.display = callState.inputMode === 'ptt' ? '' : 'none';
    const pttKey = document.getElementById('vc-ptt-status-key');
    if (pttKey) {
        const map = { Space: 'Space', KeyV: 'V', KeyT: 'T', AltLeft: 'Left Alt' };
        pttKey.textContent = map[callState.pttKey] || callState.pttKey;
    }
}

/* ── Create Channel Modal ──────────────────────────────────── */

function vcShowCreateModal() {
    const modal = document.getElementById('vc-create-modal');
    if (modal) modal.style.display = '';
    const nameInput = document.getElementById('vc-create-name');
    if (nameInput) { nameInput.value = ''; nameInput.focus(); }
}

function vcHideCreateModal() {
    const modal = document.getElementById('vc-create-modal');
    if (modal) modal.style.display = 'none';
}

async function vcCreateChannel() {
    const name = (document.getElementById('vc-create-name')?.value || '').trim();
    const mode = document.getElementById('vc-create-mode')?.value || 'mic+cam';
    const maxP = parseInt(document.getElementById('vc-create-max')?.value, 10) || 15;

    if (!name) {
        const input = document.getElementById('vc-create-name');
        if (input) { input.classList.add('error'); setTimeout(() => input.classList.remove('error'), 1500); }
        return;
    }

    try {
        const token = localStorage.getItem('token');
        const resp = await fetch('/api/streams/voice-channels', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ name, mode, maxParticipants: maxP }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            alert(err.error || 'Failed to create channel');
            return;
        }
        vcHideCreateModal();
        await vcFetchChannels();
    } catch (err) {
        console.error('[VC] Create channel failed:', err);
    }
}

/* ── Channel Polling ───────────────────────────────────────── */

function vcStartPolling() {
    vcStopPolling();
    vcFetchChannels();
    vcState.pollTimer = setInterval(vcFetchChannels, vcState.pollInterval);
}

function vcStopPolling() {
    if (vcState.pollTimer) {
        clearInterval(vcState.pollTimer);
        vcState.pollTimer = null;
    }
}

/* ── Participant Count Update (called from call.js) ────────── */

function vcUpdateParticipantCount(count) {
    // We don't have a separate badge; the channel list shows counts.
    // Trigger a channel list refresh for live count.
    vcFetchChannels();
}

/* ── Initialization ────────────────────────────────────────── */

/**
 * Called when the Chat tab becomes visible.
 * Starts polling for channel updates and renders the list.
 */
function vcInit() {
    vcStartPolling();
}

/**
 * Called when navigating away from the Chat tab.
 * Stops polling but does NOT leave the voice channel.
 */
function vcDeinit() {
    vcStopPolling();
}

// Auto-init if chat tab is already visible (e.g. on page load)
document.addEventListener('DOMContentLoaded', () => {
    // Listen for tab switches to start/stop polling
    const chatTab = document.getElementById('page-chat');
    if (chatTab) {
        // Create a MutationObserver to watch for class changes (active/inactive)
        const observer = new MutationObserver(() => {
            const isVisible = chatTab.classList.contains('active');
            if (isVisible && !vcState.pollTimer) {
                vcInit();
            } else if (!isVisible && vcState.pollTimer) {
                vcDeinit();
            }
        });
        observer.observe(chatTab, { attributes: true, attributeFilter: ['class'] });
    }
});
