/**
 * powerchat.js — dashboard panel to connect a PowerChat account for real tips.
 * Connection is per-streamer OAuth; the card is hidden unless the site admin has
 * enabled + configured the PowerChat app. The connect flow is a small state machine
 * (idle → connecting → success | error | cancelled) with live animation + auto-refresh.
 */
(function () {
    'use strict';
    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    // Fade the status content on each swap so state changes feel smooth, not janky.
    function _swap(el, html) { if (!el) return; el.innerHTML = html; el.classList.remove('pc-fade-in'); void el.offsetWidth; el.classList.add('pc-fade-in'); }

    let _pcActive = null;   // the in-flight connect session (so Cancel can reach it)

    window.loadPowerchatStatus = async function loadPowerchatStatus() {
        const card = $('dash-powerchat-card');
        if (!card) return;
        // Don't clobber the live connecting animation with a stale status render.
        if (_pcActive) return;
        let st;
        try { st = await api('/powerchat/status'); }
        catch { card.style.display = 'none'; return; }

        if (!st || !st.enabled) { card.style.display = 'none'; return; }
        if (card.style.display === 'none') { card.style.display = ''; card.classList.add('pc-card-in'); setTimeout(() => card.classList.remove('pc-card-in'), 500); }
        else card.style.display = '';

        const statusEl = $('pc-status'), actionsEl = $('pc-actions'), hintEl = $('pc-hint');
        if (statusEl && st.sandbox_username) statusEl.dataset.sandbox = st.sandbox_username;

        if (!st.configured) {
            _swap(statusEl, '<span class="pc-dot pc-dot-off"></span> PowerChat isn\'t fully set up by the site owner yet.');
            if (actionsEl) actionsEl.innerHTML = '';
            if (hintEl) hintEl.textContent = '';
            return;
        }

        if (st.connected) {
            _swap(statusEl, `<span class="pc-dot pc-dot-on"></span> Connected as <strong>${esc(st.username || 'your account')}</strong>`);
            if (actionsEl) actionsEl.innerHTML = `
                <button class="btn btn-outline btn-small" onclick="powerchatTestAlert(this)"><i class="fa-solid fa-bell"></i> Test alert</button>
                ${st.tip_page_url ? `<a class="btn btn-outline btn-small" href="${esc(st.tip_page_url)}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i> My tip page</a>` : ''}
                <button class="btn btn-small pc-disconnect-btn" onclick="powerchatDisconnect(this)"><i class="fa-solid fa-link-slash"></i> Disconnect</button>`;
            if (hintEl) hintEl.textContent = st.last_error ? ('Note: ' + st.last_error) : 'Tips confirmed on PowerChat now flow into your goals, alerts, and chat automatically.';
        } else {
            _swap(statusEl, '<span class="pc-dot pc-dot-off"></span> Not connected.');
            if (actionsEl) actionsEl.innerHTML = `<button class="btn btn-primary btn-small pc-connect-btn" onclick="powerchatConnect()"><i class="fa-solid fa-plug"></i> Connect PowerChat</button>`;
            if (hintEl) hintEl.innerHTML = st.last_error ? `<span class="pc-warn">Reconnect needed: ${esc(st.last_error)}</span>` : '';
        }
    };

    // ── Connect flow (state machine) ──────────────────────────────────────────
    function _renderConnecting() {
        const card = $('dash-powerchat-card'); if (card) card.classList.add('pc-busy');
        _swap($('pc-status'), `<span class="pc-spinner"></span> <span class="pc-connecting-text">Waiting for you to authorize in PowerChat<span class="pc-ellipsis"><span>.</span><span>.</span><span>.</span></span></span>`);
        const a = $('pc-actions');
        if (a) a.innerHTML = `<button class="btn btn-small pc-cancel-btn" onclick="powerchatCancelConnect()"><i class="fa-solid fa-xmark"></i> Cancel</button>`;
        const h = $('pc-hint');
        if (h) h.innerHTML = `<span class="pc-progress"><span class="pc-progress-bar"></span></span> Finish the login in the popup — this page updates automatically the moment you're done.`;
    }
    function _renderSuccess(username) {
        const card = $('dash-powerchat-card');
        if (card) { card.classList.remove('pc-busy'); card.classList.add('pc-flash'); setTimeout(() => card.classList.remove('pc-flash'), 1000); }
        _swap($('pc-status'), `<span class="pc-check-pop">✓</span> <span class="pc-success-text">Connected${username ? ' as <strong>' + esc(username) + '</strong>' : ''}!</span>`);
        const a = $('pc-actions'); if (a) a.innerHTML = '';
        const h = $('pc-hint'); if (h) h.textContent = 'Linking your tip settings…';
    }
    function _renderCancelled() {
        const card = $('dash-powerchat-card'); if (card) card.classList.remove('pc-busy');
        _swap($('pc-status'), '<span class="pc-dot pc-dot-off"></span> Connection cancelled — the window closed before finishing.');
        const a = $('pc-actions'); if (a) a.innerHTML = `<button class="btn btn-primary btn-small pc-connect-btn" onclick="powerchatConnect()"><i class="fa-solid fa-plug"></i> Try again</button>`;
        const h = $('pc-hint'); if (h) h.textContent = '';
    }
    function _renderError(msg) {
        const card = $('dash-powerchat-card'); if (card) card.classList.remove('pc-busy');
        _swap($('pc-status'), '<span class="pc-dot pc-dot-off"></span> Couldn\'t connect.');
        const a = $('pc-actions'); if (a) a.innerHTML = `<button class="btn btn-primary btn-small pc-connect-btn" onclick="powerchatConnect()"><i class="fa-solid fa-plug"></i> Try again</button>`;
        const h = $('pc-hint'); if (h) h.innerHTML = `<span class="pc-warn">${esc(msg || 'Connection failed. Please try again.')}</span>`;
    }

    window.powerchatConnect = function powerchatConnect() {
        if (_pcActive) return; // already connecting

        const w = 560, h = 720;
        const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
        const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
        const popup = window.open('/api/powerchat/oauth/start', 'powerchat_oauth', `width=${w},height=${h},left=${left},top=${top}`);
        if (!popup) { toast('Please allow popups for this site, then click Connect again.', 'error'); return; }

        _renderConnecting();

        let settled = false;
        const finish = (result, msg, username) => {
            if (settled) return;
            settled = true;
            cleanup();
            _pcActive = null;
            try { if (popup && !popup.closed) popup.close(); } catch { /* */ }
            if (result === 'ok') {
                _renderSuccess(username);
                toast('PowerChat connected ✓', 'success');
                // Auto-refresh the card/widget once the server has stored the grant.
                setTimeout(() => window.loadPowerchatStatus(), 1100);
            } else if (result === 'error') {
                toast('PowerChat: ' + (msg || 'connection failed'), 'error');
                _renderError(msg);
            } else {
                _renderCancelled();
            }
        };

        const done = (m) => { if (!m || m.type !== 'powerchat-oauth') return; finish(m.ok ? 'ok' : 'error', m.error, m.username); };
        const onMsg = (e) => { if (e.origin === window.location.origin) done(e.data); };
        let bc = null;
        try { bc = new BroadcastChannel('powerchat-oauth'); bc.onmessage = (e) => done(e.data); } catch { /* */ }
        const onStorage = (e) => { if (e.key === 'powerchat-oauth' && e.newValue) { try { done(JSON.parse(e.newValue)); } catch { /* */ } } };
        window.addEventListener('message', onMsg);
        window.addEventListener('storage', onStorage);

        // Detect the popup being closed before finishing. Give any in-flight completion
        // message a moment to land first, then treat a bare close as "cancelled".
        const poll = setInterval(() => {
            if (popup.closed) { clearInterval(poll); setTimeout(() => finish('cancelled'), 700); }
        }, 500);
        // Absolute safety net.
        const to = setTimeout(() => finish('cancelled'), 5 * 60 * 1000);

        function cleanup() {
            window.removeEventListener('message', onMsg);
            window.removeEventListener('storage', onStorage);
            try { bc && bc.close(); } catch { /* */ }
            clearInterval(poll); clearTimeout(to);
        }

        _pcActive = { finish, popup };
    };

    window.powerchatCancelConnect = function powerchatCancelConnect() {
        if (!_pcActive) return;
        try { if (_pcActive.popup && !_pcActive.popup.closed) _pcActive.popup.close(); } catch { /* */ }
        _pcActive.finish('cancelled');
    };

    window.powerchatDisconnect = async function powerchatDisconnect(btn) {
        if (!confirm('Disconnect PowerChat? Tips will stop flowing into HoboStreamer until you reconnect.')) return;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Disconnecting…'; }
        const card = $('dash-powerchat-card'); if (card) card.classList.add('pc-busy');
        try { await api('/powerchat/oauth/connection', { method: 'DELETE' }); toast('PowerChat disconnected', 'success'); }
        catch (e) { toast(e.message || 'Failed to disconnect', 'error'); }
        finally { if (card) card.classList.remove('pc-busy'); window.loadPowerchatStatus(); }
    };

    window.powerchatTestAlert = async function powerchatTestAlert(btn) {
        if (btn) btn.disabled = true;
        try { await api('/powerchat/test-alert', { method: 'POST' }); toast('Test alert sent to PowerChat ✓', 'success'); }
        catch (e) { toast('Test alert failed: ' + (e.message || 'error'), 'error'); }
        finally { if (btn) btn.disabled = false; }
    };

    // Chain into the dashboard load.
    const _prev = window.loadDashboard;
    window.loadDashboard = async function powerchatLoadDashboard() {
        if (typeof _prev === 'function') await _prev();
        try { await window.loadPowerchatStatus(); } catch { /* */ }
    };
})();
