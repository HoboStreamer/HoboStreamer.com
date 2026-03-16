/**
 * HoboStreamer — Auth Routes
 * POST /api/auth/register
 * POST /api/auth/login
 * GET  /api/auth/me
 * PUT  /api/auth/profile
 * POST /api/auth/change-password
 * POST /api/auth/avatar
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { generateToken, requireAuth } = require('./auth');
const permissions = require('./permissions');
const legacyMigration = require('../game/legacy-migration');
const ipUtils = require('../admin/ip-utils');

const router = express.Router();

function cleanOptionalString(value) {
    if (value === undefined || value === null) return undefined;
    return String(value).trim();
}

/** Strip HTML tags from a string */
function stripHtml(str) {
    return str.replace(/<[^>]*>/g, '');
}

/**
 * Sanitize display names — strip HTML, control chars, and characters that could
 * cause injection issues in HTML attributes / JS string contexts / URLs.
 */
function sanitizeDisplayName(raw) {
    if (!raw) return raw;
    let s = stripHtml(raw);
    // Remove characters dangerous in HTML/JS/URL contexts
    s = s.replace(/[\\`'"<>(){};:/\[\]]/g, '');
    // Collapse whitespace and trim
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

function isValidEmail(value) {
    if (!value) return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isAllowedAvatarUrl(value) {
    if (!value) return true;
    if (value.startsWith('/data/avatars/')) return true;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

// ── Avatar Upload Config ─────────────────────────────────────
const avatarDir = path.resolve('./data/avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif' };
const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, avatarDir),
    filename: (req, file, cb) => {
        const ext = MIME_TO_EXT[file.mimetype] || '.png';
        cb(null, `avatar-${req.user.id}-${Date.now()}${ext}`);
    },
});
const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 512 * 1024 }, // 512KB
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/gif', 'image/webp', 'image/jpeg', 'image/avif'];
        cb(null, allowed.includes(file.mimetype));
    },
});

// ── Register ─────────────────────────────────────────────────
router.post('/register', (req, res) => {
    try {
        const username = cleanOptionalString(req.body.username);
        const email = cleanOptionalString(req.body.email);
        const password = typeof req.body.password === 'string' ? req.body.password : '';
        let display_name = cleanOptionalString(req.body.display_name);
        const verification_key = cleanOptionalString(req.body.verification_key);

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }
        if (username.length < 3 || username.length > 24) {
            return res.status(400).json({ error: 'Username must be 3-24 characters' });
        }
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
        }
        if (/^anon\d*$/i.test(username)) {
            return res.status(400).json({ error: 'That username is reserved for anonymous users' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        if (display_name) {
            display_name = sanitizeDisplayName(display_name);
        }
        if (display_name && display_name.length > 60) {
            return res.status(400).json({ error: 'Display name must be 1-60 characters' });
        }
        if (email && (!isValidEmail(email) || email.length > 254)) {
            return res.status(400).json({ error: 'Invalid email address' });
        }

        // Check existing
        if (db.getUserByUsername(username)) {
            return res.status(409).json({ error: 'Username already taken' });
        }

        // Check if username is reserved (has an active verification key)
        const reserved = db.isUsernameReserved(username);
        if (reserved) {
            if (!verification_key) {
                return res.status(403).json({
                    error: 'This username is reserved. A verification key is required to claim it.',
                    reserved: true,
                });
            }
            // Validate the key
            const vk = db.getVerificationKeyByKey(verification_key);
            if (!vk || vk.status !== 'active') {
                return res.status(403).json({ error: 'Invalid or expired verification key' });
            }
            if (vk.target_username.toLowerCase() !== username.toLowerCase()) {
                return res.status(403).json({ error: 'This verification key is for a different username' });
            }
        }

        // Check if registration is open
        const regOpen = db.getSetting('registration_open');
        if (regOpen === false) {
            return res.status(403).json({ error: 'Registration is currently closed' });
        }

        const password_hash = bcrypt.hashSync(password, 10);
        const stream_key = uuidv4().replace(/-/g, '');

        const result = db.createUser({
            username,
            email: email || null,
            password_hash,
            display_name: display_name || username,
            stream_key,
        });

        let user = db.getUserById(result.lastInsertRowid);

        // If a verification key was used, redeem it and migrate legacy data
        let migrated = null;
        if (verification_key && reserved) {
            db.redeemVerificationKey(verification_key, user.id);

            // Auto-migrate RS-Companion game data for legacy users
            if (legacyMigration.isAvailable()) {
                const migration = legacyMigration.migrateUser(db.getDb(), user.id, username);
                if (migration.success) {
                    migrated = migration.message;
                    // Re-fetch user to include migrated coin balance
                    const updatedUser = db.getUserById(user.id);
                    if (updatedUser) user = updatedUser;

                    // Grant tags for legacy migrated users
                    try {
                        const tags = require('../game/tags');
                        tags.grantTag(user.id, 'legacy', 'migration');
                        // Grant CFO tag specifically to Patrick
                        if (username.toLowerCase() === 'patrick') {
                            tags.grantTag(user.id, 'cfo', 'migration');
                        }
                    } catch (err) { console.warn('[Auth] Tags migration error:', err.message); /* non-critical */ }
                }
            }
        }

        const token = generateToken(user);

        // Log IP on registration
        try {
            const geo = ipUtils.enrichIp(req.ip);
            db.logIp({ userId: user.id, ip: req.ip, action: 'register', geo, userAgent: req.headers['user-agent'] });
        } catch (e) { /* non-critical */ }

        res.status(201).json({
            token,
            user: sanitizeUser(user),
            ...(migrated && { migrated }),
        });
    } catch (err) {
        console.error('[Auth] Register error:', err.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ── Login ────────────────────────────────────────────────────
router.post('/login', (req, res) => {
    try {
        const username = cleanOptionalString(req.body.username);
        const password = typeof req.body.password === 'string' ? req.body.password : '';

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const user = db.getUserByUsername(username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (user.is_banned) {
            return res.status(403).json({ error: 'Account is banned', reason: user.ban_reason });
        }

        // Update last seen
        db.run('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

        // Log IP on login
        try {
            const geo = ipUtils.enrichIp(req.ip);
            db.logIp({ userId: user.id, ip: req.ip, action: 'login', geo, userAgent: req.headers['user-agent'] });
        } catch (e) { /* non-critical */ }

        const token = generateToken(user);
        res.json({ token, user: sanitizeUser(user) });
    } catch (err) {
        console.error('[Auth] Login error:', err.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ── Get Current User ─────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
    res.json({
        user: sanitizeUser(req.user),
        capabilities: permissions.getCapabilities(req.user),
    });
});

// ── Update Profile ───────────────────────────────────────────
router.put('/profile', requireAuth, (req, res) => {
    try {
        let display_name = cleanOptionalString(req.body.display_name);
        let bio = cleanOptionalString(req.body.bio);
        const avatar_url = cleanOptionalString(req.body.avatar_url);
        const email = cleanOptionalString(req.body.email);
        const profile_color = cleanOptionalString(req.body.profile_color);
        const updates = [];
        const params = [];

        // Strip HTML tags from free-text fields
        if (display_name !== undefined) display_name = sanitizeDisplayName(display_name);
        if (bio !== undefined) bio = stripHtml(bio);

        if (display_name !== undefined && (display_name.length < 1 || display_name.length > 60)) {
            return res.status(400).json({ error: 'Display name must be 1-60 characters' });
        }
        if (bio !== undefined && bio.length > 500) {
            return res.status(400).json({ error: 'Bio must be 500 characters or fewer' });
        }
        if (email !== undefined && (!isValidEmail(email) || email.length > 254)) {
            return res.status(400).json({ error: 'Invalid email address' });
        }
        if (profile_color !== undefined && profile_color !== '' && !/^#[0-9a-fA-F]{6}$/.test(profile_color)) {
            return res.status(400).json({ error: 'Profile color must be a 6-digit hex color' });
        }
        if (avatar_url !== undefined && !isAllowedAvatarUrl(avatar_url)) {
            return res.status(400).json({ error: 'Avatar URL must be http(s) or a local /data/avatars path' });
        }

        if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name); }
        if (bio !== undefined) { updates.push('bio = ?'); params.push(bio); }
        if (avatar_url !== undefined) { updates.push('avatar_url = ?'); params.push(avatar_url); }
        if (email !== undefined) { updates.push('email = ?'); params.push(email); }
        if (profile_color !== undefined) { updates.push('profile_color = ?'); params.push(profile_color); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.user.id);

        db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        const updated = db.getUserById(req.user.id);
        res.json({ user: sanitizeUser(updated) });
    } catch (err) {
        console.error('[Auth] Profile update error:', err.message);
        res.status(500).json({ error: 'Profile update failed' });
    }
});

// ── Change Password ──────────────────────────────────────────
router.post('/change-password', requireAuth, (req, res) => {
    try {
        const currentPassword = typeof req.body.current_password === 'string' ? req.body.current_password : '';
        const newPassword = typeof req.body.new_password === 'string' ? req.body.new_password : '';

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        const user = db.getUserById(req.user.id);
        if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
            return res.status(403).json({ error: 'Current password is incorrect' });
        }

        const newHash = bcrypt.hashSync(newPassword, 10);
        db.run('UPDATE users SET password_hash = ?, token_valid_after = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newHash, user.id]);
        // Issue a fresh token so the current session stays logged in
        const { generateToken } = require('./auth');
        const token = generateToken(user);
        res.json({ success: true, token });
    } catch (err) {
        console.error('[Auth] Change password error:', err.message);
        res.status(500).json({ error: 'Password change failed' });
    }
});

// ── Get Stream Key ───────────────────────────────────────────
router.get('/stream-key', requireAuth, (req, res) => {
    res.json({ stream_key: req.user.stream_key });
});

// ── Regenerate Stream Key ────────────────────────────────────
router.post('/stream-key/regenerate', requireAuth, (req, res) => {
    const newKey = uuidv4().replace(/-/g, '');
    db.run('UPDATE users SET stream_key = ? WHERE id = ?', [newKey, req.user.id]);
    res.json({ stream_key: newKey });
});

// ── Get User Profile (public) ────────────────────────────────
router.get('/user/:username', (req, res) => {
    const user = db.getUserByUsername(req.params.username);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: sanitizeUser(user, true) });
});

// ── Upload Avatar ────────────────────────────────────────────
router.post('/avatar', requireAuth, avatarUpload.single('avatar'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

        // Delete old avatar file if it exists
        const oldUser = db.getUserById(req.user.id);
        if (oldUser?.avatar_url) {
            const oldPath = path.resolve('./data/avatars', path.basename(oldUser.avatar_url));
            if (fs.existsSync(oldPath)) {
                try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
            }
        }

        const avatarUrl = `/data/avatars/${req.file.filename}`;
        db.updateUserAvatar(req.user.id, avatarUrl);

        const updated = db.getUserById(req.user.id);
        res.json({ user: sanitizeUser(updated), avatar_url: avatarUrl });
    } catch (err) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch { }
        console.error('[Auth] Avatar upload error:', err.message);
        res.status(500).json({ error: 'Avatar upload failed' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Hobo.Tools OAuth2 SSO Integration
// ═══════════════════════════════════════════════════════════════

const HOBO_TOOLS_BASE = process.env.HOBO_TOOLS_URL || 'https://hobo.tools';
const HOBO_TOOLS_INTERNAL = process.env.HOBO_TOOLS_INTERNAL || 'http://127.0.0.1:3100';
const HOBO_INTERNAL_KEY = process.env.HOBO_INTERNAL_KEY || '';
const HOBO_CLIENT_ID = process.env.HOBO_OAUTH_CLIENT_ID || 'hobostreamer';
const HOBO_CLIENT_SECRET = process.env.HOBO_OAUTH_CLIENT_SECRET || '';
const HOBO_REDIRECT_URI = `${process.env.BASE_URL || 'https://hobostreamer.com'}/api/auth/callback`;

// ── Get Hobo Network Token for Linked Users ──────────────────
// Returns a hobo.tools JWT if the user has a linked hobo.tools account.
// Used by the frontend to call cross-service APIs (notifications, etc.)
router.get('/hobo-token', requireAuth, async (req, res) => {
    try {
        const linked = db.getDb().prepare(
            "SELECT service_user_id FROM linked_accounts WHERE user_id = ? AND service = 'hobotools'"
        ).get(req.user.id);
        if (!linked) return res.json({ ok: false, reason: 'no_linked_account' });
        if (!HOBO_INTERNAL_KEY) return res.json({ ok: false, reason: 'internal_key_not_configured' });

        // Request a token from hobo.tools internal API
        const http = require('http');
        const tokenData = await new Promise((resolve, reject) => {
            const body = JSON.stringify({ user_id: parseInt(linked.service_user_id) });
            const url = new URL(`${HOBO_TOOLS_INTERNAL}/internal/issue-token`);
            const reqOpts = {
                hostname: url.hostname, port: url.port, path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Internal-Key': HOBO_INTERNAL_KEY },
            };
            const httpReq = http.request(reqOpts, (httpRes) => {
                let data = '';
                httpRes.on('data', chunk => data += chunk);
                httpRes.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response')); } });
            });
            httpReq.on('error', reject);
            httpReq.write(body);
            httpReq.end();
        });

        if (!tokenData.token) return res.json({ ok: false, reason: 'token_issue_failed' });
        res.json({ ok: true, token: tokenData.token });
    } catch (err) {
        console.error('[Auth] hobo-token error:', err.message);
        res.json({ ok: false, reason: 'error' });
    }
});

// ── Initiate OAuth Login (redirect to hobo.tools) ───────────
router.get('/sso/login', (req, res) => {
    const state = require('crypto').randomBytes(16).toString('hex');
    // Store state in a short-lived cookie for CSRF protection
    res.cookie('oauth_state', state, { httpOnly: true, maxAge: 5 * 60 * 1000, sameSite: 'Lax', secure: true });

    const params = new URLSearchParams({
        client_id: HOBO_CLIENT_ID,
        redirect_uri: HOBO_REDIRECT_URI,
        response_type: 'code',
        scope: 'profile theme',
        state,
    });
    res.redirect(`${HOBO_TOOLS_BASE}/oauth/authorize?${params.toString()}`);
});

// ── OAuth Callback (exchange code for token) ─────────────────
router.get('/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        if (!code) return res.status(400).send('Missing authorization code');

        // Validate CSRF state
        const savedState = req.cookies?.oauth_state;
        if (savedState && savedState !== state) {
            return res.status(403).send('Invalid state parameter');
        }
        res.clearCookie('oauth_state');

        // Exchange code for tokens
        const https = require('https');
        const tokenData = await new Promise((resolve, reject) => {
            const body = JSON.stringify({
                grant_type: 'authorization_code',
                client_id: HOBO_CLIENT_ID,
                client_secret: HOBO_CLIENT_SECRET,
                code,
                redirect_uri: HOBO_REDIRECT_URI,
            });

            const url = new URL(`${HOBO_TOOLS_BASE}/oauth/token`);
            const reqOpts = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const httpReq = https.request(reqOpts, (httpRes) => {
                let data = '';
                httpRes.on('data', chunk => data += chunk);
                httpRes.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { reject(new Error('Invalid token response')); }
                });
            });
            httpReq.on('error', reject);
            httpReq.write(body);
            httpReq.end();
        });

        if (tokenData.error) {
            console.error('[Auth/SSO] Token exchange failed:', tokenData.error_description || tokenData.error);
            return res.status(400).send(`OAuth error: ${tokenData.error_description || tokenData.error}`);
        }

        const ssoUser = tokenData.user;
        if (!ssoUser) {
            return res.status(400).send('No user data in token response');
        }

        // Find or create local user linked to this hobo.tools account
        const hoboToolsId = String(ssoUser.id);

        // Check linked_accounts first
        let localUser = null;
        const linked = db.getDb().prepare(
            "SELECT user_id FROM linked_accounts WHERE service = 'hobotools' AND service_user_id = ?"
        ).get(hoboToolsId);

        if (linked) {
            localUser = db.getUserById(linked.user_id);
        }

        // Try matching by username
        if (!localUser) {
            localUser = db.getUserByUsername(ssoUser.username);
            if (localUser) {
                // Auto-link
                db.getDb().prepare(
                    "INSERT OR IGNORE INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'hobotools', ?, ?)"
                ).run(localUser.id, hoboToolsId, ssoUser.username);
            }
        }

        // Create new local user if none found
        if (!localUser) {
            const stream_key = uuidv4().replace(/-/g, '');
            const result = db.createUser({
                username: ssoUser.username,
                email: ssoUser.email || null,
                password_hash: '$sso$' + require('crypto').randomBytes(32).toString('hex'), // placeholder, can't login with password
                display_name: ssoUser.display_name || ssoUser.username,
                stream_key,
            });
            localUser = db.getUserById(result.lastInsertRowid);

            // Sync optional fields from hobo.tools
            if (ssoUser.avatar_url) db.updateUserAvatar(localUser.id, ssoUser.avatar_url);
            if (ssoUser.bio) db.getDb().prepare('UPDATE users SET bio = ? WHERE id = ?').run(ssoUser.bio, localUser.id);
            if (ssoUser.role && ['user', 'streamer', 'global_mod', 'admin'].includes(ssoUser.role)) {
                db.getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(ssoUser.role, localUser.id);
            }
            if (ssoUser.profile_color) db.getDb().prepare('UPDATE users SET profile_color = ? WHERE id = ?').run(ssoUser.profile_color, localUser.id);

            // Link to hobo.tools
            db.getDb().prepare(
                "INSERT OR IGNORE INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'hobotools', ?, ?)"
            ).run(localUser.id, hoboToolsId, ssoUser.username);

            localUser = db.getUserById(localUser.id); // re-fetch
            console.log(`[Auth/SSO] New local account created for hobo.tools user ${ssoUser.username} (hobo-tools id:${hoboToolsId}, local id:${localUser.id})`);
        }

        // Issue a local token
        const token = generateToken(localUser);
        const hoboToolsToken = tokenData.access_token || '';

        // Set cookie and redirect to home
        res.cookie('token', token, { httpOnly: false, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'Lax', secure: true });

        // Return HTML that stores token in localStorage and redirects
        res.send(`<!DOCTYPE html>
<html><head><title>Logging in...</title></head>
<body>
<script>
    localStorage.setItem('token', ${JSON.stringify(token)});
    localStorage.setItem('hobo_token', ${JSON.stringify(hoboToolsToken)});
    window.location.href = '/';
</script>
<noscript><a href="/">Click here to continue</a></noscript>
</body></html>`);
    } catch (err) {
        console.error('[Auth/SSO] Callback error:', err);
        res.status(500).send('OAuth login failed. Please try again.');
    }
});

// ── SSO Status (for client-side detection) ───────────────────
router.get('/sso/status', (req, res) => {
    res.json({
        enabled: !!HOBO_CLIENT_SECRET,
        provider: 'hobo.tools',
        loginUrl: `${HOBO_TOOLS_BASE}/oauth/authorize`,
    });
});

router.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 512KB)' });
    }
    res.status(500).json({ error: 'Upload failed' });
});

// ── Helper ───────────────────────────────────────────────────
function sanitizeUser(user, publicOnly = false) {
    const safe = {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        bio: user.bio,
        role: user.role,
        profile_color: user.profile_color,
        hobo_bucks_balance: user.hobo_bucks_balance,
        hobo_coins_balance: user.hobo_coins_balance,
        created_at: user.created_at,
        capabilities: permissions.getCapabilities(user),
    };
    if (!publicOnly) {
        safe.email = user.email;
        safe.stream_key = user.stream_key;
    }
    return safe;
}

module.exports = router;
