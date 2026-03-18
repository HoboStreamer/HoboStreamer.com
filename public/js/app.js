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

/* ── Capability helpers ────────────────────────────────────── */
function mergeUserWithCapabilities(user, capabilities) {
    if (!user) return null;
    return { ...user, capabilities: capabilities || user.capabilities || {} };
}

function getUserCapabilities(user = currentUser) {
    return user?.capabilities || {};
}

function hasCapability(capability, user = currentUser) {
    return !!getUserCapabilities(user)?.[capability];
}

function isStaffUser(user = currentUser) {
    return hasCapability('can_access_staff_console', user);
}

// Reserved paths (not usernames)
const RESERVED = new Set(['vods', 'clips', 'vod', 'clip', 'dashboard', 'settings', 'broadcast', 'admin', 'themes', 'game', 'canvas', 'chat', 'api', 'ws', 'media', 'pastes', 'p', 'updates']);

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
            <h3><i class="fa-solid fa-right-to-bracket"></i> Sign In</h3>
            <p style="color:var(--text-muted);margin-bottom:16px">Sign in with your Hobo Network account to continue.</p>
            <a href="/api/auth/sso/login" class="btn btn-lg" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#c0965c,#a07840);color:#fff;text-decoration:none;border:none;cursor:pointer">
                <i class="fa-solid fa-network-wired"></i> Sign in with Hobo Network
            </a>
            <p style="text-align:center;margin-top:12px;font-size:12px;color:var(--text-muted)">Don't have an account? One will be created when you sign in.</p>`,
        register: `
            <h3><i class="fa-solid fa-user-plus"></i> Sign Up</h3>
            <p style="color:var(--text-muted);margin-bottom:16px">Create your account on the Hobo Network.</p>
            <a href="/api/auth/sso/login" class="btn btn-lg" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#c0965c,#a07840);color:#fff;text-decoration:none;border:none;cursor:pointer">
                <i class="fa-solid fa-network-wired"></i> Sign in with Hobo Network
            </a>
            <p style="text-align:center;margin-top:12px;font-size:12px;color:var(--text-muted)">Registration is handled on hobo.tools</p>`,
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
// Local login/register removed — all auth goes through Hobo Network SSO
function doLogin() { window.location.href = '/api/auth/sso/login'; }
function doRegister() { window.location.href = '/api/auth/sso/login'; }

function logout() {
    localStorage.removeItem('token');
    currentUser = null;
    onAuthChange();
    if (typeof destroyCall === 'function') destroyCall();
    if (typeof destroyCanvasPage === 'function') destroyCanvasPage();
    // Clear notification bell
    if (window.HoboNotifications) HoboNotifications.setToken(null);
    const bellMount = document.getElementById('hobo-bell-mount');
    if (bellMount) bellMount.innerHTML = '';
    if (['dashboard', 'admin', 'broadcast', 'settings'].includes(currentPage)) navigate('/');
    toast('Logged out', 'info');
}

async function loadUser() {
    const tok = localStorage.getItem('token');
    if (!tok) return;
    try {
        const data = await api('/auth/me');
        currentUser = mergeUserWithCapabilities(data.user || data, data.capabilities);
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
        admin.style.display = (currentUser.capabilities?.admin_panel || hasCapability('can_access_staff_console')) ? '' : 'none';
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

    // Sync canvas auth state if canvas page is loaded
    if (typeof syncCanvasAuthState === 'function') syncCanvasAuthState();

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
    if (typeof destroyCanvasPage === 'function') destroyCanvasPage();
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
        window.location.href = 'https://hobo.tools/admin';
        return;
    } else if (segments[0] === 'themes') {
        showPage('themes');
        loadThemesPage();
    } else if (segments[0] === 'chat') {
        showPage('chat');
        loadChatPage();
    } else if (segments[0] === 'game') {
        window.location.href = 'https://hobo.quest/game';
        return;
    } else if (segments[0] === 'canvas') {
        window.location.href = 'https://hobo.quest/canvas';
        return;
    } else if (segments[0] === 'pastes') {
        showPage('pastes');
        loadPastesPage();
        // Handle ?edit=slug
        const editSlug = new URLSearchParams(window.location.search).get('edit');
        if (editSlug) {
            api(`/pastes/${editSlug}`).then(data => {
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
        // Channel page: /:username?stream=ID
        showPage('channel');
        const streamParam = new URLSearchParams(window.location.search).get('stream');
        loadChannelPage(segments[0], streamParam ? parseInt(streamParam) : null);
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

    // Game/Canvas: hide footer only, keep navbar visible; other pages restore both
    const navbar = document.querySelector('.navbar');
    const footer = document.querySelector('.footer');
    if (page === 'game' || page === 'canvas') {
        if (footer) footer.style.display = 'none';
        document.body.style.overflow = 'hidden';
    } else {
        if (navbar) navbar.style.display = '';
        if (footer) footer.style.display = '';
        document.body.style.overflow = '';
    }

    // Highlight nav link
    const pageToNav = { home: 'home', vods: 'vods', clips: 'clips', broadcast: 'broadcast', dashboard: 'dashboard', admin: 'admin', chat: 'chat', game: 'game', canvas: 'game', pastes: 'pastes', 'paste-viewer': 'pastes' };
    const navPage = pageToNav[page];
    if (navPage) {
        const link = document.querySelector(`.nav-link[data-page="${navPage}"]`);
        if (link) link.classList.add('active');
    }
}

/* ── Nav Dropdown Helpers ──────────────────────────────────────── */
function toggleNavDropdown(id) {
    const dd = document.getElementById(id);
    if (!dd) return;
    const wasOpen = dd.classList.contains('open');
    closeNavDropdowns();
    if (!wasOpen) dd.classList.add('open');
}

function closeNavDropdowns() {
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
}

// Close nav dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-dropdown')) closeNavDropdowns();
});

/* ── Nav Scroll Overflow Detection ─────────────────────────────── */
function checkNavOverflow() {
    const nl = document.querySelector('.nav-links');
    if (!nl) return;
    const hasOverflow = nl.scrollWidth > nl.clientWidth + 2;
    const left = document.getElementById('nav-scroll-left');
    const right = document.getElementById('nav-scroll-right');
    const atStart = nl.scrollLeft <= 1;
    const atEnd = nl.scrollLeft >= nl.scrollWidth - nl.clientWidth - 1;
    if (left) left.classList.toggle('visible', hasOverflow && !atStart);
    if (right) right.classList.toggle('visible', hasOverflow && !atEnd);
}

function scrollNavLinks(dir) {
    const nl = document.querySelector('.nav-links');
    if (!nl) return;
    nl.scrollBy({ left: dir * 160, behavior: 'smooth' });
    // Poll until scroll settles (smooth scroll can take 300-600ms)
    let checks = 0;
    let lastPos = nl.scrollLeft;
    const poll = setInterval(() => {
        checkNavOverflow();
        if (nl.scrollLeft === lastPos || ++checks > 12) clearInterval(poll);
        lastPos = nl.scrollLeft;
    }, 60);
}

// Position fixed dropdown menus below their triggers
function positionNavDropdownMenu(dropdown) {
    const menu = dropdown?.querySelector('.nav-dropdown-menu');
    const trigger = dropdown?.querySelector('.nav-link');
    if (!menu || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    menu.style.top = `${rect.bottom}px`;
    menu.style.left = `${rect.left}px`;
}

// Observe hover/open to position dropdown menus
document.querySelectorAll('.nav-dropdown').forEach(dd => {
    dd.addEventListener('mouseenter', () => positionNavDropdownMenu(dd));
    dd.addEventListener('click', () => positionNavDropdownMenu(dd));
});

// Listen for scroll and resize to update nav overflow arrows
{
    const nl = document.querySelector('.nav-links');
    if (nl) {
        nl.addEventListener('scroll', checkNavOverflow, { passive: true });
        new ResizeObserver(checkNavOverflow).observe(nl);
    }
    // Also check on login (new nav items may appear)
    window.addEventListener('load', () => setTimeout(checkNavOverflow, 500));
}

/* ── Home Page ────────────────────────────────────────────────── */
const HERO_ROTATE_WORDS = [
    'stealth campers', 'nomads', 'outdoor enthusiasts',
    'nerds', 'IRL streamers', 'desktop gamers', 'hobos',
    'van dwellers', 'digital nomads', 'backpackers',
    'overlanders', 'thru-hikers', 'urban explorers',
    'tinkerers', 'makers', 'coders',
];
let _heroRotateIdx = 0;
let _heroRotateTimer = null;

function startHeroRotation() {
    const el = document.getElementById('hero-rotate');
    if (!el) return;
    _heroRotateIdx = 0;
    el.textContent = HERO_ROTATE_WORDS[0];
    el.classList.add('visible');
    if (_heroRotateTimer) clearInterval(_heroRotateTimer);
    _heroRotateTimer = setInterval(() => {
        el.classList.remove('visible');
        setTimeout(() => {
            _heroRotateIdx = (_heroRotateIdx + 1) % HERO_ROTATE_WORDS.length;
            el.textContent = HERO_ROTATE_WORDS[_heroRotateIdx];
            el.classList.add('visible');
        }, 400);
    }, 3000);
}

async function loadHome() {
    void loadHomeChangelog();
    startHeroRotation();

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

    // Load recent clips
    loadHomeClips();
    // Load recent pastes
    loadHomePastes();
    // Load HoboQuest leaderboards
    loadHomeLeaderboards();
    // Load Canvas preview
    loadHomeCanvas();
}

async function loadHomeClips() {
    try {
        const data = await api('/clips?limit=8');
        const clips = data.clips || [];
        const header = document.getElementById('home-clips-header');
        const grid = document.getElementById('home-clips-grid');
        if (!clips.length) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';
        grid.innerHTML = clips.map(c => `
            <div class="stream-card" onclick="navigate('/clip/${c.id}')">
                <div class="stream-card-thumb">
                    ${thumbImg(c.thumbnail_url, 'fa-scissors', c.title, `/api/thumbnails/generate/clip/${c.id}`)}
                    <span class="stream-card-viewers"><i class="fa-solid fa-eye"></i> ${c.view_count || 0}</span>
                    ${c.duration_seconds ? `<span class="stream-card-duration">${formatDuration(c.duration_seconds)}</span>` : ''}
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(c.title || 'Untitled Clip')}</div>
                    <div class="stream-card-streamer">
                        <span class="stream-card-avatar">${(c.username || '?')[0].toUpperCase()}</span>
                        ${esc(c.username || 'Anonymous')}
                        <span class="muted" style="margin-left:auto;font-size:0.75rem">${timeAgo(c.created_at)}</span>
                    </div>
                </div>
            </div>
        `).join('');
    } catch { /* silent */ }
}

async function loadHomePastes() {
    try {
        const data = await api('/pastes?limit=6');
        const pastes = data.pastes || [];
        const header = document.getElementById('home-pastes-header');
        const list = document.getElementById('home-pastes-list');
        if (!pastes.length) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';
        list.innerHTML = pastes.map(p => {
            const icon = p.type === 'screenshot' ? 'fa-image' : (p.language && p.language !== 'plaintext' ? 'fa-code' : 'fa-file-lines');
            const preview = p.type === 'paste' ? esc((p.content || '').slice(0, 220)).replace(/\n{3,}/g, '\n\n') : '';
            const media = p.type === 'screenshot' && p.screenshot_url
                ? `<div class="home-paste-media"><img src="${esc(p.screenshot_url)}" alt="${esc(p.title || 'Screenshot paste')}" loading="lazy"><span class="home-paste-type">Image</span></div>`
                : `<div class="home-paste-media"><div class="home-paste-snippet">${preview || esc(p.title || 'Untitled paste')}</div><div class="home-paste-icon"><i class="fa-solid ${icon}"></i></div><span class="home-paste-type">${p.language && p.language !== 'plaintext' ? esc(p.language) : 'Text'}</span></div>`;
            return `
            <a class="home-paste-card" href="/p/${esc(p.slug)}" onclick="event.preventDefault();navigate('/p/${esc(p.slug)}')">
                ${media}
                <div class="home-paste-body">
                <div class="home-paste-info">
                    <div class="home-paste-title">${esc(p.title || 'Untitled')}</div>
                    ${p.type === 'paste' && preview ? `<div class="home-paste-preview">${preview}</div>` : ''}
                    <div class="home-paste-meta">
                        ${p.username ? esc(p.username) : 'Anonymous'}
                        ${p.language && p.language !== 'plaintext' ? ` · <span class="home-paste-lang">${esc(p.language)}</span>` : ''}
                        · ${timeAgo(p.created_at)}
                    </div>
                </div>
                </div>
            </a>`;
        }).join('');
    } catch { /* silent */ }
}

async function loadHomeLeaderboards() {
    try {
        const boards = ['total_level', 'combat', 'mining', 'fishing'];
        const results = await Promise.all(boards.map(b =>
            fetch(`https://hobo.quest/api/game/leaderboard/${b}`).then(r => r.json()).catch(() => ({ entries: [] }))
        ));
        const header = document.getElementById('home-quest-header');
        const container = document.getElementById('home-leaderboards');
        const hasData = results.some(r => r.entries && r.entries.length);
        if (!hasData) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';

        const labels = { total_level: 'Total Level', combat: 'Combat', mining: 'Mining', fishing: 'Fishing' };
        const icons = { total_level: 'fa-star', combat: 'fa-sword', mining: 'fa-gem', fishing: 'fa-fish' };
        container.innerHTML = boards.map((board, i) => {
            const entries = (results[i].entries || []).slice(0, 5);
            if (!entries.length) return '';
            return `
            <div class="home-lb-card">
                <div class="home-lb-title"><i class="fa-solid ${icons[board] || 'fa-trophy'}"></i> ${labels[board]}</div>
                <div class="home-lb-entries">
                    ${entries.map((e, rank) => `
                        <div class="home-lb-row">
                            <span class="home-lb-rank">${rank + 1}</span>
                            <span class="home-lb-name">${esc(e.display_name || e.username || 'Unknown')}</span>
                            <span class="home-lb-score">${typeof e.score === 'number' ? e.score.toLocaleString() : e.score}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }).join('');
    } catch { /* silent */ }
}

async function loadHomeCanvas() {
    try {
        const data = await fetch('https://hobo.quest/api/game/canvas/state').then(r => r.json());
        const header = document.getElementById('home-canvas-header');
        const container = document.getElementById('home-canvas-preview');
        if (!data || !data.board) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';

        const tiles = data.tiles || [];
        const recentActions = data.recent_actions || [];
        const uniqueArtists = new Set(tiles.map(t => t.user_id).filter(Boolean)).size;
        const width = data.board.width || 64;
        const height = data.board.height || 64;
        const palette = data.board.palette || ['#000000'];

        // Render a mini canvas preview
        const scale = 4;
        container.innerHTML = `
            <div class="home-canvas-wrap">
                <canvas id="home-canvas-mini" width="${width * scale}" height="${height * scale}" style="image-rendering:pixelated;border-radius:var(--radius);border:1px solid var(--border);max-width:100%;"></canvas>
                <div class="home-canvas-stats">
                    <div class="home-canvas-stat"><strong>${tiles.length.toLocaleString()}</strong> <span>pixels placed</span></div>
                    <div class="home-canvas-stat"><strong>${uniqueArtists.toLocaleString()}</strong> <span>artists</span></div>
                    <div class="home-canvas-stat"><strong>${width}×${height}</strong> <span>board size</span></div>
                    <div class="home-canvas-stat"><strong>${recentActions.length}</strong> <span>recent actions</span></div>
                </div>
                <a href="https://hobo.quest/canvas" class="btn btn-outline" style="margin-top:12px;">
                    <i class="fa-solid fa-palette"></i> Open Canvas
                </a>
            </div>
        `;

        // Draw tiles on the mini canvas
        const canvas = document.getElementById('home-canvas-mini');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = palette[0] || '#000';
            ctx.fillRect(0, 0, width * scale, height * scale);
            for (const tile of tiles) {
                const color = palette[tile.color_index] || '#fff';
                ctx.fillStyle = color;
                ctx.fillRect(tile.x * scale, tile.y * scale, scale, scale);
            }
        }
    } catch { /* silent */ }
}

function renderStreamGrid(containerId, streams, isLive) {
    const c = document.getElementById(containerId);
    if (!streams.length) {
        if (!isLive) c.innerHTML = '<div class="empty-state"><p class="muted">No recent streams</p></div>';
        return;
    }
    c.innerHTML = streams.map(s => {
        // Navigate to channel with ?stream=ID for live, VOD for recent if available, else channel
        let navUrl;
        if (isLive && s.id) {
            navUrl = `/${esc(s.username)}?stream=${s.id}`;
        } else if (!isLive && s.vod_id && s.vod_is_public) {
            navUrl = `/vod/${s.vod_id}`;
        } else {
            navUrl = `/${esc(s.username)}`;
        }
        const thumb = (!isLive && s.vod_thumbnail_url) ? s.vod_thumbnail_url : s.thumbnail_url;
        const duration = !isLive && s.vod_duration ? `<span class="stream-card-duration">${formatDuration(s.vod_duration)}</span>` : '';
        const endedAgo = !isLive && s.ended_at ? `<span class="stream-card-ago">${timeAgo(s.ended_at)}</span>` : '';
        return `
        <div class="stream-card" onclick="navigate('${navUrl}')">
            <div class="stream-card-thumb">
                ${thumbImg(thumb, 'fa-campground', s.title, !isLive && s.vod_id ? `/api/thumbnails/generate/vod/${s.vod_id}` : null)}
                ${isLive ? '<span class="stream-card-live">LIVE</span>' : ''}
                ${s.protocol ? protocolBadge(s.protocol) : ''}
                ${s.is_nsfw ? '<span class="stream-card-nsfw">NSFW</span>' : ''}
                ${isLive ? `<span class="stream-card-viewers"><i class="fa-solid fa-eye"></i> ${s.viewer_count || 0}</span>` : ''}
                ${duration}
            </div>
            <div class="stream-card-info">
                <div class="stream-card-title">${esc(s.title || 'Untitled Stream')}</div>
                <div class="stream-card-streamer">
                    <span class="stream-card-avatar">${(s.username || '?')[0].toUpperCase()}</span>
                    ${esc(s.username || 'Anonymous')}
                    ${endedAgo}
                </div>
                ${s.category ? `<div class="stream-card-tags"><span class="stream-card-tag">${esc(s.category)}</span></div>` : ''}
            </div>
        </div>`;
    }).join('');
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

async function loadChannelPage(username, preferredStreamId = null) {
    try {
        currentChannelUsername = username;
        const data = await api(`/streams/channel/${username}`);
        const ch = data.channel;
        const streams = data.streams || (data.stream ? [data.stream] : []);
        const vods = data.vods || [];
        const clips = data.clips || [];
        const liveStreams = streams.filter(s => s && s.is_live);
        const rsRestream = data.rs_restream || {};
        const restreamLinks = data.restream_links || null;

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

            // Pick the preferred stream:
            // 1. URL ?stream=ID (deep link / shared link)
            // 2. Last viewed stream in this session (sessionStorage)
            // 3. Highest viewer count stream (default)
            let targetStream;
            if (preferredStreamId) {
                targetStream = liveStreams.find(s => s.id === preferredStreamId);
            }
            if (!targetStream) {
                const lastId = getLastStream(username);
                if (lastId) targetStream = liveStreams.find(s => s.id === lastId);
            }
            if (!targetStream) {
                targetStream = liveStreams.reduce((best, s) =>
                    (s.viewer_count || 0) > (best.viewer_count || 0) ? s : best
                , liveStreams[0]);
                // Clean up stale ?stream= param — the requested stream isn't live
                if (preferredStreamId && targetStream) {
                    history.replaceState(null, '', `/${username}?stream=${targetStream.id}`);
                }
            }

            // Remember selection and update URL
            rememberLastStream(username, targetStream.id);
            if (!preferredStreamId && liveStreams.length > 1) {
                history.replaceState(null, '', `/${username}?stream=${targetStream.id}`);
            }

            loadLiveStreamTabs(username, targetStream.id, liveStreams, rsRestream);

            // Activate the selected stream
            activateChannelStream(targetStream);

            // Show cumulative viewers across all streams
            updateCumulativeViewers(liveStreams, rsRestream, restreamLinks);
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
                                    ${thumbImg(v.thumbnail_url, 'fa-video', v.title, `/api/thumbnails/generate/vod/${v.id}`)}
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
                        ${thumbImg(v.thumbnail_url, 'fa-video', v.title, `/api/thumbnails/generate/vod/${v.id}`)}
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
                        ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title, `/api/thumbnails/generate/clip/${cl.id}`)}
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
 * Format uptime from a started_at timestamp to a short human string (e.g. "2h 14m").
 */
function formatUptime(startedAt) {
    if (!startedAt) return '';
    const start = new Date(startedAt.replace ? startedAt.replace(' ', 'T') + 'Z' : startedAt).getTime();
    if (isNaN(start)) return '';
    const d = Date.now() - start;
    if (d < 0) return '';
    const h = Math.floor(d / 3600000);
    const m = Math.floor((d % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Show/hide the stream switch loading overlay on the video container.
 */
function showStreamSwitchOverlay(show) {
    const el = document.getElementById('stream-switch-overlay');
    if (!el) return;
    if (show) {
        el.classList.add('visible');
    } else {
        el.classList.remove('visible');
    }
}

/**
 * Remember the last viewed stream for a channel (sessionStorage).
 */
function rememberLastStream(username, streamId) {
    try { sessionStorage.setItem(`last-stream:${username}`, String(streamId)); } catch {}
}
function getLastStream(username) {
    try { const v = sessionStorage.getItem(`last-stream:${username}`); return v ? parseInt(v) : null; } catch { return null; }
}

/**
 * Auto-scroll the active tab into view within the tab bar.
 */
function scrollActiveTabIntoView() {
    const active = document.querySelector('.live-tab.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

/**
 * Copy the current stream-specific URL to clipboard.
 */
function shareStreamUrl() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(
        () => toast('Stream link copied!', 'success'),
        () => toast('Failed to copy link', 'error')
    );
}

/**
 * Load tabs for the current channel's live streams.
 * Shows tabs when the channel has multiple concurrent streams.
 * Each tab shows: number badge, live dot, title, protocol badge, RS icon, viewers, uptime.
 * Supports keyboard navigation (arrow keys) between tabs.
 */
function loadLiveStreamTabs(currentUsername, activeStreamId, channelStreams = [], rsRestream = {}) {
    const tabsContainer = document.getElementById('live-stream-tabs');
    const tabsScroll = document.getElementById('live-tabs-scroll');
    const pageEl = document.getElementById('page-channel');
    if (!tabsContainer || !tabsScroll) return;

    // Only show tabs if the channel has more than one concurrent live stream
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

    // Calculate total viewers for the summary
    const totalViewers = filtered.reduce((sum, s) => sum + (s.viewer_count || 0), 0);

    tabsScroll.innerHTML = filtered.map((s, idx) => {
        const isActive = s.id === activeStreamId;
        const title = s.title || `Stream ${idx + 1}`;
        const viewers = s.viewer_count || 0;
        const uptime = formatUptime(s.started_at);
        const protoTag = s.protocol ? `<span class="live-tab-proto">${s.protocol.toUpperCase()}</span>` : '';
        const rsTag = rsRestream[s.id] ? '<span class="live-tab-rs" title="Also on RobotStreamer"><i class="fa-solid fa-robot"></i></span>' : '';
        const uptimeTag = uptime ? `<span class="live-tab-uptime"><i class="fa-solid fa-clock"></i> ${uptime}</span>` : '';
        const sep = idx > 0 ? '<span class="live-tab-separator" aria-hidden="true"></span>' : '';
        return `${sep}<button class="live-tab ${isActive ? 'active' : ''}"
                    onclick="switchToLiveStream('${esc(currentUsername)}', ${s.id}, this)"
                    data-stream-id="${s.id}" data-username="${esc(currentUsername)}"
                    role="tab" aria-selected="${isActive}" tabindex="${isActive ? '0' : '-1'}"
                    title="${esc(title)} — ${viewers} viewer${viewers !== 1 ? 's' : ''}${uptime ? ' — Live for ' + uptime : ''} (${s.protocol || 'unknown'})">
            <span class="live-tab-num">${idx + 1}</span>
            <span class="live-tab-dot"></span>
            <span class="live-tab-title">${esc(title)}</span>
            <span class="live-tab-meta">
                ${protoTag}${rsTag}
                <span class="live-tab-viewers"><i class="fa-solid fa-eye"></i> ${viewers}</span>
                ${uptimeTag}
            </span>
        </button>`;
    }).join('') +
    `<span class="live-tabs-summary" title="${totalViewers} viewers across ${filtered.length} streams">
        <i class="fa-solid fa-tower-broadcast"></i> <strong>${filtered.length}</strong> streams &middot;
        <i class="fa-solid fa-eye"></i> <strong>${totalViewers}</strong> total
    </span>`;

    // Auto-scroll active tab into view after render
    requestAnimationFrame(scrollActiveTabIntoView);

    // Setup keyboard navigation (arrow keys between tabs)
    setupTabKeyboardNav(tabsScroll, currentUsername);
}

/**
 * Keyboard navigation for stream tabs — left/right arrows move between tabs.
 */
function setupTabKeyboardNav(container, username) {
    // Remove old listener if any
    if (container._tabKeyHandler) container.removeEventListener('keydown', container._tabKeyHandler);
    container._tabKeyHandler = (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const tabs = Array.from(container.querySelectorAll('.live-tab'));
        if (!tabs.length) return;
        const currentIdx = tabs.findIndex(t => t === document.activeElement);
        if (currentIdx === -1) return;
        e.preventDefault();
        const nextIdx = e.key === 'ArrowRight'
            ? (currentIdx + 1) % tabs.length
            : (currentIdx - 1 + tabs.length) % tabs.length;
        tabs[currentIdx].setAttribute('tabindex', '-1');
        tabs[nextIdx].setAttribute('tabindex', '0');
        tabs[nextIdx].focus();
    };
    container.addEventListener('keydown', container._tabKeyHandler);
}

/**
 * Update cumulative viewer display below the video player.
 * Shows total viewers across all streams, RS restream indicator, and share button.
 */
function updateCumulativeViewers(liveStreams, rsRestream = {}, restreamLinks = null) {
    const el = document.getElementById('ch-cumulative-viewers');
    if (!el) return;

    const hasRs = Object.keys(rsRestream).length > 0;
    const hasRestream = restreamLinks?.length > 0;

    if (liveStreams.length <= 1 && !hasRs && !hasRestream) {
        el.style.display = 'none';
        return;
    }

    const total = liveStreams.reduce((sum, s) => sum + (s.viewer_count || 0), 0);
    const streamCount = liveStreams.length;

    let html = '';
    if (streamCount > 1) {
        html += `<span class="ch-viewer-total"><i class="fa-solid fa-layer-group"></i> <strong>${total}</strong> viewer${total !== 1 ? 's' : ''} across <strong>${streamCount}</strong> streams</span>`;
    }

    // RS restream badges — link to robotstreamer.com/robot/{id} when robot_id available
    for (const [, rs] of Object.entries(rsRestream)) {
        if (rs.active) {
            const label = 'RS Restream';
            if (rs.robot_id) {
                const rsUrl = `https://robotstreamer.com/robot/${esc(rs.robot_id)}`;
                html += `<a href="${rsUrl}" target="_blank" rel="noopener" class="ch-rs-badge" title="Also live on RobotStreamer${rs.robot_name ? ': ' + esc(rs.robot_name) : ''}"><i class="fa-solid fa-robot"></i> ${label}</a>`;
            } else {
                html += `<span class="ch-rs-badge" title="Also live on RobotStreamer${rs.robot_name ? ': ' + esc(rs.robot_name) : ''}"><i class="fa-solid fa-robot"></i> ${label}</span>`;
            }
        }
    }

    // Restream platform link badges (Twitch/Kick/YouTube) with viewer counts
    if (hasRestream) {
        const platformIcons = { twitch: 'fa-brands fa-twitch', kick: 'fa-brands fa-kickstarter-k', youtube: 'fa-brands fa-youtube', custom: 'fa-solid fa-globe' };
        const platformColors = { twitch: '#9146ff', kick: '#53fc18', youtube: '#ff0000', custom: '#888' };
        for (const link of restreamLinks) {
            const icon = platformIcons[link.platform] || platformIcons.custom;
            const color = platformColors[link.platform] || platformColors.custom;
            const liveDot = link.is_live ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#e91916;margin-right:4px;animation:pulse-live 1.5s infinite"></span>' : '';
            const name = esc(link.name || link.platform);
            const viewerStr = link.viewer_count != null ? ` · <i class="fa-solid fa-eye" style="font-size:0.75em"></i> ${link.viewer_count}` : '';
            html += `<a href="${esc(link.channel_url)}" target="_blank" rel="noopener" class="ch-restream-badge" style="color:${color}" title="${link.is_live ? 'Live on' : 'Also on'} ${name}${link.viewer_count != null ? ' (' + link.viewer_count + ' viewers)' : ''}">${liveDot}<i class="${icon}"></i> ${name}${viewerStr}</a>`;
        }
    }

    // Share button (copies stream-specific URL)
    if (streamCount > 1) {
        html += `<button class="ch-share-stream" onclick="shareStreamUrl()" title="Copy link to this specific stream"><i class="fa-solid fa-link"></i> Share stream</button>`;
    }

    if (html) {
        el.innerHTML = html;
        el.style.display = '';
    } else {
        el.style.display = 'none';
    }
}

/**
 * Switch to a different live stream within the same channel.
 * Shows loading overlay, destroys current player, fetches fresh data, initializes new stream.
 */
function switchToLiveStream(username, streamId, btn) {
    // If switching to a different channel, navigate there with stream preference
    if (username !== currentChannelUsername) {
        navigate('/' + username + '?stream=' + streamId);
        return;
    }

    // Don't re-switch to the already active stream
    if (streamId === currentStreamId) return;

    // Update tab UI immediately — highlight the target tab
    const tabsScroll = document.getElementById('live-tabs-scroll');
    if (tabsScroll) {
        tabsScroll.querySelectorAll('.live-tab').forEach(t => {
            const isTarget = parseInt(t.dataset.streamId) === streamId;
            t.classList.toggle('active', isTarget);
            t.setAttribute('aria-selected', String(isTarget));
            t.setAttribute('tabindex', isTarget ? '0' : '-1');
        });
    }
    if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

    // Show loading overlay
    showStreamSwitchOverlay(true);

    // Destroy current player before fetching the new stream
    if (typeof destroyPlayer === 'function') destroyPlayer();

    // Fetch the full stream data (with endpoint info) from the /channel API
    api(`/streams/channel/${username}`).then(data => {
        const streams = data.streams || [];
        const target = streams.find(s => s.id === streamId && s.is_live);
        if (target) {
            activateChannelStream(target);
            // Update URL to reflect stream selection (without full nav)
            history.replaceState(null, '', `/${username}?stream=${streamId}`);
            // Remember for return visits
            rememberLastStream(username, streamId);
            // Update cumulative viewers with fresh data
            const liveStreams = streams.filter(s => s && s.is_live);
            updateCumulativeViewers(liveStreams, data.rs_restream || {}, data.restream_links || null);
            // Refresh tabs with latest viewer counts
            loadLiveStreamTabs(username, streamId, liveStreams, data.rs_restream || {});
        } else {
            toast('Stream is no longer live', 'error');
        }
    }).catch(() => toast('Failed to load stream', 'error'))
      .finally(() => showStreamSwitchOverlay(false));
}

function activateChannelStream(stream) {
    // Avoid no-op reactivation of same stream (prevents double-init bugs)
    const isSameStream = currentStreamId === stream.id;
    currentStreamId = stream.id;
    currentStreamData = stream;
    document.getElementById('ch-stream-title').textContent = stream.title || 'Untitled Stream';
    // Protocol badge on live channel page (moved from tabs to info bar)
    const chProtoEl = document.getElementById('ch-protocol-badge');
    if (chProtoEl) chProtoEl.innerHTML = stream.protocol ? protocolBadge(stream.protocol) : '';
    // Description on live channel page
    const chDescEl = document.getElementById('ch-stream-description');
    if (chDescEl) {
        const desc = stream.description || '';
        chDescEl.textContent = desc;
        chDescEl.style.display = desc ? '' : 'none';
    }
    // Always destroy before init to prevent stale player state
    if (typeof destroyPlayer === 'function') destroyPlayer();
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
            const rsRestream = data.rs_restream || {};
            const restreamLinks = data.restream_links || null;
            if (!current && liveStreams.length > 0) {
                // Current stream ended, but others are live — auto-switch to best
                const best = liveStreams.reduce((b, s) =>
                    (s.viewer_count || 0) > (b.viewer_count || 0) ? s : b
                , liveStreams[0]);
                const bestTitle = best.title || 'another stream';
                loadLiveStreamTabs(username, best.id, liveStreams, rsRestream);
                activateChannelStream(best);
                updateCumulativeViewers(liveStreams, rsRestream, restreamLinks);
                rememberLastStream(username, best.id);
                history.replaceState(null, '', `/${username}?stream=${best.id}`);
                toast(`Stream ended — switched to "${bestTitle}"`, 'info');
                return;
            }

            // Update tabs with fresh viewer counts and uptime
            if (liveStreams.length > 1) {
                loadLiveStreamTabs(username, currentStreamId, liveStreams, rsRestream);
            } else {
                // Single stream — ensure tabs are hidden
                const tabsC = document.getElementById('live-stream-tabs');
                if (tabsC) tabsC.style.display = 'none';
                const pageEl = document.getElementById('page-channel');
                if (pageEl) pageEl.classList.remove('has-live-tabs');
            }

            // Update cumulative viewers
            updateCumulativeViewers(liveStreams, rsRestream, restreamLinks);
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
                    ${thumbImg(v.thumbnail_url, 'fa-video', v.title, `/api/thumbnails/generate/vod/${v.id}`)}
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
                    ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title, `/api/thumbnails/generate/clip/${cl.id}`)}
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
                        ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title, `/api/thumbnails/generate/clip/${cl.id}`)}
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

/* ── VOD Clip Creator ─────────────────────────────────────────── */
let _vpClipStart = 0;
let _vpClipEnd = 0;
let _clipDragging = null;      // 'start' | 'end' | null
let _clipPreviewRAF = null;
let _clipVideoDuration = 0;
const CLIP_MAX_DURATION = 60;

function openClipCreator() {
    if (!currentUser) { toast('Login required to create clips', 'info'); return; }
    const modal = document.getElementById('vp-clip-modal');
    const video = document.getElementById('vp-video');
    if (!modal || !video) return;

    _clipVideoDuration = video.duration || 0;
    if (!_clipVideoDuration || !isFinite(_clipVideoDuration)) {
        toast('Video not loaded yet', 'error');
        return;
    }

    // Pause the main video
    video.pause();

    // Initialize clip range: center on current position, 30s default
    const cur = video.currentTime;
    const halfDur = 15;
    _vpClipStart = Math.max(0, cur - halfDur);
    _vpClipEnd = Math.min(_clipVideoDuration, _vpClipStart + 30);
    if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = _vpClipStart + CLIP_MAX_DURATION;

    // Setup preview video
    const preview = document.getElementById('clip-preview-video');
    if (preview) {
        const filename = video.src.split('/').pop().split('?')[0];
        preview.src = `/api/vods/file/${filename}`;
        preview.currentTime = _vpClipStart;
        preview.muted = true;
    }

    // Build timeline ticks
    _buildClipTimelineTicks();

    modal.style.display = '';
    document.body.style.overflow = 'hidden';

    _updateClipCreatorUI();
    _setupClipDragHandlers();
    document.addEventListener('keydown', _clipModalKeyHandler);
}

/**
 * Legacy alias — the HTML button still calls toggleVodClipPanel()
 */
function toggleVodClipPanel() {
    const modal = document.getElementById('vp-clip-modal');
    if (modal && modal.style.display !== 'none') {
        closeClipCreator();
    } else {
        openClipCreator();
    }
}

function closeClipCreator() {
    const modal = document.getElementById('vp-clip-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';

    // Stop preview playback
    const preview = document.getElementById('clip-preview-video');
    if (preview) { preview.pause(); preview.removeAttribute('src'); preview.load(); }
    if (_clipPreviewRAF) { cancelAnimationFrame(_clipPreviewRAF); _clipPreviewRAF = null; }

    _teardownClipDragHandlers();
    document.removeEventListener('keydown', _clipModalKeyHandler);
}

function _clipModalKeyHandler(e) {
    if (e.key === 'Escape') { closeClipCreator(); e.stopPropagation(); }
}

function _buildClipTimelineTicks() {
    const ticksEl = document.getElementById('clip-timeline-ticks');
    if (!ticksEl || !_clipVideoDuration) return;
    ticksEl.innerHTML = '';

    // Determine tick interval based on duration
    let interval;
    if (_clipVideoDuration <= 60) interval = 10;
    else if (_clipVideoDuration <= 300) interval = 30;
    else if (_clipVideoDuration <= 1800) interval = 120;
    else if (_clipVideoDuration <= 7200) interval = 300;
    else interval = 600;

    for (let t = 0; t <= _clipVideoDuration; t += interval) {
        const pct = (t / _clipVideoDuration) * 100;
        const tick = document.createElement('span');
        tick.className = 'clip-tick';
        tick.style.left = pct + '%';
        tick.textContent = formatDuration(t);
        ticksEl.appendChild(tick);
    }
}

function _updateClipCreatorUI() {
    if (!_clipVideoDuration) return;
    const startPct = (_vpClipStart / _clipVideoDuration) * 100;
    const endPct = (_vpClipEnd / _clipVideoDuration) * 100;
    const duration = Math.max(0, _vpClipEnd - _vpClipStart);

    // Timeline handles & fill
    const handleStart = document.getElementById('clip-handle-start');
    const handleEnd = document.getElementById('clip-handle-end');
    const fill = document.getElementById('clip-timeline-fill');
    if (handleStart) handleStart.style.left = startPct + '%';
    if (handleEnd) handleEnd.style.left = endPct + '%';
    if (fill) { fill.style.left = startPct + '%'; fill.style.width = (endPct - startPct) + '%'; }

    // Time displays
    const startDisp = document.getElementById('clip-start-display');
    const endDisp = document.getElementById('clip-end-display');
    if (startDisp) startDisp.textContent = formatDuration(Math.floor(_vpClipStart));
    if (endDisp) endDisp.textContent = formatDuration(Math.floor(_vpClipEnd));

    // Duration display
    const durNum = document.getElementById('clip-duration-number');
    const durBar = document.getElementById('clip-duration-bar');
    const durSec = Math.floor(duration);
    if (durNum) {
        durNum.textContent = durSec;
        durNum.classList.toggle('clip-duration-over', durSec > CLIP_MAX_DURATION);
        durNum.classList.toggle('clip-duration-zero', durSec <= 0);
    }
    if (durBar) durBar.style.width = Math.min(100, (durSec / CLIP_MAX_DURATION) * 100) + '%';

    // Create button state
    const btn = document.getElementById('clip-create-btn');
    if (btn) btn.disabled = durSec <= 0 || durSec > CLIP_MAX_DURATION;
}

function setClipMarkToCurrent(which) {
    const video = document.getElementById('vp-video');
    if (!video) return;
    const cur = video.currentTime;
    if (which === 'start') {
        _vpClipStart = Math.max(0, cur);
        if (_vpClipEnd <= _vpClipStart) _vpClipEnd = Math.min(_vpClipStart + 30, _clipVideoDuration);
        if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = _vpClipStart + CLIP_MAX_DURATION;
    } else {
        _vpClipEnd = Math.min(cur, _clipVideoDuration);
        if (_vpClipStart >= _vpClipEnd) _vpClipStart = Math.max(0, _vpClipEnd - 30);
        if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = _vpClipEnd - CLIP_MAX_DURATION;
    }
    _updateClipCreatorUI();
    _seekClipPreview(_vpClipStart);
}

function nudgeClipMark(which, delta) {
    if (which === 'start') {
        _vpClipStart = Math.max(0, Math.min(_vpClipStart + delta, _clipVideoDuration));
        if (_vpClipStart >= _vpClipEnd) _vpClipEnd = Math.min(_vpClipStart + 1, _clipVideoDuration);
        if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = _vpClipStart + CLIP_MAX_DURATION;
    } else {
        _vpClipEnd = Math.max(0, Math.min(_vpClipEnd + delta, _clipVideoDuration));
        if (_vpClipEnd <= _vpClipStart) _vpClipStart = Math.max(0, _vpClipEnd - 1);
        if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = _vpClipEnd - CLIP_MAX_DURATION;
    }
    _updateClipCreatorUI();
    _seekClipPreview(which === 'start' ? _vpClipStart : _vpClipEnd - 1);
}

function _seekClipPreview(time) {
    const preview = document.getElementById('clip-preview-video');
    if (preview && preview.readyState >= 1) {
        preview.currentTime = Math.max(0, time);
    }
}

function toggleClipPreview() {
    const preview = document.getElementById('clip-preview-video');
    const btn = document.getElementById('clip-preview-play-btn');
    if (!preview) return;

    if (preview.paused) {
        preview.currentTime = _vpClipStart;
        preview.play().catch(() => {});
        if (btn) btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        _clipPreviewLoop();
    } else {
        preview.pause();
        if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        if (_clipPreviewRAF) { cancelAnimationFrame(_clipPreviewRAF); _clipPreviewRAF = null; }
    }
}

function _clipPreviewLoop() {
    const preview = document.getElementById('clip-preview-video');
    if (!preview || preview.paused) return;

    // Update playhead position
    const playhead = document.getElementById('clip-playhead');
    if (playhead && _clipVideoDuration) {
        const pct = (preview.currentTime / _clipVideoDuration) * 100;
        playhead.style.left = pct + '%';
        playhead.style.display = '';
    }

    // Stop at clip end
    if (preview.currentTime >= _vpClipEnd) {
        preview.pause();
        preview.currentTime = _vpClipStart;
        const btn = document.getElementById('clip-preview-play-btn');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        if (playhead) playhead.style.display = 'none';
        _clipPreviewRAF = null;
        return;
    }

    _clipPreviewRAF = requestAnimationFrame(_clipPreviewLoop);
}

/* -- Clip timeline drag handlers -- */
let _clipDragBound = {};

function _setupClipDragHandlers() {
    const wrap = document.getElementById('clip-timeline-wrap');
    if (!wrap) return;

    const onMouseDown = (e) => {
        const handle = e.target.closest('.clip-handle-start, .clip-handle-end');
        if (!handle) {
            // Click on timeline bar itself → move nearest handle
            const rect = wrap.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const time = pct * _clipVideoDuration;
            // Move whichever handle is closer
            const distStart = Math.abs(time - _vpClipStart);
            const distEnd = Math.abs(time - _vpClipEnd);
            if (distStart <= distEnd) {
                _vpClipStart = Math.max(0, time);
                if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = _vpClipStart + CLIP_MAX_DURATION;
            } else {
                _vpClipEnd = Math.min(_clipVideoDuration, time);
                if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = _vpClipEnd - CLIP_MAX_DURATION;
            }
            _updateClipCreatorUI();
            _seekClipPreview(_vpClipStart);
            return;
        }
        _clipDragging = handle.classList.contains('clip-handle-start') ? 'start' : 'end';
        e.preventDefault();
    };

    const onMouseMove = (e) => {
        if (!_clipDragging) return;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const time = pct * _clipVideoDuration;

        if (_clipDragging === 'start') {
            _vpClipStart = Math.max(0, Math.min(time, _vpClipEnd - 1));
            if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = Math.min(_vpClipStart + CLIP_MAX_DURATION, _clipVideoDuration);
        } else {
            _vpClipEnd = Math.min(_clipVideoDuration, Math.max(time, _vpClipStart + 1));
            if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = Math.max(0, _vpClipEnd - CLIP_MAX_DURATION);
        }
        _updateClipCreatorUI();
    };

    const onMouseUp = () => {
        if (_clipDragging) {
            _seekClipPreview(_vpClipStart);
            _clipDragging = null;
        }
    };

    // Touch support
    const onTouchStart = (e) => {
        const handle = e.target.closest('.clip-handle-start, .clip-handle-end');
        if (!handle) return;
        _clipDragging = handle.classList.contains('clip-handle-start') ? 'start' : 'end';
        e.preventDefault();
    };

    const onTouchMove = (e) => {
        if (!_clipDragging) return;
        const touch = e.touches[0];
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
        const time = pct * _clipVideoDuration;

        if (_clipDragging === 'start') {
            _vpClipStart = Math.max(0, Math.min(time, _vpClipEnd - 1));
            if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = Math.min(_vpClipStart + CLIP_MAX_DURATION, _clipVideoDuration);
        } else {
            _vpClipEnd = Math.min(_clipVideoDuration, Math.max(time, _vpClipStart + 1));
            if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = Math.max(0, _vpClipEnd - CLIP_MAX_DURATION);
        }
        _updateClipCreatorUI();
        e.preventDefault();
    };

    const onTouchEnd = () => {
        if (_clipDragging) {
            _seekClipPreview(_vpClipStart);
            _clipDragging = null;
        }
    };

    wrap.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    wrap.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);

    _clipDragBound = { wrap, onMouseDown, onMouseMove, onMouseUp, onTouchStart, onTouchMove, onTouchEnd };
}

function _teardownClipDragHandlers() {
    const b = _clipDragBound;
    if (b.wrap) {
        b.wrap.removeEventListener('mousedown', b.onMouseDown);
        b.wrap.removeEventListener('touchstart', b.onTouchStart);
    }
    document.removeEventListener('mousemove', b.onMouseMove);
    document.removeEventListener('mouseup', b.onMouseUp);
    document.removeEventListener('touchmove', b.onTouchMove);
    document.removeEventListener('touchend', b.onTouchEnd);
    _clipDragBound = {};
    _clipDragging = null;
}

let _clipCreating = false;
let _clipCooldownUntil = 0;
let _clipCooldownTimer = null;
const CLIP_CLIENT_COOLDOWN_MS = 10000;

async function createVodClip() {
    if (!currentUser) { toast('Login required to create clips', 'info'); return; }

    // Debounce: prevent double-clicks while request is in-flight
    if (_clipCreating) return;

    // Cooldown: enforce client-side wait between clips
    const now = Date.now();
    if (now < _clipCooldownUntil) {
        const secs = Math.ceil((_clipCooldownUntil - now) / 1000);
        toast(`Please wait ${secs}s before creating another clip`, 'info');
        return;
    }

    const vodId = window._vpVodId;
    if (!vodId) { toast('No VOD loaded', 'error'); return; }

    const duration = _vpClipEnd - _vpClipStart;
    if (duration <= 0) { toast('End time must be after start time', 'error'); return; }
    if (duration > CLIP_MAX_DURATION) { toast('Clips are limited to 60 seconds', 'error'); return; }

    const title = document.getElementById('clip-title-input')?.value?.trim() || 'Untitled Clip';
    const btn = document.getElementById('clip-create-btn');

    _clipCreating = true;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…'; }

    try {
        const result = await api('/vods/clips', {
            method: 'POST',
            body: {
                vod_id: vodId,
                start_time: _vpClipStart,
                end_time: _vpClipEnd,
                title,
            }
        });
        toast(result.deduplicated ? 'Clip already exists — opening it' : 'Clip created!', 'success');

        // Start client-side cooldown
        _clipCooldownUntil = Date.now() + CLIP_CLIENT_COOLDOWN_MS;
        _startClipCooldownUI(btn);

        closeClipCreator();
        if (result.clip?.id) {
            navigate(`/clip/${result.clip.id}`);
        } else {
            loadVodPlayer(vodId);
        }
    } catch (err) {
        toast(err.message || 'Failed to create clip', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-scissors"></i> Create Clip'; }
    } finally {
        _clipCreating = false;
    }
}

function _startClipCooldownUI(btn) {
    if (!btn) return;
    if (_clipCooldownTimer) clearInterval(_clipCooldownTimer);
    const update = () => {
        const left = Math.ceil((_clipCooldownUntil - Date.now()) / 1000);
        if (left <= 0) {
            clearInterval(_clipCooldownTimer);
            _clipCooldownTimer = null;
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-scissors"></i> Create Clip';
        } else {
            btn.disabled = true;
            btn.innerHTML = `<i class="fa-solid fa-clock"></i> Wait ${left}s`;
        }
    };
    update();
    _clipCooldownTimer = setInterval(update, 1000);
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
async function handleThumbnailError(img) {
    if (!img) return;
    img.onerror = null;
    const fallback = img.nextElementSibling;
    const regenerateUrl = img.dataset.regenerateUrl;
    if (regenerateUrl && !img.dataset.regenerateTried) {
        img.dataset.regenerateTried = '1';
        try {
            const res = await fetch(regenerateUrl, { method: 'POST', credentials: 'include' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.thumbnail_url) {
                img.src = `${data.thumbnail_url}${data.thumbnail_url.includes('?') ? '&' : '?'}t=${Date.now()}`;
                img.style.display = '';
                if (fallback) fallback.style.display = 'none';
                return;
            }
        } catch {}
    }
    img.style.display = 'none';
    if (fallback) fallback.style.display = '';
}

function thumbImg(thumbnailUrl, fallbackIcon, alt, regenerateUrl = null) {
    if (thumbnailUrl || regenerateUrl) {
        const src = thumbnailUrl || '/api/thumbnails/__missing__';
        return `<img src="${esc(src)}" alt="${esc(alt || '')}" loading="lazy" data-regenerate-url="${esc(regenerateUrl || '')}" onerror="handleThumbnailError(this)">
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
        const data = await api('/updates?limit=50');
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

async function loadHomeChangelog(attempt = 0) {
    const container = document.getElementById('home-changelog');
    if (!container) return;

    try {
        const data = await api('/updates?limit=15');
        if (!data.commits || data.commits.length === 0) {
            container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:16px 0;">No recent changes.</p>';
            return;
        }

        // Group commits by date (same pattern as updates page)
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
    } catch {
        // Retry up to 2 times with increasing delay (handles Cloudflare challenge timing)
        if (attempt < 2) {
            setTimeout(() => loadHomeChangelog(attempt + 1), (attempt + 1) * 3000);
        } else {
            container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:16px 0;">Failed to load changelog.</p>';
        }
    }
}

/* Toggle collapsible changelog on homepage */
function toggleHomeChangelog() {
    const wrapper = document.getElementById('home-changelog-wrapper');
    const btn = document.getElementById('home-changelog-toggle');
    if (!wrapper || !btn) return;
    const expanded = wrapper.classList.toggle('expanded');
    wrapper.classList.toggle('collapsed', !expanded);
    btn.textContent = expanded ? 'Show Less' : 'Show All';
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
