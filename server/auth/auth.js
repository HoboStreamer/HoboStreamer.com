/**
 * HoboStreamer — JWT Auth Middleware
 * All authentication is handled via Hobo.Tools RS256 tokens.
 * Users sign in on hobo.tools and are redirected back via OAuth2.
 * Local user records are resolved via linked_accounts.
 */
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

// ── Hobo.Tools Public Key (RS256 verification) ──────────────
let hoboToolsPublicKey = null;
const HOBO_TOOLS_ISSUER = 'https://hobo.tools';

function loadHoboToolsPublicKey() {
    const keyPaths = [
        process.env.HOBO_TOOLS_PUBLIC_KEY,
        path.resolve('./data/keys/hobo-tools-public.pem'),
        '/opt/hobo/hobo-tools/data/keys/public.pem',
    ].filter(Boolean);

    for (const p of keyPaths) {
        try {
            if (fs.existsSync(p)) {
                hoboToolsPublicKey = fs.readFileSync(p, 'utf8');
                console.log(`[Auth] Loaded hobo.tools public key from ${p}`);
                return;
            }
        } catch { /* try next */ }
    }
    console.error('[Auth] ❌ hobo.tools public key not found — authentication will NOT work!');
}
loadHoboToolsPublicKey();

/**
 * Verify a hobo.tools RS256 JWT token.
 * Returns decoded payload or null.
 */
function verifyToken(token) {
    if (!hoboToolsPublicKey) return null;
    try {
        return jwt.verify(token, hoboToolsPublicKey, {
            algorithms: ['RS256'],
            issuer: HOBO_TOOLS_ISSUER,
        });
    } catch {
        return null;
    }
}

/**
 * Resolve a hobo.tools user to a local HoboStreamer user.
 * Checks linked_accounts first, falls back to username match,
 * auto-creates a local account if none found.
 */
function resolveHoboToolsUser(decoded) {
    const hoboToolsId = String(decoded.sub || decoded.id);

    // Check linked_accounts for existing link
    const linked = db.getDb().prepare(
        "SELECT * FROM linked_accounts WHERE service = 'hobotools' AND service_user_id = ?"
    ).get(hoboToolsId);

    if (linked) {
        return db.getUserById(linked.user_id);
    }

    // Try matching by username (case-insensitive)
    let user = db.getUserByUsername(decoded.username);
    if (user) {
        // Auto-link this user to the hobo.tools account
        try {
            db.getDb().prepare(
                "INSERT OR IGNORE INTO linked_accounts (service, service_user_id, service_username, user_id) VALUES ('hobotools', ?, ?, ?)"
            ).run(hoboToolsId, decoded.username, user.id);
            console.log(`[Auth] Auto-linked ${decoded.username} to hobo.tools id ${hoboToolsId}`);
        } catch { /* already linked */ }
        return user;
    }

    // Auto-create a local user for this hobo.tools account
    try {
        const stream_key = uuidv4().replace(/-/g, '');
        const result = db.createUser({
            username: decoded.username,
            email: null,
            password_hash: '$sso$' + require('crypto').randomBytes(32).toString('hex'),
            display_name: decoded.display_name || decoded.username,
            stream_key,
        });
        user = db.getUserById(result.lastInsertRowid);

        // Sync profile fields from token claims
        const updates = [];
        const params = [];
        if (decoded.avatar_url) { updates.push('avatar_url = ?'); params.push(decoded.avatar_url); }
        if (decoded.profile_color) { updates.push('profile_color = ?'); params.push(decoded.profile_color); }
        if (decoded.role && ['user', 'streamer', 'global_mod', 'admin'].includes(decoded.role)) {
            updates.push('role = ?'); params.push(decoded.role);
        }
        if (updates.length > 0) {
            params.push(user.id);
            db.getDb().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
            user = db.getUserById(user.id);
        }

        // Create linked_accounts entry
        db.getDb().prepare(
            "INSERT OR IGNORE INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'hobotools', ?, ?)"
        ).run(user.id, hoboToolsId, decoded.username);

        console.log(`[Auth] Auto-created local account for hobo.tools user ${decoded.username} (local id: ${user.id})`);
        return user;
    } catch (err) {
        console.error(`[Auth] Failed to auto-create user for ${decoded.username}:`, err.message);
        return null;
    }
}

/**
 * Try to authenticate via API token (hbt_xxx format)
 * Returns { user, scopes } or null
 */
function authenticateApiToken(rawToken) {
    if (!rawToken || !rawToken.startsWith('hbt_')) return null;
    const user = db.validateApiToken(rawToken);
    if (!user) return null;
    return user;
}

/**
 * Express middleware — requires valid hobo.tools JWT or API token
 * Resolves to local user via linked_accounts (auto-creates if needed).
 */
function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    // Try API token first (hbt_ prefix)
    const apiUser = authenticateApiToken(token);
    if (apiUser) {
        if (apiUser.is_banned) {
            return res.status(403).json({ error: 'Account is banned' });
        }
        req.user = apiUser;
        req.authSource = 'api_token';
        req.tokenScopes = apiUser.scopes || [];
        return next();
    }

    // Fall back to hobo.tools JWT
    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = resolveHoboToolsUser(decoded);
    if (!user) {
        return res.status(401).json({ error: 'Unable to resolve account' });
    }
    if (user.is_banned) {
        return res.status(403).json({ error: 'Account is banned', reason: user.ban_reason });
    }

    req.user = user;
    req.authSource = 'hobotools';
    next();
}

/**
 * Express middleware — optional auth (attaches user if token present)
 */
function optionalAuth(req, res, next) {
    const token = extractToken(req);
    if (token) {
        // Try API token first
        const apiUser = authenticateApiToken(token);
        if (apiUser && !apiUser.is_banned) {
            req.user = apiUser;
            req.authSource = 'api_token';
            req.tokenScopes = apiUser.scopes || [];
        } else {
            const decoded = verifyToken(token);
            if (decoded) {
                const user = resolveHoboToolsUser(decoded);
                if (user && !user.is_banned) {
                    req.user = user;
                    req.authSource = 'hobotools';
                }
            }
        }
    }
    next();
}

/**
 * Express middleware — requires admin role
 */
function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}

/**
 * Express middleware — requires staff (global_mod or admin)
 */
function requireStaff(req, res, next) {
    requireAuth(req, res, () => {
        if (!['global_mod', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Staff access required' });
        }
        next();
    });
}

/**
 * Express middleware — requires streamer or above role
 */
function requireStreamer(req, res, next) {
    requireAuth(req, res, () => {
        if (!['streamer', 'global_mod', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Streamer access required' });
        }
        next();
    });
}

/**
 * Extract JWT from Authorization header or cookie
 */
function extractToken(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }

    // Check both cookie names: 'token' (legacy hobostreamer) and 'hobo_token' (shared network)
    if (req.cookies) {
        if (req.cookies.hobo_token) return req.cookies.hobo_token;
        if (req.cookies.token) return req.cookies.token;
    }

    // Raw Node/WebSocket upgrade requests do not go through cookie-parser,
    // so parse the Cookie header directly as a fallback.
    const cookieHeader = req.headers?.cookie;
    if (cookieHeader && typeof cookieHeader === 'string') {
        const parsed = {};
        for (const part of cookieHeader.split(';')) {
            const idx = part.indexOf('=');
            if (idx === -1) continue;
            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (!key) continue;
            parsed[key] = decodeURIComponent(value);
        }
        if (parsed.hobo_token) return parsed.hobo_token;
        if (parsed.token) return parsed.token;
    }

    return null;
}

/**
 * Extract JWT from query parameter (WebSocket upgrade requests)
 */
function extractWsToken(req) {
    const direct = extractToken(req);
    if (direct) return direct;

    try {
        const url = new URL(req.url || '/', 'http://localhost');
        return url.searchParams.get('token') || null;
    } catch {
        return (req.query && req.query.token) || null;
    }
}

/**
 * Authenticate a WebSocket connection (returns user or null)
 * Supports both hobo.tools JWT and API tokens (hbt_xxx)
 */
function authenticateWs(token) {
    if (!token) return null;
    // Try API token first
    const apiUser = authenticateApiToken(token);
    if (apiUser) {
        // Attach scopes for chat server to check
        apiUser._authSource = 'api_token';
        return apiUser;
    }
    const decoded = verifyToken(token);
    if (!decoded) return null;
    return resolveHoboToolsUser(decoded);
}

/**
 * Reload the hobo.tools public key (e.g., after key rotation)
 */
function reloadHoboToolsKey() {
    loadHoboToolsPublicKey();
}

module.exports = {
    verifyToken,
    requireAuth,
    optionalAuth,
    requireAdmin,
    requireStaff,
    requireStreamer,
    extractToken,
    extractWsToken,
    authenticateWs,
    authenticateApiToken,
    reloadHoboToolsKey,
    resolveHoboToolsUser,
};
