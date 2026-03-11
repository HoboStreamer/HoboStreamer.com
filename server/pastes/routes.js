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

// ── Screenshot upload storage ───────────────────────────────
const SCREENSHOTS_DIR = path.resolve('./data/pastes/screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const screenshotStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, SCREENSHOTS_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || '.png';
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
function generateSlug() {
    // 8-char url-safe id (like gist/pastebin short ids)
    return crypto.randomBytes(6).toString('base64url').slice(0, 8);
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

const MAX_PASTE_SIZE = 512 * 1024; // 512 KB text limit

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
        if (content.length > MAX_PASTE_SIZE) {
            return res.status(400).json({ error: `Paste too large (max ${MAX_PASTE_SIZE / 1024} KB)` });
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
router.post('/screenshot', optionalAuth, screenshotUpload.single('screenshot'), (req, res) => {
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
});

// ── Update paste ────────────────────────────────────────────
router.put('/:slug', requireAuth, (req, res) => {
    try {
        const paste = db.get('SELECT * FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!paste) return res.status(404).json({ error: 'Paste not found' });
        if (paste.user_id !== req.user.id && req.user.role !== 'admin') {
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
        if (paste.user_id !== req.user.id && req.user.role !== 'admin') {
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

// ── Fork (copy) a paste ─────────────────────────────────────
router.post('/:slug/fork', optionalAuth, (req, res) => {
    try {
        const original = db.get('SELECT * FROM pastes WHERE slug = ?', [req.params.slug]);
        if (!original || original.type !== 'paste') {
            return res.status(404).json({ error: 'Paste not found' });
        }

        const slug = generateSlug();
        db.run(
            `INSERT INTO pastes (slug, user_id, type, title, content, language, visibility, forked_from, ip_address)
             VALUES (?, ?, 'paste', ?, ?, ?, 'public', ?, ?)`,
            [slug, req.user?.id || null, `Fork of ${original.title}`,
             original.content, original.language, original.id, req.ip]
        );

        const paste = db.get('SELECT * FROM pastes WHERE slug = ?', [slug]);
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

module.exports = router;
