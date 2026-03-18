/**
 * HoboStreamer — Pastes & Screenshots API
 *
 * Pastebin-style sharing: text pastes, code snippets, notes, and
 * full-page screenshots. Public by default with optional "unlisted" mode.
 * Anonymous creation allowed (tied to IP); logged-in users get authorship.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/database');
const { requireAuth, optionalAuth } = require('../auth/auth');

const HOBO_TOOLS_INTERNAL_URL = process.env.HOBO_TOOLS_INTERNAL_URL || 'http://127.0.0.1:3100';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.HOBO_INTERNAL_KEY || '';

function truncatePreview(text, max = 120) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function notificationActor(user, fallbackName = 'Someone') {
    return {
        sender_id: user?.id || null,
        sender_name: user ? (user.display_name || user.username) : fallbackName,
        sender_avatar: user?.avatar_url || null,
    };
}

function pushNotification(payload) {
    if (!payload?.user_id) return;

    fetch(`${HOBO_TOOLS_INTERNAL_URL}/internal/notifications/push`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': INTERNAL_API_KEY,
        },
        body: JSON.stringify(payload),
    }).then((response) => {
        if (!response.ok) {
            console.warn(`[Notify] Paste notification push failed: ${response.status}`);
        }
    }).catch((err) => {
        console.warn('[Notify] Paste notification push error:', err.message);
    });
}

// ── Screenshot upload storage ───────────────────────────────
const SCREENSHOTS_DIR = path.resolve('./data/pastes/screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const screenshotStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, SCREENSHOTS_DIR),
    filename: (_req, file, cb) => {
        const ext = MIME_TO_EXT[file.mimetype] || '.png';
        cb(null, `ss-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
});
const screenshotUpload = multer({
    storage: screenshotStorage,
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
    fileFilter: (_req, file, cb) => {
        if (/^image\/(png|jpeg|webp)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only PNG, JPEG, or WebP images allowed'));
    },
});

// ── Helpers ─────────────────────────────────────────────────

// Word pools for readable paste slugs (adj-noun-number)
const SLUG_ADJECTIVES = [
    'amber', 'blue', 'bold', 'brave', 'bright', 'calm', 'clean', 'clever',
    'cold', 'cool', 'coral', 'crisp', 'dark', 'dawn', 'deep', 'dry',
    'dusk', 'dusty', 'fair', 'fast', 'fierce', 'fine', 'foggy', 'free',
    'fresh', 'frost', 'glad', 'gold', 'grand', 'gray', 'green', 'grim',
    'hazy', 'heavy', 'hidden', 'hollow', 'honey', 'hot', 'icy', 'iron',
    'jade', 'keen', 'kind', 'late', 'lazy', 'light', 'lime', 'lit',
    'lone', 'lost', 'loud', 'lucky', 'lush', 'mild', 'misty', 'mossy',
    'muddy', 'neon', 'new', 'noble', 'odd', 'old', 'opal', 'open',
    'pale', 'pink', 'plain', 'plum', 'prime', 'proud', 'pure', 'quick',
    'quiet', 'rare', 'raw', 'red', 'rich', 'rocky', 'rosy', 'rough',
    'ruby', 'rusty', 'safe', 'sage', 'sandy', 'sharp', 'shy', 'silver',
    'slim', 'slow', 'smoky', 'snowy', 'soft', 'sour', 'steep', 'still',
    'stone', 'sunny', 'sweet', 'swift', 'tall', 'tame', 'teal', 'thin',
    'tidy', 'tiny', 'torn', 'vast', 'vivid', 'warm', 'wavy', 'west',
    'wet', 'white', 'wide', 'wild', 'windy', 'wise', 'worn', 'young',
];
const SLUG_NOUNS = [
    'acorn', 'arch', 'arrow', 'aspen', 'badger', 'basil', 'bay', 'bear',
    'birch', 'blade', 'bloom', 'bolt', 'brook', 'brush', 'cairn', 'cave',
    'cedar', 'cliff', 'cloud', 'clover', 'coast', 'coral', 'crane', 'creek',
    'crow', 'dale', 'deer', 'delta', 'dew', 'dock', 'dove', 'drift',
    'drum', 'dune', 'eagle', 'echo', 'edge', 'elm', 'ember', 'fawn',
    'fern', 'field', 'finch', 'flame', 'flare', 'flint', 'fog', 'ford',
    'forge', 'fox', 'frost', 'gale', 'gate', 'gem', 'glen', 'goat',
    'grove', 'gull', 'hawk', 'haze', 'heath', 'hedge', 'heron', 'hill',
    'holly', 'horse', 'hound', 'isle', 'ivy', 'jade', 'jay', 'kelp',
    'lake', 'lark', 'leaf', 'ledge', 'lily', 'lion', 'lodge', 'lynx',
    'maple', 'marsh', 'mesa', 'mill', 'mint', 'mist', 'moon', 'moss',
    'moth', 'mule', 'nest', 'oak', 'orca', 'otter', 'owl', 'palm',
    'path', 'peak', 'pearl', 'petal', 'pike', 'pine', 'plum', 'pond',
    'quail', 'rain', 'raven', 'reed', 'reef', 'ridge', 'river', 'robin',
    'root', 'rose', 'sage', 'seal', 'shade', 'shell', 'shore', 'slate',
    'snail', 'spark', 'stone', 'storm', 'stork', 'thorn', 'tide', 'trail',
    'trout', 'tulip', 'vale', 'vine', 'viper', 'wave', 'wren', 'wolf',
];

function generateSlug() {
    const adj = SLUG_ADJECTIVES[crypto.randomInt(SLUG_ADJECTIVES.length)];
    const noun = SLUG_NOUNS[crypto.randomInt(SLUG_NOUNS.length)];
    const num = crypto.randomInt(10, 100); // 10–99
    const slug = `${adj}-${noun}-${num}`;
    // Check uniqueness — retry with fresh combo on collision (extremely unlikely)
    const existing = db.get('SELECT 1 FROM pastes WHERE slug = ?', [slug]);
    if (existing) return generateSlug();
    return slug;
}

function sanitizeTitle(title) {
    return String(title || '').trim().slice(0, 200) || 'Untitled';
}

function detectLanguage(content, hint) {
    if (hint && hint !== 'auto') return hint;
    const first = String(content || '').slice(0, 500);
    if (/^<(!DOCTYPE|html|div|span|head|body)/im.test(first)) return 'html';
    if (/^(import |from |const |let |var |function |=>|class )/m.test(first)) return 'javascript';
    if (/^(def |class |import |from |print\(|if __name__)/m.test(first)) return 'python';
    if (/^(package |func |import \(|fmt\.)/m.test(first)) return 'go';
    if (/^\{[\s\n]*"/.test(first)) return 'json';
    if (/^---\n|^[a-z_]+:\s/m.test(first)) return 'yaml';
    if (/^#!\/(bin|usr)/m.test(first)) return 'bash';
    if (/```|^#{1,6} |^\* |\*\*|^\[.*\]\(.*\)/m.test(first)) return 'markdown';
    if (/^(SELECT|INSERT|CREATE|ALTER|DROP|UPDATE|DELETE)\s/im.test(first)) return 'sql';
    if (/^<\?php/m.test(first)) return 'php';
    if (/^(use |fn |let mut |pub |impl |struct )/m.test(first)) return 'rust';
    return 'text';
}

const MAX_PASTE_SIZE = 512 * 1024; // 512 KB text limit (fallback; overridden by site setting)

/**
 * Level-based daily paste limits.
 * Users earn higher limits by leveling up skills in HoboGame.
 * Total level = sum of all 8 skill levels (mining, fishing, woodcut, farming,
 * combat, crafting, smithing, agility). Each skill starts at level 1.
 * A brand-new game profile has total level 8 (all skills at 1).
 *
 * Tiers (total game level → daily paste limit):
 *   Anon / no account:   10/day
 *   Level 0-15  (new):   20/day
 *   Level 16-30 (casual): 40/day
 *   Level 31-60 (active): 75/day
 *   Level 61-100 (vet):  120/day
 *   Level 101+  (elite): 200/day
 *   Admin/global_mod:    unlimited (0 = no limit)
 */
const PASTE_LEVEL_TIERS = [
    { minLevel: 101, limit: 200 },
    { minLevel:  61, limit: 120 },
    { minLevel:  31, limit:  75 },
    { minLevel:  16, limit:  40 },
    { minLevel:   0, limit:  20 },
];
const PASTE_ANON_LIMIT = 10;

/**
 * Get the effective daily paste limit for a user based on their game level.
 * @param {object|null} user - req.user (null for anon)
 * @returns {{ limit: number, totalLevel: number, tierLabel: string }}
 */
function getEffectivePasteLimit(user) {
    if (!user) return { limit: PASTE_ANON_LIMIT, totalLevel: 0, tierLabel: 'Anonymous' };

    // Admins and global mods get unlimited
    if (user.role === 'admin' || user.role === 'global_mod') {
        return { limit: 0, totalLevel: -1, tierLabel: 'Unlimited (staff)' };
    }

    const totalLevel = db.getUserTotalGameLevel(user.id);
    for (const tier of PASTE_LEVEL_TIERS) {
        if (totalLevel >= tier.minLevel) {
            return { limit: tier.limit, totalLevel, tierLabel: `Lv ${totalLevel}` };
        }
    }
    // Fallback (shouldn't reach here)
    return { limit: 20, totalLevel, tierLabel: `Lv ${totalLevel}` };
}

// Helper: get configurable limits from site settings
function getPasteConfig() {
    return {
        maxSizeKb: Number(db.getSetting('paste_max_size_kb')) || 512,
        screenshotMaxSizeMb: Number(db.getSetting('paste_screenshot_max_size_mb')) || 8,
        cooldownSeconds: Number(db.getSetting('paste_cooldown_seconds')) || 30,
        maxPerUserPerDay: Number(db.getSetting('paste_max_per_user_per_day')) || 50,
        anonAllowed: db.getSetting('paste_anon_allowed') !== false,
        imageUploadEnabled: db.getSetting('paste_image_upload_enabled') !== false,
    };
}

// ── List pastes (public index) ──────────────────────────────
router.get('/', optionalAuth, (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const type = req.query.type; // 'paste', 'screenshot', or undefined for all
        const search = req.query.search ? `%${req.query.search}%` : null;

        let sql = `SELECT p.*, u.username, u.display_name, u.avatar_url
                    FROM pastes p
                    LEFT JOIN users u ON p.user_id = u.id
                    WHERE p.visibility = 'public'`;
        const params = [];

        if (type === 'paste' || type === 'screenshot') {
            sql += ` AND p.type = ?`;
            params.push(type);
        }
        if (search) {
            sql += ` AND (p.title LIKE ? OR p.content LIKE ?)`;
            params.push(search, search);
        }

        sql += ` ORDER BY p.pinned DESC, p.created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const pastes = db.all(sql, params).map(p => ({
            ...p,
            content: p.type === 'paste' ? (p.content || '').slice(0, 300) : null, // Preview only in list
            screenshot_url: p.screenshot_path ? `/data/pastes/screenshots/${path.basename(p.screenshot_path)}` : null,
            copies: p.copies || 0,
            likes: p.likes || 0,
        }));

        const countSql = `SELECT COUNT(*) as total FROM pastes WHERE visibility = 'public'`
            + (type ? ` AND type = '${type === 'screenshot' ? 'screenshot' : 'paste'}'` : '');
        const { total } = db.get(countSql);

        res.json({ pastes, total, limit, offset });
    } catch (err) {
        console.error('[Pastes] List error:', err);
        res.status(500).json({ error: 'Failed to list pastes' });
    }
});

// ── Get paste config (public) — must be before /:slug ───────
router.get('/config', optionalAuth, (req, res) => {
    try {
        const config = getPasteConfig();
        const { limit, totalLevel, tierLabel } = getEffectivePasteLimit(req.user);
        const effectiveLimit = limit || config.maxPerUserPerDay; // 0 = unlimited for staff
        const todayCount = req.user
            ? db.countUserPastesToday(req.user.id, null)
            : db.countUserPastesToday(null, req.ip);
        res.json({
            maxSizeKb: config.maxSizeKb,
            screenshotMaxSizeMb: config.screenshotMaxSizeMb,
            cooldownSeconds: config.cooldownSeconds,
            maxPerUserPerDay: effectiveLimit,
            anonAllowed: config.anonAllowed,
            imageUploadEnabled: config.imageUploadEnabled,
            // Level-based limit details
            levelInfo: {
                totalLevel,
                tierLabel,
                dailyLimit: effectiveLimit,
                usedToday: todayCount,
                remaining: limit === 0 ? Infinity : Math.max(0, effectiveLimit - todayCount),
            },
            tiers: PASTE_LEVEL_TIERS.map(t => ({ minLevel: t.minLevel, limit: t.limit })),
            anonLimit: PASTE_ANON_LIMIT,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get config' });
    }
});

// ── Paste stats (admin) — must be before /:slug ─────────────
router.get('/admin/stats', requireAuth, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'global_mod') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    try {
        const stats = db.getPasteStats();
        res.json({ stats });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get paste stats' });
    }
});

// ── Delete all forks (admin) — must be before /:slug ────────
router.delete('/admin/forks', requireAuth, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    try {
        const count = db.deleteAllForks();
        res.json({ success: true, deleted: count });
    } catch (err) {
        console.error('[Pastes] Delete forks error:', err);
        res.status(500).json({ error: 'Failed to delete forks' });
    }
});

// ── Get single paste by slug ────────────────────────────────
router.get('/:slug', optionalAuth, (req, res) => {
    try {
        const paste = db.get(
            `SELECT p.*, u.username, u.display_name, u.avatar_url
             FROM pastes p LEFT JOIN users u ON p.user_id = u.id
             WHERE p.slug = ?`,
            [req.params.slug]
        );
        if (!paste) return res.status(404).json({ error: 'Paste not found' });

        // Unlisted pastes: only accessible via direct link (no auth check needed — that's the point)
        // But we still serve them.

        // Increment view count (don't count own views)
        const isOwner = req.user && paste.user_id === req.user.id;
        if (!isOwner) {
            db.run('UPDATE pastes SET views = views + 1 WHERE id = ?', [paste.id]);
            paste.views += 1;
        }

        paste.screenshot_url = paste.screenshot_path
            ? `/data/pastes/screenshots/${path.basename(paste.screenshot_path)}`
            : null;

        // Include like status for logged-in user
        paste.liked = req.user ? db.hasUserLikedPaste(paste.id, req.user.id) : false;
        paste.copies = paste.copies || 0;
        paste.likes = paste.likes || 0;

        res.json({ paste });
    } catch (err) {
        console.error('[Pastes] Get error:', err);
        res.status(500).json({ error: 'Failed to get paste' });
    }
});

// ── Create text paste ───────────────────────────────────────
router.post('/', optionalAuth, (req, res) => {
    try {
        const { title, content, language, visibility, stream_id, burn_after_read } = req.body;
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const config = getPasteConfig();

        // Anonymous check
        if (!req.user && !config.anonAllowed) {
            return res.status(403).json({ error: 'Anonymous pastes are disabled. Please log in.' });
        }

        // Size limit
        const maxBytes = config.maxSizeKb * 1024;
        if (content.length > maxBytes) {
            return res.status(400).json({ error: `Paste too large (max ${config.maxSizeKb} KB)` });
        }

        // Cooldown check
        if (config.cooldownSeconds > 0) {
            const lastTime = db.getLastPasteTime(req.user?.id, req.ip);
            const elapsed = (Date.now() - lastTime) / 1000;
            if (elapsed < config.cooldownSeconds) {
                const wait = Math.ceil(config.cooldownSeconds - elapsed);
                return res.status(429).json({ error: `Please wait ${wait}s before creating another paste`, cooldown: wait });
            }
        }

        // Daily limit check (level-based)
        const { limit: dailyLimit } = getEffectivePasteLimit(req.user);
        if (dailyLimit > 0) {
            const todayCount = db.countUserPastesToday(req.user?.id, req.ip);
            if (todayCount >= dailyLimit) {
                const hint = req.user ? ' Level up in HoboGame to increase your limit!' : ' Log in for a higher limit!';
                return res.status(429).json({ error: `Daily paste limit reached (${dailyLimit}/day).${hint}`, dailyLimit });
            }
        }

        const slug = generateSlug();
        const vis = visibility === 'unlisted' ? 'unlisted' : 'public';
        const lang = detectLanguage(content, language);
        const burn = burn_after_read ? 1 : 0;

        db.run(
            `INSERT INTO pastes (slug, user_id, type, title, content, language, visibility, stream_id, burn_after_read, ip_address)
             VALUES (?, ?, 'paste', ?, ?, ?, ?, ?, ?, ?)`,
            [slug, req.user?.id || null, sanitizeTitle(title), content.trim(), lang, vis,
             stream_id || null, burn, req.ip]
        );

        const paste = db.get('SELECT * FROM pastes WHERE slug = ?', [slug]);
        res.status(201).json({ paste, url: `/p/${slug}` });
    } catch (err) {
        console.error('[Pastes] Create error:', err);
        res.status(500).json({ error: 'Failed to create paste' });
    }
});

// ── Upload screenshot ───────────────────────────────────────
router.post('/screenshot', optionalAuth, (req, res, next) => {
    const config = getPasteConfig();

    if (!config.imageUploadEnabled) {
        return res.status(403).json({ error: 'Image uploads are currently disabled' });
    }

    // Anonymous check
    if (!req.user && !config.anonAllowed) {
        return res.status(403).json({ error: 'Anonymous uploads are disabled. Please log in.' });
    }

    // Cooldown check
    if (config.cooldownSeconds > 0) {
        const lastTime = db.getLastPasteTime(req.user?.id, req.ip);
        const elapsed = (Date.now() - lastTime) / 1000;
        if (elapsed < config.cooldownSeconds) {
            const wait = Math.ceil(config.cooldownSeconds - elapsed);
            return res.status(429).json({ error: `Please wait ${wait}s before uploading`, cooldown: wait });
        }
    }

    // Daily limit check (level-based)
    const { limit: dailyLimit } = getEffectivePasteLimit(req.user);
    if (dailyLimit > 0) {
        const todayCount = db.countUserPastesToday(req.user?.id, req.ip);
        if (todayCount >= dailyLimit) {
            const hint = req.user ? ' Level up in HoboGame to increase your limit!' : ' Log in for a higher limit!';
            return res.status(429).json({ error: `Daily upload limit reached (${dailyLimit}/day).${hint}`, dailyLimit });
        }
    }

    // Dynamic file-size limit from settings
    const dynamicUpload = multer({
        storage: screenshotStorage,
        limits: { fileSize: config.screenshotMaxSizeMb * 1024 * 1024 },
        fileFilter: (_req, file, cb) => {
            if (/^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) cb(null, true);
            else cb(new Error('Only PNG, JPEG, WebP, or GIF images allowed'));
        },
    }).single('screenshot');

    dynamicUpload(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: `File too large (max ${config.screenshotMaxSizeMb} MB)` });
            }
            return res.status(400).json({ error: err.message || 'Upload failed' });
        }
        _handleScreenshotUpload(req, res);
    });
});

function _handleScreenshotUpload(req, res) {
    try {
        if (!req.file) return res.status(400).json({ error: 'Screenshot image is required' });

        const { title, description, visibility, stream_id, page_url, user_agent } = req.body;
        const slug = generateSlug();
        const vis = visibility === 'unlisted' ? 'unlisted' : 'public';

        // Build metadata JSON
        const metadata = JSON.stringify({
            page_url: page_url || null,
            user_agent: user_agent || req.get('user-agent') || null,
            original_name: req.file.originalname,
            size_bytes: req.file.size,
            mime_type: req.file.mimetype,
        });

        db.run(
            `INSERT INTO pastes (slug, user_id, type, title, content, language, visibility, stream_id, screenshot_path, metadata, ip_address)
             VALUES (?, ?, 'screenshot', ?, ?, 'text', ?, ?, ?, ?, ?)`,
            [slug, req.user?.id || null, sanitizeTitle(title || 'Screenshot'),
             description || '', vis, stream_id || null, req.file.path, metadata, req.ip]
        );

        const paste = db.get('SELECT * FROM pastes WHERE slug = ?', [slug]);
        paste.screenshot_url = `/data/pastes/screenshots/${path.basename(req.file.path)}`;
        res.status(201).json({ paste, url: `/p/${slug}` });
    } catch (err) {
        console.error('[Pastes] Screenshot error:', err);
        // Clean up uploaded file on error
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
        res.status(500).json({ error: 'Failed to upload screenshot' });
    }
}

// ── Update paste ────────────────────────────────────────────
router.put('/:slug', requireAuth, (req, res) => {
    try {
        const paste = db.get('SELECT * FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!paste) return res.status(404).json({ error: 'Paste not found' });
        const isOwner = paste.user_id && paste.user_id === req.user.id;
        const isStaff = req.user.role === 'admin' || req.user.role === 'global_mod';
        if (!isOwner && !isStaff) {
            return res.status(403).json({ error: 'Not your paste' });
        }

        const { title, content, language, visibility, pinned } = req.body;
        const updates = [];
        const params = [];

        if (title !== undefined) { updates.push('title = ?'); params.push(sanitizeTitle(title)); }
        if (content !== undefined && paste.type === 'paste') {
            if (content.length > MAX_PASTE_SIZE) return res.status(400).json({ error: 'Too large' });
            updates.push('content = ?'); params.push(content);
            updates.push('language = ?'); params.push(detectLanguage(content, language));
        }
        if (visibility !== undefined) { updates.push('visibility = ?'); params.push(visibility === 'unlisted' ? 'unlisted' : 'public'); }
        if (pinned !== undefined && (req.user.role === 'admin' || req.user.role === 'global_mod')) {
            updates.push('pinned = ?'); params.push(pinned ? 1 : 0);
        }

        if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.slug);
        db.run(`UPDATE pastes SET ${updates.join(', ')} WHERE slug = ?`, params);

        const updated = db.get(
            `SELECT p.*, u.username, u.display_name, u.avatar_url
             FROM pastes p LEFT JOIN users u ON p.user_id = u.id WHERE p.slug = ?`,
            [req.params.slug]
        );
        res.json({ paste: updated });
    } catch (err) {
        console.error('[Pastes] Update error:', err);
        res.status(500).json({ error: 'Failed to update paste' });
    }
});

// ── Delete paste ────────────────────────────────────────────
router.delete('/:slug', requireAuth, (req, res) => {
    try {
        const paste = db.get('SELECT * FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!paste) return res.status(404).json({ error: 'Paste not found' });
        const isOwner = paste.user_id && paste.user_id === req.user.id;
        const isStaff = req.user.role === 'admin' || req.user.role === 'global_mod';
        if (!isOwner && !isStaff) {
            return res.status(403).json({ error: 'Not your paste' });
        }

        // Delete screenshot file if exists
        if (paste.screenshot_path) {
            try { fs.unlinkSync(paste.screenshot_path); } catch {}
        }

        db.run('DELETE FROM pastes WHERE id = ?', [paste.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('[Pastes] Delete error:', err);
        res.status(500).json({ error: 'Failed to delete paste' });
    }
});

// ── Censor screenshot image (admin/global_mod) ─────────────
router.post('/:slug/censor', requireAuth, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'global_mod') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    const paste = db.get('SELECT * FROM pastes WHERE slug = ?', [req.params.slug]);
    if (!paste) return res.status(404).json({ error: 'Paste not found' });
    if (paste.type !== 'screenshot' || !paste.screenshot_path) {
        return res.status(400).json({ error: 'Not a screenshot paste' });
    }

    // Use multer to handle the uploaded censored image
    const censorUpload = multer({
        storage: screenshotStorage,
        limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB for censored exports
        fileFilter: (_req, file, cb) => {
            if (/^image\/(png|jpeg|webp)$/.test(file.mimetype)) cb(null, true);
            else cb(new Error('Only PNG, JPEG, or WebP images allowed'));
        },
    }).single('screenshot');

    censorUpload(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
        if (!req.file) return res.status(400).json({ error: 'Censored image is required' });

        try {
            // Delete the old screenshot file
            try { fs.unlinkSync(paste.screenshot_path); } catch {}

            // Update the paste record with the new screenshot path
            db.run('UPDATE pastes SET screenshot_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [req.file.path, paste.id]);

            const updated = db.get(
                `SELECT p.*, u.username, u.display_name, u.avatar_url
                 FROM pastes p LEFT JOIN users u ON p.user_id = u.id WHERE p.slug = ?`,
                [req.params.slug]
            );
            updated.screenshot_url = `/data/pastes/screenshots/${path.basename(req.file.path)}`;
            res.json({ paste: updated });
        } catch (err2) {
            console.error('[Pastes] Censor error:', err2);
            if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
            res.status(500).json({ error: 'Failed to save censored image' });
        }
    });
});

// ── Fork (copy) a paste ─────────────────────────────────────
router.post('/:slug/fork', optionalAuth, (req, res) => {
    try {
        const original = db.get('SELECT * FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!original || original.type !== 'paste') {
            return res.status(404).json({ error: 'Paste not found' });
        }

        const config = getPasteConfig();

        // Cooldown check
        if (config.cooldownSeconds > 0) {
            const lastTime = db.getLastPasteTime(req.user?.id, req.ip);
            const elapsed = (Date.now() - lastTime) / 1000;
            if (elapsed < config.cooldownSeconds) {
                const wait = Math.ceil(config.cooldownSeconds - elapsed);
                return res.status(429).json({ error: `Please wait ${wait}s before forking`, cooldown: wait });
            }
        }

        const slug = generateSlug();
        db.run(
            `INSERT INTO pastes (slug, user_id, type, title, content, language, visibility, forked_from, ip_address)
             VALUES (?, ?, 'paste', ?, ?, ?, 'public', ?, ?)`,
            [slug, req.user?.id || null, `Fork of ${original.title}`,
             original.content, original.language, original.id, req.ip]
        );

        const paste = db.get('SELECT * FROM pastes WHERE slug = ?', [slug]);

        if (original.user_id && (!req.user || original.user_id !== req.user.id)) {
            const actor = notificationActor(req.user, 'Someone');
            pushNotification({
                user_id: original.user_id,
                type: 'PASTE_FORK',
                category: 'social',
                priority: 'normal',
                title: 'Your paste was forked',
                message: `${actor.sender_name} forked "${truncatePreview(original.title || 'Untitled paste', 80)}"`,
                icon: '🍴',
                ...actor,
                service: 'hobostreamer',
                url: `https://hobostreamer.com/p/${original.slug}`,
                rich_content: {
                    body: truncatePreview(original.content, 160),
                    context: { paste_slug: original.slug, event: 'fork' },
                },
            });
        }

        res.status(201).json({ paste, url: `/p/${slug}` });
    } catch (err) {
        console.error('[Pastes] Fork error:', err);
        res.status(500).json({ error: 'Failed to fork paste' });
    }
});

// ── Raw content (plain text download) ───────────────────────
router.get('/:slug/raw', (req, res) => {
    try {
        const paste = db.get('SELECT * FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!paste || paste.type !== 'paste') return res.status(404).send('Not found');

        // Burn after read
        if (paste.burn_after_read && paste.views > 0) {
            db.run('DELETE FROM pastes WHERE id = ?', [paste.id]);
            return res.status(410).send('This paste has been burned after reading.');
        }

        db.run('UPDATE pastes SET views = views + 1 WHERE id = ?', [paste.id]);
        res.type('text/plain').send(paste.content);
    } catch {
        res.status(500).send('Error');
    }
});

// ── Like / Unlike a paste ───────────────────────────────────
router.post('/:slug/like', requireAuth, (req, res) => {
    try {
        const paste = db.get('SELECT id, slug, user_id, title FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!paste) return res.status(404).json({ error: 'Paste not found' });

        const alreadyLiked = db.hasUserLikedPaste(paste.id, req.user.id);
        let result;
        if (alreadyLiked) {
            result = db.unlikePaste(paste.id, req.user.id);
        } else {
            result = db.likePaste(paste.id, req.user.id);
            if (paste.user_id && paste.user_id !== req.user.id) {
                const actor = notificationActor(req.user);
                pushNotification({
                    user_id: paste.user_id,
                    type: 'PASTE_LIKE',
                    category: 'social',
                    priority: 'normal',
                    title: 'New like on your paste',
                    message: `${actor.sender_name} liked "${truncatePreview(paste.title || 'Untitled paste', 80)}"`,
                    icon: '👍',
                    ...actor,
                    service: 'hobostreamer',
                    url: `https://hobostreamer.com/p/${paste.slug}`,
                    rich_content: {
                        context: { paste_slug: paste.slug, event: 'like' },
                    },
                });
            }
        }
        res.json({ liked: !alreadyLiked, likes: result?.likes || 0 });
    } catch (err) {
        console.error('[Pastes] Like error:', err);
        res.status(500).json({ error: 'Failed to toggle like' });
    }
});

// ── Track a copy event ──────────────────────────────────────
router.post('/:slug/copy', optionalAuth, (req, res) => {
    try {
        const paste = db.get('SELECT id, slug, user_id, title, copies FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!paste) return res.status(404).json({ error: 'Paste not found' });
        db.incrementPasteCopies(req.params.slug);

        if (paste.user_id && (!req.user || paste.user_id !== req.user.id)) {
            const actor = notificationActor(req.user, 'Someone');
            pushNotification({
                user_id: paste.user_id,
                type: 'PASTE_COPY',
                category: 'social',
                priority: 'low',
                title: 'Your paste was copied',
                message: `${actor.sender_name} copied "${truncatePreview(paste.title || 'Untitled paste', 80)}"`,
                icon: '📋',
                ...actor,
                service: 'hobostreamer',
                url: `https://hobostreamer.com/p/${paste.slug}`,
                rich_content: {
                    context: { paste_slug: paste.slug, event: 'copy' },
                },
            });
        }

        res.json({ copies: (paste.copies || 0) + 1 });
    } catch (err) {
        console.error('[Pastes] Copy track error:', err);
        res.status(500).json({ error: 'Failed to track copy' });
    }
});

// ═════════════════════════════════════════════════════════════
// ── Paste Comments ──────────────────────────────────────────
// ═════════════════════════════════════════════════════════════

// Rate-limit state: IP → timestamp of last comment
const commentCooldowns = new Map();

// Cleanup stale cooldown entries every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, ts] of commentCooldowns) {
        if (now - ts > 120_000) commentCooldowns.delete(ip);
    }
}, 600_000);

/**
 * GET /:slug/comments — List comments for a paste
 */
router.get('/:slug/comments', optionalAuth, (req, res) => {
    try {
        const paste = db.get('SELECT id FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!paste) return res.status(404).json({ error: 'Paste not found' });

        const limit = Math.min(parseInt(req.query.limit || '50'), 100);
        const offset = parseInt(req.query.offset || '0');

        const comments = db.getPasteComments(paste.id, limit, offset);
        const total = db.getPasteCommentCount(paste.id);

        // Attach replies to each top-level comment
        for (const c of comments) {
            c.replies = db.getPasteCommentReplies(c.id);
            c.reply_count = c.replies.length;
        }

        res.json({ comments, total });
    } catch (err) {
        console.error('[PasteComments] List error:', err.message);
        res.status(500).json({ error: 'Failed to load comments' });
    }
});

/**
 * POST /:slug/comments — Add a comment (logged-in or anon)
 *
 * Body: { message, parent_id?, anon_name? }
 * Anti-spam: IP cooldown, length limit, duplicate check, banned IP check
 */
router.post('/:slug/comments', optionalAuth, (req, res) => {
    try {
        const paste = db.get('SELECT id, slug, user_id, title FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!paste) return res.status(404).json({ error: 'Paste not found' });

        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        const isLoggedIn = !!req.user;

        // ── Anon check ──────────────────────────────────────
        if (!isLoggedIn) {
            const anonAllowed = db.getSetting('paste_comment_anon_allowed');
            if (anonAllowed === 'false') {
                return res.status(401).json({ error: 'You must be logged in to comment' });
            }
        }

        // ── IP ban check ────────────────────────────────────
        if (db.isIpBanned && db.isIpBanned(ip)) {
            return res.status(403).json({ error: 'You are not allowed to comment' });
        }

        // ── Message validation ──────────────────────────────
        const message = (req.body.message || '').trim();
        const maxLen = parseInt(db.getSetting('paste_comment_max_length') || '2000');
        if (!message) return res.status(400).json({ error: 'Comment cannot be empty' });
        if (message.length > maxLen) {
            return res.status(400).json({ error: `Comment must be under ${maxLen} characters` });
        }

        // ── Anon name validation ────────────────────────────
        let anonName = null;
        if (!isLoggedIn) {
            anonName = (req.body.anon_name || '').trim().substring(0, 32) || 'Anonymous';
            // Sanitize — alphanumeric, spaces, underscores, hyphens only
            anonName = anonName.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() || 'Anonymous';
        }

        // ── Rate limit (IP-based cooldown) ──────────────────
        const cooldownSec = parseInt(db.getSetting('paste_comment_cooldown_seconds') || '10');
        const lastComment = commentCooldowns.get(ip);
        if (lastComment && (Date.now() - lastComment) < cooldownSec * 1000) {
            const wait = Math.ceil((cooldownSec * 1000 - (Date.now() - lastComment)) / 1000);
            return res.status(429).json({ error: `Please wait ${wait}s before commenting again` });
        }

        // ── Flood detection (multiple recent comments from same IP) ──
        const recentFromIp = db.getRecentPasteCommentsByIp(ip, 60);
        if (recentFromIp.length >= 5) {
            return res.status(429).json({ error: 'Too many comments. Please slow down.' });
        }

        // ── Duplicate detection ─────────────────────────────
        if (recentFromIp.length > 0 && recentFromIp[0].message === message) {
            return res.status(400).json({ error: 'Duplicate comment' });
        }

        // ── Parent comment validation ───────────────────────
        const parentId = req.body.parent_id ? parseInt(req.body.parent_id) : null;
        let parent = null;
        if (parentId) {
            parent = db.getPasteCommentById(parentId);
            if (!parent || parent.paste_id !== paste.id) {
                return res.status(400).json({ error: 'Invalid parent comment' });
            }
            // Prevent deeply nested replies — only allow replies to top-level
            if (parent.parent_id) {
                return res.status(400).json({ error: 'Cannot reply to a reply — reply to the original comment instead' });
            }
        }

        // ── Create comment ──────────────────────────────────
        const result = db.createPasteComment({
            paste_id: paste.id,
            user_id: isLoggedIn ? req.user.id : null,
            parent_id: parentId,
            anon_name: anonName,
            message,
            ip_address: ip,
        });

        // Record cooldown
        commentCooldowns.set(ip, Date.now());

        // Return the newly created comment with user data
        const comment = db.get(`
            SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
            FROM paste_comments c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.id = ?
        `, [result.lastInsertRowid]);

        const actor = notificationActor(req.user, anonName || 'Anonymous');
        const actorUserId = req.user?.id || null;
        const recipients = new Map();

        if (paste.user_id && paste.user_id !== actorUserId) {
            recipients.set(paste.user_id, {
                user_id: paste.user_id,
                type: parentId ? 'PASTE_REPLY' : 'PASTE_COMMENT',
                category: 'social',
                priority: 'normal',
                title: parentId ? 'New reply on your paste' : 'New comment on your paste',
                message: `${actor.sender_name} ${parentId ? 'replied on' : 'commented on'} "${truncatePreview(paste.title || 'Untitled paste', 80)}"`,
                icon: parentId ? '↩️' : '💬',
                ...actor,
                service: 'hobostreamer',
                url: `https://hobostreamer.com/p/${paste.slug}#comments`,
                rich_content: {
                    body: truncatePreview(message, 180),
                    context: { paste_slug: paste.slug, comment_id: comment.id, parent_id: parentId || null },
                },
            });
        }

        if (parent?.user_id && parent.user_id !== actorUserId) {
            recipients.set(parent.user_id, {
                user_id: parent.user_id,
                type: 'PASTE_REPLY',
                category: 'social',
                priority: 'normal',
                title: 'New reply to your comment',
                message: `${actor.sender_name} replied to your comment on "${truncatePreview(paste.title || 'Untitled paste', 80)}"`,
                icon: '↩️',
                ...actor,
                service: 'hobostreamer',
                url: `https://hobostreamer.com/p/${paste.slug}#comments`,
                rich_content: {
                    body: truncatePreview(message, 180),
                    context: { paste_slug: paste.slug, comment_id: comment.id, parent_id: parentId },
                },
            });
        }

        for (const payload of recipients.values()) {
            pushNotification(payload);
        }

        res.status(201).json({ comment });
    } catch (err) {
        console.error('[PasteComments] Create error:', err.message);
        res.status(500).json({ error: 'Failed to post comment' });
    }
});

/**
 * DELETE /:slug/comments/:commentId — Delete a comment
 *
 * Allowed by: comment author, paste owner/poster, or site admin
 */
router.delete('/:slug/comments/:commentId', optionalAuth, (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Login required' });

        const paste = db.get('SELECT id, user_id FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!paste) return res.status(404).json({ error: 'Paste not found' });

        const comment = db.getPasteCommentById(parseInt(req.params.commentId));
        if (!comment || comment.paste_id !== paste.id) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const isAuthor = comment.user_id && comment.user_id === req.user.id;
        const isPasteOwner = paste.user_id && paste.user_id === req.user.id;
        const isAdmin = req.user.role === 'admin';

        if (!isAuthor && !isPasteOwner && !isAdmin) {
            return res.status(403).json({ error: 'Not authorized to delete this comment' });
        }

        db.deletePasteComment(comment.id);
        res.json({ message: 'Comment deleted' });
    } catch (err) {
        console.error('[PasteComments] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

module.exports = router;
