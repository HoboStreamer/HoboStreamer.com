let canvasPageBootstrapped = false;
let canvasSocket = null;
let canvasBoardState = null;
let canvasTiles = new Map();
let canvasPresence = [];
let canvasActivity = [];
let canvasCursor = { x: 256, y: 256 };
let canvasHover = null;
let canvasSelectedColor = 1;
let canvasZoom = 2;
let canvasOffsetX = 0;
let canvasOffsetY = 0;
let canvasPanning = false;
let canvasDragStart = null;
let canvasRenderQueued = false;
let canvasUiTimer = null;
let canvasBitmap = null;
let canvasBitmapCtx = null;
let canvasBoundEvents = false;
const originalLoadGamePage = window.loadGamePage;

function ensureGameShell() {
    const page = document.getElementById('page-game');
    if (!page || page.dataset.canvasEnhanced === 'true') return;
    const adventureMarkup = page.innerHTML;
    page.innerHTML = `
        <div class="game-shell">
            <div class="game-mode-bar">
                <button class="game-mode-btn active" id="game-mode-canvas" onclick="navigate('/game')">
                    <i class="fa-solid fa-brush"></i> Canvas
                </button>
                <button class="game-mode-btn" id="game-mode-adventure" onclick="navigate('/game/adventure')">
                    <i class="fa-solid fa-mountain-sun"></i> Adventure
                </button>
            </div>
            <div class="game-pane active" id="game-pane-canvas">
                <div class="canvas-layout">
                    <aside class="canvas-sidebar">
                        <div class="canvas-card">
                            <h3><i class="fa-solid fa-globe"></i> Hobo Place</h3>
                            <p class="muted">A persistent 512x512 board. Click to paint, or use arrow keys plus space.</p>
                            <div class="canvas-status" id="canvas-status-text">Loading board...</div>
                            <div class="canvas-cooldown" id="canvas-cooldown-text">Cooldown: --</div>
                            <div class="canvas-coords" id="canvas-coords-text">Tile: --, --</div>
                        </div>
                        <div class="canvas-card">
                            <h3><i class="fa-solid fa-palette"></i> Palette</h3>
                            <div class="canvas-palette" id="canvas-palette"></div>
                        </div>
                        <div class="canvas-card">
                            <h3><i class="fa-solid fa-magnifying-glass-location"></i> Tile Info</h3>
                            <div class="canvas-hover" id="canvas-hover-meta">Hover a tile to inspect it.</div>
                        </div>
                        <div class="canvas-card">
                            <h3><i class="fa-solid fa-bolt"></i> Controls</h3>
                            <div class="canvas-help">
                                <div><strong>Click</strong> Paint selected color</div>
                                <div><strong>Wheel</strong> Zoom</div>
                                <div><strong>Right drag</strong> Pan</div>
                                <div><strong>Arrows</strong> Move cursor</div>
                                <div><strong>Space</strong> Place at cursor</div>
                                <div><strong>R</strong> Reset camera</div>
                            </div>
                        </div>
                    </aside>
                    <div class="canvas-stage-wrap">
                        <div class="canvas-toolbar">
                            <div class="canvas-toolbar-left">
                                <button class="btn btn-outline btn-small" onclick="resetCanvasCamera()"><i class="fa-solid fa-crosshairs"></i> Reset View</button>
                                <button class="btn btn-outline btn-small" onclick="centerCanvasCursor()"><i class="fa-solid fa-location-crosshairs"></i> Center Cursor</button>
                            </div>
                            <div class="canvas-toolbar-right">
                                <span class="badge" id="canvas-online-count">0 online</span>
                                <span class="badge" id="canvas-board-mode">Live</span>
                            </div>
                        </div>
                        <div class="canvas-stage" id="canvas-stage">
                            <canvas id="canvas-board" width="1200" height="800"></canvas>
                            <div class="canvas-login-prompt" id="canvas-login-prompt" style="display:none">
                                <strong>Login to paint.</strong> You can still watch the board live.
                            </div>
                        </div>
                    </div>
                    <aside class="canvas-sidebar canvas-sidebar-right">
                        <div class="canvas-card">
                            <h3><i class="fa-solid fa-clock-rotate-left"></i> Recent Activity</h3>
                            <div class="canvas-activity" id="canvas-activity-list"></div>
                        </div>
                        <div class="canvas-card">
                            <h3><i class="fa-solid fa-users"></i> Active Cursors</h3>
                            <div class="canvas-presence" id="canvas-presence-list"></div>
                        </div>
                        <div class="canvas-card">
                            <h3><i class="fa-solid fa-shield-halved"></i> Board Rules</h3>
                            <div class="canvas-help">
                                <div>Logged-in accounts place tiles.</div>
                                <div>Cooldown scales with your HoboGame total level.</div>
                                <div>Fresh accounts are clamped to 12 seconds.</div>
                                <div>Changed tiles stay locked for 20 seconds.</div>
                            </div>
                        </div>
                    </aside>
                </div>
            </div>
            <div class="game-pane" id="game-pane-adventure">${adventureMarkup}</div>
        </div>
    `;
    page.dataset.canvasEnhanced = 'true';
}

function setGameMode(mode) {
    ensureGameShell();
    document.getElementById('game-pane-canvas')?.classList.toggle('active', mode === 'canvas');
    document.getElementById('game-pane-adventure')?.classList.toggle('active', mode === 'adventure');
    document.getElementById('game-mode-canvas')?.classList.toggle('active', mode === 'canvas');
    document.getElementById('game-mode-adventure')?.classList.toggle('active', mode === 'adventure');
}

function buildCanvasPalette(colors) {
    const palette = document.getElementById('canvas-palette');
    if (!palette) return;
    palette.innerHTML = (colors || []).map((color, index) => `
        <button class="canvas-swatch ${index === canvasSelectedColor ? 'active' : ''}" style="background:${color}" onclick="selectCanvasColor(${index})" title="${color}"></button>
    `).join('');
}

function selectCanvasColor(index) {
    canvasSelectedColor = index;
    buildCanvasPalette(canvasBoardState?.board?.palette || []);
    queueCanvasRender();
}

function resetCanvasCamera() {
    const canvas = document.getElementById('canvas-board');
    if (!canvas || !canvasBoardState) return;
    canvasZoom = Math.max(1, Math.min(canvas.width / canvasBoardState.board.width, canvas.height / canvasBoardState.board.height));
    canvasOffsetX = Math.floor((canvas.width - canvasBoardState.board.width * canvasZoom) / 2);
    canvasOffsetY = Math.floor((canvas.height - canvasBoardState.board.height * canvasZoom) / 2);
    queueCanvasRender();
}

function centerCanvasCursor() {
    const canvas = document.getElementById('canvas-board');
    if (!canvas || !canvasBoardState) return;
    canvasOffsetX = Math.floor(canvas.width / 2 - (canvasCursor.x + 0.5) * canvasZoom);
    canvasOffsetY = Math.floor(canvas.height / 2 - (canvasCursor.y + 0.5) * canvasZoom);
    queueCanvasRender();
}

function syncCanvasAuthState() {
    const prompt = document.getElementById('canvas-login-prompt');
    if (prompt) prompt.style.display = currentUser ? 'none' : '';
}

function setupCanvasBitmap() {
    if (!canvasBoardState) return;
    canvasBitmap = document.createElement('canvas');
    canvasBitmap.width = canvasBoardState.board.width;
    canvasBitmap.height = canvasBoardState.board.height;
    canvasBitmapCtx = canvasBitmap.getContext('2d');
    paintCanvasBitmapBackground();
}

function paintCanvasBitmapBackground() {
    if (!canvasBitmapCtx || !canvasBoardState) return;
    canvasBitmapCtx.fillStyle = canvasBoardState.board.palette[0] || '#101418';
    canvasBitmapCtx.fillRect(0, 0, canvasBitmap.width, canvasBitmap.height);
}

function applyCanvasTiles(tiles) {
    for (const tile of tiles || []) {
        const key = `${tile.x},${tile.y}`;
        if (Number(tile.color_index || 0) === 0) {
            canvasTiles.delete(key);
        } else {
            canvasTiles.set(key, tile);
        }
        if (canvasBitmapCtx && canvasBoardState) {
            canvasBitmapCtx.fillStyle = canvasBoardState.board.palette[Number(tile.color_index || 0)] || canvasBoardState.board.palette[0];
            canvasBitmapCtx.fillRect(tile.x, tile.y, 1, 1);
        }
    }
}

function replaceCanvasTiles(tiles) {
    canvasTiles = new Map();
    paintCanvasBitmapBackground();
    applyCanvasTiles(tiles || []);
}

function queueCanvasRender() {
    if (canvasRenderQueued) return;
    canvasRenderQueued = true;
    requestAnimationFrame(() => {
        canvasRenderQueued = false;
        renderCanvasBoard();
    });
}

function renderCanvasBoard() {
    const canvas = document.getElementById('canvas-board');
    if (!canvas || !canvasBitmap || !canvasBoardState) return;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0f1318';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(canvasBitmap, canvasOffsetX, canvasOffsetY, canvasBitmap.width * canvasZoom, canvasBitmap.height * canvasZoom);

    if (canvasZoom >= 8) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        for (let x = 0; x <= canvasBitmap.width; x += 1) {
            const drawX = Math.round(canvasOffsetX + x * canvasZoom) + 0.5;
            ctx.beginPath();
            ctx.moveTo(drawX, canvasOffsetY);
            ctx.lineTo(drawX, canvasOffsetY + canvasBitmap.height * canvasZoom);
            ctx.stroke();
        }
        for (let y = 0; y <= canvasBitmap.height; y += 1) {
            const drawY = Math.round(canvasOffsetY + y * canvasZoom) + 0.5;
            ctx.beginPath();
            ctx.moveTo(canvasOffsetX, drawY);
            ctx.lineTo(canvasOffsetX + canvasBitmap.width * canvasZoom, drawY);
            ctx.stroke();
        }
    }

    const cursorX = canvasOffsetX + canvasCursor.x * canvasZoom;
    const cursorY = canvasOffsetY + canvasCursor.y * canvasZoom;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(cursorX, cursorY, canvasZoom, canvasZoom);

    canvasPresence.forEach((entry, index) => {
        if (!entry.cursor) return;
        const px = canvasOffsetX + (entry.cursor.x + 0.5) * canvasZoom;
        const py = canvasOffsetY + (entry.cursor.y + 0.5) * canvasZoom;
        ctx.beginPath();
        ctx.fillStyle = index === 0 ? '#ffd15c' : '#7ecbff';
        ctx.arc(px, py, Math.max(3, Math.min(6, canvasZoom / 2)), 0, Math.PI * 2);
        ctx.fill();
    });
}

function canvasTileFromPoint(clientX, clientY) {
    const canvas = document.getElementById('canvas-board');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left - canvasOffsetX) / canvasZoom);
    const y = Math.floor((clientY - rect.top - canvasOffsetY) / canvasZoom);
    if (!canvasBoardState || x < 0 || y < 0 || x >= canvasBoardState.board.width || y >= canvasBoardState.board.height) return null;
    return { x, y };
}

function updateCanvasHover(tile) {
    canvasHover = tile;
    const meta = document.getElementById('canvas-hover-meta');
    const coords = document.getElementById('canvas-coords-text');
    if (coords) coords.textContent = tile ? `Tile: ${tile.x}, ${tile.y}` : 'Tile: --, --';
    if (!meta) return;
    if (!tile) {
        meta.textContent = 'Hover a tile to inspect it.';
        return;
    }
    const stored = canvasTiles.get(`${tile.x},${tile.y}`);
    if (!stored) {
        meta.innerHTML = `Tile <strong>${tile.x}, ${tile.y}</strong><br>Empty`;
        return;
    }
    meta.innerHTML = `
        Tile <strong>${tile.x}, ${tile.y}</strong><br>
        Color: ${stored.color_index}<br>
        By: ${esc(stored.username || 'unknown')}<br>
        Updated: ${stored.updated_at ? new Date(toIso(stored.updated_at)).toLocaleString() : 'unknown'}
    `;
}

function pushCanvasActivity(entries) {
    const next = (entries || []).filter((entry) => entry.action_type !== 'blocked');
    canvasActivity = [...next, ...canvasActivity].slice(0, 60);
    const list = document.getElementById('canvas-activity-list');
    if (!list) return;
    if (!canvasActivity.length) {
        list.innerHTML = '<div class="muted">No activity yet.</div>';
        return;
    }
    list.innerHTML = canvasActivity.slice(0, 30).map((entry) => {
        const time = entry.created_at ? new Date(toIso(entry.created_at)).toLocaleTimeString() : '';
        if (entry.action_type === 'place') {
            return `<div class="canvas-activity-row"><strong>${esc(entry.username || 'unknown')}</strong> placed color ${entry.color_index} at ${entry.x},${entry.y}<span class="muted">${time}</span></div>`;
        }
        if (entry.action_type === 'rollback') {
            return `<div class="canvas-activity-row"><strong>${esc(entry.username || 'staff')}</strong> rolled back ${entry.x},${entry.y}<span class="muted">${time}</span></div>`;
        }
        return `<div class="canvas-activity-row"><strong>${esc(entry.action_type)}</strong><span class="muted">${time}</span></div>`;
    }).join('');
}

function renderCanvasPresence() {
    const list = document.getElementById('canvas-presence-list');
    const count = document.getElementById('canvas-online-count');
    if (count) count.textContent = `${canvasPresence.length} online`;
    if (!list) return;
    if (!canvasPresence.length) {
        list.innerHTML = '<div class="muted">No active cursors.</div>';
        return;
    }
    list.innerHTML = canvasPresence.slice(0, 20).map((entry) => `
        <div class="canvas-presence-row">
            <strong>${esc(entry.username || 'viewer')}</strong>
            <span class="muted">${entry.cursor ? `${entry.cursor.x}, ${entry.cursor.y}` : 'watching'}</span>
        </div>
    `).join('');
}

function renderCanvasBoardMode() {
    const el = document.getElementById('canvas-board-mode');
    const status = document.getElementById('canvas-status-text');
    if (!el || !canvasBoardState) return;
    const mode = canvasBoardState.settings?.frozen ? 'Frozen' : canvasBoardState.settings?.read_only ? 'Read Only' : 'Live';
    el.textContent = mode;
    if (status) status.textContent = `Board status: ${mode}`;
}

function updateCanvasCooldownText() {
    const el = document.getElementById('canvas-cooldown-text');
    if (!el) return;
    if (!currentUser) {
        el.textContent = 'Cooldown: login required to paint';
        return;
    }
    const cooldown = canvasBoardState?.cooldown;
    if (!cooldown) {
        el.textContent = 'Cooldown: --';
        return;
    }
    const seconds = Math.ceil(Math.max(0, cooldown.remaining_ms || 0) / 1000);
    if (seconds > 0) {
        el.textContent = `Cooldown: ${seconds}s remaining`;
    } else {
        el.textContent = `Cooldown: ready (${cooldown.cooldown_seconds}s base, level ${cooldown.total_level})`;
    }
}

async function fetchCanvasState() {
    const data = await api('/game/canvas/state');
    canvasBoardState = data;
    setupCanvasBitmap();
    replaceCanvasTiles(data.tiles);
    canvasActivity = data.recent_actions || [];
    buildCanvasPalette(data.board.palette);
    renderCanvasBoardMode();
    pushCanvasActivity([]);
    syncCanvasAuthState();
    if (!canvasZoom || !canvasOffsetX || !canvasOffsetY) resetCanvasCamera();
    queueCanvasRender();
    updateCanvasCooldownText();
}

function attachCanvasEvents() {
    if (canvasBoundEvents) return;
    canvasBoundEvents = true;
    const canvas = document.getElementById('canvas-board');
    if (!canvas) return;

    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('mousedown', (event) => {
        if (event.button === 2) {
            canvasPanning = true;
            canvasDragStart = { x: event.clientX, y: event.clientY, ox: canvasOffsetX, oy: canvasOffsetY };
            return;
        }
        const tile = canvasTileFromPoint(event.clientX, event.clientY);
        if (!tile) return;
        canvasCursor = tile;
        updateCanvasHover(tile);
        if (event.button === 0) placeCanvasTile(tile.x, tile.y);
        queueCanvasRender();
    });
    canvas.addEventListener('mousemove', (event) => {
        if (canvasPanning && canvasDragStart) {
            canvasOffsetX = canvasDragStart.ox + (event.clientX - canvasDragStart.x);
            canvasOffsetY = canvasDragStart.oy + (event.clientY - canvasDragStart.y);
            queueCanvasRender();
            return;
        }
        const tile = canvasTileFromPoint(event.clientX, event.clientY);
        updateCanvasHover(tile);
    });
    window.addEventListener('mouseup', () => {
        canvasPanning = false;
        canvasDragStart = null;
    });
    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const tileBefore = canvasTileFromPoint(event.clientX, event.clientY);
        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
        canvasZoom = Math.max(1, Math.min(24, canvasZoom * factor));
        if (tileBefore) {
            const rect = canvas.getBoundingClientRect();
            canvasOffsetX = event.clientX - rect.left - tileBefore.x * canvasZoom;
            canvasOffsetY = event.clientY - rect.top - tileBefore.y * canvasZoom;
        }
        queueCanvasRender();
    }, { passive: false });
    window.addEventListener('keydown', handleCanvasHotkeys);
}

function handleCanvasHotkeys(event) {
    if (currentPage !== 'game' || !document.getElementById('game-pane-canvas')?.classList.contains('active')) return;
    if (event.target && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
    let moved = false;
    if (event.key === 'ArrowLeft') { canvasCursor.x = Math.max(0, canvasCursor.x - 1); moved = true; }
    if (event.key === 'ArrowRight') { canvasCursor.x = Math.min((canvasBoardState?.board?.width || 512) - 1, canvasCursor.x + 1); moved = true; }
    if (event.key === 'ArrowUp') { canvasCursor.y = Math.max(0, canvasCursor.y - 1); moved = true; }
    if (event.key === 'ArrowDown') { canvasCursor.y = Math.min((canvasBoardState?.board?.height || 512) - 1, canvasCursor.y + 1); moved = true; }
    if (moved) {
        event.preventDefault();
        updateCanvasHover(canvasCursor);
        sendCanvasCursor();
        queueCanvasRender();
    }
    if (event.key === ' ' || event.key.toLowerCase() === 'enter') {
        event.preventDefault();
        placeCanvasTile(canvasCursor.x, canvasCursor.y);
    }
    if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        resetCanvasCamera();
    }
}

function sendCanvasCursor() {
    if (canvasSocket && canvasSocket.readyState === WebSocket.OPEN) {
        canvasSocket.send(JSON.stringify({ type: 'cursor', x: canvasCursor.x, y: canvasCursor.y }));
    }
}

async function placeCanvasTile(x, y) {
    if (!currentUser) {
        syncCanvasAuthState();
        toast('Login required to place tiles', 'info');
        return;
    }
    try {
        const result = await api('/game/canvas/place', { method: 'POST', body: { x, y, color_index: canvasSelectedColor } });
        if (result.tile) {
            applyCanvasTiles([result.tile]);
            canvasBoardState.cooldown = result.cooldown;
            updateCanvasCooldownText();
            queueCanvasRender();
        }
    } catch (error) {
        if (error.remaining_ms && canvasBoardState?.cooldown) {
            canvasBoardState.cooldown.remaining_ms = error.remaining_ms;
        }
        updateCanvasCooldownText();
        toast(error.message || 'Failed to place tile', 'error');
    }
}

function connectCanvasSocket() {
    if (canvasSocket) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = localStorage.getItem('token');
    const url = `${proto}//${window.location.host}/ws/canvas${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    canvasSocket = new WebSocket(url);
    canvasSocket.addEventListener('open', () => sendCanvasCursor());
    canvasSocket.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'tile_patch' && msg.tile) {
            applyCanvasTiles([msg.tile]);
            pushCanvasActivity([{ ...msg.tile, action_type: 'place', created_at: msg.tile.updated_at }]);
            queueCanvasRender();
        }
        if (msg.type === 'bulk_patch') {
            replaceCanvasTiles(msg.tiles || []);
            queueCanvasRender();
        }
        if (msg.type === 'board_reset') {
            replaceCanvasTiles([]);
            queueCanvasRender();
        }
        if (msg.type === 'board_state') {
            canvasBoardState.settings = { ...canvasBoardState.settings, ...msg.settings };
            renderCanvasBoardMode();
        }
        if (msg.type === 'presence' || msg.type === 'presence_snapshot') {
            canvasPresence = msg.users || [];
            renderCanvasPresence();
            queueCanvasRender();
        }
    });
    canvasSocket.addEventListener('close', () => { canvasSocket = null; });
}

async function loadCanvasPage() {
    ensureGameShell();
    setGameMode('canvas');
    syncCanvasAuthState();
    canvasPageBootstrapped = true;
    try {
        await fetchCanvasState();
        attachCanvasEvents();
        connectCanvasSocket();
        clearInterval(canvasUiTimer);
        canvasUiTimer = setInterval(updateCanvasCooldownText, 500);
    } catch (error) {
        toast(error.message || 'Failed to load canvas', 'error');
    }
}

function destroyCanvasPage() {
    clearInterval(canvasUiTimer);
    canvasUiTimer = null;
    if (canvasSocket) {
        canvasSocket.close();
        canvasSocket = null;
    }
}

window.loadCanvasPage = loadCanvasPage;
window.destroyCanvasPage = destroyCanvasPage;
window.resetCanvasCamera = resetCanvasCamera;
window.centerCanvasCursor = centerCanvasCursor;
window.selectCanvasColor = selectCanvasColor;
window.syncCanvasAuthState = syncCanvasAuthState;

window.loadGamePage = function wrappedLoadGamePage(...args) {
    ensureGameShell();
    setGameMode('adventure');
    return originalLoadGamePage ? originalLoadGamePage.apply(this, args) : undefined;
};
