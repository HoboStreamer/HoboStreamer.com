/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Dashboard (Streamer Panel)
   ═══════════════════════════════════════════════════════════════ */

let activeStreamData = null;
let activeStreams = [];

/**
 * Load the dashboard page.
 */
async function loadDashboard() {
    if (!currentUser) {
        toast('Login required', 'error');
        return navigate('/');
    }

    // Load channel info
    loadDashChannel();
    // Load stream key
    loadDashStreamKey();
    // Load goals
    loadDashGoals();
    // Load VODs
    loadDashVods();
    // Load funds
    loadDashFunds();
    // Load active streams list
    loadDashActiveStreams();
    // Load controls
    loadDashControls();
    // Load custom emotes
    if (typeof loadDashEmotes === 'function') loadDashEmotes();
    // Load clips
    loadDashMyClips();
    loadDashStreamClips();
    // Load Hobo Coins
    loadDashCoins();
    // Load coin rewards
    if (typeof loadDashRewards === 'function') loadDashRewards();
    // Load redemption queue
    if (typeof loadDashRedemptions === 'function') loadDashRedemptions();
}

/* ── Channel Info ──────────────────────────────────────────────── */
async function loadDashChannel() {
    // No-op: stream creation is handled by the Broadcast page
}

/* ── Stream Key ───────────────────────────────────────────────── */
async function loadDashStreamKey() {
    try {
        const data = await api('/auth/stream-key');
        const key = data.streamKey || data.stream_key || '';
        document.getElementById('dash-stream-key').value = key;
    } catch { /* silent */ }
}

function toggleKeyVisibility() {
    const el = document.getElementById('dash-stream-key');
    el.type = el.type === 'password' ? 'text' : 'password';
}

function copyStreamKey() {
    const key = document.getElementById('dash-stream-key').value;
    if (!key) return toast('No stream key', 'error');
    navigator.clipboard.writeText(key).then(() => toast('Stream key copied!', 'success'));
}

async function regenerateStreamKey() {
    if (!confirm('Are you sure? Your old key will stop working.')) return;
    try {
        const data = await api('/auth/stream-key/regenerate', { method: 'POST' });
        const key = data.streamKey || data.stream_key || '';
        document.getElementById('dash-stream-key').value = key;
        toast('Stream key regenerated', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Go Live / End Stream ─────────────────────────────────────── */
// Stream creation is handled by the Broadcast page (/broadcast).
// goLive() has been removed — use broadcast.js instead.

async function loadDashActiveStreams() {
    const listEl = document.getElementById('dash-active-streams');
    if (!listEl) return;
    try {
        const data = await api('/streams/mine');
        const all = data.streams || [];
        activeStreams = all.filter(s => s.is_live);

        if (!activeStreams.length) {
            listEl.innerHTML = '<p class="muted">No active streams</p>';
            activeStreamData = null;
            document.getElementById('dash-endpoint-info').style.display = 'none';
            return;
        }

        listEl.innerHTML = activeStreams.map(s => {
            const proto = (s.protocol || 'webrtc').toUpperCase();
            const icon = s.protocol === 'jsmpeg' ? 'fa-terminal' : s.protocol === 'rtmp' ? 'fa-server' : 'fa-globe';
            const raw = s.started_at || '';
            const ts = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
            const started = new Date(ts);
            const elapsed = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
            return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
                <i class="fa-solid ${icon}" style="color:var(--accent)"></i>
                <div style="flex:1;min-width:0">
                    <strong style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.title || 'Untitled')}</strong>
                    <span class="muted" style="font-size:0.8rem">${proto} · ${formatDuration(elapsed)} live</span>
                </div>
                <button class="btn btn-small" onclick="showEndpointInfoById(${s.id})"><i class="fa-solid fa-info-circle"></i></button>
                <button class="btn btn-small btn-danger" onclick="endStreamById(${s.id})"><i class="fa-solid fa-stop"></i> End</button>
            </div>`;
        }).join('');

        // Set first active stream if not already set
        if (!activeStreamData) activeStreamData = activeStreams[0];
    } catch { listEl.innerHTML = '<p class="muted">Failed to load streams</p>'; }
}

async function endStreamById(streamId) {
    try {
        await api(`/streams/${streamId}`, { method: 'DELETE' });
        toast('Stream ended', 'info');
        if (activeStreamData && activeStreamData.id === streamId) activeStreamData = null;
        activeStreams = activeStreams.filter(s => s.id !== streamId);
        loadDashActiveStreams();
        loadDashControls();
    } catch (e) { toast(e.message, 'error'); }
}

async function endStream() {
    if (!activeStreamData) return;
    await endStreamById(activeStreamData.id);
}

function showEndpointInfoById(streamId) {
    const s = activeStreams.find(x => x.id === streamId);
    if (s) showEndpointInfo(s);
}

function showEndpointInfo(stream) {
    const el = document.getElementById('dash-endpoint-info');
    el.style.display = '';

    const host = window.location.hostname;
    const proto = stream.protocol || 'jsmpeg';

    let info = '';
    if (proto === 'jsmpeg') {
            const vp = stream.endpoint?.videoPort || stream.endpoint?.video_port || 9710;
        info = `Protocol: JSMPEG\n\nFFmpeg command:\nffmpeg -i <source> \\\n  -f mpegts \\\n  -codec:v mpeg1video -b:v 800k -r 24 \\\n  -codec:a mp2 -ar 44100 -ac 1 -b:a 64k \\\n  http://${host}:${vp}/stream_key`;
    } else if (proto === 'webrtc') {
        info = `Protocol: WebRTC\n\nUse the browser "Start Broadcasting" feature.\nYour webcam/screen will be shared via Mediasoup SFU.`;
    } else if (proto === 'rtmp') {
        info = `Protocol: RTMP\n\nServer: rtmp://${host}:1935/live\nStream Key: ${stream.stream_key || '(use your stream key)'}\n\nIn OBS: Settings → Stream → Custom → paste above.`;
    }

    el.textContent = info;
}

/* ── Controls Manager ─────────────────────────────────────────── */
async function loadDashControls() {
    const list = document.getElementById('dash-controls-list');
    if (!activeStreams.length) {
        list.innerHTML = '<p class="muted">Go live first to manage controls</p>';
        return;
    }

    try {
        // Load controls for the first active stream (or the selected one)
        const streamId = activeStreamData ? activeStreamData.id : activeStreams[0].id;
        const data = await api(`/controls/${streamId}`);
        const controls = data.controls || [];
        if (!controls.length) {
            list.innerHTML = '<p class="muted">No controls configured</p>';
            return;
        }
        list.innerHTML = controls.map(c => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
                <i class="fa-solid ${esc(c.icon || 'fa-circle')}"></i>
                <span>${esc(c.label || c.command)}</span>
                <span class="muted" style="flex:1">${esc(c.command)} (${c.cooldown}s)</span>
                <button class="btn btn-small btn-danger" onclick="deleteControl('${c.id}')">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `).join('');
    } catch { list.innerHTML = '<p class="muted">Failed to load controls</p>'; }
}

async function doAddControl() {
    const streamId = activeStreamData ? activeStreamData.id : (activeStreams[0] && activeStreams[0].id);
    if (!streamId) return toast('Go live first', 'error');
    const command = document.getElementById('modal-ctrl-cmd').value.trim();
    const label = document.getElementById('modal-ctrl-label').value.trim();
    const icon = document.getElementById('modal-ctrl-icon').value.trim();
    const cooldown = parseInt(document.getElementById('modal-ctrl-cooldown').value) || 1;

    if (!command) return toast('Command is required', 'error');

    try {
        await api(`/controls/${streamId}`, {
            method: 'POST',
            body: { command, label: label || command, icon, cooldown }
        });
        toast('Control added', 'success');
        closeModal();
        loadDashControls();
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteControl(controlId) {
    const streamId = activeStreamData ? activeStreamData.id : (activeStreams[0] && activeStreams[0].id);
    if (!streamId) return;
    try {
        await api(`/controls/${streamId}/${controlId}`, { method: 'DELETE' });
        toast('Control removed', 'success');
        loadDashControls();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Goals ─────────────────────────────────────────────────────── */
async function loadDashGoals() {
    if (!currentUser) return;
    const list = document.getElementById('dash-goals-list');
    try {
        const data = await api(`/funds/goals/${currentUser.id}`);
        const goals = data.goals || [];
        if (!goals.length) {
            list.innerHTML = '<p class="muted">No goals set</p>';
            return;
        }
        list.innerHTML = goals.map(g => {
            const pct = g.target_amount ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100)) : 0;
            return `
                <div style="margin-bottom:12px">
                    <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                        <strong>${esc(g.title)}</strong>
                        <span class="muted">${pct}%</span>
                    </div>
                    <div class="goal-bar">
                        <div class="goal-fill" style="width:${pct}%"></div>
                    </div>
                    <div class="muted" style="font-size:0.8rem;margin-top:2px">
                        $${g.current_amount} / $${g.target_amount} Hobo Bucks
                    </div>
                </div>
            `;
        }).join('');
    } catch { list.innerHTML = '<p class="muted">Failed to load goals</p>'; }
}

async function doAddGoal() {
    const title = document.getElementById('modal-goal-title').value.trim();
    const target = parseInt(document.getElementById('modal-goal-target').value);

    if (!title || !target) return toast('Fill in all fields', 'error');

    try {
        await api('/funds/goals', { method: 'POST', body: { title, targetAmount: target } });
        toast('Goal created!', 'success');
        closeModal();
        loadDashGoals();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── VODs ──────────────────────────────────────────────────────── */
async function loadDashVods() {
    const list = document.getElementById('dash-vods-list');
    try {
        const data = await api('/vods/mine');
        const vods = data.vods || [];
        if (!vods.length) {
            list.innerHTML = '<p class="muted">No recordings yet. Videos are created automatically when you stream.</p>';
            return;
        }
        list.innerHTML = vods.map(v => `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(v.thumbnail_url, 'fa-video', v.title) : '<i class="fa-solid fa-video"></i>'}
                    ${!v.is_public ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">PRIVATE</span>' : '<span class="stream-card-nsfw" style="background:var(--accent)">PUBLIC</span>'}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(v.duration_seconds || v.duration)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(v.title || 'Untitled Video')}</div>
                    <div style="display:flex;gap:6px;margin-top:6px">
                        ${!v.is_public
                            ? `<button class="btn btn-small btn-success" onclick="publishVod('${v.id}')"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="unpublishVod('${v.id}')"><i class="fa-solid fa-eye-slash"></i> Private</button>`}
                        <button class="btn btn-small" onclick="navigate('/vod/${v.id}')"><i class="fa-solid fa-play"></i></button>
                        <button class="btn btn-small btn-danger" onclick="deleteVod('${v.id}')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `).join('');
    } catch { list.innerHTML = '<p class="muted">Failed to load videos</p>'; }
}

async function publishVod(vodId) {
    try {
        await api(`/vods/${vodId}/publish`, { method: 'POST' });
        toast('Video published', 'success');
        loadDashVods();
    } catch (e) { toast(e.message, 'error'); }
}

async function unpublishVod(vodId) {
    try {
        await api(`/vods/${vodId}`, { method: 'PUT', body: { is_public: false } });
        toast('Video set to private', 'info');
        loadDashVods();
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteVod(vodId) {
    if (!confirm('Delete this video forever?')) return;
    try {
        await api(`/vods/${vodId}`, { method: 'DELETE' });
        toast('Video deleted', 'success');
        loadDashVods();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── My Clips (clips I created) ───────────────────────────────── */
async function loadDashMyClips() {
    const list = document.getElementById('dash-my-clips');
    if (!list) return;
    try {
        const data = await api('/clips/mine');
        const clips = data.clips || [];
        if (!clips.length) {
            list.innerHTML = '<p class="muted">You haven\'t clipped anything yet. Use the clip button while watching a stream!</p>';
            return;
        }
        list.innerHTML = clips.map(cl => `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title) : '<i class="fa-solid fa-scissors"></i>'}
                    ${!cl.is_public ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">UNLISTED</span>' : '<span class="stream-card-nsfw" style="background:var(--accent)">PUBLIC</span>'}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Untitled Clip')}</div>
                    <div class="muted" style="font-size:0.8rem;margin-bottom:4px">${new Date(cl.created_at).toLocaleDateString()}</div>
                    <div style="display:flex;gap:6px">
                        ${!cl.is_public
                            ? `<button class="btn btn-small btn-success" onclick="dashToggleClipVisibility(${cl.id}, true, 'mine')"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="dashToggleClipVisibility(${cl.id}, false, 'mine')"><i class="fa-solid fa-eye-slash"></i> Unlist</button>`}
                        <button class="btn btn-small" onclick="navigate('/clip/${cl.id}')"><i class="fa-solid fa-play"></i></button>
                        <button class="btn btn-small btn-danger" onclick="dashDeleteClip(${cl.id}, 'mine')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `).join('');
    } catch { list.innerHTML = '<p class="muted">Failed to load clips</p>'; }
}

/* ── Clips of My Stream ───────────────────────────────────────── */
async function loadDashStreamClips() {
    const list = document.getElementById('dash-stream-clips');
    if (!list) return;
    try {
        const data = await api('/clips/my-stream');
        const clips = data.clips || [];
        if (!clips.length) {
            list.innerHTML = '<p class="muted">No one has clipped your streams yet.</p>';
            return;
        }
        list.innerHTML = clips.map(cl => `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title) : '<i class="fa-solid fa-scissors"></i>'}
                    ${!cl.is_public ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">UNLISTED</span>' : '<span class="stream-card-nsfw" style="background:var(--accent)">PUBLIC</span>'}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Untitled Clip')}</div>
                    <div class="muted" style="font-size:0.8rem;margin-bottom:4px">
                        <i class="fa-solid fa-scissors"></i> ${esc(cl.display_name || cl.username || 'Unknown')} &bull; ${new Date(cl.created_at).toLocaleDateString()}
                    </div>
                    <div style="display:flex;gap:6px">
                        ${!cl.is_public
                            ? `<button class="btn btn-small btn-success" onclick="dashToggleClipVisibility(${cl.id}, true)"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="dashToggleClipVisibility(${cl.id}, false)"><i class="fa-solid fa-eye-slash"></i> Unlist</button>`}
                        <button class="btn btn-small" onclick="navigate('/clip/${cl.id}')"><i class="fa-solid fa-play"></i></button>
                        <button class="btn btn-small btn-danger" onclick="dashDeleteClip(${cl.id}, 'stream')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `).join('');
    } catch { list.innerHTML = '<p class="muted">Failed to load clips</p>'; }
}

async function dashToggleClipVisibility(clipId, makePublic, source) {
    try {
        await api(`/clips/${clipId}/visibility`, {
            method: 'PUT',
            body: { is_public: makePublic }
        });
        toast(makePublic ? 'Clip published' : 'Clip unlisted', 'success');
        if (source === 'mine') loadDashMyClips();
        else loadDashStreamClips();
    } catch (e) { toast(e.message || 'Failed to update visibility', 'error'); }
}

async function dashDeleteClip(clipId, source) {
    if (!confirm('Delete this clip permanently?')) return;
    try {
        await api(`/clips/${clipId}`, { method: 'DELETE' });
        toast('Clip deleted', 'success');
        if (source === 'mine') loadDashMyClips();
        else loadDashStreamClips();
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
}

/* ── Hobo Bucks ───────────────────────────────────────────────── */
async function loadDashFunds() {
    if (!currentUser) return;
    try {
        const data = await api('/funds/balance');
        const bal = data.balance || 0;
        document.getElementById('dash-funds-amount').textContent = parseFloat(bal).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        document.getElementById('dash-funds-usd').textContent = `($${parseFloat(bal).toFixed(2)})`;
    } catch { /* silent */ }
}

/* ── Hobo Coins ─────────────────────────────────────────────── */
async function loadDashCoins() {
    if (!currentUser) return;
    try {
        const data = await api('/coins/balance');
        const bal = data.balance || 0;
        document.getElementById('dash-coins-amount').textContent = bal.toLocaleString();
    } catch { /* silent */ }
}
