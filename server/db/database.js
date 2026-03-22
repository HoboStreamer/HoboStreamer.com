/**
 * HoboStreamer — Database Connection & Helpers
 * SQLite3 via better-sqlite3
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || './data/hobostreamer.db';
const dbDir = path.dirname(path.resolve(DB_PATH));

// Ensure data directory exists
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function getDb() {
    if (!db) {
        db = new Database(path.resolve(DB_PATH));
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.pragma('busy_timeout = 5000');
    }
    return db;
}

function initDb() {
    const database = getDb();
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    database.exec(schema);

    // ── Migrations ────────────────────────────────────────────
    try {
        const cols = database.prepare("PRAGMA table_info('channels')").all().map(c => c.name);
        if (!cols.includes('emote_sources')) {
            database.exec(`ALTER TABLE channels ADD COLUMN emote_sources TEXT DEFAULT '{"defaults":true,"custom":true,"ffz":true,"bttv":true,"7tv":true}'`);
            console.log('[DB] Added emote_sources column to channels');
        }
    } catch (e) { console.warn('[DB] Migration note:', e.message); }

    // Migrate camp_funds_balance → hobo_bucks_balance (REAL for dollar amounts)
    try {
        const userCols = database.prepare("PRAGMA table_info('users')").all().map(c => c.name);
        if (userCols.includes('camp_funds_balance') && !userCols.includes('hobo_bucks_balance')) {
            database.exec(`ALTER TABLE users ADD COLUMN hobo_bucks_balance REAL DEFAULT 0.00`);
            // Convert old bits to dollars (100 bits → $1.00)
            database.exec(`UPDATE users SET hobo_bucks_balance = camp_funds_balance * 0.01`);
            console.log('[DB] Migrated camp_funds_balance → hobo_bucks_balance');
        }
        if (!userCols.includes('hobo_coins_balance')) {
            database.exec(`ALTER TABLE users ADD COLUMN hobo_coins_balance INTEGER DEFAULT 0`);
            console.log('[DB] Added hobo_coins_balance column to users');
        }
        if (!userCols.includes('token_valid_after')) {
            database.exec(`ALTER TABLE users ADD COLUMN token_valid_after TEXT DEFAULT NULL`);
            console.log('[DB] Added token_valid_after column to users');
        }
    } catch (e) { console.warn('[DB] Migration note:', e.message); }

    // Migrate: create site_settings table if missing (old DB)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS site_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            description TEXT DEFAULT '',
            type TEXT DEFAULT 'string' CHECK(type IN ('string', 'number', 'boolean', 'json')),
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (e) { console.warn('[DB] site_settings migration:', e.message); }

    // Migrate: create verification_keys table if missing (old DB)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS verification_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT UNIQUE NOT NULL,
            target_username TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_by INTEGER NOT NULL,
            used_by INTEGER,
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'used', 'revoked')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            used_at DATETIME,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_vkeys_key ON verification_keys(key)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_vkeys_target ON verification_keys(target_username)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_vkeys_status ON verification_keys(status)`);
    } catch (e) { console.warn('[DB] verification_keys migration:', e.message); }

    // Migrate: create linked_accounts table for hobo.tools SSO
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS linked_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            service TEXT NOT NULL,
            service_user_id TEXT NOT NULL,
            service_username TEXT,
            linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(service, service_user_id)
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_linked_service ON linked_accounts(service, service_user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_linked_user ON linked_accounts(user_id)`);
    } catch (e) { console.warn('[DB] linked_accounts migration:', e.message); }

    // Migrate: make chat_messages.stream_id nullable (was NOT NULL, broke global chat saves)
    try {
        const cmCols = database.prepare("PRAGMA table_info('chat_messages')").all();
        const streamIdCol = cmCols.find(c => c.name === 'stream_id');
        if (streamIdCol && streamIdCol.notnull === 1) {
            database.exec(`
                CREATE TABLE chat_messages_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    stream_id INTEGER,
                    user_id INTEGER,
                    anon_id TEXT,
                    username TEXT,
                    message TEXT NOT NULL,
                    message_type TEXT DEFAULT 'chat' CHECK(message_type IN ('chat', 'system', 'donation', 'command', 'tts')),
                    is_global INTEGER DEFAULT 0,
                    is_deleted INTEGER DEFAULT 0,
                    is_filtered INTEGER DEFAULT 0,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
                );
                INSERT INTO chat_messages_new SELECT * FROM chat_messages;
                DROP TABLE chat_messages;
                ALTER TABLE chat_messages_new RENAME TO chat_messages;
                CREATE INDEX IF NOT EXISTS idx_chat_stream ON chat_messages(stream_id);
                CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id);
                CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
            `);
            console.log('[DB] Migrated chat_messages.stream_id to nullable');
        }
    } catch (e) { console.warn('[DB] chat_messages migration:', e.message); }

    // Migrate: add reply_to_id column to chat_messages for threaded replies
    try {
        const cmCols2 = database.prepare("PRAGMA table_info('chat_messages')").all().map(c => c.name);
        if (!cmCols2.includes('reply_to_id')) {
            database.exec(`ALTER TABLE chat_messages ADD COLUMN reply_to_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL`);
            console.log('[DB] Added reply_to_id column to chat_messages');
        }
    } catch (e) { console.warn('[DB] chat_messages reply_to_id migration:', e.message); }

    // Migrate: add default_vod_visibility / default_clip_visibility to channels
    try {
        const chanCols = database.prepare("PRAGMA table_info('channels')").all().map(c => c.name);
        if (!chanCols.includes('default_vod_visibility')) {
            database.exec(`ALTER TABLE channels ADD COLUMN default_vod_visibility TEXT DEFAULT 'public'`);
            console.log('[DB] Added default_vod_visibility column to channels');
        }
        if (!chanCols.includes('default_clip_visibility')) {
            database.exec(`ALTER TABLE channels ADD COLUMN default_clip_visibility TEXT DEFAULT 'public'`);
            console.log('[DB] Added default_clip_visibility column to channels');
        }
    } catch (e) { console.warn('[DB] Channel visibility migration:', e.message); }

    // Migrate: add weather_zip / weather_detail to channels
    try {
        const wCols = database.prepare("PRAGMA table_info('channels')").all().map(c => c.name);
        if (!wCols.includes('weather_zip')) {
            database.exec(`ALTER TABLE channels ADD COLUMN weather_zip TEXT DEFAULT NULL`);
            console.log('[DB] Added weather_zip column to channels');
        }
        if (!wCols.includes('weather_detail')) {
            database.exec(`ALTER TABLE channels ADD COLUMN weather_detail TEXT DEFAULT 'basic'`);
            console.log('[DB] Added weather_detail column to channels');
        }
        if (!wCols.includes('weather_show_location')) {
            database.exec(`ALTER TABLE channels ADD COLUMN weather_show_location INTEGER DEFAULT 0`);
            console.log('[DB] Added weather_show_location column to channels');
        }
    } catch (e) { console.warn('[DB] Channel weather migration:', e.message); }

    // Migrate: create RobotStreamer integration table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS robotstreamer_integrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            enabled INTEGER DEFAULT 0,
            mirror_chat INTEGER DEFAULT 1,
            token TEXT,
            robot_id TEXT,
            owner_id TEXT,
            chat_url TEXT,
            control_url TEXT,
            rtc_sfu_url TEXT,
            stream_name TEXT,
            owner_name TEXT,
            last_validated_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
    } catch (e) { console.warn('[DB] RobotStreamer integration migration:', e.message); }

    // Migrate: create restream_destinations table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS restream_destinations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            platform TEXT NOT NULL CHECK(platform IN ('youtube', 'twitch', 'kick', 'custom')),
            name TEXT,
            server_url TEXT,
            stream_key TEXT,
            enabled INTEGER DEFAULT 1,
            auto_start INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
    } catch (e) { console.warn('[DB] Restream destinations migration:', e.message); }

    // Migrate: add quality_preset column to restream_destinations
    try {
        const cols = database.pragma('table_info(restream_destinations)').map(c => c.name);
        if (!cols.includes('quality_preset')) {
            database.exec(`ALTER TABLE restream_destinations ADD COLUMN quality_preset TEXT DEFAULT 'auto'`);
            console.log('[DB] Added quality_preset column to restream_destinations');
        }
    } catch (e) { console.warn('[DB] Restream quality_preset migration:', e.message); }

    // Migrate: add custom encoding override columns to restream_destinations
    try {
        const cols = database.pragma('table_info(restream_destinations)').map(c => c.name);
        const newCols = [
            { name: 'custom_video_bitrate', def: 'INTEGER DEFAULT NULL' },
            { name: 'custom_audio_bitrate', def: 'INTEGER DEFAULT NULL' },
            { name: 'custom_fps', def: 'INTEGER DEFAULT NULL' },
            { name: 'custom_encoder_preset', def: 'TEXT DEFAULT NULL' },
        ];
        for (const col of newCols) {
            if (!cols.includes(col.name)) {
                database.exec(`ALTER TABLE restream_destinations ADD COLUMN ${col.name} ${col.def}`);
                console.log(`[DB] Added ${col.name} column to restream_destinations`);
            }
        }
    } catch (e) { console.warn('[DB] Restream custom overrides migration:', e.message); }

    // Migrate: add channel_url and chat_relay columns to restream_destinations
    try {
        const cols = database.pragma('table_info(restream_destinations)').map(c => c.name);
        const newCols = [
            { name: 'channel_url', def: 'TEXT DEFAULT NULL' },
            { name: 'chat_relay', def: 'INTEGER DEFAULT 0' },
        ];
        for (const col of newCols) {
            if (!cols.includes(col.name)) {
                database.exec(`ALTER TABLE restream_destinations ADD COLUMN ${col.name} ${col.def}`);
                console.log(`[DB] Added ${col.name} column to restream_destinations`);
            }
        }
    } catch (e) { console.warn('[DB] Restream channel_url/chat_relay migration:', e.message); }

    // Migrate: create comments table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_type TEXT NOT NULL CHECK(content_type IN ('vod', 'clip')),
            content_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            parent_id INTEGER,
            message TEXT NOT NULL,
            is_deleted INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_comments_content ON comments(content_type, content_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)`);
    } catch (e) { console.warn('[DB] Comments migration:', e.message); }

    // Migrate: create media request tables if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS media_request_settings (
            user_id INTEGER PRIMARY KEY,
            enabled INTEGER DEFAULT 1,
            request_cost INTEGER DEFAULT 25,
            max_per_user INTEGER DEFAULT 3,
            max_duration_seconds INTEGER DEFAULT 600,
            allow_youtube INTEGER DEFAULT 1,
            allow_vimeo INTEGER DEFAULT 1,
            allow_direct_media INTEGER DEFAULT 1,
            auto_advance INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec(`CREATE TABLE IF NOT EXISTS media_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            streamer_id INTEGER NOT NULL,
            stream_id INTEGER,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            input TEXT NOT NULL,
            canonical_url TEXT NOT NULL,
            embed_url TEXT,
            provider TEXT NOT NULL CHECK(provider IN ('youtube', 'vimeo', 'audio', 'video')),
            title TEXT NOT NULL,
            thumbnail_url TEXT,
            duration_seconds INTEGER,
            cost INTEGER NOT NULL DEFAULT 25,
            queue_position INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'playing', 'played', 'skipped', 'removed', 'failed')),
            requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            started_at DATETIME,
            ended_at DATETIME,
            last_error TEXT,
            FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_media_requests_streamer_status ON media_requests(streamer_id, status, queue_position, requested_at)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_media_requests_user_status ON media_requests(user_id, status, requested_at)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_media_requests_canonical ON media_requests(streamer_id, canonical_url, status)');
    } catch (e) { console.warn('[DB] media requests migration:', e.message); }

    // Migrate: add new media columns for server-side downloading + pricing + playback state
    try {
        const mrCols = database.pragma('table_info(media_requests)').map(c => c.name);
        if (!mrCols.includes('stream_url'))             database.exec('ALTER TABLE media_requests ADD COLUMN stream_url TEXT');
        if (!mrCols.includes('download_status'))        database.exec("ALTER TABLE media_requests ADD COLUMN download_status TEXT DEFAULT 'none' CHECK(download_status IN ('none','extracting','downloading','ready','failed'))");
        if (!mrCols.includes('file_path'))              database.exec('ALTER TABLE media_requests ADD COLUMN file_path TEXT');
        if (!mrCols.includes('playback_position'))      database.exec('ALTER TABLE media_requests ADD COLUMN playback_position REAL DEFAULT 0');
        if (!mrCols.includes('refunded'))               database.exec('ALTER TABLE media_requests ADD COLUMN refunded INTEGER DEFAULT 0');

        const msCols = database.pragma('table_info(media_request_settings)').map(c => c.name);
        if (!msCols.includes('cost_mode'))              database.exec("ALTER TABLE media_request_settings ADD COLUMN cost_mode TEXT DEFAULT 'flat' CHECK(cost_mode IN ('flat','per_minute'))");
        if (!msCols.includes('cost_per_minute'))        database.exec('ALTER TABLE media_request_settings ADD COLUMN cost_per_minute INTEGER DEFAULT 5');
        if (!msCols.includes('allow_live'))             database.exec('ALTER TABLE media_request_settings ADD COLUMN allow_live INTEGER DEFAULT 0');
        if (!msCols.includes('download_mode'))          database.exec("ALTER TABLE media_request_settings ADD COLUMN download_mode TEXT DEFAULT 'stream' CHECK(download_mode IN ('stream','download'))");
    } catch (e) { console.warn('[DB] media columns migration:', e.message); }

    // Migrate: create anon IP mapping table for persistent anon numbering
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS anon_ip_mappings (
            ip TEXT PRIMARY KEY,
            anon_num INTEGER NOT NULL UNIQUE
        )`);
    } catch (e) { console.warn('[DB] anon_ip_mappings migration:', e.message); }

    // Seed default site settings if empty
    try {
        const settingsCount = database.prepare("SELECT COUNT(*) as c FROM site_settings").get().c;
        if (settingsCount === 0) {
            const defaults = [
                ['max_video_bitrate', '6000', 'Maximum video bitrate for streamers (kbps)', 'number'],
                ['max_audio_bitrate', '320', 'Maximum audio bitrate for streamers (kbps)', 'number'],
                ['max_vod_size_mb', '5120', 'Maximum VOD file size in MB', 'number'],
                ['max_clip_duration', '60', 'Maximum clip duration in seconds', 'number'],
                ['registration_open', 'true', 'Whether new user registration is open', 'boolean'],
                ['require_email', 'false', 'Require email for registration', 'boolean'],
                ['site_name', 'HoboStreamer', 'Public site name', 'string'],
                ['site_description', 'Live streaming for camp culture', 'Site description / tagline', 'string'],
                ['motd', '', 'Message of the day shown on homepage', 'string'],
                ['min_cashout_amount', '500', 'Minimum Hobo Bucks for cashout', 'number'],
                ['coins_per_minute', '10', 'Hobo Coins earned per minute watching', 'number'],
                ['chat_slowmode_seconds', '0', 'Global chat slow mode (0=off)', 'number'],
                ['max_emotes_per_user', '25', 'Max custom emotes per user', 'number'],
                ['nsfw_enabled', 'true', 'Allow NSFW streams', 'boolean'],
                // TTS settings
                ['tts_enabled', 'true', 'Enable site-wide TTS system', 'boolean'],
                ['tts_provider', 'espeak-ng', 'Default TTS provider (espeak-ng, google-cloud, amazon-polly)', 'string'],
                ['tts_google_api_key', '', 'Google Cloud TTS API key', 'string'],
                ['tts_google_service_account', '', 'Google Cloud service account JSON (paste full JSON or file path)', 'string'],
                ['tts_aws_access_key_id', '', 'Amazon Polly AWS Access Key ID', 'string'],
                ['tts_aws_secret_access_key', '', 'Amazon Polly AWS Secret Access Key', 'string'],
                ['tts_aws_region', 'us-east-1', 'Amazon Polly AWS Region', 'string'],
                ['tts_max_length', '200', 'Maximum TTS message length (characters)', 'number'],
                ['tts_max_queue_per_user', '3', 'Maximum queued TTS messages per user', 'number'],
                ['tts_max_queue_global', '20', 'Maximum global TTS queue size', 'number'],
                ['tts_default_voice', 'gary', 'Default TTS voice ID', 'string'],
            ];
            const insert = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
            for (const [k, v, d, t] of defaults) insert.run(k, v, d, t);
            console.log('[DB] Default site settings seeded');
        }
        // Always seed any NEW TTS settings that may be missing (for existing databases)
        const ttsSeeds = [
            ['tts_enabled', 'true', 'Enable site-wide TTS system', 'boolean'],
            ['tts_provider', 'espeak-ng', 'Default TTS provider (espeak-ng, google-cloud, amazon-polly)', 'string'],
            ['tts_google_api_key', '', 'Google Cloud TTS API key', 'string'],
            ['tts_google_service_account', '', 'Google Cloud service account JSON (paste full JSON or file path)', 'string'],
            ['tts_aws_access_key_id', '', 'Amazon Polly AWS Access Key ID', 'string'],
            ['tts_aws_secret_access_key', '', 'Amazon Polly AWS Secret Access Key', 'string'],
            ['tts_aws_region', 'us-east-1', 'Amazon Polly AWS Region', 'string'],
            ['tts_max_length', '200', 'Maximum TTS message length (characters)', 'number'],
            ['tts_max_queue_per_user', '3', 'Maximum queued TTS messages per user', 'number'],
            ['tts_max_queue_global', '20', 'Maximum global TTS queue size', 'number'],
            ['tts_default_voice', 'gary', 'Default TTS voice ID', 'string'],
        ];
        const seedInsert = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of ttsSeeds) seedInsert.run(k, v, d, t);

        // Seed Twitch API settings (for Helix viewer count polling)
        const twitchSeeds = [
            ['twitch_client_id', '', 'Twitch API Client ID (from dev.twitch.tv, used for viewer counts)', 'string'],
            ['twitch_client_secret', '', 'Twitch API Client Secret (from dev.twitch.tv)', 'string'],
        ];
        const seedTwitch = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of twitchSeeds) seedTwitch.run(k, v, d, t);

        // Seed Kick viewer-count settings
        const kickViewerSeeds = [
            ['kick_viewer_count_mode', 'auto', 'Kick viewer-count mode: auto, server, browser, or disabled', 'string'],
            ['kick_viewer_count_api_url_template', 'https://kick.com/api/v2/channels/{slug}', 'Kick viewer-count API/proxy URL template. Use {slug} for the channel slug.', 'string'],
            ['kick_viewer_count_json_path', 'livestream.viewer_count', 'Dot-path to the viewer count in the Kick API/proxy JSON response', 'string'],
            ['kick_viewer_count_headers_json', '{"Accept":"application/json"}', 'Optional JSON object of HTTP headers for Kick viewer-count requests', 'string'],
            ['kick_viewer_count_user_agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'Optional User-Agent header for server-side Kick viewer-count requests', 'string'],
        ];
        const seedKickViewer = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of kickViewerSeeds) seedKickViewer.run(k, v, d, t);
    } catch (e) { console.warn('[DB] Settings seed:', e.message); }

    // Migrate: expand role CHECK to include global_mod, migrate 'mod' → 'global_mod'
    try {
        // SQLite cannot ALTER CHECK constraints, but we can migrate data.
        // The schema.sql already has the new CHECK for fresh DBs.
        // For existing DBs, just migrate any 'mod' users to 'global_mod'.
        const modCount = database.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'mod'").get().c;
        if (modCount > 0) {
            database.exec("UPDATE users SET role = 'global_mod' WHERE role = 'mod'");
            console.log(`[DB] Migrated ${modCount} mod(s) → global_mod`);
        }
    } catch (e) { console.warn('[DB] Role migration:', e.message); }

    // Migrate: create channel_moderators table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS channel_moderators (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            added_by INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(channel_id, user_id),
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_channel_mods_channel ON channel_moderators(channel_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_channel_mods_user ON channel_moderators(user_id)`);
    } catch (e) { console.warn('[DB] channel_moderators migration:', e.message); }

    // Migrate: create channel_moderation_settings table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS channel_moderation_settings (
            channel_id INTEGER PRIMARY KEY,
            slow_mode_seconds INTEGER DEFAULT 0,
            followers_only INTEGER DEFAULT 0,
            emote_only INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
        )`);
    } catch (e) { console.warn('[DB] channel_moderation_settings migration:', e.message); }

    // Migrate: add extended channel moderation settings columns
    try {
        const cols = database.pragma('table_info(channel_moderation_settings)').map(c => c.name);
        if (!cols.includes('allow_anonymous')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN allow_anonymous INTEGER DEFAULT 1');
        if (!cols.includes('links_allowed')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN links_allowed INTEGER DEFAULT 1');
        if (!cols.includes('account_age_gate_hours')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN account_age_gate_hours INTEGER DEFAULT 0');
        if (!cols.includes('caps_percentage_limit')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN caps_percentage_limit INTEGER DEFAULT 0');
        if (!cols.includes('aggressive_filter')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN aggressive_filter INTEGER DEFAULT 0');
        if (!cols.includes('max_message_length')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN max_message_length INTEGER DEFAULT 500');
    } catch (e) { console.warn('[DB] channel_moderation_settings columns migration:', e.message); }

    // Migrate: create moderation_actions table for audit logging
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS moderation_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_type TEXT NOT NULL DEFAULT 'site',
            scope_id INTEGER,
            actor_user_id INTEGER,
            target_user_id INTEGER,
            action_type TEXT NOT NULL,
            details TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_mod_actions_created ON moderation_actions(created_at DESC)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_mod_actions_actor ON moderation_actions(actor_user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_mod_actions_scope ON moderation_actions(scope_type, scope_id)`);
    } catch (e) { console.warn('[DB] moderation_actions migration:', e.message); }

    // Migrate: create pastes table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS pastes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            user_id INTEGER,
            type TEXT DEFAULT 'paste' CHECK(type IN ('paste', 'screenshot')),
            title TEXT NOT NULL DEFAULT 'Untitled',
            content TEXT,
            language TEXT DEFAULT 'text',
            visibility TEXT DEFAULT 'public' CHECK(visibility IN ('public', 'unlisted')),
            stream_id INTEGER,
            screenshot_path TEXT,
            metadata TEXT,
            burn_after_read INTEGER DEFAULT 0,
            forked_from INTEGER,
            pinned INTEGER DEFAULT 0,
            views INTEGER DEFAULT 0,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
            FOREIGN KEY (forked_from) REFERENCES pastes(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_slug ON pastes(slug)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_user ON pastes(user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_visibility ON pastes(visibility)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_type ON pastes(type)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_created ON pastes(created_at)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_pinned ON pastes(pinned)`);
    } catch (e) { console.warn('[DB] pastes migration:', e.message); }

    // Migrate: add copies + likes columns to pastes, create paste_likes table
    try {
        const cols = database.prepare("PRAGMA table_info(pastes)").all().map(c => c.name);
        if (!cols.includes('copies'))  database.exec("ALTER TABLE pastes ADD COLUMN copies INTEGER DEFAULT 0");
        if (!cols.includes('likes'))   database.exec("ALTER TABLE pastes ADD COLUMN likes INTEGER DEFAULT 0");

        database.exec(`CREATE TABLE IF NOT EXISTS paste_likes (
            paste_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (paste_id, user_id),
            FOREIGN KEY (paste_id) REFERENCES pastes(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
    } catch (e) { console.warn('[DB] paste_likes migration:', e.message); }

    // Seed paste-related site settings
    try {
        const pasteSettings = [
            ['paste_max_size_kb', '512', 'Maximum paste content size in KB', 'number'],
            ['paste_screenshot_max_size_mb', '8', 'Maximum screenshot upload size in MB', 'number'],
            ['paste_cooldown_seconds', '30', 'Cooldown between paste submissions in seconds', 'number'],
            ['paste_max_per_user_per_day', '50', 'Maximum pastes per user per day (0 = unlimited)', 'number'],
            ['paste_anon_allowed', 'true', 'Allow anonymous paste creation', 'boolean'],
            ['paste_image_upload_enabled', 'true', 'Allow image uploads in pastes', 'boolean'],
        ];
        const seedPaste = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of pasteSettings) seedPaste.run(k, v, d, t);
    } catch (e) { console.warn('[DB] paste settings seed:', e.message); }

    // Migrate: paste_comments table (separate from vod/clip comments — supports anon)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS paste_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paste_id INTEGER NOT NULL,
            user_id INTEGER,
            parent_id INTEGER,
            anon_name TEXT,
            message TEXT NOT NULL,
            ip_address TEXT,
            is_deleted INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (paste_id) REFERENCES pastes(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (parent_id) REFERENCES paste_comments(id) ON DELETE CASCADE
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_paste_comments_paste ON paste_comments(paste_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_paste_comments_user ON paste_comments(user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_paste_comments_parent ON paste_comments(parent_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_paste_comments_ip ON paste_comments(ip_address)`);

        // Seed paste comment settings
        const commentSettings = [
            ['paste_comment_cooldown_seconds', '10', 'Cooldown between paste comments in seconds', 'number'],
            ['paste_comment_max_length', '2000', 'Maximum paste comment length in characters', 'number'],
            ['paste_comment_anon_allowed', 'true', 'Allow anonymous comments on pastes', 'boolean'],
        ];
        const seedComment = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of commentSettings) seedComment.run(k, v, d, t);
    } catch (e) { console.warn('[DB] paste_comments migration:', e.message); }

    // Migrate: stream_first_chats — tracks first-time chatters per streamer (for welcome messages)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS stream_first_chats (
            chatter_key TEXT NOT NULL,
            channel_user_id INTEGER NOT NULL,
            first_chat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (chatter_key, channel_user_id)
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_sfc_channel ON stream_first_chats(channel_user_id)`);
    } catch (e) { console.warn('[DB] stream_first_chats migration:', e.message); }

    // Migrate: ip_log — tracks IP addresses used by users and anons
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS ip_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            anon_id TEXT,
            ip_address TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT 'chat',
            geo_country TEXT,
            geo_region TEXT,
            geo_city TEXT,
            geo_isp TEXT,
            geo_org TEXT,
            geo_ll TEXT,
            user_agent TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_ip_log_user ON ip_log(user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_ip_log_ip ON ip_log(ip_address)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_ip_log_created ON ip_log(created_at)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_ip_log_action ON ip_log(action)`);
    } catch (e) { console.warn('[DB] ip_log migration:', e.message); }

    console.log('[DB] Schema initialized');
    return database;
}

// ── Generic helpers ──────────────────────────────────────────

function run(sql, params = []) {
    return getDb().prepare(sql).run(...(Array.isArray(params) ? params : [params]));
}

function get(sql, params = []) {
    return getDb().prepare(sql).get(...(Array.isArray(params) ? params : [params]));
}

function all(sql, params = []) {
    return getDb().prepare(sql).all(...(Array.isArray(params) ? params : [params]));
}

// ── User helpers ─────────────────────────────────────────────

function getUserById(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
}

function getUserByUsername(username) {
    return get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username]);
}

function getUserByStreamKey(key) {
    return get('SELECT * FROM users WHERE stream_key = ?', [key]);
}

function createUser({ username, email, password_hash, display_name, stream_key }) {
    return run(
        `INSERT INTO users (username, email, password_hash, display_name, stream_key)
         VALUES (?, ?, ?, ?, ?)`,
        [username, email || null, password_hash, display_name || username, stream_key]
    );
}

function getOrCreateAnonGameUser(anonId) {
    const normalizedAnonId = String(anonId || 'anon0').trim().toLowerCase();
    const safeAnonKey = normalizedAnonId.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'anon0';
    const username = `__game_${safeAnonKey}`;

    let user = getUserByUsername(username);
    if (user) {
        if (user.display_name !== normalizedAnonId) {
            run('UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [normalizedAnonId, user.id]);
            user = getUserById(user.id);
        }
        return user;
    }

    const passwordHash = `!anon-game:${safeAnonKey}:${crypto.randomBytes(12).toString('hex')}`;
    run(
        `INSERT OR IGNORE INTO users (username, password_hash, display_name, role)
         VALUES (?, ?, ?, 'user')`,
        [username, passwordHash, normalizedAnonId]
    );

    return getUserByUsername(username);
}

// ── Stream helpers ───────────────────────────────────────────

function getLiveStreams() {
    return all(`
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM streams s
        JOIN users u ON s.user_id = u.id
        WHERE s.is_live = 1
        ORDER BY s.viewer_count DESC, s.started_at DESC
    `);
}

function getRecentStreams(limit = 20) {
    return all(`
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color,
               v.id AS vod_id, v.is_public AS vod_is_public, v.thumbnail_url AS vod_thumbnail_url,
               v.duration_seconds AS vod_duration
        FROM streams s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN vods v ON v.stream_id = s.id AND COALESCE(v.is_recording, 0) = 0
        WHERE s.is_live = 0 AND s.ended_at IS NOT NULL
        ORDER BY s.ended_at DESC
        LIMIT ?
    `, [limit]);
}

function getStreamById(id) {
    return get(`
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.stream_key
        FROM streams s
        JOIN users u ON s.user_id = u.id
        WHERE s.id = ?
    `, [id]);
}

function getStreamByUserId(userId) {
    return get(`
        SELECT * FROM streams WHERE user_id = ? AND is_live = 1
        ORDER BY started_at DESC LIMIT 1
    `, [userId]);
}

function getLiveStreamsByUserId(userId) {
    return all(`
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.stream_key
        FROM streams s
        JOIN users u ON s.user_id = u.id
        WHERE s.user_id = ? AND s.is_live = 1
        ORDER BY s.started_at DESC
    `, [userId]);
}

function getStreamsByUserId(userId, limit = 50) {
    return all(`
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM streams s
        JOIN users u ON s.user_id = u.id
        WHERE s.user_id = ?
        ORDER BY s.created_at DESC
        LIMIT ?
    `, [userId, limit]);
}

function createStream({ user_id, channel_id, title, description, category, protocol, is_nsfw, thumbnail_url }) {
    return run(
        `INSERT INTO streams (user_id, channel_id, title, description, category, protocol, is_nsfw, thumbnail_url, is_live, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
        [user_id, channel_id || null, title || 'Untitled Stream', description || '', category || 'irl', protocol || 'webrtc', is_nsfw ? 1 : 0, thumbnail_url || null]
    );
}

function endStream(streamId) {
    const stream = get('SELECT started_at FROM streams WHERE id = ?', [streamId]);
    if (!stream) return null;
    return run(
        `UPDATE streams SET is_live = 0, ended_at = CURRENT_TIMESTAMP,
         duration_seconds = CAST((julianday(CURRENT_TIMESTAMP) - julianday(started_at)) * 86400 AS INTEGER)
         WHERE id = ?`,
        [streamId]
    );
}

function updateViewerCount(streamId, count) {
    run(`UPDATE streams SET viewer_count = ?, peak_viewers = MAX(peak_viewers, ?) WHERE id = ?`,
        [count, count, streamId]);
}

// ── Channel helpers ──────────────────────────────────────────

function getChannelByUserId(userId) {
    return get('SELECT * FROM channels WHERE user_id = ?', [userId]);
}

function getChannelByUsername(username) {
    return get(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.bio, u.stream_key
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE u.username = ? COLLATE NOCASE
    `, [username]);
}

function createChannel({ user_id, title, description, category, protocol }) {
    return run(
        `INSERT OR IGNORE INTO channels (user_id, title, description, category, protocol)
         VALUES (?, ?, ?, ?, ?)`,
        [user_id, title || 'Untitled Channel', description || '', category || 'irl', protocol || 'webrtc']
    );
}

function updateChannel(userId, fields) {
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(fields)) {
        if (val !== undefined && ['title', 'description', 'category', 'tags', 'protocol', 'is_nsfw', 'auto_record', 'offline_banner_url', 'panels', 'emote_sources', 'weather_zip', 'weather_detail', 'weather_show_location'].includes(key)) {
            updates.push(`${key} = ?`);
            params.push(['tags', 'panels', 'emote_sources'].includes(key) ? (typeof val === 'string' ? val : JSON.stringify(val)) : val);
        }
    }
    if (updates.length === 0) return;
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId);
    return run(`UPDATE channels SET ${updates.join(', ')} WHERE user_id = ?`, params);
}

function ensureChannel(userId) {
    let ch = getChannelByUserId(userId);
    if (!ch) {
        const user = getUserById(userId);
        createChannel({ user_id: userId, title: `${user?.display_name || user?.username}'s Channel` });
        ch = getChannelByUserId(userId);
    }
    return ch;
}

// ── RobotStreamer integration helpers ───────────────────────

function getRobotStreamerIntegrationByUserId(userId) {
    return get('SELECT * FROM robotstreamer_integrations WHERE user_id = ?', [userId]);
}

function upsertRobotStreamerIntegration(userId, fields) {
    const allowed = new Set([
        'enabled',
        'mirror_chat',
        'token',
        'robot_id',
        'owner_id',
        'chat_url',
        'control_url',
        'rtc_sfu_url',
        'stream_name',
        'owner_name',
        'last_validated_at',
    ]);
    const existing = getRobotStreamerIntegrationByUserId(userId);
    const filtered = Object.entries(fields || {}).filter(([key, val]) => allowed.has(key) && val !== undefined);

    if (!filtered.length) return existing;

    if (existing) {
        const updates = [];
        const params = [];
        for (const [key, val] of filtered) {
            updates.push(`${key} = ?`);
            params.push(val);
        }
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(userId);
        run(`UPDATE robotstreamer_integrations SET ${updates.join(', ')} WHERE user_id = ?`, params);
    } else {
        const keys = ['user_id', ...filtered.map(([key]) => key), 'updated_at'];
        const placeholders = keys.map(() => '?').join(', ');
        const params = [userId, ...filtered.map(([, val]) => val), new Date().toISOString()];
        run(
            `INSERT INTO robotstreamer_integrations (${keys.join(', ')}) VALUES (${placeholders})`,
            params,
        );
    }

    return getRobotStreamerIntegrationByUserId(userId);
}

// ── Restream Destination helpers ─────────────────────────────

function getRestreamDestinationsByUserId(userId) {
    return all('SELECT * FROM restream_destinations WHERE user_id = ? ORDER BY created_at', [userId]);
}

function getRestreamDestinationById(id) {
    return get('SELECT * FROM restream_destinations WHERE id = ?', [id]);
}

function createRestreamDestination(userId, fields) {
    const result = run(
        `INSERT INTO restream_destinations (user_id, platform, name, server_url, stream_key, enabled, auto_start, quality_preset,
         custom_video_bitrate, custom_audio_bitrate, custom_fps, custom_encoder_preset, channel_url, chat_relay)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, fields.platform, fields.name || null, fields.server_url || null,
         fields.stream_key || null, fields.enabled ?? 1, fields.auto_start ?? 0,
         fields.quality_preset || 'auto',
         fields.custom_video_bitrate ?? null, fields.custom_audio_bitrate ?? null,
         fields.custom_fps ?? null, fields.custom_encoder_preset || null,
         fields.channel_url || null, fields.chat_relay ? 1 : 0]
    );
    return get('SELECT * FROM restream_destinations WHERE id = ?', [result.lastInsertRowid]);
}

function updateRestreamDestination(id, fields) {
    const allowed = new Set(['name', 'server_url', 'stream_key', 'enabled', 'auto_start', 'quality_preset',
        'custom_video_bitrate', 'custom_audio_bitrate', 'custom_fps', 'custom_encoder_preset',
        'channel_url', 'chat_relay']);
    const filtered = Object.entries(fields || {}).filter(([key]) => allowed.has(key));
    if (!filtered.length) return getRestreamDestinationById(id);

    const updates = filtered.map(([key]) => `${key} = ?`);
    updates.push('updated_at = CURRENT_TIMESTAMP');
    const params = [...filtered.map(([, val]) => val), id];

    run(`UPDATE restream_destinations SET ${updates.join(', ')} WHERE id = ?`, params);
    return getRestreamDestinationById(id);
}

function deleteRestreamDestination(id) {
    return run('DELETE FROM restream_destinations WHERE id = ?', [id]);
}

// ── Chat helpers ─────────────────────────────────────────────

function saveChatMessage({ stream_id, user_id, anon_id, username, message, message_type, is_global, reply_to_id }) {
    return run(
        `INSERT INTO chat_messages (stream_id, user_id, anon_id, username, message, message_type, is_global, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [stream_id, user_id || null, anon_id || null, username, message, message_type || 'chat', is_global ? 1 : 0, reply_to_id || null]
    );
}

function searchChatMessages({ query, userId, streamId, limit = 50, offset = 0 }) {
    let sql = `SELECT cm.*, u.display_name, u.role, u.avatar_url, u.profile_color
               FROM chat_messages cm
               LEFT JOIN users u ON cm.user_id = u.id
               WHERE cm.is_deleted = 0`;
    const params = [];

    if (query) {
        sql += ` AND cm.message LIKE ?`;
        params.push(`%${query}%`);
    }
    if (userId) {
        sql += ` AND cm.user_id = ?`;
        params.push(userId);
    }
    if (streamId) {
        sql += ` AND cm.stream_id = ?`;
        params.push(streamId);
    }

    const countSql = sql.replace(/SELECT cm\.\*.*FROM/, 'SELECT COUNT(*) as c FROM');
    const total = get(countSql, params)?.c || 0;

    sql += ` ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return { messages: all(sql, params), total };
}

function getUserChatHistory(userId, limit = 50, offset = 0) {
    const sql = `SELECT cm.*, s.title as stream_title
                 FROM chat_messages cm
                 LEFT JOIN streams s ON cm.stream_id = s.id
                 WHERE cm.user_id = ? AND cm.is_deleted = 0
                 ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
    const messages = all(sql, [userId, limit, offset]);
    const total = get('SELECT COUNT(*) as c FROM chat_messages WHERE user_id = ? AND is_deleted = 0', [userId])?.c || 0;
    return { messages, total };
}

function getUserProfile(userId) {
    const user = get(`SELECT id, username, display_name, avatar_url, profile_color, role,
                      hobo_bucks_balance, hobo_coins_balance, created_at, last_seen
                      FROM users WHERE id = ?`, [userId]);
    if (!user) return null;
    user.messageCount = get('SELECT COUNT(*) as c FROM chat_messages WHERE user_id = ? AND is_deleted = 0', [userId])?.c || 0;
    user.followerCount = get('SELECT COUNT(*) as c FROM follows WHERE streamer_id = ?', [userId])?.c || 0;
    user.followingCount = get('SELECT COUNT(*) as c FROM follows WHERE follower_id = ?', [userId])?.c || 0;
    return user;
}

function updateUserAvatar(userId, avatarUrl) {
    return run('UPDATE users SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [avatarUrl, userId]);
}

// ── Follow helpers ───────────────────────────────────────────

function followUser(followerId, streamerId) {
    return run(
        `INSERT OR IGNORE INTO follows (follower_id, streamer_id) VALUES (?, ?)`,
        [followerId, streamerId]
    );
}

function unfollowUser(followerId, streamerId) {
    return run(`DELETE FROM follows WHERE follower_id = ? AND streamer_id = ?`,
        [followerId, streamerId]);
}

function getFollowerCount(streamerId) {
    const row = get('SELECT COUNT(*) as count FROM follows WHERE streamer_id = ?', [streamerId]);
    return row ? row.count : 0;
}

function isFollowing(followerId, streamerId) {
    const row = get('SELECT id FROM follows WHERE follower_id = ? AND streamer_id = ?',
        [followerId, streamerId]);
    return !!row;
}

function getFollowerIds(streamerId) {
    return all('SELECT follower_id FROM follows WHERE streamer_id = ?', [streamerId])
        .map(r => r.follower_id);
}

// ── Transaction helpers ──────────────────────────────────────

function createTransaction({ from_user_id, to_user_id, stream_id, amount, type, status, message }) {
    return run(
        `INSERT INTO transactions (from_user_id, to_user_id, stream_id, amount, type, status, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [from_user_id || null, to_user_id || null, stream_id || null, amount, type, status || 'completed', message || null]
    );
}

function addHoboBucks(userId, amount) {
    return run(`UPDATE users SET hobo_bucks_balance = hobo_bucks_balance + ? WHERE id = ?`,
        [amount, userId]);
}

function deductHoboBucks(userId, amount) {
    const user = getUserById(userId);
    if (!user || user.hobo_bucks_balance < amount) return false;
    run(`UPDATE users SET hobo_bucks_balance = hobo_bucks_balance - ? WHERE id = ?`,
        [amount, userId]);
    return true;
}

// ── VOD helpers ──────────────────────────────────────────────

function createVod({ stream_id, user_id, title, description, file_path, file_size, duration_seconds, thumbnail_url }) {
    return run(
        `INSERT INTO vods (stream_id, user_id, title, description, file_path, file_size, duration_seconds, thumbnail_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [stream_id || null, user_id, title, description || '', file_path, file_size || 0, duration_seconds || 0, thumbnail_url || null]
    );
}

function getVodById(id) {
    return get(`
        SELECT v.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.protocol AS stream_protocol
        FROM vods v
        JOIN users u ON v.user_id = u.id
        LEFT JOIN streams s ON v.stream_id = s.id
        WHERE v.id = ?
    `, [id]);
}

function getVodsByUser(userId, includePrivate = false) {
    const clause = includePrivate ? '' : ' AND is_public = 1';
    return all(`
        SELECT v.*, u.username, u.display_name, u.avatar_url,
               s.protocol AS stream_protocol
        FROM vods v JOIN users u ON v.user_id = u.id
        LEFT JOIN streams s ON v.stream_id = s.id
        WHERE v.user_id = ?${clause} AND COALESCE(v.is_recording, 0) = 0
        ORDER BY v.created_at DESC
    `, [userId]);
}

function getPublicVods(limit = 50, offset = 0) {
    return all(`
        SELECT v.*, u.username, u.display_name, u.avatar_url,
               s.protocol AS stream_protocol
        FROM vods v JOIN users u ON v.user_id = u.id
        LEFT JOIN streams s ON v.stream_id = s.id
        WHERE v.is_public = 1 AND COALESCE(v.is_recording, 0) = 0
        ORDER BY v.created_at DESC
        LIMIT ? OFFSET ?
    `, [limit, offset]);
}

function getActiveVodByStream(streamId) {
    return get(`
        SELECT v.*, u.username, u.display_name, u.avatar_url
        FROM vods v JOIN users u ON v.user_id = u.id
        WHERE v.stream_id = ? AND v.is_recording = 1
        ORDER BY v.created_at DESC LIMIT 1
    `, [streamId]);
}

function getOrphanedRecordingVods() {
    return all(`
        SELECT v.* FROM vods v
        LEFT JOIN streams s ON v.stream_id = s.id
        WHERE v.is_recording = 1
          AND (s.id IS NULL OR s.is_live = 0)
    `);
}

// ── Clip helpers ─────────────────────────────────────────────

function createClip({ vod_id, stream_id, user_id, title, description, file_path, thumbnail_url, start_time, end_time, duration_seconds }) {
    return run(
        `INSERT INTO clips (vod_id, stream_id, user_id, title, description, file_path, thumbnail_url, start_time, end_time, duration_seconds, is_public)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [vod_id || null, stream_id || null, user_id, title || 'Untitled Clip', description || '', file_path || '', thumbnail_url || null, start_time || 0, end_time || 0, duration_seconds || 0]
    );
}

function getClipById(id) {
    return get(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        WHERE c.id = ?
    `, [id]);
}

function getClipsByUser(userId, includePrivate = false) {
    const publicFilter = includePrivate ? '' : 'AND c.is_public = 1';
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        WHERE c.user_id = ? ${publicFilter}
        ORDER BY c.created_at DESC
    `, [userId]);
}

function setClipPublic(clipId, isPublic) {
    return run('UPDATE clips SET is_public = ? WHERE id = ?', [isPublic ? 1 : 0, clipId]);
}

function getPublicClips(limit = 50, offset = 0) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        WHERE c.is_public = 1
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
    `, [limit, offset]);
}

function getClipsByStream(streamId) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        WHERE c.stream_id = ? AND c.is_public = 1
        ORDER BY c.created_at DESC
    `, [streamId]);
}

function getClipsOfUserStreams(userId) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        JOIN streams s ON c.stream_id = s.id
        WHERE s.user_id = ?
        ORDER BY c.created_at DESC
    `, [userId]);
}

function findDuplicateClip({ streamId = null, vodId = null, startTime = 0, endTime = 0, startWindow = 8, endWindow = 10, createdSinceMinutes = 10 }) {
    const filters = [];
    const params = [];

    if (streamId) {
        filters.push('c.stream_id = ?');
        params.push(streamId);
    }
    if (vodId) {
        filters.push('c.vod_id = ?');
        params.push(vodId);
    }
    if (!filters.length) return null;

    return get(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        WHERE (${filters.join(' OR ')})
          AND ABS(COALESCE(c.start_time, 0) - ?) <= ?
          AND ABS(COALESCE(c.end_time, 0) - ?) <= ?
          AND c.created_at >= datetime('now', ?)
        ORDER BY c.created_at DESC
        LIMIT 1
    `, [...params, startTime || 0, startWindow, endTime || 0, endWindow, `-${Math.max(1, createdSinceMinutes)} minutes`]);
}

// ── Control helpers ──────────────────────────────────────────

function getStreamControls(streamId) {
    return all('SELECT * FROM stream_controls WHERE stream_id = ? ORDER BY sort_order', [streamId]);
}

function createControl({ stream_id, label, command, icon, control_type, key_binding, cooldown_ms }) {
    return run(
        `INSERT INTO stream_controls (stream_id, label, command, icon, control_type, key_binding, cooldown_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [stream_id, label, command, icon || 'fa-gamepad', control_type || 'button', key_binding || null, cooldown_ms || 500]
    );
}

// ── API Key helpers ──────────────────────────────────────────

function createApiKey({ user_id, key_hash, label, permissions }) {
    return run(
        `INSERT INTO api_keys (user_id, key_hash, label, permissions)
         VALUES (?, ?, ?, ?)`,
        [user_id, key_hash, label || 'Default', JSON.stringify(permissions || ['control', 'stream'])]
    );
}

function getApiKeyByHash(hash) {
    return get('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1', [hash]);
}

// ── Ban helpers ──────────────────────────────────────────────

function isUserBanned(userId, streamId) {
    const ban = get(`
        SELECT * FROM bans
        WHERE user_id = ?
        AND (stream_id = ? OR stream_id IS NULL)
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        LIMIT 1
    `, [userId, streamId]);
    return !!ban;
}

function isIpBanned(ip, streamId) {
    const ban = get(`
        SELECT * FROM bans
        WHERE ip_address = ?
        AND (stream_id = ? OR stream_id IS NULL)
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        LIMIT 1
    `, [ip, streamId]);
    return !!ban;
}

// ── Cleanup ──────────────────────────────────────────────────

function close() {
    if (db) {
        db.close();
        db = null;
    }
}

// ── Site Settings helpers ────────────────────────────────────

function getSetting(key) {
    const row = get('SELECT * FROM site_settings WHERE key = ?', [key]);
    if (!row) return null;
    switch (row.type) {
        case 'number': return Number(row.value);
        case 'boolean': return row.value === 'true';
        case 'json': try { return JSON.parse(row.value); } catch { return row.value; }
        default: return row.value;
    }
}

function getSettingRow(key) {
    return get('SELECT * FROM site_settings WHERE key = ?', [key]);
}

function getAllSettings() {
    return all('SELECT * FROM site_settings ORDER BY key');
}

function setSetting(key, value) {
    const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const existing = get('SELECT key FROM site_settings WHERE key = ?', [key]);
    if (existing) {
        return run('UPDATE site_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?', [strVal, key]);
    }
    return run('INSERT INTO site_settings (key, value) VALUES (?, ?)', [key, strVal]);
}

function deleteSetting(key) {
    return run('DELETE FROM site_settings WHERE key = ?', [key]);
}

// ── Verification Key helpers ─────────────────────────────────

function createVerificationKey({ key, target_username, note, created_by }) {
    return run(
        `INSERT INTO verification_keys (key, target_username, note, created_by) VALUES (?, ?, ?, ?)`,
        [key, target_username, note || '', created_by]
    );
}

function getVerificationKeyByKey(key) {
    return get('SELECT * FROM verification_keys WHERE key = ?', [key]);
}

function getVerificationKeyByUsername(username) {
    return get("SELECT * FROM verification_keys WHERE target_username = ? COLLATE NOCASE AND status = 'active'", [username]);
}

function getAllVerificationKeys() {
    return all(`
        SELECT vk.*, u1.username as created_by_name, u2.username as used_by_name
        FROM verification_keys vk
        LEFT JOIN users u1 ON vk.created_by = u1.id
        LEFT JOIN users u2 ON vk.used_by = u2.id
        ORDER BY vk.created_at DESC
    `);
}

function redeemVerificationKey(key, userId) {
    return run(
        "UPDATE verification_keys SET status = 'used', used_by = ?, used_at = CURRENT_TIMESTAMP WHERE key = ? AND status = 'active'",
        [userId, key]
    );
}

function revokeVerificationKey(id) {
    return run("UPDATE verification_keys SET status = 'revoked' WHERE id = ? AND status = 'active'", [id]);
}

function isUsernameReserved(username) {
    const vk = get("SELECT id FROM verification_keys WHERE target_username = ? COLLATE NOCASE AND status = 'active'", [username]);
    return !!vk;
}

// ── Emote helpers ────────────────────────────────────────────

function createEmote({ user_id, code, url, animated = false, width = 28, height = 28, is_global = false }) {
    return run(
        `INSERT INTO emotes (user_id, code, url, animated, width, height, is_global)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [user_id, code, url, animated ? 1 : 0, width, height, is_global ? 1 : 0]
    );
}

function getEmoteById(id) {
    return get('SELECT e.*, u.username FROM emotes e JOIN users u ON e.user_id = u.id WHERE e.id = ?', [id]);
}

function getEmotesByUser(userId) {
    return all('SELECT * FROM emotes WHERE user_id = ? ORDER BY code', [userId]);
}

function getGlobalEmotes() {
    return all('SELECT e.*, u.username FROM emotes e JOIN users u ON e.user_id = u.id WHERE e.is_global = 1 AND e.is_approved = 1 ORDER BY code');
}

function getChannelEmotes(userId) {
    return all('SELECT e.*, u.username FROM emotes e JOIN users u ON e.user_id = u.id WHERE e.user_id = ? AND e.is_approved = 1 ORDER BY code', [userId]);
}

function deleteEmote(id) {
    return run('DELETE FROM emotes WHERE id = ?', [id]);
}

function getEmoteByCode(code, userId) {
    // Check channel emotes first, then global
    return get(
        `SELECT * FROM emotes WHERE code = ? AND (user_id = ? OR is_global = 1) AND is_approved = 1 ORDER BY is_global ASC LIMIT 1`,
        [code, userId]
    );
}

function countUserEmotes(userId) {
    const row = get('SELECT COUNT(*) as count FROM emotes WHERE user_id = ?', [userId]);
    return row ? row.count : 0;
}

// ── Hobo Coins helpers ───────────────────────────────────────

function addHoboCoins(userId, amount) {
    return run(`UPDATE users SET hobo_coins_balance = hobo_coins_balance + ? WHERE id = ?`,
        [amount, userId]);
}

function deductHoboCoins(userId, amount) {
    const user = getUserById(userId);
    if (!user || user.hobo_coins_balance < amount) return false;
    run(`UPDATE users SET hobo_coins_balance = hobo_coins_balance - ? WHERE id = ?`,
        [amount, userId]);
    return true;
}

function createCoinTransaction({ user_id, stream_id, amount, type, reward_id, message }) {
    return run(
        `INSERT INTO coin_transactions (user_id, stream_id, amount, type, reward_id, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [user_id, stream_id || null, amount, type, reward_id || null, message || null]
    );
}

function getCoinTransactions(userId, limit = 50) {
    return all(`SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        [userId, limit]);
}

// ── Coin Rewards helpers ─────────────────────────────────────

function createCoinReward({ streamer_id, title, description, cost, icon, color, cooldown_seconds, max_per_stream, requires_input, is_global, sort_order }) {
    return run(
        `INSERT INTO coin_rewards (streamer_id, title, description, cost, icon, color, cooldown_seconds, max_per_stream, requires_input, is_global, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [streamer_id, title, description || '', cost || 100, icon || 'fa-star', color || '#c0965c',
         cooldown_seconds || 0, max_per_stream || 0, requires_input ? 1 : 0, is_global ? 1 : 0, sort_order || 0]
    );
}

function getCoinRewardsByStreamer(streamerId) {
    return all('SELECT * FROM coin_rewards WHERE streamer_id = ? AND is_enabled = 1 ORDER BY sort_order, cost',
        [streamerId]);
}

function getCoinRewardById(id) {
    return get('SELECT * FROM coin_rewards WHERE id = ?', [id]);
}

function updateCoinReward(id, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = ?`);
        vals.push(v);
    }
    vals.push(id);
    return run(`UPDATE coin_rewards SET ${sets.join(', ')} WHERE id = ?`, vals);
}

function deleteCoinReward(id) {
    return run('DELETE FROM coin_rewards WHERE id = ?', [id]);
}

// ── Coin Redemptions helpers ─────────────────────────────────

function createCoinRedemption({ reward_id, user_id, stream_id, user_input }) {
    return run(
        `INSERT INTO coin_redemptions (reward_id, user_id, stream_id, user_input)
         VALUES (?, ?, ?, ?)`,
        [reward_id, user_id, stream_id || null, user_input || null]
    );
}

function getPendingRedemptions(streamerId) {
    return all(`
        SELECT r.*, cr.title as reward_title, cr.cost, cr.icon, cr.color,
               u.username, u.display_name, u.avatar_url
        FROM coin_redemptions r
        JOIN coin_rewards cr ON r.reward_id = cr.id
        JOIN users u ON r.user_id = u.id
        WHERE cr.streamer_id = ? AND r.status = 'pending'
        ORDER BY r.created_at ASC
    `, [streamerId]);
}

function resolveRedemption(id, status) {
    return run(`UPDATE coin_redemptions SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [status, id]);
}

// ── Watch Time helpers ───────────────────────────────────────

function upsertWatchTime(userId, streamId) {
    // Create or update watch time record
    const existing = get('SELECT * FROM watch_time WHERE user_id = ? AND stream_id = ?',
        [userId, streamId]);
    if (existing) {
        return run(
            `UPDATE watch_time SET minutes_watched = minutes_watched + 1, last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?`,
            [existing.id]
        );
    }
    return run(
        'INSERT INTO watch_time (user_id, stream_id, minutes_watched) VALUES (?, ?, 1)',
        [userId, streamId]
    );
}

function getWatchTime(userId, streamId) {
    return get('SELECT * FROM watch_time WHERE user_id = ? AND stream_id = ?',
        [userId, streamId]);
}

function getTotalWatchTime(userId) {
    const row = get('SELECT SUM(minutes_watched) as total FROM watch_time WHERE user_id = ?', [userId]);
    return row ? (row.total || 0) : 0;
}

// ── Media Request helpers ───────────────────────────────────

function getMediaRequestSettingsByUserId(userId) {
    return get('SELECT * FROM media_request_settings WHERE user_id = ?', [userId]);
}

function upsertMediaRequestSettings(userId, fields = {}) {
    const existing = getMediaRequestSettingsByUserId(userId);
    if (!existing) {
        run(`INSERT INTO media_request_settings (
            user_id, enabled, request_cost, max_per_user, max_duration_seconds,
            allow_youtube, allow_vimeo, allow_direct_media, auto_advance,
            cost_mode, cost_per_minute, allow_live, download_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            userId,
            fields.enabled ?? 1,
            fields.request_cost ?? 25,
            fields.max_per_user ?? 3,
            fields.max_duration_seconds ?? 600,
            fields.allow_youtube ?? 1,
            fields.allow_vimeo ?? 1,
            fields.allow_direct_media ?? 1,
            fields.auto_advance ?? 1,
            fields.cost_mode ?? 'flat',
            fields.cost_per_minute ?? 5,
            fields.allow_live ?? 0,
            fields.download_mode ?? 'stream',
        ]);
    } else if (Object.keys(fields).length) {
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            sets.push(`${k} = ?`);
            vals.push(v);
        }
        sets.push('updated_at = CURRENT_TIMESTAMP');
        vals.push(userId);
        run(`UPDATE media_request_settings SET ${sets.join(', ')} WHERE user_id = ?`, vals);
    }
    return getMediaRequestSettingsByUserId(userId);
}

function createMediaRequest({ streamer_id, stream_id, user_id, username, input, canonical_url, embed_url, provider, title, thumbnail_url, duration_seconds, cost, queue_position }) {
    return run(
        `INSERT INTO media_requests (
            streamer_id, stream_id, user_id, username, input, canonical_url, embed_url,
            provider, title, thumbnail_url, duration_seconds, cost, queue_position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            streamer_id,
            stream_id || null,
            user_id,
            username,
            input,
            canonical_url,
            embed_url || null,
            provider,
            title,
            thumbnail_url || null,
            duration_seconds ?? null,
            cost,
            queue_position ?? 0,
        ]
    );
}

function getMediaRequestById(id) {
    return get('SELECT * FROM media_requests WHERE id = ?', [id]);
}

function getMediaRequestByStreamerAndId(streamerId, id) {
    return get('SELECT * FROM media_requests WHERE streamer_id = ? AND id = ?', [streamerId, id]);
}

function getActiveMediaRequestByStreamer(streamerId) {
    return get(`SELECT * FROM media_requests WHERE streamer_id = ? AND status = 'playing' ORDER BY started_at DESC, id DESC LIMIT 1`, [streamerId]);
}

function getNextPendingMediaRequest(streamerId) {
    return get(`SELECT * FROM media_requests WHERE streamer_id = ? AND status = 'pending' ORDER BY queue_position ASC, requested_at ASC, id ASC LIMIT 1`, [streamerId]);
}

function getPendingMediaRequestsByStreamer(streamerId, limit = 50) {
    return all(`SELECT * FROM media_requests WHERE streamer_id = ? AND status = 'pending' ORDER BY queue_position ASC, requested_at ASC, id ASC LIMIT ?`, [streamerId, limit]);
}

function getRecentMediaRequestsByStreamer(streamerId, limit = 15) {
    return all(`SELECT * FROM media_requests WHERE streamer_id = ? AND status IN ('played', 'skipped', 'removed', 'failed') ORDER BY COALESCE(ended_at, requested_at) DESC, id DESC LIMIT ?`, [streamerId, limit]);
}

function countPendingMediaRequestsForUser(streamerId, userId) {
    const row = get(`SELECT COUNT(*) AS c FROM media_requests WHERE streamer_id = ? AND user_id = ? AND status IN ('pending', 'playing')`, [streamerId, userId]);
    return row?.c || 0;
}

function getMediaRequestMaxQueuePosition(streamerId) {
    const row = get(`SELECT MAX(queue_position) AS max_pos FROM media_requests WHERE streamer_id = ? AND status = 'pending'`, [streamerId]);
    return row?.max_pos || 0;
}

function findActiveMediaRequestByCanonicalUrl(streamerId, canonicalUrl) {
    return get(`SELECT * FROM media_requests WHERE streamer_id = ? AND canonical_url = ? AND status IN ('pending', 'playing') ORDER BY id DESC LIMIT 1`, [streamerId, canonicalUrl]);
}

function updateMediaRequest(id, fields = {}) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = ?`);
        vals.push(v);
    }
    if (!sets.length) return null;
    vals.push(id);
    return run(`UPDATE media_requests SET ${sets.join(', ')} WHERE id = ?`, vals);
}

function renormalizePendingMediaRequestPositions(streamerId) {
    const rows = all(`SELECT id FROM media_requests WHERE streamer_id = ? AND status = 'pending' ORDER BY queue_position ASC, requested_at ASC, id ASC`, [streamerId]);
    const tx = getDb().transaction((list) => {
        list.forEach((row, idx) => {
            run('UPDATE media_requests SET queue_position = ? WHERE id = ?', [idx + 1, row.id]);
        });
    });
    tx(rows);
}

// ── Comment helpers ──────────────────────────────────────────

function createComment({ content_type, content_id, user_id, parent_id, message }) {
    return run(
        `INSERT INTO comments (content_type, content_id, user_id, parent_id, message)
         VALUES (?, ?, ?, ?, ?)`,
        [content_type, content_id, user_id, parent_id || null, message]
    );
}

function getComments(contentType, contentId, limit = 50, offset = 0) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
        FROM comments c
        JOIN users u ON c.user_id = u.id
        WHERE c.content_type = ? AND c.content_id = ? AND c.is_deleted = 0 AND c.parent_id IS NULL
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
    `, [contentType, contentId, limit, offset]);
}

function getCommentReplies(parentId) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
        FROM comments c
        JOIN users u ON c.user_id = u.id
        WHERE c.parent_id = ? AND c.is_deleted = 0
        ORDER BY c.created_at ASC
    `, [parentId]);
}

function getCommentById(id) {
    return get('SELECT * FROM comments WHERE id = ?', [id]);
}

function getCommentCount(contentType, contentId) {
    const row = get('SELECT COUNT(*) as c FROM comments WHERE content_type = ? AND content_id = ? AND is_deleted = 0',
        [contentType, contentId]);
    return row ? row.c : 0;
}

function deleteComment(id) {
    return run('UPDATE comments SET is_deleted = 1 WHERE id = ?', [id]);
}

function updateComment(id, message) {
    return run('UPDATE comments SET message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [message, id]);
}

// ── Chat replay helpers ──────────────────────────────────────

function getChatReplay(streamId, fromTime, toTime) {
    let sql = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name
               FROM chat_messages cm
               LEFT JOIN users u ON cm.user_id = u.id
               WHERE cm.stream_id = ? AND cm.is_deleted = 0 AND cm.message_type = 'chat'`;
    const params = [streamId];
    if (fromTime) { sql += ` AND cm.timestamp >= ?`; params.push(fromTime); }
    if (toTime) { sql += ` AND cm.timestamp <= ?`; params.push(toTime); }
    sql += ` ORDER BY cm.timestamp ASC`;
    return all(sql, params);
}

// ── Channel lookup by ID ─────────────────────────────────────

function getChannelById(id) {
    return get('SELECT * FROM channels WHERE id = ?', [id]);
}

// ── Channel Moderators ───────────────────────────────────────

function isChannelModerator(userId, channelId) {
    const row = get('SELECT 1 FROM channel_moderators WHERE user_id = ? AND channel_id = ?', [userId, channelId]);
    return !!row;
}

function addChannelModerator(channelId, userId, addedBy) {
    return run(
        'INSERT OR IGNORE INTO channel_moderators (channel_id, user_id, added_by) VALUES (?, ?, ?)',
        [channelId, userId, addedBy]
    );
}

function removeChannelModerator(channelId, userId) {
    return run('DELETE FROM channel_moderators WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
}

function getChannelModerators(channelId) {
    return all(`
        SELECT cm.id, cm.user_id, cm.added_by, cm.created_at,
               u.username, u.display_name, u.avatar_url,
               a.username as added_by_username
        FROM channel_moderators cm
        JOIN users u ON cm.user_id = u.id
        LEFT JOIN users a ON cm.added_by = a.id
        WHERE cm.channel_id = ?
        ORDER BY cm.created_at ASC
    `, [channelId]);
}

function getChannelsByModerator(userId) {
    return all(`
        SELECT cm.channel_id, c.title, c.user_id, u.username as owner_username
        FROM channel_moderators cm
        JOIN channels c ON cm.channel_id = c.id
        JOIN users u ON c.user_id = u.id
        WHERE cm.user_id = ?
    `, [userId]);
}

// ── Channel Moderation Settings ──────────────────────────────

function getChannelModerationSettings(channelId) {
    return get('SELECT * FROM channel_moderation_settings WHERE channel_id = ?', [channelId])
        || { channel_id: channelId, slow_mode_seconds: 0, followers_only: 0, emote_only: 0 };
}

function upsertChannelModerationSettings(channelId, fields) {
    const existing = get('SELECT 1 FROM channel_moderation_settings WHERE channel_id = ?', [channelId]);
    if (existing) {
        const updates = [];
        const params = [];
        if (fields.slow_mode_seconds !== undefined) { updates.push('slow_mode_seconds = ?'); params.push(fields.slow_mode_seconds); }
        if (fields.followers_only !== undefined) { updates.push('followers_only = ?'); params.push(fields.followers_only ? 1 : 0); }
        if (fields.emote_only !== undefined) { updates.push('emote_only = ?'); params.push(fields.emote_only ? 1 : 0); }
        if (fields.allow_anonymous !== undefined) { updates.push('allow_anonymous = ?'); params.push(fields.allow_anonymous ? 1 : 0); }
        if (fields.links_allowed !== undefined) { updates.push('links_allowed = ?'); params.push(fields.links_allowed ? 1 : 0); }
        if (fields.account_age_gate_hours !== undefined) { updates.push('account_age_gate_hours = ?'); params.push(Number(fields.account_age_gate_hours) || 0); }
        if (fields.caps_percentage_limit !== undefined) { updates.push('caps_percentage_limit = ?'); params.push(Number(fields.caps_percentage_limit) || 0); }
        if (fields.aggressive_filter !== undefined) { updates.push('aggressive_filter = ?'); params.push(fields.aggressive_filter ? 1 : 0); }
        if (fields.max_message_length !== undefined) { updates.push('max_message_length = ?'); params.push(Math.max(50, Number(fields.max_message_length) || 500)); }
        if (updates.length > 0) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            params.push(channelId);
            run(`UPDATE channel_moderation_settings SET ${updates.join(', ')} WHERE channel_id = ?`, params);
        }
    } else {
        run(
            'INSERT INTO channel_moderation_settings (channel_id, slow_mode_seconds, followers_only, emote_only) VALUES (?, ?, ?, ?)',
            [channelId, fields.slow_mode_seconds || 0, fields.followers_only ? 1 : 0, fields.emote_only ? 1 : 0]
        );
    }
    return getChannelModerationSettings(channelId);
}

// ── Paste helpers ────────────────────────────────────────────

function createPaste({ slug, userId, type, title, content, language, visibility, streamId, screenshotPath, metadata, burnAfterRead, forkedFrom, ipAddress }) {
    return run(
        `INSERT INTO pastes (slug, user_id, type, title, content, language, visibility, stream_id, screenshot_path, metadata, burn_after_read, forked_from, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [slug, userId || null, type || 'paste', title || 'Untitled', content || '', language || 'text',
         visibility || 'public', streamId || null, screenshotPath || null, metadata || null,
         burnAfterRead ? 1 : 0, forkedFrom || null, ipAddress || null]
    );
}

function getPasteBySlug(slug) {
    return get(`
        SELECT p.*, u.username, u.avatar_url, u.display_name
        FROM pastes p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE p.slug = ?
    `, [slug]);
}

function getPasteById(id) {
    return get(`
        SELECT p.*, u.username, u.avatar_url, u.display_name
        FROM pastes p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE p.id = ?
    `, [id]);
}

function listPastes({ visibility = 'public', type, search, limit = 30, offset = 0 } = {}) {
    let where = 'WHERE p.visibility = ?';
    const params = [visibility];

    if (type && type !== 'all') {
        where += ' AND p.type = ?';
        params.push(type);
    }
    if (search) {
        where += ' AND (p.title LIKE ? OR p.content LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    const total = get(`SELECT COUNT(*) as c FROM pastes p ${where}`, params).c;
    const pastes = all(`
        SELECT p.id, p.slug, p.user_id, p.type, p.title, p.language, p.visibility,
               p.screenshot_path, p.burn_after_read, p.pinned, p.views, p.copies, p.likes, p.created_at,
               u.username, u.avatar_url, u.display_name,
               SUBSTR(p.content, 1, 220) as content
        FROM pastes p
        LEFT JOIN users u ON p.user_id = u.id
        ${where}
        ORDER BY p.pinned DESC, p.created_at DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { pastes, total };
}

function incrementPasteViews(slug) {
    return run('UPDATE pastes SET views = views + 1 WHERE slug = ?', [slug]);
}

function updatePaste(slug, fields) {
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(fields)) {
        if (['title', 'content', 'language', 'visibility', 'pinned', 'metadata'].includes(key)) {
            updates.push(`${key} = ?`);
            params.push(val);
        }
    }
    if (updates.length === 0) return;
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(slug);
    return run(`UPDATE pastes SET ${updates.join(', ')} WHERE slug = ?`, params);
}

function deletePaste(slug) {
    return run('DELETE FROM pastes WHERE slug = ?', [slug]);
}

function getUserPastes(userId, limit = 50) {
    return all(`
        SELECT id, slug, type, title, language, visibility, burn_after_read, pinned, views, copies, likes, created_at
        FROM pastes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `, [userId, limit]);
}

function likePaste(pasteId, userId) {
    run('INSERT OR IGNORE INTO paste_likes (paste_id, user_id) VALUES (?, ?)', [pasteId, userId]);
    run('UPDATE pastes SET likes = (SELECT COUNT(*) FROM paste_likes WHERE paste_id = ?) WHERE id = ?', [pasteId, pasteId]);
    return get('SELECT likes FROM pastes WHERE id = ?', [pasteId]);
}

function unlikePaste(pasteId, userId) {
    run('DELETE FROM paste_likes WHERE paste_id = ? AND user_id = ?', [pasteId, userId]);
    run('UPDATE pastes SET likes = (SELECT COUNT(*) FROM paste_likes WHERE paste_id = ?) WHERE id = ?', [pasteId, pasteId]);
    return get('SELECT likes FROM pastes WHERE id = ?', [pasteId]);
}

function hasUserLikedPaste(pasteId, userId) {
    const row = get('SELECT 1 FROM paste_likes WHERE paste_id = ? AND user_id = ?', [pasteId, userId]);
    return !!row;
}

function incrementPasteCopies(slug) {
    return run('UPDATE pastes SET copies = copies + 1 WHERE slug = ?', [slug]);
}

function countUserPastesToday(userId, ip) {
    if (userId) {
        return get("SELECT COUNT(*) as c FROM pastes WHERE user_id = ? AND created_at > datetime('now', '-1 day')", [userId])?.c || 0;
    }
    if (ip) {
        return get("SELECT COUNT(*) as c FROM pastes WHERE ip_address = ? AND created_at > datetime('now', '-1 day')", [ip])?.c || 0;
    }
    return 0;
}

/**
 * Get a user's total game level (sum of all skill levels).
 * Game has been migrated to hobo.quest — always returns 0 now.
 * Kept for paste upload limit compatibility.
 */
function getUserTotalGameLevel(userId) {
    if (!userId) return 0;
    try {
        const p = get('SELECT mining_xp, fishing_xp, woodcut_xp, farming_xp, combat_xp, crafting_xp, smithing_xp, agility_xp FROM game_players WHERE user_id = ?', [userId]);
        if (!p) return 0;
        const xpToLevel = (xp) => Math.floor(Math.sqrt((xp || 0) / 25)) + 1;
        return xpToLevel(p.mining_xp) + xpToLevel(p.fishing_xp) + xpToLevel(p.woodcut_xp) +
               xpToLevel(p.farming_xp) + xpToLevel(p.combat_xp) + xpToLevel(p.crafting_xp) +
               xpToLevel(p.smithing_xp) + xpToLevel(p.agility_xp);
    } catch {
        return 0; // game_players table may not exist after migration
    }
}

function getLastPasteTime(userId, ip) {
    let row;
    if (userId) {
        row = get('SELECT created_at FROM pastes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
    } else if (ip) {
        row = get('SELECT created_at FROM pastes WHERE ip_address = ? ORDER BY created_at DESC LIMIT 1', [ip]);
    }
    return row ? new Date(row.created_at + (row.created_at.includes('Z') ? '' : 'Z')).getTime() : 0;
}

function deleteAllForks() {
    const forks = all('SELECT id, screenshot_path FROM pastes WHERE forked_from IS NOT NULL');
    run('DELETE FROM pastes WHERE forked_from IS NOT NULL');
    return forks.length;
}

function getPasteStats() {
    const total = get('SELECT COUNT(*) as c FROM pastes')?.c || 0;
    const textPastes = get("SELECT COUNT(*) as c FROM pastes WHERE type = 'paste'")?.c || 0;
    const screenshots = get("SELECT COUNT(*) as c FROM pastes WHERE type = 'screenshot'")?.c || 0;
    const forks = get('SELECT COUNT(*) as c FROM pastes WHERE forked_from IS NOT NULL')?.c || 0;
    const totalViews = get('SELECT SUM(views) as s FROM pastes')?.s || 0;
    const totalCopies = get('SELECT SUM(copies) as s FROM pastes')?.s || 0;
    const totalLikes = get('SELECT SUM(likes) as s FROM pastes')?.s || 0;
    return { total, textPastes, screenshots, forks, totalViews, totalCopies, totalLikes };
}

// ── Paste Comment helpers ────────────────────────────────────

function createPasteComment({ paste_id, user_id, parent_id, anon_name, message, ip_address }) {
    return run(
        `INSERT INTO paste_comments (paste_id, user_id, parent_id, anon_name, message, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [paste_id, user_id || null, parent_id || null, anon_name || null, message, ip_address || null]
    );
}

function getPasteComments(pasteId, limit = 50, offset = 0) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
        FROM paste_comments c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.paste_id = ? AND c.is_deleted = 0 AND c.parent_id IS NULL
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
    `, [pasteId, limit, offset]);
}

function getPasteCommentReplies(parentId) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
        FROM paste_comments c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.parent_id = ? AND c.is_deleted = 0
        ORDER BY c.created_at ASC
    `, [parentId]);
}

function getPasteCommentById(commentId) {
    return get('SELECT * FROM paste_comments WHERE id = ?', [commentId]);
}

function getPasteCommentCount(pasteId) {
    const row = get('SELECT COUNT(*) as count FROM paste_comments WHERE paste_id = ? AND is_deleted = 0', [pasteId]);
    return row ? row.count : 0;
}

function deletePasteComment(commentId) {
    return run('UPDATE paste_comments SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [commentId]);
}

// ── Anon IP Mapping ─────────────────────────────────

/**
 * Get or assign a persistent anon number for a normalized IP.
 * Returns the existing number if the IP was seen before, or assigns
 * the next sequential number. Survives server restarts.
 */
function getOrCreateAnonNum(ip) {
    const existing = get('SELECT anon_num FROM anon_ip_mappings WHERE ip = ?', [ip]);
    if (existing) return existing.anon_num;
    const max = get('SELECT MAX(anon_num) as m FROM anon_ip_mappings');
    const nextNum = (max?.m || 0) + 1;
    try {
        run('INSERT INTO anon_ip_mappings (ip, anon_num) VALUES (?, ?)', [ip, nextNum]);
    } catch (e) {
        // Race condition: another connection inserted first — re-read
        const retry = get('SELECT anon_num FROM anon_ip_mappings WHERE ip = ?', [ip]);
        if (retry) return retry.anon_num;
        throw e;
    }
    return nextNum;
}

/**
 * Load all existing anon mappings (for in-memory cache warmup).
 * @returns {{ maxNum: number, mappings: Map<string, number> }}
 */
function loadAnonMappings() {
    const rows = all('SELECT ip, anon_num FROM anon_ip_mappings ORDER BY anon_num');
    const mappings = new Map();
    let maxNum = 0;
    for (const row of rows) {
        mappings.set(row.ip, row.anon_num);
        if (row.anon_num > maxNum) maxNum = row.anon_num;
    }
    return { maxNum, mappings };
}

// ── Stream First Chats (Welcome Messages) ────────────────────

/**
 * Check if a chatter has ever chatted in this streamer's channel.
 * @param {string} chatterKey - e.g. "user:42" or "anon:anon3" or "ext:[Twitch] foo"
 * @param {number} channelUserId - the streamer's user ID
 * @returns {boolean} true if this is their first time
 */
function isFirstChatInChannel(chatterKey, channelUserId) {
    const row = get(
        'SELECT 1 FROM stream_first_chats WHERE chatter_key = ? AND channel_user_id = ?',
        [chatterKey, channelUserId]
    );
    return !row;
}

/**
 * Record that a chatter has chatted in a streamer's channel.
 */
function recordFirstChat(chatterKey, channelUserId) {
    run(
        'INSERT OR IGNORE INTO stream_first_chats (chatter_key, channel_user_id) VALUES (?, ?)',
        [chatterKey, channelUserId]
    );
}

function getRecentPasteCommentsByIp(ip, seconds = 10) {
    return all(`
        SELECT * FROM paste_comments
        WHERE ip_address = ? AND created_at > datetime('now', '-' || ? || ' seconds')
        ORDER BY created_at DESC
    `, [ip, seconds]);
}

// ── Moderation Action Logging ────────────────────────────────

/**
 * Log a moderation action for auditing.
 * Used by canvas, chat moderation, bans, etc.
 */
function logModerationAction({ scope_type, scope_id, actor_user_id, target_user_id, action_type, details }) {
    return run(`
        INSERT INTO moderation_actions (scope_type, scope_id, actor_user_id, target_user_id, action_type, details)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [scope_type || 'site', scope_id || null, actor_user_id || null, target_user_id || null, action_type, JSON.stringify(details || {})]);
}

/**
 * Get moderation actions with optional filters.
 */
function getModerationActions({ scopeType, scope_type, scopeId, scope_id, actor_user_id, target_user_id, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    const st = scopeType || scope_type;
    const si = scopeId || scope_id;
    if (st) { conditions.push('ma.scope_type = ?'); params.push(st); }
    if (si) { conditions.push('ma.scope_id = ?'); params.push(si); }
    if (actor_user_id) { conditions.push('ma.actor_user_id = ?'); params.push(actor_user_id); }
    if (target_user_id) { conditions.push('ma.target_user_id = ?'); params.push(target_user_id); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    return all(`
        SELECT ma.*, actor.username AS actor_username, target.username AS target_username
        FROM moderation_actions ma
        LEFT JOIN users actor ON ma.actor_user_id = actor.id
        LEFT JOIN users target ON ma.target_user_id = target.id
        ${where}
        ORDER BY ma.created_at DESC
        LIMIT ? OFFSET ?
    `, params);
}

/**
 * Get a single chat message by ID.
 */
function getChatMessageById(id) {
    return get('SELECT * FROM chat_messages WHERE id = ?', [id]);
}

/**
 * Delete a chat message by ID.
 */
function deleteChatMessage(id) {
    return run('DELETE FROM chat_messages WHERE id = ?', [id]);
}

/**
 * Search chat messages within a specific channel's streams.
 */
function searchChannelChatMessages(channelId, { query, userId, limit = 50, offset = 0 } = {}) {
    const conditions = ['cm.stream_id IN (SELECT id FROM streams WHERE channel_id = ?)'];
    const params = [channelId];
    if (query) {
        conditions.push('cm.message LIKE ?');
        params.push(`%${query}%`);
    }
    if (userId) {
        conditions.push('cm.user_id = ?');
        params.push(userId);
    }
    params.push(limit, offset);
    return {
        messages: all(`
            SELECT cm.*, u.username, u.display_name, u.avatar_url
            FROM chat_messages cm
            LEFT JOIN users u ON cm.user_id = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY cm.created_at DESC
            LIMIT ? OFFSET ?
        `, params),
    };
}

// ── IP Tracking ──────────────────────────────────────────────

/**
 * Log an IP association. Deduplicates within 10 minutes for the same user+ip+action.
 */
function logIp({ userId, anonId, ip, action = 'chat', geo, userAgent }) {
    if (!ip || ip === 'unknown') return;
    // Deduplicate: skip if same user+ip+action within the last 10 minutes
    const dedupKey = userId
        ? `user_id = ? AND ip_address = ? AND action = ?`
        : `anon_id = ? AND ip_address = ? AND action = ?`;
    const dedupParams = userId ? [userId, ip, action] : [anonId, ip, action];
    const recent = get(
        `SELECT id FROM ip_log WHERE ${dedupKey} AND created_at > datetime('now', '-10 minutes') LIMIT 1`,
        dedupParams
    );
    if (recent) return;

    run(
        `INSERT INTO ip_log (user_id, anon_id, ip_address, action, geo_country, geo_region, geo_city, geo_isp, geo_org, geo_ll, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            userId || null,
            anonId || null,
            ip,
            action,
            geo?.country || null,
            geo?.region || null,
            geo?.city || null,
            geo?.isp || null,
            geo?.org || null,
            geo?.ll || null,
            userAgent || null,
        ]
    );
}

/**
 * Get all IPs used by a user, with geo data and last-seen times.
 */
function getIpsByUser(userId) {
    return all(`
        SELECT ip_address, geo_country, geo_region, geo_city, geo_isp, geo_org, geo_ll,
               COUNT(*) as hit_count,
               MIN(created_at) as first_seen,
               MAX(created_at) as last_seen,
               GROUP_CONCAT(DISTINCT action) as actions
        FROM ip_log
        WHERE user_id = ?
        GROUP BY ip_address
        ORDER BY last_seen DESC
    `, [userId]);
}

/**
 * Get all users (and anons) that have used a specific IP.
 */
function getUsersByIp(ip) {
    return all(`
        SELECT il.user_id, il.anon_id,
               u.username, u.display_name, u.avatar_url, u.role, u.is_banned, u.ban_reason, u.created_at as user_created_at,
               COUNT(*) as hit_count,
               MIN(il.created_at) as first_seen,
               MAX(il.created_at) as last_seen,
               GROUP_CONCAT(DISTINCT il.action) as actions
        FROM ip_log il
        LEFT JOIN users u ON il.user_id = u.id
        WHERE il.ip_address = ?
        GROUP BY COALESCE(il.user_id, il.anon_id)
        ORDER BY last_seen DESC
    `, [ip]);
}

/**
 * Get linked accounts for a user — finds all IPs the user has used, then finds all other
 * accounts sharing any of those IPs. Returns accounts sorted by number of shared IPs.
 */
function getLinkedAccounts(userId) {
    return all(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.role, u.is_banned, u.ban_reason,
               u.created_at,
               COUNT(DISTINCT shared.ip_address) as shared_ip_count,
               GROUP_CONCAT(DISTINCT shared.ip_address) as shared_ips,
               MAX(shared.created_at) as last_shared_activity
        FROM ip_log mine
        JOIN ip_log shared ON mine.ip_address = shared.ip_address AND shared.user_id != ?
        JOIN users u ON shared.user_id = u.id
        WHERE mine.user_id = ?
        GROUP BY shared.user_id
        ORDER BY shared_ip_count DESC, last_shared_activity DESC
    `, [userId, userId]);
}

/**
 * Get linked accounts for an anon — same as above but using anon_id.
 */
function getLinkedAccountsByAnon(anonId) {
    return all(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.role, u.is_banned, u.ban_reason,
               u.created_at,
               COUNT(DISTINCT shared.ip_address) as shared_ip_count,
               GROUP_CONCAT(DISTINCT shared.ip_address) as shared_ips,
               MAX(shared.created_at) as last_shared_activity
        FROM ip_log mine
        JOIN ip_log shared ON mine.ip_address = shared.ip_address AND (shared.user_id IS NOT NULL OR shared.anon_id != ?)
        LEFT JOIN users u ON shared.user_id = u.id
        WHERE mine.anon_id = ?
        GROUP BY COALESCE(shared.user_id, shared.anon_id)
        ORDER BY shared_ip_count DESC, last_shared_activity DESC
    `, [anonId, anonId]);
}

/**
 * Get the most recent IP for a user.
 */
function getLatestIpForUser(userId) {
    return get(`SELECT ip_address, geo_country, geo_region, geo_city, geo_isp, geo_org, geo_ll, created_at
                FROM ip_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [userId]);
}

/**
 * Get the most recent IP for an anon.
 */
function getLatestIpForAnon(anonId) {
    return get(`SELECT ip_address, geo_country, geo_region, geo_city, geo_isp, geo_org, geo_ll, created_at
                FROM ip_log WHERE anon_id = ? ORDER BY created_at DESC LIMIT 1`, [anonId]);
}

/**
 * Get full IP history log (admin search).
 */
function getIpLog({ userId, anonId, ip, action, limit = 100, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    if (userId) { conditions.push('il.user_id = ?'); params.push(userId); }
    if (anonId) { conditions.push('il.anon_id = ?'); params.push(anonId); }
    if (ip) { conditions.push('il.ip_address = ?'); params.push(ip); }
    if (action) { conditions.push('il.action = ?'); params.push(action); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    return all(`
        SELECT il.*, u.username, u.display_name
        FROM ip_log il
        LEFT JOIN users u ON il.user_id = u.id
        ${where}
        ORDER BY il.created_at DESC
        LIMIT ? OFFSET ?
    `, params);
}

/**
 * Ban all accounts sharing an IP. Returns the list of user IDs banned.
 */
function banAllAccountsOnIp(ip, { reason, bannedBy, expires }) {
    const users = all(`
        SELECT DISTINCT il.user_id
        FROM ip_log il
        WHERE il.ip_address = ? AND il.user_id IS NOT NULL
    `, [ip]);

    const bannedIds = [];
    for (const row of users) {
        if (!row.user_id) continue;
        // Set is_banned flag
        run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ? AND is_banned = 0', [reason, row.user_id]);
        // Create global user ban
        run(`INSERT INTO bans (user_id, ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
            [row.user_id, ip, reason, bannedBy, expires || null]);
        bannedIds.push(row.user_id);
    }
    // Also create standalone IP ban
    run(`INSERT INTO bans (ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
        [ip, reason, bannedBy, expires || null]);

    return bannedIds;
}

// ── Stream Analytics helpers ─────────────────────────────────

function insertViewerSnapshot(streamId, viewerCount, chatMessages5m) {
    return run(
        `INSERT INTO viewer_snapshots (stream_id, viewer_count, chat_messages_5m)
         VALUES (?, ?, ?)`,
        [streamId, viewerCount, chatMessages5m || 0]
    );
}

function getViewerSnapshots(streamId) {
    return all(
        `SELECT viewer_count, chat_messages_5m, recorded_at
         FROM viewer_snapshots WHERE stream_id = ? ORDER BY recorded_at ASC`,
        [streamId]
    );
}

function computeAndCacheStreamAnalytics(streamId) {
    const stream = get('SELECT * FROM streams WHERE id = ?', [streamId]);
    if (!stream) return null;

    // Average viewers from snapshots
    const avgRow = get(
        'SELECT AVG(viewer_count) as avg_vc FROM viewer_snapshots WHERE stream_id = ?', [streamId]
    );
    const avgViewers = avgRow?.avg_vc || 0;

    // Unique chatters
    const chattersRow = get(
        `SELECT COUNT(DISTINCT COALESCE(user_id, anon_id)) as cnt
         FROM chat_messages WHERE stream_id = ? AND is_deleted = 0 AND is_global = 0`,
        [streamId]
    );
    const uniqueChatters = chattersRow?.cnt || 0;

    // Total messages
    const msgsRow = get(
        `SELECT COUNT(*) as cnt FROM chat_messages
         WHERE stream_id = ? AND is_deleted = 0 AND is_global = 0 AND message_type = 'chat'`,
        [streamId]
    );
    const totalMessages = msgsRow?.cnt || 0;

    // Total watch minutes
    const watchRow = get(
        'SELECT SUM(minutes_watched) as total FROM watch_time WHERE stream_id = ?', [streamId]
    );
    const totalWatchMinutes = watchRow?.total || 0;

    // Clips created during this stream
    const clipsRow = get(
        'SELECT COUNT(*) as cnt FROM clips WHERE stream_id = ?', [streamId]
    );
    const clipsCreated = clipsRow?.cnt || 0;

    // Coins earned during this stream
    const coinsRow = get(
        'SELECT SUM(coins_earned) as total FROM watch_time WHERE stream_id = ?', [streamId]
    );
    const coinsEarned = coinsRow?.total || 0;

    // New followers — approximate: follows where followed_at is during stream
    let newFollowers = 0;
    if (stream.started_at && stream.ended_at) {
        const fRow = get(
            `SELECT COUNT(*) as cnt FROM follows
             WHERE followed_id = ? AND followed_at >= ? AND followed_at <= ?`,
            [stream.user_id, stream.started_at, stream.ended_at]
        );
        newFollowers = fRow?.cnt || 0;
    }

    // Upsert into stream_analytics
    run(
        `INSERT INTO stream_analytics
            (stream_id, avg_viewers, peak_viewers, unique_chatters, total_messages,
             total_watch_minutes, new_followers, clips_created, coins_earned, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(stream_id) DO UPDATE SET
            avg_viewers = excluded.avg_viewers,
            peak_viewers = excluded.peak_viewers,
            unique_chatters = excluded.unique_chatters,
            total_messages = excluded.total_messages,
            total_watch_minutes = excluded.total_watch_minutes,
            new_followers = excluded.new_followers,
            clips_created = excluded.clips_created,
            coins_earned = excluded.coins_earned,
            computed_at = CURRENT_TIMESTAMP`,
        [streamId, avgViewers, stream.peak_viewers || 0, uniqueChatters, totalMessages,
         totalWatchMinutes, newFollowers, clipsCreated, coinsEarned]
    );

    return {
        stream_id: streamId,
        avg_viewers: avgViewers,
        peak_viewers: stream.peak_viewers || 0,
        unique_chatters: uniqueChatters,
        total_messages: totalMessages,
        total_watch_minutes: totalWatchMinutes,
        new_followers: newFollowers,
        clips_created: clipsCreated,
        coins_earned: coinsEarned,
    };
}

function getStreamAnalytics(streamId) {
    return get('SELECT * FROM stream_analytics WHERE stream_id = ?', [streamId]);
}

function getChannelAnalyticsSummary(userId, days) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    // Stream history with analytics
    const streams = all(`
        SELECT s.id, s.title, s.category, s.started_at, s.ended_at, s.duration_seconds,
               s.peak_viewers, s.viewer_count,
               sa.avg_viewers, sa.unique_chatters, sa.total_messages,
               sa.total_watch_minutes, sa.new_followers, sa.clips_created, sa.coins_earned
        FROM streams s
        LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
        WHERE s.user_id = ? AND s.started_at >= ? AND s.duration_seconds > 0
        ORDER BY s.started_at DESC
    `, [userId, cutoff]);

    // Aggregate stats
    const agg = get(`
        SELECT COUNT(*) as total_streams,
               SUM(s.duration_seconds) as total_duration,
               MAX(s.peak_viewers) as all_time_peak,
               AVG(sa.avg_viewers) as avg_viewers_per_stream,
               SUM(sa.total_messages) as total_messages,
               SUM(sa.unique_chatters) as total_unique_chatters,
               SUM(sa.total_watch_minutes) as total_watch_minutes,
               SUM(sa.new_followers) as total_new_followers,
               SUM(sa.clips_created) as total_clips
        FROM streams s
        LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
        WHERE s.user_id = ? AND s.started_at >= ? AND s.duration_seconds > 0
    `, [userId, cutoff]);

    // All-time totals
    const allTime = get(`
        SELECT COUNT(*) as total_streams,
               SUM(duration_seconds) as total_duration,
               MAX(peak_viewers) as peak_viewers
        FROM streams WHERE user_id = ? AND duration_seconds > 0
    `, [userId]);

    const followerCount = get(
        'SELECT COUNT(*) as cnt FROM follows WHERE followed_id = ?', [userId]
    )?.cnt || 0;

    return {
        period_days: days,
        streams,
        summary: {
            total_streams: agg?.total_streams || 0,
            total_duration_seconds: agg?.total_duration || 0,
            peak_viewers: agg?.all_time_peak || 0,
            avg_viewers_per_stream: Math.round((agg?.avg_viewers_per_stream || 0) * 10) / 10,
            total_messages: agg?.total_messages || 0,
            total_unique_chatters: agg?.total_unique_chatters || 0,
            total_watch_minutes: agg?.total_watch_minutes || 0,
            total_new_followers: agg?.total_new_followers || 0,
            total_clips: agg?.total_clips || 0,
        },
        all_time: {
            total_streams: allTime?.total_streams || 0,
            total_duration_seconds: allTime?.total_duration || 0,
            peak_viewers: allTime?.peak_viewers || 0,
            follower_count: followerCount,
        },
    };
}

function getRecentChatActivity(streamId, minutes) {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const row = get(
        `SELECT COUNT(*) as cnt FROM chat_messages
         WHERE stream_id = ? AND timestamp >= ? AND is_deleted = 0 AND is_global = 0 AND message_type = 'chat'`,
        [streamId, cutoff]
    );
    return row?.cnt || 0;
}

module.exports = {
    getDb, initDb, run, get, all, close,
    // Users
    getUserById, getUserByUsername, getUserByStreamKey, createUser, getOrCreateAnonGameUser,
    // Streams
    getLiveStreams, getRecentStreams, getStreamById, getStreamByUserId, getLiveStreamsByUserId, getStreamsByUserId,
    createStream, endStream, updateViewerCount,
    // Channels
    getChannelByUserId, getChannelByUsername, createChannel, updateChannel, ensureChannel,
    // RobotStreamer integration
    getRobotStreamerIntegrationByUserId, upsertRobotStreamerIntegration,
    // Restream destinations
    getRestreamDestinationsByUserId, getRestreamDestinationById,
    createRestreamDestination, updateRestreamDestination, deleteRestreamDestination,
    // Chat
    saveChatMessage, searchChatMessages, getUserChatHistory,
    // Profiles
    getUserProfile, updateUserAvatar,
    // Follows
    followUser, unfollowUser, getFollowerCount, isFollowing, getFollowerIds,
    // Transactions (Hobo Bucks)
    createTransaction, addHoboBucks, deductHoboBucks,
    // Hobo Coins
    addHoboCoins, deductHoboCoins, createCoinTransaction, getCoinTransactions,
    // Coin Rewards
    createCoinReward, getCoinRewardsByStreamer, getCoinRewardById, updateCoinReward, deleteCoinReward,
    // Coin Redemptions
    createCoinRedemption, getPendingRedemptions, resolveRedemption,
    // Watch Time
    upsertWatchTime, getWatchTime, getTotalWatchTime,
    // Media Requests
    getMediaRequestSettingsByUserId, upsertMediaRequestSettings,
    createMediaRequest, getMediaRequestById, getMediaRequestByStreamerAndId,
    getActiveMediaRequestByStreamer, getNextPendingMediaRequest,
    getPendingMediaRequestsByStreamer, getRecentMediaRequestsByStreamer,
    countPendingMediaRequestsForUser, getMediaRequestMaxQueuePosition,
    findActiveMediaRequestByCanonicalUrl, updateMediaRequest,
    renormalizePendingMediaRequestPositions,
    // VODs
    createVod, getVodById, getVodsByUser, getPublicVods, getActiveVodByStream, getOrphanedRecordingVods,
    // Clips
    createClip, getClipById, getClipsByUser, getPublicClips, getClipsByStream, setClipPublic, getClipsOfUserStreams, findDuplicateClip,
    // Controls
    getStreamControls, createControl,
    // API Keys
    createApiKey, getApiKeyByHash,
    // Bans
    isUserBanned, isIpBanned,
    // Emotes
    createEmote, getEmoteById, getEmotesByUser, getGlobalEmotes, getChannelEmotes,
    deleteEmote, getEmoteByCode, countUserEmotes,
    // Site Settings
    getSetting, getSettingRow, getAllSettings, setSetting, deleteSetting,
    // Verification Keys
    createVerificationKey, getVerificationKeyByKey, getVerificationKeyByUsername,
    getAllVerificationKeys, redeemVerificationKey, revokeVerificationKey, isUsernameReserved,
    // Comments
    createComment, getComments, getCommentReplies, getCommentById, getCommentCount,
    deleteComment, updateComment,
    // Chat Replay
    getChatReplay,
    // Channel lookup
    getChannelById,
    // Channel Moderators
    isChannelModerator, addChannelModerator, removeChannelModerator,
    getChannelModerators, getChannelsByModerator,
    // Channel Moderation Settings
    getChannelModerationSettings, upsertChannelModerationSettings,
    // Pastes
    createPaste, getPasteBySlug, getPasteById, listPastes,
    incrementPasteViews, updatePaste, deletePaste, getUserPastes,
    likePaste, unlikePaste, hasUserLikedPaste, incrementPasteCopies,
    countUserPastesToday, getLastPasteTime, deleteAllForks, getPasteStats, getUserTotalGameLevel,
    // Paste Comments
    createPasteComment, getPasteComments, getPasteCommentReplies,
    getPasteCommentById, getPasteCommentCount, deletePasteComment,
    getRecentPasteCommentsByIp,
    // Anon IP Mappings
    getOrCreateAnonNum, loadAnonMappings,
    // Stream first chats (welcome messages)
    isFirstChatInChannel, recordFirstChat,
    // Moderation Action Logging
    logModerationAction, getModerationActions,
    getChatMessageById, deleteChatMessage, searchChannelChatMessages,
    // IP Tracking
    logIp, getIpsByUser, getUsersByIp, getLinkedAccounts, getLinkedAccountsByAnon,
    getLatestIpForUser, getLatestIpForAnon, getIpLog, banAllAccountsOnIp,
    // Stream Analytics
    insertViewerSnapshot, getViewerSnapshots, computeAndCacheStreamAnalytics,
    getStreamAnalytics, getChannelAnalyticsSummary, getRecentChatActivity,
};
