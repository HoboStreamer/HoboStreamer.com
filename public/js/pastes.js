/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Pastes & Screenshots
   Pastebin-style sharing with syntax highlighting, screenshot capture,
   public/unlisted modes, burn-after-read, and chat integration.
   ═══════════════════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────────────
let _pastesLoaded = false;
let _pastesOffset = 0;
let _pastesFilter = 'all'; // 'all' | 'paste' | 'screenshot'
let _pastesSearch = '';
let _pastesTotal = 0;
const PASTES_PER_PAGE = 30;

// ── Syntax highlighting (lightweight, no lib needed) ────────
const _hlKeywords = {
    javascript: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|try|catch|throw|typeof|instanceof|in|of|switch|case|break|continue|default|null|undefined|true|false)\b/g,
    python: /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|in|not|and|or|is|None|True|False|print|self|lambda|yield|raise|pass|break|continue|global|nonlocal)\b/g,
    html: /(&lt;\/?[a-zA-Z][a-zA-Z0-9]*|&gt;)/g,
    sql: /\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|PRIMARY|KEY|FOREIGN|REFERENCES|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|AS|DISTINCT|UNION|EXISTS|BETWEEN|LIKE|IN|IS|COUNT|SUM|AVG|MAX|MIN|CASE|WHEN|THEN|ELSE|END)\b/gi,
    rust: /\b(fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|self|Self|match|if|else|for|while|loop|return|break|continue|async|await|move|ref|where|type|true|false|None|Some|Ok|Err)\b/g,
    go: /\b(func|package|import|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|switch|case|default|break|continue|select|nil|true|false|make|new|len|cap|append)\b/g,
    php: /\b(function|class|public|private|protected|static|return|if|else|elseif|for|foreach|while|switch|case|break|continue|echo|print|new|null|true|false|array|isset|empty|require|include|namespace|use|try|catch|throw)\b/g,
    bash: /\b(if|then|else|elif|fi|for|do|done|while|until|case|esac|function|return|local|export|readonly|declare|echo|exit|source|eval|exec|set|unset|shift|cd|pwd|test)\b/g,
};

function highlightSyntax(code, lang) {
    // Escape HTML
    let html = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (lang === 'text' || lang === 'markdown') return html;

    // Strings
    html = html.replace(/(["'`])(?:(?!\1|\\).|\\.)*?\1/g, '<span class="paste-hl-str">$&</span>');
    // Comments (// and #)
    html = html.replace(/(\/\/.*$|#(?!!).*$)/gm, '<span class="paste-hl-cmt">$&</span>');
    // Numbers
    html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="paste-hl-num">$&</span>');
    // Keywords
    const kwPattern = _hlKeywords[lang] || _hlKeywords.javascript;
    if (kwPattern) {
        html = html.replace(kwPattern, '<span class="paste-hl-kw">$&</span>');
    }
    return html;
}

// ── Load pastes index page ──────────────────────────────────
function loadPastesPage() {
    _pastesOffset = 0;
    _pastesFilter = 'all';
    _pastesSearch = '';
    _pastesLoaded = true;

    const grid = document.getElementById('pastes-grid');
    if (grid) grid.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';

    fetchPastes();
}

async function fetchPastes() {
    const grid = document.getElementById('pastes-grid');
    if (!grid) return;

    try {
        let url = `/api/pastes?limit=${PASTES_PER_PAGE}&offset=${_pastesOffset}`;
        if (_pastesFilter !== 'all') url += `&type=${_pastesFilter}`;
        if (_pastesSearch) url += `&search=${encodeURIComponent(_pastesSearch)}`;

        const data = await api(url);
        _pastesTotal = data.total || 0;

        document.getElementById('pastes-count').textContent = `${_pastesTotal} item${_pastesTotal !== 1 ? 's' : ''}`;

        if (!data.pastes?.length && _pastesOffset === 0) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1; text-align:center; padding:48px 20px;">
                    <i class="fa-solid fa-paste" style="font-size:2.5rem; opacity:0.3; margin-bottom:12px;"></i>
                    <p style="opacity:0.5;">No pastes yet. Share something!</p>
                </div>`;
            return;
        }

        grid.innerHTML = data.pastes.map(p => renderPasteCard(p)).join('');

        // Pagination
        const pagEl = document.getElementById('pastes-pagination');
        if (pagEl) {
            const totalPages = Math.ceil(_pastesTotal / PASTES_PER_PAGE);
            const currentPage = Math.floor(_pastesOffset / PASTES_PER_PAGE) + 1;
            if (totalPages <= 1) { pagEl.innerHTML = ''; return; }
            let html = '';
            if (currentPage > 1) html += `<button class="btn btn-outline btn-sm" onclick="pastesPaginate(${_pastesOffset - PASTES_PER_PAGE})"><i class="fa-solid fa-chevron-left"></i></button>`;
            html += `<span class="pastes-page-info">Page ${currentPage} of ${totalPages}</span>`;
            if (currentPage < totalPages) html += `<button class="btn btn-outline btn-sm" onclick="pastesPaginate(${_pastesOffset + PASTES_PER_PAGE})"><i class="fa-solid fa-chevron-right"></i></button>`;
            pagEl.innerHTML = html;
        }
    } catch (err) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;text-align:center;padding:48px;"><p style="color:var(--danger);">Failed to load pastes</p></div>`;
    }
}

function renderPasteCard(p) {
    const isScreenshot = p.type === 'screenshot';
    const timeAgo = formatTimeAgo(p.created_at);
    const author = p.username || 'Anonymous';
    const avatar = p.avatar_url
        ? `<img src="${p.avatar_url}" class="paste-card-avatar" alt="">`
        : `<div class="paste-card-avatar paste-card-avatar-letter">${author[0].toUpperCase()}</div>`;

    const langBadge = !isScreenshot && p.language && p.language !== 'text'
        ? `<span class="paste-card-lang">${p.language}</span>` : '';
    const pinBadge = p.pinned ? `<span class="paste-card-pin" title="Pinned"><i class="fa-solid fa-thumbtack"></i></span>` : '';
    const burnBadge = p.burn_after_read ? `<span class="paste-card-burn" title="Burns after reading"><i class="fa-solid fa-fire"></i></span>` : '';
    const viewsBadge = `<span class="paste-card-views"><i class="fa-solid fa-eye"></i> ${p.views || 0}</span>`;

    let thumb = '';
    if (isScreenshot && p.screenshot_url) {
        thumb = `<div class="paste-card-thumb"><img src="${p.screenshot_url}" alt="Screenshot" loading="lazy"></div>`;
    } else {
        // Code preview
        const preview = (p.content || '').slice(0, 200).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        thumb = `<div class="paste-card-code"><pre><code>${preview}${(p.content || '').length > 200 ? '…' : ''}</code></pre></div>`;
    }

    return `
        <div class="paste-card" onclick="navigate('/p/${p.slug}')">
            ${thumb}
            <div class="paste-card-info">
                <div class="paste-card-title">${pinBadge}${escapeHtml(p.title)}${burnBadge}</div>
                <div class="paste-card-meta">
                    <div class="paste-card-author">${avatar}<span>${escapeHtml(author)}</span></div>
                    <div class="paste-card-right">
                        ${langBadge}${viewsBadge}
                        <span class="paste-card-time">${timeAgo}</span>
                    </div>
                </div>
            </div>
        </div>`;
}

function filterPastes(type) {
    _pastesFilter = type;
    _pastesOffset = 0;
    document.querySelectorAll('.pastes-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === type));
    fetchPastes();
}

function searchPastes() {
    const input = document.getElementById('pastes-search-input');
    _pastesSearch = input?.value?.trim() || '';
    _pastesOffset = 0;
    fetchPastes();
}

function pastesPaginate(offset) {
    _pastesOffset = Math.max(0, offset);
    fetchPastes();
    document.getElementById('page-pastes')?.scrollTo(0, 0);
}

// ── View single paste ───────────────────────────────────────
async function loadPasteViewer(slug) {
    const container = document.getElementById('paste-viewer-content');
    if (!container) return;
    container.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';

    try {
        const data = await api(`/api/pastes/${slug}`);
        const p = data.paste;
        if (!p) throw new Error('Not found');

        // Check burn after read
        if (p.burn_after_read && p.views > 1) {
            container.innerHTML = `
                <div class="paste-burned">
                    <i class="fa-solid fa-fire" style="font-size:3rem; color:var(--danger); margin-bottom:16px;"></i>
                    <h2>This paste has been burned</h2>
                    <p>It was set to self-destruct after being read.</p>
                    <button class="btn btn-primary" onclick="navigate('/pastes')">Back to Pastes</button>
                </div>`;
            return;
        }

        const isScreenshot = p.type === 'screenshot';
        const author = p.username || 'Anonymous';
        const isOwner = typeof currentUser !== 'undefined' && currentUser && p.user_id === currentUser.id;
        const isAdmin = typeof currentUser !== 'undefined' && currentUser && (currentUser.role === 'admin' || currentUser.role === 'global_mod');

        let meta;
        try { meta = JSON.parse(p.metadata); } catch { meta = {}; }

        let contentHtml;
        if (isScreenshot) {
            const screenshotUrl = p.screenshot_url || `/data/pastes/screenshots/${p.screenshot_path?.split('/').pop()}`;
            contentHtml = `
                <div class="paste-screenshot-view">
                    <img src="${screenshotUrl}" alt="Screenshot" class="paste-screenshot-img"
                         onclick="window.open(this.src, '_blank')">
                    ${p.content ? `<div class="paste-screenshot-desc">${escapeHtml(p.content)}</div>` : ''}
                    ${meta.page_url ? `<div class="paste-screenshot-url"><i class="fa-solid fa-link"></i> <a href="${escapeHtml(meta.page_url)}" target="_blank" rel="noopener">${escapeHtml(meta.page_url)}</a></div>` : ''}
                </div>`;
        } else {
            const lines = (p.content || '').split('\n');
            const lineNums = lines.map((_, i) => `<span>${i + 1}</span>`).join('\n');
            const highlighted = highlightSyntax(p.content || '', p.language || 'text');
            contentHtml = `
                <div class="paste-code-view">
                    <div class="paste-code-header">
                        <span class="paste-code-lang"><i class="fa-solid fa-code"></i> ${p.language || 'text'}</span>
                        <span class="paste-code-lines">${lines.length} line${lines.length !== 1 ? 's' : ''}</span>
                        <div class="paste-code-actions">
                            <button class="btn btn-outline btn-sm" onclick="copyPasteContent()" title="Copy"><i class="fa-solid fa-copy"></i> Copy</button>
                            <a class="btn btn-outline btn-sm" href="/api/pastes/${p.slug}/raw" target="_blank" title="Raw"><i class="fa-solid fa-file-lines"></i> Raw</a>
                            <button class="btn btn-outline btn-sm" onclick="forkPaste('${p.slug}')" title="Fork"><i class="fa-solid fa-code-fork"></i> Fork</button>
                        </div>
                    </div>
                    <div class="paste-code-body">
                        <div class="paste-line-numbers">${lineNums}</div>
                        <pre class="paste-code-pre"><code id="paste-code-content">${highlighted}</code></pre>
                    </div>
                </div>`;
        }

        const forkedFrom = p.forked_from ? `<span class="paste-forked-badge"><i class="fa-solid fa-code-fork"></i> Forked</span>` : '';

        container.innerHTML = `
            <div class="paste-view-header">
                <div class="paste-view-title-row">
                    <h1 class="paste-view-title">${escapeHtml(p.title)}${forkedFrom}</h1>
                    ${p.pinned ? '<span class="paste-card-pin"><i class="fa-solid fa-thumbtack"></i> Pinned</span>' : ''}
                    ${p.burn_after_read ? '<span class="paste-card-burn"><i class="fa-solid fa-fire"></i> Burns after read</span>' : ''}
                    ${p.visibility === 'unlisted' ? '<span class="paste-unlisted-badge"><i class="fa-solid fa-eye-slash"></i> Unlisted</span>' : ''}
                </div>
                <div class="paste-view-meta">
                    <span><i class="fa-solid fa-user"></i> ${escapeHtml(author)}</span>
                    <span><i class="fa-solid fa-clock"></i> ${formatTimeAgo(p.created_at)}</span>
                    <span><i class="fa-solid fa-eye"></i> ${p.views} view${p.views !== 1 ? 's' : ''}</span>
                    ${isOwner || isAdmin ? `
                        <div class="paste-view-owner-actions">
                            <button class="btn btn-outline btn-sm" onclick="editPaste('${p.slug}')"><i class="fa-solid fa-pen"></i> Edit</button>
                            <button class="btn btn-outline btn-sm btn-danger" onclick="deletePaste('${p.slug}')"><i class="fa-solid fa-trash"></i> Delete</button>
                        </div>
                    ` : ''}
                </div>
            </div>
            ${contentHtml}
        `;

        // Store content for clipboard
        container._pasteContent = p.content || '';
    } catch (err) {
        container.innerHTML = `
            <div class="empty-state" style="text-align:center; padding:48px;">
                <i class="fa-solid fa-circle-exclamation" style="font-size:2rem; color:var(--danger); margin-bottom:12px;"></i>
                <h3>Paste not found</h3>
                <p>It may have been deleted or the link is invalid.</p>
                <button class="btn btn-primary" onclick="navigate('/pastes')" style="margin-top:16px;">Browse Pastes</button>
            </div>`;
    }
}

function copyPasteContent() {
    const container = document.getElementById('paste-viewer-content');
    const text = container?._pasteContent || '';
    navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard!', 'success')).catch(() => toast('Failed to copy', 'error'));
}

async function forkPaste(slug) {
    try {
        const data = await api(`/api/pastes/${slug}/fork`, { method: 'POST' });
        toast('Paste forked!', 'success');
        navigate(`/p/${data.paste.slug}`);
    } catch (err) {
        toast(err.message || 'Failed to fork', 'error');
    }
}

async function deletePaste(slug) {
    if (!confirm('Delete this paste permanently?')) return;
    try {
        await api(`/api/pastes/${slug}`, { method: 'DELETE' });
        toast('Paste deleted', 'success');
        navigate('/pastes');
    } catch (err) {
        toast(err.message || 'Failed to delete', 'error');
    }
}

function editPaste(slug) {
    // Load into the create form for editing
    navigate(`/pastes?edit=${slug}`);
}

// ── Create / New paste UI ───────────────────────────────────
function openNewPasteModal(prefill = {}) {
    const modal = document.getElementById('paste-create-modal');
    if (!modal) return;

    document.getElementById('paste-create-title').value = prefill.title || '';
    document.getElementById('paste-create-content').value = prefill.content || '';
    document.getElementById('paste-create-lang').value = prefill.language || 'auto';
    document.getElementById('paste-create-visibility').value = prefill.visibility || 'public';
    document.getElementById('paste-create-burn').checked = !!prefill.burn;
    document.getElementById('paste-create-slug').value = prefill.slug || ''; // For edits

    modal.style.display = 'flex';
    document.getElementById('paste-create-content').focus();

    // Update line count
    _updatePasteLineCount();
}

function closePasteModal() {
    const modal = document.getElementById('paste-create-modal');
    if (modal) modal.style.display = 'none';
}

function _updatePasteLineCount() {
    const ta = document.getElementById('paste-create-content');
    const counter = document.getElementById('paste-line-count');
    if (ta && counter) {
        const lines = (ta.value || '').split('\n').length;
        const chars = (ta.value || '').length;
        counter.textContent = `${lines} line${lines !== 1 ? 's' : ''} · ${chars.toLocaleString()} chars`;
    }
}

async function submitPaste() {
    const title = document.getElementById('paste-create-title').value.trim();
    const content = document.getElementById('paste-create-content').value;
    const language = document.getElementById('paste-create-lang').value;
    const visibility = document.getElementById('paste-create-visibility').value;
    const burn = document.getElementById('paste-create-burn').checked;
    const editSlug = document.getElementById('paste-create-slug').value;

    if (!content.trim()) return toast('Content is required', 'error');

    try {
        let data;
        if (editSlug) {
            data = await api(`/api/pastes/${editSlug}`, {
                method: 'PUT',
                body: { title, content, language, visibility },
            });
            toast('Paste updated!', 'success');
        } else {
            data = await api('/api/pastes', {
                method: 'POST',
                body: { title: title || 'Untitled', content, language, visibility, burn_after_read: burn },
            });
            toast('Paste created!', 'success');
        }
        closePasteModal();
        navigate(`/p/${data.paste.slug}`);
    } catch (err) {
        toast(err.message || 'Failed to save paste', 'error');
    }
}

// ── Screenshot capture ──────────────────────────────────────
let _screenshotPending = false;

async function captureScreenshot() {
    if (_screenshotPending) return;
    _screenshotPending = true;

    const btn = document.getElementById('screenshot-capture-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Capturing…'; }

    try {
        // Use html2canvas-style approach: capture via Canvas API
        // We'll use the browser's native approach: create a canvas from the viewport
        let blob;

        // Method 1: Try the Screen Capture API (requires user gesture, HTTPS)
        // Method 2: Use a simpler canvas-based DOM renderer
        // For reliability, we'll use a canvas snapshot approach
        blob = await _captureViewportToBlob();

        if (!blob) throw new Error('Capture failed');

        // Open upload dialog
        _openScreenshotUploadDialog(blob);
    } catch (err) {
        console.error('[Screenshot] Capture error:', err);
        // Fallback: let user pick a file
        _openScreenshotUploadDialog(null);
    } finally {
        _screenshotPending = false;
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-camera"></i> Screenshot'; }
    }
}

async function _captureViewportToBlob() {
    // Use html2canvas if available, otherwise fallback to file picker
    // For now we'll do a lightweight in-page capture using OffscreenCanvas + drawWindow
    // Since drawWindow is Firefox-only and deprecated, we'll use a different approach:
    // Render the visible page to canvas using the html2canvas technique of
    // serializing DOM + CSS. But that's a huge lib. Instead, let's use a
    // pragmatic approach: screenshot the current view using the toBlob of a
    // canvas that draws the main content.

    // Actually the cleanest approach for "screenshot for devs" is just:
    // 1. Try to use the newer Presentation/Screenshot API (not widely available)
    // 2. Fall back to letting the user use their OS screenshot tool and upload

    // We'll load html2canvas on-demand from CDN (it's only ~44KB gzipped)
    if (typeof html2canvas === 'undefined') {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load html2canvas'));
            document.head.appendChild(script);
        });
    }

    // Capture current visible page
    const activePage = document.querySelector('.page.active') || document.getElementById('app');
    const canvas = await html2canvas(activePage, {
        backgroundColor: getComputedStyle(document.body).backgroundColor || '#0e0e10',
        scale: window.devicePixelRatio || 1,
        useCORS: true,
        logging: false,
        ignoreElements: (el) => {
            // Ignore screenshot button itself, modals, tooltips
            return el.id === 'paste-create-modal' || el.id === 'screenshot-upload-modal'
                || el.classList?.contains('modal-overlay') || el.classList?.contains('toast-container');
        },
    });

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function _openScreenshotUploadDialog(blob) {
    const modal = document.getElementById('screenshot-upload-modal');
    if (!modal) return;

    const preview = document.getElementById('screenshot-preview');
    const fileInput = document.getElementById('screenshot-file-input');

    if (blob) {
        const url = URL.createObjectURL(blob);
        preview.src = url;
        preview.style.display = 'block';
        preview._blob = blob;
        preview._fromCapture = true;
    } else {
        preview.src = '';
        preview.style.display = 'none';
        preview._blob = null;
        preview._fromCapture = false;
    }

    // Pre-fill page URL
    document.getElementById('screenshot-page-url').value = window.location.href;
    document.getElementById('screenshot-title').value = `Screenshot — ${document.title}`;
    document.getElementById('screenshot-desc').value = '';
    document.getElementById('screenshot-visibility').value = 'public';
    if (fileInput) fileInput.value = '';

    modal.style.display = 'flex';
}

function closeScreenshotModal() {
    const modal = document.getElementById('screenshot-upload-modal');
    if (modal) modal.style.display = 'none';
    const preview = document.getElementById('screenshot-preview');
    if (preview?.src) { URL.revokeObjectURL(preview.src); preview.src = ''; }
}

function onScreenshotFileSelect(input) {
    const file = input.files?.[0];
    if (!file) return;
    const preview = document.getElementById('screenshot-preview');
    if (preview) {
        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.src = URL.createObjectURL(file);
        preview.style.display = 'block';
        preview._blob = file;
        preview._fromCapture = false;
    }
}

async function submitScreenshot() {
    const preview = document.getElementById('screenshot-preview');
    const fileInput = document.getElementById('screenshot-file-input');
    const title = document.getElementById('screenshot-title').value.trim();
    const desc = document.getElementById('screenshot-desc').value.trim();
    const visibility = document.getElementById('screenshot-visibility').value;
    const pageUrl = document.getElementById('screenshot-page-url').value.trim();

    let blob = preview?._blob;
    if (!blob && fileInput?.files?.[0]) blob = fileInput.files[0];
    if (!blob) return toast('No screenshot to upload', 'error');

    const formData = new FormData();
    formData.append('screenshot', blob instanceof Blob ? blob : blob, blob.name || 'screenshot.png');
    formData.append('title', title || 'Screenshot');
    formData.append('description', desc);
    formData.append('visibility', visibility);
    formData.append('page_url', pageUrl);
    formData.append('user_agent', navigator.userAgent);

    const submitBtn = document.getElementById('screenshot-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading…'; }

    try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${typeof API !== 'undefined' ? API : ''}/api/pastes/screenshot`, {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');

        toast('Screenshot uploaded!', 'success');
        closeScreenshotModal();
        navigate(`/p/${data.paste.slug}`);
    } catch (err) {
        toast(err.message || 'Failed to upload screenshot', 'error');
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload'; }
    }
}

// ── Chat integration: /paste command creates a quick paste from chat ──
function handlePasteFromChat(content, streamId) {
    // This creates a paste programmatically from a chat message
    return api('/api/pastes', {
        method: 'POST',
        body: {
            title: `Chat paste — ${new Date().toLocaleString()}`,
            content,
            language: 'auto',
            visibility: 'public',
            stream_id: streamId || null,
        },
    });
}

// ── Utility ─────────────────────────────────────────────────
function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr.includes('T') ? dateStr : dateStr + 'Z');
    const now = Date.now();
    const diff = now - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return date.toLocaleDateString();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}
