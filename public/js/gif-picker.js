/**
 * HoboStreamer — GIF Picker (Tenor)
 *
 * Provides a searchable GIF picker that integrates with the chat input.
 * Uses Tenor's free v2 API. Selected GIFs are inserted as [gif:url] tags.
 */

// ── State ─────────────────────────────────────────────────────
let _gifPickerOpen = false;
let _gifPickerTarget = 'chat-input'; // which textarea to insert into
let _gifSearchDebounce = null;
let _gifApiKey = ''; // loaded from server settings
let _gifsEnabled = true; // per-channel or global setting

const GIF_ALLOWED_DOMAINS = ['tenor.com', 'media.tenor.com', 'media1.tenor.com', 'c.tenor.com', 'giphy.com', 'media.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'i.giphy.com'];
const GIF_TAG_RE = /\[gif:(https?:\/\/[^\]]+)\]/g;

/**
 * Validate that a URL points to an allowed GIF domain.
 */
function isAllowedGifUrl(url) {
    try {
        const parsed = new URL(url);
        return GIF_ALLOWED_DOMAINS.includes(parsed.hostname);
    } catch { return false; }
}

/**
 * Parse [gif:url] tags in message text and return HTML with inline images.
 * Called from parseEmotes() flow.
 */
function renderGifTags(html) {
    if (!_gifsEnabled) return html;
    return html.replace(GIF_TAG_RE, (match, url) => {
        if (!isAllowedGifUrl(url)) return match; // leave as text if untrusted domain
        const safeUrl = url.replace(/[<>"']/g, ''); // basic attribute safety
        return `<img class="chat-gif" src="${safeUrl}" alt="GIF" loading="lazy" draggable="false" onclick="window.open('${safeUrl}','_blank')">`;
    });
}

/**
 * Set whether GIFs are enabled (called when joining a channel).
 */
function setGifsEnabled(enabled) {
    _gifsEnabled = enabled;
}

/**
 * Set the Tenor API key (loaded from server).
 */
function setGifApiKey(key) {
    _gifApiKey = key || '';
}

// ── GIF Picker UI ──────────────────────────────────────────────

/**
 * Toggle the GIF picker for a specific chat input.
 */
function toggleGifPicker(inputId) {
    _gifPickerTarget = inputId || 'chat-input';
    const picker = document.getElementById('gif-picker');
    if (!picker) return;

    _gifPickerOpen = !_gifPickerOpen;
    picker.style.display = _gifPickerOpen ? 'flex' : 'none';

    if (_gifPickerOpen) {
        const search = picker.querySelector('.gif-search');
        if (search) { search.value = ''; search.focus(); }
        _loadTrendingGifs();
    }
}

/**
 * Close the GIF picker if open.
 */
function closeGifPicker() {
    _gifPickerOpen = false;
    const picker = document.getElementById('gif-picker');
    if (picker) picker.style.display = 'none';
}

/**
 * Search Tenor for GIFs.
 */
function onGifSearch(query) {
    clearTimeout(_gifSearchDebounce);
    _gifSearchDebounce = setTimeout(() => {
        if (!query || query.length < 2) {
            _loadTrendingGifs();
        } else {
            _searchGifs(query);
        }
    }, 300);
}

async function _loadTrendingGifs() {
    if (!_gifApiKey) {
        _renderGifGrid('<p class="muted" style="padding:12px">GIF API key not configured</p>');
        return;
    }
    try {
        const res = await fetch(`https://tenor.googleapis.com/v2/featured?key=${encodeURIComponent(_gifApiKey)}&limit=30&media_filter=tinygif,gif`);
        const data = await res.json();
        _renderGifResults(data.results || []);
    } catch {
        _renderGifGrid('<p class="muted" style="padding:12px">Failed to load GIFs</p>');
    }
}

async function _searchGifs(query) {
    if (!_gifApiKey) return;
    try {
        const res = await fetch(`https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(_gifApiKey)}&q=${encodeURIComponent(query)}&limit=30&media_filter=tinygif,gif`);
        const data = await res.json();
        _renderGifResults(data.results || []);
    } catch {
        _renderGifGrid('<p class="muted" style="padding:12px">Search failed</p>');
    }
}

function _renderGifResults(results) {
    if (!results.length) {
        _renderGifGrid('<p class="muted" style="padding:12px">No GIFs found</p>');
        return;
    }
    const html = results.map(r => {
        const tiny = r.media_formats?.tinygif?.url || r.media_formats?.gif?.url || '';
        const full = r.media_formats?.gif?.url || tiny;
        if (!tiny) return '';
        return `<img class="gif-picker-item" src="${tiny.replace(/[<>"']/g, '')}" alt="${(r.content_description || '').replace(/[<>"']/g, '')}" loading="lazy" onclick="selectGif('${full.replace(/'/g, "\\'")}')">`;
    }).join('');
    _renderGifGrid(html);
}

function _renderGifGrid(html) {
    const grid = document.getElementById('gif-picker-grid');
    if (grid) grid.innerHTML = html;
}

/**
 * Insert selected GIF URL into the target chat input.
 */
function selectGif(url) {
    if (!isAllowedGifUrl(url)) return;
    const input = document.getElementById(_gifPickerTarget);
    if (!input) return;

    // Replace the entire message with just the GIF tag (GIF-only messages)
    input.value = `[gif:${url}]`;
    input.focus();
    closeGifPicker();

    // Auto-send if the input has a send handler
    if (typeof sendChat === 'function') {
        sendChat(input);
    }
}

/**
 * Create the GIF picker HTML and inject it into a chat-input-area.
 * Called once per chat-input-area that needs GIF support.
 */
function ensureGifPicker(chatInputAreaEl) {
    if (!chatInputAreaEl || chatInputAreaEl.querySelector('#gif-picker')) return;
    const picker = document.createElement('div');
    picker.id = 'gif-picker';
    picker.className = 'gif-picker';
    picker.style.display = 'none';
    picker.innerHTML = `
        <div class="gif-picker-header">
            <input type="text" class="gif-search" placeholder="Search GIFs..." oninput="onGifSearch(this.value)">
        </div>
        <div class="gif-picker-grid" id="gif-picker-grid"></div>
        <div class="gif-picker-footer">
            <span class="muted" style="font-size:0.7rem">Powered by Tenor</span>
        </div>
    `;
    chatInputAreaEl.insertBefore(picker, chatInputAreaEl.firstChild);
}
