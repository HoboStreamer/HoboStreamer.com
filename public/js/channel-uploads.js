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
        `;
        const el = document.createElement('style');
        el.id = 'cu-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    function close() {
        if (overlay) { overlay.remove(); overlay = null; }
    }

    function render() {
        overlay.querySelectorAll('.cu-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === curTab));
        const body = overlay.querySelector('.cu-body');
        if (curTab === 'emote') renderEmoteTab(body);
        else renderSoundTab(body);
    }

    function renderEmoteTab(body) {
        body.innerHTML = `
            <form class="cu-form" id="cu-emote-form">
                <input type="text" id="cu-emote-code" maxlength="32" placeholder="Emote code (letters/numbers/_)" autocomplete="off">
                <input type="file" id="cu-emote-file" accept="image/png,image/gif,image/webp,image/jpeg,image/avif">
                <button class="cu-btn" type="submit">Upload emote to this channel</button>
                <div class="cu-hint">Type the code in chat to use it. PNG/GIF/WebP/JPEG, up to 256&nbsp;KB.</div>
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
                <div class="cu-hint">Trigger it by typing <b>!command</b> in chat. MP3/WAV/OGG, within the streamer's max length.</div>
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
                    <code>${esc(e.code)}</code>
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
            box.innerHTML = list.map((s) => `
                <div class="cu-sound">
                    <span class="cu-cmd">!${esc(s.command)}</span>
                    <button class="cu-btn" style="padding:3px 8px;font-size:12px;" onclick="__cuPreviewSound('${esc(s.url)}')">▶</button>
                    <span class="cu-meta">${(s.duration_seconds || 0).toFixed ? s.duration_seconds.toFixed(1) : s.duration_seconds}s · ${esc(s.uploader || '')}</span>
                    <button class="cu-del" title="Delete" onclick="__cuDeleteSound(${s.id})">✕</button>
                </div>`).join('');
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
