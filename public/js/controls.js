/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Interactive Controls Client (WebSocket)
   Supports: Traditional buttons, ONVIF PTZ cameras
   ═══════════════════════════════════════════════════════════════ */

let controlWs = null;
let controlCooldowns = {};
let onvifCooldowns = {};
let currentStreamId = null;

/**
 * Load and display interactive controls for a stream.
 */
async function loadStreamControls(streamId) {
    const panel = document.getElementById('controls-panel');
    const grid = document.getElementById('controls-grid');
    currentStreamId = streamId;

    try {
        const data = await api(`/controls/${streamId}`);
        const controls = data.controls || [];

        if (!controls.length) {
            panel.style.display = 'none';
            return;
        }

        panel.style.display = '';
        
        // Separate ONVIF controls from regular controls
        const onvifControls = controls.filter(c => c.control_type === 'onvif' && c.camera_id);
        const regularControls = controls.filter(c => c.control_type !== 'onvif' || !c.camera_id);

        let html = '';

        // Render regular controls
        if (regularControls.length > 0) {
            html += '<div class="controls-row regular-controls">';
            html += regularControls.map(c => `
                <button class="control-btn" data-id="${c.id}" data-cmd="${esc(c.command)}" data-cooldown="${parseInt(c.cooldown_ms) || 500}"
                        onclick="sendControl(${c.id}, '${esc(c.command)}', this, ${parseInt(c.cooldown_ms) || 500})"
                        title="${esc(c.label || c.command)}" style="flex: 1;">
                    <i class="fa-solid ${esc(c.icon || 'fa-circle')}"></i>
                    <span>${esc(c.label || c.command)}</span>
                </button>
            `).join('');
            html += '</div>';
        }

        // Render ONVIF camera controls
        if (onvifControls.length > 0) {
            const uniqueCameras = [...new Set(onvifControls.map(c => c.camera_id))];
            for (const cameraId of uniqueCameras) {
                const cameraControls = onvifControls.filter(c => c.camera_id === cameraId);
                try {
                    const cameraData = await api(`/onvif/cameras/${cameraId}`);
                    html += renderOnvifCameraWidget(cameraData, cameraControls);
                } catch (e) {
                    console.warn(`Failed to load camera ${cameraId}:`, e);
                }
            }
        }

        grid.innerHTML = html;

        // Connect control WS
        connectControlWs(streamId);
    } catch (e) {
        console.error('Failed to load controls:', e);
        panel.style.display = 'none';
    }
}

/**
 * Render ONVIF camera control widget (D-pad + zoom + presets)
 */
function renderOnvifCameraWidget(camera, controls) {
    const id = `onvif-${camera.id}`;
    
    return `
        <div class="onvif-widget" id="${id}">
            <div class="onvif-header">
                <h3><i class="fa-solid fa-video"></i> ${esc(camera.name)}</h3>
                <span class="onvif-status ${camera.status === 'connected' ? 'connected' : camera.status === 'unreachable' ? 'unreachable' : 'unknown'}">
                    ${camera.status === 'connected' ? '🟢' : camera.status === 'unreachable' ? '🔴' : '⚪'}
                </span>
            </div>

            <div class="onvif-controls">
                <!-- D-Pad for Pan/Tilt -->
                <div class="dpad-container">
                    <button class="dpad-btn dpad-up" onclick="sendOnvifCommand(${camera.id}, 'tilt_up', this, 200)" title="Tilt up">
                        <i class="fa-solid fa-arrow-up"></i>
                    </button>
                    <button class="dpad-btn dpad-left" onclick="sendOnvifCommand(${camera.id}, 'pan_left', this, 200)" title="Pan left">
                        <i class="fa-solid fa-arrow-left"></i>
                    </button>
                    <button class="dpad-btn dpad-center" onclick="sendOnvifCommand(${camera.id}, 'stop', this, 0)" title="Stop">
                        <i class="fa-solid fa-circle"></i>
                    </button>
                    <button class="dpad-btn dpad-right" onclick="sendOnvifCommand(${camera.id}, 'pan_right', this, 200)" title="Pan right">
                        <i class="fa-solid fa-arrow-right"></i>
                    </button>
                    <button class="dpad-btn dpad-down" onclick="sendOnvifCommand(${camera.id}, 'tilt_down', this, 200)" title="Tilt down">
                        <i class="fa-solid fa-arrow-down"></i>
                    </button>
                </div>

                <!-- Zoom Controls -->
                <div class="zoom-container">
                    <button class="zoom-btn zoom-out" onclick="sendOnvifCommand(${camera.id}, 'zoom_out', this, 200)" title="Zoom out">
                        <i class="fa-solid fa-minus"></i>
                    </button>
                    <input type="range" class="zoom-slider" min="0" max="100" value="50" 
                           onchange="setOnvifZoom(${camera.id}, this.value)" title="Zoom">
                    <button class="zoom-btn zoom-in" onclick="sendOnvifCommand(${camera.id}, 'zoom_in', this, 200)" title="Zoom in">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>

                <!-- Preset Buttons -->
                <div class="presets-container" id="presets-${camera.id}">
                    <!-- Loaded dynamically -->
                </div>
            </div>
        </div>
    `;
}

/**
 * Load and render camera presets
 */
async function loadCameraPresets(cameraId) {
    try {
        const data = await api(`/onvif/cameras/${cameraId}/presets`);
        const presetsDiv = document.getElementById(`presets-${cameraId}`);
        if (!presetsDiv) return;

        if (!data.presets || data.presets.length === 0) {
            presetsDiv.innerHTML = '<p style="text-align:center;font-size:0.8em;color:#999;">No presets saved</p>';
            return;
        }

        presetsDiv.innerHTML = data.presets.map(preset => `
            <button class="preset-btn" onclick="gotoOnvifPreset(${cameraId}, ${preset.id}, this)">
                ${esc(preset.name)}
            </button>
        `).join('');
    } catch (e) {
        console.warn(`Failed to load presets for camera ${cameraId}:`, e);
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
        } catch (err) {
            console.warn('Failed to parse control message:', err);
        }
    };

    controlWs.onerror = (err) => {
        console.warn('Control WS error:', err);
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
    onvifCooldowns = {};
}

/* ── Send regular command ─────────────────────────────────────── */
function sendControl(controlId, command, btnEl, cooldownMs) {
    if (!controlWs || controlWs.readyState !== WebSocket.OPEN) {
        toast('Controls not connected', 'error');
        return;
    }

    // Check cooldown
    const cooldownKey = `cmd-${controlId}`;
    if (controlCooldowns[cooldownKey]) return;

    controlWs.send(JSON.stringify({
        type: 'command',
        control_id: controlId,
        command: command,
        streamId: currentStreamId,
    }));

    // Apply cooldown
    btnEl.classList.add('on-cooldown');
    controlCooldowns[cooldownKey] = true;

    setTimeout(() => {
        btnEl.classList.remove('on-cooldown');
        delete controlCooldowns[cooldownKey];
    }, cooldownMs || 500);
}

/* ── Send ONVIF command ──────────────────────────────────────── */
function sendOnvifCommand(cameraId, movement, btnEl, cooldownMs) {
    if (!controlWs || controlWs.readyState !== WebSocket.OPEN) {
        toast('Controls not connected', 'error');
        return;
    }

    // Check cooldown
    const cooldownKey = `onvif-${cameraId}-${movement}`;
    if (onvifCooldowns[cooldownKey]) return;

    controlWs.send(JSON.stringify({
        type: 'command',
        streamId: currentStreamId,
        isOnvif: true,
        cameraId: cameraId,
        movement: movement,
    }));

    // Apply cooldown
    if (btnEl) {
        btnEl.classList.add('on-cooldown');
    }
    onvifCooldowns[cooldownKey] = true;

    setTimeout(() => {
        if (btnEl) {
            btnEl.classList.remove('on-cooldown');
        }
        delete onvifCooldowns[cooldownKey];
    }, cooldownMs || 200);
}

/**
 * Adjust zoom level (sends discrete zoom_in/zoom_out as slider moves)
 */
let lastZoomValue = 50;
function setOnvifZoom(cameraId, value) {
    const numValue = parseInt(value);
    if (numValue > lastZoomValue) {
        sendOnvifCommand(cameraId, 'zoom_in', null, 100);
    } else if (numValue < lastZoomValue) {
        sendOnvifCommand(cameraId, 'zoom_out', null, 100);
    }
    lastZoomValue = numValue;
}

/**
 * Go to a saved preset position
 */
function gotoOnvifPreset(cameraId, presetId, btnEl) {
    if (!controlWs || controlWs.readyState !== WebSocket.OPEN) {
        toast('Controls not connected', 'error');
        return;
    }

    const cooldownKey = `preset-${cameraId}-${presetId}`;
    if (onvifCooldowns[cooldownKey]) return;

    controlWs.send(JSON.stringify({
        type: 'command',
        streamId: currentStreamId,
        isOnvif: true,
        cameraId: cameraId,
        movement: 'preset',
        presetId: presetId,
    }));

    btnEl.classList.add('on-cooldown');
    onvifCooldowns[cooldownKey] = true;

    setTimeout(() => {
        btnEl.classList.remove('on-cooldown');
        delete onvifCooldowns[cooldownKey];
    }, 500);
}

/* ── Handle incoming control messages ─────────────────────────── */
function handleControlMessage(msg) {
    switch (msg.type) {
        case 'command_executed':
            showControlActivity(msg.command, msg.by);
            break;
        case 'onvif_activity':
            showOnvifActivity(msg.camera_name, msg.movement, msg.by);
            break;
        case 'hardware_status':
            updateHardwareStatus(msg.connected);
            break;
        case 'error':
            toast(msg.message || 'Control error', 'error');
            break;
        case 'cooldown':
            console.warn('Command on cooldown');
            break;
        case 'ok':
            // Command executed successfully
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

function showOnvifActivity(cameraName, movement, username) {
    const widget = document.querySelector('.onvif-widget');
    if (!widget) return;

    widget.style.borderColor = 'var(--accent)';
    widget.style.boxShadow = '0 0 12px rgba(192,150,92,0.5)';

    setTimeout(() => {
        widget.style.borderColor = '';
        widget.style.boxShadow = '';
    }, 300);
}

function updateHardwareStatus(connected) {
    const header = document.querySelector('.controls-header h3');
    if (!header) return;
    const dot = connected ? '🟢' : '🔴';
    header.textContent = `Controls ${dot}`;
}

/* ── Keyboard controls for ONVIF cameras ──────────────────────── */
document.addEventListener('keydown', (e) => {
    // Only when on stream page and not typing in input
    if (!currentStreamId) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    const cameraId = getCurrentONVIFCamera(); // First visible ONVIF camera
    if (!cameraId) return;

    const keyMap = {
        'ArrowUp': 'tilt_up',
        'ArrowDown': 'tilt_down',
        'ArrowLeft': 'pan_left',
        'ArrowRight': 'pan_right',
        '[': 'zoom_out',
        ']': 'zoom_in',
        ' ': 'stop',
    };

    const movement = keyMap[e.key];
    if (!movement) return;

    e.preventDefault();
    sendOnvifCommand(cameraId, movement, null, 200);
});

function getCurrentONVIFCamera() {
    const widget = document.querySelector('.onvif-widget');
    if (!widget) return null;
    const id = widget.id; // "onvif-{cameraId}"
    return parseInt(id.split('-')[1]);
}
