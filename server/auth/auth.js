/**
 * HoboStreamer — JWT Auth Middleware
 * Supports dual auth:
 *   1. Local HS256 tokens (legacy / direct login)
 *   2. Hobo.Tools RS256 tokens (SSO via OAuth2)
 */
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');

// ── Hobo.Tools Public Key (RS256 verification) ──────────────
let hoboToolsPublicKey = null;
const HOBO_TOOLS_ISSUER = 'https://hobo.tools';

function loadHoboToolsPublicKey() {
    // Try loading from shared location or env
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
    console.warn('[Auth] ⚠️  hobo.tools public key not found — SSO login will be unavailable');
}
loadHoboToolsPublicKey();

/**
 * Generates a local HS256 JWT token for a user
 */
function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
    );
}

/**
 * Verifies a JWT token — tries local HS256 first, then hobo.tools RS256
 * Returns { decoded, source: 'local' | 'hobotools' } or null
 */
function verifyToken(token) {
    // Try local HS256
    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        return { decoded, source: 'local' };
    } catch { /* not a local token */ }

    // Try hobo.tools RS256
    if (hoboToolsPublicKey) {
        try {
            const decoded = jwt.verify(token, hoboToolsPublicKey, {
                algorithms: ['RS256'],
                issuer: HOBO_TOOLS_ISSUER,
            });
            return { decoded, source: 'hobotools' };
        } catch { /* not a hobo.tools token either */ }
    }

    return null;
}

/**
 * Resolve a hobo.tools user to a local HoboStreamer user.
 * Looks up linked_accounts first, falls back to username match.
 * Returns the local user or null.
 */
function resolveHoboToolsUser(decoded) {
    const hoboToolsId = decoded.sub || decoded.id;

    // Check linked_accounts for existing link
    const linked = db.getDb().prepare(
        "SELECT * FROM linked_accounts WHERE service = 'hobotools' AND service_user_id = ?"
    ).get(String(hoboToolsId));

    if (linked) {
        return db.getUserById(linked.user_id);
    }

    // Try matching by username (case-insensitive)
    const user = db.getUserByUsername(decoded.username);
    if (user) {
        // Auto-link this user to the hobo.tools account
        try {
            db.getDb().prepare(
                "INSERT OR IGNORE INTO linked_accounts (service, service_user_id, service_username, user_id) VALUES ('hobotools', ?, ?, ?)"
            ).run(String(hoboToolsId), decoded.username, user.id);
        } catch { /* already linked */ }
        return user;
    }

    return null;
}

/**
 * Express middleware — requires valid JWT
 * Attaches req.user with full user record
 */
function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const result = verifyToken(token);
    if (!result) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { decoded, source } = result;
    let user;

    if (source === 'hobotools') {
        user = resolveHoboToolsUser(decoded);
        if (!user) {
            return res.status(401).json({ error: 'No linked HoboStreamer account. Please complete setup first.' });
        }
    } else {
        user = db.getUserById(decoded.id);
    }

    if (!user) {
        return res.status(401).json({ error: 'User not found' });
    }
    if (user.is_banned) {
        return res.status(403).json({ error: 'Account is banned', reason: user.ban_reason });
    }
    // Reject tokens issued before a password change (local tokens only)
    if (source === 'local' && user.token_valid_after && decoded.iat < Math.floor(new Date(user.token_valid_after + 'Z').getTime() / 1000)) {
        return res.status(401).json({ error: 'Token revoked — please log in again' });
    }

    req.user = user;
    req.authSource = source;
    next();
}

/**
 * Express middleware — optional auth (attaches user if token present)
 */
function optionalAuth(req, res, next) {
    const token = extractToken(req);
    if (token) {
        const result = verifyToken(token);
        if (result) {
            const { decoded, source } = result;
            let user;

            if (source === 'hobotools') {
                user = resolveHoboToolsUser(decoded);
            } else {
                user = db.getUserById(decoded.id);
                // Check token_valid_after for local tokens
                if (user && user.token_valid_after && decoded.iat < Math.floor(new Date(user.token_valid_after + 'Z').getTime() / 1000)) {
                    user = null;
                }
            }

            if (user) {
                req.user = user;
                req.authSource = source;
            }
        }
    }
    next();
}

/**
 * Express middleware — requires admin role
 * @deprecated Prefer permissions.requireAdmin which doesn't wrap requireAuth
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
 * Wraps requireAuth + role check in one call for convenience.
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
 * Includes streamer, global_mod, admin.
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
 * Extract JWT from Authorization header or cookie (HTTP requests only — no query param)
 */
function extractToken(req) {
    // Check Authorization header: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    // Check cookie
    if (req.cookies && req.cookies.token) {
        return req.cookies.token;
    }
    return null;
}

/**
 * Extract JWT from query parameter (WebSocket upgrade requests only)
 */
function extractWsToken(req) {
    return extractToken(req) || (req.query && req.query.token) || null;
}

/**
 * Authenticate a WebSocket connection (returns user or null)
 */
function authenticateWs(token) {
    if (!token) return null;
    const result = verifyToken(token);
    if (!result) return null;

    const { decoded, source } = result;
    let user;

    if (source === 'hobotools') {
        user = resolveHoboToolsUser(decoded);
    } else {
        user = db.getUserById(decoded.id);
        if (user && user.token_valid_after && decoded.iat < Math.floor(new Date(user.token_valid_after + 'Z').getTime() / 1000)) {
            return null;
        }
    }

    return user;
}

/**
 * Reload the hobo.tools public key (e.g., after key rotation)
 */
function reloadHoboToolsKey() {
    loadHoboToolsPublicKey();
}

module.exports = {
    generateToken,
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
