/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Chat Client (WebSocket)
   ═══════════════════════════════════════════════════════════════ */

let chatWs = null;
let chatStreamId = null;
let chatRenderTargetId = null;

// ── Chat mode (Global / Voice Call) ──────────────────────────
let chatMode = 'global'; // 'global' or 'voice'

// ── Floating chat widget state ───────────────────────────────
let _fcwOpen = false;
let _fcwUnread = 0;
let _fcwDragging = false;
let _fcwDragOffset = { x: 0, y: 0 };

// ── Background broadcast chat ────────────────────────────────
// When the user is broadcasting and navigates away, the chat WS
// is kept alive in the background so TTS messages still play.
let _bgBroadcastWs = null;
let _bgBroadcastStreamId = null;

// ── Chat auto-reconnect state ────────────────────────────────
let _chatReconnectTimer = null;
let _chatReconnectDelay = 2000;
const CHAT_RECONNECT_BASE = 2000;
const CHAT_RECONNECT_MAX = 30000;
let _chatIntentionalClose = false;
let _chatActive = false; // true whenever we have an active/desired chat connection (including global)
let _chatIsReconnecting = false; // true during auto-reconnect to prevent clearing messages

// ── Voice-call invite overlays + sounds ─────────────────────
let _incomingVcCall = null;
let _incomingVcCallTimeout = null;
let _outgoingVcCall = null;
let _vcRingLoopTimer = null;
let _vcAudioCtx = null;

// ── Cross-feed: secondary global WS for piping messages into stream chat ──
let _globalFeedWs = null;
let _globalFeedReconnectTimer = null;
let _globalFeedReconnectDelay = 3000;
const _GLOBAL_FEED_RECONNECT_MAX = 20000;

// ── Slow mode state ─────────────────────────────────────────
let chatSlowModeSeconds = 0;
let chatSlowModeCooldownTimer = null;
let chatSlowModeCooldownEnd = 0;

// ── Reply-to state ──────────────────────────────────────────
let _chatReplyTo = null; // { id, username, user_id, message }

// ── Chat settings (persisted to localStorage) ────────────────
const CHAT_SETTINGS_KEY = 'hobo_chat_settings';
const CHAT_SETTINGS_DEFAULTS = {
    // Appearance
    showTimestamps: false,
    timestampFormat: '12h',       // '12h' or '24h'
    fontSize: 'default',          // 'small', 'default', 'large'
    showAvatars: true,
    showBadges: true,
    readableColors: false,        // Force minimum contrast on name colors
    alternateBackground: false,   // Zebra-stripe messages
    // Emotes
    animatedEmotes: true,         // Show animated/GIF emotes
    emoteScale: 'default',        // 'small', 'default', 'large'
    // Behavior
    showDeletedMessages: false,   // Show <deleted> instead of hiding
    showSystemMessages: true,     // Join/part/system messages
    mentionHighlight: true,       // Highlight messages containing your @name
    autoScroll: true,             // Auto-scroll to bottom on new messages
    autoDeleteMinutes: 0,         // Auto-delete your own new messages after N minutes (0 = off)
    // Notifications
    flashOnMention: true,         // Flash browser tab on @mention
    soundOnMention: false,        // Play a sound on @mention
    // Widget
    showFloatingChat: true,       // Show floating global chat button on non-chat pages
    fullscreenOverlayChat: true,  // Show OBS-style chat overlay in fullscreen live player
    // Cross-feed — show messages from other sources while in a stream chat
    showGlobalInStream: false,    // Show global chat messages in stream chat
    showAllStreamsInStream: false, // Show messages from ALL live streams in stream chat
    // TTS
    ttsEnabled: false,            // TTS toggle for regular pages (off by default)
    streamingTtsEnabled: true,    // Separate TTS toggle while broadcasting live
    ttsVolume: 80,                // TTS volume (0–100)
    // Per-source TTS — which relay platforms contribute to TTS
    ttsSrcNative: true,           // Native HoboStreamer chat
    ttsSrcRS: true,               // RobotStreamer relay
    ttsSrcKick: true,             // Kick relay
    ttsSrcYoutube: true,          // YouTube relay
    ttsSrcTwitch: true,           // Twitch relay
};
let chatSettings = { ...CHAT_SETTINGS_DEFAULTS };
let chatSettingsPanelOpen = false;
const CHAT_SELF_DELETE_MINUTES = 3;
let chatSelfDeletePolicy = {
    allowAutoDelete: true,
    allowDeleteAll: true,
    minMinutes: CHAT_SELF_DELETE_MINUTES,
};
let chatSlurPolicy = {
    enabled: false,
    useBuiltin: true,
    disabledCategories: [],
    terms: [],
    regexes: [],
    message: '',
    announcedForKey: null,
};
const CHAT_CORE_SLUR_CATEGORIES = [
    { key: 'n_word',      label: 'N-word and variants',        patterns: ['\\bn+i+g+g+(?:a+|e+r+)\\b', '\\bk?n+i+c?k+e+r+\\b'] },
    { key: 'antisemitic', label: 'Antisemitic slurs',          patterns: ['\\bk+\\s*y+\\s*k+\\s*e+\\b', '\\bj+\\s*e+\\s*w+\\s*s?\\s+w+\\s*i+\\s*l+\\s*l+\\s+n+\\s*o+\\s*t+\\s+r+\\s*e+\\s*p+\\s*l+\\s*a+\\s*c+\\s*e+\\b'] },
    { key: 'homophobic',  label: 'Homophobic slurs',           patterns: ['\\bf+\\s*a+\\s*g+(?:o+\\s*t+)?\\b'] },
    { key: 'racial',      label: 'Racial slurs (spic, chink)', patterns: ['\\bs+\\s*p+\\s*i+\\s*c+\\b', '\\bc+\\s*h+\\s*i+\\s*n+\\s*k+\\b'] },
];
for (const cat of CHAT_CORE_SLUR_CATEGORIES) {
    cat.compiled = cat.patterns.map((src) => { try { return new RegExp(src, 'i'); } catch { return null; } }).filter(Boolean);
}
const FULLSCREEN_CHAT_IDLE_MS = 2600;
const FULLSCREEN_CHAT_FADE_MS = 9000;
const FULLSCREEN_CHAT_MAX_MESSAGES = 7;
let _fullscreenChatIdleTimer = null;
let _fullscreenChatRecent = [];

function normalizeChatAutoDeleteMinutes(value) {
    const minutes = parseInt(value, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return Math.max(CHAT_SELF_DELETE_MINUTES, minutes);
}

function canUseViewerAutoDeleteHere() {
    return !chatStreamId || !!chatSelfDeletePolicy.allowAutoDelete;
}

function canUseViewerDeleteAllHere() {
    return !chatStreamId || !!chatSelfDeletePolicy.allowDeleteAll;
}

function loadChatSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY));
        if (saved) chatSettings = { ...CHAT_SETTINGS_DEFAULTS, ...saved };
    } catch { /* use defaults */ }
    chatSettings.autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
}
function saveChatSettings() {
    chatSettings.autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
    try { localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings)); } catch {}
    applyChatSettings();
}

function _vcEnsureAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!_vcAudioCtx) {
        try { _vcAudioCtx = new Ctx(); } catch { return null; }
    }
    if (_vcAudioCtx.state === 'suspended') {
        _vcAudioCtx.resume().catch(() => {});
    }
    return _vcAudioCtx;
}

function _vcPlayTone(frequency, durationMs = 150, { type = 'sine', gain = 0.05, delayMs = 0 } = {}) {
    const ctx = _vcEnsureAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime + (delayMs / 1000);
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0001), now + 0.02);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + (durationMs / 1000));

    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + (durationMs / 1000) + 0.03);
}

function _vcPlayPattern(steps) {
    let offset = 0;
    for (const step of steps) {
        if (step.freq) {
            _vcPlayTone(step.freq, step.ms || 140, {
                type: step.type || 'sine',
                gain: step.gain ?? 0.055,
                delayMs: offset,
            });
        }
        offset += step.ms || 0;
        offset += step.pause || 0;
    }
    return offset;
}

function _vcStopRingLoop() {
    if (_vcRingLoopTimer) {
        clearInterval(_vcRingLoopTimer);
        _vcRingLoopTimer = null;
    }
}

function _vcStartIncomingRing() {
    _vcStopRingLoop();
    const pattern = [
        { freq: 740, ms: 130, pause: 70, gain: 0.065 },
        { freq: 988, ms: 170, pause: 820, gain: 0.075 },
    ];
    const loopMs = _vcPlayPattern(pattern) + 40;
    _vcRingLoopTimer = setInterval(() => _vcPlayPattern(pattern), loopMs);
}

function _vcStartOutgoingRingback() {
    _vcStopRingLoop();
    const pattern = [
        { freq: 440, ms: 150, pause: 90, gain: 0.05 },
        { freq: 440, ms: 150, pause: 900, gain: 0.05 },
    ];
    const loopMs = _vcPlayPattern(pattern) + 40;
    _vcRingLoopTimer = setInterval(() => _vcPlayPattern(pattern), loopMs);
}

function _vcPlayAcceptedTone() {
    _vcPlayPattern([
        { freq: 523, ms: 110, pause: 40, gain: 0.06 },
        { freq: 659, ms: 130, pause: 30, gain: 0.06 },
        { freq: 784, ms: 180, gain: 0.06 },
    ]);
}

function _vcPlayDeclinedTone() {
    _vcPlayPattern([
        { freq: 370, ms: 150, pause: 60, gain: 0.06, type: 'triangle' },
        { freq: 262, ms: 220, gain: 0.06, type: 'triangle' },
    ]);
}

function _dismissIncomingVcCallOverlay() {
    if (_incomingVcCall?.el?.parentNode) _incomingVcCall.el.parentNode.removeChild(_incomingVcCall.el);
    _incomingVcCall = null;
    if (_incomingVcCallTimeout) {
        clearTimeout(_incomingVcCallTimeout);
        _incomingVcCallTimeout = null;
    }
    _vcStopRingLoop();
}

function _dismissOutgoingVcCallOverlay() {
    if (_outgoingVcCall?.el?.parentNode) _outgoingVcCall.el.parentNode.removeChild(_outgoingVcCall.el);
    _outgoingVcCall = null;
    _vcStopRingLoop();
}

function _showOutgoingVcCallOverlay(targetName, targetUserId, channelId, channelName) {
    _dismissOutgoingVcCallOverlay();

    const safeTargetName = esc(targetName || 'User');
    const overlay = document.createElement('div');
    overlay.className = 'vc-call-toast-overlay vc-call-toast-outgoing';
    overlay.innerHTML = `
        <div class="vc-call-toast-card">
            <div class="vc-call-toast-ring"></div>
            <div class="vc-call-toast-main">
                <div class="vc-call-toast-title">Calling ${safeTargetName}</div>
                <div class="vc-call-toast-subtitle" data-vc-call-status>Ringing...</div>
            </div>
            <button class="vc-call-toast-action vc-call-toast-cancel" type="button" data-vc-cancel-call>
                <i class="fa-solid fa-xmark"></i>
                Cancel
            </button>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('[data-vc-cancel-call]')?.addEventListener('click', () => {
        _dismissOutgoingVcCallOverlay();
        toast('Call canceled', 'info');
    });

    _outgoingVcCall = {
        el: overlay,
        statusEl: overlay.querySelector('[data-vc-call-status]'),
        targetUserId: Number(targetUserId) || 0,
        targetName,
        channelId: String(channelId || ''),
        channelName: channelName || 'Voice Channel',
    };

    _vcStartOutgoingRingback();
}

function _setOutgoingVcCallStatus(text, tone = null, autoDismissMs = 1800) {
    if (!_outgoingVcCall) return;
    if (_outgoingVcCall.statusEl) _outgoingVcCall.statusEl.textContent = text;
    _vcStopRingLoop();
    if (tone === 'accepted') _vcPlayAcceptedTone();
    if (tone === 'declined') _vcPlayDeclinedTone();
    if (autoDismissMs > 0) {
        setTimeout(() => {
            _dismissOutgoingVcCallOverlay();
        }, autoDismissMs);
    }
}

async function _sendVcCallResponse({ callerUserId, channelId, channelName, status }) {
    if (!callerUserId || !channelId || !status) return;
    try {
        await api('/streams/voice-channels/call-user/respond', {
            method: 'POST',
            body: {
                caller_user_id: Number(callerUserId),
                channel_id: String(channelId),
                channel_name: String(channelName || 'Voice Channel'),
                status: String(status),
            },
        });
    } catch {
        // Non-fatal. Joining/declining should still continue client-side.
    }
}

function _showIncomingVcCallOverlay(msg) {
    const callerUserId = Number(msg.fromUserId || 0);
    const channelId = String(msg.channelId || '');
    if (!callerUserId || !channelId) return;

    if (typeof callState !== 'undefined' && callState.joined && callState.channelId !== channelId) {
        _sendVcCallResponse({
            callerUserId,
            channelId,
            channelName: msg.channelName || 'Voice Channel',
            status: 'busy',
        });
        if (typeof toast === 'function') toast(`${msg.fromDisplayName || msg.fromUsername || 'Someone'} tried to call you`, 'info');
        return;
    }

    _dismissIncomingVcCallOverlay();

    const callerName = esc(msg.fromDisplayName || msg.fromUsername || 'Someone');
    const channelName = esc(String(msg.channelName || 'Voice Channel'));
    const avatarUrl = msg.fromAvatarUrl ? esc(String(msg.fromAvatarUrl)) : '';

    const overlay = document.createElement('div');
    overlay.className = 'vc-call-overlay';
    overlay.innerHTML = `
        <div class="vc-call-card">
            <div class="vc-call-ring"></div>
            <div class="vc-call-avatar-wrap">
                ${avatarUrl ? `<img class="vc-call-avatar" src="${avatarUrl}" alt="${callerName}">` : '<div class="vc-call-avatar vc-call-avatar-fallback"><i class="fa-solid fa-user"></i></div>'}
            </div>
            <div class="vc-call-heading">Incoming Call</div>
            <div class="vc-call-caller">${callerName}</div>
            <div class="vc-call-channel">${channelName}</div>
            <div class="vc-call-actions">
                <button type="button" class="vc-call-btn vc-call-btn-decline" data-vc-decline>
                    <i class="fa-solid fa-phone-slash"></i>
                    Decline
                </button>
                <button type="button" class="vc-call-btn vc-call-btn-accept" data-vc-accept>
                    <i class="fa-solid fa-phone"></i>
                    Accept
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    _incomingVcCall = {
        el: overlay,
        callerUserId,
        callerName: msg.fromDisplayName || msg.fromUsername || 'Someone',
        channelId,
        channelName: msg.channelName || 'Voice Channel',
    };

    overlay.querySelector('[data-vc-decline]')?.addEventListener('click', async () => {
        const state = _incomingVcCall;
        _dismissIncomingVcCallOverlay();
        if (!state) return;
        await _sendVcCallResponse({
            callerUserId: state.callerUserId,
            channelId: state.channelId,
            channelName: state.channelName,
            status: 'declined',
        });
        toast('Call declined', 'info');
    });

    overlay.querySelector('[data-vc-accept]')?.addEventListener('click', async () => {
        const state = _incomingVcCall;
        _dismissIncomingVcCallOverlay();
        if (!state) return;
        await _sendVcCallResponse({
            callerUserId: state.callerUserId,
            channelId: state.channelId,
            channelName: state.channelName,
            status: 'accepted',
        });
        await acceptVcInvite(state.channelId, state.channelName);
    });

    _incomingVcCallTimeout = setTimeout(async () => {
        const state = _incomingVcCall;
        _dismissIncomingVcCallOverlay();
        if (!state) return;
        await _sendVcCallResponse({
            callerUserId: state.callerUserId,
            channelId: state.channelId,
            channelName: state.channelName,
            status: 'no-answer',
        });
    }, 30000);

    _vcStartIncomingRing();
}

function _handleVcCallResponse(msg) {
    if (!_outgoingVcCall) return;
    const expectedUser = Number(_outgoingVcCall.targetUserId || 0);
    const fromUser = Number(msg.fromUserId || 0);
    if (expectedUser && fromUser && expectedUser !== fromUser) return;
    if (_outgoingVcCall.channelId && msg.channelId && _outgoingVcCall.channelId !== msg.channelId) return;

    const who = msg.fromDisplayName || msg.fromUsername || _outgoingVcCall.targetName || 'User';
    const status = String(msg.status || '').toLowerCase();
    if (status === 'accepted') {
        _setOutgoingVcCallStatus(`${who} accepted`, 'accepted', 1400);
        if (typeof toast === 'function') toast(`${who} accepted your call`, 'success');
        return;
    }
    if (status === 'busy') {
        _setOutgoingVcCallStatus(`${who} is busy`, 'declined', 2000);
        if (typeof toast === 'function') toast(`${who} is already in another call`, 'info');
        return;
    }
    if (status === 'no-answer') {
        _setOutgoingVcCallStatus(`No answer from ${who}`, 'declined', 2200);
        if (typeof toast === 'function') toast(`${who} did not answer`, 'info');
        return;
    }
    _setOutgoingVcCallStatus(`${who} declined`, 'declined', 1800);
    if (typeof toast === 'function') toast(`${who} declined your call`, 'error');
}

function bindContainedChatScroll() {
    const selectors = [
        '.chat-sidebar',
        '.global-chat-main',
        '.offline-global-chat',
        '.chat-messages',
        '.global-chat-messages',
        '.fullscreen-chat-messages',
        '.chat-users-panel',
        '.rewards-panel',
    ];

    document.querySelectorAll(selectors.join(', ')).forEach(el => {
        if (!el || el.dataset.scrollContainBound === '1') return;
        el.dataset.scrollContainBound = '1';

        const containScroll = (deltaY, event) => {
            const canScroll = el.scrollHeight > (el.clientHeight + 1);
            if (!canScroll) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const atTop = el.scrollTop <= 0;
            const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight;
            if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
                event.preventDefault();
            }
            event.stopPropagation();
        };

        el.addEventListener('wheel', (event) => {
            if (Math.abs(event.deltaY) >= Math.abs(event.deltaX || 0)) {
                containScroll(event.deltaY, event);
            }
        }, { passive: false });

        let lastTouchY = null;
        el.addEventListener('touchstart', (event) => {
            if (event.touches && event.touches.length) {
                lastTouchY = event.touches[0].clientY;
            }
        }, { passive: true });
        el.addEventListener('touchmove', (event) => {
            if (!event.touches || !event.touches.length || lastTouchY == null) return;
            const currentY = event.touches[0].clientY;
            const deltaY = lastTouchY - currentY;
            lastTouchY = currentY;
            containScroll(deltaY, event);
        }, { passive: false });
        el.addEventListener('touchend', () => { lastTouchY = null; }, { passive: true });
        el.addEventListener('touchcancel', () => { lastTouchY = null; }, { passive: true });
    });
}

function applyChatSettings() {
    bindContainedChatScroll();
    // Font size
    document.querySelectorAll('.chat-messages, .global-chat-messages').forEach(el => {
        el.classList.remove('chat-font-small', 'chat-font-large');
        if (chatSettings.fontSize === 'small') el.classList.add('chat-font-small');
        if (chatSettings.fontSize === 'large') el.classList.add('chat-font-large');
    });
    // Animated emotes
    document.documentElement.classList.toggle('chat-no-animated-emotes', !chatSettings.animatedEmotes);
    // Emote scale
    document.documentElement.classList.remove('chat-emote-small', 'chat-emote-large');
    if (chatSettings.emoteScale === 'small') document.documentElement.classList.add('chat-emote-small');
    if (chatSettings.emoteScale === 'large') document.documentElement.classList.add('chat-emote-large');
    // Avatars
    document.documentElement.classList.toggle('chat-hide-avatars', !chatSettings.showAvatars);
    // Badges
    document.documentElement.classList.toggle('chat-hide-badges', !chatSettings.showBadges);
    // Alternate backgrounds
    document.documentElement.classList.toggle('chat-alt-bg', chatSettings.alternateBackground);
    // System messages
    document.documentElement.classList.toggle('chat-hide-system', !chatSettings.showSystemMessages);
    // Sync all settings panel checkboxes/selects if any are open
    syncSettingsPanelUI();
    updateFullscreenChatOverlayState();
}
function syncSettingsPanelUI() {
    document.querySelectorAll('.chat-settings-panel').forEach(panel => {
        panel.querySelectorAll('[data-setting]').forEach(el => {
            const key = el.dataset.setting;
            if (el.type === 'checkbox') el.checked = chatSettings[key];
            else if (el.type === 'range') el.value = chatSettings[key];
            else if (el.tagName === 'SELECT') el.value = chatSettings[key];
        });

        const autoDeleteSelect = panel.querySelector('[data-setting="autoDeleteMinutes"]');
        if (autoDeleteSelect) {
            autoDeleteSelect.disabled = !canUseViewerAutoDeleteHere();
        }

        const deleteBtn = panel.querySelector('.csp-delete-own-btn');
        if (deleteBtn) {
            deleteBtn.disabled = !canUseViewerDeleteAllHere();
            deleteBtn.title = canUseViewerDeleteAllHere()
                ? 'Delete all of your messages from this chat'
                : 'Disabled by the streamer for this chat';
        }

        const hint = panel.querySelector('.csp-self-delete-hint');
        if (hint) {
            const scopeLabel = chatStreamId ? 'this stream chat' : 'global chat';
            if (!chatStreamId) {
                hint.textContent = `Applies to your own new messages in ${scopeLabel}. Minimum ${chatSelfDeletePolicy.minMinutes} minutes.`;
            } else if (!canUseViewerAutoDeleteHere() && !canUseViewerDeleteAllHere()) {
                hint.textContent = 'This streamer has disabled viewer self-delete tools in this chat.';
            } else if (!canUseViewerAutoDeleteHere()) {
                hint.textContent = 'Manual delete-all is allowed here, but auto-delete timers are disabled by the streamer.';
            } else if (!canUseViewerDeleteAllHere()) {
                hint.textContent = `Auto-delete is allowed here, but manual delete-all is disabled by the streamer. Minimum ${chatSelfDeletePolicy.minMinutes} minutes.`;
            } else {
                hint.textContent = `Applies to your own new messages in ${scopeLabel}. Minimum ${chatSelfDeletePolicy.minMinutes} minutes.`;
            }
        }
    });
    syncTTSToggleButtons();
}

function isBroadcastingLiveForTTS() {
    return typeof isStreaming === 'function' && isStreaming();
}

function getChatTTSSettingKey(options = {}) {
    if (options.button) {
        const inBroadcastPage = !!options.button.closest('#page-broadcast');
        if (inBroadcastPage && isBroadcastingLiveForTTS()) return 'streamingTtsEnabled';
    }
    if (options.streaming || options.forceStreaming || options.page === 'broadcast') {
        return 'streamingTtsEnabled';
    }
    return 'ttsEnabled';
}

function isChatTTSEnabled(options = {}) {
    const key = getChatTTSSettingKey(options);
    return !!chatSettings[key];
}

/** Returns true if TTS should fire for a message with the given source_platform string */
function _isTTSEnabledForSource(sourcePlatform) {
    const src = (sourcePlatform || '').toLowerCase();
    if (!src || src === 'native' || src === 'hobostreamer') return chatSettings.ttsSrcNative !== false;
    if (src === 'rs' || src === 'robotstreamer') return chatSettings.ttsSrcRS !== false;
    if (src === 'kick') return chatSettings.ttsSrcKick !== false;
    if (src === 'youtube') return chatSettings.ttsSrcYoutube !== false;
    if (src === 'twitch') return chatSettings.ttsSrcTwitch !== false;
    return true; // unknown source: allow by default
}

function refreshChatTTSContext() {
    syncTTSToggleButtons();
    syncSettingsPanelUI();
}
// Initialize on load
loadChatSettings();

// ── Context menu state ───────────────────────────────────────
let activeContextMenu = null;

/**
 * Detect which chat UI is active (channel page vs broadcast page vs global chat page vs offline)
 * and return the correct input + messages container elements.
 */
function getChatEl() {
    // Global chat page
    const chatPage = document.getElementById('page-chat');
    if (chatPage && chatPage.classList.contains('active')) {
        return {
            input: document.getElementById('global-chat-input'),
            messages: document.getElementById('global-chat-messages'),
            isGlobal: true,
        };
    }
    // Offline channel page with global chat — only if the channel page is actually active
    const channelPage = document.getElementById('page-channel');
    if (channelPage && channelPage.classList.contains('active')) {
        const offlineArea = document.getElementById('ch-offline-area');
        if (offlineArea && offlineArea.style.display !== 'none') {
            const offlineChat = document.getElementById('offline-chat-messages');
            if (offlineChat) {
                return {
                    input: document.getElementById('offline-chat-input'),
                    messages: offlineChat,
                    isGlobal: true,
                };
            }
        }
    }
    const bcPage = document.getElementById('page-broadcast');
    const isBroadcast = bcPage && bcPage.classList.contains('active');
    if (isBroadcast) {
        return {
            input: document.getElementById('bc-chat-input'),
            messages: document.getElementById('bc-chat-messages'),
        };
    }
    return {
        input: document.getElementById('chat-input'),
        messages: document.getElementById('chat-messages'),
    };
}

function getChatRenderTargetId() {
    return getChatEl().messages?.id || null;
}

function getFullscreenChatEls() {
    return {
        container: document.getElementById('video-container'),
        overlay: document.getElementById('fullscreen-chat-overlay'),
        messages: document.getElementById('fullscreen-chat-messages'),
        input: document.getElementById('fullscreen-chat-input'),
    };
}

function isFullscreenChatActive() {
    const { container } = getFullscreenChatEls();
    const page = document.getElementById('page-channel');
    return !!(
        chatSettings.fullscreenOverlayChat &&
        container &&
        document.fullscreenElement === container &&
        page &&
        page.classList.contains('active') &&
        document.getElementById('ch-live-area')?.style.display !== 'none'
    );
}

function clearFullscreenChatMessages() {
    const { messages } = getFullscreenChatEls();
    if (messages) messages.innerHTML = '';
}

function scheduleFullscreenChatIdle() {
    if (_fullscreenChatIdleTimer) clearTimeout(_fullscreenChatIdleTimer);
    const { container, input } = getFullscreenChatEls();
    if (!isFullscreenChatActive() || !container) return;
    if (input && document.activeElement === input) return;
    _fullscreenChatIdleTimer = setTimeout(() => {
        if (!isFullscreenChatActive()) return;
        if (input && document.activeElement === input) return;
        container.classList.add('fs-chat-idle');
    }, FULLSCREEN_CHAT_IDLE_MS);
}

function markFullscreenChatActivity() {
    const { container } = getFullscreenChatEls();
    if (!container) return;
    container.classList.remove('fs-chat-idle');
    scheduleFullscreenChatIdle();
}

function renderFullscreenChatRecent() {
    const { messages } = getFullscreenChatEls();
    if (!messages) return;
    messages.innerHTML = '';
    _fullscreenChatRecent.slice(-FULLSCREEN_CHAT_MAX_MESSAGES).forEach(entry => {
        const el = document.createElement('div');
        el.className = `fullscreen-chat-msg ${entry.kind || 'chat'}`.trim();
        el.innerHTML = entry.html;
        messages.appendChild(el);
        scheduleFullscreenChatFade(el);
    });
}

function updateFullscreenChatOverlayState() {
    const { container, overlay, input } = getFullscreenChatEls();
    if (!container || !overlay) return;

    const active = isFullscreenChatActive();
    container.classList.toggle('fs-chat-enabled', active);
    if (!active) {
        container.classList.remove('fs-chat-idle');
        overlay.setAttribute('aria-hidden', 'true');
        if (_fullscreenChatIdleTimer) { clearTimeout(_fullscreenChatIdleTimer); _fullscreenChatIdleTimer = null; }
        return;
    }

    overlay.setAttribute('aria-hidden', 'false');
    renderFullscreenChatRecent();
    if (input) _autoResizeTextarea(input);
    markFullscreenChatActivity();
}

function scheduleFullscreenChatFade(el) {
    if (!el) return;
    if (el._fadeTimer) clearTimeout(el._fadeTimer);
    if (el._removeTimer) clearTimeout(el._removeTimer);
    el.classList.remove('is-fading');
    el._fadeTimer = setTimeout(() => {
        el.classList.add('is-fading');
    }, FULLSCREEN_CHAT_FADE_MS);
    el._removeTimer = setTimeout(() => {
        el.remove();
    }, FULLSCREEN_CHAT_FADE_MS + 550);
}

function queueFullscreenChatEntry(entry) {
    if (!entry?.html) return;
    _fullscreenChatRecent.push(entry);
    if (_fullscreenChatRecent.length > FULLSCREEN_CHAT_MAX_MESSAGES * 2) {
        _fullscreenChatRecent = _fullscreenChatRecent.slice(-FULLSCREEN_CHAT_MAX_MESSAGES * 2);
    }

    if (!isFullscreenChatActive()) return;

    const { messages } = getFullscreenChatEls();
    if (!messages) return;
    const el = document.createElement('div');
    el.className = `fullscreen-chat-msg ${entry.kind || 'chat'}`.trim();
    el.innerHTML = entry.html;
    messages.appendChild(el);

    while (messages.children.length > FULLSCREEN_CHAT_MAX_MESSAGES) {
        messages.firstElementChild?.remove();
    }

    scheduleFullscreenChatFade(el);
}

function buildFullscreenChatEntry(msg) {
    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    let nameColor = msg.color || msg.profile_color || getRoleColor(msg.role);
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);
    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    const rawText = msg.message || msg.text || '';
    const text = (typeof parseEmotes === 'function') ? parseEmotes(rawText) : esc(rawText);
    const replyLine = msg.reply_to ? `<div style="font-size:0.72em;opacity:0.5;margin-bottom:1px"><i class="fa-solid fa-reply fa-flip-horizontal" style="font-size:0.65em"></i> @${esc(msg.reply_to.username || 'unknown')}</div>` : '';
    return {
        kind: 'chat',
        html: `${replyLine}<div class="fullscreen-chat-meta"><span class="fullscreen-chat-user" style="color:${esc(nameColor)}">${badge}${displayName}</span></div><div class="fullscreen-chat-text">${text}</div>`,
    };
}

function setupFullscreenChatOverlay() {
    document.addEventListener('fullscreenchange', updateFullscreenChatOverlayState);
    document.addEventListener('keydown', () => {
        if (isFullscreenChatActive()) markFullscreenChatActivity();
    }, { passive: true });
    document.addEventListener('focusin', (e) => {
        if (e.target?.id === 'fullscreen-chat-input') markFullscreenChatActivity();
    });
    document.addEventListener('focusout', (e) => {
        if (e.target?.id === 'fullscreen-chat-input') scheduleFullscreenChatIdle();
    });
    ['mousemove', 'mousedown', 'touchstart'].forEach(type => {
        document.addEventListener(type, (e) => {
            const { container } = getFullscreenChatEls();
            if (!container || !isFullscreenChatActive()) return;
            if (e.target === container || container.contains(e.target)) markFullscreenChatActivity();
        }, { passive: true });
    });
}

async function hydrateActiveChatHistory(streamId, { clear = false } = {}) {
    const { messages } = getChatEl();
    if (!messages) return;

    // If clearing, show a loading skeleton rather than an empty panel while
    // we wait for history to arrive — avoids a blank flash on stream restart.
    if (clear) {
        messages.innerHTML = '<div class="chat-loading-history" style="padding:12px;color:var(--text-muted);text-align:center;font-size:0.85rem"><i class="fa-solid fa-spinner fa-spin"></i> Loading history…</div>';
    }

    _loadingHistory = true;
    try {
        if (streamId) await loadChatHistory(streamId);
        else await loadGlobalChatHistory();
    } catch {
        // History failed — just clear the skeleton and let chat continue live
        if (clear) messages.innerHTML = '';
    } finally {
        _loadingHistory = false;
    }

    applyChatSettings();
    // Always scroll to the bottom after loading history — reset scroll state
    // to prevent false "new messages below" indicators on first open
    scrollChatToBottom();
    _chatUserScrolledUp = false;
    _chatUnreadCount = 0;
    _hideChatNewMessagesIndicator();
    // Re-scroll after a frame to catch any late DOM renders
    requestAnimationFrame(() => {
        scrollChatToBottom();
        _chatUserScrolledUp = false;
        _chatUnreadCount = 0;
        _hideChatNewMessagesIndicator();
    });
    // Also scroll the floating chat widget if it's open
    _fcwScrollToBottom();
}

/**
 * Initialize chat for a stream.
 * Idempotent — if already connected to the same stream, skip reconnection.
 */
function initChat(streamId) {
    const nextTargetId = getChatRenderTargetId();

    // Already connected or actively connecting to this stream — nothing to do
    if (chatWs && chatStreamId === streamId) {
        if (chatWs.readyState === WebSocket.OPEN || chatWs.readyState === WebSocket.CONNECTING) {
            const { messages } = getChatEl();
            const targetChanged = nextTargetId && nextTargetId !== chatRenderTargetId;
            const needsHydrate = chatWs.readyState === WebSocket.OPEN && (!messages || !messages.children.length);
            chatRenderTargetId = nextTargetId;
            if (targetChanged || needsHydrate) {
                hydrateActiveChatHistory(streamId, { clear: true }).catch(() => {});
            }
            applyChatSettings();
            return;
        }
    }

    // Reclaim background broadcast WS if it's connected to the same stream
    if (_bgBroadcastWs && _bgBroadcastWs.readyState === WebSocket.OPEN && _bgBroadcastStreamId === streamId) {
        destroyChat(); // close any existing foreground chat
        chatWs = _bgBroadcastWs;
        chatStreamId = _bgBroadcastStreamId;
        chatRenderTargetId = nextTargetId;
        _bgBroadcastWs = null;
        _bgBroadcastStreamId = null;
        _chatIntentionalClose = false;
        _chatActive = true;
        // Reattach full message handler
        chatWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                handleChatMessage(msg);
            } catch { /* ignore */ }
        };
        chatWs.onclose = () => {
            addSystemMessage('Chat disconnected');
            if (!_chatIntentionalClose && _chatActive) {
                _scheduleChatReconnect(chatStreamId);
            }
        };
        chatWs.onerror = () => { addSystemMessage('Chat connection error'); };
        // Load history and apply settings
        hydrateActiveChatHistory(streamId, { clear: true }).catch(() => {});
        applyChatSettings();
        return;
    }

    destroyChat();
    chatStreamId = streamId;
    chatRenderTargetId = nextTargetId;

    const host = window.location.hostname;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const token = localStorage.getItem('token');

    // Pass token and stream in URL so the server can authenticate on connect
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (streamId) params.set('stream', streamId);
    const wsUrl = `${protocol}://${host}:${port}/ws/chat?${params.toString()}`;

    const ws = new WebSocket(wsUrl);
    chatWs = ws;

    _chatIntentionalClose = false;
    _chatActive = true;
    _chatReconnectDelay = CHAT_RECONNECT_BASE;
    if (_chatReconnectTimer) { clearTimeout(_chatReconnectTimer); _chatReconnectTimer = null; }

    // All handlers capture `ws` so stale close/error events from a
    // previously-destroyed WebSocket can't trigger spurious reconnects.
    ws.onopen = () => {
        if (chatWs !== ws) return; // stale — a newer WS replaced us
        ws.send(JSON.stringify({
            type: 'join',
            streamId: streamId,
            token: token || undefined
        }));
        _chatReconnectDelay = CHAT_RECONNECT_BASE; // reset backoff on success
        addSystemMessage('Connected to chat');
    };

    // Load emotes for this stream context
    if (typeof loadEmotes === 'function') loadEmotes(streamId);

    ws.onmessage = (e) => {
        if (chatWs !== ws) return;
        try {
            const msg = JSON.parse(e.data);
            handleChatMessage(msg);
        } catch { /* ignore */ }
    };

    ws.onerror = () => {
        if (chatWs !== ws) return;
        addSystemMessage('Chat connection error');
    };

    ws.onclose = () => {
        if (chatWs !== ws) return; // stale close from old socket — ignore
        addSystemMessage('Chat disconnected');
        // Auto-reconnect unless intentionally closed (navigation/destroy)
        // For global chat, chatStreamId is null — use _chatActive to track connection intent
        if (!_chatIntentionalClose && _chatActive) {
            _scheduleChatReconnect(chatStreamId);
        }
    };

    // Load history
    hydrateActiveChatHistory(streamId).catch(() => {});

    // Apply persisted settings to DOM
    applyChatSettings();

    // Start cross-feed if enabled and we're in a stream chat
    _syncGlobalFeed();

    // Track user scroll position — clear indicator when user scrolls to bottom
    const { messages: chatContainer } = getChatEl();
    if (chatContainer && !chatContainer._scrollListenerAttached) {
        chatContainer._scrollListenerAttached = true;
        chatContainer.addEventListener('scroll', () => {
            const nearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 100;
            if (nearBottom) {
                _chatUserScrolledUp = false;
                _chatUnreadCount = 0;
                _hideChatNewMessagesIndicator();
            } else {
                _chatUserScrolledUp = true;
            }
        }, { passive: true });
    }
}

/**
 * Schedule a chat reconnect with exponential backoff.
 */
function _scheduleChatReconnect(streamId) {
    if (_chatReconnectTimer) return; // already scheduled
    const delay = _chatReconnectDelay;
    _chatReconnectDelay = Math.min(_chatReconnectDelay * 1.5, CHAT_RECONNECT_MAX);
    addSystemMessage(`Reconnecting in ${Math.round(delay / 1000)}s…`);
    _chatReconnectTimer = setTimeout(() => {
        _chatReconnectTimer = null;
        if (_chatIntentionalClose || !_chatActive) return;
        // Reconnect to current stream or global (null)
        const targetStream = chatStreamId ?? streamId ?? null;
        console.log('[Chat] Auto-reconnecting to', targetStream || 'global');
        // Reconnect the WebSocket WITHOUT clearing messages or tearing down the DOM.
        // This prevents the flash/clear that users see during server restarts.
        _reconnectChatWs(targetStream);
    }, delay);
}

/**
 * Reconnect just the WebSocket without clearing the chat UI.
 * Preserves all existing messages — only new messages are appended after reconnect.
 */
function _reconnectChatWs(streamId) {
    _chatIsReconnecting = true;
    // Close stale WS if any
    if (chatWs) {
        try { chatWs.onclose = null; chatWs.onerror = null; chatWs.close(); } catch {}
        chatWs = null;
    }
    chatStreamId = streamId;

    const host = window.location.hostname;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const token = localStorage.getItem('token');

    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (streamId) params.set('stream', streamId);
    const wsUrl = `${protocol}://${host}:${port}/ws/chat?${params.toString()}`;

    const ws = new WebSocket(wsUrl);
    chatWs = ws;
    _chatIntentionalClose = false;
    _chatActive = true;

    ws.onopen = () => {
        if (chatWs !== ws) return;
        _chatIsReconnecting = false;
        ws.send(JSON.stringify({ type: 'join', streamId, token: token || undefined }));
        _chatReconnectDelay = CHAT_RECONNECT_BASE;
        addSystemMessage('Reconnected to chat');
    };

    ws.onmessage = (e) => {
        if (chatWs !== ws) return;
        try { handleChatMessage(JSON.parse(e.data)); } catch {}
    };

    ws.onerror = () => {
        if (chatWs !== ws) return;
        _chatIsReconnecting = false;
        addSystemMessage('Chat connection error');
    };

    ws.onclose = () => {
        if (chatWs !== ws) return;
        _chatIsReconnecting = false;
        addSystemMessage('Chat disconnected');
        if (!_chatIntentionalClose && _chatActive) {
            _scheduleChatReconnect(chatStreamId);
        }
    };

    // Restart cross-feed if applicable
    _syncGlobalFeed();
}

function destroyChat() {
    _chatIntentionalClose = true;
    _chatActive = false;
    _closeGlobalFeed();
    if (_chatReconnectTimer) { clearTimeout(_chatReconnectTimer); _chatReconnectTimer = null; }
    // When broadcasting, keep the chat WS alive in the background so TTS
    // messages continue to play while the user browses other pages.
    const isBroadcasting = typeof isStreaming === 'function' && isStreaming();
    if (isBroadcasting && chatWs && chatWs.readyState === WebSocket.OPEN && chatStreamId) {
        // Transfer to background — only process TTS/audio, skip rendering
        _bgBroadcastWs = chatWs;
        _bgBroadcastStreamId = chatStreamId;
        // Replace the message handler with a TTS-only handler
        _bgBroadcastWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                _handleBgBroadcastMessage(msg);
            } catch { /* ignore */ }
        };
        _bgBroadcastWs.onclose = () => {
            _bgBroadcastWs = null;
            _bgBroadcastStreamId = null;
        };
        _bgBroadcastWs.onerror = () => {};
        chatWs = null;
        chatStreamId = null;
    } else {
        if (chatWs) {
            chatWs.close();
            chatWs = null;
        }
        chatStreamId = null;
    }
    chatRenderTargetId = null;
    clearFullscreenChatMessages();
    _fullscreenChatRecent = [];
    // Clean up stale background WS (disconnected while in bg)
    if (_bgBroadcastWs && _bgBroadcastWs.readyState !== WebSocket.OPEN) {
        try { _bgBroadcastWs.close(); } catch {}
        _bgBroadcastWs = null;
        _bgBroadcastStreamId = null;
    }
    // Clear all chat containers (only on intentional navigation, not auto-reconnect)
    if (!_chatIsReconnecting) {
        for (const id of ['chat-messages', 'bc-chat-messages', 'global-chat-messages', 'offline-chat-messages']) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }
    }
    dismissContextMenu();
}

/**
 * Background broadcast message handler — only processes TTS messages
 * so they continue playing while the broadcaster navigates other pages.
 */
function _handleBgBroadcastMessage(msg) {
    switch (msg.type) {
        case 'tts':
            if (typeof broadcastState !== 'undefined' && broadcastState.settings?.ttsMode === 'self') {
                if (typeof speakBroadcastTTS === 'function') {
                    speakBroadcastTTS(msg.message || msg.text, msg.username);
                }
            }
            break;
        case 'tts-audio':
            if (typeof playBroadcastTTSAudio === 'function' && typeof broadcastState !== 'undefined') {
                playBroadcastTTSAudio(msg);
            }
            break;
    }
}

/**
 * Close the background broadcast chat WS (call when broadcast ends).
 */
function destroyBgBroadcastChat() {
    if (_bgBroadcastWs) {
        try { _bgBroadcastWs.close(); } catch {}
        _bgBroadcastWs = null;
        _bgBroadcastStreamId = null;
    }
}

/* ── Message handling ─────────────────────────────────────────── */
function handleChatMessage(msg) {
    switch (msg.type) {
        case 'chat':
            addChatMessage(msg);
            // Self-mode TTS: speak every incoming chat message via browser synthesis
            if (typeof isStreaming === 'function' && isStreaming() && broadcastState?.settings?.ttsMode === 'self') {
                if (typeof speakBroadcastTTS === 'function' && _isTTSEnabledForSource(msg.source_platform)) {
                    speakBroadcastTTS(msg.message || msg.text, msg.username);
                }
            }
            break;
        case 'gotti':
            addGottiMessage(msg);
            break;
        case 'system':
            addSystemMessage(msg.message || msg.text);
            break;
        case 'donation':
            addDonationMessage(msg);
            break;
        case 'user-count':
            updateViewerCount(msg.count);
            updateTabViewerCount(msg.stream_id, msg.count);
            // Also update broadcast page viewer count element
            if (typeof updateViewerCountBroadcast === 'function') updateViewerCountBroadcast(msg.count);
            break;
        case 'users-list':
            renderChatUsersList(msg.users);
            break;
        case 'auth':
            if (msg.authenticated) {
                addSystemMessage(`Chatting as ${msg.username}`);
            } else {
                // Server didn't authenticate us — show as anon
                const hasToken = !!localStorage.getItem('token');
                if (hasToken) {
                    // We think we're logged in but the server rejected the token —
                    // token may be expired/invalid. Reconnect chat after loadUser refreshes auth.
                    addSystemMessage(`Chatting as ${msg.username} (not logged in)`);
                    console.warn('[Chat] Token rejected by server — will attempt re-auth');
                    // Re-validate token; if still valid, reconnect chat with fresh state
                    if (typeof loadUser === 'function') {
                        loadUser().then(() => {
                            if (typeof currentUser !== 'undefined' && currentUser) {
                                // Token was actually valid (race condition) — reconnect chat
                                console.log('[Chat] Re-auth succeeded, reconnecting chat');
                                const sid = chatStreamId;
                                destroyChat();
                                if (sid) initChat(sid);
                            } else {
                                // Token truly expired — clear it and update UI
                                addSystemMessage('Session expired. Please log in again.');
                                if (typeof onAuthChange === 'function') onAuthChange();
                            }
                        }).catch(() => {});
                    }
                } else {
                    addSystemMessage(`Chatting as ${msg.username}`);
                }
            }
            // Sync slow mode state from server on join
            if (typeof msg.slowmode_seconds === 'number') {
                chatSlowModeSeconds = msg.slowmode_seconds;
                updateSlowModeIndicator();
            }
            chatSelfDeletePolicy = {
                allowAutoDelete: msg.allow_auto_delete !== false,
                allowDeleteAll: msg.allow_self_delete_all !== false,
                minMinutes: Math.max(CHAT_SELF_DELETE_MINUTES, parseInt(msg.min_auto_delete_minutes, 10) || CHAT_SELF_DELETE_MINUTES),
            };
            chatSlurPolicy = {
                enabled: !!msg.slur_filter_enabled,
                useBuiltin: msg.slur_filter_use_builtin !== false,
                disabledCategories: Array.isArray(msg.slur_filter_disabled_categories) ? msg.slur_filter_disabled_categories : [],
                terms: Array.isArray(msg.slur_filter_terms) ? msg.slur_filter_terms.map((t) => String(t || '').trim()).filter(Boolean) : [],
                regexes: Array.isArray(msg.slur_filter_regexes) ? msg.slur_filter_regexes.map((t) => String(t || '').trim()).filter(Boolean) : [],
                message: String(msg.slur_filter_nudge_message || ''),
                announcedForKey: chatSlurPolicy.announcedForKey,
            };
            if (chatSlurPolicy.enabled && chatStreamId) {
                const policyKey = `stream:${chatStreamId}`;
                if (chatSlurPolicy.announcedForKey !== policyKey) {
                    chatSlurPolicy.announcedForKey = policyKey;
                    addSystemMessage('Heads up: this streamer enabled Anti-Slur Nudge for this chat. This is a channel choice, not a global platform block.');
                }
            }
            syncSettingsPanelUI();
            break;
        case 'slowmode':
            chatSlowModeSeconds = msg.seconds || 0;
            updateSlowModeIndicator();
            break;
        case 'user-updated': {
            // Admin renamed us — update local identity
            if (msg.user && typeof currentUser !== 'undefined' && currentUser && currentUser.id === msg.user.id) {
                const oldUsername = currentUser.username;
                const oldDisplay = currentUser.display_name;
                if (msg.user.username) currentUser.username = msg.user.username;
                if (msg.user.display_name) currentUser.display_name = msg.user.display_name;
                if (msg.user.role) currentUser.role = msg.user.role;
                if (msg.user.avatar_url !== undefined) currentUser.avatar_url = msg.user.avatar_url;
                if (msg.user.profile_color) currentUser.profile_color = msg.user.profile_color;
                // Refresh auth-dependent UI
                if (typeof onAuthChange === 'function') onAuthChange();
                // Notify user of what changed
                if (msg.user.username && msg.user.username !== oldUsername) {
                    addSystemMessage(`Your username was changed to @${msg.user.username}`);
                }
                if (msg.user.display_name && msg.user.display_name !== oldDisplay) {
                    addSystemMessage(`Your display name was changed to ${msg.user.display_name}`);
                }
            }
            break;
        }
        case 'clear': {
            const { messages: clearTarget } = getChatEl();
            if (clearTarget) clearTarget.innerHTML = '';
            addSystemMessage('Chat was cleared by a moderator');
            break;
        }
        case 'delete-messages': {
            // Remove specific messages from the DOM by their IDs
            if (msg.ids && msg.ids.length > 0) {
                const idSet = new Set(msg.ids.map(String));
                document.querySelectorAll('.chat-msg[data-msg-id]').forEach(el => {
                    if (idSet.has(el.dataset.msgId)) {
                        el.classList.add('chat-msg-deleted');
                        setTimeout(() => el.remove(), 300);
                    }
                });
            }
            break;
        }
        case 'self-delete-result': {
            const scopeLabel = msg.scope === 'stream' ? 'this chat' : 'your chat history';
            toast(`Deleted ${msg.count || 0} of your message(s) from ${scopeLabel}`, 'success');
            break;
        }
        case 'tts':
            // Legacy browser-side TTS (Self TTS mode)
            if (typeof isStreaming === 'function' && isStreaming() && broadcastState?.settings?.ttsMode === 'self') {
                // Broadcaster is live — use broadcast TTS with its volume/pitch/rate settings
                if (isChatTTSEnabled({ streaming: true }) && typeof speakBroadcastTTS === 'function' && _isTTSEnabledForSource(msg.source_platform)) {
                    speakBroadcastTTS(msg.message || msg.text, msg.username);
                }
            } else if (isChatTTSEnabled() && _isTTSEnabledForSource(msg.source_platform)) {
                speakTTS(msg.message || msg.text, msg.voiceFX, msg.username);
            }
            break;
        case 'tts-audio':
            // Server-synthesized TTS audio (Site-Wide TTS mode)
            if (typeof isStreaming === 'function' && isStreaming() && typeof playBroadcastTTSAudio === 'function') {
                // Broadcaster is live — route to broadcast audio queue
                if (isChatTTSEnabled({ streaming: true }) && _isTTSEnabledForSource(msg.source_platform)) playBroadcastTTSAudio(msg);
            } else if (isChatTTSEnabled() && _isTTSEnabledForSource(msg.source_platform)) {
                // Regular chat viewer — play through chat TTS queue
                playTTSAudio(msg);
            }
            break;
        case 'ban':
        case 'timeout':
            addSystemMessage(msg.message || `User ${msg.username} was ${msg.type === 'ban' ? 'banned' : 'timed out'}`);
            break;
        case 'error':
            addSystemMessage(msg.message, true);
            break;
        case 'slur-blocked':
            showSlurNudgeModal(msg.message || null);
            addSystemMessage('Message blocked by this streamer\'s Anti-Slur Nudge setting.');
            break;
        case 'server_restart':
            // Server is about to restart — show prominent notice
            addRichSystemMessage(msg.message || 'Server restarting — chat will reconnect automatically.', 'warning');
            break;
        case 'update': {
            // Platform update notification with commit logs + expandable changelog
            const summary = esc(msg.summary || 'New update deployed!');
            const commits = Array.isArray(msg.commits) ? msg.commits : [];
            const linkUrl = msg.url ? esc(msg.url) : null;

            let html = `🚀 ${summary}`;

            if (commits.length > 0) {
                const changelogId = 'update-changelog-' + Date.now();
                html += ` <a href="#" onclick="event.preventDefault();document.getElementById('${changelogId}').classList.toggle('open')" style="color:var(--accent);text-decoration:underline;cursor:pointer">View changelog ▾</a>`;
                if (linkUrl) {
                    html += ` · <a href="${linkUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">Full patch notes →</a>`;
                }
                html += `<div id="${changelogId}" class="chat-changelog" style="display:none;margin-top:6px;padding:6px 8px;background:rgba(0,0,0,0.25);border-radius:6px;font-size:0.82rem;max-height:200px;overflow-y:auto;">`;
                for (const c of commits) {
                    const short = esc(c.short || '');
                    const subject = esc(c.subject || '');
                    const commitUrl = c.hash ? `https://github.com/HoboStreamer/HoboStreamer.com/commit/${esc(c.hash)}` : '#';
                    html += `<div style="padding:2px 0;display:flex;gap:6px;align-items:baseline;"><a href="${commitUrl}" target="_blank" rel="noopener" style="color:var(--accent);font-family:monospace;font-size:0.78rem;text-decoration:none;flex-shrink:0">${short}</a> <span style="opacity:0.85">${subject}</span></div>`;
                }
                html += '</div>';
                // Auto-expand with a microtask so the DOM element exists
                setTimeout(() => {
                    const el = document.getElementById(changelogId);
                    if (el) el.classList.add('open'), el.style.display = '';
                }, 0);
            } else if (linkUrl) {
                html += ` <a href="${linkUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">View full patch notes →</a>`;
            }
            addRichSystemMessage(html, 'update');
            break;
        }
        case 'coin_earned':
            if (typeof handleCoinEarned === 'function') handleCoinEarned(msg);
            break;
        case 'redemption': {
            const { messages: rContainer } = getChatEl();
            if (rContainer && typeof renderRedemption === 'function') renderRedemption(msg, rContainer);
            break;
        }
        case 'dm':
        case 'dm-participant-added':
            // Route DM events to the messenger widget
            if (typeof window._messengerHandleDm === 'function') {
                window._messengerHandleDm(msg);
            }
            break;
        case 'vc-call-invite': {
            _showIncomingVcCallOverlay(msg);
            break;
        }
        case 'vc-call-response': {
            _handleVcCallResponse(msg);
            break;
        }
    }
}

function addChatMessage(msg) {
    // Feed username into autocomplete cache
    if (typeof acTrackUser === 'function') acTrackUser(msg);

    const chatEl = getChatEl();
    const container = chatEl.messages;

    // Voice Call mode filter: skip messages not tagged with our voice channel
    const isVoiceMsg = !!msg.voiceChannelId;
    if (chatMode === 'voice' && !isVoiceMsg) {
        // Still mirror to floating widget even if filtered from main view
        _fcwAddMessage(msg);
        return;
    }
    if (chatMode === 'voice' && isVoiceMsg) {
        // Only show messages from the same channel
        if (typeof callState !== 'undefined' && callState.joined && msg.voiceChannelId !== callState.channelId) {
            _fcwAddMessage(msg);
            return;
        }
    }

    if (!container) {
        _fcwAddMessage(msg);
        return;
    }
    const el = document.createElement('div');
    el.className = 'chat-msg';

    // Attach message ID for reply targeting
    if (msg.id) el.dataset.msgId = msg.id;
    // Attach source platform for relay user identification
    if (msg.source_platform) el.dataset.sourcePlatform = msg.source_platform;
    if (msg.role === 'external') el.dataset.isRelay = '1';
    if (msg.message_type === 'news') el.classList.add('news');

    const isGlobal = chatEl.isGlobal;

    // Timestamps — normalize to UTC then display in browser local time
    const showTs = isGlobal || chatSettings.showTimestamps;
    let tsSource;
    if (msg.timestamp) {
        const raw = msg.timestamp;
        // Ensure UTC: ISO strings with 'Z' or '+' are fine; bare SQLite datetimes need 'Z' appended
        const isUTC = raw.includes('Z') || raw.includes('+') || raw.includes('T');
        tsSource = new Date(isUTC ? raw : raw.replace(' ', 'T') + 'Z');
    } else {
        tsSource = new Date();
    }
    const tsOpts = chatSettings.timestampFormat === '24h'
        ? { hour: '2-digit', minute: '2-digit', hour12: false }
        : { hour: '2-digit', minute: '2-digit' };
    const timestamp = showTs
        ? `<span class="chat-time-inline">${tsSource.toLocaleTimeString([], tsOpts)}</span> `
        : '';

    // Stream source badge for global chat
    let streamBadge = '';
    if (isGlobal && msg.stream_channel) {
        streamBadge = `<span class="chat-stream-badge" title="From ${esc(msg.stream_channel)}'s stream" data-channel="${esc(msg.stream_channel)}" onclick="navigate('/' + this.dataset.channel)">${esc(msg.stream_channel)}</span> `;
    } else if (isGlobal && msg.stream_username) {
        streamBadge = `<span class="chat-stream-badge" title="From ${esc(msg.stream_username)}'s stream" data-channel="${esc(msg.stream_username)}" onclick="navigate('/' + this.dataset.channel)">${esc(msg.stream_username)}</span> `;
    }

    // Voice call badge (shown in global mode for voice-tagged messages)
    let voiceBadge = '';
    if (isGlobal && isVoiceMsg && chatMode === 'global') {
        voiceBadge = `<span class="chat-voice-badge" title="Voice Channel"><i class="fa-solid fa-headset"></i> VC</span> `;
    }

    // Game chat badge
    let gameBadge = '';
    if (isGlobal && msg.is_game_chat) {
        gameBadge = `<span class="chat-game-badge" title="Game Chat"><i class="fa-solid fa-gamepad"></i></span> `;
    }

    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    let nameColor = msg.color || msg.profile_color || getRoleColor(msg.role);
    // Readable colors — ensure minimum contrast against dark backgrounds
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);

    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    const coreUsername = esc(msg.core_username || '');
    const rawText = msg.message || msg.text || '';
    let text = (typeof parseEmotes === 'function') ? parseEmotes(rawText) : esc(rawText);
    // Append clickable source link for news headlines
    if (msg.message_type === 'news' && msg.url) {
        text += ` <a href="${esc(msg.url)}" target="_blank" rel="noopener" class="news-link"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>`;
    }
    const isAnon = displayName.startsWith('anon');

    // Mention highlighting
    const currentUser = getCurrentUsername();
    const isMention = currentUser && rawText.toLowerCase().includes(`@${currentUser.toLowerCase()}`);
    if (isMention && chatSettings.mentionHighlight) {
        el.classList.add('chat-msg-mention');
        if (chatSettings.flashOnMention) flashTabTitle(displayName);
        if (chatSettings.soundOnMention) playMentionSound();
    }

    // Avatar (respects showAvatars setting via CSS class on root, but still render for toggle)
    const avatarHtml = msg.avatar_url
        ? `<img class="chat-avatar" src="${esc(msg.avatar_url)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''">`
          + `<span class="chat-avatar-letter" style="display:none;background:${esc(nameColor)}">${displayName[0].toUpperCase()}</span>`
        : `<span class="chat-avatar-letter" style="background:${esc(nameColor)}">${displayName[0].toUpperCase()}</span>`;

    const userId = esc(String(msg.user_id || ''));

    // ── Cosmetic rendering ───────────────────────────────
    // Hat emoji before name
    let hatHtml = '';
    if (msg.hatFX && msg.hatFX.hatChar) {
        const animClass = msg.hatFX.animated ? ` hat-${esc(msg.hatFX.animated)}` : '';
        hatHtml = `<span class="chat-hat${animClass}">${esc(msg.hatFX.hatChar)}</span>`;
    }

    // Name effect CSS class on username
    const nameFXClass = msg.nameFX?.cssClass ? ` ${esc(msg.nameFX.cssClass)}` : '';

    // Particle wrapper
    const hasParticles = msg.particleFX?.chars;
    const particleWrapOpen = hasParticles ? `<span class="chat-particle-wrap ${esc(msg.particleFX.cssClass || '')}">` : '';
    const particleWrapClose = hasParticles ? `</span>` : '';

    // Reply header (if this message is a reply)
    let replyHtml = '';
    if (msg.reply_to) {
        const replyUser = esc(msg.reply_to.username || 'unknown');
        const replySnippet = esc(msg.reply_to.message || '');
        const replyMsgId = msg.reply_to.id ? `data-reply-target="${esc(String(msg.reply_to.id))}"` : '';
        replyHtml = `<div class="chat-reply-header" ${replyMsgId} onclick="scrollToReplyTarget(this)"><i class="fa-solid fa-reply fa-flip-horizontal"></i> <span class="chat-reply-user">@${replyUser}</span> <span class="chat-reply-snippet">${replySnippet}</span></div>`;
    }

    el.innerHTML = `${replyHtml}${timestamp}${streamBadge}${voiceBadge}${gameBadge}<span class="chat-avatar-wrap">${avatarHtml}</span>${badge}${hatHtml}${particleWrapOpen}<span class="chat-user${nameFXClass}" style="color:${esc(nameColor)}" data-username="${displayName}" data-core-username="${coreUsername}" data-user-id="${userId}" data-anon="${isAnon ? '1' : ''}" oncontextmenu="showChatContextMenu(event)" onclick="showChatContextMenu(event)">${displayName}</span>${particleWrapClose}: ${text}`;

    // Reply action button (hover)
    if (msg.id) {
        const replyBtn = document.createElement('button');
        replyBtn.className = 'chat-reply-btn';
        replyBtn.title = 'Reply';
        replyBtn.innerHTML = '<i class="fa-solid fa-reply"></i>';
        replyBtn.onclick = (e) => {
            e.stopPropagation();
            setChatReply({
                id: msg.id,
                username: msg.username || msg.displayName || 'anon',
                user_id: msg.user_id,
                message: (msg.message || msg.text || '').slice(0, 100),
            });
        };
        el.appendChild(replyBtn);
        el.classList.add('chat-msg-hoverable');
    }

    // Spawn particles if equipped
    if (hasParticles) {
        const wrap = el.querySelector('.chat-particle-wrap');
        if (wrap) spawnChatParticles(wrap, msg.particleFX.chars);
    }

    // Freeze animated emotes if setting is off
    if (!chatSettings.animatedEmotes) {
        el.querySelectorAll('.chat-emote-animated').forEach(img => {
            freezeGifEmote(img);
        });
    }

    container.appendChild(el);
    if (chatSettings.autoScroll) {
        if (_loadingHistory) {
            // During history loading, force-scroll without the nearBottom guard
            // to avoid false "user scrolled up" detection from rapid DOM appends
            scrollChatToBottom();
        } else {
            scrollChat();
            // If user is scrolled up, show the new-messages indicator instead
            if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
        }
    }

    // Mirror message to floating chat widget (for non-chat pages)
    _fcwAddMessage(msg);
    queueFullscreenChatEntry(buildFullscreenChatEntry(msg));
}

/**
 * Spawn small particle characters around a name element
 */
function spawnChatParticles(wrap, chars) {
    const charArr = [...chars];
    const count = 3 + Math.floor(Math.random() * 3); // 3-5 particles
    for (let i = 0; i < count; i++) {
        const p = document.createElement('span');
        p.className = 'chat-particle';
        p.textContent = charArr[Math.floor(Math.random() * charArr.length)];
        const dx = (Math.random() - 0.5) * 40;
        const dy = -10 - Math.random() * 25;
        p.style.setProperty('--px-dx', `${dx}px`);
        p.style.setProperty('--px-dy', `${dy}px`);
        p.style.left = `${Math.random() * 80}%`;
        p.style.top = `${Math.random() * 60}%`;
        p.style.animationDelay = `${Math.random() * 0.4}s`;
        wrap.appendChild(p);
        // Clean up after animation
        setTimeout(() => p.remove(), 2200);
    }
}

function addSystemMessage(text, isError = false) {
    const { messages: container } = getChatEl();
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-msg system';
    if (isError) el.style.color = 'var(--danger)';
    el.textContent = text;
    container.appendChild(el);
    scrollChat();
    if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
    if (text) {
        queueFullscreenChatEntry({
            kind: 'system',
            html: `<div class="fullscreen-chat-text">${esc(text)}</div>`,
        });
    }
}

/**
 * Build avatar HTML for a chat message (reusable helper).
 * Returns an <img> with letter fallback, or just a letter span for anon users.
 */
function getChatAvatarHTML(msg) {
    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    let nameColor = msg.color || msg.profile_color || getRoleColor(msg.role);
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);
    return msg.avatar_url
        ? `<img class="chat-avatar" src="${esc(msg.avatar_url)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''">`
          + `<span class="chat-avatar-letter" style="display:none;background:${esc(nameColor)}">${displayName[0].toUpperCase()}</span>`
        : `<span class="chat-avatar-letter" style="background:${esc(nameColor)}">${displayName[0].toUpperCase()}</span>`;
}

function addGottiMessage(msg) {
    const { messages: container } = getChatEl();
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'chat-msg gotti';

    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    const avatarHtml = getChatAvatarHTML(msg);
    const hatHtml = msg.hatFX?.emoji ? `<span class="chat-hat" aria-hidden="true">${esc(msg.hatFX.emoji)}</span>` : '';
    let nameColor = msg.color || msg.profile_color || getRoleColor(msg.role);
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);

    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    const coreUsername = esc(msg.core_username || '');
    const userId = esc(String(msg.user_id || ''));
    const isAnon = !msg.user_id;
    const nameFXClass = msg.nameFX?.cssClass ? ` ${esc(msg.nameFX.cssClass)}` : '';
    const hasParticles = msg.particleFX?.chars;
    const particleWrapOpen = hasParticles ? `<span class="chat-particle-wrap ${esc(msg.particleFX.cssClass || '')}">` : '';
    const particleWrapClose = hasParticles ? '</span>' : '';
    const gifUrl = esc(msg.gif_url || '');
    const sourceUrl = esc(msg.source_url || gifUrl);
    const caption = esc(msg.message || 'GOTTI!');

    el.innerHTML = `${badge}${hatHtml}${particleWrapOpen}<span class="chat-avatar-wrap">${avatarHtml}</span><span class="chat-user${nameFXClass}" style="color:${esc(nameColor)}" data-username="${displayName}" data-core-username="${coreUsername}" data-user-id="${userId}" data-anon="${isAnon ? '1' : ''}" oncontextmenu="showChatContextMenu(event)" onclick="showChatContextMenu(event)">${displayName}</span>${particleWrapClose}<div class="gotti-card"><div class="gotti-card-media"><img class="gotti-card-image" src="${gifUrl}" alt="${caption}" loading="lazy"></div><div class="gotti-card-copy"><div class="gotti-card-title">${caption}</div><a class="gotti-card-link" href="${sourceUrl}" target="_blank" rel="noopener">Open source GIF</a></div></div>`;

    if (hasParticles) {
        const wrap = el.querySelector('.chat-particle-wrap');
        if (wrap) spawnChatParticles(wrap, msg.particleFX.chars);
    }

    container.appendChild(el);
    if (chatSettings.autoScroll) {
        scrollChat();
        if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
    }

    _fcwAddMessage({
        ...msg,
        message: `${msg.message || 'GOTTI!'} ${msg.source_url || msg.gif_url || ''}`,
    });

    queueFullscreenChatEntry({
        kind: 'gotti',
        html: `<div class="fullscreen-chat-meta"><span class="fullscreen-chat-user" style="color:${esc(nameColor)}">${badge}${displayName}</span></div><div class="fullscreen-chat-text">${caption}</div><img class="fullscreen-chat-gotti" src="${gifUrl}" alt="${caption}" loading="lazy">`,
    });
}

/**
 * Add a rich system message that supports HTML (links, formatting).
 * @param {string} html - Pre-escaped HTML content
 * @param {'warning'|'update'|'info'} style - Visual style variant
 */
function addRichSystemMessage(html, style = 'info') {
    const { messages: container } = getChatEl();
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-msg system';
    if (style === 'warning') el.style.color = 'var(--warning, #f59e0b)';
    else if (style === 'update') el.style.color = 'var(--accent)';
    el.innerHTML = html;
    container.appendChild(el);
    scrollChat();
    if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
}

function addDonationMessage(msg) {
    const { messages: container } = getChatEl();
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-msg donation';

    const donorName = esc(msg.username || msg.from || 'Anonymous');
    const amount = msg.amount || 0;
    const rawDonText = msg.message || '';
    const text = rawDonText ? `: ${(typeof parseEmotes === 'function') ? parseEmotes(rawDonText) : esc(rawDonText)}` : '';

    el.innerHTML = `<i class="fa-solid fa-coins" style="color:var(--accent)"></i> <strong>${donorName}</strong> donated <strong>$${amount} Hobo Bucks</strong>${text}`;

    container.appendChild(el);
    scrollChat();
    if (_chatUserScrolledUp) _onNewChatMessageWhileScrolledUp();
    queueFullscreenChatEntry({
        kind: 'donation',
        html: `<div class="fullscreen-chat-meta"><span class="fullscreen-chat-user" style="color:var(--accent)"><i class="fa-solid fa-coins"></i> ${donorName}</span></div><div class="fullscreen-chat-text">donated <strong>$${amount} Hobo Bucks</strong>${text}</div>`,
    });

    // TTS for donations
    if (document.getElementById('tts-checkbox')?.checked) {
        speakTTS(`${donorName} donated ${amount} hobo bucks. ${msg.message || ''}`);
    }
}

/* ── Slow Mode Indicator ───────────────────────────────────── */
function getOrCreateSlowModeBanner(inputArea) {
    let banner = inputArea.querySelector('.chat-slowmode-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.className = 'chat-slowmode-banner';
        banner.innerHTML = `
            <div class="chat-slowmode-info">
                <i class="fa-solid fa-clock"></i>
                <span class="chat-slowmode-label">Slow mode</span>
                <span class="chat-slowmode-duration"></span>
            </div>
            <div class="chat-slowmode-bar"><div class="chat-slowmode-fill"></div></div>
        `;
        // Insert before the input row
        const row = inputArea.querySelector('.chat-input-row');
        if (row) inputArea.insertBefore(banner, row);
        else inputArea.prepend(banner);
    }
    return banner;
}

function updateSlowModeIndicator() {
    document.querySelectorAll('.chat-input-area').forEach(area => {
        const banner = getOrCreateSlowModeBanner(area);
        if (chatSlowModeSeconds > 0) {
            banner.style.display = '';
            banner.querySelector('.chat-slowmode-duration').textContent = `${chatSlowModeSeconds}s`;
        } else {
            banner.style.display = 'none';
            // Clear any active cooldown
            clearSlowModeCooldown();
        }
    });
}

function startSlowModeCooldown() {
    if (chatSlowModeSeconds <= 0) return;
    chatSlowModeCooldownEnd = Date.now() + chatSlowModeSeconds * 1000;

    // Disable send buttons and update all banners
    document.querySelectorAll('.chat-input-area').forEach(area => {
        const banner = getOrCreateSlowModeBanner(area);
        banner.classList.add('cooldown');
        const fill = banner.querySelector('.chat-slowmode-fill');
        if (fill) {
            fill.style.transition = 'none';
            fill.style.width = '100%';
            // Force reflow then animate
            fill.offsetHeight; // eslint-disable-line no-unused-expressions
            fill.style.transition = `width ${chatSlowModeSeconds}s linear`;
            fill.style.width = '0%';
        }
        const sendBtn = area.querySelector('.chat-send-btn');
        if (sendBtn) sendBtn.classList.add('disabled');
    });

    // Countdown tick
    if (chatSlowModeCooldownTimer) clearInterval(chatSlowModeCooldownTimer);
    chatSlowModeCooldownTimer = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((chatSlowModeCooldownEnd - Date.now()) / 1000));
        document.querySelectorAll('.chat-slowmode-banner.cooldown .chat-slowmode-duration').forEach(el => {
            el.textContent = remaining > 0 ? `${remaining}s` : `${chatSlowModeSeconds}s`;
        });
        if (remaining <= 0) {
            clearSlowModeCooldown();
        }
    }, 250);
}

function clearSlowModeCooldown() {
    if (chatSlowModeCooldownTimer) { clearInterval(chatSlowModeCooldownTimer); chatSlowModeCooldownTimer = null; }
    chatSlowModeCooldownEnd = 0;
    document.querySelectorAll('.chat-input-area').forEach(area => {
        const banner = area.querySelector('.chat-slowmode-banner');
        if (banner) {
            banner.classList.remove('cooldown');
            const dur = banner.querySelector('.chat-slowmode-duration');
            if (dur && chatSlowModeSeconds > 0) dur.textContent = `${chatSlowModeSeconds}s`;
            const fill = banner.querySelector('.chat-slowmode-fill');
            if (fill) { fill.style.transition = 'none'; fill.style.width = '0%'; }
        }
        const sendBtn = area.querySelector('.chat-send-btn');
        if (sendBtn) sendBtn.classList.remove('disabled');
    });
}

/* ── Send ──────────────────────────────────────────────────────── */

// ── Message history (up/down arrow recall) ───────────────────
const _chatMsgHistory = [];
let _chatHistoryIndex = -1;
let _chatHistoryDraft = '';
const CHAT_HISTORY_MAX = 50;
const CHAT_TEXTAREA_MAX_LINES = 4;

function normalizeSlurText(input) {
    const map = {
        '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
        '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
        '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
    };
    const lower = String(input || '').toLowerCase();
    const mapped = lower.split('').map((ch) => map[ch] || ch).join('');
    const ascii = mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const lettersOnly = ascii.replace(/[^a-z]/g, '');
    return lettersOnly.replace(/(.)\1{1,}/g, '$1');
}

function normalizeSlurPatternText(input) {
    const map = {
        '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
        '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
        '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
    };
    const lower = String(input || '').toLowerCase();
    const mapped = lower.split('').map((ch) => map[ch] || ch).join('');
    const ascii = mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return ascii.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function compileRegexRules(rules, { forceInsensitive = true } = {}) {
    const compiled = [];
    for (const raw of rules || []) {
        if (!raw || raw.length > 200) continue;
        let source = raw;
        let flags = forceInsensitive ? 'i' : '';

        const wrapped = raw.match(/^\/(.+)\/([a-z]*)$/i);
        if (wrapped) {
            source = wrapped[1];
            flags = wrapped[2] || '';
            if (forceInsensitive && !flags.includes('i')) flags += 'i';
        }
        try {
            compiled.push(new RegExp(source, flags));
        } catch {
            // Ignore invalid user-provided regex entries.
        }
    }
    return compiled;
}

function messageHitsCoreSlurPolicy(text, disabledCategories = []) {
    const normalized = normalizeSlurPatternText(text);
    if (!normalized) return false;
    const disabled = new Set(disabledCategories);
    return CHAT_CORE_SLUR_CATEGORIES.some((cat) => !disabled.has(cat.key) && cat.compiled.some((pat) => pat.test(normalized)));
}

function messageHitsCustomRegexPolicy(text) {
    if (!chatSlurPolicy.regexes?.length) return false;
    const normalized = normalizeSlurPatternText(text);
    if (!normalized) return false;
    const patterns = compileRegexRules(chatSlurPolicy.regexes, { forceInsensitive: true });
    return patterns.some((pattern) => pattern.test(normalized));
}

function messageHitsSlurPolicy(text) {
    if (!chatSlurPolicy.enabled) return false;
    const normalizedText = normalizeSlurText(text);
    const hitsConfigured = !!normalizedText && chatSlurPolicy.terms.some((term) => {
        const normalizedTerm = normalizeSlurText(term);
        return normalizedTerm.length >= 2 && normalizedText.includes(normalizedTerm);
    });
    const hitsCore = chatSlurPolicy.useBuiltin && messageHitsCoreSlurPolicy(text, chatSlurPolicy.disabledCategories);
    const hitsRegex = messageHitsCustomRegexPolicy(text);
    return hitsConfigured || hitsCore || hitsRegex;
}

function showSlurNudgeModal(customMessage = null) {
    const existing = document.getElementById('chat-slur-nudge-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'chat-slur-nudge-modal';
    modal.className = 'chat-slur-nudge-modal';

    const message = String(customMessage || chatSlurPolicy.message || '').trim()
        || 'This streamer enabled Anti-Slur Nudge for this chat. Roast smarter, not lazier. Pick a different word and keep the banter fun.';

    modal.innerHTML = `
        <div class="chat-slur-nudge-card" role="dialog" aria-modal="true" aria-label="Chat message blocked">
            <h3><i class="fa-solid fa-comments"></i> Message Not Sent</h3>
            <p>${esc(message)}</p>
            <p class="chat-slur-nudge-sub">Streamer setting: Anti-Slur Nudge is enabled in this channel.</p>
            <button class="btn btn-primary" id="chat-slur-nudge-ok">Got it</button>
        </div>`;

    modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
    const okBtn = modal.querySelector('#chat-slur-nudge-ok');
    if (okBtn) okBtn.addEventListener('click', () => modal.remove());
}

function sendChat(overrideInput = null) {
    const input = overrideInput || getChatEl().input;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    if (messageHitsSlurPolicy(text)) {
        showSlurNudgeModal();
        return;
    }

    // If WS is down (server restarting, etc.), send to global chat via REST API
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
        _sendChatViaRest(text, input);
        return;
    }

    // Client-side cooldown enforcement
    if (chatSlowModeCooldownEnd > Date.now()) {
        const remaining = Math.ceil((chatSlowModeCooldownEnd - Date.now()) / 1000);
        addSystemMessage(`Slow mode: wait ${remaining}s`);
        return;
    }

    // Save to message history
    if (_chatMsgHistory[0] !== text) {
        _chatMsgHistory.unshift(text);
        if (_chatMsgHistory.length > CHAT_HISTORY_MAX) _chatMsgHistory.pop();
    }
    _chatHistoryIndex = -1;
    _chatHistoryDraft = '';

    const msg = {
        type: 'chat',
        message: text,
        streamId: chatStreamId,
    };

    const autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
    if (autoDeleteMinutes >= (chatSelfDeletePolicy.minMinutes || CHAT_SELF_DELETE_MINUTES) && canUseViewerAutoDeleteHere()) {
        msg.auto_delete_minutes = autoDeleteMinutes;
    }

    // Attach reply-to if replying
    if (_chatReplyTo) {
        msg.reply_to_id = _chatReplyTo.id;
    }

    // Tag message with voice channel ID if in voice call chat mode
    if (chatMode === 'voice' && typeof callState !== 'undefined' && callState.joined && callState.channelId) {
        msg.voiceChannelId = callState.channelId;
    }

    chatWs.send(JSON.stringify(msg));

    input.value = '';
    _autoResizeTextarea(input);
    input.focus();
    clearChatReply();
    if (input.id === 'fullscreen-chat-input') markFullscreenChatActivity();
    startSlowModeCooldown();
}

/**
 * Fallback: send a chat message via REST API when the WebSocket is down.
 * The message goes to global chat so the user isn't silenced during reconnects.
 */
async function _sendChatViaRest(text, input) {
    const token = localStorage.getItem('token');
    if (!token) {
        addSystemMessage('Chat disconnected — log in to send messages while reconnecting');
        return;
    }
    try {
        const autoDeleteMinutes = normalizeChatAutoDeleteMinutes(chatSettings.autoDeleteMinutes);
        const payload = { message: text, reply_to_id: _chatReplyTo?.id || undefined };
        if (autoDeleteMinutes >= (chatSelfDeletePolicy.minMinutes || CHAT_SELF_DELETE_MINUTES) && canUseViewerAutoDeleteHere()) {
            payload.auto_delete_minutes = autoDeleteMinutes;
        }

        const res = await fetch('/api/chat/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            addSystemMessage(err.error || 'Failed to send message');
            return;
        }
        // Clear input on success
        input.value = '';
        _autoResizeTextarea(input);
        input.focus();
        clearChatReply();
        if (chatStreamId) {
            addSystemMessage('Sent to global chat (stream chat reconnecting)');
        }
    } catch {
        addSystemMessage('Server unreachable — message not sent');
    }
}

/* ── Reply-to helpers ─────────────────────────────────────────── */

/**
 * Set the reply target — shows the reply bar above the chat input.
 */
function setChatReply(replyData) {
    _chatReplyTo = replyData;
    // Show/update reply bar on all chat input areas
    document.querySelectorAll('.chat-input-area').forEach(area => {
        let bar = area.querySelector('.chat-reply-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'chat-reply-bar';
            // Insert before the chat-input-row
            const inputRow = area.querySelector('.chat-input-row');
            if (inputRow) {
                area.insertBefore(bar, inputRow);
            } else {
                area.prepend(bar);
            }
        }
        bar.innerHTML = `<div class="chat-reply-bar-content"><i class="fa-solid fa-reply fa-flip-horizontal"></i> Replying to <strong>${esc(replyData.username)}</strong><span class="chat-reply-bar-snippet">${esc(replyData.message)}</span></div><button class="chat-reply-bar-close" onclick="clearChatReply()" title="Cancel reply"><i class="fa-solid fa-xmark"></i></button>`;
        bar.style.display = '';
    });
    // Focus the relevant input
    const chatEl = getChatEl();
    if (chatEl.input) chatEl.input.focus();
}

/**
 * Clear the reply target — hides the reply bar.
 */
function clearChatReply() {
    _chatReplyTo = null;
    document.querySelectorAll('.chat-reply-bar').forEach(bar => {
        bar.style.display = 'none';
    });
}

/**
 * Scroll to and highlight the message being replied to.
 */
function scrollToReplyTarget(headerEl) {
    const targetId = headerEl?.dataset?.replyTarget;
    if (!targetId) return;
    // Search all chat containers for the target message
    const targetMsg = document.querySelector(`.chat-msg[data-msg-id="${targetId}"]`);
    if (targetMsg) {
        targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetMsg.classList.add('chat-msg-reply-flash');
        setTimeout(() => targetMsg.classList.remove('chat-msg-reply-flash'), 1500);
    }
}

/**
 * Auto-resize a chat textarea to fit content, up to max lines.
 */
function _autoResizeTextarea(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    // Clamp to max-height set in CSS (~108px = 4 lines)
    el.style.height = Math.min(el.scrollHeight, 108) + 'px';
    // Toggle overflow once content exceeds max
    el.style.overflowY = el.scrollHeight > 108 ? 'auto' : 'hidden';
}

/**
 * Handle keydown for chat textareas:
 *  - Enter (no shift) = send
 *  - Shift+Enter = newline (up to max lines)
 *  - ArrowUp/Down = message history
 */
function _chatTextareaKeydown(e) {
    const el = e.target;
    const isFcw = el.id === 'fcw-chat-input';
    const isFullscreen = el.id === 'fullscreen-chat-input';

    if (e.key === 'Enter' && !e.shiftKey) {
        // Let autocomplete handle Enter when its menu is open
        if (typeof acIsActive === 'function' && acIsActive()) return;
        e.preventDefault();
        if (isFcw) fcwSendChat();
        else if (isFullscreen) sendChat(el);
        else sendChat();
        return;
    }

    // Escape: clear reply
    if (e.key === 'Escape' && _chatReplyTo) {
        clearChatReply();
        e.preventDefault();
        return;
    }

    // Shift+Enter: allow newline but enforce line limit
    if (e.key === 'Enter' && e.shiftKey) {
        const lines = (el.value.substring(0, el.selectionStart).match(/\n/g) || []).length + 1;
        if (lines >= CHAT_TEXTAREA_MAX_LINES) {
            e.preventDefault();
            return;
        }
        // Let the newline insert, then resize
        requestAnimationFrame(() => _autoResizeTextarea(el));
        return;
    }

    // Arrow Up — recall older messages
    if (e.key === 'ArrowUp' && el.selectionStart === 0 && !e.shiftKey) {
        if (_chatMsgHistory.length === 0) return;
        if (_chatHistoryIndex === -1) _chatHistoryDraft = el.value;
        if (_chatHistoryIndex < _chatMsgHistory.length - 1) {
            _chatHistoryIndex++;
            el.value = _chatMsgHistory[_chatHistoryIndex];
            _autoResizeTextarea(el);
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = el.value.length; });
            e.preventDefault();
        }
        return;
    }

    // Arrow Down — recall newer messages
    if (e.key === 'ArrowDown' && el.selectionEnd === el.value.length && !e.shiftKey) {
        if (_chatHistoryIndex > 0) {
            _chatHistoryIndex--;
            el.value = _chatMsgHistory[_chatHistoryIndex];
            _autoResizeTextarea(el);
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = el.value.length; });
            e.preventDefault();
        } else if (_chatHistoryIndex === 0) {
            _chatHistoryIndex = -1;
            el.value = _chatHistoryDraft;
            _autoResizeTextarea(el);
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = el.value.length; });
            e.preventDefault();
        }
        return;
    }
}

// Attach handlers to all chat textareas (delegated for dynamic elements too)
document.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('chat-textarea')) _chatTextareaKeydown(e);
}, true);
let _autoResizeTimer = null;
document.addEventListener('input', (e) => {
    if (!e.target.classList.contains('chat-textarea')) return;
    const el = e.target;
    clearTimeout(_autoResizeTimer);
    _autoResizeTimer = setTimeout(() => _autoResizeTextarea(el), 40);
}, true);

/* ── History ──────────────────────────────────────────────────── */
async function loadChatHistory(streamId) {
    if (!streamId) return; // Use loadGlobalChatHistory() for global
    try {
        const data = await api(`/chat/${streamId}/history?limit=500`);
        const msgs = data.messages || [];
        // Clear any loading skeleton / stale messages before inserting history
        const { messages } = getChatEl();
        if (messages) messages.innerHTML = '';
        msgs.forEach(m => {
            addChatMessage({
                id: m.id,
                username: m.username || m.display_name || `anon${m.user_id || ''}`,
                core_username: m.core_username || null,
                message: m.message,
                role: m.role || 'user',
                color: m.color,
                avatar_url: m.avatar_url,
                profile_color: m.profile_color,
                user_id: m.user_id,
                timestamp: m.timestamp,
                reply_to: m.reply_to || null,
            });
        });
    } catch { /* silent */ }
}

async function loadGlobalChatHistory() {
    try {
        const data = await api('/chat/global/history?limit=500');
        const msgs = data.messages || [];
        // Clear any loading skeleton / stale messages before inserting history
        const { messages } = getChatEl();
        if (messages) messages.innerHTML = '';
        msgs.forEach(m => {
            if (m.message_type === 'system') {
                // Render system messages (update announcements, etc.) with system styling
                addRichSystemMessage(esc(m.message), 'update');
            } else {
                addChatMessage({
                    id: m.id,
                    username: m.username || m.display_name || `anon${m.user_id || ''}`,
                    core_username: m.core_username || null,
                    message: m.message,
                    role: m.role || 'user',
                    color: m.color,
                    avatar_url: m.avatar_url,
                    profile_color: m.profile_color,
                    user_id: m.user_id,
                    timestamp: m.timestamp,
                    stream_username: m.stream_username || null,
                    reply_to: m.reply_to || null,
                });
            }
        });
    } catch { /* silent */ }
}

/* ═══════════════════════════════════════════════════════════════
   CONTEXT MENU
   ═══════════════════════════════════════════════════════════════ */

function showChatContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    dismissContextMenu();

    const target = event.currentTarget || event.target.closest('[data-username]');
    if (!target) return;
    const username = target.dataset.username;
    const coreUsername = target.dataset.coreUsername || username;
    const userId = target.dataset.userId;
    const isAnon = target.dataset.anon === '1';
    if (!username) return;

    // Extract message data from parent .chat-msg for reply support
    const msgEl = target.closest('.chat-msg');
    const msgId = msgEl?.dataset?.msgId || null;
    const isRelay = msgEl?.dataset?.isRelay === '1';
    const sourcePlatform = msgEl?.dataset?.sourcePlatform || '';

    const menu = document.createElement('div');
    menu.className = 'chat-context-menu';
    if (msgId) {
        menu.dataset.replyMsgId = msgId;
        menu.dataset.replyUsername = username;
        menu.dataset.replyUserId = userId || '';
        // Extract plain text of the message (everything after the username colon)
        const msgText = msgEl?.textContent?.split(username + ':')?.slice(1)?.join(':')?.trim() || '';
        menu.dataset.replyMessage = msgText.slice(0, 100);
    }
    // Store message and relay data for moderation actions
    menu.dataset.msgId = msgId || '';
    menu.dataset.isRelay = isRelay ? '1' : '';
    menu.dataset.sourcePlatform = sourcePlatform;
    menu.innerHTML = `
        <div class="ctx-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>
    `;

    // Position near the click
    document.body.appendChild(menu);
    positionContextMenu(menu, event.clientX, event.clientY);
    activeContextMenu = menu;

    // Fetch user profile (or render simplified menu for relay/anon users)
    if (isRelay) {
        renderRelayContextMenu(menu, username, sourcePlatform);
    } else {
        loadContextMenuProfile(menu, coreUsername, userId, isAnon);
    }

    // Clicks inside the menu shouldn't dismiss it (needed for rename submenu toggle etc.)
    menu.addEventListener('click', (e) => e.stopPropagation());

    // Click outside to dismiss
    setTimeout(() => {
        document.addEventListener('click', dismissContextMenu, { once: true });
    }, 10);
}

function positionContextMenu(menu, x, y) {
    // Initial position — invisible until we measure
    menu.style.visibility = 'hidden';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // ── Robust viewport-aware positioning ────────────────────
    // Runs after DOM paint so getBoundingClientRect has real dimensions.
    // Also handles profile card load (which changes menu height) via
    // a MutationObserver.
    const reposition = () => {
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pad = 8;

        let finalX = x;
        let finalY = y;

        // Horizontal: prefer right of cursor, flip left if needed
        if (finalX + rect.width > vw - pad) {
            finalX = Math.max(pad, x - rect.width);
        }
        if (finalX < pad) finalX = pad;

        // Vertical: prefer below cursor, flip above if needed
        if (finalY + rect.height > vh - pad) {
            finalY = Math.max(pad, y - rect.height);
        }
        if (finalY < pad) finalY = pad;

        // Last resort: if it still overflows, pin to edges and allow internal scroll
        if (rect.height > vh - pad * 2) {
            finalY = pad;
            menu.style.maxHeight = (vh - pad * 2) + 'px';
            menu.style.overflowY = 'auto';
        }

        menu.style.left = finalX + 'px';
        menu.style.top = finalY + 'px';
        menu.style.visibility = '';
    };

    requestAnimationFrame(reposition);

    // Re-position when content changes (profile card load, rename submenu toggle)
    const observer = new MutationObserver(() => requestAnimationFrame(reposition));
    observer.observe(menu, { childList: true, subtree: true, characterData: true });
    menu._repositionObserver = observer;

    // Re-position on window resize
    const onResize = () => {
        if (!menu.isConnected) {
            window.removeEventListener('resize', onResize);
            return;
        }
        reposition();
    };
    window.addEventListener('resize', onResize);
    menu._resizeHandler = onResize;
}

function dismissContextMenu() {
    if (activeContextMenu) {
        // Clean up observers
        if (activeContextMenu._repositionObserver) activeContextMenu._repositionObserver.disconnect();
        if (activeContextMenu._resizeHandler) window.removeEventListener('resize', activeContextMenu._resizeHandler);
        activeContextMenu.remove();
        activeContextMenu = null;
    }
}

async function loadContextMenuProfile(menu, username, userId, isAnon) {
    if (isAnon) {
        renderAnonContextMenu(menu, username, userId);
        return;
    }
    try {
        const profile = await api(`/chat/user/${encodeURIComponent(username)}/profile`);
        renderContextMenu(menu, profile, username);
    } catch {
        menu.innerHTML = `
            <div class="ctx-header">
                <span class="ctx-avatar-letter">${esc(username)[0].toUpperCase()}</span>
                <div class="ctx-info">
                    <span class="ctx-name">${esc(username)}</span>
                </div>
            </div>
            <div class="ctx-actions">
                <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxWhisper(this.dataset.username)"><i class="fa-solid fa-comment"></i> Message</button>
                <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxViewChannel(this.dataset.username)"><i class="fa-solid fa-user"></i> Channel</button>
            </div>
        `;
    }
}

function renderAnonContextMenu(menu, username, userId) {
    const initial = username[0] ? username[0].toUpperCase() : '?';
    const canMod = canModerateCurrentStream() && chatStreamId;
    const isGlobalMod = currentUser?.capabilities?.moderate_global;

    let modBtns = '';
    let banBtns = '';
    const showStreamBan = canMod;
    const showSiteBan = currentUser?.capabilities?.manage_site_bans;
    const showAdminTools = currentUser?.capabilities?.view_ip_info;

    // Delete message / delete all messages (moderators)
    if (canMod || isGlobalMod) {
        const msgId = menu.dataset.msgId;
        if (msgId) {
            modBtns += `<button class="ctx-btn ctx-btn-warn" onclick="ctxDeleteMessage('${esc(msgId)}')"><i class="fa-solid fa-trash"></i> Delete Message</button>`;
        }
        modBtns += `<button class="ctx-btn ctx-btn-warn" data-username="${esc(username)}" onclick="ctxDeleteAllAnonMessages(this.dataset.username)"><i class="fa-solid fa-trash-can"></i> Delete All Messages</button>`;
    }
    if (modBtns) modBtns = '<div class="ctx-divider"></div>' + modBtns;

    if (showStreamBan || showSiteBan || showAdminTools) banBtns += '<div class="ctx-divider"></div>';
    if (showAdminTools) {
        banBtns += `<button class="ctx-btn ctx-btn-admin-tools" data-username="${esc(username)}" data-uid="" data-anon="1" onclick="ctxAdminTools(this.dataset.username, null, this.dataset.username)"><i class="fa-solid fa-shield-halved"></i> Admin Tools</button>`;
    }
    if (showStreamBan) {
        banBtns += `<button class="ctx-btn ctx-btn-danger" data-username="${esc(username)}" data-uid="${esc(userId)}" onclick="ctxStreamBan(this.dataset.username, null, this.dataset.username)"><i class="fa-solid fa-comment-slash"></i> Ban from stream</button>`;
    }
    if (showSiteBan) {
        banBtns += `<button class="ctx-btn ctx-btn-danger" data-username="${esc(username)}" data-uid="${esc(userId)}" onclick="ctxGlobalBanAnon(this.dataset.username)"><i class="fa-solid fa-ban"></i> Ban from site</button>`;
    }
    menu.innerHTML = `
        <div class="ctx-header">
            <span class="ctx-avatar-letter" style="background:#666">${initial}</span>
            <div class="ctx-info">
                <span class="ctx-name">${esc(username)}</span>
                <span class="ctx-meta">Anonymous user</span>
            </div>
        </div>
        <div class="ctx-actions">
            ${menu.dataset.replyMsgId ? `<button class="ctx-btn" onclick="ctxReply()"><i class="fa-solid fa-reply"></i> Reply</button>` : ''}
            <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxWhisper(this.dataset.username)"><i class="fa-solid fa-comment"></i> Message</button>
            ${modBtns}
            ${banBtns}
        </div>
    `;
}

function renderContextMenu(menu, profile, username) {
    const avatarHtml = profile.avatar_url
        ? `<img class="ctx-avatar" src="${esc(profile.avatar_url)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''">`
          + `<span class="ctx-avatar-letter" style="display:none;background:${esc(profile.profile_color || '#999')}">${esc(username)[0].toUpperCase()}</span>`
        : `<span class="ctx-avatar-letter" style="background:${esc(profile.profile_color || '#999')}">${esc(username)[0].toUpperCase()}</span>`;

    const badge = getBadgeHTML(profile.role);
    const joined = profile.created_at ? timeAgoShort(profile.created_at) : '?';

    // Game stats
    let gameHtml = '';
    if (profile.game) {
        const g = profile.game;
        gameHtml = `
            <div class="ctx-game">
                <div class="ctx-game-level">Lv. <strong>${g.total_level}</strong></div>
                <div class="ctx-skills">
                    <span title="Mining ${g.mining_level}"><i class="fa-solid fa-gem"></i>${g.mining_level}</span>
                    <span title="Fishing ${g.fishing_level}"><i class="fa-solid fa-fish"></i>${g.fishing_level}</span>
                    <span title="Woodcutting ${g.woodcut_level}"><i class="fa-solid fa-tree"></i>${g.woodcut_level}</span>
                    <span title="Farming ${g.farming_level}"><i class="fa-solid fa-seedling"></i>${g.farming_level}</span>
                    <span title="Combat ${g.combat_level}"><i class="fa-solid fa-sword"></i>${g.combat_level}</span>
                    <span title="Crafting ${g.crafting_level}"><i class="fa-solid fa-hammer"></i>${g.crafting_level}</span>
                </div>
            </div>
        `;
    }

    // Coins + messages
    const coins = profile.hobo_coins_balance || 0;
    const msgs = profile.messageCount || 0;

    // Moderation: delete message / delete all messages
    const canMod = canModerateCurrentStream() && chatStreamId;
    const isGlobalMod = currentUser?.capabilities?.moderate_global;
    let modBtns = '';
    if (canMod || isGlobalMod) {
        const msgId = menu.dataset.msgId;
        if (msgId) {
            modBtns += `<button class="ctx-btn ctx-btn-warn" onclick="ctxDeleteMessage('${esc(String(msgId))}')"><i class="fa-solid fa-trash"></i> Delete Message</button>`;
        }
        modBtns += `<button class="ctx-btn ctx-btn-warn" data-uid="${profile.id}" onclick="ctxDeleteAllUserMessages(this.dataset.uid)"><i class="fa-solid fa-trash-can"></i> Delete All Messages</button>`;
    }

    menu.innerHTML = `
        <div class="ctx-header">
            ${avatarHtml}
            <div class="ctx-info">
                <span class="ctx-name">${badge}${esc(profile.display_name || username)}</span>
                <span class="ctx-meta">@${esc(username)} &middot; ${joined}</span>
            </div>
        </div>
        <div class="ctx-stats">
            <div class="ctx-stat"><i class="fa-solid fa-coins"></i> ${formatNumber(coins)}</div>
            <div class="ctx-stat"><i class="fa-solid fa-message"></i> ${formatNumber(msgs)}</div>
            <div class="ctx-stat"><i class="fa-solid fa-heart"></i> ${formatNumber(profile.followerCount || 0)}</div>
        </div>
        ${gameHtml}
        <div class="ctx-divider"></div>
        <div class="ctx-actions">
            ${menu.dataset.replyMsgId ? `<button class="ctx-btn" onclick="ctxReply()"><i class="fa-solid fa-reply"></i> Reply</button>` : ''}
            <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxWhisper(this.dataset.username)"><i class="fa-solid fa-comment"></i> Message</button>
            ${currentUser?.id && currentUser.id !== profile.id ? `<button class="ctx-btn" data-username="${esc(username)}" data-uid="${profile.id}" onclick="ctxCallUser(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-phone"></i> Call this user</button>` : ''}
            <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxViewChannel(this.dataset.username)"><i class="fa-solid fa-user"></i> Channel</button>
            ${currentUser?.capabilities?.view_all_logs ? `<button class="ctx-btn" data-username="${esc(username)}" data-uid="${profile.id}" onclick="ctxViewLogs(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-clock-rotate-left"></i> Chat Logs</button>` : ''}
            ${currentUser?.capabilities?.manage_users ? `<div class="ctx-rename-group">
                <button class="ctx-btn" onclick="this.parentElement.classList.toggle('open')" type="button"><i class="fa-solid fa-pen"></i> Rename <i class="fa-solid fa-chevron-right ctx-rename-arrow"></i></button>
                <div class="ctx-rename-submenu">
                    <button class="ctx-btn" data-username="${esc(username)}" data-uid="${profile.id}" onclick="ctxRenameUsername(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-at"></i> Rename Username</button>
                    <button class="ctx-btn" data-username="${esc(username)}" data-uid="${profile.id}" data-display="${esc(profile.display_name || username)}" onclick="ctxRenameDisplayName(this.dataset.username, this.dataset.uid, this.dataset.display)"><i class="fa-solid fa-signature"></i> Rename Display Name</button>
                </div>
            </div>` : ''}
            ${modBtns ? '<div class="ctx-divider"></div>' + modBtns : ''}
            ${(canModerateCurrentStream() && chatStreamId) || currentUser?.capabilities?.manage_site_bans || currentUser?.capabilities?.view_ip_info ? '<div class="ctx-divider"></div>' : ''}
            ${currentUser?.capabilities?.view_ip_info ? `<button class="ctx-btn ctx-btn-admin-tools" data-username="${esc(username)}" data-uid="${profile.id}" onclick="ctxAdminTools(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-shield-halved"></i> Admin Tools</button>` : ''}
            ${canModerateCurrentStream() && chatStreamId ? `<button class="ctx-btn ctx-btn-danger" data-username="${esc(username)}" data-uid="${profile.id}" onclick="ctxStreamBan(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-comment-slash"></i> Ban from stream</button>` : ''}
            ${currentUser?.capabilities?.manage_site_bans ? `<button class="ctx-btn ctx-btn-danger" data-username="${esc(username)}" data-uid="${profile.id}" onclick="ctxGlobalBan(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-ban"></i> Ban from site</button>` : ''}
        </div>
    `;
}

/* ── Context menu actions ─────────────────────────────────────── */
function ctxReply() {
    const menu = activeContextMenu;
    if (!menu?.dataset?.replyMsgId) return;
    setChatReply({
        id: parseInt(menu.dataset.replyMsgId),
        username: menu.dataset.replyUsername,
        user_id: menu.dataset.replyUserId ? parseInt(menu.dataset.replyUserId) : null,
        message: menu.dataset.replyMessage || '',
    });
    dismissContextMenu();
}

function ctxWhisper(username) {
    dismissContextMenu();
    // Route to the DM messenger widget instead of the old whisper command
    if (typeof window.openMessengerDm === 'function') {
        window.openMessengerDm(username);
    } else {
        toast('Messenger not available', 'error');
    }
}

async function ctxCallUser(username, userId) {
    dismissContextMenu();
    if (!currentUser) {
        toast('Log in to call users', 'error');
        return;
    }
    try {
        const data = await api('/streams/voice-channels/call-user', {
            method: 'POST',
            body: { user_id: Number(userId) || null, username },
        });
        if (!data?.channel?.id) throw new Error('Call channel not available');
        await _joinVoiceChannelFromInvite(data.channel.id, data.channel.name || 'Voice Channel', false);
        _showOutgoingVcCallOverlay(username, userId, data.channel.id, data.channel.name || 'Voice Channel');
        toast(`Calling ${username}...`, 'success');
    } catch (err) {
        _dismissOutgoingVcCallOverlay();
        toast(err.message || 'Failed to place call', 'error');
    }
}

async function _joinVoiceChannelFromInvite(channelId, channelName, switchToChat = false) {
    if (!channelId) return;

    if (switchToChat && typeof showPage === 'function') {
        showPage('chat');
    }

    if (typeof vcFetchChannels !== 'function' || typeof vcJoinChannel !== 'function' || typeof vcState === 'undefined') {
        window._pendingVcInvite = { channelId, channelName, at: Date.now() };
        toast(`Invite received for ${channelName || 'Voice Channel'}. Open Chat to join.`, 'info');
        return;
    }

    await vcFetchChannels();
    const ch = (vcState.channels || []).find(c => c.id === channelId);
    if (!ch) {
        toast('That call channel is no longer available', 'error');
        return;
    }
    if (typeof callState !== 'undefined' && callState.joined && callState.channelId === ch.id) {
        return;
    }
    await vcJoinChannel(ch);
}

async function acceptVcInvite(channelId, channelName) {
    try {
        _dismissIncomingVcCallOverlay();
        await _joinVoiceChannelFromInvite(channelId, channelName || 'Voice Channel', true);
    } catch (err) {
        toast(err.message || 'Failed to join call invite', 'error');
    }
}

function ctxViewChannel(username) {
    dismissContextMenu();
    navigate(`/${username}`);
}

function ctxViewLogs(username, userId) {
    dismissContextMenu();
    openChatLogsModal(username, userId);
}

async function ctxRenameUsername(username, userId) {
    dismissContextMenu();
    const newUsername = prompt(`Rename username for @${username}:`, username);
    if (newUsername == null || !newUsername.trim()) return;
    try {
        await api(`/admin/users/${userId}`, { method: 'PUT', body: { username: newUsername.trim() } });
        toast(`Username changed: @${username} → @${newUsername.trim()}`, 'success');
    } catch (err) {
        toast('Failed to rename username: ' + (err.message || 'unknown error'), 'error');
    }
}

async function ctxRenameDisplayName(username, userId, currentDisplay) {
    dismissContextMenu();
    const newName = prompt(`Rename display name for @${username}:`, currentDisplay || username);
    if (newName == null || !newName.trim()) return;
    try {
        await api(`/admin/users/${userId}`, { method: 'PUT', body: { display_name: newName.trim() } });
        toast(`Display name changed: @${username} → ${newName.trim()}`, 'success');
    } catch (err) {
        toast('Failed to rename display name: ' + (err.message || 'unknown error'), 'error');
    }
}

/**
 * Can the current user moderate the chat stream they're viewing?
 * Checks global mod capability OR stream ownership.
 */
function canModerateCurrentStream() {
    if (!currentUser) return false;
    if (currentUser.capabilities?.moderate_global) return true;
    // Stream owner can moderate their own stream
    if (currentStreamData && currentStreamData.user_id === currentUser.id) return true;
    // Channel mods — if the server told us we can moderate, the chatStreamId will match
    // For now, channel mods use /ban command in chat. Context menu covers global mods + owners.
    return false;
}

function ctxStreamBan(username, userId, anonId) {
    dismissContextMenu();
    if (!chatStreamId) return toast('Not in a stream chat', 'error');
    if (!confirm(`Ban ${username} from this stream?`)) return;
    const body = { stream_id: chatStreamId, reason: 'Banned via chat' };
    if (userId) body.user_id = userId;
    if (anonId) body.anon_id = anonId;
    api('/mod/stream-ban', { method: 'POST', body })
        .then(() => toast(`${username} banned from stream`, 'success'))
        .catch(e => toast(e.message || 'Ban failed', 'error'));
}

function ctxGlobalBan(username, userId) {
    dismissContextMenu();
    // Prefer staff console ban UI if available (has reason/duration prompt + audit logging)
    if (typeof staffBanUser === 'function') {
        staffBanUser(userId, username, 'Banned via chat', 0);
        return;
    }
    if (!confirm(`⚠️ GLOBAL BAN: Ban ${username} from the entire site? This also IP-bans them.`)) return;
    api('/mod/global-ban', { method: 'POST', body: { user_id: userId, reason: 'Banned via chat' } })
        .then(() => toast(`${username} globally banned`, 'success'))
        .catch(e => toast(e.message || 'Ban failed', 'error'));
}

function ctxGlobalBanAnon(anonName) {
    dismissContextMenu();
    if (!confirm(`⚠️ GLOBAL BAN: Ban ${anonName} from the entire site? This will IP-ban them and all associated accounts.`)) return;
    // Look up anon IP first, then ban-all on that IP
    api(`/mod/ip/anon/${encodeURIComponent(anonName)}`)
        .then(data => {
            if (!data.current_ip) {
                toast('Could not determine IP for this anonymous user.', 'error');
                return;
            }
            return api('/mod/ip/ban-all', { method: 'POST', body: { ip: data.current_ip, reason: `Banned via chat (${anonName})` } });
        })
        .then(result => {
            if (result) toast(`${anonName} IP-banned (${result.banned_user_ids?.length || 0} associated accounts also banned)`, 'success');
        })
        .catch(e => toast(e.message || 'Ban failed', 'error'));
}

/* ── Message deletion actions ─────────────────────────────────── */

function ctxDeleteMessage(msgId) {
    dismissContextMenu();
    if (!msgId) return;
    api('/mod/delete-message', { method: 'POST', body: { message_id: msgId, stream_id: chatStreamId || null } })
        .then(() => toast('Message deleted', 'success'))
        .catch(e => toast(e.message || 'Delete failed', 'error'));
}

function ctxDeleteAllUserMessages(userId) {
    dismissContextMenu();
    if (!userId) return;
    const scope = currentUser?.capabilities?.moderate_global ? 'globally' : 'from this stream';
    if (!confirm(`Delete ALL messages from this user ${scope}?`)) return;
    const body = { user_id: userId };
    if (chatStreamId) body.stream_id = chatStreamId;
    api('/mod/delete-user-messages', { method: 'POST', body })
        .then(r => toast(`Deleted ${r.count || 0} message(s)`, 'success'))
        .catch(e => toast(e.message || 'Delete failed', 'error'));
}

function ctxDeleteAllAnonMessages(anonId) {
    dismissContextMenu();
    if (!anonId) return;
    const scope = currentUser?.capabilities?.moderate_global ? 'globally' : 'from this stream';
    if (!confirm(`Delete ALL messages from ${anonId} ${scope}?`)) return;
    const body = { anon_id: anonId };
    if (chatStreamId) body.stream_id = chatStreamId;
    api('/mod/delete-user-messages', { method: 'POST', body })
        .then(r => toast(`Deleted ${r.count || 0} message(s)`, 'success'))
        .catch(e => toast(e.message || 'Delete failed', 'error'));
}

function ctxDeleteRelayMessages(relayUsername) {
    dismissContextMenu();
    if (!relayUsername) return;
    const scope = currentUser?.capabilities?.moderate_global ? 'globally' : 'from this stream';
    if (!confirm(`Delete ALL messages from ${relayUsername} ${scope}?`)) return;
    const body = { relay_username: relayUsername };
    if (chatStreamId) body.stream_id = chatStreamId;
    api('/mod/delete-user-messages', { method: 'POST', body })
        .then(r => toast(`Deleted ${r.count || 0} message(s)`, 'success'))
        .catch(e => toast(e.message || 'Delete failed', 'error'));
}

/* ── Relay user moderation ────────────────────────────────────── */

/**
 * Parse a relay username like "[Twitch] foobar" into { platform, externalUsername }.
 */
function parseRelayUsername(prefixedUsername) {
    const match = prefixedUsername.match(/^\[(\w+)\]\s*(.+)$/);
    if (match) return { platform: match[1].toLowerCase(), externalUsername: match[2] };
    return { platform: '', externalUsername: prefixedUsername };
}

function ctxHideRelayUser(prefixedUsername) {
    dismissContextMenu();
    const { platform, externalUsername } = parseRelayUsername(prefixedUsername);
    if (!platform) return toast('Could not identify platform', 'error');
    if (!confirm(`Hide [${platform}] ${externalUsername} from this stream? Their messages will no longer appear.`)) return;
    api('/mod/relay-user/hide', {
        method: 'POST',
        body: {
            channel_id: currentStreamData?.channel_id || null,
            platform,
            external_username: externalUsername,
            action: 'hide',
            reason: 'Hidden via chat context menu',
        },
    })
        .then(() => toast(`[${platform}] ${externalUsername} hidden`, 'success'))
        .catch(e => toast(e.message || 'Hide failed', 'error'));
}

function ctxBanRelayUser(prefixedUsername) {
    dismissContextMenu();
    const { platform, externalUsername } = parseRelayUsername(prefixedUsername);
    if (!platform) return toast('Could not identify platform', 'error');
    if (!confirm(`⚠️ Ban [${platform}] ${externalUsername}? Their messages will be hidden and future messages blocked.`)) return;
    // Ban the relay user AND delete their messages
    const body = {
        channel_id: currentStreamData?.channel_id || null,
        platform,
        external_username: externalUsername,
        action: 'ban',
        reason: 'Banned via chat context menu',
    };
    api('/mod/relay-user/hide', { method: 'POST', body })
        .then(() => {
            // Also delete their existing messages
            const deleteBody = { relay_username: prefixedUsername };
            if (chatStreamId) deleteBody.stream_id = chatStreamId;
            return api('/mod/delete-user-messages', { method: 'POST', body: deleteBody });
        })
        .then(r => toast(`[${platform}] ${externalUsername} banned — ${r?.count || 0} message(s) deleted`, 'success'))
        .catch(e => toast(e.message || 'Ban failed', 'error'));
}

/**
 * Render context menu for relayed external users (Twitch, Kick, YouTube, RS).
 */
function renderRelayContextMenu(menu, username, sourcePlatform) {
    const { platform, externalUsername } = parseRelayUsername(username);
    const displayPlatform = platform.charAt(0).toUpperCase() + platform.slice(1);
    const initial = externalUsername[0] ? externalUsername[0].toUpperCase() : '?';

    const platformColors = { twitch: '#9146ff', kick: '#53fc18', youtube: '#ff0000', rs: '#e67e22' };
    const color = platformColors[platform] || '#888';

    const canMod = canModerateCurrentStream() && chatStreamId;
    const isGlobalMod = currentUser?.capabilities?.moderate_global;

    let modBtns = '';
    if (canMod || isGlobalMod) {
        const msgId = menu.dataset.msgId;
        if (msgId) {
            modBtns += `<button class="ctx-btn ctx-btn-warn" onclick="ctxDeleteMessage('${esc(String(msgId))}')"><i class="fa-solid fa-trash"></i> Delete Message</button>`;
        }
        modBtns += `<button class="ctx-btn ctx-btn-warn" data-username="${esc(username)}" onclick="ctxDeleteRelayMessages(this.dataset.username)"><i class="fa-solid fa-trash-can"></i> Delete All Messages</button>`;
        modBtns += `<button class="ctx-btn ctx-btn-warn" data-username="${esc(username)}" onclick="ctxHideRelayUser(this.dataset.username)"><i class="fa-solid fa-eye-slash"></i> Hide from stream</button>`;
        modBtns += `<button class="ctx-btn ctx-btn-danger" data-username="${esc(username)}" onclick="ctxBanRelayUser(this.dataset.username)"><i class="fa-solid fa-ban"></i> Ban from stream</button>`;
    }

    menu.innerHTML = `
        <div class="ctx-header">
            <span class="ctx-avatar-letter" style="background:${esc(color)}">${initial}</span>
            <div class="ctx-info">
                <span class="ctx-name">${esc(externalUsername)}</span>
                <span class="ctx-meta"><i class="fa-solid fa-link"></i> ${esc(displayPlatform)} relay user</span>
            </div>
        </div>
        <div class="ctx-actions">
            ${menu.dataset.replyMsgId ? `<button class="ctx-btn" onclick="ctxReply()"><i class="fa-solid fa-reply"></i> Reply</button>` : ''}
            ${modBtns ? '<div class="ctx-divider"></div>' + modBtns : ''}
        </div>
    `;
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN TOOLS PANEL
   ═══════════════════════════════════════════════════════════════ */

/**
 * Open the Admin Tools modal for a user or anon.
 * Shows: IP info, GeoIP, IP history, linked accounts (alts), ban controls.
 */
async function ctxAdminTools(username, userId, anonId) {
    dismissContextMenu();
    closeModal();

    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    if (!overlay || !content) return;

    const isAnon = !userId || userId === '';
    const displayName = username;

    content.innerHTML = `
        <div class="admin-tools-modal">
            <div class="admin-tools-header">
                <h3><i class="fa-solid fa-shield-halved"></i> Admin Tools — ${esc(displayName)}</h3>
                <button class="modal-close-btn" onclick="closeModal()"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="admin-tools-body">
                <div class="admin-tools-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading IP intelligence...</div>
            </div>
        </div>
    `;
    overlay.classList.add('show');

    try {
        let data;
        if (isAnon) {
            data = await api(`/mod/ip/anon/${encodeURIComponent(anonId || username)}`);
            renderAdminToolsAnon(content.querySelector('.admin-tools-body'), data, username);
        } else {
            data = await api(`/mod/ip/user/${encodeURIComponent(userId)}`);
            renderAdminToolsUser(content.querySelector('.admin-tools-body'), data, username);
        }
    } catch (err) {
        content.querySelector('.admin-tools-body').innerHTML = `
            <div class="admin-tools-error"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load: ${esc(err.message)}</div>
        `;
    }
}

function renderAdminToolsUser(container, data, username) {
    const { user, ips, linked_accounts, live_ip } = data;

    // Current IP section
    const currentIp = live_ip || (ips.length ? ips[0].ip_address : 'Unknown');
    const currentGeo = ips.length ? ips[0] : {};

    let html = `
        <div class="at-section">
            <h4><i class="fa-solid fa-user"></i> User Info</h4>
            <div class="at-info-grid">
                <span class="at-label">Username</span><span class="at-value">@${esc(user.username)}</span>
                <span class="at-label">Display Name</span><span class="at-value">${esc(user.display_name || user.username)}</span>
                <span class="at-label">Role</span><span class="at-value at-role-${esc(user.role)}">${esc(user.role)}</span>
                <span class="at-label">Joined</span><span class="at-value">${user.created_at ? new Date(user.created_at).toLocaleDateString() : '?'}</span>
                <span class="at-label">Status</span><span class="at-value ${user.is_banned ? 'at-banned' : 'at-active'}">${user.is_banned ? '⛔ BANNED' : '✅ Active'}${user.ban_reason ? ' — ' + esc(user.ban_reason) : ''}</span>
            </div>
        </div>

        <div class="at-section">
            <h4><i class="fa-solid fa-globe"></i> Current IP</h4>
            <div class="at-ip-card at-ip-current">
                <span class="at-ip-address" title="Click to copy" onclick="navigator.clipboard.writeText('${esc(currentIp)}');toast('IP copied','success')">${esc(currentIp)}</span>
                ${live_ip ? '<span class="at-live-badge">● LIVE</span>' : ''}
                ${formatGeoLine(currentGeo)}
            </div>
        </div>
    `;

    // IP History
    if (ips.length) {
        html += `
            <div class="at-section">
                <h4><i class="fa-solid fa-clock-rotate-left"></i> IP History (${ips.length})</h4>
                <div class="at-ip-list">
                    ${ips.map(ip => `
                        <div class="at-ip-card">
                            <div class="at-ip-row">
                                <span class="at-ip-address" title="Click to copy" onclick="navigator.clipboard.writeText('${esc(ip.ip_address)}');toast('IP copied','success')">${esc(ip.ip_address)}</span>
                                <span class="at-ip-hits">${ip.hit_count} hits</span>
                            </div>
                            ${formatGeoLine(ip)}
                            <div class="at-ip-times">
                                <span>First: ${timeAgoShort(ip.first_seen)}</span>
                                <span>Last: ${timeAgoShort(ip.last_seen)}</span>
                                <span>Actions: ${esc(ip.actions || '')}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Linked accounts (alts)
    if (linked_accounts && linked_accounts.length) {
        html += `
            <div class="at-section">
                <h4><i class="fa-solid fa-users"></i> Linked Accounts — Alt Detection (${linked_accounts.length})</h4>
                <div class="at-alts-list">
                    ${linked_accounts.map(alt => `
                        <div class="at-alt-card ${alt.is_banned ? 'at-alt-banned' : ''}">
                            <div class="at-alt-row">
                                <span class="at-alt-name" onclick="ctxAdminTools('${esc(alt.username)}', '${alt.id}')" title="Open admin tools for this user">@${esc(alt.username)}</span>
                                <span class="at-alt-role at-role-${esc(alt.role)}">${esc(alt.role)}</span>
                                ${alt.is_banned ? '<span class="at-banned-badge">BANNED</span>' : ''}
                            </div>
                            <div class="at-alt-detail">
                                <span>${alt.shared_ip_count} shared IP${alt.shared_ip_count > 1 ? 's' : ''}</span>
                                <span>Last shared: ${timeAgoShort(alt.last_shared_activity)}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    } else {
        html += `
            <div class="at-section">
                <h4><i class="fa-solid fa-users"></i> Linked Accounts</h4>
                <div class="at-empty">No linked accounts found (no shared IPs)</div>
            </div>
        `;
    }

    // Quick actions
    html += `
        <div class="at-section at-actions">
            <h4><i class="fa-solid fa-bolt"></i> Quick Actions</h4>
            <div class="at-action-grid">
                ${currentIp !== 'Unknown' ? `<button class="btn btn-sm at-action-btn" onclick="adminToolsIpBanAll('${esc(currentIp)}', '${esc(username)}')"><i class="fa-solid fa-ban"></i> Ban IP + All Accounts</button>` : ''}
                <button class="btn btn-sm at-action-btn" onclick="ctxViewLogs('${esc(username)}', '${data.user.id}');closeModal()"><i class="fa-solid fa-clock-rotate-left"></i> View Chat Logs</button>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

function renderAdminToolsAnon(container, data, username) {
    const { anon_id, current_ip, geo, linked_accounts } = data;

    let html = `
        <div class="at-section">
            <h4><i class="fa-solid fa-ghost"></i> Anonymous User</h4>
            <div class="at-info-grid">
                <span class="at-label">Anon ID</span><span class="at-value">${esc(anon_id)}</span>
            </div>
        </div>

        <div class="at-section">
            <h4><i class="fa-solid fa-globe"></i> IP Address</h4>
            <div class="at-ip-card at-ip-current">
                <span class="at-ip-address" title="Click to copy" onclick="navigator.clipboard.writeText('${esc(current_ip || 'unknown')}');toast('IP copied','success')">${esc(current_ip || 'Unknown')}</span>
                ${geo ? formatGeoFromObj(geo) : '<span class="at-geo">No geo data</span>'}
            </div>
        </div>
    `;

    // Linked accounts
    if (linked_accounts && linked_accounts.length) {
        html += `
            <div class="at-section">
                <h4><i class="fa-solid fa-users"></i> Linked Accounts — Alt Detection (${linked_accounts.length})</h4>
                <div class="at-alts-list">
                    ${linked_accounts.map(alt => `
                        <div class="at-alt-card ${alt.is_banned ? 'at-alt-banned' : ''}">
                            <div class="at-alt-row">
                                <span class="at-alt-name" onclick="ctxAdminTools('${esc(alt.username || 'anon')}', '${alt.id || ''}')" title="Open admin tools">${alt.username ? '@' + esc(alt.username) : 'Anonymous'}</span>
                                ${alt.role ? `<span class="at-alt-role at-role-${esc(alt.role)}">${esc(alt.role)}</span>` : ''}
                                ${alt.is_banned ? '<span class="at-banned-badge">BANNED</span>' : ''}
                            </div>
                            <div class="at-alt-detail">
                                <span>${alt.shared_ip_count} shared IP${alt.shared_ip_count > 1 ? 's' : ''}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Quick actions
    if (current_ip) {
        html += `
            <div class="at-section at-actions">
                <h4><i class="fa-solid fa-bolt"></i> Quick Actions</h4>
                <div class="at-action-grid">
                    <button class="btn btn-sm at-action-btn" onclick="adminToolsIpBanAll('${esc(current_ip)}', '${esc(username)}')"><i class="fa-solid fa-ban"></i> Ban IP + All Accounts</button>
                </div>
            </div>
        `;
    }

    container.innerHTML = html;
}

function formatGeoLine(ip) {
    const parts = [];
    if (ip.geo_city) parts.push(ip.geo_city);
    if (ip.geo_region) parts.push(ip.geo_region);
    if (ip.geo_country) parts.push(ip.geo_country);
    if (!parts.length) return '';
    return `<span class="at-geo"><i class="fa-solid fa-location-dot"></i> ${esc(parts.join(', '))}${ip.geo_isp ? ' — ' + esc(ip.geo_isp) : ''}</span>`;
}

function formatGeoFromObj(geo) {
    const parts = [];
    if (geo.city) parts.push(geo.city);
    if (geo.region) parts.push(geo.region);
    if (geo.country) parts.push(geo.country);
    if (!parts.length) return '<span class="at-geo">No geo data</span>';
    return `<span class="at-geo"><i class="fa-solid fa-location-dot"></i> ${esc(parts.join(', '))}${geo.isp ? ' — ' + esc(geo.isp) : ''}</span>`;
}

async function adminToolsIpBanAll(ip, username) {
    if (!confirm(`⚠️ IP BAN: Ban ${ip} and ALL associated accounts?\n\nThis will:\n- IP-ban this address\n- Global-ban every account that has ever used this IP\n- Return 404 for all pages from this IP\n\nThis action cannot be easily undone.`)) return;
    try {
        const result = await api('/mod/ip/ban-all', { method: 'POST', body: { ip, reason: `IP ban via Admin Tools (user: ${username})` } });
        toast(`IP banned: ${ip} — ${result.banned_user_ids?.length || 0} account(s) banned`, 'success');
        // Refresh the admin tools panel if still open
        const body = document.querySelector('.admin-tools-body');
        if (body) {
            body.innerHTML = '<div class="admin-tools-loading"><i class="fa-solid fa-check" style="color:var(--success)"></i> Ban applied. Close and reopen to refresh.</div>';
        }
    } catch (e) {
        toast(e.message || 'Ban failed', 'error');
    }
}

/* ═══════════════════════════════════════════════════════════════
   CHAT LOGS MODAL
   ═══════════════════════════════════════════════════════════════ */

function openChatLogsModal(username, userId) {
    // Close existing modal overlay if open
    closeModal();

    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    if (!overlay || !content) return;

    content.innerHTML = `
        <div class="chat-logs-modal">
            <div class="chat-logs-header">
                <h3><i class="fa-solid fa-clock-rotate-left"></i> Chat Logs${username ? ` — ${esc(username)}` : ''}</h3>
                <div class="chat-logs-search-row">
                    <input type="text" id="chat-logs-search" class="chat-logs-search" placeholder="Search messages..." onkeydown="if(event.key==='Enter')searchChatLogs()">
                    <button class="btn btn-sm" onclick="searchChatLogs()"><i class="fa-solid fa-search"></i></button>
                </div>
            </div>
            <div class="chat-logs-body" id="chat-logs-body">
                <div class="chat-logs-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>
            </div>
            <div class="chat-logs-footer" id="chat-logs-footer"></div>
        </div>
    `;

    overlay.classList.add('show');

    // Store context on the modal for pagination
    content._logsCtx = { username, userId, offset: 0, query: '' };

    loadChatLogs();
}

async function loadChatLogs() {
    const content = document.getElementById('modal-content');
    if (!content?._logsCtx) return;
    const ctx = content._logsCtx;
    const body = document.getElementById('chat-logs-body');
    const footer = document.getElementById('chat-logs-footer');
    if (!body) return;

    body.innerHTML = '<div class="chat-logs-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>';

    try {
        let url, result;
        if (ctx.userId && !ctx.query) {
            // User history mode
            url = `/chat/user/${ctx.userId}/history?limit=50&offset=${ctx.offset}`;
            result = await api(url);
        } else {
            // Search mode
            const params = new URLSearchParams({ limit: '50', offset: String(ctx.offset) });
            if (ctx.query) params.set('q', ctx.query);
            if (ctx.userId) params.set('user_id', String(ctx.userId));
            url = `/chat/search?${params}`;
            result = await api(url);
        }

        const msgs = result.messages || [];
        const total = result.total || 0;

        if (msgs.length === 0) {
            body.innerHTML = '<p class="muted" style="text-align:center;padding:20px">No messages found</p>';
        } else {
            body.innerHTML = msgs.map(m => {
                const ts = m.timestamp ? new Date(m.timestamp.replace(' ', 'T') + (m.timestamp.includes('Z') ? '' : 'Z')).toLocaleString() : '';
                const name = esc(m.display_name || m.username || 'anon');
                const stream = m.stream_title ? ` <span class="log-stream">${esc(m.stream_title)}</span>` : '';
                return `<div class="log-entry">
                    <span class="log-time">${ts}</span>${stream}
                    <span class="log-user" style="color:${esc(m.profile_color || '#999')}">${name}</span>:
                    <span class="log-text">${esc(m.message)}</span>
                </div>`;
            }).join('');
        }

        // Pagination
        const pages = Math.ceil(total / 50);
        const curPage = Math.floor(ctx.offset / 50) + 1;
        if (pages > 1 && footer) {
            footer.innerHTML = `
                <button class="btn btn-sm" ${ctx.offset <= 0 ? 'disabled' : ''} onclick="chatLogsPrev()"><i class="fa-solid fa-chevron-left"></i></button>
                <span class="log-page-info">Page ${curPage} of ${pages} (${total} msgs)</span>
                <button class="btn btn-sm" ${curPage >= pages ? 'disabled' : ''} onclick="chatLogsNext()"><i class="fa-solid fa-chevron-right"></i></button>
            `;
        } else if (footer) {
            footer.innerHTML = total > 0 ? `<span class="log-page-info">${total} messages</span>` : '';
        }
    } catch (err) {
        body.innerHTML = '<p class="muted" style="text-align:center;padding:20px">Failed to load logs</p>';
    }
}

function searchChatLogs() {
    const content = document.getElementById('modal-content');
    if (!content?._logsCtx) return;
    const input = document.getElementById('chat-logs-search');
    content._logsCtx.query = input?.value?.trim() || '';
    content._logsCtx.offset = 0;
    loadChatLogs();
}

function chatLogsPrev() {
    const content = document.getElementById('modal-content');
    if (!content?._logsCtx) return;
    content._logsCtx.offset = Math.max(0, content._logsCtx.offset - 50);
    loadChatLogs();
}

function chatLogsNext() {
    const content = document.getElementById('modal-content');
    if (!content?._logsCtx) return;
    content._logsCtx.offset += 50;
    loadChatLogs();
}

/* ── Helpers ──────────────────────────────────────────────────── */
function getBadgeHTML(role) {
    switch (role) {
        case 'admin': return '<span class="chat-badge chat-badge-admin" title="Admin"><i class="fa-solid fa-shield"></i></span>';
        case 'streamer': return '<span class="chat-badge chat-badge-streamer" title="Streamer"><i class="fa-solid fa-broadcast-tower"></i></span>';
        case 'global_mod':
        case 'mod':
        case 'moderator': return '<span class="chat-badge chat-badge-mod" title="Moderator"><i class="fa-solid fa-gavel"></i></span>';
        case 'subscriber': return '<span class="chat-badge chat-badge-sub" title="Subscriber"><i class="fa-solid fa-star"></i></span>';
        default: return '';
    }
}

function getRoleColor(role) {
    switch (role) {
        case 'admin': return '#f39c12';
        case 'streamer': return '#e74c3c';
        case 'global_mod':
        case 'mod':
        case 'moderator': return '#2ecc71';
        case 'subscriber': return '#3498db';
        default: return '#9a9a9a';
    }
}

let _chatUserScrolledUp = false;
let _chatUnreadCount = 0;
let _loadingHistory = false;

function scrollChat() {
    const { messages: container } = getChatEl();
    if (!container) return;
    // Only auto-scroll if user is near the bottom
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (nearBottom) {
        container.scrollTop = container.scrollHeight;
        _chatUserScrolledUp = false;
        _chatUnreadCount = 0;
        _hideChatNewMessagesIndicator();
    } else {
        _chatUserScrolledUp = true;
    }
}

/** Force-scroll chat to the very bottom (ignoring nearBottom guard). Used after loading history. */
function scrollChatToBottom() {
    const { messages: container } = getChatEl();
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    _chatUserScrolledUp = false;
    _chatUnreadCount = 0;
    _hideChatNewMessagesIndicator();
}

function _showChatNewMessagesIndicator() {
    const { messages: container } = getChatEl();
    if (!container) return;
    const parent = container.parentElement;
    if (!parent) return;
    let indicator = parent.querySelector('.chat-new-msgs-indicator');
    if (!indicator) {
        indicator = document.createElement('button');
        indicator.className = 'chat-new-msgs-indicator';
        indicator.onclick = () => scrollChatToBottom();
        // Insert directly above the chat-input-area so it doesn't overlap the input
        const inputArea = parent.querySelector('.chat-input-area');
        if (inputArea) {
            parent.insertBefore(indicator, inputArea);
        } else {
            parent.appendChild(indicator);
        }
    }
    indicator.innerHTML = `<i class="fa-solid fa-arrow-down"></i> ${_chatUnreadCount} new message${_chatUnreadCount !== 1 ? 's' : ''}`;
    indicator.style.display = 'flex';
}

function _hideChatNewMessagesIndicator() {
    const { messages: container } = getChatEl();
    if (!container) return;
    const indicator = container.parentElement?.querySelector('.chat-new-msgs-indicator');
    if (indicator) indicator.style.display = 'none';
}

function _onNewChatMessageWhileScrolledUp() {
    _chatUnreadCount++;
    _showChatNewMessagesIndicator();
}

/* ═══════════════════════════════════════════════════════════════
   Cross-Feed: Secondary Global WS (show global/all-stream msgs in stream chat)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Sync the global feed WS connection based on current chat settings.
 * Opens a secondary WS to global chat when the user is in a stream chat
 * and has enabled showGlobalInStream or showAllStreamsInStream.
 */
function _syncGlobalFeed() {
    const wantFeed = chatStreamId && (chatSettings.showGlobalInStream || chatSettings.showAllStreamsInStream);
    if (wantFeed && !_globalFeedWs) {
        _openGlobalFeed();
    } else if (!wantFeed && _globalFeedWs) {
        _closeGlobalFeed();
    }
}

function _openGlobalFeed() {
    _closeGlobalFeed();
    const host = window.location.hostname;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const token = localStorage.getItem('token');

    const params = new URLSearchParams();
    if (token) params.set('token', token);
    // No stream param = global chat
    const wsUrl = `${protocol}://${host}:${port}/ws/chat?${params.toString()}`;
    const ws = new WebSocket(wsUrl);
    _globalFeedWs = ws;
    _globalFeedReconnectDelay = 3000;

    ws.onopen = () => {
        if (_globalFeedWs !== ws) return;
        ws.send(JSON.stringify({ type: 'join', token: token || undefined }));
        console.log('[CrossFeed] Global feed connected');
    };

    ws.onmessage = (e) => {
        if (_globalFeedWs !== ws) return;
        try {
            const msg = JSON.parse(e.data);
            _handleGlobalFeedMessage(msg);
        } catch { /* ignore */ }
    };

    ws.onclose = () => {
        if (_globalFeedWs !== ws) return;
        _globalFeedWs = null;
        // Auto-reconnect if still desired
        const wantFeed = chatStreamId && (chatSettings.showGlobalInStream || chatSettings.showAllStreamsInStream);
        if (wantFeed) {
            _globalFeedReconnectTimer = setTimeout(() => {
                _globalFeedReconnectTimer = null;
                if (chatStreamId && (chatSettings.showGlobalInStream || chatSettings.showAllStreamsInStream)) {
                    _openGlobalFeed();
                }
            }, _globalFeedReconnectDelay);
            _globalFeedReconnectDelay = Math.min(_globalFeedReconnectDelay * 1.5, _GLOBAL_FEED_RECONNECT_MAX);
        }
    };

    ws.onerror = () => {
        if (_globalFeedWs !== ws) return;
        console.warn('[CrossFeed] Global feed WS error');
    };
}

function _closeGlobalFeed() {
    if (_globalFeedReconnectTimer) {
        clearTimeout(_globalFeedReconnectTimer);
        _globalFeedReconnectTimer = null;
    }
    if (_globalFeedWs) {
        const ws = _globalFeedWs;
        _globalFeedWs = null;
        try { ws.close(); } catch {}
    }
}

function _handleGlobalFeedMessage(msg) {
    // Only process chat messages — ignore system, auth, user-count, etc.
    if (msg.type !== 'chat') return;

    const hasStreamChannel = !!msg.stream_channel;

    // Filter based on settings:
    // - showAllStreamsInStream: show everything (global + all streams)
    // - showGlobalInStream only: show global messages (those WITHOUT stream_channel)
    if (!chatSettings.showAllStreamsInStream && hasStreamChannel) {
        return; // only global messages when showAllStreams is off
    }

    // Don't duplicate messages from our own stream
    // stream_channel matches a username; we need to skip if it's our current stream
    // The msg.stream_channel is set by the server for messages originating from streams
    // Our own stream's messages are already in the stream chat — skip them
    if (hasStreamChannel && chatStreamId) {
        // Try to detect if this is from our own stream (avoid duplicating)
        // tag messages with cross-feed source so they're visually distinct
    }

    // Render into the stream chat container with a source badge
    const container = document.getElementById('chat-messages')
                   || document.getElementById('bc-chat-messages');
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-crossfeed';

    // Source badge
    let sourceBadge = '';
    if (hasStreamChannel) {
        sourceBadge = `<span class="chat-crossfeed-badge chat-crossfeed-stream" title="From ${esc(msg.stream_channel)}'s stream"><i class="fa-solid fa-tower-broadcast"></i> ${esc(msg.stream_channel)}</span> `;
    } else {
        sourceBadge = `<span class="chat-crossfeed-badge chat-crossfeed-global" title="Global chat"><i class="fa-solid fa-globe"></i> Global</span> `;
    }

    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    let nameColor = msg.color || msg.profile_color || getRoleColor(msg.role);
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);

    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    const rawText = msg.message || msg.text || '';
    const text = (typeof parseEmotes === 'function') ? parseEmotes(rawText) : esc(rawText);

    // Timestamp
    let tsHtml = '';
    if (chatSettings.showTimestamps) {
        const tsSource = msg.timestamp ? new Date(msg.timestamp) : new Date();
        const tsOpts = chatSettings.timestampFormat === '24h'
            ? { hour: '2-digit', minute: '2-digit', hour12: false }
            : { hour: '2-digit', minute: '2-digit' };
        tsHtml = `<span class="chat-time-inline">${tsSource.toLocaleTimeString([], tsOpts)}</span> `;
    }

    el.innerHTML = `${tsHtml}${sourceBadge}${badge}<span class="chat-name" style="color:${nameColor}" data-username="${displayName}">${displayName}</span>: <span class="chat-text">${text}</span>`;

    // Auto-scroll management
    if (!_chatUserScrolledUp) {
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
    } else {
        container.appendChild(el);
        _onNewChatMessageWhileScrolledUp();
    }
    // Trim old messages
    while (container.children.length > 500) container.removeChild(container.firstChild);
}

/**
 * Freeze a GIF emote by drawing its first frame onto a canvas and replacing the src.
 */
function freezeGifEmote(img) {
    if (img._frozen) return;
    img._frozen = true;
    img._origSrc = img.src;
    const freeze = () => {
        try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth || 28;
            c.height = img.naturalHeight || 28;
            c.getContext('2d').drawImage(img, 0, 0);
            img.src = c.toDataURL('image/png');
        } catch { /* CORS — leave as-is, CSS will hide animation */ }
    };
    if (img.complete) freeze();
    else img.addEventListener('load', freeze, { once: true });
}

function updateViewerCount(count) {
    const el = document.getElementById('vc-viewers');
    // Include cached external viewer count (Kick/Twitch/RS) if available
    const external = (typeof _cachedExternalViewerCount === 'number') ? _cachedExternalViewerCount : 0;
    if (el) el.textContent = count + external;
}

/**
 * Update the viewer count badge in the live stream tab for a given stream.
 */
function updateTabViewerCount(streamId, count) {
    if (!streamId) return;
    const tab = document.querySelector(`.live-tab[data-stream-id="${streamId}"]`);
    if (!tab) return;
    const badge = tab.querySelector('.live-tab-viewers');
    if (badge) {
        // Update just the number, keep the icon
        badge.innerHTML = `<i class="fa-solid fa-eye"></i> ${count}`;
    }
}

function viewProfile(username) {
    if (username.startsWith('anon')) return;
    navigate(`/${username}`);
}

function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}

function timeAgoShort(dateStr) {
    const d = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z');
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
    if (diff < 31536000) return Math.floor(diff / 2592000) + 'mo ago';
    return Math.floor(diff / 31536000) + 'y ago';
}

/* ── TTS ──────────────────────────────────────────────────────── */

/** Browser-side TTS using SpeechSynthesis API (Self TTS / legacy fallback) */
function speakTTS(text, voiceFX, username) {
    if (!('speechSynthesis' in window)) return;
    // Replace URLs with TTS-friendly descriptions
    let cleanText = text.replace(/(?:https?:\/\/)?(?:www\.)?([a-z0-9][-a-z0-9]*(?:\.[a-z]{2,})+)(?:[^\s]*)/gi, (m, domain) => {
        const parts = domain.split('.');
        const site = parts.length > 2 ? parts[parts.length - 2] : parts[0];
        return username ? `(${username} sent a link to ${site})` : `(link to ${site})`;
    });
    const utter = new SpeechSynthesisUtterance(cleanText);
    utter.rate = voiceFX?.rate || 1;
    utter.pitch = voiceFX?.pitch || 1;
    utter.volume = (chatSettings.ttsVolume || 80) / 100;
    speechSynthesis.speak(utter);
}

/** Server-synthesized TTS audio playback queue */
let _ttsAudioQueue = [];
let _ttsAudioPlaying = false;

function playTTSAudio(msg) {
    if (!msg.audio || !msg.mimeType) return;
    _ttsAudioQueue.push(msg);
    _processTTSAudioQueue();
}

function _processTTSAudioQueue() {
    if (_ttsAudioPlaying || _ttsAudioQueue.length === 0) return;
    _ttsAudioPlaying = true;
    const msg = _ttsAudioQueue.shift();
    try {
        const binaryStr = atob(msg.audio);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: msg.mimeType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const volume = (chatSettings.ttsVolume || 80) / 100;
        console.log('[TTS] Chat audio volume:', volume, '(raw setting:', chatSettings.ttsVolume, ')');
        // Use Web Audio API GainNode for volume — Audio.volume is unreliable on PipeWire/Steam Deck
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const source = ctx.createMediaElementSource(audio);
            const gain = ctx.createGain();
            gain.gain.value = volume;
            source.connect(gain).connect(ctx.destination);
            const cleanup = () => { URL.revokeObjectURL(url); try { ctx.close(); } catch {} _ttsAudioPlaying = false; _processTTSAudioQueue(); };
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.play().catch(cleanup);
        } catch {
            // Fallback to Audio.volume if Web Audio API unavailable
            audio.volume = volume;
            audio.onended = () => { URL.revokeObjectURL(url); _ttsAudioPlaying = false; _processTTSAudioQueue(); };
            audio.onerror = () => { URL.revokeObjectURL(url); _ttsAudioPlaying = false; _processTTSAudioQueue(); };
            audio.play().catch(() => { URL.revokeObjectURL(url); _ttsAudioPlaying = false; _processTTSAudioQueue(); });
        }
    } catch {
        _ttsAudioPlaying = false;
        _processTTSAudioQueue();
    }
}

/** Cancel all TTS (both browser and server audio) */
function cancelAllTTS() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    _ttsAudioQueue = [];
    _ttsAudioPlaying = false;
}

/** Toggle TTS on/off from the chat input button */
function toggleChatTTS(btn) {
    const key = getChatTTSSettingKey({ button: btn });
    chatSettings[key] = !chatSettings[key];
    saveChatSettings();
    if (btn) {
        const enabled = !!chatSettings[key];
        btn.classList.toggle('tts-active', enabled);
        btn.title = enabled ? 'TTS On (click to mute)' : 'TTS Off (click to enable)';
    }
    if (!chatSettings[key]) cancelAllTTS();
}

/** Update TTS toggle button state (called after settings load) */
function syncTTSToggleButtons() {
    document.querySelectorAll('.chat-tts-toggle').forEach(btn => {
        const enabled = isChatTTSEnabled({ button: btn });
        btn.classList.toggle('tts-active', enabled);
        btn.title = enabled ? 'TTS On (click to mute)' : 'TTS Off (click to enable)';
    });
}

/* ── Chat settings panel ──────────────────────────────────────── */
function toggleChatSettings(btn) {
    // Find the closest chat container (sidebar, global, offline, broadcast)
    const container = btn ? btn.closest('.chat-sidebar, .offline-global-chat, .global-chat-main') : null;
    if (!container) return;
    let panel = container.querySelector('.chat-settings-panel');
    if (panel) {
        panel.remove();
        chatSettingsPanelOpen = false;
        return;
    }
    chatSettingsPanelOpen = true;
    panel = document.createElement('div');
    panel.className = 'chat-settings-panel';
    panel.innerHTML = buildSettingsPanelHTML();
    // Insert after chat-header
    const header = container.querySelector('.chat-header, .global-chat-header');
    if (header) {
        header.after(panel);
    } else {
        container.prepend(panel);
    }
    syncSettingsPanelUI();
    // Close when clicking outside
    setTimeout(() => {
        const closer = (e) => {
            if (!panel.contains(e.target) && !e.target.closest('.chat-settings-btn')) {
                panel.remove();
                chatSettingsPanelOpen = false;
                document.removeEventListener('click', closer);
            }
        };
        document.addEventListener('click', closer);
    }, 0);
}

function deleteMyChatMessagesNow() {
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
        toast('Chat must be connected before deleting your history', 'error');
        return;
    }
    if (!canUseViewerDeleteAllHere()) {
        toast('This streamer has disabled viewer self-delete for this chat', 'error');
        return;
    }

    const scopeLabel = chatStreamId
        ? 'from this stream chat'
        : 'from your HoboStreamer chat history';
    if (!confirm(`Delete all of your messages ${scopeLabel}? This cannot be undone.`)) return;

    chatWs.send(JSON.stringify({
        type: 'self-delete-history',
        streamId: chatStreamId || null,
    }));
}

function buildSettingsPanelHTML() {
    return `
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-paintbrush"></i> Appearance</div>
            <label class="csp-row">
                <span>Show Timestamps</span>
                <input type="checkbox" data-setting="showTimestamps" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Time Format</span>
                <select data-setting="timestampFormat" onchange="onChatSettingChange(this)">
                    <option value="12h">12 hour</option>
                    <option value="24h">24 hour</option>
                </select>
            </label>
            <label class="csp-row">
                <span>Font Size</span>
                <select data-setting="fontSize" onchange="onChatSettingChange(this)">
                    <option value="small">Small</option>
                    <option value="default">Default</option>
                    <option value="large">Large</option>
                </select>
            </label>
            <label class="csp-row">
                <span>Show Avatars</span>
                <input type="checkbox" data-setting="showAvatars" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Show Badges</span>
                <input type="checkbox" data-setting="showBadges" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Readable Colors</span>
                <input type="checkbox" data-setting="readableColors" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Alternating Backgrounds</span>
                <input type="checkbox" data-setting="alternateBackground" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-face-grin-squint-tears"></i> Emotes</div>
            <label class="csp-row">
                <span>Animated Emotes</span>
                <input type="checkbox" data-setting="animatedEmotes" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Emote Size</span>
                <select data-setting="emoteScale" onchange="onChatSettingChange(this)">
                    <option value="small">Small</option>
                    <option value="default">Default</option>
                    <option value="large">Large</option>
                </select>
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-sliders"></i> Behavior</div>
            <label class="csp-row">
                <span>Show Deleted Messages</span>
                <input type="checkbox" data-setting="showDeletedMessages" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Show System Messages</span>
                <input type="checkbox" data-setting="showSystemMessages" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Highlight @Mentions</span>
                <input type="checkbox" data-setting="mentionHighlight" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Auto-Scroll</span>
                <input type="checkbox" data-setting="autoScroll" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-user-shield"></i> Privacy</div>
            <p class="csp-hint csp-self-delete-hint">Control how long your own messages stay in chat history.</p>
            <label class="csp-row">
                <span>Auto-Delete My Messages</span>
                <select data-setting="autoDeleteMinutes" onchange="onChatSettingChange(this)">
                    <option value="0">Off</option>
                    <option value="3">3 minutes</option>
                    <option value="5">5 minutes</option>
                    <option value="10">10 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                    <option value="360">6 hours</option>
                    <option value="1440">24 hours</option>
                </select>
            </label>
            <div style="margin-top:10px">
                <button class="btn btn-small btn-danger csp-delete-own-btn" onclick="deleteMyChatMessagesNow()">
                    <i class="fa-solid fa-trash-can"></i> Delete All My Messages
                </button>
            </div>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-bell"></i> Notifications</div>
            <label class="csp-row">
                <span>Flash Tab on @Mention</span>
                <input type="checkbox" data-setting="flashOnMention" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Sound on @Mention</span>
                <input type="checkbox" data-setting="soundOnMention" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-window-restore"></i> Widget</div>
            <label class="csp-row">
                <span>Floating Chat Button</span>
                <input type="checkbox" data-setting="showFloatingChat" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Fullscreen Overlay Chat</span>
                <input type="checkbox" data-setting="fullscreenOverlayChat" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-tower-broadcast"></i> Cross-Feed</div>
            <p class="csp-hint">Show messages from other sources while watching a stream.</p>
            <label class="csp-row">
                <span>Show Global Chat</span>
                <input type="checkbox" data-setting="showGlobalInStream" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Show All Streams</span>
                <input type="checkbox" data-setting="showAllStreamsInStream" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-section">
            <div class="csp-title"><i class="fa-solid fa-volume-high"></i> Text-to-Speech</div>
            <label class="csp-row">
                <span>Enable TTS</span>
                <input type="checkbox" data-setting="ttsEnabled" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Enable TTS While Streaming</span>
                <input type="checkbox" data-setting="streamingTtsEnabled" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>TTS Volume</span>
                <input type="range" min="0" max="100" step="5" data-setting="ttsVolume" onchange="onChatSettingChange(this)" oninput="onChatSettingChange(this)">
            </label>
            <div class="csp-sub-title" style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">TTS Sources</div>
            <label class="csp-row">
                <span>Native chat</span>
                <input type="checkbox" data-setting="ttsSrcNative" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>RobotStreamer relay</span>
                <input type="checkbox" data-setting="ttsSrcRS" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Kick relay</span>
                <input type="checkbox" data-setting="ttsSrcKick" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>YouTube relay</span>
                <input type="checkbox" data-setting="ttsSrcYoutube" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>Twitch relay</span>
                <input type="checkbox" data-setting="ttsSrcTwitch" onchange="onChatSettingChange(this)">
            </label>
        </div>
        <div class="csp-footer">
            <button class="btn btn-small" onclick="resetChatSettings()">Reset to Defaults</button>
        </div>
    `;
}

function onChatSettingChange(el) {
    const key = el.dataset.setting;
    if (!key) return;
    if (key === 'autoDeleteMinutes') {
        chatSettings[key] = normalizeChatAutoDeleteMinutes(el.value);
        el.value = String(chatSettings[key]);
    } else if (el.type === 'checkbox') chatSettings[key] = el.checked;
    else if (el.type === 'range') chatSettings[key] = parseInt(el.value, 10);
    else chatSettings[key] = el.value;
    saveChatSettings();
    if (key === 'ttsEnabled' || key === 'streamingTtsEnabled') syncTTSToggleButtons();
    if (key === 'showFloatingChat') _fcwUpdateVisibility();
    if (key === 'showGlobalInStream' || key === 'showAllStreamsInStream') _syncGlobalFeed();
}

function resetChatSettings() {
    chatSettings = { ...CHAT_SETTINGS_DEFAULTS };
    saveChatSettings();
    _syncGlobalFeed();
    syncSettingsPanelUI();
    toast('Chat settings reset to defaults', 'info');
}

/* ── Helpers for mention features ─────────────────────────────── */
function getCurrentUsername() {
    try {
        const token = localStorage.getItem('token');
        if (!token) return null;
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.username || payload.name || null;
    } catch { return null; }
}

let _tabFlashInterval = null;
let _originalTitle = document.title;
function flashTabTitle(fromUser) {
    if (document.hasFocus()) return;
    if (_tabFlashInterval) return; // already flashing
    let flash = true;
    _tabFlashInterval = setInterval(() => {
        document.title = flash ? `💬 ${fromUser} mentioned you!` : _originalTitle;
        flash = !flash;
    }, 1000);
    const stopFlash = () => {
        clearInterval(_tabFlashInterval);
        _tabFlashInterval = null;
        document.title = _originalTitle;
        window.removeEventListener('focus', stopFlash);
    };
    window.addEventListener('focus', stopFlash);
}

function playMentionSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        gain.gain.value = 0.15;
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.stop(ctx.currentTime + 0.3);
    } catch {}
}

function ensureReadableColor(hex) {
    // Ensure minimum luminance for dark backgrounds (target: 0.4 relative luminance)
    try {
        let r, g, b;
        if (hex.startsWith('#')) {
            const c = hex.slice(1);
            r = parseInt(c.substring(0, 2), 16);
            g = parseInt(c.substring(2, 4), 16);
            b = parseInt(c.substring(4, 6), 16);
        } else {
            return hex;
        }
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        if (lum < 0.4) {
            // Brighten the color while keeping the hue
            const boost = 0.4 / Math.max(lum, 0.01);
            r = Math.min(255, Math.round(r * boost));
            g = Math.min(255, Math.round(g * boost));
            b = Math.min(255, Math.round(b * boost));
            return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        }
        return hex;
    } catch { return hex; }
}

/* ── Close context menu on Escape ─────────────────────────────── */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismissContextMenu();
});

/* ── Apply settings on initial page load ──────────────────────── */
applyChatSettings();
setupFullscreenChatOverlay();

/* ═══════════════════════════════════════════════════════════════
   MOBILE CHAT — Bottom Sheet Toggle
   ═══════════════════════════════════════════════════════════════ */
let _mobileChatOpen = false;
let _mobileChatUnread = 0;

function isMobileChatLayout() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function toggleMobileChat() {
    const sidebar = document.getElementById('chat-sidebar');
    const fab = document.getElementById('mobile-chat-toggle');
    if (!sidebar) return;

    _mobileChatOpen = !_mobileChatOpen;
    sidebar.classList.toggle('mobile-chat-open', _mobileChatOpen);
    document.body.classList.toggle('mobile-chat-visible', _mobileChatOpen);

    if (fab) {
        const icon = fab.querySelector('i');
        if (icon) icon.className = _mobileChatOpen ? 'fa-solid fa-xmark' : 'fa-solid fa-comment';
    }

    if (_mobileChatOpen) {
        _mobileChatUnread = 0;
        const badge = document.getElementById('mobile-chat-badge');
        if (badge) { badge.style.display = 'none'; badge.textContent = '0'; }
        scrollChat();
    }
}

function incrementMobileChatUnread() {
    if (!isMobileChatLayout() || _mobileChatOpen) return;
    _mobileChatUnread++;
    const badge = document.getElementById('mobile-chat-badge');
    if (badge) {
        badge.textContent = _mobileChatUnread > 99 ? '99+' : _mobileChatUnread;
        badge.style.display = '';
    }
}

// Hook into addChatMessage to count unread on mobile
const _origAddChatMessage = typeof addChatMessage === 'function' ? addChatMessage : null;
// We can't easily wrap addChatMessage since it's already defined, so we use MutationObserver
(function() {
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.addedNodes.length > 0) {
                incrementMobileChatUnread();
            }
        }
    });
    // Start observing when chat panel exists
    function _tryObserve() {
        const container = document.getElementById('chat-messages');
        if (container) {
            observer.observe(container, { childList: true });
        } else {
            setTimeout(_tryObserve, 1000);
        }
    }
    _tryObserve();

    // Close mobile chat on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _mobileChatOpen) toggleMobileChat();
    });

    // Close mobile chat when navigating away from channel page
    window.addEventListener('popstate', () => {
        if (_mobileChatOpen) toggleMobileChat();
    });

    // Close mobile chat when tapping the backdrop scrim
    document.addEventListener('click', (e) => {
        if (!_mobileChatOpen || !isMobileChatLayout()) return;
        // Check if click is on the scrim (the ::after pseudo-element area above chat)
        const sidebar = document.getElementById('chat-sidebar');
        const fab = document.getElementById('mobile-chat-toggle');
        if (sidebar && !sidebar.contains(e.target) && fab && !fab.contains(e.target)) {
            toggleMobileChat();
        }
    });

    // Reset state on resize crossing the breakpoint
    let _wasMobile = isMobileChatLayout();
    window.addEventListener('resize', () => {
        const nowMobile = isMobileChatLayout();
        if (_wasMobile && !nowMobile && _mobileChatOpen) {
            // Went from mobile → desktop while chat was open: reset
            _mobileChatOpen = false;
            const sidebar = document.getElementById('chat-sidebar');
            if (sidebar) sidebar.classList.remove('mobile-chat-open');
            document.body.classList.remove('mobile-chat-visible');
            const fab = document.getElementById('mobile-chat-toggle');
            if (fab) {
                const icon = fab.querySelector('i');
                if (icon) icon.className = 'fa-solid fa-comment';
            }
        }
        _wasMobile = nowMobile;
    });

    // Touch swipe-down on chat header to close bottom sheet
    let _touchStartY = 0;
    document.addEventListener('touchstart', (e) => {
        if (!_mobileChatOpen) return;
        const header = e.target.closest('.chat-header');
        if (header) _touchStartY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
        if (!_mobileChatOpen || !_touchStartY) return;
        const dy = e.changedTouches[0].clientY - _touchStartY;
        _touchStartY = 0;
        if (dy > 60) toggleMobileChat(); // swipe down > 60px = close
    }, { passive: true });
})();

/* ═══════════════════════════════════════════════════════════════
   CHAT MODE (Global / Voice Call)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Called when the chat mode dropdown changes.
 * 'global' — show all messages (default)
 * 'voice'  — show only messages tagged with the user's current voice channel
 */
function onChatModeChange(mode) {
    if (!['global', 'voice'].includes(mode)) return;
    chatMode = mode;
    const titleEl = document.getElementById('chat-mode-title');
    const subtitleEl = document.getElementById('chat-mode-subtitle');
    if (mode === 'voice') {
        if (titleEl) titleEl.textContent = 'Voice Call Chat';
        if (subtitleEl) subtitleEl.textContent = 'Messages only shared with your voice channel';
    } else {
        if (titleEl) titleEl.textContent = 'Global Chat';
        if (subtitleEl) subtitleEl.textContent = 'Live messages from all streams and the lobby';
    }
}

/**
 * Enable/disable the Voice Call option in the dropdown based on VC connection state.
 * Called from voice-channels.js when joining/leaving.
 */
function updateChatModeVoiceOption(enabled) {
    const opt = document.getElementById('chat-mode-voice-opt');
    if (opt) opt.disabled = !enabled;
    // Auto-switch back to global if voice channel disconnected
    if (!enabled && chatMode === 'voice') {
        chatMode = 'global';
        const sel = document.getElementById('chat-mode-select');
        if (sel) sel.value = 'global';
        onChatModeChange('global');
    }
}

/* ═══════════════════════════════════════════════════════════════
   FLOATING CHAT WIDGET
   ═══════════════════════════════════════════════════════════════ */

/** Show/hide the floating chat FAB on non-chat pages */
function _fcwUpdateVisibility() {
    const fab = document.getElementById('floating-chat-fab');
    const widget = document.getElementById('floating-chat-widget');
    const disabled = chatSettings && chatSettings.showFloatingChat === false;

    // Hide on the global chat page (already has full chat)
    const chatPage = document.getElementById('page-chat');
    const isOnChatPage = chatPage && chatPage.classList.contains('active');

    // Hide on live stream / channel pages (already have chat sidebar)
    const streamPage = document.getElementById('page-stream');
    const channelPage = document.getElementById('page-channel');
    const isOnStreamPage = (streamPage && streamPage.classList.contains('active'))
        || (channelPage && channelPage.classList.contains('active'));

    // Hide on broadcast page (has its own chat panel)
    const broadcastPage = document.getElementById('page-broadcast');
    const isOnBroadcastPage = broadcastPage && broadcastPage.classList.contains('active');

    if (isOnChatPage || isOnStreamPage || isOnBroadcastPage || disabled) {
        if (fab) fab.style.display = 'none';
        if (widget) widget.style.display = 'none';
        _fcwOpen = false;
    } else {
        // Not on chat/stream page — show FAB
        if (fab) fab.style.display = '';
        if (!_fcwOpen && widget) widget.style.display = 'none';
    }
}

function fcwToggle() {
    _fcwOpen = !_fcwOpen;
    const widget = document.getElementById('floating-chat-widget');
    if (widget) widget.style.display = _fcwOpen ? '' : 'none';

    if (_fcwOpen) {
        // Clear unread
        _fcwUnread = 0;
        const badge = document.getElementById('fcw-unread-badge');
        if (badge) badge.style.display = 'none';

        // Ensure chat is connected (global)
        if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
            initChat(null);
        }

        // Scroll to bottom
        const msgs = document.getElementById('fcw-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
}

function fcwMinimize() {
    _fcwOpen = false;
    const widget = document.getElementById('floating-chat-widget');
    if (widget) widget.style.display = 'none';
}

function fcwClose() {
    fcwMinimize();
}

function fcwSendChat() {
    const input = document.getElementById('fcw-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;

    // Save to shared message history
    if (_chatMsgHistory[0] !== text) {
        _chatMsgHistory.unshift(text);
        if (_chatMsgHistory.length > CHAT_HISTORY_MAX) _chatMsgHistory.pop();
    }
    _chatHistoryIndex = -1;
    _chatHistoryDraft = '';

    chatWs.send(JSON.stringify({ type: 'chat', message: text, streamId: null }));
    input.value = '';
    _autoResizeTextarea(input);
    input.focus();
}

/** Scroll the floating chat widget to bottom */
function _fcwScrollToBottom() {
    const container = document.getElementById('fcw-messages');
    if (container) container.scrollTop = container.scrollHeight;
}

/** Mirror a chat message to the floating widget */
function _fcwAddMessage(msg) {
    const container = document.getElementById('fcw-messages');
    if (!container) return;

    const username = msg.username || msg.displayName || 'anon';
    const text = msg.message || msg.text || '';
    const color = msg.color || msg.profile_color || '#999';

    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<span class="chat-user" style="color:${esc(color)}">${esc(username)}</span>: ${(typeof parseEmotes === 'function') ? parseEmotes(text) : esc(text)}`;
    container.appendChild(el);

    // Trim old messages
    while (container.children.length > 200) container.removeChild(container.firstChild);

    // Auto-scroll: force during history load, otherwise only when near bottom
    if (_loadingHistory) {
        container.scrollTop = container.scrollHeight;
    } else {
        const isScrolledDown = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        if (isScrolledDown) container.scrollTop = container.scrollHeight;
    }

    // Increment unread if widget is closed and not on chat page
    if (!_fcwOpen) {
        const chatPage = document.getElementById('page-chat');
        const isOnChatPage = chatPage && chatPage.classList.contains('active');
        if (!isOnChatPage) {
            _fcwUnread++;
            const badge = document.getElementById('fcw-unread-badge');
            if (badge) {
                badge.textContent = _fcwUnread > 99 ? '99+' : String(_fcwUnread);
                badge.style.display = '';
            }
        }
    }
}

/** Dragging support for the floating widget header */
function fcwStartDrag(e) {
    if (e.button !== 0) return;
    _fcwDragging = true;
    const widget = document.getElementById('floating-chat-widget');
    if (!widget) return;
    const rect = widget.getBoundingClientRect();
    _fcwDragOffset.x = e.clientX - rect.left;
    _fcwDragOffset.y = e.clientY - rect.top;
    document.addEventListener('mousemove', _fcwDrag);
    document.addEventListener('mouseup', _fcwStopDrag);
    e.preventDefault();
}

function _fcwDrag(e) {
    if (!_fcwDragging) return;
    const widget = document.getElementById('floating-chat-widget');
    if (!widget) return;
    const x = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - _fcwDragOffset.x));
    const y = Math.max(0, Math.min(window.innerHeight - 80, e.clientY - _fcwDragOffset.y));
    widget.style.left = x + 'px';
    widget.style.top = y + 'px';
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';
}

function _fcwStopDrag() {
    _fcwDragging = false;
    document.removeEventListener('mousemove', _fcwDrag);
    document.removeEventListener('mouseup', _fcwStopDrag);
}

/** Resize support for the floating widget */
let _fcwResizing = false;
let _fcwResizeStart = { x: 0, y: 0, w: 0, h: 0 };

function fcwStartResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    _fcwResizing = true;
    const widget = document.getElementById('floating-chat-widget');
    if (!widget) return;
    const rect = widget.getBoundingClientRect();
    _fcwResizeStart = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    document.addEventListener('mousemove', _fcwResize);
    document.addEventListener('mouseup', _fcwStopResize);
}

function _fcwResize(e) {
    if (!_fcwResizing) return;
    const widget = document.getElementById('floating-chat-widget');
    if (!widget) return;
    const dw = e.clientX - _fcwResizeStart.x;
    const dh = e.clientY - _fcwResizeStart.y;
    const newW = Math.max(260, Math.min(window.innerWidth - 40, _fcwResizeStart.w + dw));
    const newH = Math.max(200, Math.min(window.innerHeight - 40, _fcwResizeStart.h + dh));
    widget.style.width = newW + 'px';
    widget.style.height = newH + 'px';
}

function _fcwStopResize() {
    _fcwResizing = false;
    document.removeEventListener('mousemove', _fcwResize);
    document.removeEventListener('mouseup', _fcwStopResize);
}

// Hook into page navigation to show/hide FAB
document.addEventListener('DOMContentLoaded', () => {
    // Watch all page sections for class changes
    document.querySelectorAll('.page').forEach(page => {
        const obs = new MutationObserver(_fcwUpdateVisibility);
        obs.observe(page, { attributes: true, attributeFilter: ['class'] });
    });
    // Initial check
    setTimeout(_fcwUpdateVisibility, 100);

    // Deep-link support from notifications: /?vcInvite=<channelId>
    try {
        const inviteChannel = new URLSearchParams(window.location.search).get('vcInvite');
        if (inviteChannel) {
            setTimeout(() => {
                acceptVcInvite(inviteChannel, 'Voice Channel');
            }, 450);
        }
        if (window._pendingVcInvite?.channelId && typeof vcFetchChannels === 'function' && typeof vcJoinChannel === 'function') {
            const pending = window._pendingVcInvite;
            window._pendingVcInvite = null;
            setTimeout(() => {
                acceptVcInvite(pending.channelId, pending.channelName || 'Voice Channel');
            }, 450);
        }
    } catch {}
});

// ── Re-authenticate chat WebSocket on login/logout ───────────
// When the user logs in or registers, the navbar updates but the existing
// WebSocket still carries the old anonymous identity. Re-send a `join`
// message with the new token so the server upgrades the connection.
// On logout, reconnect so the server assigns a fresh anon identity.
window.addEventListener('hobo-auth-changed', (e) => {
    const token = e.detail?.token;
    const wasAuthed = chatWs?._hoboAuthed;

    if (token && chatWs && chatWs.readyState === WebSocket.OPEN) {
        // Logged in — re-authenticate the existing connection
        chatWs.send(JSON.stringify({
            type: 'join',
            streamId: chatStreamId,
            token,
        }));
        chatWs._hoboAuthed = true;
    } else if (!token && wasAuthed) {
        // Logged out — reconnect to get a fresh anon identity
        chatWs._hoboAuthed = false;
        const sid = chatStreamId;
        destroyChat();
        if (sid) initChat(sid); else initChat(null);
    }

    // Also re-auth background broadcast WS if active
    if (token && _bgBroadcastWs && _bgBroadcastWs.readyState === WebSocket.OPEN) {
        _bgBroadcastWs.send(JSON.stringify({
            type: 'join',
            streamId: _bgBroadcastStreamId,
            token,
        }));
    }
});

/* ═══════════════════════════════════════════════════════════════
   POPOUT CHAT WINDOWS
   Open global chat or stream chat in a standalone popup window.
   ═══════════════════════════════════════════════════════════════ */
let _popoutChatWindows = new Map(); // key → Window reference

function popoutChat(mode = 'global', streamId = null) {
    const key = mode === 'stream' ? `stream-${streamId}` : 'global';

    // If already open and alive, focus it
    const existing = _popoutChatWindows.get(key);
    if (existing && !existing.closed) {
        existing.focus();
        return;
    }

    const title = mode === 'stream' ? `Stream Chat — ${streamId}` : 'Global Chat';
    const w = 400, h = 600;
    const left = window.screenX + window.outerWidth - w - 20;
    const top = window.screenY + 80;

    const popup = window.open('', `hobo_chat_${key}`,
        `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=no`);
    if (!popup) {
        toast('Popup blocked — please allow popups for this site', 'error');
        return;
    }

    _popoutChatWindows.set(key, popup);

    // Build the popout HTML
    const doc = popup.document;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-primary, #0d0d1a);
            color: var(--text-primary, #e0e0e0);
            display: flex; flex-direction: column; height: 100vh;
            --bg-primary: #0d0d1a; --bg-secondary: #1a1a2e; --border: #2a2a3e;
            --text-primary: #e0e0e0; --text-muted: #888; --accent: #c0965c;
            --danger: #e74c3c; --success: #2ecc71; --radius-sm: 4px;
        }
        .popout-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 8px 12px; background: var(--bg-secondary); border-bottom: 1px solid var(--border);
            font-size: 0.85rem; font-weight: 600; flex-shrink: 0;
        }
        .popout-header i { margin-right: 6px; }
        .popout-messages {
            flex: 1; overflow-y: auto; padding: 8px;
            font-size: 0.85rem; line-height: 1.4;
        }
        .popout-messages .chat-msg { padding: 2px 0; word-break: break-word; }
        .popout-messages .chat-msg.system { color: var(--text-muted); font-style: italic; font-size: 0.8rem; }
        .popout-messages .chat-user { font-weight: 600; cursor: default; }
        .popout-messages .chat-time-inline { font-size: 0.7rem; color: var(--text-muted); margin-right: 4px; }
        .popout-messages .chat-stream-badge {
            font-size: 0.65rem; background: rgba(192,150,92,0.2); color: var(--accent);
            padding: 1px 5px; border-radius: 3px; margin-right: 4px; cursor: pointer;
        }
        .popout-messages .chat-avatar, .popout-messages .chat-avatar-letter { display: none; }
        .popout-messages .chat-badge { display: none; }
        .popout-input-area {
            display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--border);
            background: var(--bg-secondary); flex-shrink: 0;
        }
        .popout-input-area input {
            flex: 1; background: var(--bg-primary); border: 1px solid var(--border);
            border-radius: var(--radius-sm); color: var(--text-primary);
            padding: 6px 10px; font-size: 0.85rem; outline: none;
        }
        .popout-input-area input:focus { border-color: var(--accent); }
        .popout-input-area button {
            background: var(--accent); color: #fff; border: none;
            border-radius: var(--radius-sm); padding: 6px 12px;
            cursor: pointer; font-size: 0.85rem;
        }
        .popout-input-area button:hover { opacity: 0.85; }
    </style>
</head>
<body>
    <div class="popout-header">
        <span><i class="fa-solid fa-comments"></i> ${title}</span>
    </div>
    <div class="popout-messages" id="popout-msgs"></div>
    <div class="popout-input-area">
        <input type="text" id="popout-input" placeholder="Send a message..." maxlength="500" autocomplete="off">
        <button id="popout-send">Send</button>
    </div>
</body>
</html>`);
    doc.close();

    // Set up the popout's WS connection
    const host = window.location.hostname;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const token = localStorage.getItem('token');
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (mode === 'stream' && streamId) params.set('stream', streamId);
    const wsUrl = `${protocol}://${host}:${port}/ws/chat?${params.toString()}`;

    let popupWs = null;
    let popupReconnectTimer = null;
    let popupReconnectDelay = 2000;

    function esc(s) {
        const d = doc.createElement('div');
        d.textContent = String(s || '');
        return d.innerHTML;
    }

    function appendMsg(html) {
        const container = doc.getElementById('popout-msgs');
        if (!container) return;
        const el = doc.createElement('div');
        el.className = 'chat-msg';
        el.innerHTML = html;
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
        // Trim old messages
        while (container.children.length > 500) container.removeChild(container.firstChild);
    }

    function connectPopout() {
        popupWs = new WebSocket(wsUrl);
        popupWs.onopen = () => {
            popupReconnectDelay = 2000;
            popupWs.send(JSON.stringify({ type: 'join', streamId: mode === 'stream' ? streamId : undefined, token: token || undefined }));
            appendMsg('<div class="chat-msg system">Connected</div>');
        };
        popupWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'chat') {
                    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const nameColor = msg.profile_color || '#999';
                    let badge = '';
                    if (msg.stream_channel) badge = `<span class="chat-stream-badge">${esc(msg.stream_channel)}</span> `;
                    appendMsg(`<span class="chat-time-inline">${ts}</span> ${badge}<span class="chat-user" style="color:${esc(nameColor)}">${esc(msg.username)}</span>: ${(typeof parseEmotes === 'function') ? parseEmotes(msg.message) : esc(msg.message)}`);
                } else if (msg.type === 'system') {
                    appendMsg(`<span class="chat-msg system">${esc(msg.message)}</span>`);
                }
            } catch {}
        };
        popupWs.onclose = () => {
            if (popup.closed) return;
            appendMsg('<span class="chat-msg system">Disconnected — reconnecting...</span>');
            popupReconnectTimer = setTimeout(() => {
                if (!popup.closed) {
                    popupReconnectDelay = Math.min(popupReconnectDelay * 1.5, 30000);
                    connectPopout();
                }
            }, popupReconnectDelay);
        };
        popupWs.onerror = () => {};
    }

    connectPopout();

    // Wire up input
    popup.addEventListener('load', () => {
        const input = doc.getElementById('popout-input');
        const sendBtn = doc.getElementById('popout-send');
        if (input && sendBtn) {
            const doSend = () => {
                const text = input.value.trim();
                if (!text || !popupWs || popupWs.readyState !== WebSocket.OPEN) return;
                popupWs.send(JSON.stringify({ type: 'chat', message: text, streamId: mode === 'stream' ? streamId : undefined }));
                input.value = '';
                input.focus();
            };
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
            sendBtn.addEventListener('click', doSend);
            input.focus();
        }
    });

    // Clean up on popup close
    const checkClosed = setInterval(() => {
        if (popup.closed) {
            clearInterval(checkClosed);
            if (popupReconnectTimer) clearTimeout(popupReconnectTimer);
            if (popupWs) { try { popupWs.close(); } catch {} }
            _popoutChatWindows.delete(key);
        }
    }, 1000);
}

/** Convenience: popout global chat */
function popoutGlobalChat() { popoutChat('global'); }

/** Convenience: popout the current stream's chat */
function popoutStreamChat() {
    if (!chatStreamId) {
        toast('Not in a stream chat', 'error');
        return;
    }
    popoutChat('stream', chatStreamId);
}

/* ── Chat Users List ──────────────────────────────────────────── */

/** Current users data cache */
let _chatUsersData = null;

/**
 * Toggle the chat users panel open/closed.
 * On open, request the users list from the server.
 */
function toggleChatUsers(btn) {
    // Find the nearest chat container and its users panel
    const chatContainer = btn ? btn.closest('.chat-sidebar, .global-chat-container, .offline-global-chat') : null;
    const panels = chatContainer
        ? [chatContainer.querySelector('.chat-users-panel')]
        : document.querySelectorAll('.chat-users-panel');

    for (const panel of panels) {
        if (!panel) continue;
        const isOpen = panel.classList.toggle('open');
        if (isOpen && chatWs && chatWs.readyState === WebSocket.OPEN) {
            chatWs.send(JSON.stringify({ type: 'get-users' }));
        }
    }
}

/**
 * Render the users list into all open panels.
 */
function renderChatUsersList(users) {
    if (!users) return;
    _chatUsersData = users;
    const panels = document.querySelectorAll('.chat-users-panel');
    for (const panel of panels) {
        if (!panel.classList.contains('open')) continue;
        const { logged = [], anonCount = 0 } = users;
        const total = logged.length + anonCount;
        let html = `<div class="chat-users-header"><span>Users — ${total}</span><button class="chat-users-close" onclick="closeChatUsersPanel(this)" title="Close"><i class="fa-solid fa-xmark"></i></button></div>`;
        html += '<div class="chat-users-list">';
        for (const u of logged) {
            const avatar = u.avatar_url
                ? `<img src="${esc(u.avatar_url)}" class="chat-users-avatar" alt="" loading="lazy">`
                : `<div class="chat-users-avatar chat-users-avatar-default"><i class="fa-solid fa-user"></i></div>`;
            const badge = u.role === 'admin' ? '<span class="chat-users-badge admin" title="Admin"><i class="fa-solid fa-shield-halved"></i></span>'
                : u.role === 'global_mod' ? '<span class="chat-users-badge mod" title="Moderator"><i class="fa-solid fa-shield"></i></span>'
                : u.role === 'streamer' ? '<span class="chat-users-badge streamer" title="Streamer"><i class="fa-solid fa-video"></i></span>'
                : '';
            html += `<div class="chat-users-row"><a href="/${esc(u.username)}" class="chat-users-link" onclick="event.preventDefault(); if(typeof showPage==='function') showPage('/${esc(u.username)}')">${avatar}<span class="chat-users-name">${esc(u.display_name)}</span>${badge}</a></div>`;
        }
        if (anonCount > 0) {
            html += `<div class="chat-users-row chat-users-anon"><div class="chat-users-avatar chat-users-avatar-default"><i class="fa-solid fa-user-secret"></i></div><span class="chat-users-name">${anonCount} anonymous viewer${anonCount !== 1 ? 's' : ''}</span></div>`;
        }
        if (total === 0) {
            html += '<div class="chat-users-empty">No one here yet</div>';
        }
        html += '</div>';
        panel.innerHTML = html;
    }
}

function closeChatUsersPanel(btn) {
    const panel = btn?.closest('.chat-users-panel');
    if (panel) panel.classList.remove('open');
}

/* ═══════════════════════════════════════════════════════════════════
   CHAT LINKS — Trust-Domain System, Context Menu & Preview
   ═══════════════════════════════════════════════════════════════════ */

/** Trusted domains stored in localStorage */
const _TRUSTED_DOMAINS_KEY = 'hobo_trusted_domains';
let _trustedDomains = new Set();
let _activeLinkMenu = null;
let _activeLinkDialog = null;

/** Load trusted domains from localStorage on startup */
(function _initTrustedDomains() {
    try {
        const stored = localStorage.getItem(_TRUSTED_DOMAINS_KEY);
        if (stored) {
            const arr = JSON.parse(stored);
            if (Array.isArray(arr)) _trustedDomains = new Set(arr);
        }
    } catch { /* ignore */ }
})();

function _saveTrustedDomains() {
    try {
        localStorage.setItem(_TRUSTED_DOMAINS_KEY, JSON.stringify([..._trustedDomains]));
    } catch { /* ignore */ }
}

function _getDomain(url) {
    try { return new URL(url).hostname.toLowerCase(); }
    catch { return ''; }
}

/** Left-click handler for chat links */
function handleChatLinkClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const a = event.currentTarget || event.target.closest('.chat-link');
    if (!a) return;
    const url = a.dataset.url || a.href;
    if (!url) return;
    const domain = _getDomain(url);

    // Always-trusted domains (own site)
    const alwaysTrusted = ['hobostreamer.com', 'www.hobostreamer.com', location.hostname];
    if (alwaysTrusted.includes(domain) || _trustedDomains.has(domain)) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
    }

    _showTrustDomainDialog(url, domain);
}

/** Show the "Trust This Domain?" dialog */
function _showTrustDomainDialog(url, domain) {
    _dismissLinkDialog();

    const overlay = document.createElement('div');
    overlay.className = 'link-trust-overlay show';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) _dismissLinkDialog(); });

    overlay.innerHTML = `
        <div class="link-trust-dialog">
            <div class="link-trust-header">
                <i class="fa-solid fa-shield-halved"></i>
                <span>Trust This Domain?</span>
            </div>
            <div class="link-trust-body">
                <p class="link-trust-warning">You're about to visit an external link. Make sure you trust this domain before proceeding.</p>
                <div class="link-trust-domain">
                    <i class="fa-solid fa-globe"></i>
                    <span>${esc(domain)}</span>
                </div>
                <div class="link-trust-url-wrap">
                    <code class="link-trust-url">${esc(url)}</code>
                    <button class="link-trust-copy" title="Copy URL" onclick="event.stopPropagation(); _copyLinkUrl(this)">
                        <i class="fa-regular fa-copy"></i>
                    </button>
                </div>
            </div>
            <div class="link-trust-actions">
                <button class="link-trust-btn link-trust-cancel" onclick="_dismissLinkDialog()">Cancel</button>
                <button class="link-trust-btn link-trust-once" onclick="_openLinkOnce('${esc(url)}')">Open Once</button>
                <button class="link-trust-btn link-trust-always" onclick="_trustAndOpen('${esc(url)}', '${esc(domain)}')">
                    <i class="fa-solid fa-check"></i> Always Trust ${esc(domain)}
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    _activeLinkDialog = overlay;

    // ESC to close
    const onKey = (e) => { if (e.key === 'Escape') { _dismissLinkDialog(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
}

function _dismissLinkDialog() {
    if (_activeLinkDialog) {
        _activeLinkDialog.remove();
        _activeLinkDialog = null;
    }
}

function _copyLinkUrl(btn) {
    const code = btn.parentElement.querySelector('.link-trust-url');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => {
        const icon = btn.querySelector('i');
        if (icon) { icon.className = 'fa-solid fa-check'; setTimeout(() => { icon.className = 'fa-regular fa-copy'; }, 1500); }
    }).catch(() => {});
}

function _openLinkOnce(url) {
    _dismissLinkDialog();
    window.open(url, '_blank', 'noopener,noreferrer');
}

function _trustAndOpen(url, domain) {
    _trustedDomains.add(domain);
    _saveTrustedDomains();
    _dismissLinkDialog();
    window.open(url, '_blank', 'noopener,noreferrer');
}

/** Right-click context menu for chat links */
function showLinkContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    _dismissLinkMenu();

    const a = event.currentTarget || event.target.closest('.chat-link');
    if (!a) return;
    const url = a.dataset.url || a.href;
    if (!url) return;

    const menu = document.createElement('div');
    menu.className = 'link-context-menu';
    menu.innerHTML = `
        <button class="link-ctx-btn" onclick="_linkCtxOpenTab('${esc(url)}')">
            <i class="fa-solid fa-arrow-up-right-from-square"></i> Open in New Tab
        </button>
        <button class="link-ctx-btn" onclick="_linkCtxPreview('${esc(url)}')">
            <i class="fa-solid fa-eye"></i> Preview
        </button>
        <div class="link-ctx-divider"></div>
        <button class="link-ctx-btn" onclick="_linkCtxCopy('${esc(url)}', this)">
            <i class="fa-regular fa-copy"></i> Copy URL
        </button>
    `;

    document.body.appendChild(menu);
    _activeLinkMenu = menu;

    // Position near mouse
    _positionLinkMenu(menu, event.clientX, event.clientY);

    // Click outside to dismiss
    setTimeout(() => {
        document.addEventListener('click', _dismissLinkMenu, { once: true });
    }, 10);
}

function _positionLinkMenu(menu, x, y) {
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (x + rect.width > vw - 8) menu.style.left = Math.max(8, x - rect.width) + 'px';
        if (y + rect.height > vh - 8) menu.style.top = Math.max(8, y - rect.height) + 'px';
    });
}

function _dismissLinkMenu() {
    if (_activeLinkMenu) {
        _activeLinkMenu.remove();
        _activeLinkMenu = null;
    }
}

function _linkCtxOpenTab(url) {
    _dismissLinkMenu();
    const domain = _getDomain(url);
    const alwaysTrusted = ['hobostreamer.com', 'www.hobostreamer.com', location.hostname];
    if (alwaysTrusted.includes(domain) || _trustedDomains.has(domain)) {
        window.open(url, '_blank', 'noopener,noreferrer');
    } else {
        _showTrustDomainDialog(url, domain);
    }
}

function _linkCtxCopy(url, btn) {
    _dismissLinkMenu();
    navigator.clipboard.writeText(url).catch(() => {});
}

function _linkCtxPreview(url) {
    _dismissLinkMenu();
    _showLinkPreview(url);
}

/** Link Preview Modal — loads URL in a sandboxed iframe */
function _showLinkPreview(url) {
    _dismissLinkPreview();

    const overlay = document.createElement('div');
    overlay.className = 'link-preview-overlay show';
    overlay.id = 'link-preview-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) _dismissLinkPreview(); });

    overlay.innerHTML = `
        <div class="link-preview-modal">
            <div class="link-preview-header">
                <div class="link-preview-url-bar">
                    <i class="fa-solid fa-globe"></i>
                    <span class="link-preview-url-text" title="${esc(url)}">${esc(url)}</span>
                    <button class="link-preview-copy" title="Copy URL" onclick="event.stopPropagation(); navigator.clipboard.writeText('${esc(url)}')">
                        <i class="fa-regular fa-copy"></i>
                    </button>
                </div>
                <div class="link-preview-toolbar">
                    <button class="link-preview-btn" title="Open in New Tab" onclick="_linkPreviewOpen('${esc(url)}')">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> Open
                    </button>
                    <button class="link-preview-btn link-preview-close" title="Close" onclick="_dismissLinkPreview()">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="link-preview-body">
                <div class="link-preview-loading">
                    <i class="fa-solid fa-spinner fa-spin"></i> Loading preview...
                </div>
                <iframe class="link-preview-frame" sandbox="allow-scripts allow-same-origin allow-forms" src="${esc(url)}" onload="this.previousElementSibling.style.display='none'" onerror="this.previousElementSibling.innerHTML='<i class=\\'fa-solid fa-triangle-exclamation\\'></i> Could not load preview'"></iframe>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // ESC to close
    const onKey = (e) => { if (e.key === 'Escape') { _dismissLinkPreview(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
}

function _dismissLinkPreview() {
    const el = document.getElementById('link-preview-overlay');
    if (el) el.remove();
}

function _linkPreviewOpen(url) {
    const domain = _getDomain(url);
    const alwaysTrusted = ['hobostreamer.com', 'www.hobostreamer.com', location.hostname];
    if (alwaysTrusted.includes(domain) || _trustedDomains.has(domain)) {
        window.open(url, '_blank', 'noopener,noreferrer');
    } else {
        _dismissLinkPreview();
        _showTrustDomainDialog(url, domain);
    }
}
