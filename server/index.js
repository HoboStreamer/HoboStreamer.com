/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║            HoboStreamer.com — Main Server                 ║
 * ║  Live streaming platform for stealth campers & nomads     ║
 * ║  Paired with HoboApp — Open Source & Community Driven     ║
 * ╚═══════════════════════════════════════════════════════════╝
 * 
 * Streaming: JSMPEG + WebRTC (Mediasoup) + RTMP
 * Chat: WebSocket with anon handling + word filter
 * Currency: Hobo Bucks (1 HB = $1.00 USD)
 * Controls: Interactive hardware API (Raspberry Pi)
 */

// Prevent sub-service port conflicts from crashing the main HTTP server
process.on('uncaughtException', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`[Server] Port ${err.port || '?'} already in use — sub-service skipped`);
    } else {
        console.error('[Server] Uncaught exception:', err);
        process.exit(1);
    }
});

const path = require('path');
const fs = require('fs');

// Load env before anything else
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');

// Database
const db = require('./db/database');

// Streaming
const jsmpegRelay = require('./streaming/jsmpeg-relay');
const webrtcSFU = require('./streaming/webrtc-sfu');
const rtmpServer = require('./streaming/rtmp-server');

// Real-time
const chatServer = require('./chat/chat-server');
const controlServer = require('./controls/control-server');
const broadcastServer = require('./streaming/broadcast-server');
const callServer = require('./streaming/call-server');

// Routes
const authRoutes = require('./auth/routes');
const streamRoutes = require('./streaming/routes');
const chatRoutes = require('./chat/routes');
const monetizationRoutes = require('./monetization/routes');
const coinsRoutes = require('./monetization/coins-routes');
const cosmeticsRoutes = require('./monetization/cosmetics-routes');
const cosmeticsModule = require('./monetization/cosmetics');
const vodRoutes = require('./vod/routes');
const clipRoutes = require('./vod/clips-routes');
const commentRoutes = require('./vod/comments-routes');
const controlRoutes = require('./controls/routes');
const adminRoutes = require('./admin/routes');
const { requireAuth } = require('./auth/auth');
const permissions = require('./auth/permissions');
const robotStreamerRoutes = require('./integrations/routes');
const thumbnailRoutes = require('./thumbnails/routes');
const thumbnailService = require('./thumbnails/thumbnail-service');
const themeRoutes = require('./themes/routes');
const emoteRoutes = require('./emotes/routes');
const metaRoutes = require('./meta/routes');
const pasteRoutes = require('./pastes/routes');
const robotStreamerService = require('./integrations/robotstreamer-service');
const chatRelayService = require('./integrations/chat-relay-service');

// Restream
const restreamRoutes = require('./streaming/restream-routes');
const restreamManager = require('./streaming/restream-manager');

// Game & Canvas — migrated to hobo.quest (game/canvas code removed)

// ── Express App ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

function normalizeOrigin(origin) {
    if (!origin || typeof origin !== 'string') return null;
    try {
        return new URL(origin).origin;
    } catch {
        return null;
    }
}

function getAllowedOrigins() {
    const allowed = new Set();
    const baseOrigin = normalizeOrigin(config.baseUrl);
    if (baseOrigin) allowed.add(baseOrigin);

    // hobo.quest game client calls cosmetics API cross-origin
    allowed.add('https://hobo.quest');

    if (config.nodeEnv !== 'production') {
        [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost:3200',
        ].forEach(origin => allowed.add(origin));
    }

    return allowed;
}

const allowedOrigins = getAllowedOrigins();

// ── Middleware ────────────────────────────────────────────────
app.set('trust proxy', 2); // Two hops: Cloudflare → nginx → Node

app.use(helmet({
    contentSecurityPolicy: false, // Allow inline scripts for dev
    crossOriginEmbedderPolicy: false,
}));
app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cookieParser());
app.use((err, req, res, next) => {
    if (err && err.message === 'Origin not allowed by CORS') {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    next(err);
});

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down partner' },
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many auth attempts, please try again later' },
});
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many upload requests, please slow down' },
});
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/avatar', uploadLimiter);
app.use('/api/thumbnails/live', uploadLimiter);
app.use('/api/vods/upload', uploadLimiter);
// Only rate-limit VOD upload chunk endpoint, not the read-only /live poll
app.use('/api/vods/stream/:streamId/chunk', uploadLimiter);
app.use('/api/vods/stream/:streamId/finalize', uploadLimiter);
app.use('/api/vods/clips', uploadLimiter);

// ── IP Ban Enforcement ───────────────────────────────────────
// Check if the requester's IP is globally banned. If so, return 404 for page requests
// and 403 for API requests. This makes the site appear to not exist for banned IPs.
app.use((req, res, next) => {
    // Skip health check so monitoring still works
    if (req.url === '/api/health') return next();
    try {
        if (db.isIpBanned(req.ip, null)) {
            if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
                return res.status(403).json({ error: 'Access denied' });
            }
            return res.status(404).send('<!DOCTYPE html><html><head><title>404</title></head><body><h1>404 Not Found</h1></body></html>');
        }
    } catch (e) { /* DB error — let request through rather than block everyone */ }
    next();
});

// ── Static Files ─────────────────────────────────────────────
// JS/CSS/HTML: no-cache + tell Cloudflare CDN not to cache at edge
// Browsers revalidate with etag (304 Not Modified), CDN always fetches fresh from origin
const noCacheHeaders = (res) => { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('CDN-Cache-Control', 'no-store'); };
app.use('/js', express.static(path.join(__dirname, '../public/js'), { maxAge: 0, etag: true, lastModified: true, setHeaders: noCacheHeaders }));
app.use('/css', express.static(path.join(__dirname, '../public/css'), { maxAge: 0, etag: true, lastModified: true, setHeaders: noCacheHeaders }));
app.use(express.static(path.join(__dirname, '../public'), { setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) noCacheHeaders(res); } }));

// Ensure data directories exist
['./data', './data/vods', './data/clips', './data/media', './data/thumbnails', './data/emotes', './data/avatars', './data/pastes', './data/pastes/screenshots'].forEach(dir => {
    const fullPath = path.resolve(dir);
    if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// Serve VOD/media files
app.use('/media', express.static(path.resolve('./data/media')));

// Map file extensions to forced image MIME types
const IMAGE_EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };

// Serve avatar files (force image Content-Type, prevent XSS via spoofed extensions)
app.use('/data/avatars', express.static(path.resolve('./data/avatars'), {
    setHeaders: (res, filePath) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        const ext = path.extname(filePath).toLowerCase();
        if (IMAGE_EXT_MIME[ext]) res.setHeader('Content-Type', IMAGE_EXT_MIME[ext]);
    },
}));

// Serve paste screenshots (force image Content-Type, prevent XSS via spoofed extensions)
app.use('/data/pastes/screenshots', express.static(path.resolve('./data/pastes/screenshots'), {
    setHeaders: (res, filePath) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        const ext = path.extname(filePath).toLowerCase();
        if (IMAGE_EXT_MIME[ext]) res.setHeader('Content-Type', IMAGE_EXT_MIME[ext]);
    },
}));

// ── API Routes ───────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/streams', streamRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/funds', monetizationRoutes);
app.use('/api/coins', coinsRoutes);
app.use('/api/cosmetics', cosmeticsRoutes);
app.use('/api/vods', vodRoutes);
app.use('/api/clips', clipRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/controls', controlRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/mod', require('./admin/mod-routes'));
app.use('/api/channels', require('./admin/channel-mod-routes'));
app.use('/api/robotstreamer', robotStreamerRoutes);
app.use('/api/restream', restreamRoutes);
app.use('/api/thumbnails', thumbnailRoutes);
app.use('/api/themes', themeRoutes);
app.use('/api/emotes', emoteRoutes);
// Game & Canvas — migrated to hobo.quest
app.get('/game', (req, res) => res.redirect(301, 'https://hobo.quest/game'));
app.get('/canvas', (req, res) => res.redirect(301, 'https://hobo.quest/canvas'));
app.use('/api/game', (req, res) => res.status(410).json({ error: 'Game has moved to https://hobo.quest/game' }));
app.use('/api/meta', metaRoutes);
app.use('/api/pastes', pasteRoutes);
const ttsRoutes = require('./chat/tts-routes');
app.use('/api/tts', ttsRoutes);
const dmRoutes = require('./chat/dm-routes');
app.use('/api/dm', dmRoutes);

// ── Health Check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        name: 'HoboStreamer',
        version: '1.0.0',
        uptime: process.uptime(),
        chat_connections: chatServer.getTotalConnections(),
    });
});

// ── Updates / Changelog ──────────────────────────────────────
const { execSync } = require('child_process');
const REPO_DIR = path.resolve(__dirname, '..');

/**
 * GET /api/updates — returns recent git commit history for the updates page.
 * Query params: ?limit=30 (default 30, max 100)
 */
app.get('/api/updates', (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
        const raw = execSync(
            `git --no-pager log --pretty=format:'%H||%h||%s||%an||%aI' -${limit}`,
            { cwd: REPO_DIR, encoding: 'utf8', timeout: 5000 }
        );
        const commits = raw.trim().split('\n').filter(Boolean).map(line => {
            const [hash, short, subject, author, date] = line.split('||');
            return { hash, short, subject, author, date };
        });
        res.json({ commits });
    } catch (err) {
        console.error('[Updates] git log error:', err.message);
        res.status(500).json({ error: 'Failed to read update history' });
    }
});

/**
 * POST /api/admin/broadcast — admin sends a message to all chat clients.
 * Body: { type: 'system'|'server_restart'|'update', message, summary, url }
 */
app.post('/api/admin/broadcast', requireAuth, permissions.requireAdmin, (req, res) => {
    try {
        const { type = 'system', message, summary, url } = req.body;
        if (!message && !summary) return res.status(400).json({ error: 'message or summary required' });
        chatServer.broadcastAll({
            type,
            message: message || summary,
            summary,
            url,
            timestamp: new Date().toISOString(),
        });
        res.json({ ok: true, clients: chatServer.getTotalConnections() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── OBS Overlay Widgets ──────────────────────────────────────
// Modular system: /obs/<widget>/<username>
// Each widget is a standalone HTML page designed for OBS browser sources.
app.get('/obs/chat/:username', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/obs/chat.html'));
});

// ── SPA Fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
    // Don't serve HTML for API routes
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Global Error Handler ─────────────────────────────────────
app.use((err, req, res, _next) => {
    // Multer file-filter / size-limit errors → 400
    if (err.name === 'MulterError' || (err.message && err.message.includes('file'))) {
        return res.status(400).json({ error: err.message || 'File upload error' });
    }
    console.error('[Server] Unhandled route error:', err.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// ── WebSocket Upgrade Handler ────────────────────────────────
server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    const origin = normalizeOrigin(req.headers.origin);

    if (origin && !allowedOrigins.has(origin)) {
        socket.destroy();
        return;
    }

    // Block banned IPs from WebSocket connections
    try {
        const wsIp = chatServer.getClientIp(req);
        if (db.isIpBanned(wsIp, null)) {
            socket.destroy();
            return;
        }
    } catch (e) { /* non-critical — allow through on DB error */ }

    if (url.startsWith('/ws/chat')) {
        chatServer.handleUpgrade(req, socket, head);
    } else if (url.startsWith('/ws/broadcast')) {
        broadcastServer.handleUpgrade(req, socket, head);
    } else if (url.startsWith('/ws/control')) {
        controlServer.handleUpgrade(req, socket, head);
    } else if (url.startsWith('/ws/call')) {
        callServer.handleUpgrade(req, socket, head);
    } else if (url.startsWith('/ws/game') || url.startsWith('/ws/canvas')) {
        socket.destroy(); // migrated to hobo.quest
    } else if (url.startsWith('/ws/robotstreamer-publish')) {
        robotStreamerService.handleUpgrade(req, socket, head);
    } else {
        socket.destroy();
    }
});

// ── Initialize & Start ──────────────────────────────────────
async function start() {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║     🏕️  HoboStreamer.com  v1.0.0     ║');
    console.log('  ║   Live Streaming for Camp Culture    ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');

    // 1. Initialize database
    db.initDb();
    // Initialize cosmetics tables
    cosmeticsModule.ensureTables();
    // Initialize tags tables
    const tagsModule = require('./game/tags');
    tagsModule.ensureTagTables();
    // Initialize DM tables
    const dm = require('./chat/dm');
    dm.ensureTables();
    // Migrate: add last_heartbeat column if missing
    try { db.run("ALTER TABLE streams ADD COLUMN last_heartbeat DATETIME"); console.log('[DB] Added last_heartbeat column'); } catch { /* already exists */ }
    // Migrate: add theme_id to users table if missing
    try { db.run("ALTER TABLE users ADD COLUMN theme_id INTEGER"); console.log('[DB] Added theme_id column'); } catch { /* already exists */ }
    // Migrate: add is_recording column to vods table for live VOD tracking
    try { db.run("ALTER TABLE vods ADD COLUMN is_recording INTEGER DEFAULT 0"); console.log('[DB] Added vods.is_recording column'); } catch { /* already exists */ }
    // Migrate: add call_mode column to streams table for group calls
    try { db.run("ALTER TABLE streams ADD COLUMN call_mode TEXT DEFAULT NULL"); console.log('[DB] Added streams.call_mode column'); } catch { /* already exists */ }
    console.log('[Server] Database ready');

    // Seed built-in themes if empty
    try {
        const themeCount = db.get("SELECT COUNT(*) as count FROM themes WHERE is_builtin = 1");
        if (!themeCount || themeCount.count === 0) {
            const themeService = require('./themes/theme-service');
            themeService.seedBuiltinThemes();
            console.log('[Themes] Built-in themes seeded');
        }
    } catch (err) {
        console.warn('[Themes] Seed error:', err.message);
    }

    // 2. Create admin from .env config if none exists (first-time setup only)
    const adminExists = db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (!adminExists) {
        const bcrypt = require('bcryptjs');
        const { v4: uuidv4 } = require('uuid');
        const adminUser = config.adminUsername || 'admin';
        const adminPass = config.adminPassword || 'changeme123';
        db.createUser({
            username: adminUser,
            email: null,
            password_hash: bcrypt.hashSync(adminPass, 10),
            display_name: adminUser,
            stream_key: uuidv4().replace(/-/g, ''),
        });
        db.run("UPDATE users SET role = 'admin' WHERE username = ?", [adminUser]);
        console.log(`[Server] Admin user "${adminUser}" created from ADMIN_USERNAME — change password after first login!`);
    }

    // Game & Canvas migrated to hobo.quest — no local init needed

    // 3. Initialize chat server
    chatServer.init(server);

    // 4. Initialize control server
    controlServer.init(server);

    // 4b. Initialize broadcast server
    broadcastServer.init(server);

    // Game & Canvas WebSocket servers migrated to hobo.quest

    // 4d. Initialize group call signaling server
    callServer.init(server);

    for (const stream of db.getLiveStreams()) {
        robotStreamerService.startForStream(stream).catch((err) => {
            console.warn(`[RS] Restore failed for stream ${stream.id}:`, err.message);
        });
        chatRelayService.startForStream(stream).catch((err) => {
            console.warn(`[ChatRelay] Restore failed for stream ${stream.id}:`, err.message);
        });
    }

    // 4e. Refresh heartbeats for streams surviving a server restart
    // After a deploy/restart, is_live=1 streams have stale heartbeats from before
    // the server went down. Without this, the stale-stream cleanup (every 60s) would
    // kill them before the broadcaster's client can reconnect and resume heartbeating.
    // This gives broadcasters a fresh 5-minute window to reconnect.
    const survivingStreams = db.all('SELECT id FROM streams WHERE is_live = 1');
    if (survivingStreams.length > 0) {
        db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE is_live = 1');
        console.log(`[Server] Refreshed heartbeats for ${survivingStreams.length} surviving stream(s) — broadcasters have 5 min to reconnect`);
    }

    // 5. Initialize WebRTC SFU (may fail if mediasoup not installed)
    try {
        await webrtcSFU.init();
    } catch (err) {
        console.warn('[Server] WebRTC SFU not available:', err.message);
    }

    // 6. Start RTMP server (may fail if node-media-server not installed)
    try {
        // node-media-server registers process.on('uncaughtException') that calls process.exit()
        // We need to remove it so port conflicts don't crash the main HTTP server
        const listenersBefore = process.listeners('uncaughtException').slice();
        rtmpServer.start();
        const listenersAfter = process.listeners('uncaughtException');
        for (const fn of listenersAfter) {
            if (!listenersBefore.includes(fn)) {
                process.removeListener('uncaughtException', fn);
            }
        }
    } catch (err) {
        console.warn('[Server] RTMP server not available:', err.message);
    }

    // 6b. Hook RTMP events for auto-start/stop restreams
    rtmpServer.on('publish', ({ streamId, userId, streamKey }) => {
        restreamManager.autoStartForStream(streamId, userId, { protocol: 'rtmp', streamKey }).catch(err => {
            console.warn(`[Restream] RTMP auto-start error for stream ${streamId}:`, err.message);
        });
    });
    rtmpServer.on('unpublish', ({ streamId }) => {
        restreamManager.stopAllForStream(streamId);
    });

    // 6c. Hook WebRTC SFU events for auto-start restreams
    // When a broadcaster produces into the SFU (triggered by restream request),
    // the first video producer signals that media is available for restreaming.
    webrtcSFU.on('producer-added', ({ roomId, kind }) => {
        if (kind !== 'video') return; // Only trigger on video producer
        const match = roomId.match(/^stream-(\d+)$/);
        if (!match) return;
        const streamId = parseInt(match[1]);
        const stream = db.getStreamById(streamId);
        if (!stream?.is_live || stream.protocol !== 'webrtc') return;
        restreamManager.autoStartForStream(streamId, stream.user_id, { protocol: 'webrtc' }).catch(err => {
            console.warn(`[Restream] WebRTC auto-start error for stream ${streamId}:`, err.message);
        });
    });

    // 6d. Hook broadcaster connection for WebRTC restream resume
    // When a broadcaster connects (or reconnects after server restart), resume ALL enabled
    // restreams — not just auto_start ones. If the stream is live, all restreams should run.
    broadcastServer.on('broadcaster-connected', ({ streamId, userId }) => {
        const stream = db.getStreamById(streamId);
        if (!stream?.is_live || stream.protocol !== 'webrtc') return;
        restreamManager.resumeForStream(streamId, userId, { protocol: 'webrtc' }).catch(err => {
            console.warn(`[Restream] Broadcaster-connect resume error for stream ${streamId}:`, err.message);
        });
    });

    // 6e. Start periodic viewer count polling for restream destinations
    restreamManager.startViewerCountPolling();

    // 7. Start HTTP server
    server.listen(config.port, config.host, () => {
        console.log('');
        console.log(`[Server] HTTP server:  http://${config.host}:${config.port}`);
        console.log(`[Server] WebSocket:    ws://${config.host}:${config.port}/ws/chat`);
        console.log(`[Server] WebSocket:    ws://${config.host}:${config.port}/ws/broadcast`);
        console.log(`[Server] WebSocket:    ws://${config.host}:${config.port}/ws/control`);
        console.log(`[Server] WebSocket:    ws://${config.host}:${config.port}/ws/call`);
        console.log(`[Server] Game/Canvas:  migrated to hobo.quest`);
        console.log(`[Server] Environment:  ${config.nodeEnv}`);
        console.log('');
        console.log('[Server] Ready. Happy camping! 🏕️');
        console.log('');

        // Broadcast recent git changes to all chat clients after startup.
        // Uses a retry loop — clients reconnect with backoff after a restart,
        // so a single 5s broadcast misses most of them. We broadcast at 5s,
        // 15s, and 30s intervals, tracking which clients already received it.
        // The message is also persisted to chat_messages so it shows in history.
        const _changelogSentTo = new Set();
        let _changelogBroadcasts = 0;
        const _changelogMaxBroadcasts = 3;
        const _changelogDelays = [5000, 15000, 30000];

        function broadcastChangelog() {
            try {
                // Get git describe for a human-readable version tag
                let versionTag = '';
                try {
                    versionTag = execSync('git describe --always --tags', { cwd: REPO_DIR, encoding: 'utf8', timeout: 3000 }).trim();
                } catch { versionTag = ''; }

                const raw = execSync(
                    `git --no-pager log --pretty=format:'%H||%h||%s||%an||%aI' -10`,
                    { cwd: REPO_DIR, encoding: 'utf8', timeout: 5000 }
                );
                const commits = raw.trim().split('\n').filter(Boolean).map(line => {
                    const [hash, short, subject, author, date] = line.split('||');
                    return { hash, short, subject, author, date };
                });
                if (commits.length === 0) return;

                // Build summary: use version tag if available, otherwise top 3 subjects
                const top3 = commits.slice(0, 3).map(c => c.subject).join(' · ');
                const versionPrefix = versionTag ? `(${versionTag}) ` : '';
                // Include relative time since the most recent commit
                const latestDate = commits[0].date ? new Date(commits[0].date) : null;
                let timeSuffix = '';
                if (latestDate) {
                    const ago = Date.now() - latestDate.getTime();
                    if (ago < 60_000) timeSuffix = ' (just now)';
                    else if (ago < 3_600_000) timeSuffix = ` (${Math.round(ago / 60_000)}m ago)`;
                    else if (ago < 86_400_000) timeSuffix = ` (${Math.round(ago / 3_600_000)}h ago)`;
                    else timeSuffix = ` (${Math.round(ago / 86_400_000)}d ago)`;
                }

                const payload = {
                    type: 'update',
                    summary: `Server restarted ${versionPrefix}— ${top3}${timeSuffix}`,
                    commits,
                    url: '/updates',
                    timestamp: new Date().toISOString(),
                };
                const msg = JSON.stringify(payload);

                // Persist to chat_messages on the FIRST broadcast only
                if (_changelogBroadcasts === 0) {
                    try {
                        const summaryText = `🚀 Server restarted ${versionPrefix}— ${top3}${timeSuffix}`;
                        db.saveChatMessage({
                            stream_id: null,
                            user_id: null,
                            anon_id: null,
                            username: 'HoboStreamer',
                            message: summaryText,
                            message_type: 'system',
                            is_global: true,
                        });
                    } catch (dbErr) {
                        console.warn('[Server] Failed to persist changelog to chat:', dbErr.message);
                    }
                }

                // Send only to clients that haven't received it yet
                let newRecipients = 0;
                for (const [ws, client] of chatServer.clients) {
                    const clientKey = client.user?.id ? `u:${client.user.id}` : `a:${client.anonId || ws._socket?.remoteAddress}`;
                    if (_changelogSentTo.has(clientKey)) continue;
                    if (ws.readyState === 1 /* WebSocket.OPEN */ && ws.bufferedAmount <= 256 * 1024) {
                        ws.send(msg);
                        _changelogSentTo.add(clientKey);
                        newRecipients++;
                    }
                }

                _changelogBroadcasts++;
                console.log(`[Server] Changelog broadcast #${_changelogBroadcasts}: ${newRecipients} new recipients (${_changelogSentTo.size} total, ${chatServer.getTotalConnections()} connected)`);

                // Schedule next broadcast if we haven't hit the max
                if (_changelogBroadcasts < _changelogMaxBroadcasts) {
                    const nextDelay = (_changelogDelays[_changelogBroadcasts] || 30000) - (_changelogDelays[_changelogBroadcasts - 1] || 0);
                    setTimeout(broadcastChangelog, nextDelay);
                }
            } catch (err) {
                console.warn('[Server] Failed to broadcast startup changelog:', err.message);
            }
        }

        setTimeout(broadcastChangelog, _changelogDelays[0]);
    });

    // 8. Start stale stream heartbeat cleanup (every 60 seconds)
    let heartbeatCleanupRunning = false;
    const maintenanceInterval = setInterval(() => {
        if (heartbeatCleanupRunning) return;
        heartbeatCleanupRunning = true;
        try {
            const staleStreams = db.all(
                `SELECT id, user_id, protocol FROM streams
                 WHERE is_live = 1
                 AND (
                     (last_heartbeat IS NOT NULL AND last_heartbeat < datetime('now', '-5 minutes'))
                     OR (last_heartbeat IS NULL AND started_at < datetime('now', '-6 minutes'))
                 )`
            );
            for (const stream of staleStreams) {
                console.log(`[Heartbeat] Ending stale stream ${stream.id} (no heartbeat for 5+ minutes)`);
                db.endStream(stream.id);
                // Auto-finalize any active VOD recording for this stream
                vodRoutes.finalizeVodRecording(stream.id).catch(err => {
                    console.warn(`[VOD] Auto-finalize failed for stale stream ${stream.id}:`, err.message);
                });
                // Stop RS chat bridge for this stream (prevents zombie bridges)
                robotStreamerService.stopForStream(stream.id);
                // Stop chat relay bridges for this stream
                chatRelayService.stopForStream(stream.id);
                // Stop any active restreams for this stream
                restreamManager.stopAllForStream(stream.id);
                // Close signaling room and notify viewers
                broadcastServer.endStream(stream.id);
                const user = db.getUserById(stream.user_id);
                if (stream.protocol === 'jsmpeg' && user) {
                    jsmpegRelay.destroyChannel(user.stream_key);
                } else if (stream.protocol === 'webrtc') {
                    webrtcSFU.closeRoom(`stream-${stream.id}`);
                }
            }

            // Also finalize any orphaned VOD recordings where the stream ended but finalize was never called
            try {
                const orphaned = db.getOrphanedRecordingVods();
                for (const vod of orphaned) {
                    console.log(`[VOD] Finalizing orphaned recording: vod ${vod.id} (stream ${vod.stream_id})`);
                    vodRoutes.finalizeVodRecording(vod.stream_id).catch(() => {
                        // If no stream match, just mark it as done
                        db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vod.id]);
                    });
                }
            } catch (err) {
                console.warn('[VOD] Orphan cleanup error:', err.message);
            }

            // Also clean up old live-stream thumbnails (>1 hour)
            thumbnailService.cleanupOldThumbnails();

            // Generate server-side thumbnails for RTMP streams (no client capture available)
            const rtmpStreams = db.all(
                `SELECT s.id, u.stream_key FROM streams s
                 JOIN users u ON s.user_id = u.id
                 WHERE s.is_live = 1 AND s.protocol = 'rtmp'`
            );
            for (const rs of rtmpStreams) {
                if (!rtmpServer.isReceiving(rs.stream_key)) continue;
                if (!thumbnailService.shouldRefreshLiveThumbnail(rs.id, 120000)) continue;
                thumbnailService.generateLiveStreamThumbnail(rs.id, rs.stream_key, { minAgeMs: 120000 }).catch(() => {});
            }

            // Generate server-side thumbnails for JSMPEG streams (broadcaster uses FFmpeg, no browser preview)
            const jsmpegStreams = db.all(
                `SELECT s.id, u.stream_key FROM streams s
                 JOIN users u ON s.user_id = u.id
                 WHERE s.is_live = 1 AND s.protocol = 'jsmpeg'`
            );
            for (const js of jsmpegStreams) {
                if (!thumbnailService.shouldRefreshLiveThumbnail(js.id, 120000)) continue;
                const channelInfo = jsmpegRelay.getChannelInfo(js.stream_key);
                if (channelInfo && channelInfo.videoPort) {
                    thumbnailService.generateJSMPEGThumbnail(js.id, channelInfo.videoPort).catch(() => {});
                }
            }
        } catch (err) {
            console.error('[Heartbeat] Cleanup error:', err.message);
        } finally {
            heartbeatCleanupRunning = false;
        }
    }, 60000);
    if (typeof maintenanceInterval.unref === 'function') maintenanceInterval.unref();
}

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
    console.log('\n[Server] Shutting down...');

    // Notify all chat clients before closing connections
    try {
        chatServer.broadcastAll({
            type: 'server_restart',
            message: '⚙️ Chat server restarting — you will be reconnected automatically.',
            timestamp: new Date().toISOString(),
        });
    } catch { /* non-critical */ }

    // Small delay to let the message reach clients before closing sockets
    setTimeout(() => {
        restreamManager.stopViewerCountPolling();
        restreamManager.stopAll();
        // canvasServer + gameServer migrated to hobo.quest
        callServer.close();
        chatServer.close();
        controlServer.close();
        broadcastServer.close();
        jsmpegRelay.closeAll();
        webrtcSFU.closeAll();
        rtmpServer.stop();
        db.close();

        server.close(() => {
            console.log('[Server] Goodbye! 🎒');
            process.exit(0);
        });

        // Force exit after 5s
        setTimeout(() => process.exit(1), 5000);
    }, 300);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start Server ─────────────────────────────────────────────
start().catch(err => {
    console.error('[Server] Fatal error:', err);
    process.exit(1);
});
