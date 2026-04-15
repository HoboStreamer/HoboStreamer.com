/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Emote System (Client)
   Loads emotes from FFZ, BTTV, 7TV, defaults, and custom
   (global + channel). Provides emote picker UI and inline
   parsing for chat messages.
   ═══════════════════════════════════════════════════════════════ */

/** All available emotes for the current stream context, keyed by code */
let emoteMap = new Map();
/** Categorised arrays for the picker */
let emoteCategories = { defaults: [], channel: [], global: [], ffz: [], bttv: [], '7tv': [] };
/** Whether emotes have been loaded */
let emotesLoaded = false;
let _emotePickerOpen = false;
let _emotePickerTarget = null; // which picker element is active
let _emoteSearchTimeout = null;

/* ── Load emotes for a stream context ─────────────────────────── */
async function loadEmotes(streamId) {
    try {
        const data = await api(`/emotes/all/${streamId || 0}`);
        emoteCategories = {
            defaults: data.defaults || [],
            channel: data.channel || [],
            global: data.global || [],
            ffz: data.ffz || [],
            bttv: data.bttv || [],
            '7tv': data['7tv'] || [],
        };

        // Build lookup map — higher priority sources overwrite lower
        emoteMap.clear();
        for (const e of emoteCategories.bttv)     emoteMap.set(e.code, e);
        for (const e of emoteCategories['7tv'])    emoteMap.set(e.code, e);
        for (const e of emoteCategories.ffz)       emoteMap.set(e.code, e);
        for (const e of emoteCategories.defaults)  emoteMap.set(e.code, e);
        for (const e of emoteCategories.global)    emoteMap.set(e.code, e);
        for (const e of emoteCategories.channel)   emoteMap.set(e.code, e);

        emotesLoaded = true;
        const total = emoteMap.size;
        const cats = emoteCategories;
        console.log(`[Emotes] Loaded ${total} emotes (${cats.defaults.length} defaults, ${cats.channel.length} channel, ${cats.global.length} custom, ${cats.ffz.length} FFZ, ${cats.bttv.length} BTTV, ${cats['7tv'].length} 7TV)`);
    } catch (e) {
        console.warn('[Emotes] Failed to load emotes', e);
    }
}

/* ── URL detection regex ───────────────────────────────────────── */
const _URL_RE = /^(https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+\.[^\s<>"'`]+)$/i;

/* ── Kick inline emote format: [emote:name:id] → img tag ─────── */
const _KICK_EMOTE_RE = /\[emote:([^\]:]+):(\d+)\]/g;

/** Replace Kick inline [emote:name:id] tokens with <img> tags, return segments */
function _substituteKickEmotes(text) {
    // Returns an array of strings (plain text or img HTML) for eventual joining
    const parts = [];
    let last = 0;
    let m;
    _KICK_EMOTE_RE.lastIndex = 0;
    while ((m = _KICK_EMOTE_RE.exec(text)) !== null) {
        if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
        const name = m[1];
        const id   = m[2];
        // Validate: id must be purely numeric (already matched \d+), name must be short
        if (id.length <= 12 && name.length <= 64) {
            const url = `https://files.kick.com/emotes/${id}/fullsize`;
            parts.push({ type: 'html', value: `<img class="chat-emote" src="${_escEmote(url)}" alt="${_escEmote(':' + name + ':')}" title="${_escEmote(':' + name + ':')}" loading="lazy" draggable="false">` });
        } else {
            parts.push({ type: 'text', value: m[0] });
        }
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    return parts;
}

/* ── Parse emote codes + linkify URLs in a message string → HTML ── */
function parseEmotes(text) {
    // First pass: expand Kick inline [emote:name:id] tags regardless of loaded state
    const segments = _substituteKickEmotes(text);

    let result;
    if (!emotesLoaded || emoteMap.size === 0) {
        result = segments.map(seg => seg.type === 'html' ? seg.value : _linkifyPlain(seg.value)).join('');
    } else {
        result = segments.map(seg => {
            if (seg.type === 'html') return seg.value;
            const tokens = seg.value.split(/(\s+)/);
            return tokens.map(token => {
                if (/^\s+$/.test(token)) return token;
                const emote = emoteMap.get(token);
                if (emote) {
                    const cls = emote.animated ? 'chat-emote chat-emote-animated' : 'chat-emote';
                    return `<img class="${cls}" src="${_escEmote(emote.url)}" alt="${_escEmote(token)}" title="${_escEmote(token)}" loading="lazy" draggable="false">`;
                }
                if (_URL_RE.test(token)) return _makeChatLink(token);
                return _escEmote(token);
            }).join('');
        }).join('');
    }

    // Render [gif:url] tags as inline images
    if (typeof renderGifTags === 'function') result = renderGifTags(result);
    return result;
}

/** Linkify plain text (fallback when emotes not loaded) */
function _linkifyPlain(text) {
    return text.split(/(\s+)/).map(token => {
        if (/^\s+$/.test(token)) return token;
        if (_URL_RE.test(token)) return _makeChatLink(token);
        return _escEmote(token);
    }).join('');
}

/** Build a clickable chat link element string */
function _makeChatLink(raw) {
    // Strip trailing punctuation that's unlikely to be part of the URL
    let url = raw;
    let trailing = '';
    const trailingMatch = url.match(/[)}\].,;:!?]+$/);
    if (trailingMatch) {
        const stripped = trailingMatch[0];
        const openParens = (url.match(/\(/g) || []).length;
        const closeParens = (url.match(/\)/g) || []).length;
        if (closeParens > openParens && stripped.includes(')')) {
            trailing = stripped;
            url = url.slice(0, -stripped.length);
        } else if (!stripped.includes(')')) {
            trailing = stripped;
            url = url.slice(0, -stripped.length);
        }
    }
    const href = url.startsWith('www.') ? 'https://' + url : url;
    const escaped = _escEmote(url);
    const escapedHref = _escEmote(href);
    return `<a class="chat-link" href="${escapedHref}" data-url="${escapedHref}" onclick="handleChatLinkClick(event)" oncontextmenu="showLinkContextMenu(event)" title="${escapedHref}">${escaped}</a>${_escEmote(trailing)}`;
}
function _escEmote(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

/* ══════════════════════════════════════════════════════════════
   EMOTE PICKER — supports both channel chat and broadcast chat
   ══════════════════════════════════════════════════════════════ */

/**
 * Detect which picker + grid to use based on the target input.
 * Returns { picker, grid, search } DOM elements.
 */
function _getPickerEls(inputId) {
    const isBc = inputId && inputId.startsWith('bc-');
    const isGlobal = inputId === 'global-chat-input';
    const isOffline = inputId === 'offline-chat-input';
    const prefix = isBc ? 'bc-' : isGlobal ? 'gc-' : isOffline ? 'oc-' : '';
    return {
        picker: document.getElementById(prefix + 'emote-picker'),
        grid:   document.getElementById(prefix + 'emote-picker-grid'),
        search: prefix
            ? document.querySelector('#' + prefix + 'emote-picker .emote-search')
            : document.getElementById('emote-search'),
    };
}

function toggleEmotePicker(inputId) {
    const { picker } = _getPickerEls(inputId);
    if (!picker) return;

    // Close any other open picker first
    if (_emotePickerTarget && _emotePickerTarget !== inputId) {
        const prev = _getPickerEls(_emotePickerTarget);
        if (prev.picker) prev.picker.style.display = 'none';
    }

    _emotePickerOpen = !_emotePickerOpen || _emotePickerTarget !== inputId;
    _emotePickerTarget = inputId;
    picker.style.display = _emotePickerOpen ? 'flex' : 'none';
    picker.dataset.targetInput = inputId || 'chat-input';

    if (_emotePickerOpen && emotesLoaded) {
        renderEmotePicker('all');
    }
}

function renderEmotePicker(tab) {
    const { grid, search } = _getPickerEls(_emotePickerTarget);
    if (!grid) return;

    // Update ALL tab buttons in the active picker's parent
    const pickerEl = grid.closest('.emote-picker');
    if (pickerEl) {
        pickerEl.querySelectorAll('.emote-tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === tab);
        });
    }

    let emotes = [];
    const query = (search?.value || '').toLowerCase().trim();

    switch (tab) {
        case 'all':
            emotes = [
                ...emoteCategories.defaults,
                ...emoteCategories.channel,
                ...emoteCategories.global,
                ...emoteCategories.ffz,
                ...emoteCategories.bttv,
                ...emoteCategories['7tv'],
            ];
            break;
        case 'defaults': emotes = emoteCategories.defaults; break;
        case 'channel':  emotes = emoteCategories.channel;  break;
        case 'global':   emotes = emoteCategories.global;   break;
        case 'ffz':      emotes = emoteCategories.ffz;      break;
        case 'bttv':     emotes = emoteCategories.bttv;     break;
        case '7tv':      emotes = emoteCategories['7tv'];   break;
        default:         emotes = [];
    }

    if (query) {
        emotes = emotes.filter(e => e.code.toLowerCase().includes(query));
    }

    if (!emotes.length) {
        grid.innerHTML = '<div class="emote-picker-empty">No emotes found</div>';
        return;
    }

    grid.innerHTML = emotes.slice(0, 300).map(e => {
        const cls = e.animated ? 'emote-picker-item emote-animated' : 'emote-picker-item';
        return `<div class="${cls}" title="${_escEmote(e.code)}" onclick="insertEmote('${_escEmote(e.code).replace(/'/g, "\\'")}')">
            <img src="${e.url}" alt="${_escEmote(e.code)}" loading="lazy" draggable="false">
        </div>`;
    }).join('');
}

function insertEmote(code) {
    const picker = _getPickerEls(_emotePickerTarget).picker;
    const inputId = picker?.dataset.targetInput || _emotePickerTarget || 'chat-input';
    const input = document.getElementById(inputId);
    if (!input) return;

    const cursor = input.selectionStart || input.value.length;
    const before = input.value.slice(0, cursor);
    const after = input.value.slice(cursor);
    const space = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
    const trailing = after.startsWith(' ') || after.length === 0 ? '' : ' ';
    input.value = before + space + code + trailing + after;
    input.focus();
    const newPos = cursor + space.length + code.length + trailing.length;
    input.setSelectionRange(newPos, newPos);
}

function onEmoteSearch(value) {
    clearTimeout(_emoteSearchTimeout);
    _emoteSearchTimeout = setTimeout(() => {
        const pickerEl = _getPickerEls(_emotePickerTarget).picker;
        if (!pickerEl) return;
        const activeTab = pickerEl.querySelector('.emote-tab-btn.active');
        renderEmotePicker(activeTab?.dataset.tab || 'all');
    }, 150);
}

/* ── FFZ Search (remote) ──────────────────────────────────────── */
async function searchFFZEmotes(query) {
    if (!query || query.length < 2) return;
    const { grid } = _getPickerEls(_emotePickerTarget);
    if (!grid) return;
    grid.innerHTML = '<div class="emote-picker-empty"><i class="fa-solid fa-spinner fa-spin"></i> Searching FFZ...</div>';

    try {
        const data = await api(`/emotes/search?q=${encodeURIComponent(query)}`);
        const emotes = data.emotes || [];
        if (!emotes.length) {
            grid.innerHTML = '<div class="emote-picker-empty">No FFZ emotes found</div>';
            return;
        }
        grid.innerHTML = emotes.map(e => {
            const cls = e.animated ? 'emote-picker-item emote-animated' : 'emote-picker-item';
            return `<div class="${cls}" title="${_escEmote(e.code)}" onclick="insertEmote('${_escEmote(e.code).replace(/'/g, "\\'")}')">
                <img src="${e.url}" alt="${_escEmote(e.code)}" loading="lazy" draggable="false">
            </div>`;
        }).join('');
    } catch {
        grid.innerHTML = '<div class="emote-picker-empty">Search failed</div>';
    }
}

/* ══════════════════════════════════════════════════════════════
   DASHBOARD — Manage My Emotes
   ══════════════════════════════════════════════════════════════ */

async function loadDashEmotes() {
    const container = document.getElementById('dash-emotes-list');
    if (!container) return;

    // Load source preferences
    loadDashEmoteSources();

    try {
        const data = await api('/emotes/mine');
        const emotes = data.emotes || [];
        const count = data.count || 0;
        const max = data.max || 50;

        const countEl = document.getElementById('dash-emote-count');
        if (countEl) countEl.textContent = `${count} / ${max}`;

        if (!emotes.length) {
            container.innerHTML = '<p class="muted">No custom emotes yet. Upload your first emote!</p>';
            return;
        }

        container.innerHTML = emotes.map(e => `
            <div class="dash-emote-item">
                <img src="${e.url}" alt="${_escEmote(e.code)}" class="${e.animated ? 'emote-animated' : ''}">
                <span class="dash-emote-code">${_escEmote(e.code)}</span>
                ${e.is_global ? '<span class="badge badge-accent">Global</span>' : ''}
                <button class="btn btn-small btn-danger" onclick="deleteDashEmote(${e.id})">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `).join('');
    } catch {
        container.innerHTML = '<p class="muted">Failed to load emotes</p>';
    }
}

async function loadDashEmoteSources() {
    try {
        const data = await api('/emotes/sources');
        const src = data.sources || {};
        const ids = { defaults: 'emote-src-defaults', custom: 'emote-src-custom', ffz: 'emote-src-ffz', bttv: 'emote-src-bttv', '7tv': 'emote-src-7tv' };
        for (const [key, elId] of Object.entries(ids)) {
            const el = document.getElementById(elId);
            if (el) el.checked = src[key] !== false;
        }
    } catch { /* silent */ }
}

async function saveEmoteSources() {
    const sources = {
        defaults: document.getElementById('emote-src-defaults')?.checked ?? true,
        custom:   document.getElementById('emote-src-custom')?.checked ?? true,
        ffz:      document.getElementById('emote-src-ffz')?.checked ?? true,
        bttv:     document.getElementById('emote-src-bttv')?.checked ?? true,
        '7tv':    document.getElementById('emote-src-7tv')?.checked ?? true,
    };
    try {
        await api('/emotes/sources', { method: 'PUT', body: sources });
        toast('Emote sources saved', 'success');
    } catch (e) {
        toast(e.message || 'Failed to save', 'error');
    }
}

async function uploadDashEmote() {
    const codeInput = document.getElementById('emote-upload-code');
    const fileInput = document.getElementById('emote-upload-file');
    if (!codeInput || !fileInput) return;

    const code = codeInput.value.trim();
    if (!code) return toast('Enter an emote code', 'error');
    if (!fileInput.files.length) return toast('Select an image file', 'error');

    const formData = new FormData();
    formData.append('code', code);
    formData.append('image', fileInput.files[0]);

    try {
        const tok = localStorage.getItem('token');
        const res = await fetch('/api/emotes', {
            method: 'POST',
            headers: { Authorization: `Bearer ${tok}` },
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw { message: data.error };
        toast(`Emote "${code}" uploaded!`, 'success');
        codeInput.value = '';
        fileInput.value = '';
        loadDashEmotes();
    } catch (e) {
        toast(e.message || 'Upload failed', 'error');
    }
}

async function deleteDashEmote(id) {
    if (!confirm('Delete this emote?')) return;
    try {
        await api(`/emotes/${id}`, { method: 'DELETE' });
        toast('Emote deleted', 'success');
        loadDashEmotes();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Close picker on outside click ────────────────────────────── */
document.addEventListener('click', (e) => {
    if (!_emotePickerOpen) return;
    if (e.target.closest('.emote-picker') || e.target.closest('.emote-picker-btn')) return;
    _emotePickerOpen = false;
    // Close both pickers
    const p1 = document.getElementById('emote-picker');
    const p2 = document.getElementById('bc-emote-picker');
    if (p1) p1.style.display = 'none';
    if (p2) p2.style.display = 'none';
});
