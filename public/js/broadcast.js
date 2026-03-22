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
        _suppressRecovery: false, // set true during intentional track stops (flip cam, screen share toggle)
        _trackKeepaliveInterval: null,
        _recoveryStartedAt: 0,
        _lastRecoveryCompletedAt: 0,
        lastThumbnailAt: 0,
        thumbnailCanvas: null,
        thumbnailCtx: null,
        statsPollPending: false,
        robotStreamer: null,
        // Screen share + camera PiP composite state
        _screenStream: null,       // raw getDisplayMedia stream
        _cameraOverlayStream: null, // raw getUserMedia camera stream for PiP
        _compositeCanvas: null,
        _compositeCtx: null,
        _compositeAnimFrame: null,
        _cameraOverlayEnabled: false,
        // PiP position/size (fraction of canvas, 0-1 range) — draggable/resizable
        _pipX: 0.78,  // fractional X (top-left of PiP)
        _pipY: 0.72,  // fractional Y
        _pipW: 0.20,  // fractional width (20% of canvas)
        _pipDragging: false,
        _pipResizing: false,
    };
}

const BROADCAST_SIGNALING_MAX_BUFFERED_AMOUNT = 512 * 1024;
const BROADCAST_THUMBNAIL_INTERVAL_MS = 115000;

/**
 * Keep the PipeWire / v4l2loopback / xdg-desktop-portal capture pipeline
 * active by periodically consuming a video frame.  On Linux (Steam Deck,
 * PipeWire) the capture source can be dropped if no consumer reads frames
 * for several seconds — this heartbeat prevents that idle-timeout.
 *
 * ALSO serves as the primary health watchdog: if frame grabs fail for
 * WATCHDOG_DEAD_THRESHOLD_MS consecutive milliseconds, we consider the
 * stream truly dead and trigger recovery. This replaces the unreliable
 * track ended/inactive event approach — PipeWire on Steam Deck fires
 * spurious ended events every few minutes during normal Gamescope
 * compositing, power transitions, and GPU context switches.
 */
const KEEPALIVE_INTERVAL_MS = 1000;
const WATCHDOG_DEAD_THRESHOLD_MS = 15000; // 15s of grabFrame failures with 'live' readyState
const WATCHDOG_ENDED_THRESHOLD_MS = 8000;  // 8s for track.readyState !== 'live' (definitive death)

function startTrackKeepalive(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream) return;
    stopTrackKeepalive(streamId);
    const videoTrack = ss.localStream.getVideoTracks()[0];
    if (!videoTrack || typeof ImageCapture === 'undefined') return;
    let capture;
    try { capture = new ImageCapture(videoTrack); } catch { return; }

    // Watchdog state
    let lastSuccessfulFrame = Date.now();
    let watchdogTriggered = false;
    const streamRef = ss.localStream; // capture reference for staleness check

    ss._trackKeepaliveInterval = setInterval(() => {
        const current = getStreamState(streamId);
        if (!current?.localStream || current.localStream !== streamRef) {
            stopTrackKeepalive(streamId);
            return;
        }

        // If recovery is already in progress or suppressed, just keep ticking
        if (current._suppressRecovery || current.mediaRecoveryInProgress || current.mediaRecoveryTimer) {
            lastSuccessfulFrame = Date.now(); // reset watchdog during recovery
            return;
        }

        // During cooldown after recovery, reset watchdog
        if (current._lastRecoveryCompletedAt && (Date.now() - current._lastRecoveryCompletedAt) < 60000) {
            lastSuccessfulFrame = Date.now();
            return;
        }

        // Check for unmute reset signal from mute/unmute event handlers
        if (current._watchdogResetRequested) {
            current._watchdogResetRequested = false;
            lastSuccessfulFrame = Date.now();
            watchdogTriggered = false;
        }

        if (videoTrack.readyState !== 'live') {
            // Track is definitively not live — use shorter threshold
            const deadDuration = Date.now() - lastSuccessfulFrame;
            if (deadDuration >= WATCHDOG_ENDED_THRESHOLD_MS && !watchdogTriggered) {
                watchdogTriggered = true;
                console.warn(`[Broadcast] Watchdog: video track dead for ${(deadDuration / 1000).toFixed(1)}s (readyState: ${videoTrack.readyState}) — triggering recovery`);
                scheduleMediaRecovery(streamId, 'video track dead (watchdog)');
            }
            return;
        }

        capture.grabFrame()
            .then(bmp => {
                bmp.close();
                lastSuccessfulFrame = Date.now();
                watchdogTriggered = false; // reset if we got a frame
            })
            .catch(() => {
                // Frame grab failed but track is still 'live' — PipeWire glitch
                // If track is muted, PipeWire is renegotiating — be patient
                const deadDuration = Date.now() - lastSuccessfulFrame;
                if (deadDuration >= WATCHDOG_DEAD_THRESHOLD_MS && !watchdogTriggered) {
                    watchdogTriggered = true;
                    const mutedNote = current._videoTrackMutedAt ? ` (muted for ${((Date.now() - current._videoTrackMutedAt) / 1000).toFixed(1)}s)` : '';
                    console.warn(`[Broadcast] Watchdog: frame grabs failing for ${(deadDuration / 1000).toFixed(1)}s${mutedNote} — triggering recovery`);
                    scheduleMediaRecovery(streamId, 'frame capture failed (watchdog)');
                }
            });
    }, KEEPALIVE_INTERVAL_MS);
    console.log(`[Broadcast] Track keepalive + watchdog started (${KEEPALIVE_INTERVAL_MS / 1000}s interval, ${WATCHDOG_ENDED_THRESHOLD_MS / 1000}s ended/${WATCHDOG_DEAD_THRESHOLD_MS / 1000}s stall threshold)`);
}

function stopTrackKeepalive(streamId) {
    const ss = getStreamState(streamId);
    if (ss?._trackKeepaliveInterval) {
        clearInterval(ss._trackKeepaliveInterval);
        ss._trackKeepaliveInterval = null;
        console.log('[Broadcast] Track keepalive stopped');
    }
}

/* ── Wake Lock ─────────────────────────────────────────────────
   Prevents the OS/browser from suspending media tracks when the
   tab is backgrounded or the device enters power-saving mode.
   ─────────────────────────────────────────────────────────────── */
let _wakeLockSentinel = null;

async function acquireWakeLock() {
    if (_wakeLockSentinel) return; // already held
    if (!('wakeLock' in navigator)) {
        console.log('[Broadcast] Wake Lock API not supported');
        return;
    }
    try {
        _wakeLockSentinel = await navigator.wakeLock.request('screen');
        console.log('[Broadcast] Wake Lock acquired');
        _wakeLockSentinel.addEventListener('release', () => {
            console.log('[Broadcast] Wake Lock released by system');
            _wakeLockSentinel = null;
            // Re-acquire if still broadcasting
            if (isStreaming()) acquireWakeLock();
        });
    } catch (err) {
        console.warn('[Broadcast] Wake Lock request failed:', err.message);
        _wakeLockSentinel = null;
    }
}

function releaseWakeLock() {
    if (_wakeLockSentinel) {
        _wakeLockSentinel.release().catch(() => {});
        _wakeLockSentinel = null;
        console.log('[Broadcast] Wake Lock released');
    }
}

// Re-acquire wake lock when the tab becomes visible again
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isStreaming() && !_wakeLockSentinel) {
        acquireWakeLock();
    }
});

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
    selectedBrowserSource: 'camera', // 'camera' or 'screen'

    // Settings (persisted to localStorage) — global across all streams
    settings: {
        ttsMode: 'site-wide', ttsVolume: 800, ttsPitch: 100, ttsRate: 10, ttsVoice: '', ttsDuration: 10, ttsNames: 'off', ttsQueue: 5,
        notificationVolume: 800, forceAudio: 'default', autoGain: true, echoCancellation: true, noiseSuppression: true,
        manualGainEnabled: false, manualGain: 100, force48kSampleRate: false,
        forceCamera: 'default', broadcastRes: '720', broadcastFps: '30', broadcastCodec: 'auto',
        broadcastBps: '2500', broadcastBpsMin: '500', broadcastLimit: 'restart', screenShare: false,
        // Screen share capture preferences (hints to getDisplayMedia)
        screenCaptureSource: 'auto',        // 'auto' | 'monitor' | 'window' | 'browser'
        screenSystemAudio: 'include',        // 'include' | 'exclude' | 'auto'
        screenSelfBrowser: 'exclude',        // 'exclude' | 'include'
        screenSurfaceSwitching: 'include',   // 'include' | 'exclude'
        screenPreferCurrentTab: false,       // whether to bias toward the current tab
        serverReconnect: true,
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

/* ── RS Restream Slot ────────────────────────────────────────── */
// Only one stream at a time can restream to RobotStreamer.
// The slot stores which streamId is assigned. Persisted in localStorage.
function getRsRestreamSlotStreamId() {
    const v = localStorage.getItem('bc-rs-restream-slot');
    return v ? parseInt(v) : null;
}
function setRsRestreamSlot(streamId) {
    if (streamId) localStorage.setItem('bc-rs-restream-slot', String(streamId));
    else localStorage.removeItem('bc-rs-restream-slot');
}
/** Should RS restream auto-start for this stream? */
function isRsRestreamAssigned(streamId) {
    const slot = getRsRestreamSlotStreamId();
    // If no slot assigned, auto-assign to the first stream that goes live
    if (!slot) return true;
    if (slot === streamId) return true;
    // Validate the slotted stream still exists and has media — if not, the slot is
    // stale from a previous session. Clear it so this new stream can auto-assign.
    const slotState = broadcastState.streams.get(slot);
    if (!slotState || !slotState.localStream) {
        console.log(`[RS Slot] Clearing stale slot ${slot} — stream no longer active, auto-assigning to ${streamId}`);
        setRsRestreamSlot(null);
        return true;
    }
    return false; // another LIVE stream holds the slot
}
/** Toggle RS restream for the currently active stream */
function toggleRsRestreamSlot() {
    const streamId = broadcastState.activeStreamId;
    if (!streamId) return;
    const ss = getStreamState(streamId);
    if (!ss) return;
    const currentSlot = getRsRestreamSlotStreamId();
    if (currentSlot === streamId) {
        // Unassign — stop restream
        setRsRestreamSlot(null);
        stopRobotStreamerRestream(streamId).catch(() => {});
        toast('RS restream stopped', 'info');
    } else {
        // Assign this stream — stop restream on old slot first
        if (currentSlot) {
            const oldSs = getStreamState(currentSlot);
            if (oldSs?.robotStreamer?.active) {
                stopRobotStreamerRestream(currentSlot, { quiet: true }).catch(() => {});
            }
        }
        setRsRestreamSlot(streamId);
        if (ss.localStream && canUseRobotStreamerRestream()) {
            startRobotStreamerRestream(streamId).catch(() => {});
        }
        toast('RS restream assigned to this stream', 'success');
    }
    updateRsRestreamSlotUI();
}

/** Assign RS restream to a specific stream (from dropdown) */
function assignRsRestreamToStream(streamId) {
    streamId = parseInt(streamId);
    if (!streamId || !Number.isFinite(streamId)) return;
    const currentSlot = getRsRestreamSlotStreamId();
    // Stop old restream
    if (currentSlot && currentSlot !== streamId) {
        stopRobotStreamerRestream(currentSlot, { quiet: true }).catch(() => {});
    }
    setRsRestreamSlot(streamId);
    const ss = getStreamState(streamId);
    if (ss?.localStream && canUseRobotStreamerRestream()) {
        startRobotStreamerRestream(streamId).catch(() => {});
    }
    updateRsRestreamSlotUI();
}

/** Stop RS restream and clear the slot */
function stopRsRestream() {
    const slot = getRsRestreamSlotStreamId();
    if (slot) {
        stopRobotStreamerRestream(slot).catch(() => {});
    }
    setRsRestreamSlot(null);
    updateRsRestreamSlotUI();
}

/** Start or retry RS restream for the current slot / active stream */
function startOrRetryRsRestream() {
    let targetId = getRsRestreamSlotStreamId() || broadcastState.activeStreamId;
    if (!targetId) return;
    const ss = getStreamState(targetId);
    if (!ss?.localStream) {
        // Slot stream has no media — try active stream instead
        targetId = broadcastState.activeStreamId;
        if (!targetId) return;
    }
    // Reset retry counters for fresh attempt
    const targetSs = getStreamState(targetId);
    if (targetSs) {
        targetSs._rsConsecutiveShortLived = 0;
        targetSs._rsReconnectDelay = RS_RECONNECT_BASE_DELAY;
    }
    setRsRestreamSlot(targetId);
    stopRobotStreamerRestream(targetId, { quiet: true })
        .catch(() => {})
        .then(() => {
            startRobotStreamerRestream(targetId).catch(() => {});
        });
    updateRsRestreamSlotUI();
}

/** Update RS restream control panel in live controls */
function updateRsRestreamSlotUI() {
    updateRestreamControlPanel();
    const panel = document.getElementById('bc-rs-control');
    if (!panel) return;

    // If RS not configured, completely hide the panel
    if (!canUseRobotStreamerRestream()) {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = '';

    const liveStreams = [];
    for (const [id, ss] of broadcastState.streams) {
        if (ss.localStream && ss.streamData) {
            liveStreams.push({ id, title: ss.streamData.title || `Stream ${id}`, ss });
        }
    }

    const slotId = getRsRestreamSlotStreamId();
    const slotSs = slotId ? getStreamState(slotId) : null;
    const isLive = !!(slotSs?.robotStreamer?.active);
    const isStarting = !!(slotSs?._rsRestreamStarting);
    const hasFailed = !isLive && !isStarting && slotSs && !slotSs.robotStreamer && (slotSs._rsConsecutiveShortLived || 0) >= RS_MAX_SHORT_LIVED_RETRIES;

    let html = '';

    // Stream picker (only when multi-streaming)
    if (liveStreams.length > 1) {
        html += `<div class="bc-rs-stream-picker">
            <label><i class="fa-solid fa-tower-broadcast"></i> Stream:</label>
            <select onchange="assignRsRestreamToStream(this.value)">`;
        if (!slotId) html += `<option value="">— Select stream —</option>`;
        for (const s of liveStreams) {
            const sel = slotId === s.id ? 'selected' : '';
            html += `<option value="${s.id}" ${sel}>${s.title}</option>`;
        }
        html += `</select></div>`;
    }

    // Status + action buttons
    html += '<div class="bc-rs-status-row">';
    if (isLive) {
        html += `<span class="bc-rs-status bc-rs-live"><i class="fa-solid fa-circle"></i> RS Live</span>`;
        html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="stopRsRestream()"><i class="fa-solid fa-stop"></i> Stop</button>`;
    } else if (isStarting) {
        html += `<span class="bc-rs-status bc-rs-connecting"><i class="fa-solid fa-spinner fa-spin"></i> Connecting…</span>`;
        html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="stopRsRestream()"><i class="fa-solid fa-stop"></i> Cancel</button>`;
    } else if (hasFailed) {
        html += `<span class="bc-rs-status bc-rs-error"><i class="fa-solid fa-circle-exclamation"></i> Failed</span>`;
        html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="startOrRetryRsRestream()"><i class="fa-solid fa-rotate-right"></i> Retry</button>`;
    } else if (slotId && slotSs?.localStream) {
        // Slot assigned but not started yet (could be reconnecting)
        const isReconnecting = !!(slotSs._rsReconnectTimer);
        if (isReconnecting) {
            html += `<span class="bc-rs-status bc-rs-connecting"><i class="fa-solid fa-spinner fa-spin"></i> Reconnecting…</span>`;
            html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="stopRsRestream()"><i class="fa-solid fa-stop"></i> Cancel</button>`;
        } else {
            html += `<span class="bc-rs-status bc-rs-ready"><i class="fa-solid fa-robot"></i> Ready</span>`;
            html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="startOrRetryRsRestream()"><i class="fa-solid fa-play"></i> Start</button>`;
        }
    } else {
        // No slot assigned
        html += `<span class="bc-rs-status bc-rs-off"><i class="fa-solid fa-robot"></i> RS Off</span>`;
        html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="startOrRetryRsRestream()"><i class="fa-solid fa-play"></i> Start</button>`;
    }
    html += '</div>';

    panel.innerHTML = html;
}
/** Conditionally start RS restream only if this stream has the slot */
function maybeStartRsRestream(streamId) {
    if (!isRsRestreamAssigned(streamId)) return;
    // Auto-assign the slot on first live stream
    const currentSlot = getRsRestreamSlotStreamId();
    if (!currentSlot) setRsRestreamSlot(streamId);
    startRobotStreamerRestream(streamId).catch(() => {});
    updateRsRestreamSlotUI();
}

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

/**
 * Attach diagnostic logging to track/stream events.
 *
 * IMPORTANT: These handlers NO LONGER trigger recovery directly.
 * Recovery is driven exclusively by the frame watchdog in startTrackKeepalive().
 *
 * On Steam Deck / PipeWire / Gamescope, track 'ended' and stream 'inactive'
 * events fire spuriously every few minutes during normal operation (GPU
 * compositing switches, power state transitions, PipeWire pipeline
 * renegotiations). Reacting to these events caused the stream to go black
 * and restart constantly. The watchdog approach only triggers recovery when
 * frames actually stop being produced for 20+ seconds.
 */
function attachLocalStreamRecoveryHandlers(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream) return;
    const currentStream = ss.localStream;

    const isStillCurrent = () => {
        const latest = getStreamState(streamId);
        return latest && latest.localStream === currentStream;
    };

    currentStream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
            if (!isStillCurrent()) return;
            console.log(`[Broadcast] Track '${track.kind}' ended event (readyState: ${track.readyState}) — watchdog will handle if persistent`);
        }, { once: true });

        track.addEventListener('mute', () => {
            if (!isStillCurrent()) return;
            console.log(`[Broadcast] Track '${track.kind}' muted (readyState: ${track.readyState})`);
            if (track.kind === 'video') {
                const ss2 = getStreamState(streamId);
                if (ss2) ss2._videoTrackMutedAt = Date.now();
            }
        });
        track.addEventListener('unmute', () => {
            if (!isStillCurrent()) return;
            console.log(`[Broadcast] Track '${track.kind}' unmuted (readyState: ${track.readyState})`);
            if (track.kind === 'video') {
                const ss2 = getStreamState(streamId);
                if (ss2) {
                    ss2._videoTrackMutedAt = null;
                    ss2._watchdogResetRequested = true; // signal watchdog to reset timer
                }
            }
        });
    });

    if (typeof currentStream.addEventListener === 'function') {
        currentStream.addEventListener('inactive', () => {
            if (!isStillCurrent()) return;
            const latest = getStreamState(streamId);
            if (latest._suppressRecovery) return;
            console.log('[Broadcast] MediaStream inactive event — watchdog will handle if persistent');
        }, { once: true });
    }
}

function scheduleMediaRecovery(streamId, reason = 'media interrupted') {
    const ss = getStreamState(streamId);
    if (!ss || ss.mediaRecoveryInProgress || ss.mediaRecoveryTimer || !broadcastState.streams.has(streamId)) return;

    // Recovery cooldown — if media was just recovered, spurious track events from
    // the fresh capture pipeline should be ignored. This prevents rapid recovery
    // loops on Steam Deck / PipeWire where tracks can fire ended events briefly
    // after a new getUserMedia call.
    const RECOVERY_COOLDOWN_MS = 60000;
    if (ss._lastRecoveryCompletedAt && (Date.now() - ss._lastRecoveryCompletedAt) < RECOVERY_COOLDOWN_MS) {
        console.log(`[Broadcast] Ignoring recovery trigger during cooldown (${reason})`);
        return;
    }

    if (broadcastState.settings.broadcastLimit === 'stop') {
        toast(`Broadcast input lost (${reason}). Stream stopping.`, 'error');
        api(`/streams/${streamId}`, { method: 'DELETE' }).catch(() => {}).finally(() => cleanupStream(streamId));
        return;
    }

    const delay = Math.min(2000 * (ss.mediaRecoveryAttempts + 1), 10000);
    ss.mediaRecoveryAttempts += 1;
    ss._recoveryStartedAt = Date.now();
    if (broadcastState.activeStreamId === streamId) {
        updateBroadcastStatus('checking');
        // Only show warning toast on first attempt — subsequent retries log silently
        if (ss.mediaRecoveryAttempts <= 1) {
            toast(`Broadcast interrupted — attempting recovery (${reason})`, 'warning');
        } else {
            console.warn(`[Broadcast] Media recovery retry ${ss.mediaRecoveryAttempts} (${reason})`);
        }
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
    _cleanupSfuProduce(streamId);

    // Suppress recovery and null-out localStream BEFORE stopping tracks.
    // This ensures the ended/inactive handlers see a different localStream
    // reference and bail out, preventing re-entrant recovery loops.
    stopTrackKeepalive(streamId);
    ss._suppressRecovery = true;
    if (ss.localStream) {
        const oldStream = ss.localStream;
        ss.localStream = null;
        try { oldStream.getTracks().forEach((track) => track.stop()); } catch {}
    }

    await startMediaCapture(streamId);
    ss._suppressRecovery = false; // new stream handlers are now attached
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
    ss._lastRecoveryCompletedAt = Date.now();
    if (broadcastState.activeStreamId === streamId) {
        updateBroadcastStatusFromConnections(streamId);
        // Only show success toast if recovery was slow enough for the user to notice
        const elapsed = Date.now() - (ss._recoveryStartedAt || 0);
        if (elapsed > 5000) {
            toast(`Broadcast recovered after ${reason}`, 'success');
        } else {
            console.log(`[Broadcast] Silent recovery succeeded in ${elapsed}ms (${reason})`);
        }
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
        const isActiveStatus = currentText.includes('live') || currentText.includes('connecting') || currentText.includes('reconnect') || currentText.includes('Loading') || currentText.includes('Joining') || currentText.includes('Sending') || currentText.includes('Negotiating') || currentText.includes('Creating');
        if (!isActiveStatus) {
            if (rs.enabled && rs.hasToken && rs.robotId) {
                setRobotStreamerStatus('RobotStreamer restream ready — will start when you go live.', 'info', 'bc-rsLiveStatus');
                // If we're already live but RS isn't running, trigger start now
                // (fixes race condition where integration loads after go-live)
                for (const [streamId, ss] of broadcastState.streams) {
                    if (ss.localStream && !ss.robotStreamer?.active && !ss._rsRestreamStarting && isRsRestreamAssigned(streamId)) {
                        console.log('[RS Sync] Integration loaded while live — triggering RS start for stream', streamId);
                        maybeStartRsRestream(streamId);
                        break;
                    }
                }
            } else if (!rs.enabled) {
                setRobotStreamerStatus('RobotStreamer restream is disabled.', 'info', 'bc-rsLiveStatus');
            } else {
                setRobotStreamerStatus('RobotStreamer needs configuration — validate settings above.', 'info', 'bc-rsLiveStatus');
            }
        }
    }
    updateRsRestreamSlotUI();
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
            if (broadcastState.robotStreamer.enabled && isRsRestreamAssigned(streamId)) {
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
    loadRestreamDestinations().catch(() => {});

    // If THIS tab has active browser WebRTC streams (localStream exists), restore UI
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
            updateRsRestreamSlotUI();
            startRestreamStatusPolling();
            return;
        }
    }

    // Always show stream manager — never auto-resume WebRTC streams from other tabs/devices
    // (connecting signaling would override the existing broadcaster)
    hideBroadcastTabs();
    showStreamManager();
    loadExistingStreams();

    // Pre-fill form with last-used values
    _restoreLastBroadcastFields();
}

/* ── Stream Manager (Step 0) ─────────────────────────────────── */
function showStreamManager() {
    const ids = ['bc-stream-manager', 'bc-browser-broadcast', 'bc-rtmp-instructions', 'bc-jsmpeg-instructions', 'bc-webrtc-obs-instructions'];
    ids.forEach((id, i) => { const el = document.getElementById(id); if (el) el.style.display = i === 0 ? '' : 'none'; });
    const chat = document.getElementById('bc-chat-sidebar'); if (chat) chat.style.display = 'none';
    const info = document.getElementById('bc-info-bar'); if (info) info.style.display = 'none';
}

/** Pre-fill broadcast form with last-used title/description/category from localStorage */
function _restoreLastBroadcastFields() {
    const titleEl = document.getElementById('bc-title');
    if (titleEl && !titleEl.value) titleEl.value = localStorage.getItem('bc-last-title') || '';
    const descEl = document.getElementById('bc-description');
    if (descEl && !descEl.value) descEl.value = localStorage.getItem('bc-last-description') || '';
    const catEl = document.getElementById('bc-category');
    const lastCat = localStorage.getItem('bc-last-category');
    if (catEl && lastCat) catEl.value = lastCat;
    // Populate username in create reassurance text
    const usernameEl = document.getElementById('bc-create-username');
    if (usernameEl && currentUser?.username) usernameEl.textContent = currentUser.username;
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
        // Show a broadcasting indicator if this stream has active media state
        const hasBrowserState = broadcastState.streams.has(s.id) && broadcastState.streams.get(s.id).localStream;
        const dotClass = hasBrowserState ? 'bc-tab-dot bc-tab-dot-broadcasting' : 'bc-tab-dot';
        const vc = s.viewer_count || 0;
        return `<button class="bc-tab ${isActive ? 'active' : ''}"
                    onclick="switchBroadcastTab(${s.id})"
                    data-stream-id="${s.id}" title="${title}">
            <span class="${dotClass}"></span>
            <span>${truncTitle}</span>
            <span class="bc-tab-viewers" data-stream-id="${s.id}"><i class="fa-solid fa-eye"></i> ${vc}</span>
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
        if (!ss.robotStreamer?.active) maybeStartRsRestream(streamId);
        updateRsRestreamSlotUI();
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

    // Restore last-used form fields from localStorage
    _restoreLastBroadcastFields();

    // Populate device selectors for the create form
    await populateCreateFormDevices();
}

/**
 * End a stream directly from its tab's close button (×).
 */
async function endBroadcastTab(streamId) {
    if (!confirm('End this stream?')) return;
    try {
        // Detach VOD state and clean up immediately — VOD finalize + DELETE happen in background
        const ss = getStreamState(streamId);
        let bgCtx = null;
        if (ss) {
            bgCtx = _detachVodForBackground(streamId);
            cleanupStream(streamId);
        }
        toast('Stream ended', 'info');
        _backgroundStreamEnd(streamId, bgCtx);

        // Rebuild tabs (exclude stopped stream — DELETE hasn't fired yet)
        const data = await api('/streams/mine');
        const remaining = (data.streams || []).filter(s => s.is_live && s.id !== streamId);
        if (remaining.length > 0) {
            const withState = remaining.find(s => broadcastState.streams.has(s.id));
            const nextStream = withState || remaining[0];
            await buildBroadcastTabs(nextStream.id);
            await switchOrResumeStream(nextStream);
        } else {
            hideBroadcastTabs();
            clearGlobalDisplayTimers();
            setNavLiveIndicator(false);
            showStreamManager();
            loadExistingStreams(streamId);
            // Scroll create section into view so user lands on "Create New Stream"
            const createSec = document.getElementById('bc-create-section');
            if (createSec) createSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        if (!ss.robotStreamer?.active) maybeStartRsRestream(stream.id);
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
            if (!existing.robotStreamer?.active) maybeStartRsRestream(stream.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            updateRsRestreamSlotUI();
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
        if (typeof refreshChatTTSContext === 'function') refreshChatTTSContext();
        startHeartbeat(stream.id);
        await startMediaCapture(stream.id); connectSignaling(stream.id); maybeStartRsRestream(stream.id); startVodRecording(stream.id);
        startGlobalDisplayTimers();
        acquireWakeLock();
        showBroadcastCallControls(); updateBroadcastCallUI();
        updateRsRestreamSlotUI();
        startRestreamStatusPolling();
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
        if (typeof refreshChatTTSContext === 'function') refreshChatTTSContext();
        showBroadcastCallControls(); updateBroadcastCallUI();
        startRestreamStatusPolling();
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
        if (typeof refreshChatTTSContext === 'function') refreshChatTTSContext();
        showBroadcastCallControls(); updateBroadcastCallUI();
        startRestreamStatusPolling();
    }
}

async function loadExistingStreams(excludeStreamId) {
    const listEl = document.getElementById('bc-streams-list');
    if (!listEl) return;
    try {
        // Use the /mine endpoint to get all user's streams
        const data = await api('/streams/mine');
        // Exclude the just-ended stream (background DELETE may not have fired yet)
        const all = (data.streams || []).filter(s => !excludeStreamId || s.id !== excludeStreamId);

        if (!all.length) {
            listEl.innerHTML = `
                <div class="bc-welcome">
                    <i class="fa-solid fa-campground fa-3x" style="margin-bottom:12px;color:var(--accent)"></i>
                    <h3>Welcome to HoboStreamer!</h3>
                    <p>Ready to go live? Fill out the form on the left and click <strong>Create Stream</strong>.</p>
                    <div class="bc-welcome-tips">
                        <div class="bc-welcome-tip"><i class="fa-solid fa-1" style="font-size:0.75rem"></i> <span>Pick a <strong>title</strong> &amp; <strong>method</strong> (WebRTC is the easiest — uses your browser camera)</span></div>
                        <div class="bc-welcome-tip"><i class="fa-solid fa-2" style="font-size:0.75rem"></i> <span>Allow camera/mic when prompted (WebRTC only)</span></div>
                        <div class="bc-welcome-tip"><i class="fa-solid fa-3" style="font-size:0.75rem"></i> <span>Click <strong>Create Stream</strong> and you're live!</span></div>
                    </div>
                    <div class="bc-welcome-methods" style="margin-top:14px;text-align:left">
                        <p style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:8px"><strong>Three ways to stream:</strong></p>
                        <div class="bc-welcome-tip"><i class="fa-solid fa-globe"></i> <strong>WebRTC</strong> — Stream from your browser (camera, screen, or OBS WHIP) — no install needed</div>
                        <div class="bc-welcome-tip"><i class="fa-solid fa-server"></i> <strong>RTMP</strong> — Use OBS Studio, Streamlabs, IRL Pro, or any RTMP app — best quality</div>
                        <div class="bc-welcome-tip"><i class="fa-solid fa-terminal"></i> <strong>JSMPEG</strong> — Run an FFmpeg command — perfect for Raspberry Pi &amp; headless servers</div>
                    </div>
                    <p class="muted" style="margin-top:14px"><i class="fa-solid fa-circle-info"></i> Your permanent stream link: <strong>hobostreamer.com/${esc(currentUser?.username || 'you')}</strong></p>
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
                <p>Fill in the form on the left to create your stream. <strong>WebRTC</strong> is the easiest — it uses your browser camera directly.</p>
                <div class="bc-welcome-tips">
                    <div class="bc-welcome-tip"><i class="fa-solid fa-globe"></i> <strong>WebRTC</strong> — Stream from your browser (no install needed)</div>
                    <div class="bc-welcome-tip"><i class="fa-solid fa-server"></i> <strong>RTMP</strong> — Use OBS, Streamlabs, or a mobile app (best quality)</div>
                    <div class="bc-welcome-tip"><i class="fa-solid fa-terminal"></i> <strong>JSMPEG</strong> — FFmpeg command line (Raspberry Pi &amp; headless)</div>
                </div>
            </div>`;
    }
}

function renderStreamItem(s) {
    const badge = s.is_live ? '<span class="badge badge-live">LIVE</span>' : '<span class="badge badge-offline">Ended</span>';
    const time = s.started_at ? new Date(s.started_at.replace(' ', 'T') + 'Z').toLocaleString() : '';
    const duration = s.duration_seconds ? formatDuration(s.duration_seconds) : '';
    const hasBrowserState = broadcastState.streams.has(s.id);
    const resumeLabel = hasBrowserState ? 'Continue' : 'Resume';
    return `<div class="bc-stream-item ${s.is_live ? 'bc-stream-live' : ''}">
        <div class="bc-stream-info">
            <strong>${esc(s.title || 'Untitled')}</strong>
            <span class="muted">${(s.protocol || 'webrtc').toUpperCase()} · ${time}${duration ? ' · ' + duration : ''}${s.viewer_count ? ' · ' + s.viewer_count + ' viewer' + (s.viewer_count === 1 ? '' : 's') : ''}</span>
        </div>
        <div class="bc-stream-actions">
            ${s.is_live ? `<button class="btn btn-small btn-primary" onclick="resumeStream(${s.id})"><i class="fa-solid fa-play"></i> ${resumeLabel}</button> <button class="btn btn-small btn-danger" onclick="endExistingStream(${s.id})"><i class="fa-solid fa-stop"></i> End</button>` : ''}
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
        let bgCtx = null;
        if (ss) {
            bgCtx = _detachVodForBackground(streamId);
            cleanupStream(streamId);
        }
        toast('Stream ended', 'info');
        if (!isStreaming()) setNavLiveIndicator(false);
        loadExistingStreams(streamId);
        _backgroundStreamEnd(streamId, bgCtx);
    } catch (e) { toast(e.message || 'Failed to end stream', 'error'); }
}

/* ── Method Selection ────────────────────────────────────────── */
const _methodExplainers = {
    webrtc: '<strong>WebRTC</strong> lets you stream directly from this browser tab using your camera, microphone, or screen — no extra software needed. Just click Create Stream and you\'re live.',
    rtmp: '<strong>RTMP</strong> sends video from a dedicated streaming app (OBS Studio, Streamlabs, IRL Pro, etc.) to our server. After creating the stream, you\'ll get a <strong>Server URL</strong> and <strong>Stream Key</strong> to paste into your app. This gives you the best video quality and most customization.',
    jsmpeg: '<strong>JSMPEG</strong> uses a single FFmpeg command in your terminal to send video. It\'s the most lightweight method — ideal for Raspberry Pi, security cameras, headless Linux servers, and 24/7 unattended streams. After creating the stream, you\'ll get a ready-to-paste terminal command.',
};
function selectStreamMethod(method) {
    broadcastState.selectedMethod = method;
    document.querySelectorAll('.bc-method-card').forEach(el => el.classList.toggle('selected', el.dataset.method === method));
    const sub = document.getElementById('bc-webrtc-sub');
    if (sub) sub.style.display = method === 'webrtc' ? 'block' : 'none';
    // Update method explainer text
    const explainer = document.getElementById('bc-method-explainer-text');
    if (explainer && _methodExplainers[method]) explainer.innerHTML = _methodExplainers[method];
    // Update step 3 header based on method
    _syncStep3Header(method);
    _syncBrowserSourceUI();
}
/** Update the step 3 header text/visibility based on the selected method */
function _syncStep3Header(method) {
    const hdr = document.getElementById('bc-step3-header');
    if (!hdr) return;
    const textEl = hdr.querySelector('.bc-step-text span');
    if (!textEl) return;
    if (method === 'webrtc') {
        hdr.style.display = '';
        textEl.textContent = 'Set up your camera, mic, or screen share';
    } else if (method === 'rtmp') {
        hdr.style.display = 'none';
    } else if (method === 'jsmpeg') {
        hdr.style.display = 'none';
    }
}
function selectWebRTCSub(sub) {
    broadcastState.selectedWebRTCSub = sub;
    document.querySelectorAll('[data-sub]').forEach(el => el.classList.toggle('selected', el.dataset.sub === sub));
    _syncBrowserSourceUI();
}
function selectBrowserSource(src) {
    broadcastState.selectedBrowserSource = src;
    document.querySelectorAll('[data-bsrc]').forEach(el => el.classList.toggle('selected', el.dataset.bsrc === src));
    _syncBrowserSourceUI();
}
/** Select screen capture source type from the visual picker buttons */
function selectScreenCaptureSource(source) {
    updateBroadcastSetting('screenCaptureSource', source);
    // Update visual picker buttons
    document.querySelectorAll('#bc-source-picker .bc-source-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.source === source);
    });
    // Also sync the settings panel dropdown + create-form dropdown
    const settingsEl = document.getElementById('bc-screenCaptureSource');
    if (settingsEl) settingsEl.value = source;
    const createEl = document.getElementById('bc-screenCaptureSource-create');
    if (createEl) createEl.value = source;
}
/** Sync screen share capture option dropdowns in the create form to match settings */
function _syncScreenShareCreateOptions() {
    const s = broadcastState.settings;
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
    // Sync picker buttons
    document.querySelectorAll('#bc-source-picker .bc-source-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.source === (s.screenCaptureSource || 'auto'));
    });
    setVal('bc-screenSystemAudio-create', s.screenSystemAudio || 'include');
    setVal('bc-screenSelfBrowser-create', s.screenSelfBrowser || 'exclude');
    setVal('bc-screenSurfaceSwitching-create', s.screenSurfaceSwitching || 'include');
    setCheck('bc-screenPreferCurrentTab-create', s.screenPreferCurrentTab || false);
}
/** Show/hide the correct device pickers based on current method/sub/source selection */
function _syncBrowserSourceUI() {
    const isBrowser = broadcastState.selectedMethod === 'webrtc' && broadcastState.selectedWebRTCSub === 'browser';
    const srcChoice = document.getElementById('bc-browser-source-choice');
    const camDevices = document.getElementById('bc-create-devices');
    const screenSetup = document.getElementById('bc-screen-share-setup');
    if (srcChoice) srcChoice.style.display = isBrowser ? 'block' : 'none';
    if (camDevices) camDevices.style.display = (isBrowser && broadcastState.selectedBrowserSource === 'camera') ? 'block' : 'none';
    if (screenSetup) {
        screenSetup.style.display = (isBrowser && broadcastState.selectedBrowserSource === 'screen') ? 'block' : 'none';
        if (isBrowser && broadcastState.selectedBrowserSource === 'screen') _syncScreenShareCreateOptions();
    }
}

/* ── Create New Stream ───────────────────────────────────────── */
async function createNewStream() {
    const title = document.getElementById('bc-title')?.value.trim();
    const description = document.getElementById('bc-description')?.value.trim() || '';
    const category = document.getElementById('bc-category')?.value || 'irl';
    const method = broadcastState.selectedMethod;
    if (!title) return toast('Stream title is required', 'error');

    const isBrowserStream = method === 'webrtc' && broadcastState.selectedWebRTCSub === 'browser';
    const isScreenMode = isBrowserStream && broadcastState.selectedBrowserSource === 'screen';

    // Auto-request camera/mic permissions if user hasn't clicked "Allow Camera & Mic" yet (camera mode only)
    if (isBrowserStream && !isScreenMode) {
        const permReq = document.getElementById('bc-perm-request');
        if (permReq && permReq.style.display !== 'none') {
            await requestMediaPermissions();
            // If permissions failed, bc-perm-request will still be visible — abort
            if (permReq.style.display !== 'none') {
                return; // requestMediaPermissions() already showed the error toast
            }
        }
    }

    // Stop any existing browser WebRTC streams to prevent camera contention.
    // Without this, old streams fight with the new one over the camera device,
    // causing infinite media recovery loops and orphaned VOD uploads.
    for (const [existingId, ss] of broadcastState.streams) {
        if (ss.localStream) {
            console.log(`[Broadcast] Cleaning up existing stream ${existingId} before creating new one`);
            const bgCtx = _detachVodForBackground(existingId);
            cleanupStream(existingId);
            _backgroundStreamEnd(existingId, bgCtx);
        }
    }

    // Persist last-used values so they pre-fill next time
    localStorage.setItem('bc-last-title', title);
    localStorage.setItem('bc-last-description', description);
    localStorage.setItem('bc-last-category', category);

    // Restore existing-streams panel visibility for next time
    const existingEl = document.getElementById('bc-existing-streams');
    if (existingEl) existingEl.style.display = '';

    // Read device selection from create form (camera mode)
    const createCamera = document.getElementById('bc-create-camera')?.value || 'default';
    const createAudio = document.getElementById('bc-create-audio')?.value || 'default';

    // Read screen share device selections
    const screenMicEnabled = document.getElementById('bc-screen-mic-enabled')?.checked ?? true;
    const screenCamEnabled = document.getElementById('bc-screen-cam-enabled')?.checked ?? false;
    const screenAudio = document.getElementById('bc-screen-audio')?.value || 'default';
    const screenCamera = document.getElementById('bc-screen-camera')?.value || 'default';

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

        if (isBrowserStream) {
            // Set screen share mode before media capture
            if (isScreenMode) {
                broadcastState.settings.screenShare = true;
                ss._cameraOverlayEnabled = screenCamEnabled;
                saveBroadcastSettings();
            } else {
                broadcastState.settings.screenShare = false;
                saveBroadcastSettings();
            }

            showBrowserBroadcast(); populateDeviceLists(); populateTTSVoices(); syncSettingsUI();
            _syncScreenShareUI();
            ensureBroadcastChat(streamData.id);

            if (isScreenMode) {
                // Screen share capture options
                const captureOpts = {
                    audioId: screenMicEnabled ? screenAudio : null,
                    cameraId: screenCamEnabled ? screenCamera : null,
                    skipMic: !screenMicEnabled,
                };
                await startMediaCapture(streamData.id, captureOpts);
            } else {
                await startMediaCapture(streamData.id, { cameraId: createCamera, audioId: createAudio });
            }

            connectSignaling(streamData.id);
            maybeStartRsRestream(streamData.id);
            startHeartbeat(streamData.id); startVodRecording(streamData.id);
            startGlobalDisplayTimers();
            acquireWakeLock();
            showBroadcastCallControls(); updateBroadcastCallUI();
            updateRsRestreamSlotUI();
            startRestreamStatusPolling();
            // Show/hide screen share live controls
            _syncScreenShareLiveControls(ss);
            toast('You are now LIVE!', 'success');
        } else if (method === 'webrtc' && broadcastState.selectedWebRTCSub === 'obs') {
            showWHIPInstructions(streamData); startHeartbeat(streamData.id);
            ensureBroadcastChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            startRestreamStatusPolling();
            toast('Stream created — configure OBS with the details below', 'success');
        } else if (method === 'rtmp') {
            showRTMPInstructions(streamData); startHeartbeat(streamData.id);
            ensureBroadcastChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            startRestreamStatusPolling();
            toast('Stream created — configure your streaming software', 'success');
        } else if (method === 'jsmpeg') {
            showJSMPEGInstructions(streamData); startHeartbeat(streamData.id);
            ensureBroadcastChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            startRestreamStatusPolling();
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
    _startRsViewerPoll();
    _startRestreamViewerPoll();
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
    _startRsViewerPoll();
    _startRestreamViewerPoll();
    try {
        const data = await api(`/streams/${stream.id}/endpoint`);
        const ep = data.endpoint || {};
        const rtmpUrl = ep.rtmpUrl || `rtmp://${location.hostname}:1935/live`;
        const streamKey = ep.streamKey || data.stream_key || 'N/A';
        document.getElementById('bc-rtmp-url').textContent = rtmpUrl;
        document.getElementById('bc-rtmp-key').textContent = streamKey;
        // Mirror into IRL Pro guide fields
        const irlUrl = document.getElementById('bc-irlpro-url');
        const irlKey = document.getElementById('bc-irlpro-key');
        if (irlUrl) irlUrl.textContent = rtmpUrl;
        if (irlKey) irlKey.textContent = streamKey;
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
        label.textContent = 'Receiving RTMP feed';
        detail.textContent = 'Your stream is live and connected';
    } else {
        wrap.className = 'bc-rtmp-status waiting';
        spinner.style.display = '';
        ok.style.display = 'none';
        label.textContent = 'Waiting for stream...';
        detail.textContent = 'Start streaming in OBS or your app to connect';
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
    _startRsViewerPoll();
    _startRestreamViewerPoll();
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
    _startRsViewerPoll();
    _startRestreamViewerPoll();
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
        const preferredCamera = broadcastState.settings.forceCamera || localStorage.getItem('bc-last-camera') || 'default';
        _syncCameraSelectionUI(preferredCamera, { persist: false });
        if (broadcastState.settings.forceAudio !== 'default') audioSelect.value = broadcastState.settings.forceAudio;
        if (tempStream) tempStream.getTracks().forEach(t => t.stop());
    } catch (err) { console.warn('Could not enumerate devices:', err.message); }
}

function _getPreferredCameraId() {
    return broadcastState.settings.forceCamera || localStorage.getItem('bc-last-camera') || 'default';
}

function _setSelectValueIfPresent(select, value) {
    if (!select) return;
    const normalized = value || 'default';
    const hasExact = Array.from(select.options || []).some(opt => opt.value === normalized);
    select.value = hasExact ? normalized : 'default';
}

function _syncCameraSelectionUI(cameraId, { persist = true } = {}) {
    const normalized = cameraId || 'default';
    _setSelectValueIfPresent(document.getElementById('bc-forceCamera'), normalized);
    _setSelectValueIfPresent(document.getElementById('bc-create-camera'), normalized);
    _setSelectValueIfPresent(document.getElementById('bc-screen-camera'), normalized);
    broadcastState.settings.forceCamera = normalized;
    if (persist) {
        saveBroadcastSettings();
        try { localStorage.setItem('bc-last-camera', normalized); } catch {}
    }
}

function _describeCameraRole(device, index = 0) {
    const label = String(device?.label || '').toLowerCase();
    if (label.includes('back') || label.includes('rear') || label.includes('environment') || label.includes('world')) {
        return { icon: 'fa-solid fa-camera', title: 'Rear Camera', detail: 'Best for outward-facing mobile video.' };
    }
    if (label.includes('front') || label.includes('user') || label.includes('face') || label.includes('facetime')) {
        return { icon: 'fa-solid fa-user', title: 'Front Camera', detail: 'Best for selfie-style streaming.' };
    }
    if (label.includes('external') || label.includes('usb') || label.includes('webcam') || label.includes('obs')) {
        return { icon: 'fa-solid fa-video', title: 'External Camera', detail: 'Detected as an external or USB camera.' };
    }
    return { icon: 'fa-solid fa-camera-retro', title: `Camera ${index + 1}`, detail: 'Available video input device.' };
}

function _getCameraFacingHint(device) {
    const label = String(device?.label || '').toLowerCase();
    if (label.includes('back') || label.includes('rear') || label.includes('environment') || label.includes('world')) return 'environment';
    if (label.includes('front') || label.includes('user') || label.includes('face') || label.includes('facetime')) return 'user';
    return null;
}

async function _enumerateBroadcastVideoInputs({ ensureLabels = false } = {}) {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    let tempStream = null;
    try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        const missingLabels = devices.filter(d => d.kind === 'videoinput').some(d => !d.label);
        if (ensureLabels && missingLabels && navigator.mediaDevices?.getUserMedia) {
            try {
                tempStream = await _getUserMediaWithTimeout({ video: true, audio: false }, 8000);
                devices = await navigator.mediaDevices.enumerateDevices();
            } catch (err) {
                console.warn('[Broadcast] Could not refresh camera labels:', err.message);
            }
        }
        return devices.filter(d => d.kind === 'videoinput');
    } finally {
        if (tempStream) tempStream.getTracks().forEach(t => t.stop());
    }
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
        _syncCameraSelectionUI(_getPreferredCameraId(), { persist: false });
        camSelect.onchange = () => _syncCameraSelectionUI(camSelect.value);
    }
    if (audioSelect) {
        audioSelect.innerHTML = '<option value="default">Default</option>';
        devices.filter(d => d.kind === 'audioinput').forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Mic ${d.deviceId.slice(0, 8)}`;
            audioSelect.appendChild(opt);
        });
        // Restore saved microphone selection
        const savedMic = localStorage.getItem('bc-last-audio');
        if (savedMic && audioSelect.querySelector(`option[value="${CSS.escape(savedMic)}"]`)) {
            audioSelect.value = savedMic;
        }
        audioSelect.onchange = () => localStorage.setItem('bc-last-audio', audioSelect.value);
    }

    // Also populate screen share device selects (same device lists)
    const screenAudioSelect = document.getElementById('bc-screen-audio');
    if (screenAudioSelect) {
        screenAudioSelect.innerHTML = '<option value="default">Default Microphone</option>';
        devices.filter(d => d.kind === 'audioinput').forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Mic ${d.deviceId.slice(0, 8)}`;
            screenAudioSelect.appendChild(opt);
        });
        const savedMic = localStorage.getItem('bc-last-audio');
        if (savedMic && screenAudioSelect.querySelector(`option[value="${CSS.escape(savedMic)}"]`)) {
            screenAudioSelect.value = savedMic;
        }
    }
    const screenCamSelect = document.getElementById('bc-screen-camera');
    if (screenCamSelect) {
        screenCamSelect.innerHTML = '<option value="default">Default Camera</option>';
        devices.filter(d => d.kind === 'videoinput').forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Camera ${d.deviceId.slice(0, 8)}`;
            screenCamSelect.appendChild(opt);
        });
        _syncCameraSelectionUI(_getPreferredCameraId(), { persist: false });
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
    setCheck('bc-serverReconnect', s.serverReconnect !== false);
    setVal('bc-allowSounds', s.allowSounds); setVal('bc-soundVolume', s.soundVolume);
    setVal('bc-forceAudio', s.forceAudio || 'default');
    setCheck('bc-screenShare', s.screenShare);
    // Screen share capture settings
    setVal('bc-screenCaptureSource', s.screenCaptureSource || 'auto');
    setVal('bc-screenSystemAudio', s.screenSystemAudio || 'include');
    setVal('bc-screenSelfBrowser', s.screenSelfBrowser || 'exclude');
    setVal('bc-screenSurfaceSwitching', s.screenSurfaceSwitching || 'include');
    setCheck('bc-screenPreferCurrentTab', s.screenPreferCurrentTab || false);
    _syncCameraSelectionUI(s.forceCamera || _getPreferredCameraId(), { persist: false });
    _syncScreenShareUI();
    syncRobotStreamerUI();
}

function updateBroadcastSetting(key, value) {
    broadcastState.settings[key] = value; saveBroadcastSettings();
}

/**
 * Detach VOD recording state from a stream so it can be finalized in the background.
 * Redirects the recorder's ondataavailable to a standalone array, then nulls the
 * stream state's recorder reference so cleanupStream() won't touch it.
 */
function _detachVodForBackground(streamId) {
    const ss = getStreamState(streamId);
    if (!ss) return null;

    const recorder = ss.vodRecorder;
    const streamDataId = ss.streamData?.id;
    const finalized = ss.vodFinalized;
    const segmentId = ss.vodSegmentId || 0;
    const chunks = ss.vodChunks ? ss.vodChunks.splice(0) : [];

    // Redirect any final ondataavailable events to our standalone array
    if (recorder) {
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };
    }

    // Prevent cleanupStream from stopping the recorder or clearing chunks
    ss.vodRecorder = null;
    ss.vodChunks = [];

    return { recorder, chunks, streamDataId, finalized, segmentId };
}

/**
 * Background: stop recorder, upload remaining VOD chunks, finalize, and delete stream.
 * Fire-and-forget — errors are logged but never surface to the UI.
 */
function _backgroundStreamEnd(streamId, vodCtx) {
    (async () => {
        if (vodCtx) {
            try {
                // Stop recorder — triggers final ondataavailable into vodCtx.chunks
                if (vodCtx.recorder && vodCtx.recorder.state !== 'inactive') {
                    try { vodCtx.recorder.stop(); } catch {}
                    await new Promise(r => setTimeout(r, 600));
                }

                // Upload remaining chunks
                if (vodCtx.chunks.length > 0 && vodCtx.streamDataId) {
                    const blob = new Blob(vodCtx.chunks, { type: 'video/webm' });
                    if (blob.size >= 100) {
                        const fd = new FormData();
                        fd.append('chunk', blob, `chunk-${streamId}-final.webm`);
                        fd.append('segmentId', String(vodCtx.segmentId || 1));
                        await fetch(`/api/vods/stream/${vodCtx.streamDataId}/chunk`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                            body: fd,
                        });
                    }
                }

                // Tell server to remux for seeking
                if (vodCtx.streamDataId && !vodCtx.finalized) {
                    await fetch(`/api/vods/stream/${vodCtx.streamDataId}/finalize`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${localStorage.getItem('token')}`,
                            'Content-Type': 'application/json',
                        },
                    });
                    console.log('[VOD] Background finalize complete for stream', streamId);
                }
            } catch (err) {
                console.warn('[VOD] Background finalization error:', err.message);
            }
        }

        // Delete stream on server
        try { await api(`/streams/${streamId}`, { method: 'DELETE' }); } catch {}
    })();
}

/* ── Stop Broadcasting ───────────────────────────────────────── */
async function stopBroadcast() {
    const activeId = broadcastState.activeStreamId;
    let bgCtx = null;

    if (activeId) {
        bgCtx = _detachVodForBackground(activeId);
        cleanupStream(activeId);
    }

    // Check if other streams are still live (exclude the stopped stream — DELETE hasn't fired yet)
    try {
        const data = await api('/streams/mine');
        const remaining = (data.streams || []).filter(s => s.is_live && s.id !== activeId);
        if (remaining.length > 0) {
            const withState = remaining.find(s => broadcastState.streams.has(s.id));
            const nextStream = withState || remaining[0];
            await buildBroadcastTabs(nextStream.id);
            await switchOrResumeStream(nextStream);
            toast('Stream ended', 'info');
            if (activeId) _backgroundStreamEnd(activeId, bgCtx);
            return;
        }
    } catch {}

    hideBroadcastTabs();
    clearGlobalDisplayTimers();
    if (!isStreaming()) setNavLiveIndicator(false);
    showStreamManager(); loadExistingStreams(activeId); toast('Stream ended', 'info');
    // Scroll create section into view so user lands on "Create New Stream"
    const createSec = document.getElementById('bc-create-section');
    if (createSec) createSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (activeId) _backgroundStreamEnd(activeId, bgCtx);
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

    // Stop media tracks (suppress recovery so ended events don't trigger it)
    stopTrackKeepalive(streamId);
    ss._suppressRecovery = true;
    _cleanupComposite(ss);
    if (ss._screenStream) { ss._screenStream.getTracks().forEach(t => t.stop()); ss._screenStream = null; }
    if (ss.localStream) { ss.localStream.getTracks().forEach(t => t.stop()); ss.localStream = null; }
    stopRobotStreamerRestream(streamId, { quiet: true }).catch(() => {});
    _cleanupSfuProduce(streamId);

    // Clear RS restream slot if this stream had it
    if (getRsRestreamSlotStreamId() === streamId) setRsRestreamSlot(null);

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
    _perStreamViewerCounts.delete(streamId);
    _updateTotalViewerCount();

    // Stop RS viewer polling if no streams left
    if (broadcastState.streams.size === 0) { _stopRsViewerPoll(); _stopRestreamViewerPoll(); }

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
        releaseWakeLock();
        stopRestreamStatusPolling();
        // Close any background broadcast chat WS now that we're no longer live
        if (typeof destroyBgBroadcastChat === 'function') destroyBgBroadcastChat();
    }

    if (typeof refreshChatTTSContext === 'function') refreshChatTTSContext();

    updateBroadcastMobileChatFab();
    updateRsRestreamSlotUI();
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
    const dot = document.getElementById('nav-live-dot');
    if (dot) dot.style.display = isLive ? '' : 'none';
    const link = document.getElementById('nav-broadcast');
    if (link) {
        link.classList.toggle('nav-live', isLive);
        link.dataset.tooltip = isLive ? 'LIVE' : 'Go Live';
    }
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
    _stopRsViewerPoll();
    _stopRestreamViewerPoll();
}

/* ── Per-Stream Heartbeat ────────────────────────────────────── */

function startHeartbeat(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.streamData) return;
    clearInterval(ss.heartbeatInterval);
    const sid = ss.streamData.id;
    ss.heartbeatInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/streams/${sid}/heartbeat`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`,
                    'Content-Type': 'application/json',
                },
            });
            if (!res.ok) {
                // Server might be restarting — retry several times before giving up.
                // During a deploy the server is briefly unavailable, and the stale-stream
                // cleanup could end our stream before our heartbeat comes through.
                // Give it 5 retries (2.5 minutes at 30s intervals) before cleaning up.
                ss._heartbeatFailCount = (ss._heartbeatFailCount || 0) + 1;
                if (ss._heartbeatFailCount < 5) {
                    console.warn(`[Heartbeat] Stream ${streamId} returned ${res.status} — retry ${ss._heartbeatFailCount}/5`);
                    return;
                }
                console.warn(`[Heartbeat] Stream ${streamId} heartbeat failed ${ss._heartbeatFailCount} times — cleaning up`);
                cleanupStream(streamId);
                if (!isStreaming()) {
                    hideBroadcastTabs();
                    clearGlobalDisplayTimers();
                    setNavLiveIndicator(false);
                    showStreamManager();
                    loadExistingStreams();
                }
                return;
            }
            // Reset fail counter on success
            ss._heartbeatFailCount = 0;
        } catch {
            // Network error — don't clean up, server may be restarting
        }
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
 * Build getDisplayMedia() constraints from the user's screen share settings.
 * Modular helper — each constraint is independent so partial browser support is fine.
 * @param {object} [resolution] - {w, h} — video resolution to request
 * @returns {MediaStreamConstraints}
 */
function _buildDisplayMediaConstraints(resolution) {
    const s = broadcastState.settings;
    const res = resolution || { w: 1280, h: 720 };

    const videoConstraints = {
        width: { ideal: res.w },
        height: { ideal: res.h },
        frameRate: { ideal: getBroadcastFrameRate() },
    };

    // Display surface preference: which type of source the picker should prefer
    // 'auto' = let browser decide (no constraint), 'monitor'|'window'|'browser' = hint
    if (s.screenCaptureSource && s.screenCaptureSource !== 'auto') {
        videoConstraints.displaySurface = s.screenCaptureSource;
    }

    // Audio: system/tab audio capture
    let audioConstraint = true; // default: request audio
    if (s.screenSystemAudio === 'exclude') {
        audioConstraint = false;
    } else if (s.screenSystemAudio === 'include') {
        // Some browsers support systemAudio constraint on the top-level
        audioConstraint = { systemAudio: 'include' };
    }
    // 'auto' leaves it as `true` (let browser decide)

    const constraints = { video: videoConstraints, audio: audioConstraint };

    // Self browser surface: whether the current tab appears in the picker
    // 'exclude' prevents accidentally capturing your own broadcast page
    if (s.screenSelfBrowser === 'exclude') {
        constraints.selfBrowserSurface = 'exclude';
    } else if (s.screenSelfBrowser === 'include') {
        constraints.selfBrowserSurface = 'include';
    }

    // Surface switching: allow changing the shared surface while live (browser support varies)
    if (s.screenSurfaceSwitching === 'include') {
        constraints.surfaceSwitching = 'include';
    } else if (s.screenSurfaceSwitching === 'exclude') {
        constraints.surfaceSwitching = 'exclude';
    }

    // Prefer current tab (useful for tab capture workflows)
    if (s.screenPreferCurrentTab) {
        constraints.preferCurrentTab = true;
    }

    // Mono audio hint for screen audio (reduces bandwidth)
    if (constraints.audio && typeof constraints.audio === 'object') {
        constraints.audio.channelCount = { ideal: 2 };
    }

    console.log('[Broadcast] Display media constraints:', JSON.stringify(constraints));
    return constraints;
}

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
    const forceAudio = (opts.skipMic) ? null : (opts.audioId || s.forceAudio);
    const resMap = { '360': { w: 640, h: 360 }, '480': { w: 854, h: 480 }, '720': { w: 1280, h: 720 }, '1080': { w: 1920, h: 1080 }, '1440': { w: 2560, h: 1440 } };
    const res = resMap[s.broadcastRes] || resMap['720'];
    let videoConstraints, audioConstraints;

    if (s.screenShare) {
        // Stop any previous composite resources
        _cleanupComposite(ss);

        const displayConstraints = _buildDisplayMediaConstraints(res);
        let screenStream;
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
        } catch (err) {
            // Some browsers don't support all constraint keys — retry with minimal constraints
            if (err.name === 'TypeError' || err.name === 'OverconstrainedError') {
                console.warn('[Broadcast] getDisplayMedia constraints not fully supported, retrying with minimal:', err.message);
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { width: { ideal: res.w }, height: { ideal: res.h }, frameRate: { ideal: getBroadcastFrameRate() } },
                    audio: s.screenSystemAudio !== 'exclude',
                });
            } else {
                throw err; // permission denied, user cancelled, etc — let caller handle
            }
        }
        ss._screenStream = screenStream;

        // Handle user cancelling screen share picker (track ended immediately)
        const screenTrack = screenStream.getVideoTracks()[0];
        if (screenTrack) {
            screenTrack.addEventListener('ended', () => {
                // User clicked "Stop sharing" in browser UI — switch back to camera
                if (broadcastState.settings.screenShare && !ss._suppressRecovery) {
                    console.log('[Broadcast] Screen share ended by user/OS — switching back to camera');
                    broadcastState.settings.screenShare = false; saveBroadcastSettings();
                    _syncScreenShareUI();
                    _syncScreenShareLiveControls(ss);
                    // Re-acquire camera
                    const sid = broadcastState.activeStreamId;
                    if (sid && ss === getStreamState(sid)) {
                        ss._suppressRecovery = true;
                        _cleanupComposite(ss);
                        startMediaCapture(sid).then(() => {
                            _replaceAllViewerTracks(sid);
                            startVodRecording(sid);
                            ss._suppressRecovery = false;
                        }).catch(() => { ss._suppressRecovery = false; });
                    }
                }
            }, { once: true });
        }

        // Get mic audio separately (unless skipped). Desktop audio comes from getDisplayMedia.
        let micStream = null;
        if (forceAudio !== null) {
            audioConstraints = buildAudioConstraints(s, forceAudio);
            try { micStream = await _getUserMediaWithTimeout({ audio: audioConstraints, video: false }); } catch { micStream = null; }
        }
        ss._micEnabled = forceAudio !== null;

        // Mix desktop audio + mic audio if both are available
        const screenAudioTracks = screenStream.getAudioTracks();
        let finalAudioTrack = null;
        if (micStream && screenAudioTracks.length > 0) {
            // Mix both via AudioContext
            try {
                const mixCtx = new AudioContext();
                const dest = mixCtx.createMediaStreamDestination();
                const desktopSource = mixCtx.createMediaStreamSource(new MediaStream(screenAudioTracks));
                desktopSource.connect(dest);
                const micSource = mixCtx.createMediaStreamSource(micStream);
                micSource.connect(dest);
                finalAudioTrack = dest.stream.getAudioTracks()[0];
                ss._mixAudioContext = mixCtx;
                ss._micStream = micStream;
            } catch {
                finalAudioTrack = micStream.getAudioTracks()[0] || screenAudioTracks[0];
            }
        } else if (micStream) {
            finalAudioTrack = micStream.getAudioTracks()[0];
            ss._micStream = micStream;
        } else if (screenAudioTracks.length > 0) {
            finalAudioTrack = screenAudioTracks[0];
        }

        // If camera overlay is enabled, capture camera too and composite onto canvas
        if (ss._cameraOverlayEnabled) {
            let camStream;
            try {
                const camConstraints = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: getBroadcastFrameRate() } };
                if (forceCamera && forceCamera !== 'default') camConstraints.deviceId = forceCamera;
                camStream = await _getUserMediaWithTimeout({ video: camConstraints, audio: false });
            } catch (err) {
                console.warn('[Broadcast] Camera overlay failed, proceeding without:', err.message);
                camStream = null;
            }
            ss._cameraOverlayStream = camStream;

            if (camStream) {
                _startPipComposite(ss, screenStream, screenTrack, camStream, finalAudioTrack, res);
            } else {
                // Camera not available — screen-only
                const combined = new MediaStream();
                screenStream.getVideoTracks().forEach(t => combined.addTrack(t));
                if (finalAudioTrack) combined.addTrack(finalAudioTrack);
                ss.localStream = combined;
            }
        } else {
            // Screen share without camera overlay
            const combined = new MediaStream();
            screenStream.getVideoTracks().forEach(t => combined.addTrack(t));
            if (finalAudioTrack) combined.addTrack(finalAudioTrack);
            ss.localStream = combined;
        }
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
    startTrackKeepalive(streamId);

    // Only attach to preview if this is the active stream
    if (broadcastState.activeStreamId === streamId) {
        const preview = document.getElementById('bc-video-preview');
        if (preview) { preview.srcObject = ss.localStream; preview.muted = true; preview.play().catch(() => {}); }
        const ph = document.getElementById('bc-video-placeholder'); if (ph) ph.style.display = 'none';

        // Detect vertical video and add class for responsive mobile layout
        _detectBroadcastVerticalPreview(ss.localStream);

        // Listen for video dimension changes (e.g., device rotation mid-stream)
        if (preview) {
            preview.addEventListener('resize', () => _detectBroadcastVerticalPreview(ss.localStream));
        }
    }
    updateBroadcastMobileChatFab();
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

/* ── Multi-Platform Restream Destinations ──────────────────── */

const RESTREAM_PLATFORM_META = {
    youtube: { name: 'YouTube', icon: 'fa-brands fa-youtube', color: '#ff0000' },
    twitch:  { name: 'Twitch', icon: 'fa-brands fa-twitch', color: '#9146ff' },
    kick:    { name: 'Kick', icon: 'fa-solid fa-k', color: '#53fc18' },
    custom:  { name: 'Custom', icon: 'fa-solid fa-globe', color: '#888' },
};

const RESTREAM_DEFAULT_URLS = {
    youtube: 'rtmp://a.rtmp.youtube.com/live2',
    twitch: 'rtmps://live.twitch.tv/app',
    kick: '',
    custom: '',
};

/** Client-side cache of loaded destinations */
let _restreamDestinations = [];
let _restreamStatusPollInterval = null;
let _restreamEditingId = null; // null = adding new, number = editing existing

/** Load restream destinations from server */
async function loadRestreamDestinations() {
    try {
        const data = await api('/restream/destinations');
        _restreamDestinations = data.destinations || [];
        renderRestreamDestinations();
    } catch (err) {
        console.warn('[Restream] Failed to load destinations:', err.message);
    }
}

/** Render destination cards in the settings section */
function renderRestreamDestinations() {
    const container = document.getElementById('bc-restream-destinations');
    if (!container) return;

    if (_restreamDestinations.length === 0) {
        container.innerHTML = '';
        return;
    }

    let html = '';
    for (const dest of _restreamDestinations) {
        const meta = RESTREAM_PLATFORM_META[dest.platform] || RESTREAM_PLATFORM_META.custom;
        const enabledClass = dest.enabled ? '' : 'style="opacity:0.5"';
        const autoStartBadge = dest.auto_start ? '<span style="font-size:0.7rem;color:var(--text-secondary);margin-left:4px" title="Auto-starts when you go live">[auto]</span>' : '';
        const qualityLabel = dest.quality_preset && dest.quality_preset !== 'auto' ? dest.quality_preset : 'auto';
        const qualityBadge = `<span style="font-size:0.65rem;color:var(--text-secondary);margin-left:4px;text-transform:uppercase" title="Encoding quality preset">[${qualityLabel}]</span>`;

        // Show custom overrides badge if any are set
        const customParts = [];
        if (dest.custom_video_bitrate) customParts.push(`${dest.custom_video_bitrate}k`);
        if (dest.custom_fps) customParts.push(`${dest.custom_fps}fps`);
        if (dest.custom_encoder_preset) customParts.push(dest.custom_encoder_preset);
        const customBadge = customParts.length > 0
            ? `<span style="font-size:0.6rem;color:var(--accent);margin-left:3px" title="Custom overrides: ${customParts.join(', ')}">[${customParts.join(' ')}]</span>`
            : '';

        const keyDisplay = dest.has_key ? `Key: ${dest.stream_key}` : 'No key set';
        const chatRelayBadge = dest.chat_relay ? '<span style="font-size:0.65rem;color:#53fc18;margin-left:4px" title="Chat relay enabled">[relay]</span>' : '';
        const channelUrlBadge = dest.channel_url ? `<a href="${dest.channel_url}" target="_blank" rel="noopener" style="font-size:0.65rem;color:${meta.color};margin-left:4px;text-decoration:none" title="${dest.channel_url}"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : '';

        html += `<div class="bc-restream-dest-card" ${enabledClass} data-dest-id="${dest.id}">
            <span class="bc-restream-platform-icon" style="color:${meta.color}"><i class="${meta.icon}"></i></span>
            <span class="bc-restream-name" title="${dest.name || meta.name}">${dest.name || meta.name}</span>
            ${autoStartBadge}${qualityBadge}${customBadge}${chatRelayBadge}${channelUrlBadge}
            <span class="bc-restream-dest-meta">${keyDisplay}</span>
            <div class="bc-restream-dest-actions">
                <button class="bc-ctrl-btn-sm" onclick="editRestreamDestination(${dest.id})" title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="bc-ctrl-btn-sm" onclick="toggleRestreamDestination(${dest.id})" title="${dest.enabled ? 'Disable' : 'Enable'}">
                    <i class="fa-solid fa-${dest.enabled ? 'toggle-on' : 'toggle-off'}"></i>
                </button>
                <button class="bc-ctrl-btn-sm" onclick="deleteRestreamDestination(${dest.id})" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;
    }
    container.innerHTML = html;
}

/** Show the add destination form */
function showAddRestreamDestination() {
    _restreamEditingId = null;
    document.getElementById('bc-restream-add-form').style.display = '';
    document.getElementById('bc-restream-add-btn-row').style.display = 'none';
    // Reset form
    document.getElementById('bc-restream-platform').value = 'youtube';
    document.getElementById('bc-restream-name').value = '';
    document.getElementById('bc-restream-key').value = '';
    document.getElementById('bc-restream-autostart').checked = false;
    document.getElementById('bc-restream-channel-url').value = '';
    document.getElementById('bc-restream-chat-relay').checked = false;
    document.getElementById('bc-restream-quality').value = 'auto';
    // Reset advanced fields
    document.getElementById('bc-restream-custom-vbr').value = '';
    document.getElementById('bc-restream-custom-abr').value = '';
    document.getElementById('bc-restream-custom-fps').value = '';
    document.getElementById('bc-restream-custom-encoder').value = '';
    document.getElementById('bc-restream-advanced').style.display = 'none';
    onRestreamPlatformChange();
}

/** Cancel add/edit form */
function cancelAddRestreamDestination() {
    document.getElementById('bc-restream-add-form').style.display = 'none';
    document.getElementById('bc-restream-add-btn-row').style.display = '';
    _restreamEditingId = null;
}

/** Handle platform selection change — update server URL placeholder */
function onRestreamPlatformChange() {
    const platform = document.getElementById('bc-restream-platform').value;
    const urlInput = document.getElementById('bc-restream-url');
    const urlRow = document.getElementById('bc-restream-url-row');
    const defaultUrl = RESTREAM_DEFAULT_URLS[platform] || '';

    if (defaultUrl) {
        urlInput.value = defaultUrl;
        urlInput.placeholder = defaultUrl;
        // For YouTube/Twitch, the URL is standard — show but pre-fill
        urlRow.style.display = '';
    } else {
        urlInput.value = '';
        urlInput.placeholder = 'rtmp://your-server.com/live';
        urlRow.style.display = '';
    }

    const nameInput = document.getElementById('bc-restream-name');
    if (!nameInput.value && !_restreamEditingId) {
        nameInput.placeholder = (RESTREAM_PLATFORM_META[platform]?.name || 'Custom') + ' Channel';
    }
}

/**
 * For Kick URLs with chat relay enabled, auto-detect the numeric chatroom ID.
 * Kick's Pusher requires numeric IDs (e.g. chatrooms.98275805.v2) — slugs don't work.
 * The Kick API is Cloudflare-blocked from servers, but works from user browsers.
 */
async function _resolveKickChatroomId(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase().replace('www.', '');
        if (!host.includes('kick.com')) return url;
        if (u.searchParams.get('chatroom')) return url; // already has chatroom ID
        const slug = u.pathname.split('/').filter(Boolean)[0];
        if (!slug) return url;

        const resp = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return url;
        const data = await resp.json();
        const chatroomId = data?.chatroom?.id;
        if (chatroomId && Number.isFinite(chatroomId)) {
            u.searchParams.set('chatroom', chatroomId);
            // Also store channel ID for Pusher viewer-count subscription
            const kickChannelId = data?.id;
            if (kickChannelId && Number.isFinite(kickChannelId)) {
                u.searchParams.set('kickChannelId', kickChannelId);
            }
            console.log(`[Restream] Auto-detected Kick chatroom ID: ${chatroomId}, channel ID: ${data?.id} for ${slug}`);
            return u.toString();
        }
    } catch (err) {
        console.warn('[Restream] Could not auto-detect Kick chatroom ID:', err.message);
    }
    return url;
}

/** Save a new or edited restream destination */
async function saveRestreamDestination() {
    const platform = document.getElementById('bc-restream-platform').value;
    const name = document.getElementById('bc-restream-name').value.trim();
    const server_url = document.getElementById('bc-restream-url').value.trim();
    const stream_key = document.getElementById('bc-restream-key').value.trim();
    const auto_start = document.getElementById('bc-restream-autostart').checked;
    let channel_url = document.getElementById('bc-restream-channel-url').value.trim() || null;
    const chat_relay = document.getElementById('bc-restream-chat-relay').checked;
    const quality_preset = document.getElementById('bc-restream-quality').value;

    // Auto-detect Kick chatroom ID for chat relay (Kick API is Cloudflare-blocked from servers)
    if (chat_relay && channel_url) {
        channel_url = await _resolveKickChatroomId(channel_url);
    }

    // Custom encoding overrides (empty string → null to clear)
    const custom_video_bitrate = document.getElementById('bc-restream-custom-vbr').value.trim() || null;
    const custom_audio_bitrate = document.getElementById('bc-restream-custom-abr').value.trim() || null;
    const custom_fps = document.getElementById('bc-restream-custom-fps').value.trim() || null;
    const custom_encoder_preset = document.getElementById('bc-restream-custom-encoder').value || null;

    if (!stream_key && !_restreamEditingId) {
        toast('Stream key is required', 'error');
        return;
    }

    try {
        const customFields = { custom_video_bitrate, custom_audio_bitrate, custom_fps, custom_encoder_preset };

        if (_restreamEditingId) {
            // Update existing
            const body = { name, server_url, auto_start, channel_url, chat_relay, quality_preset, ...customFields };
            if (stream_key && !stream_key.startsWith('****')) body.stream_key = stream_key;
            await api(`/restream/destinations/${_restreamEditingId}`, { method: 'PUT', body });
            toast('Destination updated', 'success');
        } else {
            // Create new
            await api('/restream/destinations', {
                method: 'POST',
                body: { platform, name, server_url, stream_key, auto_start, channel_url, chat_relay, quality_preset, ...customFields },
            });
            toast('Destination added', 'success');
        }
        cancelAddRestreamDestination();
        await loadRestreamDestinations();
        updateRestreamControlPanel();
    } catch (err) {
        toast(err.message || 'Failed to save destination', 'error');
    }
}

/** Edit an existing destination */
function editRestreamDestination(destId) {
    const dest = _restreamDestinations.find(d => d.id === destId);
    if (!dest) return;

    _restreamEditingId = destId;
    document.getElementById('bc-restream-add-form').style.display = '';
    document.getElementById('bc-restream-add-btn-row').style.display = 'none';

    // Can't change platform on edit
    const platformSelect = document.getElementById('bc-restream-platform');
    platformSelect.value = dest.platform;
    platformSelect.disabled = true;

    document.getElementById('bc-restream-name').value = dest.name || '';
    document.getElementById('bc-restream-url').value = dest.server_url || '';
    document.getElementById('bc-restream-key').value = ''; // Don't show key, let user replace
    document.getElementById('bc-restream-key').placeholder = dest.has_key ? 'Leave empty to keep existing key' : 'Paste your stream key';
    document.getElementById('bc-restream-autostart').checked = !!dest.auto_start;
    document.getElementById('bc-restream-channel-url').value = dest.channel_url || '';
    document.getElementById('bc-restream-chat-relay').checked = !!dest.chat_relay;
    document.getElementById('bc-restream-quality').value = dest.quality_preset || 'auto';

    // Populate custom override fields
    document.getElementById('bc-restream-custom-vbr').value = dest.custom_video_bitrate || '';
    document.getElementById('bc-restream-custom-abr').value = dest.custom_audio_bitrate || '';
    document.getElementById('bc-restream-custom-fps').value = dest.custom_fps || '';
    document.getElementById('bc-restream-custom-encoder').value = dest.custom_encoder_preset || '';

    // Auto-expand advanced section if any custom overrides are set
    const hasCustom = dest.custom_video_bitrate || dest.custom_audio_bitrate || dest.custom_fps || dest.custom_encoder_preset;
    document.getElementById('bc-restream-advanced').style.display = hasCustom ? '' : 'none';

    onRestreamPlatformChange();

    // Re-enable platform on cancel
    const origCancel = cancelAddRestreamDestination;
    cancelAddRestreamDestination = function() {
        platformSelect.disabled = false;
        cancelAddRestreamDestination = origCancel;
        origCancel();
    };
}

/** Toggle enabled/disabled */
async function toggleRestreamDestination(destId) {
    const dest = _restreamDestinations.find(d => d.id === destId);
    if (!dest) return;
    try {
        await api(`/restream/destinations/${destId}`, {
            method: 'PUT', body: { enabled: !dest.enabled },
        });
        await loadRestreamDestinations();
        updateRestreamControlPanel();
        toast(`Destination ${dest.enabled ? 'disabled' : 'enabled'}`, 'info');
    } catch (err) {
        toast(err.message || 'Failed to update destination', 'error');
    }
}

/** Delete a destination */
async function deleteRestreamDestination(destId) {
    if (!confirm('Delete this restream destination?')) return;
    try {
        await api(`/restream/destinations/${destId}`, { method: 'DELETE' });
        await loadRestreamDestinations();
        updateRestreamControlPanel();
        toast('Destination deleted', 'info');
    } catch (err) {
        toast(err.message || 'Failed to delete destination', 'error');
    }
}

/** Start restream for a specific destination */
async function startRestreamDest(destId) {
    try {
        await api(`/restream/destinations/${destId}/start`, { method: 'POST', body: {} });
        toast('Restream starting…', 'info');
        // Poll status immediately
        await pollRestreamStatus();
    } catch (err) {
        toast(err.message || 'Failed to start restream', 'error');
    }
}

/** Stop restream for a specific destination */
async function stopRestreamDest(destId) {
    try {
        await api(`/restream/destinations/${destId}/stop`, { method: 'POST' });
        toast('Restream stopped', 'info');
        await pollRestreamStatus();
    } catch (err) {
        toast(err.message || 'Failed to stop restream', 'error');
    }
}

/**
 * Poll restream status from the server and update the control panel.
 * Called periodically while streaming.
 */
let _lastRestreamStatuses = {};
async function pollRestreamStatus() {
    try {
        const data = await api('/restream/status');
        _lastRestreamStatuses = data.statuses || {};
        updateRestreamControlPanel();
    } catch {
        // Silent — polling failure is non-critical
    }
}

/** Start polling restream status (called when going live) */
function startRestreamStatusPolling() {
    stopRestreamStatusPolling();
    pollRestreamStatus();
    _restreamStatusPollInterval = setInterval(pollRestreamStatus, 5000);
}

/** Stop polling */
function stopRestreamStatusPolling() {
    if (_restreamStatusPollInterval) {
        clearInterval(_restreamStatusPollInterval);
        _restreamStatusPollInterval = null;
    }
}

/**
 * Update the restream control panel in the live controls section.
 * Shows all RTMP destinations + RS status as a unified bar.
 */
function updateRestreamControlPanel() {
    const panel = document.getElementById('bc-restream-control');
    if (!panel) return;

    const enabledDests = _restreamDestinations.filter(d => d.enabled);
    const hasRs = canUseRobotStreamerRestream();

    if (enabledDests.length === 0 && !hasRs) {
        panel.style.display = 'none';
        return;
    }

    // Flatten all stream statuses into a destId → status map
    const statusMap = {};
    for (const streamStatuses of Object.values(_lastRestreamStatuses)) {
        for (const s of (streamStatuses || [])) {
            statusMap[s.destId] = s;
        }
    }

    let html = '';

    // RTMP destinations
    for (const dest of enabledDests) {
        const meta = RESTREAM_PLATFORM_META[dest.platform] || RESTREAM_PLATFORM_META.custom;
        const status = statusMap[dest.id];
        const statusLabel = status?.status || 'idle';

        let badgeClass = 'bc-restream-status-idle';
        let badgeIcon = 'fa-solid fa-circle';
        let badgeText = 'Idle';

        if (statusLabel === 'live') {
            badgeClass = 'bc-restream-status-live';
            badgeText = 'Live';
        } else if (statusLabel === 'starting') {
            badgeClass = 'bc-restream-status-starting';
            badgeIcon = 'fa-solid fa-spinner fa-spin';
            badgeText = 'Starting…';
        } else if (statusLabel === 'error') {
            badgeClass = 'bc-restream-status-error';
            badgeIcon = 'fa-solid fa-circle-exclamation';
            badgeText = 'Error';
        } else if (statusLabel === 'failed') {
            badgeClass = 'bc-restream-status-failed';
            badgeIcon = 'fa-solid fa-circle-xmark';
            badgeText = 'Failed';
        }

        const isActive = statusLabel === 'live' || statusLabel === 'starting';

        html += `<div class="bc-restream-row">
            <span class="bc-restream-platform-icon" style="color:${meta.color}"><i class="${meta.icon}"></i></span>
            <span class="bc-restream-name">${dest.name || meta.name}</span>
            <span class="bc-restream-status-badge ${badgeClass}"><i class="${badgeIcon}"></i> ${badgeText}</span>
            <div class="bc-restream-actions">
                ${isActive
                    ? `<button class="bc-ctrl-btn-sm" onclick="stopRestreamDest(${dest.id})"><i class="fa-solid fa-stop"></i> Stop</button>`
                    : `<button class="bc-ctrl-btn-sm" onclick="startRestreamDest(${dest.id})"><i class="fa-solid fa-play"></i> Start</button>`
                }
            </div>
        </div>`;
    }

    // RS status row (if configured)
    if (hasRs) {
        const slotId = getRsRestreamSlotStreamId();
        const slotSs = slotId ? getStreamState(slotId) : null;
        const isRsLive = !!(slotSs?.robotStreamer?.active);
        const isRsStarting = !!(slotSs?._rsRestreamStarting);

        let rsBadgeClass = 'bc-restream-status-idle';
        let rsBadgeIcon = 'fa-solid fa-circle';
        let rsBadgeText = 'Idle';

        if (isRsLive) {
            rsBadgeClass = 'bc-restream-status-live';
            rsBadgeText = 'Live';
        } else if (isRsStarting || slotSs?._rsReconnectTimer) {
            rsBadgeClass = 'bc-restream-status-starting';
            rsBadgeIcon = 'fa-solid fa-spinner fa-spin';
            rsBadgeText = isRsStarting ? 'Starting…' : 'Reconnecting…';
        }

        html += `<div class="bc-restream-row">
            <span class="bc-restream-platform-icon" style="color:#4a9eff"><i class="fa-solid fa-robot"></i></span>
            <span class="bc-restream-name">RobotStreamer</span>
            <span class="bc-restream-status-badge ${rsBadgeClass}"><i class="${rsBadgeIcon}"></i> ${rsBadgeText}</span>
            <div class="bc-restream-actions">
                ${isRsLive
                    ? `<button class="bc-ctrl-btn-sm" onclick="stopRsRestream()"><i class="fa-solid fa-stop"></i> Stop</button>`
                    : `<button class="bc-ctrl-btn-sm" onclick="startOrRetryRsRestream()"><i class="fa-solid fa-play"></i> Start</button>`
                }
            </div>
        </div>`;
    }

    panel.innerHTML = html;
    panel.style.display = html ? '' : 'none';
}

/* ── RobotStreamer Restream ─────────────────────────────────── */

let _robotStreamerMediasoupModulePromise = null;
let _robotStreamerIntegrationPromise = null;
const RS_RECONNECT_BASE_DELAY = 3000;
const RS_RECONNECT_MAX_DELAY = 60000;
const RS_STABLE_CONNECTION_MS = 30000; // connection must survive 30s to reset backoff
const RS_MAX_SHORT_LIVED_RETRIES = 15;  // give up after this many consecutive short-lived sessions

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

function buildRobotStreamerDeviceDescriptor(device /*, stream — no longer needed */) {
    // Construct a descriptor matching what the RS SFU expects from the
    // official robotstreamer.com web client (HAR protocol analysis).
    // The RS client serializes the mediasoup Device class which exposes
    // underscore-prefixed internal properties. We replicate this structure
    // using the Device's public API for compatibility.
    return {
        _handlerName: device.handlerName,
        _loaded: device.loaded,
        _canProduceByKind: {
            audio: device.canProduce('audio'),
            video: device.canProduce('video'),
        },
        _sctpCapabilities: device.sctpCapabilities || { numStreams: { OS: 1024, MIS: 1024 } },
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
        // Clear cache on rejection so the next call retries instead of being
        // permanently broken by a transient network error or CSP violation.
        _robotStreamerMediasoupModulePromise.catch(() => {
            _robotStreamerMediasoupModulePromise = null;
        });
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
            device: buildRobotStreamerDeviceDescriptor(device),
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
        let _rsDisconnectTimer = null;
        transport.on('connectionstatechange', (state) => {
            console.log('[RS Restream] Transport state:', state);
            // Clear any pending disconnect timer on any state change
            if (_rsDisconnectTimer) { clearTimeout(_rsDisconnectTimer); _rsDisconnectTimer = null; }
            if (state === 'connected') {
                setRobotStreamerStatus('RobotStreamer restream is live.', 'success', 'bc-rsLiveStatus');
            } else if (state === 'connecting') {
                setRobotStreamerStatus('RobotStreamer restream is connecting…', 'info', 'bc-rsLiveStatus');
            } else if (state === 'disconnected') {
                // ICE disconnected — may recover on its own, but if it stays
                // disconnected for 15s, treat it as a failure and reconnect.
                setRobotStreamerStatus('RobotStreamer restream disconnected — waiting for recovery…', 'warning', 'bc-rsLiveStatus');
                _rsDisconnectTimer = setTimeout(() => {
                    _rsDisconnectTimer = null;
                    if (ss.robotStreamer === session && session.active) {
                        console.warn('[RS Restream] Transport stuck in disconnected state for 15s — reconnecting');
                        setRobotStreamerStatus('RobotStreamer restream timed out — will retry.', 'error', 'bc-rsLiveStatus');
                        scheduleRobotStreamerReconnect(streamId);
                    }
                }, 15000);
            } else if (state === 'failed' || state === 'closed') {
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
            reconnectTimer: null,
            intentionalClose: false,
            connectedAt: Date.now(),
        };
        ss.robotStreamer = session;

        // Start a stability timer — if connection survives RS_STABLE_CONNECTION_MS,
        // reset the backoff delay and consecutive failure counter.
        ss._rsStabilityTimer = setTimeout(() => {
            ss._rsStabilityTimer = null;
            if (ss.robotStreamer === session && session.active) {
                console.log('[RS Restream] Connection stable for', RS_STABLE_CONNECTION_MS / 1000, 's — resetting backoff');
                ss._rsReconnectDelay = RS_RECONNECT_BASE_DELAY;
                ss._rsConsecutiveShortLived = 0;
            }
        }, RS_STABLE_CONNECTION_MS);

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
            // stopTracks: false — the broadcast owns these tracks, not the RS producer.
            // Without this, Producer.close() calls track.stop() on the ORIGINAL broadcast
            // tracks, killing the stream when RS reconnects.
            session.videoProducer = await transport.produce({ track: videoTrack, stopTracks: false });
            console.log('[RS Restream] Video producer ID:', session.videoProducer.id);
        }
        if (audioTrack) {
            session.audioProducer = await transport.produce({ track: audioTrack, stopTracks: false });
            console.log('[RS Restream] Audio producer ID:', session.audioProducer.id);
        }

        // Monitor producer track-ended events — on Steam Deck / PipeWire, these
        // fire spuriously during normal Gamescope compositing. Do NOT trigger an
        // independent RS reconnect — the frame watchdog in startTrackKeepalive()
        // will detect if the stream is truly dead and trigger media recovery,
        // which will restart the RS restream as part of its flow.
        const onProducerTrackEnded = (kind) => {
            if (ss.robotStreamer !== session || !session.active) return;
            // If media recovery is already in progress, it will restart RS when done
            if (ss.mediaRecoveryInProgress || ss.mediaRecoveryTimer) {
                console.log(`[RS Restream] ${kind} producer trackended — media recovery active, will restart after`);
                return;
            }
            // Log but do NOT reconnect — let the watchdog decide
            console.log(`[RS Restream] ${kind} producer trackended — deferring to frame watchdog`);
        };
        if (session.videoProducer) {
            session.videoProducer.on('trackended', () => onProducerTrackEnded('video'));
        }
        if (session.audioProducer) {
            session.audioProducer.on('trackended', () => onProducerTrackEnded('audio'));
        }

        ws.addEventListener('close', (ev) => {
            if (ss.robotStreamer === session) {
                const sessionAge = Date.now() - (session.connectedAt || 0);
                session.active = false;
                if (!session.intentionalClose) {
                    console.warn(`[RS Restream] WebSocket closed unexpectedly — code: ${ev.code}, reason: ${ev.reason || '(none)'}, session age: ${sessionAge}ms`);
                    const detail = ev.reason ? ` — ${ev.reason}` : '';
                    setRobotStreamerStatus(`RobotStreamer restream disconnected${detail} — reconnecting…`, 'warning', 'bc-rsLiveStatus');
                    scheduleRobotStreamerReconnect(streamId);
                } else {
                    console.log(`[RS Restream] WebSocket closed intentionally — code: ${ev.code}, session age: ${sessionAge}ms`);
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

    // Track short-lived sessions (connection lasted < RS_STABLE_CONNECTION_MS)
    const session = ss.robotStreamer;
    if (session?.connectedAt) {
        const sessionAge = Date.now() - session.connectedAt;
        if (sessionAge < RS_STABLE_CONNECTION_MS) {
            ss._rsConsecutiveShortLived = (ss._rsConsecutiveShortLived || 0) + 1;
        }
    }

    // Cancel stability timer since connection is being torn down
    if (ss._rsStabilityTimer) { clearTimeout(ss._rsStabilityTimer); ss._rsStabilityTimer = null; }

    // Give up after too many consecutive short-lived sessions
    if ((ss._rsConsecutiveShortLived || 0) >= RS_MAX_SHORT_LIVED_RETRIES) {
        console.warn(`[RS Restream] Giving up after ${ss._rsConsecutiveShortLived} consecutive short-lived sessions`);
        setRobotStreamerStatus(
            `RobotStreamer restream failed after ${ss._rsConsecutiveShortLived} attempts — click Retry to try again.`,
            'error', 'bc-rsLiveStatus'
        );
        ss._rsReconnectDelay = RS_RECONNECT_BASE_DELAY; // reset for manual retry
        return;
    }

    // Use stream-state-level delay so it persists across sessions
    const delay = ss._rsReconnectDelay || RS_RECONNECT_BASE_DELAY;
    const nextDelay = Math.min(delay * 1.5, RS_RECONNECT_MAX_DELAY);
    ss._rsReconnectDelay = nextDelay;

    console.log(`[RS Restream] Scheduling reconnect in ${delay}ms (attempt ${ss._rsConsecutiveShortLived || 0}/${RS_MAX_SHORT_LIVED_RETRIES}, next delay: ${nextDelay}ms)`);

    // Dedup: clear any previously scheduled reconnect for this stream
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
        await startRobotStreamerRestream(streamId);
    }, delay);

    // Store timer on BOTH stream state and session for reliable dedup
    ss._rsReconnectTimer = timer;
    if (session) {
        session.reconnectTimer = timer;
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
    // Cancel stability timer
    if (ss._rsStabilityTimer) { clearTimeout(ss._rsStabilityTimer); ss._rsStabilityTimer = null; }
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
        // Clear stale SFU produce state — the server's SFU room is fresh after reconnect,
        // so any old producers are invalid and would cause "already-producing" false positives.
        if (_sfuProduceStates.has(streamId)) {
            console.log('[SFU Produce] Clearing stale produce state on signaling reconnect for stream', streamId);
            _cleanupSfuProduce(streamId);
        }
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

        // If server reconnect is disabled, clean up the stream on signaling disconnect
        if (broadcastState.settings.serverReconnect === false) {
            console.log(`[Broadcast] Server reconnect disabled — stopping stream ${streamId}`);
            toast('Server disconnected — stream stopped (auto-reconnect is off)', 'warning');
            cleanupStream(streamId);
            if (!isStreaming()) {
                hideBroadcastTabs(); clearGlobalDisplayTimers();
                setNavLiveIndicator(false); showStreamManager(); loadExistingStreams();
            }
            return;
        }

        if (broadcastState.streams.has(streamId) && ss.streamData) {
            const delay = ss.signalingReconnectDelay;
            ss.signalingReconnectDelay = Math.min(ss.signalingReconnectDelay * 1.5, 30000);
            console.log(`[Broadcast] Reconnecting signaling for stream ${streamId} in ${Math.round(delay)}ms`);
            if (broadcastState.activeStreamId === streamId) {
                toast('Server disconnected — reconnecting...', 'warning');
            }
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
    // Use server-provided ICE servers (with TURN support) if available
    const iceServers = (ss._serverIceServers && ss._serverIceServers.length > 0)
        ? ss._serverIceServers
        : [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
    const pc = new RTCPeerConnection({ iceServers });
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

/* ── SFU Produce for Server-Side Restreaming ─────────────────── */
// When the server needs WebRTC → RTMP restreaming, it asks the broadcaster
// to produce tracks into the Mediasoup SFU via the signaling WebSocket.
// This is similar to the RS restream flow but targets our own SFU.

/** Per-stream SFU produce state */
const _sfuProduceStates = new Map();

/** Pending SFU message resolvers, keyed by streamId */
const _sfuPendingMessages = new Map();

function _resolveSfuMessage(streamId, msg) {
    const pending = _sfuPendingMessages.get(streamId);
    if (!pending?.length) return;
    // Find the first pending handler that matches this message type
    const idx = pending.findIndex(p => p.type === msg.type);
    if (idx >= 0) {
        const handler = pending.splice(idx, 1)[0];
        if (msg.type === 'sfu-error') handler.reject(new Error(msg.error || 'SFU error'));
        else handler.resolve(msg);
    }
}

function _waitForSfuMessage(streamId, type, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        if (!_sfuPendingMessages.has(streamId)) _sfuPendingMessages.set(streamId, []);
        const pending = _sfuPendingMessages.get(streamId);
        const timer = setTimeout(() => {
            const idx = pending.findIndex(p => p.id === id);
            if (idx >= 0) pending.splice(idx, 1);
            reject(new Error(`SFU message timeout: ${type}`));
        }, timeoutMs);
        const id = Math.random();
        // Also listen for sfu-error as a rejection for any pending request
        pending.push({ id, type, resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject: (err) => { clearTimeout(timer); reject(err); } });
        pending.push({ id: id + 0.1, type: 'sfu-error', resolve: () => {}, reject: (err) => {
            clearTimeout(timer);
            const idx2 = pending.findIndex(p => p.id === id);
            if (idx2 >= 0) { pending.splice(idx2, 1); }
            reject(err);
        }});
    });
}

async function _handleSfuProduceRequest(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream || !ss?.signalingWs) {
        console.warn('[SFU Produce] No local stream or signaling — cannot produce');
        sendBroadcastSignal(ss, { type: 'sfu-produce-status', status: 'skipped', detail: !ss?.localStream ? 'no-localStream' : 'no-signalingWs' });
        return;
    }

    // Already producing?
    if (_sfuProduceStates.has(streamId)) {
        console.log('[SFU Produce] Already producing for stream', streamId);
        sendBroadcastSignal(ss, { type: 'sfu-produce-status', status: 'already-producing' });
        return;
    }

    console.log('[SFU Produce] Starting SFU produce for stream', streamId);
    const state = { active: true, transport: null, videoProducer: null, audioProducer: null };
    _sfuProduceStates.set(streamId, state);

    try {
        // Step 1: Load mediasoup-client (reuse the same loader as RS restream)
        const mod = await loadRobotStreamerMediasoup();
        const Device = mod.Device || mod.default?.Device;
        if (!Device) throw new Error('mediasoup-client failed to load');

        // Step 2: Get router capabilities from our SFU
        if (!sendBroadcastSignal(ss, { type: 'sfu-get-capabilities' })) {
            throw new Error('signaling WS not open — cannot send sfu-get-capabilities');
        }
        const capsMsg = await _waitForSfuMessage(streamId, 'sfu-capabilities');

        const device = new Device();
        await device.load({ routerRtpCapabilities: capsMsg.rtpCapabilities });

        // Step 3: Create send transport
        sendBroadcastSignal(ss, { type: 'sfu-create-transport' });
        const transportMsg = await _waitForSfuMessage(streamId, 'sfu-transport-created');

        const transport = device.createSendTransport({
            id: transportMsg.id,
            iceParameters: transportMsg.iceParameters,
            iceCandidates: transportMsg.iceCandidates,
            dtlsParameters: transportMsg.dtlsParameters,
        });
        state.transport = transport;

        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            sendBroadcastSignal(ss, {
                type: 'sfu-connect-transport',
                transportId: transport.id,
                dtlsParameters,
            });
            _waitForSfuMessage(streamId, 'sfu-transport-connected')
                .then(() => callback())
                .catch(errback);
        });

        transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
            sendBroadcastSignal(ss, {
                type: 'sfu-produce',
                transportId: transport.id,
                kind,
                rtpParameters,
            });
            _waitForSfuMessage(streamId, 'sfu-produced')
                .then((msg) => callback({ id: msg.id }))
                .catch(errback);
        });

        transport.on('connectionstatechange', (connState) => {
            console.log('[SFU Produce] Transport state:', connState);
            if (connState === 'failed' || connState === 'closed') {
                _cleanupSfuProduce(streamId);
            }
        });

        // Step 4: Produce video + audio tracks
        const videoTrack = ss.localStream.getVideoTracks()[0];
        const audioTrack = ss.localStream.getAudioTracks()[0];

        if (videoTrack) {
            state.videoProducer = await transport.produce({ track: videoTrack, stopTracks: false });
            console.log('[SFU Produce] Video producer:', state.videoProducer.id);
        }
        if (audioTrack) {
            state.audioProducer = await transport.produce({ track: audioTrack, stopTracks: false });
            console.log('[SFU Produce] Audio producer:', state.audioProducer.id);
        }

        console.log('[SFU Produce] Producing into local SFU for stream', streamId);
        sendBroadcastSignal(ss, { type: 'sfu-produce-status', status: 'ok', detail: `video=${!!state.videoProducer} audio=${!!state.audioProducer}` });
    } catch (err) {
        console.error('[SFU Produce] Failed:', err.message);
        sendBroadcastSignal(ss, { type: 'sfu-produce-status', status: 'error', error: err.message });
        _cleanupSfuProduce(streamId);
    }
}

function _cleanupSfuProduce(streamId) {
    const state = _sfuProduceStates.get(streamId);
    if (!state) return;

    state.active = false;
    if (state.videoProducer) { try { state.videoProducer.close(); } catch {} }
    if (state.audioProducer) { try { state.audioProducer.close(); } catch {} }
    if (state.transport) { try { state.transport.close(); } catch {} }
    _sfuProduceStates.delete(streamId);
    _sfuPendingMessages.delete(streamId);

    // Notify server we stopped producing
    const ss = getStreamState(streamId);
    if (ss) sendBroadcastSignal(ss, { type: 'sfu-stop-produce' });

    console.log('[SFU Produce] Cleaned up for stream', streamId);
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
        case 'viewer-count':
            _perStreamViewerCounts.set(streamId, msg.count || 0);
            _updateTabViewerCount(streamId, msg.count || 0);
            _updateTotalViewerCount();
            break;
        case 'welcome':
            console.log(`[Broadcast] Stream ${streamId} welcome:`, msg);
            // Store server-provided ICE servers (includes TURN if configured)
            if (msg.iceServers && Array.isArray(msg.iceServers)) {
                ss._serverIceServers = msg.iceServers;
            }
            break;
        case 'error': toast(msg.message || 'Broadcast error', 'error'); break;

        // ── SFU Produce (for server-side WebRTC → RTMP restreaming) ──
        case 'sfu-produce-request':
            // Server is asking us to produce our tracks into the Mediasoup SFU
            // so the restream manager can consume them via PlainRtpTransport
            _handleSfuProduceRequest(streamId).catch(err => {
                console.warn('[SFU Produce] Failed:', err.message);
            });
            break;
        case 'sfu-capabilities':
        case 'sfu-transport-created':
        case 'sfu-transport-connected':
        case 'sfu-produced':
        case 'sfu-error':
            // These are handled by the SFU produce flow's promise-based handlers
            _resolveSfuMessage(streamId, msg);
            break;
    }
}

/* ── UI Updates ──────────────────────────────────────────────── */

/** Per-stream viewer counts from signaling, keyed by streamId */
const _perStreamViewerCounts = new Map();
let _rsViewerCount = 0;
let _rsViewerPollTimer = null;
/** Platform viewer counts (Twitch, Kick, etc.) fetched from server */
let _platformViewerCount = 0;
let _platformViewerBreakdown = [];

function updateBroadcastStatus(state) {
    const el = document.getElementById('bc-connection-status'); if (!el) return;
    // Determine streaming method label from active stream
    const ss = getActiveStreamState();
    const proto = (ss?.streamData?.protocol || 'webrtc').toUpperCase();
    const map = {
        connected:    { text: proto,            cls: 'bc-status-good' },
        checking:     { text: 'Connecting…',    cls: 'bc-status-warn' },
        completed:    { text: proto,            cls: 'bc-status-good' },
        disconnected: { text: 'Disconnected',   cls: 'bc-status-bad'  },
        failed:       { text: 'Failed',          cls: 'bc-status-bad'  },
        error:        { text: 'Error',           cls: 'bc-status-bad'  },
        new:          { text: 'Starting…',       cls: 'bc-status-warn' },
    };
    const s = map[state] || { text: state, cls: '' };
    el.textContent = s.text; el.className = 'bc-connection-status ' + s.cls;
}

function _updateTabViewerCount(streamId, count) {
    const badge = document.querySelector(`.bc-tab-viewers[data-stream-id="${streamId}"]`);
    if (badge) badge.innerHTML = `<i class="fa-solid fa-eye"></i> ${count}`;
}

function _updateTotalViewerCount() {
    let hsTotal = 0;
    for (const [, c] of _perStreamViewerCounts) hsTotal += c;
    const total = hsTotal + _rsViewerCount + _platformViewerCount;
    const el = document.getElementById('bc-viewer-count');
    if (el) el.textContent = total;
    // RS viewer count badge (show breakdown when RS viewers exist)
    const rsEl = document.getElementById('bc-rs-viewer-count');
    if (rsEl) {
        if (_rsViewerCount > 0) { rsEl.style.display = ''; rsEl.querySelector('strong').textContent = _rsViewerCount; }
        else rsEl.style.display = 'none';
    }
    // Platform viewer count badges (Twitch/Kick/YouTube)
    _updatePlatformViewerBadges();
}

/** Render platform viewer count badges (Twitch/Kick/YouTube) in the broadcaster info bar */
function _updatePlatformViewerBadges() {
    const container = document.getElementById('bc-platform-viewer-badges');
    if (!container) return;
    if (!_platformViewerBreakdown || _platformViewerBreakdown.length === 0) {
        container.innerHTML = '';
        return;
    }
    const platformIcons = { twitch: 'fa-brands fa-twitch', kick: 'fa-brands fa-kickstarter-k', youtube: 'fa-brands fa-youtube', custom: 'fa-solid fa-globe' };
    const platformColors = { twitch: '#9146ff', kick: '#53fc18', youtube: '#ff0000', custom: '#888' };
    let html = '';
    for (const entry of _platformViewerBreakdown) {
        const icon = platformIcons[entry.platform] || platformIcons.custom;
        const color = platformColors[entry.platform] || platformColors.custom;
        const name = entry.name || entry.platform;
        html += `<div class="bc-info-item" style="color:${color}"><i class="${icon}"></i> <strong>${entry.count}</strong> on ${name}</div>`;
    }
    container.innerHTML = html;
}

async function _startRsViewerPoll() {
    _stopRsViewerPoll();
    // Wait for RS integration to load before checking enabled/robotId
    if (_robotStreamerIntegrationPromise) {
        try { await _robotStreamerIntegrationPromise; } catch {}
    }
    const rs = broadcastState.robotStreamer;
    if (!rs?.enabled || !rs?.robotId) return;
    const poll = async () => {
        try {
            const data = await api('/robotstreamer/integration/validate', { method: 'POST', body: { robot_input: rs.robotId } });
            const robots = data.integration?.available_robots || [];
            const robot = robots.find(r => String(r.robot_id) === String(rs.robotId));
            _rsViewerCount = robot ? Number(robot.viewers || 0) : 0;
        } catch { _rsViewerCount = 0; }
        _updateTotalViewerCount();
    };
    poll();
    _rsViewerPollTimer = setInterval(poll, 60000);
}

function _stopRsViewerPoll() {
    if (_rsViewerPollTimer) { clearInterval(_rsViewerPollTimer); _rsViewerPollTimer = null; }
    _rsViewerCount = 0;
}

/* ── Restream Platform Viewer Count Polling ───────────────────── */
// Server polls Kick/Twitch APIs directly (official API with OAuth tokens).
// Client only fetches the aggregated counts from our server.
let _restreamViewerPollTimer = null;

function _startRestreamViewerPoll() {
    _stopRestreamViewerPoll();
    // Poll every 60s, with initial 10s delay
    setTimeout(async () => {
        await _pollRestreamViewerCounts();
        _restreamViewerPollTimer = setInterval(_pollRestreamViewerCounts, 60000);
    }, 10000);
}

function _stopRestreamViewerPoll() {
    if (_restreamViewerPollTimer) { clearInterval(_restreamViewerPollTimer); _restreamViewerPollTimer = null; }
    _platformViewerCount = 0;
    _platformViewerBreakdown = [];
}

async function _pollRestreamViewerCounts() {
    if (!_restreamDestinations || _restreamDestinations.length === 0) return;

    // Fetch all platform viewer counts from server (Kick + Twitch + others)
    try {
        const data = await api('/restream/viewer-counts');
        _platformViewerCount = data?.total || 0;
        _platformViewerBreakdown = data?.breakdown || [];
    } catch {
        _platformViewerCount = 0;
        _platformViewerBreakdown = [];
    }
    _updateTotalViewerCount();
}

/* ── Broadcaster Controls ─────────────────────────────────────── */

/** Toggle broadcast page mobile chat bottom sheet */
let _bcMobileChatOpen = false;
function toggleBroadcastMobileChat() {
    const sidebar = document.getElementById('bc-chat-sidebar');
    const fab = document.getElementById('bc-mobile-chat-toggle');
    if (!sidebar) return;
    _bcMobileChatOpen = !_bcMobileChatOpen;
    sidebar.classList.toggle('mobile-chat-open', _bcMobileChatOpen);
    document.body.classList.toggle('mobile-chat-visible', _bcMobileChatOpen);
    if (fab) {
        const icon = fab.querySelector('i');
        if (icon) icon.className = _bcMobileChatOpen ? 'fa-solid fa-xmark' : 'fa-solid fa-comment';
    }
    if (_bcMobileChatOpen) {
        const msgs = document.getElementById('bc-chat-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
        const badge = document.getElementById('bc-mobile-chat-badge');
        if (badge) { badge.style.display = 'none'; badge.textContent = '0'; }
    }
}
/** Show/hide the broadcast mobile chat FAB based on screen size and live state */
function updateBroadcastMobileChatFab() {
    const fab = document.getElementById('bc-mobile-chat-toggle');
    if (!fab) return;
    const isLive = broadcastState.streams.size > 0;
    const isMobile = window.innerWidth <= 768;
    const isStacked = window.innerWidth <= 1100;
    // In stacked layout (<=1100px) chat is visible inline, no FAB needed
    fab.style.display = (isLive && isMobile && !isStacked) ? 'flex' : 'none';
}

/** Detect if the broadcast preview video is vertical and toggle a class on the container */
function _detectBroadcastVerticalPreview(stream) {
    const container = document.querySelector('.bc-video-container');
    if (!container || !stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;
    const settings = videoTrack.getSettings();
    if (settings.width && settings.height) {
        container.classList.toggle('bc-vertical-preview', settings.height > settings.width);
    }
}

/** Re-detect vertical preview for the currently active stream */
function _refreshVerticalPreview() {
    try {
        const ss = getActiveStreamState();
        if (ss?.localStream) _detectBroadcastVerticalPreview(ss.localStream);
    } catch { /* ignore if no active stream */ }
}

/* ── Orientation & Resize Listeners for Camera Rotation ──── */
(function _initOrientationHandlers() {
    // Listen for device orientation changes (mobile rotation)
    if ('orientation' in screen) {
        try {
            screen.orientation.addEventListener('change', () => {
                _refreshVerticalPreview();
                updateBroadcastMobileChatFab();
            });
        } catch { /* orientation API not supported */ }
    }
    // Fallback: legacy orientationchange event
    window.addEventListener('orientationchange', () => {
        // Delay slightly — track dimensions may take a moment to update
        setTimeout(() => {
            _refreshVerticalPreview();
            updateBroadcastMobileChatFab();
        }, 300);
    });
    // Also re-check on window resize
    let _resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
            _refreshVerticalPreview();
            updateBroadcastMobileChatFab();
        }, 200);
    });
})();

function closeCameraSwitcher() {
    const sheet = document.getElementById('bc-camera-sheet');
    if (sheet) sheet.style.display = 'none';
}

function _renderCameraSwitcherChoices(devices, activeCameraId) {
    const list = document.getElementById('bc-camera-sheet-list');
    if (!list) return;
    list.innerHTML = '';

    const options = [{ deviceId: 'default', label: 'System Default Camera', _default: true }, ...devices];
    options.forEach((device, index) => {
        const current = (activeCameraId || 'default') === device.deviceId;
        const meta = device._default
            ? { icon: 'fa-solid fa-wand-magic-sparkles', title: 'Default Camera', detail: 'Let the browser choose the preferred camera for this device.' }
            : _describeCameraRole(device, index - 1);
        const titleText = device._default ? 'System Default Camera' : (device.label || meta.title);
        const subtitleText = device._default ? meta.detail : `${meta.title} • ${meta.detail}`;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `bc-camera-choice${current ? ' is-active' : ''}`;
        button.innerHTML = `
            <span class="bc-camera-choice-icon"><i class="${meta.icon}"></i></span>
            <span class="bc-camera-choice-body">
                <span class="bc-camera-choice-title">
                    <span>${titleText}</span>
                    ${current ? '<span class="bc-camera-choice-badge">Live</span>' : ''}
                </span>
                <span class="bc-camera-choice-subtitle">${subtitleText}</span>
            </span>
            <span class="bc-camera-choice-arrow"><i class="fa-solid fa-chevron-right"></i></span>
        `;
        button.addEventListener('click', () => chooseBroadcastCamera(device.deviceId, button));
        list.appendChild(button);
    });
}

async function openCameraSwitcher() {
    const sheet = document.getElementById('bc-camera-sheet');
    const list = document.getElementById('bc-camera-sheet-list');
    if (!sheet || !list) return;

    sheet.style.display = 'flex';
    list.innerHTML = '<div class="bc-camera-sheet-empty"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading cameras…</span></div>';

    try {
        const devices = await _enumerateBroadcastVideoInputs({ ensureLabels: true });
        if (!devices.length) {
            list.innerHTML = '<div class="bc-camera-sheet-empty"><i class="fa-solid fa-camera-slash"></i><span>No cameras detected.</span></div>';
            return;
        }
        const ss = getActiveStreamState();
        const activeTrack = ss?.localStream?.getVideoTracks?.()[0] || null;
        const activeCameraId = activeTrack?.getSettings?.().deviceId || _getPreferredCameraId();
        _renderCameraSwitcherChoices(devices, activeCameraId);
    } catch (err) {
        list.innerHTML = `<div class="bc-camera-sheet-empty"><i class="fa-solid fa-circle-exclamation"></i><span>${err.message || 'Could not load cameras.'}</span></div>`;
    }
}

async function _switchActiveCamera(cameraId) {
    const ss = getActiveStreamState();
    if (!ss || !ss.localStream) return;

    // Block live camera replacement during screen share — screen mode owns the video track.
    if (broadcastState.settings.screenShare) {
        toast('Camera selection saved. Turn off screen share to switch the live camera track.', 'info');
        return;
    }

    const videoTrack = ss.localStream.getVideoTracks()[0]; if (!videoTrack) return;
    const oldSettings = videoTrack.getSettings();
    const oldDeviceId = oldSettings.deviceId;
    if ((cameraId || 'default') === (oldDeviceId || 'default')) return;

    const devices = await _enumerateBroadcastVideoInputs({ ensureLabels: false });
    const chosenDevice = devices.find(d => d.deviceId === cameraId) || null;
    const facingHint = _getCameraFacingHint(chosenDevice) || oldSettings.facingMode || 'user';
    const trackWidth = oldSettings.width || 1280;
    const trackHeight = oldSettings.height || 720;
    const trackFrameRate = oldSettings.frameRate || getBroadcastFrameRate();

    const candidateConstraints = cameraId && cameraId !== 'default'
        ? [
            { video: { deviceId: { exact: cameraId }, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } },
            { video: { deviceId: cameraId, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } },
            { video: { deviceId: { ideal: cameraId }, facingMode: { ideal: facingHint }, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } },
        ]
        : [
            { video: { facingMode: { ideal: facingHint }, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } },
            { video: true },
        ];

    ss._suppressRecovery = true; // prevent track.ended from triggering recovery
    const suppressTimeout = setTimeout(() => { ss._suppressRecovery = false; }, 15000);
    videoTrack.stop();
    ss.localStream.removeTrack(videoTrack);

    try {
        let newStream = null;
        let lastError = null;
        for (const constraints of candidateConstraints) {
            try {
                newStream = await _getUserMediaWithTimeout(constraints);
                if (newStream?.getVideoTracks?.().length) break;
            } catch (err) {
                lastError = err;
            }
        }
        if (!newStream?.getVideoTracks?.().length) throw (lastError || new Error('Could not access the selected camera'));

        const newTrack = newStream.getVideoTracks()[0];
        ss.localStream.addTrack(newTrack);
        for (const [, pc] of ss.viewerConnections) {
            const sender = pc.getSenders().find(s => s.track === null || s.track?.kind === 'video');
            if (sender) sender.replaceTrack(newTrack);
        }
        syncRobotStreamerTracks(broadcastState.activeStreamId).catch(() => {});
        const preview = document.getElementById('bc-video-preview'); if (preview) preview.srcObject = ss.localStream;
        _detectBroadcastVerticalPreview(ss.localStream);
        clearTimeout(suppressTimeout);
        ss._suppressRecovery = false;
        attachLocalStreamRecoveryHandlers(broadcastState.activeStreamId);
        const appliedDeviceId = newTrack.getSettings?.().deviceId || cameraId || 'default';
        _syncCameraSelectionUI(appliedDeviceId);
        toast('Camera switched', 'success');
    } catch (err) {
        console.error('[Broadcast] switch camera failed:', err);
        try {
            const recovery = await _getUserMediaWithTimeout({ video: { deviceId: oldDeviceId ? { ideal: oldDeviceId } : undefined, facingMode: { ideal: oldSettings.facingMode || 'user' }, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } });
            const recoveryTrack = recovery.getVideoTracks()[0];
            ss.localStream.addTrack(recoveryTrack);
            for (const [, pc] of ss.viewerConnections) {
                const sender = pc.getSenders().find(s => s.track === null || s.track?.kind === 'video');
                if (sender) sender.replaceTrack(recoveryTrack);
            }
            syncRobotStreamerTracks(broadcastState.activeStreamId).catch(() => {});
            const preview = document.getElementById('bc-video-preview'); if (preview) preview.srcObject = ss.localStream;
            _detectBroadcastVerticalPreview(ss.localStream);
            _syncCameraSelectionUI(oldDeviceId || 'default');
        } catch { /* truly stuck — no video track */ }
        clearTimeout(suppressTimeout);
        ss._suppressRecovery = false;
        attachLocalStreamRecoveryHandlers(broadcastState.activeStreamId);
        throw err;
    }
}

async function chooseBroadcastCamera(cameraId, buttonEl = null) {
    const previousCameraId = _getPreferredCameraId();
    const buttons = Array.from(document.querySelectorAll('#bc-camera-sheet .bc-camera-choice'));
    buttons.forEach(btn => btn.classList.add('is-loading'));
    if (buttonEl) buttonEl.classList.add('is-active');
    _syncCameraSelectionUI(cameraId);
    try {
        const ss = getActiveStreamState();
        if (ss?.localStream) await _switchActiveCamera(cameraId);
        closeCameraSwitcher();
    } catch (err) {
        _syncCameraSelectionUI(previousCameraId);
        toast('Could not switch camera: ' + (err.message || 'Unknown error'), 'error');
    } finally {
        buttons.forEach(btn => btn.classList.remove('is-loading'));
    }
}

async function flipCamera() {
    await openCameraSwitcher();
}

async function toggleScreenShare() {
    broadcastState.settings.screenShare = !broadcastState.settings.screenShare; saveBroadcastSettings();
    _syncScreenShareUI();
    const ss = getActiveStreamState();
    const streamId = broadcastState.activeStreamId;
    if (ss && ss.localStream && streamId) {
        try {
            await uploadVodRecording(streamId, { finalizeStream: false });
            ss._suppressRecovery = true;
            // Stop old tracks and composite
            _cleanupComposite(ss);
            ss.localStream.getTracks().forEach(t => t.stop());
            await startMediaCapture(streamId);
            startVodRecording(streamId);
            _replaceAllViewerTracks(streamId);
            ss._suppressRecovery = false;
            toast(broadcastState.settings.screenShare ? 'Screen share on' : 'Camera on', 'success');
        } catch (err) {
            ss._suppressRecovery = false;
            toast('Failed to switch: ' + err.message, 'error');
            broadcastState.settings.screenShare = !broadcastState.settings.screenShare; saveBroadcastSettings();
            _syncScreenShareUI();
        }
    }
}

/** Toggle camera PiP overlay during screen share */
async function toggleCameraOverlay() {
    const ss = getActiveStreamState();
    const streamId = broadcastState.activeStreamId;
    if (!ss || !broadcastState.settings.screenShare) {
        toast('Camera overlay only works during screen share', 'info');
        return;
    }
    ss._cameraOverlayEnabled = !ss._cameraOverlayEnabled;
    const btn = document.getElementById('bc-btn-cam-overlay');
    if (btn) btn.classList.toggle('bc-ctrl-btn-active', ss._cameraOverlayEnabled);
    if (ss.localStream && streamId) {
        try {
            await uploadVodRecording(streamId, { finalizeStream: false });
            ss._suppressRecovery = true;
            _cleanupComposite(ss);
            ss.localStream.getTracks().forEach(t => t.stop());
            if (ss._screenStream) { ss._screenStream.getTracks().forEach(t => t.stop()); ss._screenStream = null; }
            await startMediaCapture(streamId);
            startVodRecording(streamId);
            _replaceAllViewerTracks(streamId);
            ss._suppressRecovery = false;
            toast(ss._cameraOverlayEnabled ? 'Camera overlay on' : 'Camera overlay off', 'success');
        } catch (err) {
            ss._suppressRecovery = false;
            ss._cameraOverlayEnabled = !ss._cameraOverlayEnabled;
            if (btn) btn.classList.toggle('bc-ctrl-btn-active', ss._cameraOverlayEnabled);
            toast('Failed to toggle camera overlay: ' + err.message, 'error');
        }
    }
}

/** Replace video+audio tracks on all viewer PeerConnections and SFU */
function _replaceAllViewerTracks(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.localStream) return;
    const nvt = ss.localStream.getVideoTracks()[0];
    const nat = ss.localStream.getAudioTracks()[0];
    for (const [, pc] of ss.viewerConnections) {
        const vs = pc.getSenders().find(s => s.track?.kind === 'video' || s.track === null);
        if (vs && nvt) vs.replaceTrack(nvt);
        const as = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (as && nat) as.replaceTrack(nat);
    }
    syncRobotStreamerTracks(streamId).catch(() => {});
}

/**
 * Start the PiP composite — draws screen + camera overlay onto a canvas.
 * Camera position is controlled by ss._pipX / _pipY / _pipW (fractions of canvas).
 */
function _startPipComposite(ss, screenStream, screenTrack, camStream, finalAudioTrack, res) {
    const canvas = document.createElement('canvas');
    canvas.width = res.w; canvas.height = res.h;
    const ctx = canvas.getContext('2d');
    ss._compositeCanvas = canvas;
    ss._compositeCtx = ctx;

    // Hidden video elements for drawing
    const screenVid = document.createElement('video');
    screenVid.srcObject = screenStream; screenVid.muted = true; screenVid.playsInline = true; screenVid.play().catch(() => {});

    const camVid = document.createElement('video');
    camVid.srcObject = camStream; camVid.muted = true; camVid.playsInline = true; camVid.play().catch(() => {});

    const fps = getBroadcastFrameRate();
    const interval = 1000 / fps;
    let lastDraw = 0;

    function draw(now) {
        ss._compositeAnimFrame = requestAnimationFrame(draw);
        if (now - lastDraw < interval) return;
        lastDraw = now;

        // Draw screen full-canvas
        ctx.drawImage(screenVid, 0, 0, canvas.width, canvas.height);

        // Draw camera PiP if video is ready
        if (camVid.readyState >= 2) {
            const pw = Math.round(canvas.width * ss._pipW);
            const aspectRatio = camVid.videoHeight / camVid.videoWidth || 0.75;
            const ph = Math.round(pw * aspectRatio);
            const px = Math.round(canvas.width * ss._pipX);
            const py = Math.round(canvas.height * ss._pipY);

            // Rounded rectangle clip (with fallback for older browsers)
            const radius = 12;
            ctx.save();
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(px, py, pw, ph, radius);
            } else {
                // Manual rounded rect fallback
                ctx.moveTo(px + radius, py);
                ctx.lineTo(px + pw - radius, py); ctx.arcTo(px + pw, py, px + pw, py + radius, radius);
                ctx.lineTo(px + pw, py + ph - radius); ctx.arcTo(px + pw, py + ph, px + pw - radius, py + ph, radius);
                ctx.lineTo(px + radius, py + ph); ctx.arcTo(px, py + ph, px, py + ph - radius, radius);
                ctx.lineTo(px, py + radius); ctx.arcTo(px, py, px + radius, py, radius);
            }
            ctx.clip();
            ctx.drawImage(camVid, px, py, pw, ph);
            ctx.restore();

            // Thin border
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(px, py, pw, ph, radius);
            } else {
                ctx.moveTo(px + radius, py);
                ctx.lineTo(px + pw - radius, py); ctx.arcTo(px + pw, py, px + pw, py + radius, radius);
                ctx.lineTo(px + pw, py + ph - radius); ctx.arcTo(px + pw, py + ph, px + pw - radius, py + ph, radius);
                ctx.lineTo(px + radius, py + ph); ctx.arcTo(px, py + ph, px, py + ph - radius, radius);
                ctx.lineTo(px, py + radius); ctx.arcTo(px, py, px + radius, py, radius);
            }
            ctx.stroke();
        }
    }
    ss._compositeAnimFrame = requestAnimationFrame(draw);

    // Capture composite as stream
    const compositeStream = canvas.captureStream(fps);
    if (finalAudioTrack) compositeStream.addTrack(finalAudioTrack);
    ss.localStream = compositeStream;
}

/** Sync screen share live controls (Mic toggle, Camera PiP button) for screen mode */
function _syncScreenShareLiveControls(ss) {
    const isScreen = broadcastState.settings.screenShare;
    const micBtn = document.getElementById('bc-btn-toggle-mic');
    const camBtn = document.getElementById('bc-btn-cam-overlay');

    // Show mic toggle only in screen share mode
    if (micBtn) {
        micBtn.style.display = isScreen ? '' : 'none';
        micBtn.classList.toggle('bc-ctrl-btn-active', !!(ss && ss._micEnabled));
        const icon = micBtn.querySelector('i');
        if (icon) {
            icon.className = (ss && ss._micEnabled) ? 'fas fa-microphone' : 'fas fa-microphone-slash';
        }
    }
    // Camera overlay button
    if (camBtn) {
        camBtn.style.display = isScreen ? '' : 'none';
        camBtn.classList.toggle('bc-ctrl-btn-active', !!(ss && ss._cameraOverlayEnabled));
    }
}

/** Toggle mic on/off during screen share */
async function toggleScreenShareMic() {
    const ss = getActiveStreamState();
    const streamId = broadcastState.activeStreamId;
    if (!ss || !broadcastState.settings.screenShare) return;

    if (ss._micEnabled) {
        // Turn mic OFF — disconnect mic from audio mix
        if (ss._micStream) {
            ss._micStream.getTracks().forEach(t => t.stop());
            ss._micStream = null;
        }
        // Rebuild audio without mic — just desktop audio
        if (ss._mixAudioContext) {
            try { ss._mixAudioContext.close(); } catch {}
            ss._mixAudioContext = null;
        }
        // Replace audio track with desktop-only audio
        if (ss._screenStream) {
            const desktopAudioTracks = ss._screenStream.getAudioTracks();
            if (desktopAudioTracks.length > 0 && ss.localStream) {
                const oldAudio = ss.localStream.getAudioTracks()[0];
                if (oldAudio) ss.localStream.removeTrack(oldAudio);
                ss.localStream.addTrack(desktopAudioTracks[0]);
                _replaceAllViewerTracks(streamId);
            }
        }
        ss._micEnabled = false;
        toast('Mic muted', 'info');
    } else {
        // Turn mic ON — get mic stream and mix with desktop audio
        const s = broadcastState.settings;
        const audioConstraints = buildAudioConstraints(s, s.forceAudio);
        let micStream;
        try {
            micStream = await _getUserMediaWithTimeout({ audio: audioConstraints, video: false });
        } catch (err) {
            toast('Could not access microphone: ' + err.message, 'error');
            return;
        }
        ss._micStream = micStream;

        // Mix desktop + mic via AudioContext
        const desktopAudioTracks = ss._screenStream ? ss._screenStream.getAudioTracks() : [];
        if (desktopAudioTracks.length > 0) {
            try {
                const mixCtx = new AudioContext();
                const dest = mixCtx.createMediaStreamDestination();
                mixCtx.createMediaStreamSource(new MediaStream(desktopAudioTracks)).connect(dest);
                mixCtx.createMediaStreamSource(micStream).connect(dest);
                const mixedTrack = dest.stream.getAudioTracks()[0];
                ss._mixAudioContext = mixCtx;

                if (ss.localStream) {
                    const oldAudio = ss.localStream.getAudioTracks()[0];
                    if (oldAudio) ss.localStream.removeTrack(oldAudio);
                    ss.localStream.addTrack(mixedTrack);
                    _replaceAllViewerTracks(streamId);
                }
            } catch {
                // Fallback: just use mic track
                if (ss.localStream) {
                    const oldAudio = ss.localStream.getAudioTracks()[0];
                    if (oldAudio) ss.localStream.removeTrack(oldAudio);
                    const micTrack = micStream.getAudioTracks()[0];
                    if (micTrack) ss.localStream.addTrack(micTrack);
                    _replaceAllViewerTracks(streamId);
                }
            }
        } else {
            // No desktop audio — just add mic
            if (ss.localStream) {
                const micTrack = micStream.getAudioTracks()[0];
                if (micTrack) {
                    const oldAudio = ss.localStream.getAudioTracks()[0];
                    if (oldAudio) ss.localStream.removeTrack(oldAudio);
                    ss.localStream.addTrack(micTrack);
                    _replaceAllViewerTracks(streamId);
                }
            }
        }
        ss._micEnabled = true;
        toast('Mic unmuted', 'info');
    }
    _syncScreenShareLiveControls(ss);
}

/** Cleanup composite canvas + camera overlay resources */
function _cleanupComposite(ss) {
    if (ss._compositeAnimFrame) { cancelAnimationFrame(ss._compositeAnimFrame); ss._compositeAnimFrame = null; }
    if (ss._cameraOverlayStream) { ss._cameraOverlayStream.getTracks().forEach(t => t.stop()); ss._cameraOverlayStream = null; }
    if (ss._mixAudioContext) { try { ss._mixAudioContext.close(); } catch {} ss._mixAudioContext = null; }
    if (ss._micStream) { ss._micStream.getTracks().forEach(t => t.stop()); ss._micStream = null; }
    ss._compositeCanvas = null;
    ss._compositeCtx = null;
}

/** Sync screen share button UI state */
function _syncScreenShareUI() {
    const active = broadcastState.settings.screenShare;
    const el = document.getElementById('bc-screenShare');
    if (el) el.checked = active;
    const btn = document.getElementById('bc-btn-screenshare');
    if (btn) btn.classList.toggle('bc-ctrl-btn-active', active);
    // Show/hide camera overlay button
    const camBtn = document.getElementById('bc-btn-cam-overlay');
    if (camBtn) camBtn.style.display = active ? '' : 'none';
    if (!active && camBtn) camBtn.classList.remove('bc-ctrl-btn-active');
}

function toggleBroadcastStats() { const el = document.getElementById('bc-stats-overlay'); if (el) el.style.display = el.style.display === 'none' ? 'flex' : 'none'; }

/* ── Group Call Controls ───────────────────────────────────────── */
let _broadcastCallMode = null;
let _broadcastCallPollTimer = null;

/**
 * Show the broadcast call panel and auto-join the streamer's voice channel.
 * Delegates to initBroadcastCallPanel() in call.js which handles the actual
 * WebRTC call setup and auto-join.
 */
function showBroadcastCallControls() {
    if (typeof initBroadcastCallPanel !== 'function') return;
    const streamId = broadcastState.activeStreamId;
    const mode = _broadcastCallMode || 'mic+cam';
    if (!streamId) return;
    initBroadcastCallPanel(streamId, mode);
    const panel = document.getElementById('bc-call-panel');
    if (panel) panel.style.display = '';
}

function hideBroadcastCallControls() {
    if (typeof leaveBroadcastCall === 'function') leaveBroadcastCall();
    const panel = document.getElementById('bc-call-panel');
    if (panel) panel.style.display = 'none';
}

function updateBroadcastCallUI() {
    // call.js handles its own UI rendering via _renderCallUI()
}

function onCallModeChange(mode) {
    _broadcastCallMode = mode || null;
    if (!mode) {
        hideBroadcastCallControls();
        return;
    }
    if (isStreaming()) {
        showBroadcastCallControls();
    }
}

function endBroadcastCall() {
    hideBroadcastCallControls();
}

function _startCallStatusPoll() {}
function _stopCallStatusPoll() {
    if (_broadcastCallPollTimer) { clearInterval(_broadcastCallPollTimer); _broadcastCallPollTimer = null; }
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
        // For site-wide, request server synthesis so we hear the actual espeak-ng output
        api('/tts/admin/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'This is a TTS test message from HoboStreamer' }),
        }).then(result => {
            if (result?.audio && result?.mimeType) {
                playBroadcastTTSAudio(result);
            } else {
                toast('TTS test: no audio returned from server', 'warning');
            }
        }).catch(err => {
            console.warn('[TTS] Server test failed, falling back to browser TTS:', err.message);
            speakBroadcastTTS('This is a TTS test message from HoboStreamer');
        });
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
    // Replace URLs with TTS-friendly descriptions
    let cleanText = text.replace(/(?:https?:\/\/)?(?:www\.)?([a-z0-9][-a-z0-9]*(?:\.[a-z]{2,})+)(?:[^\s]*)/gi, (m, domain) => {
        const parts = domain.split('.');
        const site = parts.length > 2 ? parts[parts.length - 2] : parts[0];
        return username ? `(${username} sent a link to ${site})` : `(link to ${site})`;
    });
    const fullText = s.ttsNames === 'on' && username ? `${username} says: ${cleanText}` : cleanText;
    ttsQueue.push(fullText); processTTSQueue();
}

/** Play server-synthesized TTS audio on the broadcast page (site-wide mode) */
function playBroadcastTTSAudio(msg) {
    const s = broadcastState.settings;
    console.log('[TTS] playBroadcastTTSAudio called — mode:', s.ttsMode, 'hasAudio:', !!msg.audio, 'mimeType:', msg.mimeType);
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
        const volume = (s.ttsVolume || 800) / 1000;
        console.log('[TTS] Broadcast audio volume:', volume, '(raw setting:', s.ttsVolume, ')');
        // Use Web Audio API GainNode for volume — Audio.volume is unreliable on PipeWire/Steam Deck
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const source = ctx.createMediaElementSource(audio);
            const gain = ctx.createGain();
            gain.gain.value = volume;
            source.connect(gain).connect(ctx.destination);
            const cleanup = () => { URL.revokeObjectURL(url); try { ctx.close(); } catch {} _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); };
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.play().catch(cleanup);
        } catch {
            // Fallback to Audio.volume if Web Audio API unavailable
            audio.volume = volume;
            audio.onended = () => { URL.revokeObjectURL(url); _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); };
            audio.onerror = () => { URL.revokeObjectURL(url); _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); };
            audio.play().catch(() => { URL.revokeObjectURL(url); _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); });
        }
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
     'broadcastRes', 'broadcastFps', 'broadcastCodec', 'forceAudio', 'allowSounds', 'ttsVoice'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => updateBroadcastSetting(key, el.value));
    });
    const forceCameraEl = document.getElementById('bc-forceCamera');
    if (forceCameraEl) {
        forceCameraEl.addEventListener('change', () => _syncCameraSelectionUI(forceCameraEl.value));
    }
    ['autoGain', 'echoCancellation', 'noiseSuppression', 'manualGainEnabled', 'force48kSampleRate'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => updateBroadcastSetting(key, el.checked));
    });
    // Screen share checkbox: toggle live if streaming, otherwise just save setting
    const screenShareEl = document.getElementById('bc-screenShare');
    if (screenShareEl) {
        screenShareEl.addEventListener('change', () => {
            const ss = getActiveStreamState();
            if (ss && ss.localStream) {
                // Revert the checkbox — toggleScreenShare() will set it properly
                screenShareEl.checked = broadcastState.settings.screenShare;
                toggleScreenShare();
            } else {
                updateBroadcastSetting('screenShare', screenShareEl.checked);
                _syncScreenShareUI();
            }
        });
    }
    // Screen share capture preference dropdowns
    ['screenCaptureSource', 'screenSystemAudio', 'screenSelfBrowser', 'screenSurfaceSwitching'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => updateBroadcastSetting(key, el.value));
    });
    const screenPreferEl = document.getElementById('bc-screenPreferCurrentTab');
    if (screenPreferEl) {
        screenPreferEl.addEventListener('change', () => updateBroadcastSetting('screenPreferCurrentTab', screenPreferEl.checked));
    }
}

/* ── Live Clip Creator ──────────────────────────────────────── */

let _bcClipStart = 0;
let _bcClipEnd = 0;

/** Get the current stream uptime in seconds */
function _getBroadcastUptimeSeconds() {
    const ss = getActiveStreamState();
    if (!ss || !ss.startedAt) return 0;
    let raw = ss.startedAt;
    if (typeof raw === 'string' && !raw.includes('T')) raw = raw.replace(' ', 'T') + 'Z';
    const start = new Date(raw).getTime();
    if (isNaN(start)) return 0;
    return Math.max(0, (Date.now() - start) / 1000);
}

function toggleBroadcastClipPanel() {
    const panel = document.getElementById('bc-clip-panel');
    if (!panel) return;
    const btn = document.getElementById('bc-btn-clip');
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : 'block';
    if (btn) btn.classList.toggle('bc-ctrl-btn-active', !visible);
    if (!visible) {
        // Initialize marks: last 30s by default
        const now = _getBroadcastUptimeSeconds();
        _bcClipEnd = Math.floor(now);
        _bcClipStart = Math.max(0, _bcClipEnd - 30);
        _updateBroadcastClipUI();
    }
}

function setBroadcastClipMark(which) {
    const now = Math.floor(_getBroadcastUptimeSeconds());
    if (which === 'start') {
        _bcClipStart = now;
        if (_bcClipEnd <= _bcClipStart) _bcClipEnd = Math.min(_bcClipStart + 30, Math.floor(_getBroadcastUptimeSeconds()));
    } else {
        _bcClipEnd = now;
        if (_bcClipStart >= _bcClipEnd) _bcClipStart = Math.max(0, _bcClipEnd - 30);
    }
    _updateBroadcastClipUI();
}

function setBroadcastClipLast30() {
    const now = Math.floor(_getBroadcastUptimeSeconds());
    _bcClipEnd = now;
    _bcClipStart = Math.max(0, now - 30);
    _updateBroadcastClipUI();
}

function _formatClipTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function _updateBroadcastClipUI() {
    const startEl = document.getElementById('bc-clip-start');
    const endEl = document.getElementById('bc-clip-end');
    const durEl = document.getElementById('bc-clip-duration');
    if (startEl) startEl.value = _formatClipTime(_bcClipStart);
    if (endEl) endEl.value = _formatClipTime(_bcClipEnd);
    const dur = _bcClipEnd - _bcClipStart;
    if (durEl) {
        durEl.textContent = `${dur}s`;
        durEl.style.color = (dur > 60 || dur <= 0) ? '#e74c3c' : '';
    }
}

async function createBroadcastClip() {
    const ss = getActiveStreamState();
    if (!ss) return showToast('No active stream', 'error');
    if (!ss.vodId) return showToast('VOD recording not ready yet — wait a few seconds after going live', 'error');

    const duration = _bcClipEnd - _bcClipStart;
    if (duration <= 0) return showToast('End time must be after start time', 'error');
    if (duration > 60) return showToast('Clip cannot exceed 60 seconds', 'error');
    if (_bcClipStart < 0) return showToast('Invalid start time', 'error');

    const title = document.getElementById('bc-clip-title')?.value?.trim() || 'Untitled Clip';
    const btn = document.getElementById('bc-clip-create-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…'; }

    try {
        const res = await fetch('/api/vods/clips', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vod_id: ss.vodId,
                stream_id: ss.streamData?.id,
                start_time: _bcClipStart,
                end_time: _bcClipEnd,
                title,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create clip');

        showToast(`Clip created! "${title}"`, 'success');

        // Reset panel
        const titleInput = document.getElementById('bc-clip-title');
        if (titleInput) titleInput.value = '';
        // Update marks to current time
        const now = Math.floor(_getBroadcastUptimeSeconds());
        _bcClipEnd = now;
        _bcClipStart = Math.max(0, now - 30);
        _updateBroadcastClipUI();
    } catch (err) {
        console.error('[Clip] Error:', err);
        showToast(err.message || 'Failed to create clip', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-scissors"></i> Create Clip'; }
    }
}

/* ── /Live Clip Creator ────────────────────────────────────── */

/* ── PiP Drag & Resize on Preview ─────────────────────────── */
/**
 * Allow the streamer to drag/resize the camera PiP overlay by clicking on the preview video.
 * Works in screen share + camera overlay mode. The preview shows the composite canvas output.
 * - Click & drag inside PiP rect = move
 * - Click & drag bottom-right corner of PiP = resize
 * - Positions stored as fractions (0-1) in ss._pipX/_pipY/_pipW
 */
function _initPipDragResize() {
    const preview = document.getElementById('bc-video-preview');
    if (!preview) return;

    function _getCanvasRelPos(e, rect) {
        const cx = (e.clientX - rect.left) / rect.width;
        const cy = (e.clientY - rect.top) / rect.height;
        return { cx: Math.max(0, Math.min(1, cx)), cy: Math.max(0, Math.min(1, cy)) };
    }

    function _getPipRect(ss) {
        if (!ss || !ss._compositeCanvas) return null;
        const w = ss._pipW;
        const aspect = (ss._cameraOverlayStream?.getVideoTracks()[0]?.getSettings()?.height /
                        ss._cameraOverlayStream?.getVideoTracks()[0]?.getSettings()?.width) || 0.75;
        const h = w * aspect;
        return { x: ss._pipX, y: ss._pipY, w, h };
    }

    let _dragState = null; // { mode: 'move'|'resize', startCx, startCy, startPipX, startPipY, startPipW }

    function onPointerDown(e) {
        const ss = getActiveStreamState();
        if (!ss || !ss._cameraOverlayEnabled || !broadcastState.settings.screenShare) return;
        const rect = preview.getBoundingClientRect();
        const { cx, cy } = _getCanvasRelPos(e, rect);
        const pip = _getPipRect(ss);
        if (!pip) return;

        // Check if inside PiP rectangle
        if (cx >= pip.x && cx <= pip.x + pip.w && cy >= pip.y && cy <= pip.y + pip.h) {
            e.preventDefault();
            // Check if near bottom-right corner for resize (last 20% of pip)
            const resizeThresh = 0.2;
            const isResize = (cx > pip.x + pip.w * (1 - resizeThresh)) && (cy > pip.y + pip.h * (1 - resizeThresh));
            _dragState = {
                mode: isResize ? 'resize' : 'move',
                startCx: cx, startCy: cy,
                startPipX: ss._pipX, startPipY: ss._pipY, startPipW: ss._pipW,
            };
            preview.style.cursor = isResize ? 'nwse-resize' : 'grabbing';
            preview.setPointerCapture(e.pointerId);
        }
    }

    function onPointerMove(e) {
        if (!_dragState) {
            // Show grab cursor when hovering over PiP
            const ss = getActiveStreamState();
            if (ss && ss._cameraOverlayEnabled && broadcastState.settings.screenShare) {
                const rect = preview.getBoundingClientRect();
                const { cx, cy } = _getCanvasRelPos(e, rect);
                const pip = _getPipRect(ss);
                if (pip && cx >= pip.x && cx <= pip.x + pip.w && cy >= pip.y && cy <= pip.y + pip.h) {
                    const resizeThresh = 0.2;
                    const isResize = (cx > pip.x + pip.w * (1 - resizeThresh)) && (cy > pip.y + pip.h * (1 - resizeThresh));
                    preview.style.cursor = isResize ? 'nwse-resize' : 'grab';
                } else {
                    preview.style.cursor = '';
                }
            }
            return;
        }
        e.preventDefault();
        const ss = getActiveStreamState();
        if (!ss) { _dragState = null; return; }
        const rect = preview.getBoundingClientRect();
        const { cx, cy } = _getCanvasRelPos(e, rect);
        const dx = cx - _dragState.startCx;
        const dy = cy - _dragState.startCy;

        if (_dragState.mode === 'move') {
            ss._pipX = Math.max(0, Math.min(1 - ss._pipW, _dragState.startPipX + dx));
            // Estimate pip height for bounds clamping
            const aspect = (ss._cameraOverlayStream?.getVideoTracks()[0]?.getSettings()?.height /
                            ss._cameraOverlayStream?.getVideoTracks()[0]?.getSettings()?.width) || 0.75;
            const pipH = ss._pipW * aspect;
            ss._pipY = Math.max(0, Math.min(1 - pipH, _dragState.startPipY + dy));
        } else if (_dragState.mode === 'resize') {
            // Resize — change width proportionally, min 8%, max 50%
            const newW = Math.max(0.08, Math.min(0.50, _dragState.startPipW + dx));
            ss._pipW = newW;
        }
    }

    function onPointerUp(e) {
        if (_dragState) {
            _dragState = null;
            preview.style.cursor = '';
            try { preview.releasePointerCapture(e.pointerId); } catch {}
        }
    }

    preview.addEventListener('pointerdown', onPointerDown);
    preview.addEventListener('pointermove', onPointerMove);
    preview.addEventListener('pointerup', onPointerUp);
    preview.addEventListener('pointercancel', onPointerUp);
}

document.addEventListener('DOMContentLoaded', () => {
    initBroadcastSettingsListeners();

    // Update mobile chat FAB visibility on resize
    window.addEventListener('resize', () => {
        updateBroadcastMobileChatFab();
        if (window.innerWidth > 768) {
            _bcMobileChatOpen = false;
            const sidebar = document.getElementById('bc-chat-sidebar');
            if (sidebar) sidebar.classList.remove('mobile-chat-open');
            document.body.classList.remove('mobile-chat-visible');
            closeCameraSwitcher();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCameraSwitcher();
    });

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

    // ── Screen share device toggle listeners ──
    const screenCamCheck = document.getElementById('bc-screen-cam-enabled');
    const screenCamSelect = document.getElementById('bc-screen-cam-select');
    if (screenCamCheck && screenCamSelect) {
        screenCamCheck.addEventListener('change', () => {
            screenCamSelect.style.display = screenCamCheck.checked ? 'block' : 'none';
        });
    }
    const screenMicCheck = document.getElementById('bc-screen-mic-enabled');
    const screenMicSelect = document.getElementById('bc-screen-mic-select');
    if (screenMicCheck && screenMicSelect) {
        screenMicCheck.addEventListener('change', () => {
            screenMicSelect.style.display = screenMicCheck.checked ? 'block' : 'none';
        });
    }

    // ── PiP drag/resize on preview ──
    _initPipDragResize();
});

// ═══════════════════════════════════════════════════════════════
// Media Request PiP Player (inline on broadcast page)
// ═══════════════════════════════════════════════════════════════
let _mediaPipState = null;     // { now_playing, queue, settings }
let _mediaPipPollTimer = null;
let _mediaPipSocket = null;
let _mediaPipCurrentId = null;

function toggleMediaPip() {
    const panel = document.getElementById('bc-media-pip');
    if (!panel) return;
    const btn = document.getElementById('bc-btn-media-pip');
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : '';
    if (btn) btn.classList.toggle('bc-ctrl-btn-active', !visible);
    if (!visible) {
        _mediaPipRefresh();
        _startMediaPipPoll();
        _connectMediaPipSocket();
    } else {
        _stopMediaPipPoll();
        try { _mediaPipSocket?.close(); } catch {}
        _mediaPipSocket = null;
    }
}

function mediaPopout() {
    if (currentUser?.username) window.open(`/media/${currentUser.username}`, '_blank');
}

async function _mediaPipRefresh() {
    if (!currentUser?.username) return;
    try {
        const data = await api(`/media/channel/${encodeURIComponent(currentUser.username)}`);
        _mediaPipState = data.state;
        _renderMediaPip();
    } catch (e) {
        console.warn('[MediaPip] refresh error:', e.message);
    }
}

function _renderMediaPip() {
    const state = _mediaPipState;
    if (!state) return;

    const np = state.now_playing;
    const header = document.getElementById('bc-media-pip-now');
    const emptyEl = document.getElementById('bc-media-pip-empty');
    const loadingEl = document.getElementById('bc-media-pip-loading');
    const controlsEl = document.getElementById('bc-media-pip-controls');
    const hostEl = document.getElementById('bc-media-pip-host');
    const queueEl = document.getElementById('bc-media-pip-queue');

    // Now playing
    if (np) {
        header.textContent = np.title || 'Now Playing';
        emptyEl.style.display = 'none';
        controlsEl.style.display = '';
        document.getElementById('bc-media-pip-track').textContent = np.title || 'Unknown';
        document.getElementById('bc-media-pip-requester').textContent = `Requested by ${np.username || '?'}`;

        // Load player if different request
        if (_mediaPipCurrentId !== np.id) {
            _mediaPipCurrentId = np.id;
            _loadMediaPipPlayer(np);
        }
    } else {
        header.textContent = 'Media Requests';
        emptyEl.style.display = '';
        controlsEl.style.display = 'none';
        _destroyMediaPipPlayer();
    }

    // Queue
    const queue = state.queue || [];
    if (queue.length === 0) {
        queueEl.innerHTML = '<div class="bc-media-pip-queue-empty">Queue empty</div>';
    } else {
        queueEl.innerHTML = queue.slice(0, 10).map(q =>
            `<div class="bc-pip-queue-item">
                <span class="bc-pip-queue-title">${_escPip(q.title)}</span>
                <span class="bc-pip-queue-user">${_escPip(q.username)}</span>
            </div>`
        ).join('');
        if (queue.length > 10) {
            queueEl.innerHTML += `<div class="bc-media-pip-queue-empty">+${queue.length - 10} more</div>`;
        }
    }
}

function _escPip(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function _loadMediaPipPlayer(request) {
    const host = document.getElementById('bc-media-pip-host');
    const empty = document.getElementById('bc-media-pip-empty');
    const loading = document.getElementById('bc-media-pip-loading');
    _destroyMediaPipPlayer();

    let url = request.stream_url;
    if (!url || request.download_status !== 'ready') {
        try {
            const data = await api(`/media/queue/${request.id}/stream-url`);
            url = data?.stream_url || null;
        } catch {
            url = null;
        }
    }

    if (!url) {
        empty.style.display = '';
        empty.querySelector('span').textContent = 'Server is still preparing this media';
        loading.style.display = 'none';
        return;
    }

    const isAudio = request.provider === 'audio';
    const media = document.createElement(isAudio ? 'audio' : 'video');
    media.src = url;
    media.autoplay = true;
    media.controls = true;
    if (!isAudio) media.style.cssText = 'width:100%;height:100%;display:block;background:#000';
    else media.style.cssText = 'width:100%;min-height:60px;display:block;background:#111';

    media.addEventListener('canplay', () => { loading.style.display = 'none'; });
    media.addEventListener('error', () => { loading.style.display = 'none'; });

    host.appendChild(media);
    empty.style.display = 'none';
    loading.style.display = 'none';
}

function _destroyMediaPipPlayer() {
    const host = document.getElementById('bc-media-pip-host');
    if (!host) return;
    const el = host.querySelector('video, audio');
    if (el) {
        try { el.pause?.(); } catch {}
        el.remove();
    }
    _mediaPipCurrentId = null;
}

async function mediaPipSkip() {
    const np = _mediaPipState?.now_playing;
    if (!np) { toast('Nothing playing', 'warning'); return; }
    try {
        await api('/media/advance', { method: 'POST', body: { status: 'skipped' } });
        _mediaPipRefresh();
    } catch (e) { toast(e.message, 'error'); }
}

async function mediaPipStartNext() {
    try {
        await api('/media/start', { method: 'POST' });
        _mediaPipRefresh();
    } catch (e) { toast(e.message, 'error'); }
}

function _startMediaPipPoll() {
    _stopMediaPipPoll();
    _mediaPipPollTimer = setInterval(_mediaPipRefresh, 8000);
}

function _stopMediaPipPoll() {
    if (_mediaPipPollTimer) { clearInterval(_mediaPipPollTimer); _mediaPipPollTimer = null; }
}

function _connectMediaPipSocket() {
    const activeId = broadcastState.activeStreamId;
    if (!activeId) return;
    if (_mediaPipSocket && _mediaPipSocket._sid === activeId && _mediaPipSocket.readyState <= 1) return;
    try { _mediaPipSocket?.close(); } catch {}

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/ws/chat`);
    const token = localStorage.getItem('token');
    if (token) url.searchParams.set('token', token);
    url.searchParams.set('stream', activeId);

    const ws = new WebSocket(url.toString());
    ws._sid = activeId;
    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'join_stream', streamId: activeId, token: token || undefined }));
    });
    ws.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'media_queue_update' && msg.state) {
                _mediaPipState = msg.state;
                _renderMediaPip();
            } else if (msg.type === 'media_now_playing' && msg.request) {
                if (_mediaPipState) _mediaPipState.now_playing = msg.request;
                _renderMediaPip();
            }
        } catch {}
    });
    ws.addEventListener('close', () => {
        if (_mediaPipSocket === ws) _mediaPipSocket = null;
    });
    _mediaPipSocket = ws;
}
