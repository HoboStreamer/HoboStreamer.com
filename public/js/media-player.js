let mpState = null;
let mpChannel = null;
let mpOwner = false;
let mpLiveStream = null;
let mpPollTimer = null;
let mpSocket = null;
let mpYouTubePlayer = null;
let mpVimeoPlayer = null;
let mpSuppressAutoStart = false;
window._mpYTReady = false;

function onYouTubeIframeAPIReady() {
    window._mpYTReady = true;
    maybeRenderCurrentPlayer();
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function mpUsername() {
    return window.location.pathname.split('/').filter(Boolean)[1] || '';
}

function mpToken() {
    return localStorage.getItem('token') || '';
}

async function mpApi(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    const token = mpToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

function mpToast(message) {
    console.log('[MediaPlayer]', message);
}

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function loadMediaPage() {
    const username = mpUsername();
    if (!username) return;

    document.getElementById('mp-copy-link').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(window.location.href);
            mpToast('Copied media player URL');
        } catch {}
    });

    document.getElementById('mp-start-next').addEventListener('click', () => ownerAction('/api/media/start', 'POST'));
    document.getElementById('mp-mark-played').addEventListener('click', () => ownerAction('/api/media/advance', 'POST', { status: 'played' }));
    document.getElementById('mp-skip-current').addEventListener('click', () => ownerAction('/api/media/advance', 'POST', { status: 'skipped' }));
    document.getElementById('mp-settings-form').addEventListener('submit', saveSettings);

    await refreshState();
    startPolling();
}

async function refreshState() {
    const username = mpUsername();
    const data = await mpApi(`/api/media/channel/${encodeURIComponent(username)}`);
    mpChannel = data.channel;
    mpState = data.state;
    mpOwner = !!data.is_owner;
    mpLiveStream = data.live_stream;

    renderPage(data.media_player_url);
    connectSocket();
    maybeAutoStart();
}

function renderPage(mediaPlayerUrl) {
    document.getElementById('mp-title').textContent = `${mpChannel.display_name} — Media Queue`;
    document.getElementById('mp-subtitle').textContent = mpOwner
        ? 'Manage requests, playback, and your queue from this page.'
        : `Request media in chat with !sr while watching ${mpChannel.display_name}.`;
    document.getElementById('mp-channel-link').href = `/${mpChannel.username}`;
    document.getElementById('mp-owner-controls').hidden = !mpOwner;
    document.getElementById('mp-settings-card').hidden = !mpOwner;
    document.getElementById('mp-now-meta').textContent = mpState.now_playing
        ? `Requested by ${mpState.now_playing.username}`
        : 'Nothing is playing right now.';

    renderNowPlaying();
    renderQueue();
    renderHistory();
    renderSettings();

    if (mediaPlayerUrl) document.title = `${mpChannel.display_name} media queue`;
}

function renderNowPlaying() {
    const current = mpState.now_playing;
    const empty = document.getElementById('mp-player-empty');
    const host = document.getElementById('mp-player-host');
    const card = document.getElementById('mp-now-card');

    if (!current) {
        empty.hidden = false;
        host.hidden = true;
        card.hidden = true;
        destroyPlayers();
        host.innerHTML = '';
        return;
    }

    empty.hidden = true;
    host.hidden = false;
    card.hidden = false;
    card.innerHTML = `
        <div class="mp-now-title">${esc(current.title)}</div>
        <div class="mp-now-meta-row">
            <span><i class="fa-solid fa-user"></i> ${esc(current.username)}</span>
            <span><i class="fa-solid fa-circle-play"></i> ${esc(current.provider)}</span>
            <span><i class="fa-solid fa-coins"></i> ${current.cost} coins</span>
        </div>
    `;

    maybeRenderCurrentPlayer();
}

function maybeRenderCurrentPlayer() {
    const current = mpState?.now_playing;
    const host = document.getElementById('mp-player-host');
    if (!current || !host) return;

    destroyPlayers();
    host.innerHTML = '';

    if (current.provider === 'youtube') {
        if (!window._mpYTReady || !window.YT?.Player) return;
        const div = document.createElement('div');
        div.id = 'mp-youtube-player';
        host.appendChild(div);
        mpYouTubePlayer = new window.YT.Player(div.id, {
            width: '100%',
            height: '100%',
            videoId: new URL(current.canonical_url).searchParams.get('v'),
            playerVars: { autoplay: 1, rel: 0 },
            events: {
                onStateChange: (evt) => {
                    if (evt.data === window.YT.PlayerState.ENDED) ownerAction('/api/media/advance', 'POST', { status: 'played' }, true);
                },
            },
        });
        return;
    }

    if (current.provider === 'vimeo' && window.Vimeo?.Player) {
        const iframe = document.createElement('iframe');
        iframe.src = current.embed_url;
        iframe.allow = 'autoplay; fullscreen; picture-in-picture';
        iframe.allowFullscreen = true;
        host.appendChild(iframe);
        mpVimeoPlayer = new window.Vimeo.Player(iframe);
        mpVimeoPlayer.on('ended', () => ownerAction('/api/media/advance', 'POST', { status: 'played' }, true));
        return;
    }

    const media = document.createElement(current.provider === 'audio' ? 'audio' : 'video');
    media.src = current.embed_url;
    media.controls = true;
    media.autoplay = true;
    if (current.provider !== 'audio') media.playsInline = true;
    media.addEventListener('ended', () => ownerAction('/api/media/advance', 'POST', { status: 'played' }, true));
    host.appendChild(media);
}

function destroyPlayers() {
    try { mpYouTubePlayer?.destroy(); } catch {}
    try { mpVimeoPlayer?.unload(); } catch {}
    mpYouTubePlayer = null;
    mpVimeoPlayer = null;
}

function renderQueue() {
    const list = document.getElementById('mp-queue-list');
    const queue = mpState.queue || [];
    document.getElementById('mp-queue-count').textContent = `${queue.length} queued`;
    if (!queue.length) {
        list.innerHTML = '<div class="mp-empty">Queue is empty.</div>';
        return;
    }

    list.innerHTML = queue.map((item, index) => `
        <article class="mp-item">
            <div class="mp-item-top">
                <div class="mp-item-main">
                    ${item.thumbnail_url ? `<img class="mp-item-thumb" src="${esc(item.thumbnail_url)}" alt="">` : ''}
                    <div class="mp-item-body">
                        <div class="mp-item-title">#${index + 1} ${esc(item.title)}</div>
                        <div class="mp-item-meta">Requested by ${esc(item.username)} · ${esc(item.provider)} · ${item.cost} coins</div>
                    </div>
                </div>
            </div>
            ${mpOwner ? `<div class="mp-item-actions">
                <button class="mp-icon-btn" onclick="playRequest(${item.id})"><i class="fa-solid fa-play"></i></button>
                <button class="mp-icon-btn" onclick="moveRequest(${item.id}, 'up')"><i class="fa-solid fa-arrow-up"></i></button>
                <button class="mp-icon-btn" onclick="moveRequest(${item.id}, 'down')"><i class="fa-solid fa-arrow-down"></i></button>
                <button class="mp-icon-btn" onclick="removeRequest(${item.id})"><i class="fa-solid fa-xmark"></i></button>
            </div>` : ''}
        </article>
    `).join('');
}

function renderHistory() {
    const list = document.getElementById('mp-history-list');
    const history = mpState.history || [];
    if (!history.length) {
        list.innerHTML = '<div class="mp-empty">Nothing has finished yet.</div>';
        return;
    }
    list.innerHTML = history.map((item) => `
        <article class="mp-item">
            <div class="mp-item-title">${esc(item.title)}</div>
            <div class="mp-item-meta">${esc(item.username)} · ${esc(item.status)} · ${esc(item.provider)}</div>
        </article>
    `).join('');
}

function renderSettings() {
    if (!mpOwner) return;
    const form = document.getElementById('mp-settings-form');
    const settings = mpState.settings || {};
    form.enabled.checked = !!settings.enabled;
    form.request_cost.value = settings.request_cost ?? 25;
    form.max_per_user.value = settings.max_per_user ?? 3;
    form.max_duration_seconds.value = settings.max_duration_seconds ?? 600;
    form.allow_youtube.checked = !!settings.allow_youtube;
    form.allow_vimeo.checked = !!settings.allow_vimeo;
    form.allow_direct_media.checked = !!settings.allow_direct_media;
    form.auto_advance.checked = !!settings.auto_advance;
}

async function saveSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await ownerAction('/api/media/settings', 'PUT', {
        enabled: form.enabled.checked,
        request_cost: Number(form.request_cost.value || 25),
        max_per_user: Number(form.max_per_user.value || 3),
        max_duration_seconds: Number(form.max_duration_seconds.value || 600),
        allow_youtube: form.allow_youtube.checked,
        allow_vimeo: form.allow_vimeo.checked,
        allow_direct_media: form.allow_direct_media.checked,
        auto_advance: form.auto_advance.checked,
    });
}

async function ownerAction(path, method, body, silent = false) {
    if (!mpOwner) return;
    try {
        const data = await mpApi(path, { method, body: body ? JSON.stringify(body) : undefined });
        if (data.settings) mpState.settings = data.settings;
        await refreshState();
        if (!silent) mpToast('Updated media queue');
    } catch (err) {
        if (!silent) alert(err.message || 'Action failed');
    }
}

async function playRequest(id) {
    await ownerAction(`/api/media/queue/${id}/play`, 'POST');
}
window.playRequest = playRequest;

async function moveRequest(id, direction) {
    await ownerAction(`/api/media/queue/${id}/move`, 'POST', { direction });
}
window.moveRequest = moveRequest;

async function removeRequest(id) {
    await ownerAction(`/api/media/queue/${id}`, 'DELETE');
}
window.removeRequest = removeRequest;

function maybeAutoStart() {
    if (!mpOwner || mpSuppressAutoStart) return;
    const settings = mpState?.settings || {};
    if (settings.auto_advance && !mpState.now_playing && mpState.queue?.length) {
        mpSuppressAutoStart = true;
        ownerAction('/api/media/start', 'POST', undefined, true).finally(() => {
            setTimeout(() => { mpSuppressAutoStart = false; }, 1500);
        });
    }
}

function startPolling() {
    stopPolling();
    mpPollTimer = setInterval(() => {
        refreshState().catch(() => {});
    }, 8000);
}

function stopPolling() {
    if (mpPollTimer) clearInterval(mpPollTimer);
    mpPollTimer = null;
}

function connectSocket() {
    if (!mpLiveStream?.id) return;
    if (mpSocket && mpSocket._streamId === mpLiveStream.id && mpSocket.readyState <= 1) return;
    try { mpSocket?.close(); } catch {}

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/ws/chat`);
    if (mpToken()) url.searchParams.set('token', mpToken());
    url.searchParams.set('stream', mpLiveStream.id);

    const socket = new WebSocket(url.toString());
    socket._streamId = mpLiveStream.id;
    socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'join_stream', streamId: mpLiveStream.id, token: mpToken() || undefined }));
    });
    socket.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'media_queue_update' && msg.state) {
                mpState = msg.state;
                renderPage(`/media/${mpChannel.username}`);
                maybeAutoStart();
            } else if (msg.type === 'media_now_playing' && msg.request) {
                mpState.now_playing = msg.request;
                renderNowPlaying();
            }
        } catch {}
    });
    socket.addEventListener('close', () => {
        if (mpSocket === socket) mpSocket = null;
    });
    mpSocket = socket;
}

window.addEventListener('beforeunload', () => {
    stopPolling();
    try { mpSocket?.close(); } catch {}
    destroyPlayers();
});

document.addEventListener('DOMContentLoaded', loadMediaPage);
