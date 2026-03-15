/**
 * HoboStreamer — JWT Auth Middleware
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db/database');

/**
 * Generates a JWT token for a user
 */
function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
    );
}

/**
 * Verifies a JWT token and returns the decoded payload
 */
function verifyToken(token) {
    try {
        return jwt.verify(token, config.jwt.secret);
    } catch {
        return null;
    }
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

    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = db.getUserById(decoded.id);
    if (!user) {
        return res.status(401).json({ error: 'User not found' });
    }
    if (user.is_banned) {
        return res.status(403).json({ error: 'Account is banned', reason: user.ban_reason });
    }
    // Reject tokens issued before a password change
    if (user.token_valid_after && decoded.iat < Math.floor(new Date(user.token_valid_after + 'Z').getTime() / 1000)) {
        return res.status(401).json({ error: 'Token revoked — please log in again' });
    }

    req.user = user;
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
            const user = db.getUserById(decoded.id);
            if (user && !(user.token_valid_after && decoded.iat < Math.floor(new Date(user.token_valid_after + 'Z').getTime() / 1000))) {
                req.user = user;
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
    const decoded = verifyToken(token);
    if (!decoded) return null;
    const user = db.getUserById(decoded.id);
    if (!user) return null;
    // Reject tokens issued before a password change
    if (user.token_valid_after && decoded.iat < Math.floor(new Date(user.token_valid_after + 'Z').getTime() / 1000)) {
        return null;
    }
    return user;
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
};
