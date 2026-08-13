/**
 * powerchat.js — dashboard panel to connect a PowerChat account for real tips.
 * Connection is per-streamer OAuth; the card is hidden unless the site admin has
 * enabled + configured the PowerChat app.
 */
(function () {
    'use strict';
    function $(id) { return document.getElementById(id); }

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    window.loadPowerchatStatus = async function loadPowerchatStatus() {
        const card = $('dash-powerchat-card');
        if (!card) return;
        let st;
        try { st = await api('/powerchat/status'); }
        catch { card.style.display = 'none'; return; }

        // Only show the card once an admin has enabled PowerChat.
        if (!st || !st.enabled) { card.style.display = 'none'; return; }
        card.style.display = '';

        const statusEl = $('pc-status'), actionsEl = $('pc-actions'), hintEl = $('pc-hint');
        if (statusEl && st.sandbox_username) statusEl.dataset.sandbox = st.sandbox_username;

        if (!st.configured) {
            statusEl.innerHTML = '<span class="pc-dot pc-dot-off"></span> PowerChat isn\'t fully set up by the site owner yet.';
            actionsEl.innerHTML = '';
            hintEl.textContent = '';
            return;
        }

        if (st.connected) {
            statusEl.innerHTML = `<span class="pc-dot pc-dot-on"></span> Connected as <strong>${esc(st.username || 'your account')}</strong>`;
            actionsEl.innerHTML = `
                <button class="btn btn-outline btn-small" onclick="powerchatTestAlert(this)"><i class="fa-solid fa-bell"></i> Test alert</button>
                ${st.tip_page_url ? `<a class="btn btn-outline btn-small" href="${esc(st.tip_page_url)}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i> My tip page</a>` : ''}
                <button class="btn btn-small" style="opacity:.8" onclick="powerchatDisconnect(this)"><i class="fa-solid fa-link-slash"></i> Disconnect</button>`;
            hintEl.textContent = st.last_error ? ('Note: ' + st.last_error) : 'Tips confirmed on PowerChat now flow into your goals, alerts, and chat automatically.';
        } else {
            statusEl.innerHTML = '<span class="pc-dot pc-dot-off"></span> Not connected.';
            actionsEl.innerHTML = `<button class="btn btn-primary btn-small" onclick="powerchatConnect()"><i class="fa-solid fa-plug"></i> Connect PowerChat</button>`;
            hintEl.textContent = st.last_error ? ('Reconnect needed: ' + st.last_error) : '';
        }
    };

    window.powerchatConnect = function powerchatConnect() {
        // Ask for the streamer's PowerChat username (their profile handle).
        const suggested = ($('pc-status')?.dataset.sandbox) || '';
        let username = prompt('Your PowerChat username (the handle in your PowerChat profile URL):', suggested || '');
        if (username === null) return;
        username = username.trim();
        const qs = username ? ('?username=' + encodeURIComponent(username)) : '';
        const w = 560, h = 720;
        const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
        const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
        const popup = window.open('/api/powerchat/oauth/start' + qs, 'powerchat_oauth', `width=${w},height=${h},left=${left},top=${top}`);

        const done = (msg) => {
            if (!msg || msg.type !== 'powerchat-oauth') return;
            cleanup();
            if (msg.ok) { toast('PowerChat connected ✓', 'success'); }
            else { toast('PowerChat: ' + (msg.error || 'connection failed'), 'error'); }
            setTimeout(() => window.loadPowerchatStatus(), 300);
        };
        const onMsg = (e) => { if (e.origin === window.location.origin) done(e.data); };
        let bc = null;
        try { bc = new BroadcastChannel('powerchat-oauth'); bc.onmessage = (e) => done(e.data); } catch { /* */ }
        const onStorage = (e) => { if (e.key === 'powerchat-oauth' && e.newValue) { try { done(JSON.parse(e.newValue)); } catch { /* */ } } };
        window.addEventListener('message', onMsg);
        window.addEventListener('storage', onStorage);
        // Fallback: refresh when the popup closes.
        const poll = setInterval(() => { if (popup && popup.closed) { cleanup(); setTimeout(() => window.loadPowerchatStatus(), 400); } }, 800);
        function cleanup() {
            window.removeEventListener('message', onMsg);
            window.removeEventListener('storage', onStorage);
            try { bc && bc.close(); } catch { /* */ }
            clearInterval(poll);
        }
    };

    window.powerchatDisconnect = async function powerchatDisconnect(btn) {
        if (!confirm('Disconnect PowerChat? Tips will stop flowing into HoboStreamer until you reconnect.')) return;
        if (btn) btn.disabled = true;
        try { await api('/powerchat/oauth/connection', { method: 'DELETE' }); toast('PowerChat disconnected', 'success'); }
        catch (e) { toast(e.message || 'Failed to disconnect', 'error'); }
        finally { if (btn) btn.disabled = false; window.loadPowerchatStatus(); }
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
