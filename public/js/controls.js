/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Interactive Controls Client (WebSocket)
   ═══════════════════════════════════════════════════════════════ */

let controlWs = null;
let controlCooldowns = {};

/**
 * Load and display interactive controls for a stream.
 */
async function loadStreamControls(streamId) {
    const panel = document.getElementById('controls-panel');
    const grid = document.getElementById('controls-grid');

    try {
        const data = await api(`/controls/${streamId}`);
        const controls = data.controls || [];

        if (!controls.length) {
            panel.style.display = 'none';
            return;
        }

        panel.style.display = '';
        grid.innerHTML = controls.map(c => `
            <button class="control-btn" data-cmd="${esc(c.command)}" data-cooldown="${parseInt(c.cooldown) || 1}"
                    onclick="sendControl(this.dataset.cmd, this, parseInt(this.dataset.cooldown))"
                    title="${esc(c.command)}">
                <i class="fa-solid ${esc(c.icon || 'fa-circle')}"></i>
                <span>${esc(c.label || c.command)}</span>
            </button>
        `).join('');

        // Connect control WS
        connectControlWs(streamId);
    } catch (e) {
        panel.style.display = 'none';
    }
}

/**
 * Connect to the control WebSocket.
 */
function connectControlWs(streamId) {
    destroyControlWs();

    const host = window.location.hostname;
    const port = window.location.port || 3000;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${host}:${port}/ws/control`;

    controlWs = new WebSocket(wsUrl);

    controlWs.onopen = () => {
        const token = localStorage.getItem('token');
        controlWs.send(JSON.stringify({
            type: 'join',
            streamId: streamId,
            role: 'viewer',
            token: token || undefined
        }));
    };

    controlWs.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            handleControlMessage(msg);
        } catch { /* ignore */ }
    };

    controlWs.onerror = () => {
        console.warn('Control WS error');
    };

    controlWs.onclose = () => {
        console.log('Control WS closed');
    };
}

function destroyControlWs() {
    if (controlWs) {
        controlWs.close();
        controlWs = null;
    }
    controlCooldowns = {};
}

/* ── Send command ─────────────────────────────────────────────── */
function sendControl(command, btnEl, cooldownSecs) {
    if (!controlWs || controlWs.readyState !== WebSocket.OPEN) {
        toast('Controls not connected', 'error');
        return;
    }

    // Check cooldown
    if (controlCooldowns[command]) return;

    controlWs.send(JSON.stringify({
        type: 'command',
        command: command,
        streamId: currentStreamId,
    }));

    // Apply cooldown
    btnEl.classList.add('on-cooldown');
    controlCooldowns[command] = true;

    setTimeout(() => {
        btnEl.classList.remove('on-cooldown');
        delete controlCooldowns[command];
    }, (cooldownSecs || 1) * 1000);
}

/* ── Handle incoming control messages ─────────────────────────── */
function handleControlMessage(msg) {
    switch (msg.type) {
        case 'activity':
            // Show activity pulse on the control button
            showControlActivity(msg.command, msg.username);
            break;
        case 'hardware-status':
            // Update hardware connection status
            updateHardwareStatus(msg.connected);
            break;
        case 'error':
            toast(msg.message || 'Control error', 'error');
            break;
    }
}

function showControlActivity(command, username) {
    const btn = document.querySelector(`.control-btn[data-cmd="${command}"]`);
    if (!btn) return;

    btn.style.borderColor = 'var(--accent)';
    btn.style.boxShadow = '0 0 8px rgba(192,150,92,0.4)';

    setTimeout(() => {
        btn.style.borderColor = '';
        btn.style.boxShadow = '';
    }, 300);
}

function updateHardwareStatus(connected) {
    const header = document.querySelector('.controls-header h3');
    if (!header) return;
    const dot = connected ? '🟢' : '🔴';
    header.innerHTML = `<i class="fa-solid fa-gamepad"></i> Controls ${dot}`;
}

/* ── Keyboard controls ────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
    // Only when on stream page and not typing in input
    if (currentPage !== 'stream') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    const keyMap = {
        'ArrowUp': 'forward',
        'ArrowDown': 'backward',
        'ArrowLeft': 'left',
        'ArrowRight': 'right',
        'w': 'forward',
        's': 'backward',
        'a': 'left',
        'd': 'right',
        ' ': 'stop',
    };

    const command = keyMap[e.key];
    if (!command) return;

    e.preventDefault();
    const btn = document.querySelector(`.control-btn[data-cmd="${command}"]`);
    if (btn && !btn.classList.contains('on-cooldown')) {
        const cooldown = parseInt(btn.dataset.cooldown) || 1;
        sendControl(command, btn, cooldown);
    }
});
