/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Core Application (SPA Router, Auth, API)
   URL-based routing with history.pushState
   ═══════════════════════════════════════════════════════════════ */

const API = '';   // same-origin
let currentUser = null;
let currentPage = 'home';
let currentStreamId = null;
let currentStreamData = null;
let hoboAppMetaData = null;
let hoboAppMetaPromise = null;

// Reserved paths (not usernames)
const RESERVED = new Set(['vods', 'clips', 'vod', 'clip', 'dashboard', 'settings', 'broadcast', 'admin', 'themes', 'game', 'chat', 'api', 'ws', 'media', 'pastes', 'p', 'updates']);

/* ── API helpers ──────────────────────────────────────────────── */
function authHeaders() {
    const tok = localStorage.getItem('token');
    return tok ? { Authorization: `Bearer ${tok}` } : {};
}

async function api(path, opts = {}) {
    const res = await fetch(`${API}/api${path}`, {
        headers: { 'Content-Type': 'application/json', ...authHeaders(), ...opts.headers },
        ...opts,
        body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { status: res.status, message: data.error || 'Request failed', data };
    return data;
}

/* ── Protocol Badge ───────────────────────────────────────────── */
function protocolBadge(protocol) {
    if (!protocol) return '';
    const labels = { jsmpeg: 'JSMPEG', webrtc: 'WebRTC', rtmp: 'RTMP' };
    return `<span class="protocol-badge protocol-${protocol}">${labels[protocol] || protocol.toUpperCase()}</span>`;
}

/* ── Toast ────────────────────────────────────────────────────── */
function toast(msg, type = 'info') {
    const c = document.getElementById('toast-container');
    const icons = { success: 'fa-check-circle', error: 'fa-circle-exclamation', info: 'fa-info-circle' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icon = document.createElement('i');
    icon.className = `fa-solid ${icons[type] || icons.info}`;
    el.appendChild(icon);
    el.appendChild(document.createTextNode(` ${msg == null ? '' : String(msg)}`));
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
}

/* ── HoboApp Popover ─────────────────────────────────────────── */
function toggleHoboAppPopover() {
    const popover = document.getElementById('hoboapp-popover');
    const link = document.querySelector('.promo-bar-link');
    if (!popover) return;
    const isOpen = popover.classList.toggle('open');
    if (link) link.classList.toggle('open', isOpen);
    if (isOpen) void loadHoboAppMeta();
}
// Close popover when clicking outside
document.addEventListener('click', (e) => {
    const popover = document.getElementById('hoboapp-popover');
    if (!popover || !popover.classList.contains('open')) return;
    if (e.target.closest('.hoboapp-popover') || e.target.closest('.promo-bar-link')) return;
    popover.classList.remove('open');
    const link = document.querySelector('.promo-bar-link');
    if (link) link.classList.remove('open');
});

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function renderHoboAppMeta(data) {
    if (!data) return;

    const version = data.displayVersion || data.packageVersion || 'Unknown';
    const latestRelease = data.latestRelease;
    const latestCommit = data.latestCommit || {};
    const repo = data.repo || {};

    setText('hoboapp-version', version);
    setText('hoboapp-meta-version', version);
    setText(
        'hoboapp-meta-version-sub',
        latestRelease?.publishedAt
            ? `Released ${timeAgo(latestRelease.publishedAt)} · ${formatDateTime(latestRelease.publishedAt)}`
            : data.packageVersion
                ? `Package version on ${repo.defaultBranch || 'main'}`
                : 'No tagged release yet'
    );

    setText('hoboapp-meta-commit', latestCommit.shortSha || 'Unknown');
    setText(
        'hoboapp-meta-commit-sub',
        latestCommit.committedAt
            ? `Committed ${timeAgo(latestCommit.committedAt)} · ${formatDateTime(latestCommit.committedAt)}`
            : 'Latest commit time unavailable'
    );

    setText('hoboapp-meta-pushed', repo.pushedAt ? timeAgo(repo.pushedAt) : 'Unknown');
    setText(
        'hoboapp-meta-pushed-sub',
        repo.pushedAt ? formatDateTime(repo.pushedAt) : 'Repository push time unavailable'
    );

    setText('hoboapp-meta-stars', Number(repo.stars || 0).toLocaleString());
    setText('hoboapp-meta-stars-sub', `${Number(repo.forks || 0).toLocaleString()} forks · ${Number(repo.openIssues || 0).toLocaleString()} open issues`);
    setText('hoboapp-commit-message', latestCommit.message || 'Latest commit message unavailable');

    const commitLink = document.getElementById('hoboapp-commit-link');
    if (commitLink) commitLink.href = latestCommit.htmlUrl || repo.htmlUrl || 'https://github.com/HoboStreamer/HoboApp';

    const ctaSub = document.getElementById('hoboapp-cta-sub');
    if (ctaSub) {
        ctaSub.innerHTML = `<i class="fa-solid fa-code-branch"></i> Latest push ${esc(repo.pushedAt ? timeAgo(repo.pushedAt) : 'unknown')} &nbsp;·&nbsp; <i class="fa-solid fa-code-commit"></i> ${esc(latestCommit.shortSha || 'n/a')} &nbsp;·&nbsp; <i class="fa-brands fa-windows"></i> <i class="fa-brands fa-linux"></i> <i class="fa-brands fa-apple"></i> Windows, Linux & macOS`;
    }
}

function renderHoboAppMetaError(message = 'Unable to load HoboApp GitHub data right now') {
    setText('hoboapp-version', 'GitHub offline');
    setText('hoboapp-meta-version', 'Unavailable');
    setText('hoboapp-meta-version-sub', message);
    setText('hoboapp-meta-commit', 'Unavailable');
    setText('hoboapp-meta-commit-sub', 'Could not fetch latest commit');
    setText('hoboapp-meta-pushed', 'Unavailable');
    setText('hoboapp-meta-pushed-sub', 'Could not fetch repository activity');
    setText('hoboapp-meta-stars', '—');
    setText('hoboapp-meta-stars-sub', 'GitHub metadata unavailable');
    setText('hoboapp-commit-message', message);
}

async function loadHoboAppMeta(force = false) {
    if (!force && hoboAppMetaData) {
        renderHoboAppMeta(hoboAppMetaData);
        return hoboAppMetaData;
    }
    if (!force && hoboAppMetaPromise) return hoboAppMetaPromise;

    hoboAppMetaPromise = api('/meta/hoboapp')
        .then((data) => {
            hoboAppMetaData = data;
            renderHoboAppMeta(data);
            return data;
        })
        .catch((error) => {
            renderHoboAppMetaError(error?.message || 'Failed to load latest HoboApp GitHub info');
            throw error;
        })
        .finally(() => {
            hoboAppMetaPromise = null;
        });

    return hoboAppMetaPromise;
}

/* ── Modal ────────────────────────────────────────────────────── */
function showModal(id) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    const templates = {
        login: `
            <h3><i class="fa-solid fa-right-to-bracket"></i> Login</h3>
            <div class="form-group">
                <label>Username</label>
                <input type="text" id="modal-login-user" class="form-input" placeholder="Username">
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" id="modal-login-pass" class="form-input" placeholder="Password"
                       onkeydown="if(event.key==='Enter')doLogin()">
            </div>
            <button class="btn btn-primary btn-lg" onclick="doLogin()" style="width:100%;margin-top:8px">
                <i class="fa-solid fa-right-to-bracket"></i> Login
            </button>`,
        register: `
            <h3><i class="fa-solid fa-user-plus"></i> Sign Up</h3>
            <div class="form-group">
                <label>Username</label>
                <input type="text" id="modal-reg-user" class="form-input" placeholder="Username">
            </div>
            <div class="form-group">
                <label>Email (optional)</label>
                <input type="email" id="modal-reg-email" class="form-input" placeholder="Email">
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" id="modal-reg-pass" class="form-input" placeholder="Password (min 6)">
            </div>
            <div class="form-group" id="reg-vkey-group">
                <label><i class="fa-solid fa-key"></i> Registration Code <span class="muted" style="font-weight:normal">(optional)</span></label>
                <input type="text" id="modal-reg-vkey" class="form-input" placeholder="HOBO-XXXX-XXXX-XXXX"
                       style="text-transform:uppercase;letter-spacing:1px">
                <small class="muted">Have an RS-Companion account? Enter your code to port your XP, coins, inventory & stats.</small>
            </div>
            <button class="btn btn-primary btn-lg" onclick="doRegister()" style="width:100%;margin-top:8px">
                <i class="fa-solid fa-user-plus"></i> Create Account
            </button>`,
        donate: hoboBucksDonateModal(),
        'buy-funds': hoboBucksBuyModal(),
        cashout: hoboBucksCashoutModal(),
        'stream-key': streamKeyModal(),
        'add-control': addControlModal(),
        'add-goal': addGoalModal(),
        'add-reward': addRewardModal(),
        'redeem-reward': (data) => redeemRewardModal(data),
    };
    content.innerHTML = typeof templates[id] === 'function' ? templates[id]() : (templates[id] || `<p>Unknown modal: ${id}</p>`);
    overlay.classList.add('show');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('show');
}

/* ── Auth ──────────────────────────────────────────────────────── */
async function doLogin() {
    try {
        const username = document.getElementById('modal-login-user').value.trim();
        const password = document.getElementById('modal-login-pass').value;
        if (!username || !password) return toast('Fill in all fields', 'error');
        const data = await api('/auth/login', { method: 'POST', body: { username, password } });
        localStorage.setItem('token', data.token);
        currentUser = data.user;
        onAuthChange();
        if (typeof loadThemeFromServer === 'function') loadThemeFromServer();
        closeModal();
        toast(`Welcome back, ${currentUser.username}!`, 'success');
    } catch (e) { toast(e.message || 'Login failed', 'error'); }
}

async function doRegister() {
    try {
        const username = document.getElementById('modal-reg-user').value.trim();
        const email = document.getElementById('modal-reg-email').value.trim();
        const password = document.getElementById('modal-reg-pass').value;
        const verification_key = document.getElementById('modal-reg-vkey')?.value.trim() || '';
        if (!username || !password) return toast('Username & password required', 'error');
        if (password.length < 6) return toast('Password must be at least 6 characters', 'error');
        const body = { username, email, password };
        if (verification_key) body.verification_key = verification_key;
        const data = await api('/auth/register', { method: 'POST', body });
        localStorage.setItem('token', data.token);
        currentUser = data.user;
        onAuthChange();
        if (typeof loadThemeFromServer === 'function') loadThemeFromServer();
        closeModal();
        if (data.migrated) {
            toast(`Account created! ${data.migrated}`, 'success');
        } else {
            toast(`Account created! Welcome, ${currentUser.username}`, 'success');
        }
    } catch (e) {
        // Show verification key field if username is reserved
        if (e.data?.reserved) {
            const vkeyGroup = document.getElementById('reg-vkey-group');
            if (vkeyGroup) vkeyGroup.style.display = '';
        }
        toast(e.message || 'Registration failed', 'error');
    }
}

function logout() {
    localStorage.removeItem('token');
    currentUser = null;
    onAuthChange();
    if (['dashboard', 'admin', 'broadcast', 'settings'].includes(currentPage)) navigate('/');
    toast('Logged out', 'info');
}

async function loadUser() {
    const tok = localStorage.getItem('token');
    if (!tok) return;
    try {
        const data = await api('/auth/me');
        currentUser = data.user || data;
    } catch {
        localStorage.removeItem('token');
    }
}

function onAuthChange() {
    const anon = document.getElementById('nav-auth-anon');
    const user = document.getElementById('nav-auth-user');
    const dash = document.getElementById('nav-dashboard');
    const broadcast = document.getElementById('nav-broadcast');
    const admin = document.getElementById('nav-admin');

    if (currentUser) {
        anon.style.display = 'none';
        user.style.display = 'flex';
        dash.style.display = '';
        broadcast.style.display = '';
        admin.style.display = currentUser.capabilities?.admin_panel ? '' : 'none';
        document.getElementById('nav-avatar').textContent = currentUser.username[0].toUpperCase();
        document.getElementById('nav-username').textContent = currentUser.username;
        loadBalance();
    } else {
        anon.style.display = '';
        user.style.display = 'none';
        dash.style.display = 'none';
        broadcast.style.display = 'none';
        admin.style.display = 'none';
    }
    document.getElementById('user-dropdown').classList.remove('show');

    try {
        window.dispatchEvent(new CustomEvent('hobo-auth-changed', {
            detail: {
                user: currentUser || null,
                token: localStorage.getItem('token') || null,
            },
        }));
    } catch {}
}

async function loadBalance() {
    if (!currentUser) return;
    try {
        const data = await api('/funds/balance');
        const bal = data.balance || 0;
        document.getElementById('nav-balance-amount').textContent = parseFloat(bal).toFixed(2);
    } catch { /* silent */ }
    try {
        const coinData = await api('/coins/balance');
        const coins = coinData.balance || 0;
        document.getElementById('nav-coins-amount').textContent = coins.toLocaleString();
        // Also update rewards panels if visible
        document.querySelectorAll('.rewards-coin-balance').forEach(el => {
            el.textContent = coins.toLocaleString();
        });
    } catch { /* silent */ }
}

function toggleUserMenu() {
    document.getElementById('user-dropdown').classList.toggle('show');
}

function closeMobileNav() {
    document.querySelector('.nav-links')?.classList.remove('show');
}

function toggleMobileNav() {
    document.querySelector('.nav-links').classList.toggle('show');
}

/* ── SPA Router (URL-based) ───────────────────────────────────── */
function navigate(urlPath, replace = false) {
    closeMobileNav();

    // Clean up existing page state (destroy player, disconnect chat, etc.)
    if (typeof destroyPlayer === 'function') destroyPlayer();
    if (typeof destroyChat === 'function') destroyChat();
    if (typeof stopCoinHeartbeat === 'function') stopCoinHeartbeat();
    if (typeof stopStreamStatusPoll === 'function') stopStreamStatusPoll();
    clearInterval(uptimeInterval);

    // Clean up live VOD poll timer
    if (window._liveVodPollTimer) {
        clearInterval(window._liveVodPollTimer);
        window._liveVodPollTimer = null;
        window._liveVodIsLive = false;
    }

    // Normalize path
    if (!urlPath.startsWith('/')) urlPath = '/' + urlPath;

    // Push to browser history
    if (replace) {
        history.replaceState(null, '', urlPath);
    } else {
        history.pushState(null, '', urlPath);
    }

    routeFromURL();
}

function routeFromURL() {
    const path = window.location.pathname;
    const segments = path.split('/').filter(Boolean);

    // Clean up existing page state
    if (typeof destroyPlayer === 'function') destroyPlayer();

    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelector('.nav-links')?.classList.remove('show');

    window.scrollTo(0, 0);

    // Route matching
    if (segments.length === 0) {
        // Home: /
        showPage('home');
        loadHome();
    } else if (segments[0] === 'vods') {
        showPage('vods');
        loadVodsPage();
    } else if (segments[0] === 'clips') {
        showPage('clips');
        loadClipsPage();
    } else if (segments[0] === 'vod' && segments[1]) {
        // VOD player: /vod/:id
        showPage('vod-player');
        loadVodPlayer(segments[1]);
    } else if (segments[0] === 'clip' && segments[1]) {
        // Clip player: /clip/:id
        showPage('clip-player');
        loadClipPlayer(segments[1]);
    } else if (segments[0] === 'dashboard') {
        showPage('dashboard');
        loadDashboard();
    } else if (segments[0] === 'settings') {
        showPage('settings');
        loadSettingsPage();
    } else if (segments[0] === 'broadcast') {
        showPage('broadcast');
        loadBroadcastPage();
    } else if (segments[0] === 'admin') {
        showPage('admin');
        loadAdmin();
    } else if (segments[0] === 'themes') {
        showPage('themes');
        loadThemesPage();
    } else if (segments[0] === 'chat') {
        showPage('chat');
        loadChatPage();
    } else if (segments[0] === 'game') {
        showPage('game');
        loadGamePage();
    } else if (segments[0] === 'pastes') {
        showPage('pastes');
        loadPastesPage();
        // Handle ?edit=slug
        const editSlug = new URLSearchParams(window.location.search).get('edit');
        if (editSlug) {
            api(`/api/pastes/${editSlug}`).then(data => {
                if (data.paste) openNewPasteModal({
                    title: data.paste.title,
                    content: data.paste.content,
                    language: data.paste.language,
                    visibility: data.paste.visibility,
                    slug: editSlug,
                });
            }).catch(() => {});
        }
    } else if (segments[0] === 'updates') {
        showPage('updates');
        loadUpdatesPage();
    } else if (segments[0] === 'p' && segments[1]) {
        showPage('paste-viewer');
        loadPasteViewer(segments[1]);
    } else if (segments[0] === 'stream' && segments[1]) {
        // Legacy stream URL: /stream/:id
        showPage('stream');
        openStream(segments[1]);
    } else if (segments.length === 1 && !RESERVED.has(segments[0])) {
        // Channel page: /:username
        showPage('channel');
        loadChannelPage(segments[0]);
    } else {
        // 404 fallback
        showPage('home');
        loadHome();
    }
}

function showPage(page) {
    currentPage = page;
    const el = document.getElementById(`page-${page}`);
    if (el) el.classList.add('active');

    // Game: hide footer only, keep navbar visible; other pages restore both
    const navbar = document.querySelector('.navbar');
    const footer = document.querySelector('.footer');
    if (page === 'game') {
        if (footer) footer.style.display = 'none';
        document.body.style.overflow = 'hidden';
    } else {
        if (navbar) navbar.style.display = '';
        if (footer) footer.style.display = '';
        document.body.style.overflow = '';
    }

    // Highlight nav link
    const pageToNav = { home: 'home', vods: 'vods', clips: 'clips', broadcast: 'broadcast', dashboard: 'dashboard', admin: 'admin', chat: 'chat', game: 'game', pastes: 'pastes', 'paste-viewer': 'pastes' };
    const navPage = pageToNav[page];
    if (navPage) {
        const link = document.querySelector(`.nav-link[data-page="${navPage}"]`);
        if (link) link.classList.add('active');
    }
}

/* ── Home Page ────────────────────────────────────────────────── */
async function loadHome() {
    void loadHoboAppMeta();

    try {
        const liveData = await api('/streams');
        const streams = liveData.streams || [];
        document.getElementById('live-count').textContent = streams.length;
        const noLiveEl = document.getElementById('no-live-streams');
        if (noLiveEl) noLiveEl.style.display = streams.length ? 'none' : '';
        renderStreamGrid('stream-grid-live', streams, true);
    } catch (e) { console.error('Failed to load live streams', e); }

    try {
        const recentData = await api('/streams/recent');
        renderStreamGrid('stream-grid-recent', recentData.streams || [], false);
    } catch { /* silent */ }
}

function renderStreamGrid(containerId, streams, isLive) {
    const c = document.getElementById(containerId);
    if (!streams.length) {
        if (!isLive) c.innerHTML = '<div class="empty-state"><p class="muted">No recent streams</p></div>';
        return;
    }
    c.innerHTML = streams.map(s => `
        <div class="stream-card" onclick="navigate('/${esc(s.username)}')">
            <div class="stream-card-thumb">
                ${thumbImg(s.thumbnail_url, 'fa-campground', s.title)}
                ${isLive ? '<span class="stream-card-live">LIVE</span>' : ''}
                ${s.protocol ? protocolBadge(s.protocol) : ''}
                ${s.is_nsfw ? '<span class="stream-card-nsfw">NSFW</span>' : ''}
                <span class="stream-card-viewers"><i class="fa-solid fa-eye"></i> ${s.viewer_count || 0}</span>
            </div>
            <div class="stream-card-info">
                <div class="stream-card-title">${esc(s.title || 'Untitled Stream')}</div>
                <div class="stream-card-streamer">
                    <span class="stream-card-avatar">${(s.username || '?')[0].toUpperCase()}</span>
                    ${esc(s.username || 'Anonymous')}
                </div>
                ${s.category ? `<div class="stream-card-tags"><span class="stream-card-tag">${esc(s.category)}</span></div>` : ''}
            </div>
        </div>
    `).join('');
}

/* ── Channel Page (/:username) ────────────────────────────────── */
let currentChannelUsername = null;

/* ── Global Chat Page ──────────────────────────────────────── */
function loadChatPage() {
    // Connect to global chat (no streamId)
    initChat(null);
    // Load global history
    loadGlobalChatHistory();
}

async function loadChannelPage(username) {
    try {
        currentChannelUsername = username;
        const data = await api(`/streams/channel/${username}`);
        const ch = data.channel;
        const streams = data.streams || (data.stream ? [data.stream] : []);
        const vods = data.vods || [];
        const clips = data.clips || [];
        const liveStreams = streams.filter(s => s && s.is_live);

        // Follow button helper
        const setupFollowBtn = (btn) => {
            if (!btn) return;
            if (currentUser && currentUser.username === username) {
                btn.style.display = 'none';
            } else {
                btn.style.display = '';
                btn.classList.toggle('following', ch.is_following);
                btn.innerHTML = ch.is_following
                    ? '<i class="fa-solid fa-heart-crack"></i> Unfollow'
                    : '<i class="fa-solid fa-heart"></i> Follow';
                btn.onclick = () => toggleChannelFollow(username);
            }
        };

        if (liveStreams.length > 0) {
            // ── LIVE STATE ──
            document.getElementById('ch-live-area').style.display = '';
            document.getElementById('ch-offline-area').style.display = 'none';

            // Populate streamer info bar (below video)
            document.getElementById('ch-avatar').textContent = (ch.username || '?')[0].toUpperCase();
            document.getElementById('ch-display-name').textContent = ch.display_name || ch.username;
            document.getElementById('ch-username').textContent = '@' + ch.username;
            document.getElementById('ch-category-badge').textContent = ch.category || 'irl';
            document.getElementById('ch-follower-count').textContent = `${ch.follower_count || 0} followers`;
            setupFollowBtn(document.getElementById('ch-btn-follow'));

            // Auto-select the stream with the most viewers
            const targetStream = liveStreams.reduce((best, s) =>
                (s.viewer_count || 0) > (best.viewer_count || 0) ? s : best
            , liveStreams[0]);
            loadLiveStreamTabs(username, targetStream.id, liveStreams);

            // Activate the requested stream (or first if none specified)
            activateChannelStream(targetStream);
        } else {
            // ── OFFLINE STATE ──
            document.getElementById('ch-live-area').style.display = 'none';
            document.getElementById('ch-offline-area').style.display = '';

            // Populate offline header
            document.getElementById('ch-avatar-offline').textContent = (ch.username || '?')[0].toUpperCase();
            document.getElementById('ch-display-name-offline').textContent = ch.display_name || ch.username;
            document.getElementById('ch-username-offline').textContent = '@' + ch.username;
            document.getElementById('ch-description-offline').textContent = ch.description || '';
            document.getElementById('ch-follower-count-offline').textContent = `${ch.follower_count || 0} followers`;
            document.getElementById('ch-category-badge-offline').textContent = ch.category || 'irl';
            setupFollowBtn(document.getElementById('ch-btn-follow-offline'));

            // Show global chat on offline channel pages
            initChat(null);
            loadGlobalChatHistory();

            // Hide stream tabs on offline channels
            const tabsC = document.getElementById('live-stream-tabs');
            if (tabsC) tabsC.style.display = 'none';

            // Poll for when streamer comes online
            startOfflineStatusPoll(username);
        }

        // VODs section
        const vodsGrid = document.getElementById('ch-vods-grid');
        let liveVodHtml = '';

        // Check for in-progress VOD recording on any live stream
        if (liveStreams.length > 0) {
            for (const ls of liveStreams) {
                try {
                    const liveVod = await api(`/vods/stream/${ls.id}/live`);
                    if (liveVod && liveVod.vod) {
                        const v = liveVod.vod;
                        liveVodHtml += `
                            <div class="stream-card" onclick="navigate('/vod/${v.id}')" style="border:2px solid var(--accent);position:relative">
                                <div class="stream-card-thumb">
                                    ${thumbImg(v.thumbnail_url, 'fa-video', v.title)}
                                    <span class="stream-card-nsfw" style="background:#e53e3e;animation:pulse 2s infinite">● RECORDING</span>
                                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(v.duration_seconds || 0)}</span>
                                </div>
                                <div class="stream-card-info">
                                    <div class="stream-card-title">${esc(v.title || 'Live Recording')}</div>
                                    <div class="stream-card-streamer muted">In progress — ${esc(ls.title || 'Live Stream')}</div>
                                </div>
                            </div>`;
                    }
                } catch {}
            }
        }

        if (liveVodHtml || vods.length) {
            const isOwner = currentUser && currentUser.username === username;
            vodsGrid.innerHTML = liveVodHtml + vods.map(v => `
                <div class="stream-card" onclick="navigate('/vod/${v.id}')">
                    <div class="stream-card-thumb">
                        ${thumbImg(v.thumbnail_url, 'fa-video', v.title)}
                        ${!v.is_public && isOwner ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">PRIVATE</span>' : ''}
                        ${v.stream_protocol ? protocolBadge(v.stream_protocol) : ''}
                        <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(v.duration_seconds || v.duration)}</span>
                    </div>
                    <div class="stream-card-info">
                        <div class="stream-card-title">${esc(v.title || 'VOD')}</div>
                        <div class="stream-card-streamer muted">${formatDateTime(v.created_at)}</div>
                    </div>
                </div>
            `).join('');
        } else {
            vodsGrid.innerHTML = '<p class="muted">No VODs yet</p>';
        }

        // Clips section
        const clipsGrid = document.getElementById('ch-clips-grid');
        if (clips.length) {
            const isOwner = currentUser && currentUser.username === username;
            clipsGrid.innerHTML = clips.map(cl => `
                <div class="stream-card" onclick="navigate('/clip/${cl.id}')">
                    <div class="stream-card-thumb">
                        ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title)}
                        ${!cl.is_public && isOwner ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">UNLISTED</span>' : ''}
                        ${cl.stream_protocol ? protocolBadge(cl.stream_protocol) : ''}
                        <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                    </div>
                    <div class="stream-card-info">
                        <div class="stream-card-title">${esc(cl.title || 'Clip')}</div>
                        <div class="stream-card-streamer muted">${formatDateTime(cl.created_at)}</div>
                    </div>
                </div>
            `).join('');
        } else {
            clipsGrid.innerHTML = '<p class="muted">No clips yet</p>';
        }

    } catch (e) {
        console.error('Channel load error:', e);
        toast('Channel not found', 'error');
        navigate('/');
    }
}

/**
 * Load tabs for the current channel's live streams.
 * Only shows tabs when the channel has multiple concurrent streams (multi-protocol).
 * @param {string} currentUsername - The channel username being viewed
 * @param {number|null} activeStreamId - Currently active stream ID
 * @param {Array} channelStreams - Live streams for this channel (already loaded)
 */
function loadLiveStreamTabs(currentUsername, activeStreamId, channelStreams = []) {
    const tabsContainer = document.getElementById('live-stream-tabs');
    const tabsScroll = document.getElementById('live-tabs-scroll');
    const pageEl = document.getElementById('page-channel');
    if (!tabsContainer || !tabsScroll) return;

    // Only show tabs if the channel has more than one concurrent live stream
    if (channelStreams.length <= 1) {
        tabsContainer.style.display = 'none';
        if (pageEl) pageEl.classList.remove('has-live-tabs');
        return;
    }

    // Filter to only show streams belonging to this channel (safety check)
    const filtered = channelStreams.filter(s =>
        !s.username || s.username.toLowerCase() === currentUsername.toLowerCase()
    );
    if (filtered.length <= 1) {
        tabsContainer.style.display = 'none';
        if (pageEl) pageEl.classList.remove('has-live-tabs');
        return;
    }

    tabsContainer.style.display = '';
    if (pageEl) pageEl.classList.add('has-live-tabs');
    tabsScroll.innerHTML = filtered.map((s, idx) => {
        const isActive = s.id === activeStreamId;
        // Use protocol-based label for clarity instead of raw stream title
        const protoLabel = s.protocol ? s.protocol.toUpperCase() : `Stream ${idx + 1}`;
        const tabLabel = `${esc(currentUsername)} (${protoLabel})`;
        const title = esc(s.title || 'Untitled Stream');
        return `<button class="live-tab ${isActive ? 'active' : ''}"
                    onclick="switchToLiveStream('${esc(currentUsername)}', ${s.id}, this)"
                    data-stream-id="${s.id}" data-username="${esc(currentUsername)}" title="${title}">
            <span class="live-tab-dot"></span>
            <span>${tabLabel}</span>
            ${s.protocol ? protocolBadge(s.protocol) : ''}
            <span class="live-tab-viewers"><i class="fa-solid fa-eye"></i> ${s.viewer_count || 0}</span>
        </button>`;
    }).join('');
}

/**
 * Switch to a different live stream (possibly different user/channel).
 * Navigates to that user's channel page and activates their stream.
 */
function switchToLiveStream(username, streamId, btn) {
    // If switching to a different channel, navigate there
    if (username !== currentChannelUsername) {
        navigate('/' + username);
        return;
    }

    // Same channel, just switch the stream (multi-protocol case)
    const tabsScroll = document.getElementById('live-tabs-scroll');
    if (tabsScroll) {
        tabsScroll.querySelectorAll('.live-tab').forEach(t => t.classList.remove('active'));
    }
    if (btn) btn.classList.add('active');

    api(`/streams/${streamId}`).then(data => {
        const s = data.stream || data;
        if (s && s.is_live) activateChannelStream(s);
        else toast('Stream is no longer live', 'error');
    }).catch(() => toast('Failed to load stream', 'error'));
}

function activateChannelStream(stream) {
    currentStreamId = stream.id;
    currentStreamData = stream;
    document.getElementById('ch-stream-title').textContent = stream.title || 'Untitled Stream';
    // Protocol badge on live channel page
    const chProtoEl = document.getElementById('ch-protocol-badge');
    if (chProtoEl) chProtoEl.innerHTML = stream.protocol ? protocolBadge(stream.protocol) : '';
    // Description on live channel page
    const chDescEl = document.getElementById('ch-stream-description');
    if (chDescEl) {
        const desc = stream.description || '';
        chDescEl.textContent = desc;
        chDescEl.style.display = desc ? '' : 'none';
    }
    if (typeof initPlayer === 'function') initPlayer(stream);
    if (typeof initChat === 'function') initChat(stream.id);
    if (typeof loadStreamControls === 'function') loadStreamControls(stream.id);
    if (typeof startCoinHeartbeat === 'function') startCoinHeartbeat(stream.id);
    startUptime(stream.started_at);

    // Start polling for stream status changes
    startStreamStatusPoll(stream);
}

/* ── Stream Status Polling — auto-detect online/offline ──────── */
let _streamPollTimer = null;
const STREAM_POLL_INTERVAL = 15000; // 15 seconds

function stopStreamStatusPoll() {
    if (_streamPollTimer) { clearInterval(_streamPollTimer); _streamPollTimer = null; }
}

function startStreamStatusPoll(stream) {
    stopStreamStatusPoll();
    if (!currentChannelUsername) return;
    const username = currentChannelUsername;

    _streamPollTimer = setInterval(async () => {
        // Stop polling if user navigated away from the channel page
        if (currentChannelUsername !== username) { stopStreamStatusPoll(); return; }
        try {
            const data = await api(`/streams/channel/${username}`);
            const streams = data.streams || (data.stream ? [data.stream] : []);
            const liveStreams = streams.filter(s => s && s.is_live);

            if (liveStreams.length === 0 && currentStreamId) {
                // Stream went offline — show offline state
                stopStreamStatusPoll();
                loadChannelPage(username);
                return;
            }

            if (liveStreams.length > 0 && !currentStreamId) {
                // Stream came online — switch to live state
                stopStreamStatusPoll();
                loadChannelPage(username);
                return;
            }

            // Check if current stream is still live
            const current = liveStreams.find(s => s.id === currentStreamId);
            if (!current && liveStreams.length > 0) {
                // Current stream ended, but others are live — switch to best
                const best = liveStreams.reduce((b, s) =>
                    (s.viewer_count || 0) > (b.viewer_count || 0) ? s : b
                , liveStreams[0]);
                loadLiveStreamTabs(username, best.id, liveStreams);
                activateChannelStream(best);
                toast('Stream ended — switching to another live stream', 'info');
                return;
            }

            // Update tabs with fresh viewer counts
            if (liveStreams.length > 1) {
                loadLiveStreamTabs(username, currentStreamId, liveStreams);
            } else {
                // Single stream — ensure tabs are hidden
                const tabsC = document.getElementById('live-stream-tabs');
                if (tabsC) tabsC.style.display = 'none';
            }

            // Update viewer count in the active stream's tab
            if (current) {
                const badge = document.querySelector(`.live-tab[data-stream-id="${current.id}"] .live-tab-viewers`);
                if (badge) badge.innerHTML = `<i class="fa-solid fa-eye"></i> ${current.viewer_count || 0}`;
            }
        } catch { /* silent — network error, retry next interval */ }
    }, STREAM_POLL_INTERVAL);
}

// Start offline poll — detects when a channel comes online
function startOfflineStatusPoll(username) {
    stopStreamStatusPoll();
    _streamPollTimer = setInterval(async () => {
        if (currentChannelUsername !== username) { stopStreamStatusPoll(); return; }
        try {
            const data = await api(`/streams/channel/${username}`);
            const streams = data.streams || (data.stream ? [data.stream] : []);
            const liveStreams = streams.filter(s => s && s.is_live);
            if (liveStreams.length > 0) {
                stopStreamStatusPoll();
                loadChannelPage(username);
                toast(`${username} is now live!`, 'success');
            }
        } catch { /* silent */ }
    }, STREAM_POLL_INTERVAL);
}

async function toggleChannelFollow(username) {
    if (!currentUser) return showModal('login');
    try {
        const data = await api(`/streams/channel/${username}/follow`, { method: 'POST' });
        // Update both live and offline follow buttons
        ['ch-btn-follow', 'ch-btn-follow-offline'].forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.classList.toggle('following', data.following);
            btn.innerHTML = data.following
                ? '<i class="fa-solid fa-heart-crack"></i> Unfollow'
                : '<i class="fa-solid fa-heart"></i> Follow';
        });
        ['ch-follower-count', 'ch-follower-count-offline'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = `${data.count || 0} followers`;
        });
        toast(data.following ? 'Followed!' : 'Unfollowed', 'info');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Stream Viewer (legacy /stream/:id) ──────────────────────── */
async function openStream(streamId) {
    if (!streamId) return navigate('/');
    currentStreamId = streamId;

    try {
        const data = await api(`/streams/${streamId}`);
        const s = data.stream || data;
        currentStreamData = s;

        // If stream has a username, redirect to channel
        if (s.username) {
            return navigate(`/${s.username}`, true);
        }

        document.getElementById('stream-title').textContent = s.title || 'Untitled';
        document.getElementById('stream-streamer').textContent = s.username || 'Unknown';
        document.getElementById('streamer-avatar').textContent = (s.username || '?')[0].toUpperCase();
        document.getElementById('stream-description').textContent = s.description || '';
        document.getElementById('follower-count').textContent = `${s.follower_count || 0} followers`;

        if (typeof initPlayer === 'function') initPlayer(s);
        if (typeof initChat === 'function') initChat(streamId);
        if (typeof loadStreamControls === 'function') loadStreamControls(streamId);
        if (typeof startCoinHeartbeat === 'function') startCoinHeartbeat(streamId);
        loadStreamGoals(streamId);
        startUptime(s.started_at);
    } catch (e) {
        toast('Stream not found', 'error');
        navigate('/');
    }
}

async function loadStreamGoals(streamId) {
    try {
        const data = await api(`/streams/${streamId}`);
        const s = data.stream || data;
        const goalsResp = await api(`/funds/goals/${s.user_id}`).catch(() => ({ goals: [] }));
        const goals = goalsResp.goals || [];
        const active = goals.find(g => g.is_active);
        if (active) {
            document.getElementById('goal-bar-wrap').style.display = '';
            document.getElementById('goal-label').textContent = active.title;
            const pct = Math.min(100, (active.current_amount / active.target_amount) * 100);
            document.getElementById('goal-fill').style.width = pct + '%';
            document.getElementById('goal-current').textContent = active.current_amount;
            document.getElementById('goal-target').textContent = active.target_amount;
        }
    } catch { /* silent */ }
}

let uptimeInterval = null;
function startUptime(startedAt) {
    clearInterval(uptimeInterval);
    if (!startedAt) return;
    const start = new Date(startedAt.replace(' ', 'T') + 'Z').getTime();
    const update = () => {
        const d = Date.now() - start;
        const h = Math.floor(d / 3600000);
        const m = Math.floor((d % 3600000) / 60000);
        const sec = Math.floor((d % 60000) / 1000);
        const el = document.getElementById('vc-uptime');
        if (el) el.textContent = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };
    update();
    uptimeInterval = setInterval(update, 1000);
}

async function toggleFollow() {
    if (!currentUser) return showModal('login');
    try {
        const data = await api(`/streams/${currentStreamId}/follow`, { method: 'POST' });
        const btn = document.getElementById('btn-follow');
        btn.classList.toggle('following', data.following);
        btn.innerHTML = data.following
            ? '<i class="fa-solid fa-heart-crack"></i> Unfollow'
            : '<i class="fa-solid fa-heart"></i> Follow';
        toast(data.following ? 'Followed!' : 'Unfollowed', 'info');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── VODs Page ────────────────────────────────────────────────── */
async function loadVodsPage() {
    const grid = document.getElementById('vods-grid-page');
    if (!grid) return console.error('[VODs] grid element #vods-grid-page not found');
    grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p>Loading videos...</p></div>';
    try {
        const data = await api('/vods');
        const vods = data.vods || [];
        if (!vods.length) {
            grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-video fa-3x"></i><p>No videos yet</p><p class="muted">Videos are recorded automatically when streamers go live</p></div>';
            return;
        }
        const myId = currentUser ? currentUser.id : null;
        grid.innerHTML = vods.map(v => `
            <div class="stream-card" onclick="navigate('/vod/${v.id}')">
                <div class="stream-card-thumb">
                    ${thumbImg(v.thumbnail_url, 'fa-video', v.title)}
                    ${!v.is_public && v.user_id === myId ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">PRIVATE</span>' : ''}
                    ${v.stream_protocol ? protocolBadge(v.stream_protocol) : ''}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(v.duration_seconds || v.duration)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(v.title || 'VOD')}</div>
                    <div class="stream-card-streamer">
                        <span class="stream-card-avatar">${(v.username || '?')[0].toUpperCase()}</span>
                        ${esc(v.username || 'Unknown')}
                        <span class="stream-card-date">${timeAgo(v.created_at)}</span>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load videos', e);
        grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-triangle-exclamation fa-3x"></i><p>Failed to load videos</p><p class="muted">' + esc(e.message || String(e)) + '</p></div>';
    }
}

/* ── Clips Page ───────────────────────────────────────────────── */
async function loadClipsPage() {
    const grid = document.getElementById('clips-grid-page');
    if (!grid) return console.error('[Clips] grid element not found');
    grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p>Loading clips...</p></div>';
    try {
        const data = await api('/clips');
        const clips = data.clips || [];
        if (!clips.length) {
            grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-scissors fa-3x"></i><p>No public clips yet</p><p class="muted">Viewers can create clips during live streams using the clip button</p></div>';
            return;
        }
        grid.innerHTML = clips.map(cl => `
            <div class="stream-card" onclick="navigate('/clip/${cl.id}')">
                <div class="stream-card-thumb">
                    ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title)}
                    ${cl.stream_protocol ? protocolBadge(cl.stream_protocol) : ''}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Clip')}</div>
                    <div class="stream-card-streamer">
                        <span class="stream-card-avatar">${(cl.username || '?')[0].toUpperCase()}</span>
                        Clipped by ${esc(cl.display_name || cl.username || 'Unknown')}
                        <span class="stream-card-date">${timeAgo(cl.created_at)}</span>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load clips', e);
        grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-triangle-exclamation fa-3x"></i><p>Failed to load clips</p><p class="muted">' + esc(e.message || String(e)) + '</p></div>';
    }
}

/* ── VOD Player ───────────────────────────────────────────────── */
async function loadVodPlayer(vodId) {
    try {
        // Clean up any previous live VOD poll
        if (window._liveVodPollTimer) {
            clearInterval(window._liveVodPollTimer);
            window._liveVodPollTimer = null;
        }
        // Clean up chat replay
        if (window._chatReplayTimer) {
            cancelAnimationFrame(window._chatReplayTimer);
            window._chatReplayTimer = null;
        }
        window._vpChatReplay = null;
        const vpMsgs = document.getElementById('vp-chat-replay-messages');
        if (vpMsgs) vpMsgs.innerHTML = '<div class="chat-replay-empty" id="vp-chat-replay-empty"><i class="fa-solid fa-comments" style="font-size:1.5rem"></i><p>Chat messages will appear here as the video plays</p></div>';
        const vpSidebar = document.getElementById('vp-chat-replay');
        if (vpSidebar) vpSidebar.classList.remove('no-data');

        const data = await api(`/vods/${vodId}`);
        const v = data.vod;
        const clips = data.clips || [];

        // Store for comments
        window._vpVodId = v.id;

        document.getElementById('vp-title').textContent = v.title || 'Video';
        document.getElementById('vp-streamer').textContent = v.display_name || v.username || 'Unknown';
        document.getElementById('vp-avatar').textContent = (v.username || '?')[0].toUpperCase();
        document.getElementById('vp-date').textContent = formatDateTime(v.created_at);
        document.getElementById('vp-duration').textContent = formatDuration(v.duration_seconds || v.duration);
        document.getElementById('vp-views').textContent = `${v.view_count || 0} views`;
        document.getElementById('vp-description').textContent = v.description || '';

        // Protocol badge
        const vpProto = document.getElementById('vp-protocol');
        if (vpProto) vpProto.innerHTML = v.stream_protocol ? protocolBadge(v.stream_protocol) : '';

        // Enhanced details
        const extraDetails = document.getElementById('vp-extra-details');
        if (extraDetails) {
            let chips = '';
            if (v.stream_category) chips += `<span class="detail-chip"><i class="fa-solid fa-tag"></i> ${esc(v.stream_category)}</span>`;
            if (v.stream_peak_viewers) chips += `<span class="detail-chip"><i class="fa-solid fa-users"></i> Peak: ${v.stream_peak_viewers}</span>`;
            if (v.stream_started_at) {
                const streamDate = new Date(v.stream_started_at + 'Z');
                chips += `<span class="detail-chip"><i class="fa-solid fa-calendar"></i> ${streamDate.toLocaleDateString()}</span>`;
            }
            if (chips) { extraDetails.innerHTML = chips; extraDetails.style.display = ''; }
            else extraDetails.style.display = 'none';
        }

        // Handle private VODs
        const video = document.getElementById('vp-video');
        const container = document.getElementById('vp-container');
        const privateNotice = document.getElementById('vp-private-notice');
        const liveIndicator = document.getElementById('vp-live-indicator');
        const jumpLiveBtn = document.getElementById('vp-jump-live');

        if (v.is_private) {
            // Private VOD — show notice instead of video
            video.style.display = 'none';
            if (privateNotice) privateNotice.style.display = '';
            container.querySelector('.video-overlay').style.display = 'none';
        } else if (v.file_path) {
            if (privateNotice) privateNotice.style.display = 'none';
            container.querySelector('.video-overlay').style.display = '';

            // Stream source info
            const vpStream = document.getElementById('vp-stream-source');
            if (vpStream) {
                if (v.is_recording) {
                    vpStream.innerHTML = `<span style="color:#e53e3e;animation:pulse 2s infinite"><i class="fa-solid fa-circle"></i> Recording in progress</span> — VOD is being recorded live`;
                    vpStream.style.display = '';
                } else if (v.stream_title) {
                    vpStream.innerHTML = `<i class="fa-solid fa-tower-broadcast"></i> From stream: <strong>${esc(v.stream_title)}</strong>`;
                    vpStream.style.display = '';
                } else {
                    vpStream.style.display = 'none';
                }
            }

            const filename = v.file_path.split('/').pop();
            video.src = `/api/vods/file/${filename}?t=${Date.now()}`;
            video.style.display = 'block';

            if (v.is_recording) {
                // Live VOD mode
                container.classList.add('vp-live-mode');
                if (liveIndicator) liveIndicator.style.display = '';

                window._liveVodDuration = v.duration_seconds || 0;
                window._liveVodId = v.id;
                window._liveVodFilename = filename;
                window._liveVodIsLive = true;

                if (jumpLiveBtn) {
                    jumpLiveBtn.onclick = () => {
                        video.src = `/api/vods/file/${filename}?t=${Date.now()}`;
                        video.addEventListener('loadedmetadata', function _jumpOnce() {
                            video.removeEventListener('loadedmetadata', _jumpOnce);
                            const dur = isFinite(video.duration) ? video.duration : window._liveVodDuration;
                            if (dur > 2) video.currentTime = dur - 1;
                            video.play().catch(() => {});
                        });
                    };
                }

                window._liveVodSeekableLoaded = false;
                window._liveVodLastSeekableRefresh = 0;

                window._liveVodPollTimer = setInterval(async () => {
                    try {
                        const info = await api(`/vods/${v.id}/live-info`);
                        if (!info.isRecording) {
                            clearInterval(window._liveVodPollTimer);
                            window._liveVodPollTimer = null;
                            window._liveVodIsLive = false;
                            container.classList.remove('vp-live-mode');
                            if (liveIndicator) liveIndicator.style.display = 'none';
                            loadVodPlayer(v.id);
                            return;
                        }
                        window._liveVodDuration = info.duration || 0;

                        if (info.seekable) {
                            const now = Date.now();
                            const shouldRefresh = !window._liveVodSeekableLoaded ||
                                (now - window._liveVodLastSeekableRefresh > 60000);

                            if (shouldRefresh) {
                                window._liveVodSeekableLoaded = true;
                                window._liveVodLastSeekableRefresh = now;
                                const currentTime = video.currentTime;
                                const wasPaused = video.paused;
                                video.src = `/api/vods/file/${filename}?t=${now}`;
                                video.addEventListener('loadedmetadata', function _restore() {
                                    video.removeEventListener('loadedmetadata', _restore);
                                    const dur = isFinite(video.duration) ? video.duration : window._liveVodDuration;
                                    video.currentTime = Math.min(currentTime, dur);
                                    if (!wasPaused) video.play().catch(() => {});
                                });
                            }
                        }

                        document.getElementById('vp-duration').textContent = formatDuration(info.duration);
                    } catch (e) { /* silent */ }
                }, 15000);
            } else {
                // Normal completed VOD
                container.classList.remove('vp-live-mode');
                if (liveIndicator) liveIndicator.style.display = 'none';
                window._liveVodIsLive = false;
            }

            setupCustomVideoControls('vp');

            // Load chat replay data for this VOD
            if (v.stream_id && v.stream_started_at) {
                loadChatReplayData('vp', v.stream_id, v.stream_started_at, v.stream_ended_at);
            }
        }

        // Navigate to streamer on click
        const streamerLink = document.getElementById('vp-streamer-link');
        if (streamerLink && v.username) {
            streamerLink.onclick = () => navigate(`/${v.username}`);
        }

        // Show delete button if user is the VOD owner or admin
        const vpActions = document.getElementById('vp-actions');
        if (vpActions && currentUser) {
            let canDelete = (v.user_id === currentUser.id) || currentUser.capabilities?.moderate_global;
            if (canDelete) {
                vpActions.style.display = '';
                vpActions.innerHTML = `<button class="btn btn-danger btn-small" onclick="deleteVodFromPlayer(${v.id})"><i class="fa-solid fa-trash"></i> Delete Video</button>`;
            } else {
                vpActions.style.display = 'none';
            }
        }

        // Clips for this VOD
        const clipsGrid = document.getElementById('vp-clips-grid');
        if (clips.length) {
            clipsGrid.innerHTML = clips.map(cl => `
                <div class="stream-card" onclick="navigate('/clip/${cl.id}')">
                    <div class="stream-card-thumb">
                        ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title)}
                        <span class="stream-card-viewers">${formatDuration(cl.duration_seconds)}</span>
                    </div>
                    <div class="stream-card-info">
                        <div class="stream-card-title">${esc(cl.title || 'Clip')}</div>
                    </div>
                </div>
            `).join('');
        } else {
            clipsGrid.innerHTML = '<p class="muted">No clips from this stream</p>';
        }

        // Load comments
        loadComments('vod', v.id, 'vp');
    } catch (e) {
        console.error('Failed to load VOD player', e);
        toast('Failed to load video: ' + (e.message || 'not found'), 'error');
        navigate('/vods');
    }
}

/* ── Clip Player ──────────────────────────────────────────────── */
async function loadClipPlayer(clipId) {
    try {
        // Clean up chat replay
        if (window._chatReplayTimer) {
            cancelAnimationFrame(window._chatReplayTimer);
            window._chatReplayTimer = null;
        }
        window._clpChatReplay = null;
        const clpMsgs = document.getElementById('clp-chat-replay-messages');
        if (clpMsgs) clpMsgs.innerHTML = '<div class="chat-replay-empty" id="clp-chat-replay-empty"><i class="fa-solid fa-comments" style="font-size:1.5rem"></i><p>Chat messages will appear here as the clip plays</p></div>';
        const clpSidebar = document.getElementById('clp-chat-replay');
        if (clpSidebar) clpSidebar.classList.remove('no-data');

        const data = await api(`/clips/${clipId}`);
        const cl = data.clip;

        // Store for comments
        window._clpClipId = cl.id;

        document.getElementById('clp-title').textContent = cl.title || 'Clip';
        // Reset unlisted badge
        const unlistedBadge = document.getElementById('clp-unlisted-badge');
        if (unlistedBadge) unlistedBadge.style.display = 'none';
        document.getElementById('clp-streamer').textContent = cl.display_name || cl.username || 'Unknown';
        document.getElementById('clp-avatar').textContent = (cl.username || '?')[0].toUpperCase();
        document.getElementById('clp-date').textContent = formatDateTime(cl.created_at);
        document.getElementById('clp-duration').textContent = formatDuration(cl.duration_seconds);
        document.getElementById('clp-description').textContent = cl.description || '';

        // View count
        const clpViews = document.getElementById('clp-views');
        if (clpViews) clpViews.textContent = `${cl.view_count || 0} views`;

        // Protocol badge
        const clpProto = document.getElementById('clp-protocol');
        if (clpProto) clpProto.innerHTML = cl.stream_protocol ? protocolBadge(cl.stream_protocol) : '';

        // Enhanced details
        const extraDetails = document.getElementById('clp-extra-details');
        if (extraDetails) {
            let chips = '';
            if (cl.stream_category) chips += `<span class="detail-chip"><i class="fa-solid fa-tag"></i> ${esc(cl.stream_category)}</span>`;
            if (cl.stream_peak_viewers) chips += `<span class="detail-chip"><i class="fa-solid fa-users"></i> Peak: ${cl.stream_peak_viewers}</span>`;
            if (cl.stream_started_at) {
                const streamDate = new Date(cl.stream_started_at + 'Z');
                chips += `<span class="detail-chip"><i class="fa-solid fa-calendar"></i> ${streamDate.toLocaleDateString()}</span>`;
            }
            if (chips) { extraDetails.innerHTML = chips; extraDetails.style.display = ''; }
            else extraDetails.style.display = 'none';
        }

        // Stream source + timestamp info
        const clpSource = document.getElementById('clp-stream-source');
        if (clpSource) {
            let sourceHtml = '';
            if (cl.stream_title) {
                const titleText = esc(cl.stream_title);
                if (cl.vod_id) {
                    sourceHtml += `<i class="fa-solid fa-tower-broadcast"></i> From stream: <a href="#" onclick="event.preventDefault();navigate('/vod/${cl.vod_id}')" style="color:var(--accent);text-decoration:none;font-weight:600">${titleText}</a>`;
                } else {
                    sourceHtml += `<i class="fa-solid fa-tower-broadcast"></i> From stream: <strong>${titleText}</strong>`;
                }
                if (cl.start_time > 0) {
                    sourceHtml += ` at <strong>${formatDuration(cl.start_time)}</strong>`;
                }
            } else if (cl.start_time > 0) {
                sourceHtml += `<i class="fa-solid fa-clock"></i> Clipped at <strong>${formatDuration(cl.start_time)}</strong> into the stream`;
            }
            if (sourceHtml) {
                clpSource.innerHTML = sourceHtml;
                clpSource.style.display = '';
            } else {
                clpSource.style.display = 'none';
            }
        }

        const video = document.getElementById('clp-video');
        if (cl.file_path) {
            const filename = cl.file_path.split('/').pop();
            // Handle video load errors (corrupt files, codec issues)
            video.onerror = () => {
                const container = document.getElementById('clp-container');
                if (container) {
                    container.innerHTML = `
                        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;color:var(--text-muted,#999)">
                            <i class="fa-solid fa-triangle-exclamation" style="font-size:3rem;margin-bottom:12px;color:#ef4444"></i>
                            <p style="font-size:1.1rem">This clip could not be played</p>
                            <p class="muted" style="font-size:0.85rem">The recording may be corrupt or in an unsupported format</p>
                        </div>`;
                }
            };
            video.src = `/api/vods/file/${filename}`;
            video.style.display = 'block';
            setupCustomVideoControls('clp');

            // Load chat replay data for this clip
            if (cl.stream_id && cl.stream_started_at) {
                loadChatReplayData('clp', cl.stream_id, cl.stream_started_at, cl.stream_ended_at, cl.start_time, cl.end_time);
            }
        }

        const streamerLink = document.getElementById('clp-streamer-link');
        if (streamerLink && cl.username) {
            streamerLink.onclick = () => navigate(`/${cl.username}`);
        }

        // Show "Clipped by" info
        const clippedByEl = document.getElementById('clp-clipped-by');
        if (clippedByEl) {
            clippedByEl.innerHTML = `<i class="fa-solid fa-scissors"></i> Clipped by <strong>${esc(cl.display_name || cl.username || 'Unknown')}</strong>`;
        }

        // Show delete button if user is clip creator, stream owner, or admin
        const clpActions = document.getElementById('clp-actions');
        if (clpActions && currentUser) {
            let canDelete = (cl.user_id === currentUser.id) || currentUser.capabilities?.moderate_global;
            let isStreamOwner = false;
            // Check if current user owns the stream this clip is from
            if (cl.stream_id) {
                try {
                    const sData = await api(`/streams/${cl.stream_id}`);
                    if (sData.stream && sData.stream.user_id === currentUser.id) {
                        canDelete = true;
                        isStreamOwner = true;
                    }
                } catch {}
            }

            let actionsHtml = '';
            // Edit title — clip creator or admin
            if (cl.user_id === currentUser.id || currentUser.capabilities?.moderate_global) {
                actionsHtml += `<button class="btn btn-small" onclick="editClipTitle(${cl.id})"><i class="fa-solid fa-pen"></i> Edit Title</button> `;
            }
            // Publish/unpublish toggle — only for stream owner or admin
            if (isStreamOwner || currentUser.capabilities?.moderate_global) {
                if (cl.is_public) {
                    actionsHtml += `<button class="btn btn-small" onclick="toggleClipVisibility(${cl.id}, false)"><i class="fa-solid fa-eye-slash"></i> Make Unlisted</button>`;
                } else {
                    actionsHtml += `<button class="btn btn-primary btn-small" onclick="toggleClipVisibility(${cl.id}, true)"><i class="fa-solid fa-eye"></i> Make Public</button>`;
                }
            }
            // Unlisted badge for non-public clips
            if (!cl.is_public) {
                const badge = document.getElementById('clp-unlisted-badge');
                if (badge) badge.style.display = '';
            }
            if (canDelete) {
                actionsHtml += ` <button class="btn btn-danger btn-small" onclick="deleteClipFromPlayer(${cl.id})"><i class="fa-solid fa-trash"></i> Delete Clip</button>`;
            }
            if (actionsHtml) {
                clpActions.style.display = '';
                clpActions.innerHTML = actionsHtml;
            }
        }

        // Load comments
        loadComments('clip', cl.id, 'clp');
    } catch (e) {
        toast('Clip not found', 'error');
        navigate('/clips');
    }
}

/* ── Profile (legacy, redirects to channel) ───────────────────── */
async function loadProfile(username) {
    username = username || (currentUser && currentUser.username);
    if (!username) return navigate('/');
    navigate(`/${username}`, true);
}

/* ═══════════════════════════════════════════════════════════════
   Chat Replay System
   Syncs stored chat messages with VOD/clip video playback
   Sidebar always visible — shows empty state or synced messages
   ═══════════════════════════════════════════════════════════════ */

/**
 * Load chat messages for replay and set up sync with video.
 * @param {string} prefix - 'vp' or 'clp'
 * @param {number} streamId - stream the messages belong to
 * @param {string} streamStartedAt - ISO timestamp of stream start
 * @param {string} streamEndedAt - ISO timestamp of stream end (optional)
 * @param {number} clipStartOffset - for clips, seconds into the stream the clip starts
 * @param {number} clipEndOffset - for clips, seconds into the stream the clip ends
 */
async function loadChatReplayData(prefix, streamId, streamStartedAt, streamEndedAt, clipStartOffset, clipEndOffset) {
    const sidebar = document.getElementById(`${prefix}-chat-replay`);
    const emptyEl = document.getElementById(`${prefix}-chat-replay-empty`);
    const container = document.getElementById(`${prefix}-chat-replay-messages`);

    try {
        // For clips, narrow the fetch window to just the clip's time range (+ small buffer)
        const params = new URLSearchParams();
        const streamStartMs = new Date(streamStartedAt + (streamStartedAt.endsWith('Z') ? '' : 'Z')).getTime();
        if (clipStartOffset && streamStartMs) {
            // Fetch from 5s before clip start to clip end
            const clipFromMs = streamStartMs + Math.max(0, (clipStartOffset - 5)) * 1000;
            const clipToMs = streamStartMs + (clipEndOffset || clipStartOffset + 300) * 1000;
            // Format as 'YYYY-MM-DD HH:MM:SS' to match SQLite CURRENT_TIMESTAMP format
            const toSqlite = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
            params.set('from', toSqlite(clipFromMs));
            params.set('to', toSqlite(clipToMs));
        } else {
            if (streamStartedAt) params.set('from', streamStartedAt);
            if (streamEndedAt) params.set('to', streamEndedAt);
        }

        const data = await api(`/chat/${streamId}/replay?${params.toString()}`);
        const messages = data.messages || [];

        if (!messages.length) {
            // No chat data — show empty state with "no data" indicator
            if (sidebar) sidebar.classList.add('no-data');
            if (emptyEl) emptyEl.innerHTML = '<i class="fa-solid fa-comment-slash" style="font-size:1.5rem"></i><p>No chat messages were recorded for this stream</p>';
            return;
        }

        // Has data — clear empty state, prep for sync
        if (sidebar) sidebar.classList.remove('no-data');
        if (emptyEl) emptyEl.remove();

        // Store replay data on window for sync
        const streamStart = new Date(streamStartedAt + (streamStartedAt.endsWith('Z') ? '' : 'Z')).getTime();
        window[`_${prefix}ChatReplay`] = {
            messages,
            streamStart,
            clipStartOffset: clipStartOffset || 0,
            lastIndex: 0,
        };

        // Start sync loop
        startChatReplaySync(prefix);
    } catch (e) {
        console.warn('Failed to load chat replay:', e.message);
        if (sidebar) sidebar.classList.add('no-data');
        if (emptyEl) emptyEl.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="font-size:1.5rem"></i><p>Failed to load chat replay</p>';
    }
}

function startChatReplaySync(prefix) {
    const video = document.getElementById(`${prefix}-video`);
    const container = document.getElementById(`${prefix}-chat-replay-messages`);
    if (!video || !container) return;

    function syncFrame() {
        const replay = window[`_${prefix}ChatReplay`];
        if (!replay) return;

        const currentTime = video.currentTime; // seconds into the video
        // For clips, add the clip's start offset to get stream-relative time
        const streamRelativeSeconds = currentTime + replay.clipStartOffset;
        const currentMs = replay.streamStart + (streamRelativeSeconds * 1000);

        // Find messages up to current time
        let newMessages = false;
        while (replay.lastIndex < replay.messages.length) {
            const msg = replay.messages[replay.lastIndex];
            const msgTime = new Date(msg.timestamp + (msg.timestamp.endsWith('Z') ? '' : 'Z')).getTime();

            if (msgTime <= currentMs) {
                appendChatReplayMessage(container, msg, streamRelativeSeconds, replay.streamStart, replay.clipStartOffset);
                replay.lastIndex++;
                newMessages = true;
            } else {
                break;
            }
        }

        // If user seeked backward, reset and re-render up to current time
        if (replay.lastIndex > 0) {
            const lastMsg = replay.messages[replay.lastIndex - 1];
            const lastMsgTime = new Date(lastMsg.timestamp + (lastMsg.timestamp.endsWith('Z') ? '' : 'Z')).getTime();
            if (currentMs < lastMsgTime - 2000) {
                replay.lastIndex = 0;
                container.innerHTML = '';
            }
        }

        if (newMessages) {
            container.scrollTop = container.scrollHeight;
        }

        window._chatReplayTimer = requestAnimationFrame(syncFrame);
    }

    // Clear previous
    if (window._chatReplayTimer) cancelAnimationFrame(window._chatReplayTimer);
    window._chatReplayTimer = requestAnimationFrame(syncFrame);
}

function appendChatReplayMessage(container, msg, streamSeconds, streamStart, clipStartOffset) {
    const div = document.createElement('div');
    div.className = 'chat-replay-msg';

    // Calculate relative time — clip-relative if viewing a clip, stream-relative otherwise
    const msgTime = new Date(msg.timestamp + (msg.timestamp.endsWith('Z') ? '' : 'Z')).getTime();
    const streamRelSecs = (msgTime - streamStart) / 1000;
    const relSecs = Math.max(0, Math.floor(clipStartOffset ? streamRelSecs - clipStartOffset : streamRelSecs));
    const timeStr = formatDuration(relSecs);

    const color = msg.profile_color || '#c0965c';
    const name = msg.display_name || msg.username || msg.anon_id || 'Anonymous';

    div.innerHTML = `<span class="cr-time">${timeStr}</span><span class="cr-user" style="color:${esc(color)}">${esc(name)}</span><span class="cr-text">${esc(msg.message)}</span>`;
    container.appendChild(div);

    // Keep max 300 messages in DOM for performance
    while (container.children.length > 300) {
        container.removeChild(container.firstChild);
    }
}

/* ═══════════════════════════════════════════════════════════════
   Comments System (YouTube-style)
   ═══════════════════════════════════════════════════════════════ */

async function loadComments(contentType, contentId, prefix) {
    const countEl = document.getElementById(`${prefix}-comment-count`);
    const listEl = document.getElementById(`${prefix}-comments-list`);
    const formEl = document.getElementById(`${prefix}-comment-form`);

    // Show comment form if logged in
    if (formEl) formEl.style.display = currentUser ? '' : 'none';

    try {
        const data = await api(`/comments/${contentType}/${contentId}`);
        const comments = data.comments || [];
        const total = data.total || 0;

        if (countEl) countEl.textContent = total > 0 ? `(${total})` : '';

        if (!comments.length) {
            listEl.innerHTML = '<div class="comments-empty"><i class="fa-solid fa-comment-dots" style="font-size:1.5rem;margin-bottom:8px"></i><p>No comments yet. Be the first!</p></div>';
            return;
        }

        listEl.innerHTML = comments.map(c => renderComment(c, contentType, contentId)).join('');
    } catch (e) {
        listEl.innerHTML = '<p class="muted">Failed to load comments</p>';
    }
}

function renderComment(c, contentType, contentId) {
    const initial = (c.username || '?')[0].toUpperCase();
    const color = c.profile_color || '#c0965c';
    const name = c.display_name || c.username || 'Unknown';
    const isOwn = currentUser && (c.user_id === currentUser.id);
    const isAdmin = currentUser && currentUser.capabilities?.moderate_global;
    const edited = c.updated_at && c.updated_at !== c.created_at;

    let actionsHtml = '';
    if (currentUser) {
        actionsHtml += `<button onclick="showReplyForm(${c.id}, '${contentType}', ${contentId})"><i class="fa-solid fa-reply"></i> Reply</button>`;
    }
    if (isOwn || isAdmin) {
        actionsHtml += `<button onclick="editComment(${c.id}, '${contentType}', ${contentId})"><i class="fa-solid fa-pen"></i> Edit</button>`;
        actionsHtml += `<button onclick="deleteCommentAction(${c.id}, '${contentType}', ${contentId})"><i class="fa-solid fa-trash"></i> Delete</button>`;
    }

    let repliesHtml = '';
    if (c.replies && c.replies.length) {
        repliesHtml = `<div class="comment-replies">${c.replies.map(r => renderComment(r, contentType, contentId)).join('')}</div>`;
    }

    return `
        <div class="comment-item" id="comment-${c.id}">
            <div class="comment-avatar" style="background:${esc(color)}">${initial}</div>
            <div class="comment-body">
                <div class="comment-meta">
                    <span class="comment-author" style="color:${esc(color)}">${esc(name)}</span>
                    <span class="comment-date">${timeAgo(c.created_at)}${edited ? ' (edited)' : ''}</span>
                    ${c.role === 'admin' ? '<span class="badge" style="font-size:0.7rem;padding:1px 5px">ADMIN</span>' : ''}
                </div>
                <div class="comment-text">${esc(c.message)}</div>
                <div class="comment-actions">${actionsHtml}</div>
                <div id="reply-form-${c.id}"></div>
                ${repliesHtml}
            </div>
        </div>`;
}

async function postComment(contentType, contentId) {
    const prefix = contentType === 'vod' ? 'vp' : 'clp';
    const input = document.getElementById(`${prefix}-comment-input`);
    if (!input) return;

    const message = input.value.trim();
    if (!message) return toast('Write a comment first', 'error');

    try {
        await api(`/comments/${contentType}/${contentId}`, {
            method: 'POST',
            body: { message },
        });
        input.value = '';
        toast('Comment posted', 'success');
        loadComments(contentType, contentId, prefix);
    } catch (e) {
        toast(e.message || 'Failed to post comment', 'error');
    }
}

function showReplyForm(parentId, contentType, contentId) {
    const existing = document.getElementById(`reply-form-${parentId}`);
    if (!existing) return;

    // Toggle off if already visible
    if (existing.innerHTML) {
        existing.innerHTML = '';
        return;
    }

    existing.innerHTML = `
        <div class="reply-form">
            <input type="text" id="reply-input-${parentId}" placeholder="Write a reply..." maxlength="2000"
                   onkeydown="if(event.key==='Enter')postReply(${parentId}, '${contentType}', ${contentId})">
            <button class="btn btn-small btn-primary" onclick="postReply(${parentId}, '${contentType}', ${contentId})">Reply</button>
        </div>`;
    document.getElementById(`reply-input-${parentId}`)?.focus();
}

async function postReply(parentId, contentType, contentId) {
    const input = document.getElementById(`reply-input-${parentId}`);
    if (!input) return;

    const message = input.value.trim();
    if (!message) return;

    try {
        await api(`/comments/${contentType}/${contentId}`, {
            method: 'POST',
            body: { message, parent_id: parentId },
        });
        toast('Reply posted', 'success');
        const prefix = contentType === 'vod' ? 'vp' : 'clp';
        loadComments(contentType, contentId, prefix);
    } catch (e) {
        toast(e.message || 'Failed to post reply', 'error');
    }
}

async function editComment(commentId, contentType, contentId) {
    const commentEl = document.getElementById(`comment-${commentId}`);
    if (!commentEl) return;
    const textEl = commentEl.querySelector('.comment-text');
    if (!textEl) return;

    const currentText = textEl.textContent;
    const newText = prompt('Edit comment:', currentText);
    if (newText === null || newText.trim() === currentText) return;

    try {
        await api(`/comments/${commentId}`, {
            method: 'PUT',
            body: { message: newText.trim() },
        });
        toast('Comment updated', 'success');
        const prefix = contentType === 'vod' ? 'vp' : 'clp';
        loadComments(contentType, contentId, prefix);
    } catch (e) {
        toast(e.message || 'Failed to update comment', 'error');
    }
}

async function deleteCommentAction(commentId, contentType, contentId) {
    if (!confirm('Delete this comment?')) return;

    try {
        await api(`/comments/${commentId}`, { method: 'DELETE' });
        toast('Comment deleted', 'success');
        const prefix = contentType === 'vod' ? 'vp' : 'clp';
        loadComments(contentType, contentId, prefix);
    } catch (e) {
        toast(e.message || 'Failed to delete comment', 'error');
    }
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return date.toLocaleDateString();
}

/* ── Utility ──────────────────────────────────────────────────── */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML.replace(/'/g, '&#39;');
}

/**
 * Escape a string for safe interpolation inside a JS string literal
 * within an HTML attribute (e.g. onclick="fn('${escJs(val)}')" ).
 * Escapes backslash, single/double quotes, backticks, and angle brackets.
 */
function escJs(str) {
    return String(str ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")  
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/</g, '\\x3c')
        .replace(/>/g, '\\x3e');
}

/**
 * Universal thumbnail HTML helper.
 * Returns an <img> tag if a thumbnail URL exists, or a fallback icon.
 * @param {string|null} thumbnailUrl - the thumbnail_url from the DB record
 * @param {string} fallbackIcon - Font Awesome icon class (e.g. 'fa-video')
 * @param {string} [alt] - alt text for the image
 * @returns {string} HTML string
 */
function thumbImg(thumbnailUrl, fallbackIcon, alt) {
    if (thumbnailUrl) {
        return `<img src="${esc(thumbnailUrl)}" alt="${esc(alt || '')}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display=''">
                <i class="fa-solid ${fallbackIcon}" style="display:none"></i>`;
    }
    return `<i class="fa-solid ${fallbackIcon}"></i>`;
}

function formatDuration(secs) {
    if (!secs) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    let raw = dateStr;
    if (typeof raw === 'string' && !raw.includes('T')) raw = raw.replace(' ', 'T') + 'Z';
    const d = new Date(raw);
    if (isNaN(d)) return dateStr;
    const diff = Date.now() - d.getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
}

function formatDateTime(dateStr) {
    if (!dateStr) return '';
    let raw = dateStr;
    if (typeof raw === 'string' && !raw.includes('T')) raw = raw.replace(' ', 'T') + 'Z';
    const d = new Date(raw);
    if (isNaN(d)) return dateStr;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function switchVodTab(tab) {
    document.querySelectorAll('#vod-section .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

/* ── Modal template stubs (filled by their modules) ──────────── */
function streamKeyModal() {
    return `
        <h3><i class="fa-solid fa-key"></i> Stream Key</h3>
        <p class="muted" style="margin-bottom:12px">Keep this secret! Anyone with your key can stream on your channel.</p>
        <div class="key-display">
            <input type="password" id="modal-key-val" readonly class="form-input" value="Loading...">
            <button class="btn btn-small" onclick="toggleModalKeyVis()"><i class="fa-solid fa-eye"></i></button>
            <button class="btn btn-small" onclick="copyModalKey()"><i class="fa-solid fa-copy"></i></button>
        </div>
        <button class="btn btn-outline" onclick="doRegenerateKey()" style="margin-top:12px">
            <i class="fa-solid fa-rotate"></i> Regenerate
        </button>`;
}
function addControlModal() {
    return `
        <h3><i class="fa-solid fa-gamepad"></i> Add Control</h3>
        <div class="form-group">
            <label>Command</label>
            <input type="text" id="modal-ctrl-cmd" class="form-input" placeholder="e.g. forward">
        </div>
        <div class="form-group">
            <label>Label</label>
            <input type="text" id="modal-ctrl-label" class="form-input" placeholder="e.g. Forward">
        </div>
        <div class="form-group">
            <label>Icon (FontAwesome class)</label>
            <input type="text" id="modal-ctrl-icon" class="form-input" placeholder="e.g. fa-arrow-up" value="fa-circle">
        </div>
        <div class="form-group">
            <label>Cooldown (seconds)</label>
            <input type="number" id="modal-ctrl-cooldown" class="form-input" value="1" min="0">
        </div>
        <button class="btn btn-primary btn-lg" onclick="doAddControl()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-plus"></i> Add Control
        </button>`;
}
function addGoalModal() {
    return `
        <h3><i class="fa-solid fa-bullseye"></i> Add Donation Goal</h3>
        <div class="form-group">
            <label>Goal Title</label>
            <input type="text" id="modal-goal-title" class="form-input" placeholder="e.g. New tent!">
        </div>
        <div class="form-group">
            <label>Target (Hobo Bucks)</label>
            <input type="number" id="modal-goal-target" class="form-input" placeholder="5000" min="1">
        </div>
        <button class="btn btn-primary btn-lg" onclick="doAddGoal()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-plus"></i> Create Goal
        </button>`;
}

/* Stream key modal helpers */
async function loadStreamKeyModal() {
    try {
        const data = await api('/auth/stream-key');
        const el = document.getElementById('modal-key-val');
        if (el) el.value = data.streamKey || data.stream_key || '';
    } catch { /* silent */ }
}
function toggleModalKeyVis() {
    const el = document.getElementById('modal-key-val');
    el.type = el.type === 'password' ? 'text' : 'password';
}
function copyModalKey() {
    const v = document.getElementById('modal-key-val').value;
    navigator.clipboard.writeText(v).then(() => toast('Copied!', 'success'));
}
async function doRegenerateKey() {
    try {
        const data = await api('/auth/stream-key/regenerate', { method: 'POST' });
        document.getElementById('modal-key-val').value = data.streamKey || data.stream_key || '';
        toast('Key regenerated', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Delete VOD / Clip from player pages ──────────────────────── */
async function deleteVodFromPlayer(vodId) {
    if (!confirm('Delete this video permanently?')) return;
    try {
        await api(`/vods/${vodId}`, { method: 'DELETE' });
        toast('Video deleted', 'success');
        navigate('/vods');
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
}

async function editClipTitle(clipId) {
    const newTitle = prompt('Enter new clip title:');
    if (newTitle === null) return; // cancelled
    if (!newTitle.trim()) { toast('Title cannot be empty', 'error'); return; }
    try {
        await api(`/clips/${clipId}/title`, {
            method: 'PUT',
            body: { title: newTitle.trim() }
        });
        toast('Title updated', 'success');
        loadClipPlayer(clipId); // refresh the page
    } catch (e) { toast(e.message || 'Failed to update title', 'error'); }
}

async function deleteClipFromPlayer(clipId) {
    if (!confirm('Delete this clip permanently?')) return;
    try {
        await api(`/clips/${clipId}`, { method: 'DELETE' });
        toast('Clip deleted', 'success');
        navigate('/clips');
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
}

async function toggleClipVisibility(clipId, makePublic) {
    try {
        const data = await api(`/clips/${clipId}/visibility`, {
            method: 'PUT',
            body: { is_public: makePublic }
        });
        toast(data.message || (makePublic ? 'Clip is now public' : 'Clip is now unlisted'), 'success');
        loadClipPlayer(clipId); // refresh the page
    } catch (e) { toast(e.message || 'Failed to update visibility', 'error'); }
}

/* ── Init ─────────────────────────────────────────────────────── */
/* ── Custom VOD / Clip Player Controls ────────────────────────── */
/**
 * Set up themed custom controls for a <video> element.
 * @param {string} prefix - Element ID prefix ('vp' for VOD, 'clp' for clip)
 */
function setupCustomVideoControls(prefix) {
    const video = document.getElementById(`${prefix}-video`);
    const container = document.getElementById(`${prefix}-container`);
    const btnPlay = document.getElementById(`${prefix}-btn-play`);
    const btnVol = document.getElementById(`${prefix}-btn-vol`);
    const volSlider = document.getElementById(`${prefix}-vol-slider`);
    const timeDisplay = document.getElementById(`${prefix}-time`);
    const btnSpeed = document.getElementById(`${prefix}-btn-speed`);
    const btnFullscreen = document.getElementById(`${prefix}-btn-fullscreen`);
    const progressWrap = document.getElementById(`${prefix}-progress-wrap`);
    const progressFill = document.getElementById(`${prefix}-progress-fill`);
    const progressBuffer = document.getElementById(`${prefix}-progress-buffer`);

    if (!video || !container) return;

    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
    let speedIdx = 3; // 1x
    let _rafId = null;

    function fmtTime(s) {
        if (!s || isNaN(s) || !isFinite(s)) return '0:00';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
            : `${m}:${String(sec).padStart(2, '0')}`;
    }

    /** Get effective duration — uses server-reported duration as fallback for live VODs */
    function getEffectiveDuration() {
        if (video.duration && isFinite(video.duration) && video.duration > 0) return video.duration;
        if (window._liveVodIsLive && window._liveVodDuration > 0) return window._liveVodDuration;
        return 0;
    }

    function updateProgress() {
        const dur = getEffectiveDuration();
        if (dur > 0) {
            const pct = (video.currentTime / dur) * 100;
            progressFill.style.width = Math.min(pct, 100) + '%';
            if (window._liveVodIsLive) {
                timeDisplay.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur)} [LIVE]`;
            } else {
                timeDisplay.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur)}`;
            }
        }
        // Update buffer bar
        if (video.buffered.length > 0) {
            const dur2 = getEffectiveDuration();
            if (dur2 > 0) {
                const buffEnd = video.buffered.end(video.buffered.length - 1);
                progressBuffer.style.width = (buffEnd / dur2) * 100 + '%';
            }
        }
        if (!video.paused) _rafId = requestAnimationFrame(updateProgress);
    }

    // Play / Pause
    btnPlay.onclick = () => {
        if (video.paused) { video.play().catch(() => {}); } else { video.pause(); }
    };
    video.addEventListener('play', () => {
        btnPlay.innerHTML = '<i class="fa-solid fa-pause"></i>';
        container.classList.remove('paused');
        _rafId = requestAnimationFrame(updateProgress);
    });
    video.addEventListener('pause', () => {
        btnPlay.innerHTML = '<i class="fa-solid fa-play"></i>';
        container.classList.add('paused');
        if (_rafId) cancelAnimationFrame(_rafId);
    });
    video.addEventListener('ended', () => {
        btnPlay.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';
        container.classList.add('paused');
    });

    // Click on video to toggle play
    video.addEventListener('click', () => {
        if (video.paused) { video.play().catch(() => {}); } else { video.pause(); }
    });

    // Double-click for fullscreen
    video.addEventListener('dblclick', () => {
        if (document.fullscreenElement) { document.exitFullscreen(); }
        else { container.requestFullscreen().catch(() => {}); }
    });

    // Volume
    btnVol.onclick = () => {
        video.muted = !video.muted;
        btnVol.innerHTML = video.muted
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
        volSlider.value = video.muted ? 0 : video.volume * 100;
    };
    volSlider.oninput = () => {
        const v = volSlider.value / 100;
        video.volume = v;
        video.muted = v === 0;
        btnVol.innerHTML = v === 0
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : v < 0.5 ? '<i class="fa-solid fa-volume-low"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
    };

    // Progress seek
    progressWrap.onclick = (e) => {
        const rect = progressWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dur = getEffectiveDuration();
        if (dur > 0) video.currentTime = pct * dur;
    };
    // Drag seek
    let _seeking = false;
    progressWrap.addEventListener('mousedown', (e) => {
        _seeking = true;
        const rect = progressWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dur = getEffectiveDuration();
        if (dur > 0) video.currentTime = pct * dur;
    });
    document.addEventListener('mousemove', (e) => {
        if (!_seeking) return;
        const rect = progressWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dur = getEffectiveDuration();
        if (dur > 0) {
            video.currentTime = pct * dur;
            progressFill.style.width = pct * 100 + '%';
        }
    });
    document.addEventListener('mouseup', () => { _seeking = false; });

    // Speed
    btnSpeed.onclick = () => {
        speedIdx = (speedIdx + 1) % speeds.length;
        video.playbackRate = speeds[speedIdx];
        btnSpeed.textContent = speeds[speedIdx] + 'x';
    };

    // Fullscreen
    btnFullscreen.onclick = () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            container.requestFullscreen().catch(() => {});
        }
    };
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement === container) {
            btnFullscreen.innerHTML = '<i class="fa-solid fa-compress"></i>';
        } else {
            btnFullscreen.innerHTML = '<i class="fa-solid fa-expand"></i>';
        }
    });

    // Keyboard shortcuts when container/video focused
    container.tabIndex = 0;
    container.addEventListener('keydown', (e) => {
        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                if (video.paused) video.play().catch(() => {}); else video.pause();
                break;
            case 'ArrowLeft':
                e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); break;
            case 'ArrowRight':
                e.preventDefault(); video.currentTime = Math.min(getEffectiveDuration() || 0, video.currentTime + 5); break;
            case 'ArrowUp':
                e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1);
                volSlider.value = video.volume * 100; break;
            case 'ArrowDown':
                e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1);
                volSlider.value = video.volume * 100; break;
            case 'f':
                e.preventDefault();
                if (document.fullscreenElement) document.exitFullscreen();
                else container.requestFullscreen().catch(() => {});
                break;
            case 'm':
                e.preventDefault();
                video.muted = !video.muted;
                btnVol.innerHTML = video.muted
                    ? '<i class="fa-solid fa-volume-xmark"></i>'
                    : '<i class="fa-solid fa-volume-high"></i>';
                volSlider.value = video.muted ? 0 : video.volume * 100;
                break;
        }
    });

    // Metadata loaded — update time
    video.addEventListener('loadedmetadata', () => {
        const dur = getEffectiveDuration();
        timeDisplay.textContent = `0:00 / ${fmtTime(dur)}`;
    });
    video.addEventListener('timeupdate', updateProgress);
}

let _userLoaded = false;

/* ── Updates / Changelog Page ─────────────────────────────────── */
async function loadUpdatesPage() {
    const container = document.getElementById('updates-list');
    if (!container) return;
    container.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';

    try {
        const data = await api('/api/updates?limit=50');
        if (!data.commits || data.commits.length === 0) {
            container.innerHTML = '<p style="opacity:0.6;text-align:center;padding:32px 0;">No updates found.</p>';
            return;
        }

        // Group commits by date
        const groups = {};
        for (const c of data.commits) {
            const day = new Date(c.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            if (!groups[day]) groups[day] = [];
            groups[day].push(c);
        }

        let html = '';
        for (const [day, commits] of Object.entries(groups)) {
            html += `<div class="updates-day">
                <h3 class="updates-day-header">${esc(day)}</h3>
                <div class="updates-day-commits">`;
            for (const c of commits) {
                const time = new Date(c.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                html += `<div class="update-entry">
                    <a class="update-hash" href="https://github.com/HoboStreamer/HoboStreamer.com/commit/${c.hash}" target="_blank" title="View on GitHub">${esc(c.short)}</a>
                    <span class="update-subject">${esc(c.subject)}</span>
                    <span class="update-meta">${esc(c.author)} &middot; ${esc(time)}</span>
                </div>`;
            }
            html += '</div></div>';
        }
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<p style="color:var(--error);text-align:center;padding:32px 0;">Failed to load updates.</p>`;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadUser();
    _userLoaded = true;
    onAuthChange();

    // Load theme from server if logged in (localStorage already applied instantly)
    if (currentUser && typeof loadThemeFromServer === 'function') {
        loadThemeFromServer();
    }

    // Route from current URL instead of always going home
    routeFromURL();
});

// Handle browser back/forward — wait for auth to be resolved first
window.addEventListener('popstate', () => {
    if (_userLoaded) {
        routeFromURL();
    }
    // If auth hasn't loaded yet, DOMContentLoaded handler will call routeFromURL()
});

// Intercept link clicks to use SPA navigation
document.addEventListener('click', (e) => {
    // Close user dropdown
    if (!e.target.closest('.nav-avatar-wrap') && !e.target.closest('.user-dropdown')) {
        document.getElementById('user-dropdown')?.classList.remove('show');
    }

    if (!e.target.closest('.nav-links') && !e.target.closest('.nav-hamburger')) {
        closeMobileNav();
    }
});
