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
 * Express middleware — requires valid hobo.tools JWT
 * Resolves to local user via linked_accounts (auto-creates if needed).
 */
function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

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
        const decoded = verifyToken(token);
        if (decoded) {
            const user = resolveHoboToolsUser(decoded);
            if (user && !user.is_banned) {
                req.user = user;
                req.authSource = 'hobotools';
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
    if (req.cookies && req.cookies.token) {
        return req.cookies.token;
    }
    return null;
}

/**
 * Extract JWT from query parameter (WebSocket upgrade requests)
 */
function extractWsToken(req) {
    return extractToken(req) || (req.query && req.query.token) || null;
}

/**
 * Authenticate a WebSocket connection (returns user or null)
 */
function authenticateWs(token) {
    if (!token) return null;
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
    reloadHoboToolsKey,
    resolveHoboToolsUser,
};
