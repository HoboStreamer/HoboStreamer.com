/**
 * channel-uploads.js — Viewer-facing "Add channel emote / sound" modal.
 *
 * Lets any logged-in viewer contribute custom :emotes: (gif/png) and !sound
 * commands to the channel they're currently watching. The server enforces
 * whether the feature is enabled, mods-only, size/duration/count limits.
 */
(function () {
    'use strict';

    function token() { try { return localStorage.getItem('token'); } catch { return null; } }

    function resolveStreamId(explicit) {
        if (explicit) return parseInt(explicit) || null;
        if (typeof currentStreamId !== 'undefined' && currentStreamId) return currentStreamId;
        if (window.currentStreamId) return window.currentStreamId;
        return null;
    }

    function notify(msg, type) {
        if (typeof toast === 'function') toast(msg, type || 'info');
        else if (type === 'error') alert(msg);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    let overlay = null;
    let curStreamId = null;
    let _soundPreviewUrl = null;   // object URL for the attached-sound preview
    let curTab = 'emote';

    function ensureStyles() {
        if (document.getElementById('cu-styles')) return;
        const css = `
        .cu-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100000;padding:16px;}
        .cu-modal{background:var(--bg-elevated,#1c1c22);color:var(--text,#eee);width:min(560px,96vw);max-height:90vh;overflow:auto;border-radius:12px;border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 60px rgba(0,0,0,.5);}
        .cu-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08);}
        .cu-head h3{margin:0;font-size:16px;}
        .cu-close{background:none;border:none;color:inherit;font-size:20px;cursor:pointer;opacity:.7;}
        .cu-close:hover{opacity:1;}
        .cu-tabs{display:flex;gap:6px;padding:12px 18px 0;}
        .cu-tab{flex:1;padding:9px;border:1px solid rgba(255,255,255,.12);background:transparent;color:inherit;border-radius:8px 8px 0 0;cursor:pointer;font-weight:600;}
        .cu-tab.active{background:rgba(200,150,92,.18);border-bottom-color:transparent;}
        .cu-body{padding:16px 18px 20px;}
        .cu-form{display:flex;flex-direction:column;gap:10px;margin-bottom:14px;}
        .cu-form input[type=text]{padding:9px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:inherit;}
        .cu-form input[type=file]{font-size:13px;}
        .cu-btn{padding:9px 14px;border-radius:8px;border:none;background:var(--accent,#c0965c);color:#111;font-weight:700;cursor:pointer;}
        .cu-btn:disabled{opacity:.5;cursor:default;}
        .cu-hint{font-size:12px;opacity:.65;line-height:1.4;}
        .cu-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;}
        .cu-emote{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;width:74px;padding:6px;border-radius:8px;background:rgba(255,255,255,.04);}
        .cu-emote img{width:40px;height:40px;object-fit:contain;}
        .cu-emote code{font-size:10px;opacity:.8;word-break:break-all;text-align:center;}
        .cu-sound{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border-radius:8px;background:rgba(255,255,255,.04);}
        .cu-sound .cu-cmd{font-weight:700;color:var(--accent,#c0965c);}
        .cu-sound .cu-meta{font-size:11px;opacity:.6;margin-left:auto;}
        .cu-del{background:none;border:none;color:#e66;cursor:pointer;font-size:12px;opacity:.8;}
        .cu-del:hover{opacity:1;}
        .cu-empty{opacity:.5;font-size:13px;padding:8px 0;}
        .cu-set-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px;}
        .cu-set-row input[type=number]{width:84px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:inherit;}
        .cu-set-group{border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px 12px;}
        .cu-set-group-title{font-weight:700;font-size:12px;opacity:.85;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px;}
        .cu-size-row{display:flex;align-items:center;gap:8px;font-size:13px;}
        .cu-size-row input[type=range]{flex:1;}
        .cu-count{background:var(--accent,#c0965c);color:#111;border-radius:10px;padding:0 7px;font-size:11px;font-weight:700;margin-left:2px;}
        .cu-sound-group{width:100%;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:6px 8px;margin-bottom:6px;}
        .cu-sound-cmd-hd{display:flex;align-items:center;gap:6px;margin-bottom:2px;}
        `;
        const el = document.createElement('style');
        el.id = 'cu-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    function close() {
        if (overlay) { overlay.remove(); overlay = null; }
    }

    // Is the current viewer the streamer/owner (or a global mod) of this channel?
    function isChannelOwner() {
        try {
            if (typeof canModerateCurrentStream === 'function') return canModerateCurrentStream();
            const csd = window.currentStreamData, cu = window.currentUser;
            return !!(csd && cu && csd.user_id === cu.id);
        } catch { return false; }
    }

    function render() {
        overlay.querySelectorAll('.cu-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === curTab));
        const body = overlay.querySelector('.cu-body');
        if (curTab === 'settings') renderSettingsTab(body);
        else if (curTab === 'sound') renderSoundTab(body);
        else renderEmoteTab(body);
    }

    function renderEmoteTab(body) {
        body.innerHTML = `
            <form class="cu-form" id="cu-emote-form">
                <input type="text" id="cu-emote-code" maxlength="32" placeholder="Emote code (letters/numbers/_)" autocomplete="off">
                <input type="file" id="cu-emote-file" accept="image/png,image/gif,image/webp,image/jpeg,image/avif">
                <div class="cu-size-row">
                    <span>Size <b id="cu-emote-size-val">100%</b></span>
                    <input type="range" id="cu-emote-size" min="25" max="400" step="5" value="100"
                        oninput="document.getElementById('cu-emote-size-val').textContent=this.value+'%'">
                </div>
                <button class="cu-btn" type="submit">Upload emote to this channel</button>
                <div class="cu-hint">Type the code in chat to use it. PNG/GIF/WebP/JPEG, up to 256&nbsp;KB. Size is clamped to the streamer's allowed range.</div>
            </form>
            <div id="cu-emote-list" class="cu-list"><span class="cu-empty">Loading…</span></div>`;
        overlay.querySelector('#cu-emote-form').addEventListener('submit', submitEmote);
        loadEmoteList();
    }

    function renderSoundTab(body) {
        body.innerHTML = `
            <form class="cu-form" id="cu-sound-form">
                <input type="text" id="cu-sound-cmd" maxlength="24" placeholder="Command name (e.g. airhorn) → !airhorn" autocomplete="off">
                <input type="file" id="cu-sound-file" accept="audio/*">
                <div id="cu-sound-preview" style="display:none;margin:2px 0"></div>
                <button class="cu-btn" type="submit">Upload sound to this channel</button>
                <div class="cu-hint">Trigger it by typing <b>!command</b> in chat. MP3/WAV/OGG, within the streamer's max length. Upload several under the <b>same command</b> and one plays at random each time.</div>
            </form>
            <div id="cu-sound-list" class="cu-list" style="flex-direction:column;"><span class="cu-empty">Loading…</span></div>`;
        overlay.querySelector('#cu-sound-form').addEventListener('submit', submitSound);
        // Preview the attached file before uploading.
        const fileInput = overlay.querySelector('#cu-sound-file');
        fileInput.addEventListener('change', () => {
            const preview = overlay.querySelector('#cu-sound-preview');
            if (_soundPreviewUrl) { try { URL.revokeObjectURL(_soundPreviewUrl); } catch {} _soundPreviewUrl = null; }
            const f = fileInput.files[0];
            if (!f) { preview.style.display = 'none'; preview.innerHTML = ''; return; }
            _soundPreviewUrl = URL.createObjectURL(f);
            const sizeKb = (f.size / 1024).toFixed(0);
            preview.style.display = '';
            preview.innerHTML = `<audio controls preload="metadata" src="${_soundPreviewUrl}" style="width:100%;height:34px"></audio>
                <div class="cu-hint" style="margin-top:2px">Preview: <b>${esc(f.name)}</b> · ${sizeKb} KB</div>`;
        });
        loadSoundList();
    }

    // Streamer-only tab: emote size limits + emote/sound toggles for the channel.
    async function renderSettingsTab(body) {
        body.innerHTML = '<div class="cu-empty">Loading channel settings…</div>';
        let ch = null;
        try {
            const r = await fetch('/api/channels/moderation/mine', { headers: { Authorization: `Bearer ${token()}` } });
            const data = await r.json();
            const list = data.channels || [];
            const ownerId = (window.currentStreamData && window.currentStreamData.user_id) || (window.currentUser && window.currentUser.id) || null;
            ch = list.find((c) => c.user_id === ownerId) || list[0] || null;
        } catch { /* */ }
        if (!ch) { body.innerHTML = '<div class="cu-empty">Could not load your channel settings.</div>'; return; }
        const s = ch.moderation_settings || {};
        const num = (v, d) => (v == null ? d : v);
        const chk = (v, d) => (num(v, d) ? 'checked' : '');
        body.innerHTML = `
            <div class="cu-form" style="gap:12px" data-channel-id="${ch.id}">
                <div class="cu-set-group">
                    <div class="cu-set-group-title">Emotes</div>
                    <label class="cu-set-row"><span>Custom emotes enabled</span><input type="checkbox" id="cu-set-emotes" ${chk(s.custom_emotes_enabled, 1)}></label>
                    <label class="cu-set-row"><span>Only mods can upload</span><input type="checkbox" id="cu-set-modsonly" ${chk(s.uploads_mods_only, 0)}></label>
                    <label class="cu-set-row"><span>Channel emote scale (%)</span><input type="number" id="cu-set-scale" min="50" max="300" value="${num(s.emote_scale, 100)}"></label>
                    <label class="cu-set-row"><span>Min per-emote size (%)</span><input type="number" id="cu-set-emin" min="25" max="200" value="${num(s.emote_size_min, 50)}"></label>
                    <label class="cu-set-row"><span>Max per-emote size (%)</span><input type="number" id="cu-set-emax" min="50" max="400" value="${num(s.emote_size_max, 200)}"></label>
                </div>
                <div class="cu-set-group">
                    <div class="cu-set-group-title">Sounds</div>
                    <label class="cu-set-row"><span>Custom sounds enabled</span><input type="checkbox" id="cu-set-sounds" ${chk(s.custom_sounds_enabled, 1)}></label>
                    <label class="cu-set-row"><span>Max sound length (s)</span><input type="number" id="cu-set-maxsec" min="1" max="30" value="${num(s.max_sound_seconds, 10)}"></label>
                </div>
                <button class="cu-btn" id="cu-set-save" type="button">Save channel settings</button>
                <div class="cu-hint">Applies to everyone in your channel's chat. Pitch/speed limits live in your dashboard's moderation panel.</div>
            </div>`;
        overlay.querySelector('#cu-set-save').onclick = () => saveChannelSettings(ch.id);
    }

    async function saveChannelSettings(channelId) {
        const g = (id) => overlay.querySelector(id);
        const payload = {
            custom_emotes_enabled: g('#cu-set-emotes').checked,
            uploads_mods_only: g('#cu-set-modsonly').checked,
            emote_scale: parseInt(g('#cu-set-scale').value) || 100,
            emote_size_min: parseInt(g('#cu-set-emin').value) || 50,
            emote_size_max: parseInt(g('#cu-set-emax').value) || 200,
            custom_sounds_enabled: g('#cu-set-sounds').checked,
            max_sound_seconds: parseInt(g('#cu-set-maxsec').value) || 10,
        };
        const btn = g('#cu-set-save');
        btn.disabled = true;
        try {
            const r = await fetch(`/api/channels/${channelId}/moderation`, {
                method: 'PUT', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Save failed');
            notify('Channel settings saved', 'success');
        } catch (e) { notify(e.message, 'error'); }
        finally { btn.disabled = false; }
    }

    async function loadEmoteList() {
        const box = overlay && overlay.querySelector('#cu-emote-list');
        if (!box) return;
        try {
            const r = await fetch(`/api/emotes/all/${curStreamId}`);
            const data = await r.json();
            const list = (data.channel || data.emotes || []).filter((e) => e.source === 'channel');
            if (!list.length) { box.innerHTML = '<span class="cu-empty">No channel emotes yet — be the first!</span>'; return; }
            box.innerHTML = list.map((e) => `
                <div class="cu-emote">
                    <img src="${esc(e.url)}" alt="${esc(e.code)}" loading="lazy">
                    <code>${esc(e.code)}${e.size && e.size !== 100 ? ` · ${e.size}%` : ''}</code>
                    ${e.emote_id ? `<button class="cu-del" title="Delete" onclick="__cuDeleteEmote(${e.emote_id})">✕</button>` : ''}
                </div>`).join('');
        } catch { box.innerHTML = '<span class="cu-empty">Could not load emotes.</span>'; }
    }

    async function loadSoundList() {
        const box = overlay && overlay.querySelector('#cu-sound-list');
        if (!box) return;
        try {
            const r = await fetch(`/api/sounds/all/${curStreamId}`);
            const data = await r.json();
            const list = data.sounds || [];
            if (!list.length) { box.innerHTML = '<span class="cu-empty">No channel sounds yet — be the first!</span>'; return; }
            // Group by command — a command can hold several sounds; one is chosen at random on play.
            const groups = {};
            list.forEach((s) => { (groups[s.command] = groups[s.command] || []).push(s); });
            box.innerHTML = Object.keys(groups).sort().map((cmd) => {
                const arr = groups[cmd];
                return `<div class="cu-sound-group">
                    <div class="cu-sound-cmd-hd"><span class="cu-cmd">!${esc(cmd)}</span>${arr.length > 1 ? `<span class="cu-count">×${arr.length}</span> <span class="cu-hint" style="opacity:.55">random</span>` : ''}</div>
                    ${arr.map((s) => `<div class="cu-sound" style="margin-left:10px">
                        <button class="cu-btn" style="padding:3px 8px;font-size:12px;" onclick="__cuPreviewSound('${esc(s.url)}')">▶</button>
                        <span class="cu-meta">${(s.duration_seconds || 0).toFixed ? s.duration_seconds.toFixed(1) : s.duration_seconds}s · ${esc(s.uploader || '')}</span>
                        <button class="cu-del" title="Delete" onclick="__cuDeleteSound(${s.id})">✕</button>
                    </div>`).join('')}
                </div>`;
            }).join('');
        } catch { box.innerHTML = '<span class="cu-empty">Could not load sounds.</span>'; }
    }

    async function submitEmote(ev) {
        ev.preventDefault();
        if (!token()) { notify('Log in to upload emotes.', 'error'); return; }
        const code = overlay.querySelector('#cu-emote-code').value.trim();
        const file = overlay.querySelector('#cu-emote-file').files[0];
        if (!code || !file) { notify('Enter a code and pick an image.', 'error'); return; }
        const btn = ev.target.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            const fd = new FormData();
            fd.append('code', code);
            fd.append('stream_id', curStreamId);
            fd.append('image', file);
            const sizeEl = overlay.querySelector('#cu-emote-size');
            if (sizeEl) fd.append('size', sizeEl.value || '100');
            const r = await fetch('/api/emotes', { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: fd });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Upload failed');
            notify(`Emote "${code}" added to the channel!`, 'success');
            overlay.querySelector('#cu-emote-code').value = '';
            overlay.querySelector('#cu-emote-file').value = '';
            loadEmoteList();
            if (typeof loadEmotes === 'function' && curStreamId) loadEmotes(curStreamId);
        } catch (e) { notify(e.message, 'error'); }
        finally { btn.disabled = false; }
    }

    async function submitSound(ev) {
        ev.preventDefault();
        if (!token()) { notify('Log in to upload sounds.', 'error'); return; }
        const cmd = overlay.querySelector('#cu-sound-cmd').value.trim();
        const file = overlay.querySelector('#cu-sound-file').files[0];
        if (!cmd || !file) { notify('Enter a command and pick an audio file.', 'error'); return; }
        const btn = ev.target.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            const fd = new FormData();
            fd.append('command', cmd);
            fd.append('stream_id', curStreamId);
            fd.append('sound', file);
            const r = await fetch('/api/sounds', { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: fd });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Upload failed');
            notify(`Sound !${cmd} added — type it in chat to play it!`, 'success');
            overlay.querySelector('#cu-sound-cmd').value = '';
            overlay.querySelector('#cu-sound-file').value = '';
            const preview = overlay.querySelector('#cu-sound-preview');
            if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
            if (_soundPreviewUrl) { try { URL.revokeObjectURL(_soundPreviewUrl); } catch {} _soundPreviewUrl = null; }
            loadSoundList();
        } catch (e) { notify(e.message, 'error'); }
        finally { btn.disabled = false; }
    }

    window.__cuDeleteEmote = async function (id) {
        if (!token()) return notify('Log in first.', 'error');
        try {
            const r = await fetch(`/api/emotes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Delete failed');
            notify('Emote removed.', 'success');
            loadEmoteList();
            if (typeof loadEmotes === 'function' && curStreamId) loadEmotes(curStreamId);
        } catch (e) { notify(e.message, 'error'); }
    };

    window.__cuDeleteSound = async function (id) {
        if (!token()) return notify('Log in first.', 'error');
        try {
            const r = await fetch(`/api/sounds/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Delete failed');
            notify('Sound removed.', 'success');
            loadSoundList();
        } catch (e) { notify(e.message, 'error'); }
    };

    let _previewAudio = null;
    window.__cuPreviewSound = function (url) {
        try { if (_previewAudio) { _previewAudio.pause(); } _previewAudio = new Audio(url); _previewAudio.volume = 0.7; _previewAudio.play().catch(() => {}); } catch {}
    };

    window.openChannelUploadModal = function (streamId) {
        curStreamId = resolveStreamId(streamId);
        if (!curStreamId) { notify('Open a live channel first to add emotes or sounds.', 'error'); return; }
        ensureStyles();
        close();
        overlay = document.createElement('div');
        overlay.className = 'cu-overlay';
        overlay.innerHTML = `
            <div class="cu-modal" role="dialog" aria-modal="true">
                <div class="cu-head">
                    <h3><i class="fa-solid fa-plus"></i> Add to this channel</h3>
                    <button class="cu-close" aria-label="Close">&times;</button>
                </div>
                <div class="cu-tabs">
                    <button class="cu-tab" data-tab="emote"><i class="fa-solid fa-face-grin-stars"></i> Emote</button>
                    <button class="cu-tab" data-tab="sound"><i class="fa-solid fa-volume-high"></i> Sound</button>
                    ${isChannelOwner() ? '<button class="cu-tab" data-tab="settings"><i class="fa-solid fa-sliders"></i> Settings</button>' : ''}
                </div>
                <div class="cu-body"></div>
            </div>`;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('.cu-close').addEventListener('click', close);
        overlay.querySelectorAll('.cu-tab').forEach((t) => t.addEventListener('click', () => { curTab = t.dataset.tab; render(); }));
        document.body.appendChild(overlay);
        curTab = 'emote';
        render();
    };
})();
