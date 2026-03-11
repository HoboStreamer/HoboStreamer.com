/**
 * HoboStreamer — Direct Message System
 *
 * Facebook Messenger-style DMs: 1-on-1 and group conversations,
 * persisted to SQLite, real-time delivery via WebSocket, with
 * read receipts and unread counts.
 *
 * Tables:
 *   dm_conversations  — conversation metadata
 *   dm_participants   — who's in each conversation
 *   dm_messages       — individual messages
 */
const db = require('../db/database');

// ── Schema & Migrations ──────────────────────────────────────

function ensureTables() {
    const database = db.getDb();
    try {
        database.exec(`
            CREATE TABLE IF NOT EXISTS dm_conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                is_group INTEGER DEFAULT 0,
                created_by INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS dm_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                last_read_at DATETIME DEFAULT '1970-01-01 00:00:00',
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(conversation_id, user_id),
                FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS dm_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_dm_participants_conv ON dm_participants(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_dm_participants_user ON dm_participants(user_id);
            CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages(conversation_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_dm_messages_sender ON dm_messages(sender_id);
        `);
        console.log('[DM] Tables ready');
    } catch (e) {
        console.warn('[DM] Table migration:', e.message);
    }
}

// ── Conversation helpers ─────────────────────────────────────

/**
 * Find an existing 1-on-1 conversation between two users.
 * Returns conversation row or null.
 */
function findDirectConversation(userIdA, userIdB) {
    return db.get(`
        SELECT c.* FROM dm_conversations c
        JOIN dm_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ?
        JOIN dm_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ?
        WHERE c.is_group = 0
    `, [userIdA, userIdB]) || null;
}

/**
 * Create a new conversation. Returns the new conversation id.
 * participantIds should include the creator.
 */
function createConversation(createdBy, participantIds, name = null) {
    const isGroup = participantIds.length > 2 ? 1 : 0;
    const result = db.run(
        `INSERT INTO dm_conversations (name, is_group, created_by) VALUES (?, ?, ?)`,
        [isGroup ? (name || null) : null, isGroup, createdBy]
    );
    const convId = result.lastInsertRowid;
    const insert = db.getDb().prepare(
        `INSERT OR IGNORE INTO dm_participants (conversation_id, user_id) VALUES (?, ?)`
    );
    for (const uid of participantIds) {
        insert.run(convId, uid);
    }
    return convId;
}

/**
 * Get or create a 1-on-1 conversation between two users.
 */
function getOrCreateDirect(userIdA, userIdB) {
    const existing = findDirectConversation(userIdA, userIdB);
    if (existing) return existing.id;
    return createConversation(userIdA, [userIdA, userIdB]);
}

/**
 * Add a participant to an existing group conversation.
 */
function addParticipant(conversationId, userId) {
    db.run(
        `INSERT OR IGNORE INTO dm_participants (conversation_id, user_id) VALUES (?, ?)`,
        [conversationId, userId]
    );
    // Mark as group if > 2 participants
    const count = db.get(
        `SELECT COUNT(*) as c FROM dm_participants WHERE conversation_id = ?`,
        [conversationId]
    )?.c || 0;
    if (count > 2) {
        db.run(`UPDATE dm_conversations SET is_group = 1 WHERE id = ?`, [conversationId]);
    }
}

/**
 * Remove a participant from a group conversation.
 */
function removeParticipant(conversationId, userId) {
    db.run(
        `DELETE FROM dm_participants WHERE conversation_id = ? AND user_id = ?`,
        [conversationId, userId]
    );
}

/**
 * Check if a user is a participant in a conversation.
 */
function isParticipant(conversationId, userId) {
    return !!db.get(
        `SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?`,
        [conversationId, userId]
    );
}

/**
 * Rename a group conversation.
 */
function renameConversation(conversationId, name) {
    db.run(`UPDATE dm_conversations SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [name, conversationId]);
}

/**
 * Get all conversations for a user with last message preview and unread count.
 */
function getConversations(userId) {
    return db.all(`
        SELECT
            c.id,
            c.name,
            c.is_group,
            c.updated_at,
            (SELECT dm.message FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_message,
            (SELECT dm.sender_id FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_sender_id,
            (SELECT dm.created_at FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_message_at,
            (SELECT COUNT(*) FROM dm_messages dm WHERE dm.conversation_id = c.id AND dm.created_at > p.last_read_at AND dm.sender_id != ?) AS unread_count
        FROM dm_conversations c
        JOIN dm_participants p ON p.conversation_id = c.id AND p.user_id = ?
        ORDER BY
            COALESCE((SELECT dm.created_at FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1), c.created_at) DESC
    `, [userId, userId]);
}

/**
 * Get participants of a conversation (with user profile info).
 */
function getParticipants(conversationId) {
    return db.all(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM dm_participants p
        JOIN users u ON u.id = p.user_id
        WHERE p.conversation_id = ?
    `, [conversationId]);
}

/**
 * Get a single conversation by id (with participant info for the requesting user).
 */
function getConversation(conversationId) {
    return db.get(`SELECT * FROM dm_conversations WHERE id = ?`, [conversationId]) || null;
}

// ── Message helpers ──────────────────────────────────────────

/**
 * Send a message in a conversation. Returns the message row.
 */
function sendMessage(conversationId, senderId, text) {
    if (!text || !text.trim()) return null;
    const trimmed = text.trim().slice(0, 2000); // max 2000 chars
    const result = db.run(
        `INSERT INTO dm_messages (conversation_id, sender_id, message) VALUES (?, ?, ?)`,
        [conversationId, senderId, trimmed]
    );
    // Touch conversation updated_at
    db.run(`UPDATE dm_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [conversationId]);
    // Auto-mark read for sender
    markRead(conversationId, senderId);
    return db.get(`SELECT * FROM dm_messages WHERE id = ?`, [result.lastInsertRowid]);
}

/**
 * Get messages in a conversation (paginated, newest first).
 */
function getMessages(conversationId, limit = 50, before = null) {
    if (before) {
        return db.all(`
            SELECT m.*, u.username, u.display_name, u.avatar_url, u.profile_color
            FROM dm_messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = ? AND m.id < ?
            ORDER BY m.created_at DESC
            LIMIT ?
        `, [conversationId, before, limit]);
    }
    return db.all(`
        SELECT m.*, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM dm_messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
    `, [conversationId, limit]);
}

/**
 * Mark a conversation as read for a user (set last_read_at to now).
 */
function markRead(conversationId, userId) {
    db.run(
        `UPDATE dm_participants SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND user_id = ?`,
        [conversationId, userId]
    );
}

/**
 * Get total unread message count across all conversations for a user.
 */
function getTotalUnread(userId) {
    const row = db.get(`
        SELECT COALESCE(SUM(unread), 0) as total FROM (
            SELECT COUNT(*) as unread
            FROM dm_messages m
            JOIN dm_participants p ON p.conversation_id = m.conversation_id AND p.user_id = ?
            WHERE m.created_at > p.last_read_at AND m.sender_id != ?
        )
    `, [userId, userId]);
    return row?.total || 0;
}

/**
 * Search users by username/display_name for the "new message" user picker.
 * Excludes the requesting user.
 */
function searchUsers(query, excludeUserId, limit = 10) {
    if (!query || query.length < 1) return [];
    return db.all(`
        SELECT id, username, display_name, avatar_url, profile_color
        FROM users
        WHERE id != ? AND is_banned = 0
          AND (username LIKE ? COLLATE NOCASE OR display_name LIKE ? COLLATE NOCASE)
        LIMIT ?
    `, [excludeUserId, `%${query}%`, `%${query}%`, limit]);
}

module.exports = {
    ensureTables,
    findDirectConversation,
    createConversation,
    getOrCreateDirect,
    addParticipant,
    removeParticipant,
    isParticipant,
    renameConversation,
    getConversations,
    getParticipants,
    getConversation,
    sendMessage,
    getMessages,
    markRead,
    getTotalUnread,
    searchUsers,
};
