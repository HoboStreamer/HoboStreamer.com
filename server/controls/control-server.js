/**
 * HoboStreamer — Control Server
 * 
 * WebSocket server for interactive camp controls.
 * Viewers send commands → server relays → hardware client (Raspberry Pi) OR ONVIF camera.
 * 
 * Architecture:
 *   Browser → WebSocket → Control Server → (Hardware WS OR ONVIF) → Endpoint
 */
const WebSocket = require('ws');
const db = require('../db/database');
const { authenticateWs } = require('../auth/auth');
const { OnvifClient } = require('../core/onvif-client');

class ControlServer {
    constructor() {
        this.wss = null;
        /** @type {Map<string, WebSocket>} streamKey → hardware client WebSocket */
        this.hardwareClients = new Map();
        /** @type {Map<WebSocket, { user: object, streamId: number }>} */
        this.viewerClients = new Map();
        /** @type {Map<string, number>} streamKey → command count (cooldown) */
        this.commandCounts = new Map();
    }

    /**
     * Initialize the control WebSocket server
     */
    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        console.log('[Control] WebSocket control server initialized');
        return this.wss;
    }

    /**
     * Handle WebSocket upgrade for control connections
     */
    handleUpgrade(req, socket, head) {
        if (req.url.startsWith('/ws/control')) {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
            return true;
        }
        return false;
    }

    /**
     * Handle a new control connection
     */
    handleConnection(ws, req) {
        const urlParams = new URL(req.url, 'http://localhost').searchParams;
        const token = urlParams.get('token');
        const streamKey = urlParams.get('stream_key');
        const mode = urlParams.get('mode'); // 'hardware' or 'viewer'

        if (mode === 'hardware') {
            this.handleHardwareConnection(ws, streamKey);
        } else {
            this.handleViewerConnection(ws, token, urlParams);
        }
    }

    /**
     * Handle hardware client connection (Raspberry Pi / controller)
     */
    handleHardwareConnection(ws, streamKey) {
        if (!streamKey) {
            ws.close(4001, 'Stream key required');
            return;
        }

        const user = db.getUserByStreamKey(streamKey);
        if (!user) {
            ws.close(4002, 'Invalid stream key');
            return;
        }

        this.hardwareClients.set(streamKey, ws);
        console.log(`[Control] Hardware client connected: ${user.username} (${streamKey.slice(0, 8)}...)`);

        ws.send(JSON.stringify({ type: 'connected', message: 'Hardware client registered' }));

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                // Hardware can send status updates back
                if (msg.type === 'status') {
                    this.broadcastToViewers(streamKey, {
                        type: 'hardware_status',
                        ...msg,
                    });
                }
            } catch { /* ignore */ }
        });

        ws.on('close', () => {
            this.hardwareClients.delete(streamKey);
            console.log(`[Control] Hardware client disconnected: ${streamKey.slice(0, 8)}...`);
        });
    }

    /**
     * Handle viewer control connection
     */
    handleViewerConnection(ws, token, params) {
        const streamId = parseInt(params.get('stream')) || null;
        const user = authenticateWs(token);

        this.viewerClients.set(ws, { user, streamId });

        // Send available controls
        if (streamId) {
            const controls = db.getStreamControls(streamId);
            ws.send(JSON.stringify({ type: 'controls', controls }));
        }

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'command') {
                    this.handleCommand(ws, msg);
                }
            } catch { /* ignore */ }
        });

        ws.on('close', () => {
            this.viewerClients.delete(ws);
        });
    }

    /**
     * Handle a control command from a viewer
     */
    async handleCommand(ws, msg) {
        const client = this.viewerClients.get(ws);
        if (!client || !client.streamId) return;

        const { command, control_id, isOnvif, cameraId, movement } = msg;
        if (!command && !isOnvif) return;

        // Get the stream to find the stream key
        const stream = db.getStreamById(client.streamId);
        if (!stream) return;

        const user = db.getUserById(stream.user_id);
        if (!user) return;

        // Check cooldown
        if (control_id) {
            const control = db.get('SELECT * FROM stream_controls WHERE id = ?', [control_id]);
            if (control) {
                const lastCmd = this.commandCounts.get(`${client.streamId}-${control_id}`) || 0;
                if (Date.now() - lastCmd < (control.cooldown_ms || 500)) {
                    ws.send(JSON.stringify({ type: 'cooldown', message: 'Command on cooldown' }));
                    return;
                }
                this.commandCounts.set(`${client.streamId}-${control_id}`, Date.now());
            }
        }

        // Handle ONVIF camera movement
        if (isOnvif && cameraId && movement) {
            try {
                const camera = db.getCameraProfile(cameraId);
                if (!camera) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Camera not found' }));
                    return;
                }

                // Create ONVIF client and execute movement
                const bcrypt = require('bcryptjs');
                const password = camera.password_hash; // For now, hash IS the plaintext (MVP)
                
                const onvifClient = new OnvifClient(camera.onvif_url, camera.username, password);
                const connected = await Promise.race([
                    onvifClient.connect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
                ]);

                if (!connected) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Camera unreachable' }));
                    return;
                }

                // Execute movement command
                const movements = {
                    'pan_left': [-camera.pan_speed, 0, 0],
                    'pan_right': [camera.pan_speed, 0, 0],
                    'tilt_up': [0, camera.tilt_speed, 0],
                    'tilt_down': [0, -camera.tilt_speed, 0],
                    'zoom_in': [0, 0, camera.zoom_speed],
                    'zoom_out': [0, 0, -camera.zoom_speed],
                };

                const [panSpeed, tiltSpeed, zoomSpeed] = movements[movement] || [0, 0, 0];

                if (panSpeed !== 0 || tiltSpeed !== 0 || zoomSpeed !== 0) {
                    await onvifClient.relativeMove(panSpeed, tiltSpeed, zoomSpeed, 300);
                }

                onvifClient.disconnect();

                // Broadcast activity to other viewers
                this.broadcastToViewers(user.stream_key, {
                    type: 'onvif_activity',
                    camera_name: camera.name,
                    movement,
                    by: client.user?.username || 'anonymous',
                });

                ws.send(JSON.stringify({ type: 'ok', message: 'Movement executed' }));

            } catch (err) {
                console.error('[Control] ONVIF error:', err.message);
                ws.send(JSON.stringify({ type: 'error', message: 'Camera command failed: ' + err.message }));
            }
            return;
        }

        // Handle traditional hardware commands
        if (!stream.is_live) {
            ws.send(JSON.stringify({ type: 'error', message: 'Stream not live' }));
            return;
        }

        // Check if hardware client is connected
        const hardwareWs = this.hardwareClients.get(user.stream_key);
        if (!hardwareWs || hardwareWs.readyState !== WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Hardware not connected' }));
            return;
        }

        // Forward command to hardware
        hardwareWs.send(JSON.stringify({
            type: 'command',
            command,
            control_id,
            from_user: client.user?.username || 'anonymous',
            timestamp: new Date().toISOString(),
        }));

        // Broadcast command activity to other viewers
        this.broadcastToViewers(user.stream_key, {
            type: 'command_executed',
            command,
            by: client.user?.username || 'anonymous',
        });
    }

    /**
     * Broadcast to all viewers watching a specific stream
     */
    broadcastToViewers(streamKey, data) {
        const user = db.getUserByStreamKey(streamKey);
        if (!user) return;

        const stream = db.getStreamByUserId(user.id);
        if (!stream) return;

        const msg = JSON.stringify(data);
        for (const [ws, client] of this.viewerClients) {
            if (client.streamId === stream.id && ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        }
    }

    close() {
        if (this.wss) {
            this.wss.clients.forEach(ws => ws.close());
            this.wss.close();
        }
    }
}

module.exports = new ControlServer();
