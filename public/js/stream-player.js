/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Stream Player (JSMPEG / WebRTC / HLS)
   ═══════════════════════════════════════════════════════════════ */

let player = null;
let playerType = null;

// mediasoup-client for SFU viewer consumption
let _mediasoupModulePromise = null;
let _mediasoupDevice = null;

async function loadMediasoupClient() {
    if (!_mediasoupModulePromise) {
        _mediasoupModulePromise = import('https://esm.sh/mediasoup-client@3.18.7');
        _mediasoupModulePromise.catch(() => { _mediasoupModulePromise = null; });
    }
    return _mediasoupModulePromise;
}

// Module-level failure counter — prevents infinite reconnect loops
let _totalIceFailures = 0;
const MAX_ICE_FAILURES = 25;

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
const PLAYER_VOLUME_KEY = 'hobo_player_volume';
const PLAYER_MUTED_KEY = 'hobo_player_muted';

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

/* ── Reconnecting indicator (overlay on video) ────────────────── */
function _showReconnectingIndicator() {
    if (document.getElementById('reconnecting-indicator')) return;
    const container = document.getElementById('video-container');
    if (!container) return;
    const el = document.createElement('div');
    el.id = 'reconnecting-indicator';
    el.style.cssText = 'position:absolute;top:12px;right:12px;z-index:25;background:rgba(0,0,0,0.7);color:#fbbf24;padding:6px 14px;border-radius:8px;font-size:0.85rem;display:flex;align-items:center;gap:8px;pointer-events:none;';
    el.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:0.9rem"></i> Reconnecting...';
    container.appendChild(el);
}

function _hideReconnectingIndicator() {
    document.getElementById('reconnecting-indicator')?.remove();
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

    // Check if JSMpeg lib is loaded (local copy preferred, CDN fallback)
    if (typeof JSMpeg === 'undefined') {
        loadExternalScriptOnce('/js/jsmpeg.min.js').then(() => {
            startJSMPEG(wsUrl, canvas, placeholder, bufferProfile);
        }).catch(() => {
            // Local copy failed — try CDN fallback
            console.warn('[Player] Local jsmpeg.min.js failed, trying CDN');
            loadExternalScriptOnce('https://jsmpeg.com/jsmpeg.min.js').then(() => {
                startJSMPEG(wsUrl, canvas, placeholder, bufferProfile);
            }).catch(() => {
                console.error('Failed to load JSMpeg library');
                placeholder.innerHTML = `
                    <i class="fa-solid fa-triangle-exclamation fa-3x"></i>
                    <p>JSMPEG player not available</p>
                    <p class="muted">Ensure jsmpeg.min.js is loaded</p>`;
            });
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
                console.log('[JSMPEG] Source established — applying saved volume and checking audio context');
                const audioPrefs = getSavedPlayerAudioState();
                if (player && player.audioOut && player.audioOut.gain) {
                    player.audioOut.gain.value = audioPrefs.muted ? 0 : audioPrefs.volume;
                }
                // Check if AudioContext is suspended (autoplay policy)
                const audioCtx = player?.audioOut?.context || player?.audioOut?.destination?.context;
                if (audioCtx && audioCtx.state === 'suspended' && !audioPrefs.muted) {
                    console.warn('[JSMPEG] AudioContext suspended — showing unmute overlay');
                    // Show unmute overlay on the canvas container
                    const container = document.getElementById('video-container');
                    if (container && !document.getElementById('unmute-overlay')) {
                        const overlay = document.createElement('div');
                        overlay.id = 'unmute-overlay';
                        overlay.style.cssText = 'position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(0,0,0,0.45);transition:background 0.2s;';
                        overlay.innerHTML = `
                            <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
                                <div style="width:72px;height:72px;border-radius:50%;background:rgba(255,255,255,0.15);border:2px solid rgba(255,255,255,0.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:transform 0.15s,background 0.15s;">
                                    <i class="fa-solid fa-play" style="font-size:1.8rem;color:#fff;margin-left:4px;"></i>
                                </div>
                                <span style="color:#fff;font-size:0.9rem;opacity:0.85;text-shadow:0 1px 4px rgba(0,0,0,0.6);">Click to enable audio</span>
                            </div>`;
                        overlay.addEventListener('click', () => {
                            audioCtx.resume().then(() => {
                                console.log('[JSMPEG] AudioContext resumed by user click');
                            }).catch(() => {});
                            overlay.remove();
                        }, { once: true });
                        container.appendChild(overlay);
                    }
                }

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

        // Status phase tracking — shown in placeholder so viewer knows what's happening
        const _updateStatus = (text) => {
            if (placeholder && placeholder.style.display !== 'none') {
                placeholder.innerHTML = `
                    <i class="fa-solid fa-satellite-dish fa-3x"></i>
                    <p>${text}</p>`;
            }
        };
        _updateStatus('Connecting to stream...');

        // Connect to the broadcast signaling relay as a viewer
        const host = window.location.hostname;
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const portSuffix = window.location.port ? `:${window.location.port}` : '';
        const token = localStorage.getItem('token') || '';
        const wsUrl = `${protocol}://${host}${portSuffix}/ws/broadcast?streamId=${streamRef.id}&role=viewer&token=${token}`;

        const ws = new WebSocket(wsUrl);
        player = { ws, video, pc: null, myPeerId: null, watchSent: false, _wsUrl: wsUrl, _serverIceServers: null };
        let _broadcasterDisconnectTimer = null;
        let _viewerReconnectTimer = null;
        let _viewerReconnectDelay = 3000; // exponential backoff: 3s → 30s max
        let _viewerIntentionalClose = false;
        let _viewerRewatchTimer = null;
        let _watchOfferTimer = null; // timeout: sent 'watch' but never got 'offer'
        let _rewatchCount = 0;
        const MAX_REWATCH_ATTEMPTS = 12;

        // Start a timer when 'watch' is sent — if no 'offer' arrives within 6s, re-watch
        const startWatchOfferTimeout = () => {
            if (_watchOfferTimer) clearTimeout(_watchOfferTimer);
            _watchOfferTimer = setTimeout(() => {
                _watchOfferTimer = null;
                if (!player || _viewerIntentionalClose) return;
                // Check total ICE failure cap first
                if (_totalIceFailures >= MAX_ICE_FAILURES) {
                    console.error('[Player] Too many total ICE failures — stream may require a TURN server');
                    showStreamError('Could not establish media connection. Your network may be blocking WebRTC traffic.');
                    return;
                }
                // No offer received — broadcaster may be unresponsive
                if (_rewatchCount < MAX_REWATCH_ATTEMPTS) {
                    console.warn(`[Player] No offer received within 6s (attempt ${_rewatchCount + 1}/${MAX_REWATCH_ATTEMPTS})`);
                    _updateStatus('Waiting for broadcaster response...');
                    scheduleViewerRewatch(500);
                } else {
                    console.error('[Player] Max rewatch attempts reached — stream may be unavailable');
                    showStreamError('Stream is not responding. Try refreshing the page.');
                }
            }, 6000);
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
            _updateStatus('Connected — waiting for broadcaster...');
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
                        // Store server-provided ICE servers (includes TURN if configured)
                        if (msg.iceServers && Array.isArray(msg.iceServers)) {
                            player._serverIceServers = msg.iceServers;
                        }
                        console.log('[Player] Welcome, peerId:', msg.peerId, 'iceServers:', (player._serverIceServers || []).length);
                        _updateStatus('Connected — waiting for broadcaster...');
                        // Don't send watch here — wait for broadcaster-ready
                        break;
                    case 'broadcaster-ready':
                        // Broadcaster connected/reconnected — request to watch
                        console.log('[Player] Broadcaster ready, requesting watch');
                        _updateStatus('Broadcaster found — negotiating...');
                        // Cancel any pending rewatch timer (prevents double-watch race)
                        if (_viewerRewatchTimer) { clearTimeout(_viewerRewatchTimer); _viewerRewatchTimer = null; }
                        // Cancel any pending disconnect grace timer
                        if (_broadcasterDisconnectTimer) {
                            clearTimeout(_broadcasterDisconnectTimer);
                            _broadcasterDisconnectTimer = null;
                        }
                        // Reset retry count — broadcaster is back
                        _rewatchCount = 0;
                        // Hide reconnecting indicator if shown
                        _hideReconnectingIndicator();
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
                        // Broadcaster sent us an offer (P2P path) — create answer
                        console.log('[Player] Received offer from broadcaster');
                        _updateStatus('Connecting media...');
                        // Clear the watch-to-offer timeout — offer received successfully
                        if (_watchOfferTimer) { clearTimeout(_watchOfferTimer); _watchOfferTimer = null; }
                        _rewatchCount = 0; // reset retry count on successful offer
                        _hideReconnectingIndicator();
                        // Clear any stale error overlay — we got a valid offer
                        _clearStreamError();
                        await handleViewerOffer(msg, player.ws, video);
                        break;
                    case 'sfu-viewer-ready':
                        // Server has SFU producers — use mediasoup-client RecvTransport
                        console.log('[Player] SFU viewer ready — starting mediasoup-client flow');
                        _updateStatus('Connecting media...');
                        if (_watchOfferTimer) { clearTimeout(_watchOfferTimer); _watchOfferTimer = null; }
                        _rewatchCount = 0;
                        _hideReconnectingIndicator();
                        _clearStreamError();
                        await handleSfuViewerReady(msg, player.ws, video, _updateStatus, scheduleViewerRewatch);
                        break;
                    case 'ice-candidate':
                        // ICE candidate from broadcaster
                        if (player.pc && msg.candidate) {
                            await player.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        }
                        break;
                    case 'broadcaster-disconnected':
                        console.log('[Player] Broadcaster signaling disconnected — media may still be active');
                        // Show a subtle indicator — the WebRTC PeerConnection is independent
                        // of the signaling WS so video likely still works
                        _showReconnectingIndicator();
                        // Start a grace timer matching the server's 60s disconnect window.
                        // Only show "ended" if both the signaling AND PeerConnection are dead.
                        if (_broadcasterDisconnectTimer) clearTimeout(_broadcasterDisconnectTimer);
                        _broadcasterDisconnectTimer = setTimeout(() => {
                            _broadcasterDisconnectTimer = null;
                            // Check if PeerConnection is still delivering media
                            const pcState = player?.pc?.iceConnectionState;
                            if (pcState === 'connected' || pcState === 'completed') {
                                // PC still working — don't show "ended", just log
                                console.log('[Player] Broadcaster signaling gone but PC still connected, waiting...');
                                return;
                            }
                            console.log('[Player] Broadcaster did not reconnect and PC is dead, stream ended');
                            _hideReconnectingIndicator();
                            showStreamEnded();
                        }, 60000);
                        break;
                    case 'stream-ended':
                        console.log('[Player] Stream ended by server');
                        if (_broadcasterDisconnectTimer) clearTimeout(_broadcasterDisconnectTimer);
                        _hideReconnectingIndicator();
                        _viewerIntentionalClose = true; // don't reconnect on explicit end
                        showStreamEnded();
                        break;
                    case 'viewer-count':
                        const vcEl = document.getElementById('vc-viewers');
                        const extVc = (typeof _cachedExternalViewerCount === 'number') ? _cachedExternalViewerCount : 0;
                        if (typeof _cachedHsViewerCount !== 'undefined') _cachedHsViewerCount = msg.count || 0;
                        if (vcEl) vcEl.textContent = (msg.count || 0) + extVc;
                        break;
                }
            } catch (err) {
                console.error('[Player] Message error:', err);
            }
        };

        ws.onerror = () => {
            console.error('[Player] Broadcast signaling error');
            _updateStatus('Connection error — retrying...');
        };

        ws.onclose = (ev) => {
            console.log(`[Player] Broadcast signaling closed (code=${ev.code})`);
            if (_viewerIntentionalClose) return;
            _updateStatus('Reconnecting to server...');
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

    // Use server-provided ICE servers (with TURN support) if available, else fallback to STUN-only
    const iceServers = (player._serverIceServers && player._serverIceServers.length > 0)
        ? player._serverIceServers
        : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
        ];

    const pc = new RTCPeerConnection({ iceServers });
    player.pc = pc;
    let _iceConnected = false;
    let _hasVideoFrames = false;
    let _playPending = false; // debounce play() across multiple ontrack events

    // Schedules a re-watch if the current PC is still ours
    const triggerRewatch = (reason) => {
        if (!player || player.pc !== pc) return;
        // Track ICE failures separately — these never reset (prevents infinite loop)
        if (reason.includes('ICE') || reason.includes('stall') || reason.includes('SDP')) {
            _totalIceFailures++;
            console.log(`[Player] Re-watching: ${reason} (ICE failures: ${_totalIceFailures}/${MAX_ICE_FAILURES})`);
            if (_totalIceFailures >= MAX_ICE_FAILURES) {
                console.error('[Player] Too many ICE/connection failures — giving up');
                showStreamError('Could not establish media connection. Your network may be blocking WebRTC traffic. Try a different network or refresh the page.');
                return;
            }
        } else {
            console.log(`[Player] Re-watching: ${reason}`);
        }
        player.watchSent = false;
        sendPlayerSignal({ type: 'watch' });
        player.watchSent = true;
        // Start watch-to-offer timeout for this re-watch too
        if (player._startWatchOfferTimeout) player._startWatchOfferTimeout();
    };

    // Debounced play() — always starts muted (guaranteed autoplay), then unmutes if allowed.
    // Previous approach tried unmuted first, hit NotAllowedError, then retried muted — but the
    // muted retry could also fail with AbortError if the first play() was still settling,
    // leading to "Playback failed even muted" and no frames ever rendering.
    const tryPlay = () => {
        if (_playPending || !player || player.pc !== pc) return;
        _playPending = true;
        if (player._playRetryTimer) { clearTimeout(player._playRetryTimer); player._playRetryTimer = null; }

        // Always start muted — this is the only way to guarantee autoplay across all browsers.
        // We unmute after playback starts if the user hasn't muted.
        video.muted = true;
        video.volume = 1;

        video.play().then(() => {
            _playPending = false;
            console.log('[Player] Playback started (muted autoplay)');

            // Now try to unmute based on user prefs
            const audioPrefs = getSavedPlayerAudioState();
            if (!audioPrefs.muted) {
                video.volume = Math.max(0.01, audioPrefs.volume);
                video.muted = false;
                // If unmuting fails (autoplay policy), show overlay
                // Some browsers will pause on unmute — re-play muted if needed
                const playPromise = video.play();
                if (playPromise) {
                    playPromise.catch(() => {
                        video.muted = true;
                        video.play().catch(() => {});
                        showUnmuteOverlay(video);
                    });
                }
            } else {
                video.volume = 0;
                // Already muted — remove stale overlay if present
                document.getElementById('unmute-overlay')?.remove();
            }
        }).catch((err) => {
            _playPending = false;
            if (err.name === 'AbortError') {
                // play() interrupted — retry after a tick (second ontrack can cause this)
                console.log('[Player] play() interrupted, retrying in 300ms');
                player._playRetryTimer = setTimeout(() => {
                    player._playRetryTimer = null;
                    _playPending = false;
                    tryPlay();
                }, 300);
            } else {
                console.warn('[Player] Muted play() failed:', err.name, err.message);
                // Retry once after short delay — video element may not have enough data yet
                player._playRetryTimer = setTimeout(() => {
                    player._playRetryTimer = null;
                    _playPending = false;
                    tryPlay();
                }, 1000);
            }
        });
    };

    let _trackCount = 0; // count received tracks — only tryPlay after both video+audio arrive

    pc.ontrack = (e) => {
        _trackCount++;
        console.log('[Player] Got remote track:', e.track.kind, `(${_trackCount} total)`);
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

        // Register the playing event listener for EACH new PC (fresh _hasVideoFrames each time)
        if (_trackCount === 1) {
            const onPlaying = () => {
                video.removeEventListener('playing', onPlaying);
                _hasVideoFrames = true;
                if (player._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
                const ph = document.querySelector('.video-placeholder');
                if (ph) {
                    ph.style.display = 'none';
                    ph.innerHTML = `
                        <i class="fa-solid fa-satellite-dish fa-3x"></i>
                        <p>Connecting to stream...</p>`;
                }
                // Only remove unmute overlay if video is actually playing with audio
                if (!video.muted) {
                    document.getElementById('unmute-overlay')?.remove();
                }
            };
            video.addEventListener('playing', onPlaying);
        }

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

        // Delay tryPlay until we have at least 2 tracks (video + audio) or 500ms
        // after first track (handles audio-only/video-only streams).
        // This prevents the first tryPlay() from racing with the second ontrack
        // which causes AbortError on the first play() call.
        if (_trackCount >= 2) {
            tryPlay();
        } else if (_trackCount === 1) {
            player._playRetryTimer = setTimeout(() => {
                player._playRetryTimer = null;
                _playPending = false;
                tryPlay();
            }, 500);
        }
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
            // If the stall timer is already running and no frames yet, restart it from ICE-connected
            // time — ICE negotiation itself can take several seconds, so the 8s clock should start
            // from when media can actually flow, not from when ontrack fired.
            if (player._stallTimer && !_hasVideoFrames) {
                clearTimeout(player._stallTimer);
                player._stallTimer = setTimeout(() => {
                    player._stallTimer = null;
                    if (player?.pc !== pc || _hasVideoFrames) return;
                    if (video.videoWidth === 0 || video.paused || video.readyState < 2) {
                        console.warn('[Player] Video stall detected — no frames after ICE connected + 8s');
                        triggerRewatch('video stall — no frames after ICE connect');
                    }
                }, 8000);
            }
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

    // ICE connection timeout — if not connected within 10s, something is stuck
    player._iceTimeout = setTimeout(() => {
        player._iceTimeout = null;
        if (!player || player.pc !== pc || _iceConnected) return;
        const state = pc.iceConnectionState;
        if (state !== 'connected' && state !== 'completed') {
            console.warn(`[Player] ICE timeout after 10s (state: ${state})`);
            triggerRewatch('ICE connection timeout');
        }
    }, 10000);
}

/* ── SFU Viewer via mediasoup-client (replaces hand-built SDP) ── */
async function handleSfuViewerReady(msg, ws, video, updateStatus, scheduleRewatch) {
    if (!player) return;

    // Clean up old PC if any (from P2P fallback or previous SFU attempt)
    if (player.pc) {
        const oldPc = player.pc;
        oldPc.oniceconnectionstatechange = null;
        oldPc.ontrack = null;
        oldPc.onicecandidate = null;
        try { oldPc.close(); } catch {}
        player.pc = null;
    }
    if (player._iceTimeout) { clearTimeout(player._iceTimeout); player._iceTimeout = null; }
    if (player._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
    if (player._playRetryTimer) { clearTimeout(player._playRetryTimer); player._playRetryTimer = null; }
    // Close previous SFU recv transport
    if (player._sfuRecvTransport) {
        try { player._sfuRecvTransport.close(); } catch {}
        player._sfuRecvTransport = null;
    }

    const { rtpCapabilities, producers } = msg;
    if (!rtpCapabilities || !producers?.length) {
        console.warn('[Player] sfu-viewer-ready missing capabilities or producers');
        scheduleRewatch(2000);
        return;
    }

    try {
        // Step 1: Load mediasoup-client
        updateStatus('Loading media engine...');
        const mod = await loadMediasoupClient();
        const { Device } = mod;
        if (!Device) throw new Error('mediasoup-client Device not available');

        // Step 2: Create and load Device with router capabilities
        const device = new Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        _mediasoupDevice = device;

        // Step 3: Request a recv transport from the server
        updateStatus('Creating media transport...');
        const transportParams = await _sfuViewerRequest(ws, 'sfu-viewer-create-transport', 'sfu-viewer-transport-created');

        // Step 4: Create the local RecvTransport
        const recvTransport = device.createRecvTransport({
            id: transportParams.id,
            iceParameters: transportParams.iceParameters,
            iceCandidates: transportParams.iceCandidates,
            dtlsParameters: transportParams.dtlsParameters,
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        player._sfuRecvTransport = recvTransport;

        // Wire transport 'connect' event — mediasoup-client fires this when DTLS needs to start
        recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            sendPlayerSignal({
                type: 'sfu-viewer-connect-transport',
                transportId: recvTransport.id,
                dtlsParameters,
            });
            // Wait for server confirmation
            _sfuViewerWaitFor(ws, 'sfu-viewer-transport-connected')
                .then(() => callback())
                .catch(errback);
        });

        recvTransport.on('connectionstatechange', (state) => {
            console.log(`[Player] SFU recv transport state: ${state}`);
            if (state === 'failed' || state === 'closed') {
                _totalIceFailures++;
                if (_totalIceFailures < MAX_ICE_FAILURES) {
                    console.warn(`[Player] SFU transport ${state}, re-watching`);
                    player.watchSent = false;
                    sendPlayerSignal({ type: 'watch' });
                    player.watchSent = true;
                    if (player._startWatchOfferTimeout) player._startWatchOfferTimeout();
                } else {
                    showStreamError('Could not establish media connection. Try refreshing.');
                }
            }
        });

        // Step 5: Consume each producer
        updateStatus('Receiving media...');
        const mediaStream = new MediaStream();
        let _hasVideoFrames = false;
        let _playPending = false;

        const tryPlay = () => {
            if (_playPending || !player) return;
            _playPending = true;
            if (player._playRetryTimer) { clearTimeout(player._playRetryTimer); player._playRetryTimer = null; }
            video.muted = true;
            video.volume = 1;

            console.log(`[Player] tryPlay() — video state: readyState=${video.readyState} videoWidth=${video.videoWidth} paused=${video.paused} srcObject tracks=${video.srcObject?.getTracks().length || 0}`);

            video.play().then(() => {
                _playPending = false;
                console.log(`[Player] SFU playback started (muted) — readyState=${video.readyState} videoWidth=${video.videoWidth}`);
                const audioPrefs = getSavedPlayerAudioState();
                if (!audioPrefs.muted) {
                    video.volume = Math.max(0.01, audioPrefs.volume);
                    video.muted = false;
                    const p = video.play();
                    if (p) p.catch(() => {
                        video.muted = true;
                        video.play().catch(() => {});
                        showUnmuteOverlay(video);
                    });
                } else {
                    video.volume = 0;
                    document.getElementById('unmute-overlay')?.remove();
                }
            }).catch((err) => {
                _playPending = false;
                console.warn(`[Player] play() failed: ${err.name}: ${err.message} — readyState=${video.readyState} videoWidth=${video.videoWidth} networkState=${video.networkState}`);
                if (err.name === 'AbortError') {
                    player._playRetryTimer = setTimeout(() => {
                        player._playRetryTimer = null;
                        _playPending = false;
                        tryPlay();
                    }, 300);
                } else {
                    player._playRetryTimer = setTimeout(() => {
                        player._playRetryTimer = null;
                        _playPending = false;
                        tryPlay();
                    }, 1000);
                }
            });
        };

        let consumedCount = 0;
        for (const prod of producers) {
            const consumerParams = await _sfuViewerRequest(ws, 'sfu-viewer-consume', 'sfu-viewer-consumed', {
                transportId: recvTransport.id,
                producerId: prod.id,
                rtpCapabilities: device.rtpCapabilities,
            });

            const consumer = await recvTransport.consume({
                id: consumerParams.id,
                producerId: consumerParams.producerId,
                kind: consumerParams.kind,
                rtpParameters: consumerParams.rtpParameters,
            });

            mediaStream.addTrack(consumer.track);
            console.log(`[Player] SFU consumed ${consumer.kind} track — enabled=${consumer.track.enabled} muted=${consumer.track.muted} readyState=${consumer.track.readyState} paused=${consumer.paused} id=${consumer.id}`);

            // Monitor track health
            consumer.track.addEventListener('ended', () => {
                console.warn(`[Player] SFU ${consumer.kind} track ended`);
                if (player?._sfuRecvTransport === recvTransport) {
                    player.watchSent = false;
                    sendPlayerSignal({ type: 'watch' });
                    player.watchSent = true;
                    if (player._startWatchOfferTimeout) player._startWatchOfferTimeout();
                }
            }, { once: true });

            consumer.track.addEventListener('mute', () => {
                console.warn(`[Player] SFU ${consumer.kind} track muted`);
            });
            consumer.track.addEventListener('unmute', () => {
                console.log(`[Player] SFU ${consumer.kind} track unmuted — data flowing`);
            });

            consumedCount++;
        }

        // Set video source
        video.srcObject = mediaStream;
        video.style.display = 'block';
        startClipRecordingIfNeeded(mediaStream, streamRef?.id);

        // Log MediaStream state
        const tracks = mediaStream.getTracks();
        console.log(`[Player] MediaStream set — active=${mediaStream.active} tracks=${tracks.length} (${tracks.map(t => `${t.kind}:${t.readyState}:enabled=${t.enabled}:muted=${t.muted}`).join(', ')})`);

        // Playing event — hide placeholder
        const onPlaying = () => {
            video.removeEventListener('playing', onPlaying);
            _hasVideoFrames = true;
            if (player?._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
            console.log(`[Player] SFU video playing! videoWidth=${video.videoWidth} videoHeight=${video.videoHeight}`);
            const ph = document.querySelector('.video-placeholder');
            if (ph) {
                ph.style.display = 'none';
                ph.innerHTML = `<i class="fa-solid fa-satellite-dish fa-3x"></i><p>Connecting to stream...</p>`;
            }
            if (!video.muted) document.getElementById('unmute-overlay')?.remove();
        };
        video.addEventListener('playing', onPlaying);

        // Stall detection
        if (!_hasVideoFrames) {
            player._stallTimer = setTimeout(() => {
                player._stallTimer = null;
                if (!player || player._sfuRecvTransport !== recvTransport || _hasVideoFrames) return;
                // Log comprehensive video element state for debugging
                const streamTracks = video.srcObject?.getTracks() || [];
                const trackInfo = streamTracks.map(t => `${t.kind}:${t.readyState}:enabled=${t.enabled}:muted=${t.muted}`).join(', ');
                console.warn(`[Player] SFU video stall — no frames after 8s | readyState=${video.readyState} videoWidth=${video.videoWidth} paused=${video.paused} currentTime=${video.currentTime.toFixed(2)} networkState=${video.networkState} error=${video.error?.message || 'none'} srcObjectActive=${video.srcObject?.active} tracks=[${trackInfo}] transportState=${recvTransport.connectionState}`);
                if (video.videoWidth === 0 || video.paused || video.readyState < 2) {
                    player.watchSent = false;
                    sendPlayerSignal({ type: 'watch' });
                    player.watchSent = true;
                    if (player._startWatchOfferTimeout) player._startWatchOfferTimeout();
                }
            }, 8000);
        }

        // Start playback after all tracks consumed
        if (consumedCount >= 2) {
            tryPlay();
        } else {
            player._playRetryTimer = setTimeout(() => {
                player._playRetryTimer = null;
                _playPending = false;
                tryPlay();
            }, 500);
        }

        console.log(`[Player] SFU viewer consuming ${consumedCount} track(s)`);

    } catch (err) {
        console.error('[Player] SFU viewer setup failed:', err);
        // Fall back to re-watch (will try SFU again or P2P)
        _totalIceFailures++;
        if (_totalIceFailures < MAX_ICE_FAILURES) {
            scheduleRewatch(2000);
        } else {
            showStreamError('Could not establish media connection. Try refreshing.');
        }
    }
}

/**
 * Send a signaling message and wait for a specific response type.
 * Returns the response message payload.
 */
function _sfuViewerRequest(ws, sendType, expectType, extra = {}) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for ${expectType}`));
        }, 10000);

        const handler = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === expectType) {
                    cleanup();
                    resolve(msg);
                } else if (msg.type === 'sfu-viewer-error') {
                    cleanup();
                    reject(new Error(msg.error || 'SFU viewer error'));
                }
            } catch {}
        };

        const cleanup = () => {
            clearTimeout(timeout);
            ws.removeEventListener('message', handler);
        };

        ws.addEventListener('message', handler);
        sendPlayerSignal({ type: sendType, ...extra });
    });
}

/**
 * Wait for a specific message type on the WS (no sending).
 */
function _sfuViewerWaitFor(ws, expectType) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for ${expectType}`));
        }, 10000);

        const handler = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === expectType) {
                    cleanup();
                    resolve(msg);
                } else if (msg.type === 'sfu-viewer-error') {
                    cleanup();
                    reject(new Error(msg.error || 'SFU viewer error'));
                }
            } catch {}
        };

        const cleanup = () => {
            clearTimeout(timeout);
            ws.removeEventListener('message', handler);
        };

        ws.addEventListener('message', handler);
    });
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
    const audioPrefs = getSavedPlayerAudioState();
    const savedVol = Math.round(audioPrefs.volume * 100);
    volSlider.value = savedVol;
    // For WebRTC, tryPlay() in handleViewerOffer sets volume + handles autoplay policy.
    // For JSMPEG, onSourceEstablished handles it. For HLS, set it here.
    if (playerType === 'hls') {
        setVolume(savedVol / 100, { muted: audioPrefs.muted });
    }

    let muted = audioPrefs.muted;
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
        setVolume(muted ? 0 : volSlider.value / 100, { muted, persistLevel: !muted });
        // User interacted — remove unmute overlay if unmuting
        if (!muted) {
            const vid = document.getElementById('video-element');
            if (vid && vid.muted) { vid.muted = false; vid.play().catch(() => {}); }
            document.getElementById('unmute-overlay')?.remove();
        }
    };

    volSlider.oninput = () => {
        const v = volSlider.value / 100;
        setVolume(v, { muted: v === 0 });
        muted = v === 0;
        btnVol.innerHTML = muted
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
        // User interacted — remove unmute overlay and ensure unmuted
        if (v > 0) {
            const vid = document.getElementById('video-element');
            if (vid && vid.muted) { vid.muted = false; vid.play().catch(() => {}); }
            document.getElementById('unmute-overlay')?.remove();
        }
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
let _clipCycleGen = 0;      // Generation counter — prevents stale recorder events from corrupting state

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
    const gen = ++_clipCycleGen;
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
            // Ignore events from a stale recorder that was stopped during a cycle.
            // Without this guard, the old recorder's final ondataavailable fires
            // asynchronously AFTER _startNewRecorderCycle resets clipHeaderChunk,
            // causing a data chunk to be stored as the "header" (corrupt EBML).
            if (gen !== _clipCycleGen) return;

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
    _clipCycleGen++; // invalidate any pending ondataavailable from the stopped recorder
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

    // Client-side EBML header validation — first 4 bytes must be 1A 45 DF A3.
    // If the header chunk is corrupt (e.g. a stale data chunk), fall back to
    // the previous segment before the server rejects it.
    if (header && header.size >= 4) {
        try {
            const headerBytes = new Uint8Array(await header.slice(0, 4).arrayBuffer());
            const validEbml = headerBytes[0] === 0x1A && headerBytes[1] === 0x45
                           && headerBytes[2] === 0xDF && headerBytes[3] === 0xA3;
            if (!validEbml) {
                console.warn('[Clip] Current header chunk has invalid EBML magic — falling back to previous segment');
                if (_clipPrevSegment && _clipPrevSegment.header) {
                    const prevBytes = new Uint8Array(await _clipPrevSegment.header.slice(0, 4).arrayBuffer());
                    const prevValid = prevBytes[0] === 0x1A && prevBytes[1] === 0x45
                                   && prevBytes[2] === 0xDF && prevBytes[3] === 0xA3;
                    if (prevValid) {
                        header = _clipPrevSegment.header;
                        chunks = _clipPrevSegment.chunks;
                        mimeType = _clipPrevSegment.mimeType;
                    } else {
                        toast('Clip data is temporarily corrupt — please try again in a few seconds', 'warning');
                        return;
                    }
                } else {
                    toast('Clip data is temporarily corrupt — please try again in a few seconds', 'warning');
                    return;
                }
            }
        } catch (ebmlErr) {
            console.warn('[Clip] EBML validation failed:', ebmlErr.message);
        }
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
        // Always use 'video/webm' — MediaRecorder on all platforms produces WebM,
        // but some browsers set Blob.type to codec-qualified strings or empty,
        // which can trip the server's MIME filter.
        const clipBlob = new Blob(blobs, { type: 'video/webm' });

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
            let errMsg = 'Upload failed';
            try { const err = await resp.json(); errMsg = err.error || errMsg; } catch { errMsg = `Server error (${resp.status})`; }
            throw new Error(errMsg);
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
        <input type="text" id="live-clip-title-input" class="form-input" placeholder="Enter clip title..."
               maxlength="200" style="width:100%;box-sizing:border-box;margin-bottom:16px;font-size:1rem;padding:10px 12px">
        <div style="display:flex;gap:8px;justify-content:center">
            <button id="live-clip-title-save" class="btn btn-primary" style="flex:1">
                <i class="fa-solid fa-check"></i> Save Title
            </button>
            <button id="live-clip-title-skip" class="btn" style="flex:0.6;opacity:0.7">
                Skip
            </button>
        </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = document.getElementById('live-clip-title-input');
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

    document.getElementById('live-clip-title-save').onclick = saveTitle;
    document.getElementById('live-clip-title-skip').onclick = skip;
    input.onkeydown = (e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') skip(); };
    overlay.onclick = (e) => { if (e.target === overlay) skip(); };
}

function setVolume(v) {
    const options = arguments[1] || {};
    const volume = Math.max(0, Math.min(1, Number(v) || 0));
    const muted = options.muted ?? (volume === 0);
    if (playerType === 'jsmpeg' && player && player.audioOut && dvrState.isLive) {
        player.audioOut.gain.value = muted ? 0 : volume;
    } else {
        const vid = document.getElementById('video-element');
        if (vid) {
            vid.volume = muted ? 0 : volume;
            vid.muted = muted;
        }
    }
    try {
        if (options.persistLevel !== false) localStorage.setItem(PLAYER_VOLUME_KEY, String(Math.round(volume * 100)));
        localStorage.setItem(PLAYER_MUTED_KEY, muted ? '1' : '0');
    } catch {}
}

function getSavedVolume() {
    try {
        const v = parseInt(localStorage.getItem(PLAYER_VOLUME_KEY), 10);
        return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 75;
    } catch { return 75; }
}

function getSavedMuted() {
    try {
        return localStorage.getItem(PLAYER_MUTED_KEY) === '1';
    } catch {
        return false;
    }
}

function getSavedPlayerAudioState() {
    return {
        volume: getSavedVolume() / 100,
        muted: getSavedMuted(),
    };
}

/* ── Cleanup ──────────────────────────────────────────────────── */
function destroyPlayer() {
    stopClipRecording();
    destroyDVR();
    _hideReconnectingIndicator();
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
    if (video) { video.style.display = 'none'; video.muted = false; video.srcObject = null; video.removeAttribute('src'); }
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
    _hideReconnectingIndicator();
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
            <p>${msg}</p>
            <button onclick="this.parentElement.style.display='none'" style="margin-top:8px;padding:6px 18px;border-radius:8px;border:1px solid var(--border);background:var(--bg-hover);color:var(--text-primary);cursor:pointer;font-size:0.85rem;">Dismiss</button>`;
    }
}

/** Clear stream error and reset placeholder to default connecting state */
function _clearStreamError() {
    const placeholder = document.querySelector('.video-placeholder');
    if (!placeholder) return;
    // Only clear if it's currently showing an error (has the warning icon)
    if (placeholder.innerHTML.includes('fa-triangle-exclamation')) {
        placeholder.style.display = 'none';
        placeholder.innerHTML = `
            <i class="fa-solid fa-satellite-dish fa-3x"></i>
            <p>Connecting to stream...</p>`;
    }
}

/**
 * Show a click-to-play overlay when autoplay policy forced muted playback.
 * One tap unmutes, restores volume, and removes the overlay.
 */
function showUnmuteOverlay(video) {
    // Don't duplicate
    if (document.getElementById('unmute-overlay')) return;
    const container = document.getElementById('video-container');
    if (!container) return;
    const overlay = document.createElement('div');
    overlay.id = 'unmute-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(0,0,0,0.45);transition:background 0.2s;';
    overlay.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
            <div style="width:72px;height:72px;border-radius:50%;background:rgba(255,255,255,0.15);border:2px solid rgba(255,255,255,0.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:transform 0.15s,background 0.15s;">
                <i class="fa-solid fa-play" style="font-size:1.8rem;color:#fff;margin-left:4px;"></i>
            </div>
            <span style="color:#fff;font-size:0.9rem;opacity:0.85;text-shadow:0 1px 4px rgba(0,0,0,0.6);">Click to enable audio</span>
        </div>`;
    // Hover effect on the play circle
    const circle = overlay.querySelector('div > div');
    overlay.addEventListener('mouseenter', () => { if (circle) { circle.style.transform = 'scale(1.1)'; circle.style.background = 'rgba(255,255,255,0.25)'; } });
    overlay.addEventListener('mouseleave', () => { if (circle) { circle.style.transform = ''; circle.style.background = ''; } });
    overlay.addEventListener('click', () => {
        video.muted = false;
        // Restore volume from saved preference / slider
        const slider = document.getElementById('volume-slider');
        const savedVol = getSavedVolume();
        const vol = savedVol > 0 ? savedVol / 100 : (slider ? slider.value / 100 : 0.75);
        video.volume = vol;
        if (slider) slider.value = Math.round(vol * 100);
        try { localStorage.setItem(PLAYER_MUTED_KEY, '0'); } catch {}
        overlay.remove();
        // Sync the volume button icon
        const volBtn = document.getElementById('btn-volume');
        if (volBtn) volBtn.innerHTML = vol === 0
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
        // Try playing again now that user has interacted
        video.play().catch(() => {});
    }, { once: true });
    container.appendChild(overlay);
}
