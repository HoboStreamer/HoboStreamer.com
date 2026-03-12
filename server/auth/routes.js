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
                    } catch { /* non-critical — tags table may not exist yet */ }
                }
            }
        }

        const token = generateToken(user);

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
