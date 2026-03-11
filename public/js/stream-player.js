/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Stream Player (JSMPEG / WebRTC / HLS)
   ═══════════════════════════════════════════════════════════════ */

let player = null;
let playerType = null;

// Clip recording state (rolling buffer for live clips)
let clipRecorder = null;
let clipHeaderChunk = null;  // First chunk contains the WebM EBML header — must be preserved
let clipChunks = [];
let clipStreamId = null;
let streamRef = null; // current stream object for clip recording
let clipSourceStream = null;
let clipRecorderMimeType = null;
let clipTimingBaseMs = 0;
let _jsmpegClipSetupTimer = null;
const CLIP_BUFFER_SECONDS = 30;
const externalScriptPromises = new Map();
const PLAYER_SIGNALING_MAX_BUFFERED_AMOUNT = 256 * 1024;

// DVR state (live stream seeking via server-side VOD recording)
let dvrState = {
    active: false,       // DVR feature is available (live VOD exists)
    isLive: true,        // Currently showing real-time stream (vs rewound)
    vodId: null,         // Live VOD ID
    vodFilename: null,   // Live VOD filename for HTTP src
    duration: 0,         // Current total duration (seconds) from server
    seekable: false,     // Seekable copy available
    pollTimer: null,     // Interval for polling live-info
    updateTimer: null,   // Interval for UI updates
    streamStartTime: 0,  // Stream start timestamp (ms)
    savedSrcObject: null, // WebRTC MediaStream saved when switching to DVR
    savedLivePlayer: null, // HLS/FLV player saved when switching to DVR
    seeking: false,      // User is dragging the DVR progress bar
};

function loadExternalScriptOnce(src) {
    if (!src) return Promise.reject(new Error('Missing script URL'));
    if (externalScriptPromises.has(src)) return externalScriptPromises.get(src);

    const promise = new Promise((resolve, reject) => {
        const key = encodeURIComponent(src);
        const existing = document.querySelector(`script[data-external-src="${key}"]`);
        if (existing) {
            if (existing.dataset.loaded === 'true') {
                resolve();
                return;
            }
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.externalSrc = key;
        script.onload = () => {
            script.dataset.loaded = 'true';
            resolve();
        };
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    }).catch((err) => {
        externalScriptPromises.delete(src);
        throw err;
    });

    externalScriptPromises.set(src, promise);
    return promise;
}

function getJsmpegBufferProfile() {
    const connectionType = navigator.connection?.effectiveType || '';
    if (connectionType === 'slow-2g' || connectionType === '2g') {
        return { videoBufferSize: 256 * 1024, audioBufferSize: 64 * 1024 };
    }
    return { videoBufferSize: 512 * 1024, audioBufferSize: 128 * 1024 };
}

function sendPlayerSignal(msg) {
    if (!player?.ws || player.ws.readyState !== WebSocket.OPEN) return false;
    if (player.ws.bufferedAmount > PLAYER_SIGNALING_MAX_BUFFERED_AMOUNT) return false;
    player.ws.send(JSON.stringify(msg));
    return true;
}

function isMediaRecorderSupported() {
    return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
}

function getLiveStreamElapsedSeconds() {
    if (dvrState.streamStartTime && Number.isFinite(dvrState.streamStartTime) && dvrState.streamStartTime > 0) {
        return Math.max(0, (Date.now() - dvrState.streamStartTime) / 1000);
    }

    const startedAt = streamRef?.started_at || streamRef?.created_at;
    if (startedAt) {
        const normalized = typeof startedAt === 'string' && !startedAt.includes('T')
            ? `${startedAt.replace(' ', 'T')}Z`
            : startedAt;
        const ts = new Date(normalized).getTime();
        if (Number.isFinite(ts) && ts > 0) {
            return Math.max(0, (Date.now() - ts) / 1000);
        }
    }

    return Math.max(0, CLIP_BUFFER_SECONDS);
}

function buildClipRecorderCandidates(stream) {
    const hasVideo = !!stream?.getVideoTracks?.().length;
    const hasAudio = !!stream?.getAudioTracks?.().length;
    const candidates = [];

    if (!hasVideo) return candidates;

    const pushCandidate = (mimeType, options = {}) => {
        candidates.push({ mimeType, options });
    };

    const canUse = (mimeType) => !mimeType || !isMediaRecorderSupported() || MediaRecorder.isTypeSupported(mimeType);

    if (hasAudio) {
        [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=vp8',
            'video/webm',
        ].forEach((mimeType) => {
            if (canUse(mimeType)) {
                pushCandidate(mimeType, { videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 });
            }
        });
    }

    [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        '',
    ].forEach((mimeType) => {
        if (canUse(mimeType)) {
            pushCandidate(mimeType, { videoBitsPerSecond: 2200000 });
        }
    });

    return candidates;
}

function createClipRecorder(stream) {
    if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder is not available in this browser');
    }

    const candidates = buildClipRecorderCandidates(stream);
    if (!candidates.length) {
        throw new Error('No supported recording codecs for this media stream');
    }

    let lastError = null;
    for (const candidate of candidates) {
        try {
            const opts = { ...candidate.options };
            if (candidate.mimeType) opts.mimeType = candidate.mimeType;
            const recorder = new MediaRecorder(stream, opts);
            return { recorder, mimeType: candidate.mimeType || recorder.mimeType || 'video/webm', sourceStream: stream };
        } catch (err) {
            lastError = err;
        }
    }

    const videoTracks = stream?.getVideoTracks?.() || [];
    const audioTracks = stream?.getAudioTracks?.() || [];
    if (videoTracks.length && audioTracks.length && typeof MediaStream !== 'undefined') {
        try {
            const videoOnlyStream = new MediaStream(videoTracks);
            const videoOnlyCandidates = buildClipRecorderCandidates(videoOnlyStream);
            for (const candidate of videoOnlyCandidates) {
                try {
                    const opts = { ...candidate.options };
                    if (candidate.mimeType) opts.mimeType = candidate.mimeType;
                    const recorder = new MediaRecorder(videoOnlyStream, opts);
                    console.warn('[Clip] Falling back to video-only recording for compatibility');
                    return { recorder, mimeType: candidate.mimeType || recorder.mimeType || 'video/webm', sourceStream: videoOnlyStream };
                } catch (err) {
                    lastError = err;
                }
            }
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Unable to initialize MediaRecorder');
}

function startClipRecordingIfNeeded(stream, streamId) {
    if (!stream) return;
    if (clipRecorder && clipSourceStream === stream && clipStreamId === streamId) return;
    clipSourceStream = stream;
    startClipRecording(stream, streamId);
}

/**
 * Initialize the appropriate player based on stream protocol.
 * @param {Object} stream - Stream object with protocol, endpoint info
 */
function initPlayer(stream) {
    destroyPlayer();
    streamRef = stream; // Store for clip recording across all protocols
    const proto = stream.protocol || 'jsmpeg';
    const endpoint = stream.endpoint || {};

    switch (proto) {
        case 'jsmpeg':
            initJSMPEG(endpoint, stream);
            break;
        case 'webrtc':
            initWebRTC(stream);
            break;
        case 'rtmp':
            initHLS(endpoint, stream);
            break;
        default:
            console.warn('Unknown protocol:', proto);
            initJSMPEG(endpoint, stream); // fallback
    }

    setupVideoControls();

    // Initialize DVR for all protocols — server-side recording handles JSMPEG & RTMP,
    // client-side chunked upload handles WebRTC
    initDVR(stream);
}

/* ── JSMPEG (FFmpeg → HTTP → WebSocket → Canvas) ─────────────── */
function initJSMPEG(endpoint, stream) {
    const canvas = document.getElementById('video-canvas');
    const placeholder = document.querySelector('.video-placeholder');

    // Build WS URL
    const host = window.location.hostname;
    const port = endpoint.videoPort || endpoint.video_port || endpoint.wsPort || 9710;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsProtocol}://${host}:${port}`;
    const bufferProfile = getJsmpegBufferProfile();

    // Check if JSMpeg lib is loaded (from CDN or local)
    if (typeof JSMpeg === 'undefined') {
        loadExternalScriptOnce('https://jsmpeg.com/jsmpeg.min.js').then(() => {
            startJSMPEG(wsUrl, canvas, placeholder, bufferProfile);
        }).catch(() => {
            console.error('Failed to load JSMpeg library');
            placeholder.innerHTML = `
                <i class="fa-solid fa-triangle-exclamation fa-3x"></i>
                <p>JSMPEG player not available</p>
                <p class="muted">Ensure jsmpeg.min.js is loaded</p>`;
        });
    } else {
        startJSMPEG(wsUrl, canvas, placeholder, bufferProfile);
    }

    playerType = 'jsmpeg';
}

function startJSMPEG(wsUrl, canvas, placeholder, bufferProfile = getJsmpegBufferProfile()) {
    try {
        canvas.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';

        if (_jsmpegClipSetupTimer) {
            clearTimeout(_jsmpegClipSetupTimer);
            _jsmpegClipSetupTimer = null;
        }

        player = new JSMpeg.Player(wsUrl, {
            canvas: canvas,
            autoplay: true,
            audio: true,
            videoBufferSize: bufferProfile.videoBufferSize,
            audioBufferSize: bufferProfile.audioBufferSize,
            preserveDrawingBuffer: true,
            onSourceEstablished: () => {
                console.log('[JSMPEG] Source established — waiting for first frames before clip recording');
                // Delay clip recording start so JSMpeg has time to decode & render
                // frames. Using an offscreen 2D canvas avoids WebGL captureStream issues.
                _jsmpegClipSetupTimer = setTimeout(() => {
                    _jsmpegClipSetupTimer = null;
                    try {
                        const offCanvas = document.createElement('canvas');
                        offCanvas.width = canvas.width || 640;
                        offCanvas.height = canvas.height || 480;
                        const offCtx = offCanvas.getContext('2d');
                        if (!offCtx) throw new Error('Unable to create canvas context');
                        const clipStream = offCanvas.captureStream(30);

                        // Draw JSMpeg's canvas onto our offscreen 2D canvas at ~30fps
                        const _jsmpegDrawInterval = setInterval(() => {
                            if (canvas.width && canvas.height) {
                                if (offCanvas.width !== canvas.width) offCanvas.width = canvas.width;
                                if (offCanvas.height !== canvas.height) offCanvas.height = canvas.height;
                            }
                            offCtx.drawImage(canvas, 0, 0, offCanvas.width, offCanvas.height);
                        }, 33);
                        window._jsmpegDrawInterval = _jsmpegDrawInterval;

                        // Try to capture JSMpeg's Web Audio output for clip audio
                        try {
                            const audioCtx = player.audioOut?.context || player.audioOut?.destination?.context;
                            const gainNode = player.audioOut?.gain || player.audioOut;
                            if (audioCtx && gainNode && gainNode.connect) {
                                const audioDest = audioCtx.createMediaStreamDestination();
                                gainNode.connect(audioDest);
                                for (const track of audioDest.stream.getAudioTracks()) {
                                    clipStream.addTrack(track);
                                }
                                console.log('[JSMPEG] Audio capture attached to clip recorder');
                            }
                        } catch (audioErr) {
                            console.warn('[JSMPEG] Audio capture not available:', audioErr.message);
                        }
                        startClipRecordingIfNeeded(clipStream, streamRef?.id);
                    } catch (err) {
                        console.warn('[JSMPEG] Clip recording setup failed:', err.message);
                    }
                }, 2500); // Wait 2.5s for frames to be decoded & rendered
            },
            onSourceCompleted: () => {
                console.log('[JSMPEG] Source completed (stream ended?)');
                showStreamEnded();
            },
        });
    } catch (e) {
        console.error('JSMPEG init failed:', e);
        canvas.style.display = 'none';
        if (placeholder) {
            placeholder.style.display = '';
            placeholder.innerHTML = `
                <i class="fa-solid fa-exclamation-triangle fa-3x"></i>
                <p>Failed to connect to stream</p>`;
        }
    }
}

/* ── WebRTC (Browser Broadcast via Signaling Relay) ───────────── */
async function initWebRTC(stream) {
    const video = document.getElementById('video-element');
    const placeholder = document.querySelector('.video-placeholder');
    streamRef = stream; // set module-level ref for clip recording in handleViewerOffer

    try {
        video.playsInline = true;
        video.preload = 'auto';
        // Keep placeholder visible ("Connecting to stream...") until video actually plays
        // The video element stays hidden until ontrack + playing event
        video.style.display = 'none';
        playerType = 'webrtc';

        // Connect to the broadcast signaling relay as a viewer
        const host = window.location.hostname;
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const portSuffix = window.location.port ? `:${window.location.port}` : '';
        const token = localStorage.getItem('token') || '';
        const wsUrl = `${protocol}://${host}${portSuffix}/ws/broadcast?streamId=${streamRef.id}&role=viewer&token=${token}`;

        const ws = new WebSocket(wsUrl);
        player = { ws, video, pc: null, myPeerId: null, watchSent: false, _wsUrl: wsUrl };
        let _broadcasterDisconnectTimer = null;
        let _viewerReconnectTimer = null;
        let _viewerReconnectDelay = 3000; // exponential backoff: 3s → 30s max
        let _viewerIntentionalClose = false;
        let _viewerRewatchTimer = null;
        let _watchOfferTimer = null; // timeout: sent 'watch' but never got 'offer'
        let _rewatchCount = 0;
        const MAX_REWATCH_ATTEMPTS = 8;

        // Start a timer when 'watch' is sent — if no 'offer' arrives within 12s, re-watch
        const startWatchOfferTimeout = () => {
            if (_watchOfferTimer) clearTimeout(_watchOfferTimer);
            _watchOfferTimer = setTimeout(() => {
                _watchOfferTimer = null;
                if (!player || _viewerIntentionalClose) return;
                // No offer received — broadcaster may be unresponsive
                if (_rewatchCount < MAX_REWATCH_ATTEMPTS) {
                    console.warn(`[Player] No offer received within 12s (attempt ${_rewatchCount + 1}/${MAX_REWATCH_ATTEMPTS})`);
                    scheduleViewerRewatch(500);
                } else {
                    console.error('[Player] Max rewatch attempts reached — stream may be unavailable');
                    showStreamError('Stream is not responding. Try refreshing the page.');
                }
            }, 12000);
        };

        const scheduleViewerRewatch = (delay = 1500) => {
            if (_viewerIntentionalClose || !player) return;
            if (_rewatchCount >= MAX_REWATCH_ATTEMPTS) {
                console.error('[Player] Max rewatch attempts reached, giving up');
                showStreamError('Could not connect to stream. Try refreshing the page.');
                return;
            }
            if (_viewerRewatchTimer) clearTimeout(_viewerRewatchTimer);
            _viewerRewatchTimer = setTimeout(() => {
                _viewerRewatchTimer = null;
                if (!player?.ws || player.ws.readyState !== WebSocket.OPEN) return;
                _rewatchCount++;
                player.watchSent = false;
                sendPlayerSignal({ type: 'watch' });
                player.watchSent = true;
                startWatchOfferTimeout();
            }, delay);
        };

        // Expose startWatchOfferTimeout on player so handleViewerOffer's triggerRewatch can use it
        player._startWatchOfferTimeout = startWatchOfferTimeout;

        ws.onopen = () => {
            console.log('[Player] Broadcast signaling connected');
            _viewerReconnectDelay = 3000; // reset backoff on successful connect
            const pcState = player?.pc?.iceConnectionState;
            if (!player.watchSent || pcState === 'failed' || pcState === 'disconnected' || pcState === 'closed') {
                scheduleViewerRewatch(250);
            }
        };

        ws.onmessage = async (e) => {
            try {
                const msg = JSON.parse(e.data);
                switch (msg.type) {
                    case 'welcome':
                        player.myPeerId = msg.peerId;
                        console.log('[Player] Welcome, peerId:', msg.peerId);
                        // Don't send watch here — wait for broadcaster-ready
                        break;
                    case 'broadcaster-ready':
                        // Broadcaster connected/reconnected — request to watch
                        console.log('[Player] Broadcaster ready, requesting watch');
                        // Cancel any pending rewatch timer (prevents double-watch race)
                        if (_viewerRewatchTimer) { clearTimeout(_viewerRewatchTimer); _viewerRewatchTimer = null; }
                        // Cancel any pending "stream ended" from a brief disconnect
                        if (_broadcasterDisconnectTimer) {
                            clearTimeout(_broadcasterDisconnectTimer);
                            _broadcasterDisconnectTimer = null;
                        }
                        // Skip re-negotiation if peer connection is still healthy
                        if (player.pc) {
                            const state = player.pc.iceConnectionState;
                            if (state === 'connected' || state === 'completed') {
                                console.log(`[Player] Peer connection still healthy (ICE: ${state}), skipping re-negotiate`);
                                break;
                            }
                        }
                        player.watchSent = false; // allow re-watch on reconnect
                        _rewatchCount++;
                        sendPlayerSignal({ type: 'watch' });
                        player.watchSent = true;
                        startWatchOfferTimeout();
                        break;
                    case 'offer':
                        // Broadcaster sent us an offer — create answer
                        console.log('[Player] Received offer from broadcaster');
                        // Clear the watch-to-offer timeout — offer received successfully
                        if (_watchOfferTimer) { clearTimeout(_watchOfferTimer); _watchOfferTimer = null; }
                        _rewatchCount = 0; // reset retry count on successful offer
                        await handleViewerOffer(msg, player.ws, video);
                        break;
                    case 'ice-candidate':
                        // ICE candidate from broadcaster
                        if (player.pc && msg.candidate) {
                            await player.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        }
                        break;
                    case 'broadcaster-disconnected':
                        console.log('[Player] Broadcaster disconnected — waiting for reconnect...');
                        // Give the broadcaster a grace period to reconnect before declaring stream ended
                        if (_broadcasterDisconnectTimer) clearTimeout(_broadcasterDisconnectTimer);
                        _broadcasterDisconnectTimer = setTimeout(() => {
                            _broadcasterDisconnectTimer = null;
                            console.log('[Player] Broadcaster did not reconnect, stream ended');
                            showStreamEnded();
                        }, 25000);
                        break;
                    case 'stream-ended':
                        console.log('[Player] Stream ended by server');
                        if (_broadcasterDisconnectTimer) clearTimeout(_broadcasterDisconnectTimer);
                        _viewerIntentionalClose = true; // don't reconnect on explicit end
                        showStreamEnded();
                        break;
                    case 'viewer-count':
                        const vcEl = document.getElementById('vc-viewers');
                        if (vcEl) vcEl.textContent = msg.count || 0;
                        break;
                }
            } catch (err) {
                console.error('[Player] Message error:', err);
            }
        };

        ws.onerror = () => {
            console.error('[Player] Broadcast signaling error');
        };

        ws.onclose = (ev) => {
            console.log(`[Player] Broadcast signaling closed (code=${ev.code})`);
            if (_viewerIntentionalClose) return;
            // Reconnect signaling WS with exponential backoff
            // The WebRTC peer connection may still be delivering media even without signaling
            if (player && streamRef) {
                const delay = _viewerReconnectDelay;
                _viewerReconnectDelay = Math.min(_viewerReconnectDelay * 1.5, 30000);
                console.log(`[Player] Reconnecting signaling in ${Math.round(delay)}ms`);
                _viewerReconnectTimer = setTimeout(() => {
                    _viewerReconnectTimer = null;
                    if (!player || _viewerIntentionalClose) return;
                    try {
                        const newWs = new WebSocket(wsUrl);
                        player.ws = newWs;
                        // Re-attach all handlers to the new WS
                        newWs.onopen = ws.onopen;
                        newWs.onmessage = ws.onmessage;
                        newWs.onerror = ws.onerror;
                        newWs.onclose = ws.onclose;
                    } catch (err) {
                        console.error('[Player] Signaling reconnect failed:', err);
                    }
                }, delay);
            }
        };
    } catch (e) {
        console.error('[Player] WebRTC init failed:', e);
        showStreamError('WebRTC not available');
    }
}

async function handleViewerOffer(msg, ws, video) {
    // Safety: player must be set by initWebRTC before we get here
    if (!player) {
        console.warn('[Player] handleViewerOffer called but player is null');
        return;
    }
    // Close existing PC if re-negotiating — detach handlers first to prevent
    // the old PC's 'closed' state from triggering a cascading re-watch loop
    if (player.pc) {
        const oldPc = player.pc;
        oldPc.oniceconnectionstatechange = null;
        oldPc.ontrack = null;
        oldPc.onicecandidate = null;
        try { oldPc.close(); } catch (ignored) {}
    }
    // Clear any pending stall/ICE timers from the previous connection
    if (player._iceTimeout) { clearTimeout(player._iceTimeout); player._iceTimeout = null; }
    if (player._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
    if (player._playRetryTimer) { clearTimeout(player._playRetryTimer); player._playRetryTimer = null; }

    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
    });
    player.pc = pc;
    let _iceConnected = false;
    let _hasVideoFrames = false;
    let _playPending = false; // debounce play() across multiple ontrack events

    // Schedules a re-watch if the current PC is still ours
    const triggerRewatch = (reason) => {
        if (!player || player.pc !== pc) return;
        console.log(`[Player] Re-watching: ${reason}`);
        player.watchSent = false;
        sendPlayerSignal({ type: 'watch' });
        player.watchSent = true;
        // Start watch-to-offer timeout for this re-watch too
        if (player._startWatchOfferTimeout) player._startWatchOfferTimeout();
    };

    // Debounced play() — coalesces multiple ontrack calls
    const tryPlay = () => {
        if (_playPending || !player || player.pc !== pc) return;
        _playPending = true;
        if (player._playRetryTimer) { clearTimeout(player._playRetryTimer); player._playRetryTimer = null; }
        video.play().then(() => {
            _playPending = false;
            console.log('[Player] Playback started');
        }).catch((err) => {
            _playPending = false;
            if (err.name === 'NotAllowedError') {
                // Browser blocked autoplay — mute and retry
                console.warn('[Player] Autoplay blocked, muting and retrying');
                video.muted = true;
                video.play().then(() => {
                    showUnmuteOverlay(video);
                }).catch(() => {
                    console.error('[Player] Playback failed even muted');
                });
            } else if (err.name === 'AbortError') {
                // play() was interrupted by another call — retry after a tick
                console.log('[Player] play() interrupted, retrying in 200ms');
                player._playRetryTimer = setTimeout(() => {
                    player._playRetryTimer = null;
                    _playPending = false;
                    tryPlay();
                }, 200);
            } else {
                console.error('[Player] Play failed:', err);
                // Retry once after a short delay for transient errors
                player._playRetryTimer = setTimeout(() => {
                    player._playRetryTimer = null;
                    _playPending = false;
                    video.play().catch(() => {});
                }, 1000);
            }
        });
    };

    pc.ontrack = (e) => {
        console.log('[Player] Got remote track:', e.track.kind);
        if (e.streams && e.streams[0]) {
            video.srcObject = e.streams[0];
            startClipRecordingIfNeeded(e.streams[0], streamRef?.id);
        } else {
            let mediaStream = video.srcObject;
            if (!mediaStream) {
                mediaStream = new MediaStream();
                video.srcObject = mediaStream;
            }
            mediaStream.addTrack(e.track);
            startClipRecordingIfNeeded(mediaStream, streamRef?.id);
        }

        // Monitor remote track health — if it ends or mutes, trigger re-watch
        const track = e.track;
        track.addEventListener('ended', () => {
            if (player?.pc !== pc) return;
            console.warn(`[Player] Remote ${track.kind} track ended`);
            triggerRewatch(`remote ${track.kind} track ended`);
        }, { once: true });
        track.addEventListener('mute', () => {
            if (player?.pc !== pc) return;
            console.warn(`[Player] Remote ${track.kind} track muted`);
            // Give muted tracks a grace period — they may unmute on their own (e.g. track replacement)
            setTimeout(() => {
                if (player?.pc !== pc || !track.muted) return;
                triggerRewatch(`remote ${track.kind} track stayed muted`);
            }, 5000);
        }, { once: true });

        // Show the video element now that we have tracks
        video.style.display = 'block';

        // Hide the placeholder once video actually renders frames
        const onPlaying = () => {
            video.removeEventListener('playing', onPlaying);
            _hasVideoFrames = true;
            if (player._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
            const ph = document.querySelector('.video-placeholder');
            if (ph) ph.style.display = 'none';
            // Remove the unmute overlay if somehow it lingered
            document.getElementById('unmute-overlay')?.remove();
        };
        video.addEventListener('playing', onPlaying);

        // Video stall detection — if no frames render within 8s of getting tracks, re-watch
        if (!player._stallTimer && !_hasVideoFrames) {
            player._stallTimer = setTimeout(() => {
                player._stallTimer = null;
                if (player?.pc !== pc || _hasVideoFrames) return;
                // Check if video element is actually rendering
                if (video.videoWidth === 0 || video.paused || video.readyState < 2) {
                    console.warn('[Player] Video stall detected — no frames after 8s');
                    triggerRewatch('video stall — no frames rendered');
                }
            }, 8000);
        }

        tryPlay();
    };

    pc.onicecandidate = (e) => {
        // Use player.ws (not the passed ws param) so this works after WS reconnection
        if (e.candidate) {
            sendPlayerSignal({
                type: 'ice-candidate',
                candidate: e.candidate,
            });
        }
    };

    pc.oniceconnectionstatechange = () => {
        // Ignore state changes from a stale (replaced) PC
        if (!player || player.pc !== pc) return;
        console.log('[Player] ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            _iceConnected = true;
            if (player._iceTimeout) { clearTimeout(player._iceTimeout); player._iceTimeout = null; }
            return;
        }
        if (pc.iceConnectionState === 'failed') {
            if (player._iceTimeout) { clearTimeout(player._iceTimeout); player._iceTimeout = null; }
            triggerRewatch('ICE failed');
            return;
        }
        if (pc.iceConnectionState === 'disconnected') {
            setTimeout(() => {
                if (!player?.pc || player.pc !== pc) return;
                const state = pc.iceConnectionState;
                if (state === 'disconnected' || state === 'failed') {
                    triggerRewatch('ICE disconnected/failed after grace period');
                }
            }, 2500);
        }
        // 'disconnected' is transient and often recovers on its own — don't show error
        // 'closed' is handled by detaching handlers before close — no cascading re-watch
    };

    // Wrap SDP operations in try/catch — retry on failure instead of silent black screen
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Use player.ws (not the passed ws param) so this works after WS reconnection
        sendPlayerSignal({
            type: 'answer',
            sdp: answer,
        });
        console.log('[Player] Sent answer to broadcaster');
    } catch (sdpErr) {
        console.error('[Player] SDP negotiation failed:', sdpErr);
        // Close the failed PC and retry after a short delay
        pc.oniceconnectionstatechange = null;
        pc.ontrack = null;
        try { pc.close(); } catch {}
        if (player.pc === pc) player.pc = null;
        setTimeout(() => triggerRewatch('SDP negotiation failed'), 2000);
        return;
    }

    // ICE connection timeout — if not connected within 15s, something is stuck
    player._iceTimeout = setTimeout(() => {
        player._iceTimeout = null;
        if (!player || player.pc !== pc || _iceConnected) return;
        const state = pc.iceConnectionState;
        if (state !== 'connected' && state !== 'completed') {
            console.warn(`[Player] ICE timeout after 15s (state: ${state})`);
            triggerRewatch('ICE connection timeout');
        }
    }, 15000);
}

/* ── HLS / HTTP-FLV (RTMP transcoded) ──────────────────────────── */
function initHLS(endpoint, stream) {
    const video = document.getElementById('video-element');
    const placeholder = document.querySelector('.video-placeholder');

    const hlsUrl = endpoint.hls_url || endpoint.hlsUrl;
    const flvUrl = endpoint.flv_url || endpoint.flvUrl;

    if (!hlsUrl && !flvUrl) {
        showStreamError('RTMP stream endpoint not available. Ensure the RTMP server is running and your streaming software is connected.');
        return;
    }

    video.style.display = 'block';
    video.playsInline = true;
    video.preload = 'auto';
    if (placeholder) placeholder.style.display = 'none';
    playerType = 'hls';

    // Start clip recording when video begins playing (for any RTMP sub-method)
    const _startClipOnPlay = () => {
        video.removeEventListener('playing', _startClipOnPlay);
        try {
            const capturedStream = video.captureStream ? video.captureStream() :
                                   video.mozCaptureStream ? video.mozCaptureStream() : null;
            if (capturedStream) {
                startClipRecordingIfNeeded(capturedStream, streamRef?.id);
            } else {
                console.warn('[HLS] captureStream() not available — using canvas fallback for clips');
                // Canvas-based fallback: draw video frames to an offscreen canvas
                try {
                    const offCanvas = document.createElement('canvas');
                    offCanvas.width = video.videoWidth || 1280;
                    offCanvas.height = video.videoHeight || 720;
                    const ctx = offCanvas.getContext('2d');
                    if (!ctx) throw new Error('Unable to create fallback canvas context');
                    const fallbackStream = offCanvas.captureStream(30);

                    // Try to capture audio via captureStream on AudioContext
                    try {
                        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                        const source = audioCtx.createMediaElementSource(video);
                        const audioDest = audioCtx.createMediaStreamDestination();
                        source.connect(audioDest);
                        source.connect(audioCtx.destination); // keep audio audible
                        for (const track of audioDest.stream.getAudioTracks()) {
                            fallbackStream.addTrack(track);
                        }
                    } catch (audioErr) {
                        console.warn('[HLS] Audio capture fallback failed:', audioErr.message);
                    }

                    // Periodically draw video onto the offscreen canvas
                    let _canvasDrawInterval = setInterval(() => {
                        if (video.paused || video.ended) return;
                        if (video.videoWidth && video.videoHeight) {
                            offCanvas.width = video.videoWidth;
                            offCanvas.height = video.videoHeight;
                        }
                        ctx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
                    }, 33); // ~30fps
                    // Store cleanup ref
                    window._rtmpCanvasDrawInterval = _canvasDrawInterval;

                    startClipRecordingIfNeeded(fallbackStream, streamRef?.id);
                } catch (fallbackErr) {
                    console.warn('[HLS] Canvas fallback also failed:', fallbackErr.message);
                }
            }
        } catch (err) {
            console.warn('[HLS] Clip recording setup failed:', err.message);
        }
    };
    video.addEventListener('playing', _startClipOnPlay);

    // Try HLS first
    if (hlsUrl) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Native HLS (Safari)
            video.src = hlsUrl;
            video.play().catch(() => {});
            return;
        }

        if (typeof Hls !== 'undefined') {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 30,
                liveSyncDurationCount: 2,
                liveMaxLatencyDurationCount: 4,
                maxLiveSyncPlaybackRate: 1.5,
            });
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.warn('[HLS] Fatal error, trying HTTP-FLV fallback');
                    hls.destroy();
                    if (flvUrl) tryFlvPlayer(flvUrl, video);
                    else showStreamError('HLS stream not available yet. Make sure your RTMP software is streaming.');
                }
            });
            player = { hls, video };
            return;
        }

        // Load HLS.js dynamically
        loadExternalScriptOnce('https://cdn.jsdelivr.net/npm/hls.js@latest').then(() => {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 30,
                liveSyncDurationCount: 2,
                liveMaxLatencyDurationCount: 4,
                maxLiveSyncPlaybackRate: 1.5,
            });
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    hls.destroy();
                    if (flvUrl) tryFlvPlayer(flvUrl, video);
                    else showStreamError('HLS stream not ready. Make sure your RTMP software is streaming.');
                }
            });
            player = { hls, video };
        }).catch(() => {
            if (flvUrl) tryFlvPlayer(flvUrl, video);
            else showStreamError('HLS.js failed to load');
        });
    } else if (flvUrl) {
        tryFlvPlayer(flvUrl, video);
    }
}

function tryFlvPlayer(flvUrl, video) {
    // Attempt to play HTTP-FLV via flv.js if available
    if (typeof flvjs !== 'undefined' && flvjs.isSupported()) {
        const flvPlayer = flvjs.createPlayer(
            { type: 'flv', url: flvUrl, isLive: true },
            {
                enableStashBuffer: false,
                stashInitialSize: 128,
                lazyLoad: false,
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: 30,
                autoCleanupMinBackwardDuration: 10,
            }
        );
        flvPlayer.attachMediaElement(video);
        flvPlayer.load();
        flvPlayer.play();
        player = { flv: flvPlayer, video };
    } else {
        loadExternalScriptOnce('https://cdn.jsdelivr.net/npm/flv.js@latest').then(() => {
            if (flvjs.isSupported()) {
                const flvPlayer = flvjs.createPlayer(
                    { type: 'flv', url: flvUrl, isLive: true },
                    {
                        enableStashBuffer: false,
                        stashInitialSize: 128,
                        lazyLoad: false,
                        autoCleanupSourceBuffer: true,
                        autoCleanupMaxBackwardDuration: 30,
                        autoCleanupMinBackwardDuration: 10,
                    }
                );
                flvPlayer.attachMediaElement(video);
                flvPlayer.load();
                flvPlayer.play();
                player = { flv: flvPlayer, video };
            } else {
                showStreamError('Your browser does not support FLV playback');
            }
        }).catch(() => showStreamError('Failed to load FLV player'));
    }
}

/* ── DVR (Live Stream Seeking via Server-Side VOD) ───────────── */

/**
 * Initialize DVR capability for a live stream.
 * Checks if a server-side VOD recording exists, then enables seeking.
 */
async function initDVR(stream) {
    destroyDVR();
    const streamId = stream.id;

    // Parse stream start time for elapsed calculation
    let startedAt = stream.started_at || stream.created_at;
    if (startedAt) {
        if (typeof startedAt === 'string' && !startedAt.includes('T')) startedAt = startedAt.replace(' ', 'T') + 'Z';
        dvrState.streamStartTime = new Date(startedAt).getTime();
    } else {
        dvrState.streamStartTime = Date.now();
    }

    // Delay first check — give the broadcaster time to upload initial chunks
    dvrState.pollTimer = setTimeout(() => pollDVR(streamId), 5000);
}

/**
 * Poll the server for live VOD info and update DVR state.
 */
async function pollDVR(streamId) {
    try {
        const data = await api(`/vods/stream/${streamId}/live`);
        if (data && data.vod) {
            const vod = data.vod;
            dvrState.vodId = vod.id;
            if (vod.file_path) {
                dvrState.vodFilename = vod.file_path.split('/').pop();
            }

            // Fetch live-info for seekable status and duration
            try {
                const info = await api(`/vods/${vod.id}/live-info`);
                dvrState.duration = info.duration || 0;
                dvrState.seekable = info.seekable || false;
            } catch {}

            // Show DVR controls when we have a seekable copy
            if (dvrState.seekable && dvrState.vodFilename) {
                dvrState.active = true;
                showDVRControls();
            }
        }
    } catch {
        // No live VOD yet — normal for first ~30-60s
    }

    // Continue polling every 20s
    dvrState.pollTimer = setTimeout(() => pollDVR(streamId), 20000);
}

/**
 * Show the DVR progress bar and related controls.
 */
function showDVRControls() {
    const wrap = document.getElementById('dvr-progress-wrap');
    const timeEl = document.getElementById('dvr-time-display');
    const liveBtn = document.getElementById('dvr-live-btn');

    if (wrap) wrap.style.display = '';
    if (timeEl) timeEl.style.display = '';
    if (liveBtn) liveBtn.style.display = '';

    // Start UI update loop
    if (!dvrState.updateTimer) {
        dvrState.updateTimer = setInterval(updateDVRUI, 1000);
        updateDVRUI();
    }

    setupDVRSeek();
}

function _dvrFmtTime(s) {
    if (!s || isNaN(s) || !isFinite(s)) return '0:00';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Update the DVR progress bar and time display.
 */
function updateDVRUI() {
    if (!dvrState.active) return;

    const fill = document.getElementById('dvr-progress-fill');
    const timeEl = document.getElementById('dvr-time-display');
    const container = document.getElementById('video-container');

    if (dvrState.isLive) {
        // At live edge — progress bar is full (100%)
        if (fill) fill.style.width = '100%';
        const elapsed = dvrState.duration > 0
            ? dvrState.duration
            : Math.max(0, Math.floor((Date.now() - dvrState.streamStartTime) / 1000));
        if (timeEl) timeEl.textContent = `${_dvrFmtTime(elapsed)} [LIVE]`;
        if (container) container.classList.remove('dvr-rewound');
    } else {
        // Rewound — show position within the DVR buffer
        const video = document.getElementById('video-element');
        if (video && dvrState.duration > 0 && !dvrState.seeking) {
            const pct = (video.currentTime / dvrState.duration) * 100;
            if (fill) fill.style.width = Math.min(pct, 100) + '%';
            if (timeEl) timeEl.textContent = `${_dvrFmtTime(video.currentTime)} / ${_dvrFmtTime(dvrState.duration)}`;
        }
        if (container) container.classList.add('dvr-rewound');
    }
}

/**
 * Set up DVR seek bar interaction (click + drag).
 */
function setupDVRSeek() {
    const wrap = document.getElementById('dvr-progress-wrap');
    const fill = document.getElementById('dvr-progress-fill');
    const liveBtn = document.getElementById('dvr-live-btn');
    if (!wrap) return;

    // Prevent duplicate listeners
    if (wrap._dvrListenersAttached) return;
    wrap._dvrListenersAttached = true;

    const seekToPercent = (pct) => {
        if (!dvrState.seekable || dvrState.duration <= 0) return;
        const targetTime = pct * dvrState.duration;
        switchToDVR(targetTime);
    };

    wrap.addEventListener('click', (e) => {
        if (!dvrState.active || !dvrState.seekable) return;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        seekToPercent(pct);
    });

    // Drag to seek
    wrap.addEventListener('mousedown', (e) => {
        if (!dvrState.active || !dvrState.seekable) return;
        dvrState.seeking = true;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (fill) fill.style.width = pct * 100 + '%';
    });

    const onMove = (e) => {
        if (!dvrState.seeking) return;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (fill) fill.style.width = pct * 100 + '%';
    };
    const onUp = (e) => {
        if (!dvrState.seeking) return;
        dvrState.seeking = false;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        seekToPercent(pct);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    // Live button — jump back to real-time stream
    if (liveBtn) {
        liveBtn.onclick = () => jumpToLive();
    }
}

/**
 * Switch from real-time stream to server-side VOD for seeking.
 * Handles all three protocols: WebRTC (save srcObject), JSMPEG (hide canvas),
 * and HLS/RTMP (detach live player).
 * @param {number} targetTime - Seek position in seconds
 */
function switchToDVR(targetTime) {
    if (!dvrState.vodFilename || !dvrState.seekable) return;

    const video = document.getElementById('video-element');
    const canvas = document.getElementById('video-canvas');
    if (!video) return;

    const liveBtn = document.getElementById('dvr-live-btn');

    // Save the live state for later restoration
    if (dvrState.isLive) {
        if (playerType === 'webrtc' && video.srcObject) {
            dvrState.savedSrcObject = video.srcObject;
        } else if (playerType === 'jsmpeg') {
            // Pause JSMPEG player but keep it alive for quick restoration
            if (player && player.pause) player.pause();
            if (canvas) canvas.style.display = 'none';
        } else if (playerType === 'hls') {
            // Detach the HLS/FLV player from the video element
            dvrState.savedLivePlayer = player;
            if (player && player.hls) {
                try { player.hls.detachMedia(); } catch {}
            } else if (player && player.flv) {
                try { player.flv.pause(); player.flv.unload(); player.flv.detachMediaElement(); } catch {}
            }
        }
    }

    dvrState.isLive = false;

    // Show "Jump to Live" button in alert style
    if (liveBtn) {
        liveBtn.classList.add('dvr-behind');
        liveBtn.innerHTML = '<i class="fa-solid fa-forward"></i> Back to LIVE';
    }

    // Ensure the video element is visible (JSMPEG normally hides it)
    video.style.display = 'block';

    // Switch video source from live to HTTP VOD file
    video.srcObject = null;
    video.src = `/api/vods/file/${dvrState.vodFilename}?t=${Date.now()}`;

    video.addEventListener('loadedmetadata', function _seekOnLoad() {
        video.removeEventListener('loadedmetadata', _seekOnLoad);
        // Use server duration or video.duration, whichever is valid
        const dur = isFinite(video.duration) ? video.duration : dvrState.duration;
        video.currentTime = Math.min(targetTime, dur);
        video.play().catch(() => {});
    });

    console.log(`[DVR] Switched to VOD seeking at ${Math.round(targetTime)}s`);
}

/**
 * Jump back to the live (real-time) stream from DVR mode.
 * Handles all three protocols: WebRTC (restore srcObject),
 * JSMPEG (show canvas, resume player), HLS/RTMP (re-attach live player).
 */
function jumpToLive() {
    const video = document.getElementById('video-element');
    const canvas = document.getElementById('video-canvas');
    if (!video) return;

    const liveBtn = document.getElementById('dvr-live-btn');

    if (playerType === 'webrtc') {
        // Restore WebRTC MediaStream
        if (dvrState.savedSrcObject) {
            video.removeAttribute('src');
            video.srcObject = dvrState.savedSrcObject;
            video.play().catch(() => {});
        }
    } else if (playerType === 'jsmpeg') {
        // Switch back to the JSMPEG canvas player
        video.pause();
        video.removeAttribute('src');
        video.srcObject = null;
        video.style.display = 'none';
        if (canvas) canvas.style.display = 'block';
        if (player && player.play) player.play();
    } else if (playerType === 'hls') {
        // Re-attach HLS/FLV live player to the video element
        video.removeAttribute('src');
        video.srcObject = null;
        if (dvrState.savedLivePlayer) {
            if (dvrState.savedLivePlayer.hls) {
                try {
                    dvrState.savedLivePlayer.hls.attachMedia(video);
                    player = dvrState.savedLivePlayer;
                    video.play().catch(() => {});
                } catch (err) {
                    console.warn('[DVR] HLS re-attach failed, re-initializing:', err.message);
                    if (streamRef) initHLS(streamRef.endpoint || {}, streamRef);
                }
            } else if (dvrState.savedLivePlayer.flv) {
                try {
                    dvrState.savedLivePlayer.flv.attachMediaElement(video);
                    dvrState.savedLivePlayer.flv.load();
                    dvrState.savedLivePlayer.flv.play();
                    player = dvrState.savedLivePlayer;
                } catch (err) {
                    console.warn('[DVR] FLV re-attach failed, re-initializing:', err.message);
                    if (streamRef) initHLS(streamRef.endpoint || {}, streamRef);
                }
            }
        } else if (streamRef) {
            // Fallback: re-initialize the live player from scratch
            initHLS(streamRef.endpoint || {}, streamRef);
        }
    }

    dvrState.isLive = true;

    // Reset live button
    if (liveBtn) {
        liveBtn.classList.remove('dvr-behind');
        liveBtn.innerHTML = '<i class="fa-solid fa-tower-broadcast"></i> LIVE';
    }

    updateDVRUI();
    console.log('[DVR] Jumped back to live');
}

/**
 * Clean up DVR state and timers.
 */
function destroyDVR() {
    if (dvrState.pollTimer) { clearTimeout(dvrState.pollTimer); dvrState.pollTimer = null; }
    if (dvrState.updateTimer) { clearInterval(dvrState.updateTimer); dvrState.updateTimer = null; }
    dvrState.active = false;
    dvrState.isLive = true;
    dvrState.vodId = null;
    dvrState.vodFilename = null;
    dvrState.duration = 0;
    dvrState.seekable = false;
    dvrState.streamStartTime = 0;
    dvrState.savedSrcObject = null;
    dvrState.savedLivePlayer = null;
    dvrState.seeking = false;

    // Hide DVR UI elements
    const wrap = document.getElementById('dvr-progress-wrap');
    const timeEl = document.getElementById('dvr-time-display');
    const liveBtn = document.getElementById('dvr-live-btn');
    if (wrap) { wrap.style.display = 'none'; wrap._dvrListenersAttached = false; }
    if (timeEl) timeEl.style.display = 'none';
    if (liveBtn) liveBtn.style.display = 'none';
}

/* ── Player controls ──────────────────────────────────────────── */
function setupVideoControls() {
    const btnPlay = document.getElementById('btn-play-pause');
    const btnVol = document.getElementById('btn-volume');
    const volSlider = document.getElementById('volume-slider');
    const btnFull = document.getElementById('btn-fullscreen');

    // Restore persisted volume (or default 75)
    const savedVol = getSavedVolume();
    volSlider.value = savedVol;
    setVolume(savedVol / 100);

    let muted = savedVol === 0;
    let playing = true;

    // Sync mute button icon to initial state
    btnVol.innerHTML = muted
        ? '<i class="fa-solid fa-volume-xmark"></i>'
        : '<i class="fa-solid fa-volume-high"></i>';

    // Detect vertical (portrait) video and add CSS class for responsive layout
    const _detectVerticalVideo = () => {
        const vid = document.getElementById('video-element');
        const container = document.getElementById('video-container');
        if (!vid || !container) return;
        const w = vid.videoWidth;
        const h = vid.videoHeight;
        if (w > 0 && h > 0) {
            container.classList.toggle('is-vertical', h > w);
        }
    };
    const vid = document.getElementById('video-element');
    if (vid) {
        vid.addEventListener('loadedmetadata', _detectVerticalVideo);
        vid.addEventListener('resize', _detectVerticalVideo);

        // Sync local muted state when the browser auto-mutes for autoplay policy
        vid.addEventListener('volumechange', () => {
            const actuallyMuted = vid.muted || vid.volume === 0;
            if (actuallyMuted !== muted) {
                muted = actuallyMuted;
                btnVol.innerHTML = muted
                    ? '<i class="fa-solid fa-volume-xmark"></i>'
                    : '<i class="fa-solid fa-volume-high"></i>';
            }
        });
    }

    btnPlay.onclick = () => {
        playing = !playing;
        btnPlay.innerHTML = playing
            ? '<i class="fa-solid fa-pause"></i>'
            : '<i class="fa-solid fa-play"></i>';

        if (playerType === 'jsmpeg' && player && dvrState.isLive) {
            playing ? player.play() : player.pause();
        } else {
            const vid = document.getElementById('video-element');
            playing ? vid.play().catch(() => {}) : vid.pause();
        }
    };
    // Start showing pause icon since autoplay
    btnPlay.innerHTML = '<i class="fa-solid fa-pause"></i>';

    btnVol.onclick = () => {
        muted = !muted;
        btnVol.innerHTML = muted
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
        setVolume(muted ? 0 : volSlider.value / 100);
    };

    volSlider.oninput = () => {
        const v = volSlider.value / 100;
        setVolume(v);
        muted = v === 0;
        btnVol.innerHTML = muted
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
    };

    btnFull.onclick = () => {
        const container = document.getElementById('video-container');
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            container.requestFullscreen().catch(() => {});
        }
    };

    // Clip button
    document.getElementById('btn-clip').onclick = () => {
        if (!currentUser) return showModal('login');
        createLiveClip();
    };

    // Keyboard shortcuts for DVR seeking
    const container = document.getElementById('video-container');
    if (container) {
        container.tabIndex = 0;
        container.addEventListener('keydown', (e) => {
            if (!dvrState.active || !dvrState.seekable) return;
            const video = document.getElementById('video-element');
            if (!video) return;

            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    if (dvrState.isLive) {
                        // First rewind: jump to 10s before live edge
                        const pos = Math.max(0, dvrState.duration - 10);
                        switchToDVR(pos);
                    } else {
                        // Already in DVR — rewind 5 more seconds
                        const newTime = Math.max(0, video.currentTime - 5);
                        video.currentTime = newTime;
                        updateDVRUI();
                    }
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    if (!dvrState.isLive) {
                        const newTime = video.currentTime + 5;
                        if (newTime >= dvrState.duration - 2) {
                            jumpToLive();
                        } else {
                            video.currentTime = newTime;
                            updateDVRUI();
                        }
                    }
                    break;
            }
        });
    }
}

/* ── Clip Recording (rolling buffer with periodic cycling) ──── */
let _clipCycleTimer = null;
let _clipPrevSegment = null; // Backup from previous recorder cycle

function startClipRecording(stream, streamId) {
    stopClipRecording();
    clipStreamId = streamId;
    _startNewRecorderCycle(stream);

    // Cycle the recorder every CLIP_BUFFER_SECONDS to keep WebM cluster
    // timestamps fresh. Without cycling, a 2-hour stream produces clusters
    // timestamped at ~7200s — browsers can't play files with no data at t=0.
    _clipCycleTimer = setInterval(() => {
        _cycleClipRecorder(stream);
    }, CLIP_BUFFER_SECONDS * 1000);
}

function _startNewRecorderCycle(stream) {
    clipHeaderChunk = null;
    clipChunks = [];
    clipRecorderMimeType = null;
    clipTimingBaseMs = Date.now();

    try {
        const { recorder, mimeType } = createClipRecorder(stream);
        clipRecorder = recorder;
        clipRecorderMimeType = mimeType;
        const initialElapsedSeconds = getLiveStreamElapsedSeconds();
        clipTimingBaseMs = Date.now() - Math.round(initialElapsedSeconds * 1000);

        clipRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                const capturedAt = Date.now();
                const approxEndSeconds = Math.max(0, (capturedAt - clipTimingBaseMs) / 1000);
                const approxStartSeconds = Math.max(0, approxEndSeconds - 1);
                // The very first chunk contains the WebM EBML header + initialization
                // segment. We store it separately so the rolling window never discards it.
                if (!clipHeaderChunk) {
                    clipHeaderChunk = e.data;
                    console.log(`[Clip] Header chunk captured (${e.data.size} bytes)`);
                    return; // don't add to the timed buffer
                }
                clipChunks.push({
                    data: e.data,
                    time: capturedAt,
                    startStreamSeconds: approxStartSeconds,
                    endStreamSeconds: approxEndSeconds,
                });
                // Keep only last CLIP_BUFFER_SECONDS worth of data chunks
                const cutoff = capturedAt - (CLIP_BUFFER_SECONDS * 1000);
                clipChunks = clipChunks.filter(c => c.time >= cutoff);
            }
        };

        clipRecorder.onerror = (e) => {
            console.error('[Clip] MediaRecorder error:', e.error?.message || e);
        };

        // Record in 1-second intervals to fill the buffer
        clipRecorder.start(1000);
        console.log(`[Clip] Rolling buffer recording started (${mimeType}, tracks: ${stream.getTracks().map(t => t.kind).join(', ')})`);
    } catch (err) {
        console.warn('[Clip] MediaRecorder not available:', err.message);
    }
}

function _cycleClipRecorder(stream) {
    // Save current cycle as backup (so clips right after a cycle still have data)
    if (clipHeaderChunk && clipChunks.length) {
        _clipPrevSegment = {
            header: clipHeaderChunk,
            chunks: [...clipChunks],
            mimeType: clipRecorderMimeType,
        };
    }

    // Stop current recorder (triggers final ondataavailable)
    if (clipRecorder && clipRecorder.state !== 'inactive') {
        try { clipRecorder.stop(); } catch {}
    }

    // Start a fresh recorder with reset timestamps
    _startNewRecorderCycle(stream);
    console.log('[Clip] Recorder cycled — timestamps reset');
}

function stopClipRecording() {
    if (_clipCycleTimer) { clearInterval(_clipCycleTimer); _clipCycleTimer = null; }
    if (clipRecorder && clipRecorder.state !== 'inactive') {
        try { clipRecorder.stop(); } catch {}
    }
    clipRecorder = null;
    clipSourceStream = null;
    clipHeaderChunk = null;
    clipChunks = [];
    clipStreamId = null;
    clipRecorderMimeType = null;
    clipTimingBaseMs = 0;
    _clipPrevSegment = null;
}

let liveClipRequestInFlight = false;

function setClipButtonBusy(isBusy) {
    const btn = document.getElementById('btn-clip');
    if (!btn) return;
    btn.disabled = !!isBusy;
    btn.classList.toggle('is-busy', !!isBusy);
    btn.innerHTML = isBusy
        ? '<i class="fa-solid fa-spinner fa-spin"></i>'
        : '<i class="fa-solid fa-scissors"></i>';
}

async function createLiveClip() {
    if (liveClipRequestInFlight) {
        toast('A clip is already being created — please wait a moment', 'info');
        return;
    }

    // Use current cycle if it has enough data, otherwise fall back to previous
    let header = clipHeaderChunk;
    let chunks = clipChunks;
    let mimeType = clipRecorderMimeType;

    if ((!header || chunks.length < 3) && _clipPrevSegment) {
        header = _clipPrevSegment.header;
        chunks = _clipPrevSegment.chunks;
        mimeType = _clipPrevSegment.mimeType;
    }

    if (!header || !chunks.length || !clipStreamId) {
        toast('No clip data available yet — wait a moment', 'info');
        return;
    }

    toast('Creating clip...', 'info');
    liveClipRequestInFlight = true;
    setClipButtonBusy(true);

    try {
        // Assemble: header chunk first, then rolling buffer chunks.
        // The header contains the WebM EBML header + track initialization
        // which is required for the file to be playable.
        const blobs = [header, ...chunks.map(c => c.data)];
        const clipBlob = new Blob(blobs, { type: header.type || mimeType || 'video/webm' });

        const firstChunk = chunks[0];
        const lastChunk = chunks[chunks.length - 1];
        const startTime = Math.max(0, Math.floor(firstChunk.startStreamSeconds || 0));
        const endTime = Math.max(startTime + 1, Math.ceil(lastChunk.endStreamSeconds || startTime + chunks.length));
        const duration = Math.max(1, endTime - startTime);

        const formData = new FormData();
        formData.append('video', clipBlob, `clip-${Date.now()}.webm`);
        formData.append('stream_id', clipStreamId);
        formData.append('title', `Clip from stream`);
        formData.append('start_time', String(startTime));
        formData.append('end_time', String(endTime));

        const token = localStorage.getItem('token');
        const resp = await fetch('/api/vods/clips', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData,
        });

        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || 'Upload failed');
        }

        const data = await resp.json();
        const clipId = data.clip?.id;
        toast(`Clip created! (${Math.round(duration)}s) — Give it a title`, 'success');

        // Prompt user to title the clip
        if (clipId) {
            promptClipTitle(clipId);
        }
    } catch (err) {
        toast('Failed to create clip: ' + err.message, 'error');
    } finally {
        liveClipRequestInFlight = false;
        setClipButtonBusy(false);
    }
}

/**
 * Show a modal prompt for the user to title their clip after creation.
 * @param {number} clipId - The newly created clip's ID
 */
function promptClipTitle(clipId) {
    // Exit fullscreen first — the browser top layer hides body-appended overlays
    const showOverlay = () => {
        const overlay = document.createElement('div');
        overlay.id = 'clip-title-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
        _buildClipTitleModal(overlay, clipId);
    };
    if (document.fullscreenElement) {
        document.exitFullscreen().then(showOverlay).catch(showOverlay);
    } else {
        showOverlay();
    }
}

function _buildClipTitleModal(overlay, clipId) {
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--card-bg, #1a1a2e);border:1px solid var(--border, #333);border-radius:12px;padding:24px;max-width:400px;width:90%;text-align:center;';
    modal.innerHTML = `
        <h3 style="margin:0 0 8px 0"><i class="fa-solid fa-scissors"></i> Name Your Clip</h3>
        <p style="margin:0 0 16px 0;opacity:0.7;font-size:0.9rem">Give your clip a title so others know what it is</p>
        <input type="text" id="clip-title-input" class="form-input" placeholder="Enter clip title..."
               maxlength="200" style="width:100%;box-sizing:border-box;margin-bottom:16px;font-size:1rem;padding:10px 12px">
        <div style="display:flex;gap:8px;justify-content:center">
            <button id="clip-title-save" class="btn btn-primary" style="flex:1">
                <i class="fa-solid fa-check"></i> Save Title
            </button>
            <button id="clip-title-skip" class="btn" style="flex:0.6;opacity:0.7">
                Skip
            </button>
        </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = document.getElementById('clip-title-input');
    input.focus();

    const saveTitle = async () => {
        const title = input.value.trim();
        if (!title) {
            input.style.borderColor = '#e53e3e';
            input.placeholder = 'Please enter a title...';
            input.focus();
            return;
        }
        try {
            const token = localStorage.getItem('token');
            const resp = await fetch(`/api/clips/${clipId}/title`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ title }),
            });
            if (!resp.ok) throw new Error('Failed to save');
            toast('Clip titled!', 'success');
        } catch (err) {
            toast('Failed to save title: ' + err.message, 'error');
        }
        overlay.remove();
    };

    const skip = () => overlay.remove();

    document.getElementById('clip-title-save').onclick = saveTitle;
    document.getElementById('clip-title-skip').onclick = skip;
    input.onkeydown = (e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') skip(); };
    overlay.onclick = (e) => { if (e.target === overlay) skip(); };
}

function setVolume(v) {
    if (playerType === 'jsmpeg' && player && player.audioOut && dvrState.isLive) {
        player.audioOut.gain.value = v;
    } else {
        const vid = document.getElementById('video-element');
        vid.volume = v;
        vid.muted = v === 0;
    }
    // Persist volume so it survives page navigation / refresh
    try { localStorage.setItem('hobo_player_volume', String(Math.round(v * 100))); } catch {}
}

function getSavedVolume() {
    try {
        const v = parseInt(localStorage.getItem('hobo_player_volume'), 10);
        return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 75;
    } catch { return 75; }
}

/* ── Cleanup ──────────────────────────────────────────────────── */
function destroyPlayer() {
    stopClipRecording();
    destroyDVR();
    if (_jsmpegClipSetupTimer) {
        clearTimeout(_jsmpegClipSetupTimer);
        _jsmpegClipSetupTimer = null;
    }
    // Clean up RTMP canvas fallback interval
    if (window._rtmpCanvasDrawInterval) {
        clearInterval(window._rtmpCanvasDrawInterval);
        window._rtmpCanvasDrawInterval = null;
    }
    // Clean up JSMPEG offscreen canvas draw interval
    if (window._jsmpegDrawInterval) {
        clearInterval(window._jsmpegDrawInterval);
        window._jsmpegDrawInterval = null;
    }
    if (player) {
        if (playerType === 'jsmpeg' && player.destroy) player.destroy();
        if (playerType === 'webrtc') {
            if (player.pc) player.pc.close();
            if (player.ws) player.ws.close();
        }
        if (playerType === 'hls') {
            if (player.hls) player.hls.destroy();
            if (player.flv) { player.flv.pause(); player.flv.unload(); player.flv.detachMediaElement(); player.flv.destroy(); }
        }
        player = null;
    }
    playerType = null;
    streamRef = null;

    const canvas = document.getElementById('video-canvas');
    const video = document.getElementById('video-element');
    if (canvas) canvas.style.display = 'none';
    if (video) { video.style.display = 'none'; video.muted = false; video.srcObject = null; video.src = ''; }
    document.getElementById('unmute-overlay')?.remove();

    // Clean up VOD & Clip video elements so they stop playing on navigation
    for (const id of ['vp-video', 'clp-video']) {
        const el = document.getElementById(id);
        if (el) {
            el.pause();
            el.removeAttribute('src');
            el.load(); // forces the browser to release the media resource
            el.style.display = 'none';
        }
    }

    const placeholder = document.querySelector('.video-placeholder');
    if (placeholder) {
        placeholder.style.display = '';
        placeholder.innerHTML = `
            <i class="fa-solid fa-satellite-dish fa-3x"></i>
            <p>Connecting to stream...</p>`;
    }
}

function showStreamEnded() {
    const placeholder = document.querySelector('.video-placeholder');
    if (placeholder) {
        placeholder.style.display = '';
        placeholder.innerHTML = `
            <i class="fa-solid fa-campground fa-3x"></i>
            <p>Stream has ended</p>
            <p class="muted">Check back later!</p>`;
    }
    document.getElementById('video-canvas').style.display = 'none';
    document.getElementById('video-element').style.display = 'none';
}

function showStreamError(msg) {
    const placeholder = document.querySelector('.video-placeholder');
    if (placeholder) {
        placeholder.style.display = '';
        placeholder.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation fa-3x"></i>
            <p>${msg}</p>`;
    }
}

/**
 * Show a click-to-unmute overlay when autoplay policy forced muted playback.
 * One tap unmutes and removes the overlay.
 */
function showUnmuteOverlay(video) {
    // Don't duplicate
    if (document.getElementById('unmute-overlay')) return;
    const container = document.getElementById('video-container');
    if (!container) return;
    const overlay = document.createElement('div');
    overlay.id = 'unmute-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(0,0,0,0.35);';
    overlay.innerHTML = '<div style="background:rgba(0,0,0,0.7);padding:14px 28px;border-radius:10px;color:#fff;font-size:1.1rem;display:flex;align-items:center;gap:10px;"><i class="fa-solid fa-volume-xmark" style="font-size:1.4rem"></i> Tap to unmute</div>';
    overlay.addEventListener('click', () => {
        video.muted = false;
        // Restore volume from slider (in case autoplay set it to 0)
        const slider = document.getElementById('volume-slider');
        const vol = slider ? slider.value / 100 : 0.75;
        video.volume = vol;
        overlay.remove();
        // Sync the volume button + slider UI
        const volBtn = document.getElementById('btn-volume');
        if (volBtn) volBtn.innerHTML = vol === 0
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
    }, { once: true });
    container.appendChild(overlay);
}
