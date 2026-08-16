/* ═══════════════════════════════════════════════════════════════════
   chat-shared.js — SINGLE SOURCE OF TRUTH for chat link handling +
   the user context menu, shared by BOTH the main SPA (index.html) and
   the standalone kiosk (/kiosk). Change it here → both update.

   Wrapped in an IIFE with its own `esc` so it never collides with the
   SPA's global `esc`/helpers. Everything the inline onclick="" handlers
   in chat message markup need is re-exported onto `window` at the end.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
    "use strict";

    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    /* ═══════════════════════════════════════════════════════════════
       CHAT LINKS — Trust-Domain System, Context Menu & Preview
       (moved verbatim from chat.js so the trusted-domain list + dialogs
       behave identically on the main site and the kiosk, sharing the
       same `hobo_trusted_domains` localStorage entry.)
       ═══════════════════════════════════════════════════════════════ */
    const _TRUSTED_DOMAINS_KEY = 'hobo_trusted_domains';
    let _trustedDomains = new Set();
    let _activeLinkMenu = null;
    let _activeLinkDialog = null;

    (function _initTrustedDomains() {
        try {
            const stored = localStorage.getItem(_TRUSTED_DOMAINS_KEY);
            if (stored) {
                const arr = JSON.parse(stored);
                if (Array.isArray(arr)) _trustedDomains = new Set(arr);
            }
        } catch { /* ignore */ }
    })();

    function _saveTrustedDomains() {
        try {
            localStorage.setItem(_TRUSTED_DOMAINS_KEY, JSON.stringify([..._trustedDomains]));
        } catch { /* ignore */ }
    }

    function _getDomain(url) {
        try { return new URL(url).hostname.toLowerCase(); }
        catch { return ''; }
    }

    function handleChatLinkClick(event) {
        event.preventDefault();
        event.stopPropagation();
        const a = event.currentTarget || event.target.closest('.chat-link');
        if (!a) return;
        const url = a.dataset.url || a.href;
        if (!url) return;
        const domain = _getDomain(url);

        const alwaysTrusted = ['hobostreamer.com', 'www.hobostreamer.com', location.hostname];
        if (alwaysTrusted.includes(domain) || _trustedDomains.has(domain)) {
            window.open(url, '_blank', 'noopener,noreferrer');
            return;
        }
        _showTrustDomainDialog(url, domain);
    }

    function _showTrustDomainDialog(url, domain) {
        _dismissLinkDialog();

        const overlay = document.createElement('div');
        overlay.className = 'link-trust-overlay show';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) _dismissLinkDialog(); });

        overlay.innerHTML = `
            <div class="link-trust-dialog">
                <div class="link-trust-header">
                    <i class="fa-solid fa-shield-halved"></i>
                    <span>Trust This Domain?</span>
                </div>
                <div class="link-trust-body">
                    <p class="link-trust-warning">You're about to visit an external link. Make sure you trust this domain before proceeding.</p>
                    <div class="link-trust-domain">
                        <i class="fa-solid fa-globe"></i>
                        <span>${esc(domain)}</span>
                    </div>
                    <div class="link-trust-url-wrap">
                        <code class="link-trust-url">${esc(url)}</code>
                        <button class="link-trust-copy" title="Copy URL" onclick="event.stopPropagation(); _copyLinkUrl(this)">
                            <i class="fa-regular fa-copy"></i>
                        </button>
                    </div>
                </div>
                <div class="link-trust-actions">
                    <button class="link-trust-btn link-trust-cancel" onclick="_dismissLinkDialog()">Cancel</button>
                    <button class="link-trust-btn link-trust-once" onclick="_openLinkOnce('${esc(url)}')">Open Once</button>
                    <button class="link-trust-btn link-trust-always" onclick="_trustAndOpen('${esc(url)}', '${esc(domain)}')">
                        <i class="fa-solid fa-check"></i> Always Trust ${esc(domain)}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        _activeLinkDialog = overlay;

        const onKey = (e) => { if (e.key === 'Escape') { _dismissLinkDialog(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
    }

    function _dismissLinkDialog() {
        if (_activeLinkDialog) {
            _activeLinkDialog.remove();
            _activeLinkDialog = null;
        }
    }

    function _copyLinkUrl(btn) {
        const code = btn.parentElement.querySelector('.link-trust-url');
        if (!code) return;
        navigator.clipboard.writeText(code.textContent).then(() => {
            const icon = btn.querySelector('i');
            if (icon) { icon.className = 'fa-solid fa-check'; setTimeout(() => { icon.className = 'fa-regular fa-copy'; }, 1500); }
        }).catch(() => { });
    }

    function _openLinkOnce(url) {
        _dismissLinkDialog();
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    function _trustAndOpen(url, domain) {
        _trustedDomains.add(domain);
        _saveTrustedDomains();
        _dismissLinkDialog();
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    function showLinkContextMenu(event) {
        event.preventDefault();
        event.stopPropagation();
        _dismissLinkMenu();

        const a = event.currentTarget || event.target.closest('.chat-link');
        if (!a) return;
        const url = a.dataset.url || a.href;
        if (!url) return;

        const menu = document.createElement('div');
        menu.className = 'link-context-menu';
        menu.innerHTML = `
            <button class="link-ctx-btn" onclick="_linkCtxOpenTab('${esc(url)}')">
                <i class="fa-solid fa-arrow-up-right-from-square"></i> Open in New Tab
            </button>
            <button class="link-ctx-btn" onclick="_linkCtxPreview('${esc(url)}')">
                <i class="fa-solid fa-eye"></i> Preview
            </button>
            <div class="link-ctx-divider"></div>
            <button class="link-ctx-btn" onclick="_linkCtxCopy('${esc(url)}', this)">
                <i class="fa-regular fa-copy"></i> Copy URL
            </button>
        `;

        document.body.appendChild(menu);
        _activeLinkMenu = menu;
        _positionLinkMenu(menu, event.clientX, event.clientY);

        setTimeout(() => {
            document.addEventListener('click', _dismissLinkMenu, { once: true });
        }, 10);
    }

    function _positionLinkMenu(menu, x, y) {
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            if (x + rect.width > vw - 8) menu.style.left = Math.max(8, x - rect.width) + 'px';
            if (y + rect.height > vh - 8) menu.style.top = Math.max(8, y - rect.height) + 'px';
        });
    }

    function _dismissLinkMenu() {
        if (_activeLinkMenu) {
            _activeLinkMenu.remove();
            _activeLinkMenu = null;
        }
    }

    function _linkCtxOpenTab(url) {
        _dismissLinkMenu();
        const domain = _getDomain(url);
        const alwaysTrusted = ['hobostreamer.com', 'www.hobostreamer.com', location.hostname];
        if (alwaysTrusted.includes(domain) || _trustedDomains.has(domain)) {
            window.open(url, '_blank', 'noopener,noreferrer');
        } else {
            _showTrustDomainDialog(url, domain);
        }
    }

    function _linkCtxCopy(url, btn) {
        _dismissLinkMenu();
        navigator.clipboard.writeText(url).catch(() => { });
    }

    function _linkCtxPreview(url) {
        _dismissLinkMenu();
        _showLinkPreview(url);
    }

    function _showLinkPreview(url) {
        _dismissLinkPreview();

        const overlay = document.createElement('div');
        overlay.className = 'link-preview-overlay show';
        overlay.id = 'link-preview-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) _dismissLinkPreview(); });

        overlay.innerHTML = `
            <div class="link-preview-modal">
                <div class="link-preview-header">
                    <div class="link-preview-url-bar">
                        <i class="fa-solid fa-globe"></i>
                        <span class="link-preview-url-text" title="${esc(url)}">${esc(url)}</span>
                        <button class="link-preview-copy" title="Copy URL" onclick="event.stopPropagation(); navigator.clipboard.writeText('${esc(url)}')">
                            <i class="fa-regular fa-copy"></i>
                        </button>
                    </div>
                    <div class="link-preview-toolbar">
                        <button class="link-preview-btn" title="Open in New Tab" onclick="_linkPreviewOpen('${esc(url)}')">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> Open
                        </button>
                        <button class="link-preview-btn link-preview-close" title="Close" onclick="_dismissLinkPreview()">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>
                <div class="link-preview-body">
                    <div class="link-preview-loading">
                        <i class="fa-solid fa-spinner fa-spin"></i> Loading preview...
                    </div>
                    <iframe class="link-preview-frame" sandbox="allow-scripts allow-same-origin allow-forms" src="${esc(url)}" onload="this.previousElementSibling.style.display='none'" onerror="this.previousElementSibling.innerHTML='<i class=\\'fa-solid fa-triangle-exclamation\\'></i> Could not load preview'"></iframe>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const onKey = (e) => { if (e.key === 'Escape') { _dismissLinkPreview(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
    }

    function _dismissLinkPreview() {
        const el = document.getElementById('link-preview-overlay');
        if (el) el.remove();
    }

    function _linkPreviewOpen(url) {
        const domain = _getDomain(url);
        const alwaysTrusted = ['hobostreamer.com', 'www.hobostreamer.com', location.hostname];
        if (alwaysTrusted.includes(domain) || _trustedDomains.has(domain)) {
            window.open(url, '_blank', 'noopener,noreferrer');
        } else {
            _dismissLinkPreview();
            _showTrustDomainDialog(url, domain);
        }
    }

    /**
     * Turn plain text into safe HTML with clickable, trust-gated .chat-link anchors.
     * Produces the same anchor markup the SPA emits (emotes.js), so the shared trust
     * handlers wire up identically. URLs are escaped; everything else is escaped too.
     */
    const _URL_RE = /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;!?)\]}'"])/gi;
    function linkify(text) {
        const raw = String(text ?? '');
        let out = '';
        let last = 0;
        raw.replace(_URL_RE, (match, _url, offset) => {
            out += esc(raw.slice(last, offset));
            const href = /^https?:\/\//i.test(match) ? match : 'https://' + match;
            const eh = esc(href);
            out += `<a class="chat-link" href="${eh}" data-url="${eh}" onclick="return handleChatLinkClick(event)" oncontextmenu="return showLinkContextMenu(event)" title="${eh}" rel="noopener noreferrer">${esc(match)}</a>`;
            last = offset + match.length;
            return match;
        });
        out += esc(raw.slice(last));
        return out;
    }

    // ── Re-export everything inline onclick="" handlers reference ──
    Object.assign(window, {
        handleChatLinkClick, showLinkContextMenu,
        _showTrustDomainDialog, _dismissLinkDialog, _copyLinkUrl, _openLinkOnce, _trustAndOpen,
        _positionLinkMenu, _dismissLinkMenu, _linkCtxOpenTab, _linkCtxCopy, _linkCtxPreview,
        _showLinkPreview, _dismissLinkPreview, _linkPreviewOpen,
    });

    window.HoboChat = {
        escape: esc,
        linkify,
        handleLinkClick: handleChatLinkClick,
        showLinkContextMenu,
        isTrusted: (domain) => _trustedDomains.has(String(domain || '').toLowerCase()),
    };
})();
