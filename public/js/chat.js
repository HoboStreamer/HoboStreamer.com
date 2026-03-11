/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Chat Client (WebSocket)
   ═══════════════════════════════════════════════════════════════ */

let chatWs = null;
let chatStreamId = null;
let chatRenderTargetId = null;

// ── Slow mode state ─────────────────────────────────────────
let chatSlowModeSeconds = 0;
let chatSlowModeCooldownTimer = null;
let chatSlowModeCooldownEnd = 0;

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
    // Notifications
    flashOnMention: true,         // Flash browser tab on @mention
    soundOnMention: false,        // Play a sound on @mention
    // TTS
    ttsEnabled: true,             // TTS toggle (on by default)
    ttsVolume: 80,                // TTS volume (0–100)
};
let chatSettings = { ...CHAT_SETTINGS_DEFAULTS };
let chatSettingsPanelOpen = false;

function loadChatSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY));
        if (saved) chatSettings = { ...CHAT_SETTINGS_DEFAULTS, ...saved };
    } catch { /* use defaults */ }
}
function saveChatSettings() {
    try { localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings)); } catch {}
    applyChatSettings();
}
function applyChatSettings() {
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
}
function syncSettingsPanelUI() {
    document.querySelectorAll('.chat-settings-panel').forEach(panel => {
        panel.querySelectorAll('[data-setting]').forEach(el => {
            const key = el.dataset.setting;
            if (el.type === 'checkbox') el.checked = chatSettings[key];
            else if (el.type === 'range') el.value = chatSettings[key];
            else if (el.tagName === 'SELECT') el.value = chatSettings[key];
        });
    });
    syncTTSToggleButtons();
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

async function hydrateActiveChatHistory(streamId, { clear = false } = {}) {
    const { messages } = getChatEl();
    if (!messages) return;
    if (clear) messages.innerHTML = '';

    if (streamId) await loadChatHistory(streamId);
    else await loadGlobalChatHistory();

    applyChatSettings();
}

/**
 * Initialize chat for a stream.
 * Idempotent — if already connected to the same stream, skip reconnection.
 */
function initChat(streamId) {
    const nextTargetId = getChatRenderTargetId();

    // Already connected to this stream — nothing to do
    if (chatWs && chatWs.readyState === WebSocket.OPEN && chatStreamId === streamId) {
        const { messages } = getChatEl();
        const targetChanged = nextTargetId && nextTargetId !== chatRenderTargetId;
        const needsHydrate = !messages || !messages.children.length;
        chatRenderTargetId = nextTargetId;
        if (targetChanged || needsHydrate) {
            hydrateActiveChatHistory(streamId, { clear: true }).catch(() => {});
        }
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

    chatWs = new WebSocket(wsUrl);

    chatWs.onopen = () => {
        // Also send a join message (belt-and-suspenders auth + room join)
        chatWs.send(JSON.stringify({
            type: 'join',
            streamId: streamId,
            token: token || undefined
        }));
        addSystemMessage('Connected to chat');
    };

    // Load emotes for this stream context
    if (typeof loadEmotes === 'function') loadEmotes(streamId);

    chatWs.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            handleChatMessage(msg);
        } catch { /* ignore */ }
    };

    chatWs.onerror = () => {
        addSystemMessage('Chat connection error');
    };

    chatWs.onclose = () => {
        addSystemMessage('Chat disconnected');
    };

    // Load history
    hydrateActiveChatHistory(streamId).catch(() => {});

    // Apply persisted settings to DOM
    applyChatSettings();
}

function destroyChat() {
    if (chatWs) {
        chatWs.close();
        chatWs = null;
    }
    chatStreamId = null;
    chatRenderTargetId = null;
    // Clear all chat containers
    for (const id of ['chat-messages', 'bc-chat-messages', 'global-chat-messages', 'offline-chat-messages']) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    dismissContextMenu();
}

/* ── Message handling ─────────────────────────────────────────── */
function handleChatMessage(msg) {
    switch (msg.type) {
        case 'chat':
            addChatMessage(msg);
            // Self-mode TTS: speak every incoming chat message via browser synthesis
            if (typeof broadcastState !== 'undefined' && broadcastState.settings?.ttsMode === 'self') {
                if (typeof speakBroadcastTTS === 'function') {
                    speakBroadcastTTS(msg.message || msg.text, msg.username);
                }
            }
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
        case 'auth':
            if (msg.authenticated) {
                addSystemMessage(`Chatting as ${msg.username}`);
            } else {
                addSystemMessage(`Chatting as ${msg.username}`);
            }
            // Sync slow mode state from server on join
            if (typeof msg.slowmode_seconds === 'number') {
                chatSlowModeSeconds = msg.slowmode_seconds;
                updateSlowModeIndicator();
            }
            break;
        case 'slowmode':
            chatSlowModeSeconds = msg.seconds || 0;
            updateSlowModeIndicator();
            break;
        case 'clear': {
            const { messages: clearTarget } = getChatEl();
            if (clearTarget) clearTarget.innerHTML = '';
            addSystemMessage('Chat was cleared by a moderator');
            break;
        }
        case 'tts':
            // Legacy browser-side TTS (Self TTS mode)
            if (typeof broadcastState !== 'undefined' && broadcastState.settings?.ttsMode === 'self') {
                // Broadcast page — use broadcast TTS with its volume/pitch/rate settings
                if (typeof speakBroadcastTTS === 'function') {
                    speakBroadcastTTS(msg.message || msg.text, msg.username);
                }
            } else if (chatSettings.ttsEnabled) {
                speakTTS(msg.message || msg.text, msg.voiceFX);
            }
            break;
        case 'tts-audio':
            // Server-synthesized TTS audio (Site-Wide TTS mode)
            if (typeof playBroadcastTTSAudio === 'function' && typeof broadcastState !== 'undefined') {
                // Broadcast page — route to broadcast audio queue
                playBroadcastTTSAudio(msg);
            } else if (chatSettings.ttsEnabled) {
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
        case 'coin_earned':
            if (typeof handleCoinEarned === 'function') handleCoinEarned(msg);
            break;
        case 'redemption': {
            const { messages: rContainer } = getChatEl();
            if (rContainer && typeof renderRedemption === 'function') renderRedemption(msg, rContainer);
            break;
        }
    }
}

function addChatMessage(msg) {
    const chatEl = getChatEl();
    const container = chatEl.messages;
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-msg';

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
        streamBadge = `<span class="chat-stream-badge" title="From ${esc(msg.stream_channel)}'s stream" onclick="navigate('/${esc(msg.stream_channel)}')">${esc(msg.stream_channel)}</span> `;
    } else if (isGlobal && msg.stream_username) {
        streamBadge = `<span class="chat-stream-badge" title="From ${esc(msg.stream_username)}'s stream" onclick="navigate('/${esc(msg.stream_username)}')">${esc(msg.stream_username)}</span> `;
    }

    const badge = chatSettings.showBadges ? getBadgeHTML(msg.role) : '';
    let nameColor = msg.color || msg.profile_color || getRoleColor(msg.role);
    // Readable colors — ensure minimum contrast against dark backgrounds
    if (chatSettings.readableColors) nameColor = ensureReadableColor(nameColor);

    const displayName = esc(msg.username || msg.displayName || `anon${msg.anonId || ''}`);
    const rawText = msg.message || msg.text || '';
    const text = (typeof parseEmotes === 'function') ? parseEmotes(rawText) : esc(rawText);
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

    const userId = msg.user_id || '';

    // ── Cosmetic rendering ───────────────────────────────
    // Hat emoji before name
    let hatHtml = '';
    if (msg.hatFX && msg.hatFX.hatChar) {
        const animClass = msg.hatFX.animated ? ` hat-${msg.hatFX.animated}` : '';
        hatHtml = `<span class="chat-hat${animClass}">${msg.hatFX.hatChar}</span>`;
    }

    // Name effect CSS class on username
    const nameFXClass = msg.nameFX?.cssClass ? ` ${msg.nameFX.cssClass}` : '';

    // Particle wrapper
    const hasParticles = msg.particleFX?.chars;
    const particleWrapOpen = hasParticles ? `<span class="chat-particle-wrap ${msg.particleFX.cssClass || ''}">` : '';
    const particleWrapClose = hasParticles ? `</span>` : '';

    el.innerHTML = `${timestamp}${streamBadge}<span class="chat-avatar-wrap">${avatarHtml}</span>${badge}${hatHtml}${particleWrapOpen}<span class="chat-user${nameFXClass}" style="color:${nameColor}" data-username="${displayName}" data-user-id="${userId}" data-anon="${isAnon ? '1' : ''}" oncontextmenu="showChatContextMenu(event)" onclick="showChatContextMenu(event)">${displayName}</span>${particleWrapClose}: ${text}`;

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
    if (chatSettings.autoScroll) scrollChat();
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
function sendChat() {
    const { input } = getChatEl();
    if (!input) return;
    const text = input.value.trim();
    if (!text || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;

    // Client-side cooldown enforcement
    if (chatSlowModeCooldownEnd > Date.now()) {
        const remaining = Math.ceil((chatSlowModeCooldownEnd - Date.now()) / 1000);
        addSystemMessage(`Slow mode: wait ${remaining}s`);
        return;
    }

    chatWs.send(JSON.stringify({
        type: 'chat',
        message: text,
        streamId: chatStreamId,
    }));

    input.value = '';
    input.focus();
    startSlowModeCooldown();
}

/* ── History ──────────────────────────────────────────────────── */
async function loadChatHistory(streamId) {
    if (!streamId) return; // Use loadGlobalChatHistory() for global
    try {
        const data = await api(`/chat/${streamId}/history?limit=500`);
        const msgs = data.messages || [];
        msgs.forEach(m => {
            addChatMessage({
                username: m.username || m.display_name || `anon${m.user_id || ''}`,
                message: m.message,
                role: m.role || 'user',
                color: m.color,
                avatar_url: m.avatar_url,
                profile_color: m.profile_color,
                user_id: m.user_id,
                timestamp: m.timestamp,
            });
        });
    } catch { /* silent */ }
}

async function loadGlobalChatHistory() {
    try {
        const data = await api('/chat/global/history?limit=500');
        const msgs = data.messages || [];
        msgs.forEach(m => {
            addChatMessage({
                username: m.username || m.display_name || `anon${m.user_id || ''}`,
                message: m.message,
                role: m.role || 'user',
                color: m.color,
                avatar_url: m.avatar_url,
                profile_color: m.profile_color,
                user_id: m.user_id,
                timestamp: m.timestamp,
                stream_username: m.stream_username || null,
            });
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
    const userId = target.dataset.userId;
    const isAnon = target.dataset.anon === '1';
    if (!username) return;

    const menu = document.createElement('div');
    menu.className = 'chat-context-menu';
    menu.innerHTML = `
        <div class="ctx-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>
    `;

    // Position near the click
    document.body.appendChild(menu);
    positionContextMenu(menu, event.clientX, event.clientY);
    activeContextMenu = menu;

    // Fetch user profile (or render simplified menu for anon users)
    loadContextMenuProfile(menu, username, userId, isAnon);

    // Click outside to dismiss
    setTimeout(() => {
        document.addEventListener('click', dismissContextMenu, { once: true });
    }, 10);
}

function positionContextMenu(menu, x, y) {
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Adjust if overflowing viewport
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth - 8) {
            menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
        }
        if (rect.bottom > window.innerHeight - 8) {
            menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
        }
        if (rect.left < 8) menu.style.left = '8px';
        if (rect.top < 8) menu.style.top = '8px';
    });
}

function dismissContextMenu() {
    if (activeContextMenu) {
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
                <button class="ctx-btn" onclick="ctxWhisper('${esc(username)}')"><i class="fa-solid fa-comment"></i> Whisper</button>
                <button class="ctx-btn" onclick="ctxViewChannel('${esc(username)}')"><i class="fa-solid fa-user"></i> Channel</button>
            </div>
        `;
    }
}

function renderAnonContextMenu(menu, username, userId) {
    const initial = username[0] ? username[0].toUpperCase() : '?';
    const adminBtns = currentUser && currentUser.role === 'admin'
        ? `<div class="ctx-divider"></div>
           <button class="ctx-btn ctx-btn-danger" onclick="ctxBanUser('${esc(username)}', '${esc(userId)}')"><i class="fa-solid fa-ban"></i> Ban</button>`
        : '';
    menu.innerHTML = `
        <div class="ctx-header">
            <span class="ctx-avatar-letter" style="background:#666">${initial}</span>
            <div class="ctx-info">
                <span class="ctx-name">${esc(username)}</span>
                <span class="ctx-meta">Anonymous user</span>
            </div>
        </div>
        <div class="ctx-actions">
            <button class="ctx-btn" onclick="ctxWhisper('${esc(username)}')"><i class="fa-solid fa-comment"></i> Whisper</button>
            ${adminBtns}
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
            <button class="ctx-btn" onclick="ctxWhisper('${esc(username)}')"><i class="fa-solid fa-comment"></i> Whisper</button>
            <button class="ctx-btn" onclick="ctxViewChannel('${esc(username)}')"><i class="fa-solid fa-user"></i> Channel</button>
            ${currentUser?.capabilities?.view_all_logs ? `<button class="ctx-btn" onclick="ctxViewLogs('${esc(username)}', ${profile.id})"><i class="fa-solid fa-clock-rotate-left"></i> Chat Logs</button>` : ''}
            ${currentUser?.capabilities?.manage_site_bans ? `<button class="ctx-btn ctx-btn-danger" onclick="ctxBanUser('${esc(username)}', ${profile.id})"><i class="fa-solid fa-ban"></i> Ban</button>` : ''}
        </div>
    `;
}

/* ── Context menu actions ─────────────────────────────────────── */
function ctxWhisper(username) {
    dismissContextMenu();
    const { input } = getChatEl();
    if (input) {
        input.value = `/w ${username} `;
        input.focus();
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

function ctxBanUser(username, userId) {
    dismissContextMenu();
    if (!confirm(`Ban ${username}?`)) return;
    api(`/admin/users/${userId}/ban`, { method: 'POST', body: JSON.stringify({ reason: 'Banned via chat' }) })
        .then(() => toast(`${username} banned`, 'success'))
        .catch(() => toast('Ban failed', 'error'));
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
                    <span class="log-user" style="color:${m.profile_color || '#999'}">${name}</span>:
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

function scrollChat() {
    const { messages: container } = getChatEl();
    if (!container) return;
    // Only auto-scroll if user is near the bottom
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (nearBottom) {
        container.scrollTop = container.scrollHeight;
    }
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
    if (el) el.textContent = count;
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
function speakTTS(text, voiceFX) {
    if (!('speechSynthesis' in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
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
        audio.volume = (chatSettings.ttsVolume || 80) / 100;
        audio.onended = () => { URL.revokeObjectURL(url); _ttsAudioPlaying = false; _processTTSAudioQueue(); };
        audio.onerror = () => { URL.revokeObjectURL(url); _ttsAudioPlaying = false; _processTTSAudioQueue(); };
        audio.play().catch(() => { URL.revokeObjectURL(url); _ttsAudioPlaying = false; _processTTSAudioQueue(); });
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
    chatSettings.ttsEnabled = !chatSettings.ttsEnabled;
    saveChatSettings();
    if (btn) {
        btn.classList.toggle('tts-active', chatSettings.ttsEnabled);
        btn.title = chatSettings.ttsEnabled ? 'TTS On (click to mute)' : 'TTS Off (click to enable)';
    }
    if (!chatSettings.ttsEnabled) cancelAllTTS();
}

/** Update TTS toggle button state (called after settings load) */
function syncTTSToggleButtons() {
    document.querySelectorAll('.chat-tts-toggle').forEach(btn => {
        btn.classList.toggle('tts-active', chatSettings.ttsEnabled);
        btn.title = chatSettings.ttsEnabled ? 'TTS On (click to mute)' : 'TTS Off (click to enable)';
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
            <div class="csp-title"><i class="fa-solid fa-volume-high"></i> Text-to-Speech</div>
            <label class="csp-row">
                <span>Enable TTS</span>
                <input type="checkbox" data-setting="ttsEnabled" onchange="onChatSettingChange(this)">
            </label>
            <label class="csp-row">
                <span>TTS Volume</span>
                <input type="range" min="0" max="100" step="5" data-setting="ttsVolume" onchange="onChatSettingChange(this)" oninput="onChatSettingChange(this)">
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
    if (el.type === 'checkbox') chatSettings[key] = el.checked;
    else if (el.type === 'range') chatSettings[key] = parseInt(el.value, 10);
    else chatSettings[key] = el.value;
    saveChatSettings();
    if (key === 'ttsEnabled') syncTTSToggleButtons();
}

function resetChatSettings() {
    chatSettings = { ...CHAT_SETTINGS_DEFAULTS };
    saveChatSettings();
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
