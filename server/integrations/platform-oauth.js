/**
 * HoboStreamer — Platform OAuth adapters (Twitch / YouTube / Kick)
 *
 * Provides per-user authorization so a streamer can "Connect" their external
 * platform account to a stream slot instead of hand-pasting RTMP server URLs
 * and stream keys.
 *
 * What each platform can auto-provide after OAuth:
 *   - Twitch : channel identity + ingest URL + stream key   (fully automatic)
 *   - YouTube: channel identity + ingest URL + stream key    (via Live API)
 *   - Kick   : channel identity only — Kick's official API does NOT expose the
 *              RTMP stream key, so the key/server URL stay a manual paste.
 *
 * Client credentials come from admin site-settings (getSetting), the same rows
 * already used for viewer-count polling. Redirect URIs are derived from
 * config.baseUrl and must be registered in each platform's developer app:
 *   {baseUrl}/api/restream/oauth/{platform}/callback
 */
const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');

const JWT_SECRET = process.env.JWT_SECRET || 'hobostreamer-dev-secret';

/** Per-platform OAuth endpoint + scope config. */
const PLATFORMS = {
    twitch: {
        name: 'Twitch',
        authorizeUrl: 'https://id.twitch.tv/oauth2/authorize',
        tokenUrl: 'https://id.twitch.tv/oauth2/token',
        scopes: ['channel:read:stream_key'],
        pkce: false,
        clientIdKey: 'twitch_client_id',
        clientSecretKey: 'twitch_client_secret',
        providesKey: true,
    },
    youtube: {
        name: 'YouTube',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: ['https://www.googleapis.com/auth/youtube'],
        // access_type=offline + prompt=consent guarantees a refresh_token
        extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
        pkce: false,
        clientIdKey: 'google_client_id',
        clientSecretKey: 'google_client_secret',
        providesKey: true,
    },
    kick: {
        name: 'Kick',
        authorizeUrl: 'https://id.kick.com/oauth/authorize',
        tokenUrl: 'https://id.kick.com/oauth/token',
        scopes: ['user:read', 'channel:read', 'streamkey:read'],
        pkce: true, // Kick OAuth 2.1 requires PKCE
        clientIdKey: 'kick_client_id',
        clientSecretKey: 'kick_client_secret',
        providesKey: true, // with streamkey:read, /channels returns stream.url + stream.key
    },
};

function isValidPlatform(p) {
    return Object.prototype.hasOwnProperty.call(PLATFORMS, p);
}

function redirectUri(platform) {
    return `${config.baseUrl.replace(/\/+$/, '')}/api/restream/oauth/${platform}/callback`;
}

/** Resolve client id/secret from admin settings; reports whether configured. */
function getClientConfig(platform) {
    const p = PLATFORMS[platform];
    if (!p) return { configured: false };
    const clientId = (db.getSetting(p.clientIdKey) || '').trim();
    const clientSecret = (db.getSetting(p.clientSecretKey) || '').trim();
    return {
        clientId,
        clientSecret,
        redirectUri: redirectUri(platform),
        configured: Boolean(clientId && clientSecret),
    };
}

// ---- PKCE helpers (Kick) ----
function generatePkce() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

// ---- Signed state cookie (carries userId + slot across the redirect) ----
function signState(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function verifyState(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
    // timing-safe compare
    const a = Buffer.from(sig || '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch { return null; }
}

/**
 * Build the authorize URL to redirect the user to.
 * Returns { url, stateToken } — stateToken must be stored in a short-lived
 * signed cookie and validated on callback.
 */
function buildAuthorize(platform, { userId, managedStreamId }) {
    const p = PLATFORMS[platform];
    const cfg = getClientConfig(platform);
    if (!cfg.configured) throw new Error(`${p.name} OAuth is not configured (missing client id/secret in admin settings)`);

    const nonce = crypto.randomBytes(16).toString('base64url');
    const statePayload = { platform, userId, managedStreamId: managedStreamId || null, nonce };
    let codeVerifier = null;
    const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        response_type: 'code',
        scope: p.scopes.join(' '),
        state: nonce,
    });
    if (p.extraAuthParams) for (const [k, v] of Object.entries(p.extraAuthParams)) params.set(k, v);
    if (p.pkce) {
        const pkce = generatePkce();
        codeVerifier = pkce.verifier;
        statePayload.codeVerifier = pkce.verifier;
        params.set('code_challenge', pkce.challenge);
        params.set('code_challenge_method', 'S256');
    }
    return { url: `${p.authorizeUrl}?${params.toString()}`, stateToken: signState(statePayload), codeVerifier };
}

async function postForm(url, formObj, headers = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', ...headers },
        body: new URLSearchParams(formObj).toString(),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
    if (!res.ok) {
        const msg = (json && (json.message || json.error_description || json.error)) || text || res.statusText;
        throw new Error(`${url} -> ${res.status}: ${msg}`);
    }
    return json || {};
}

/** Exchange an authorization code for tokens. */
async function exchangeCode(platform, code, codeVerifier) {
    const p = PLATFORMS[platform];
    const cfg = getClientConfig(platform);
    const form = {
        grant_type: 'authorization_code',
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri,
    };
    if (p.pkce && codeVerifier) form.code_verifier = codeVerifier;
    const tok = await postForm(p.tokenUrl, form);
    return normalizeToken(tok);
}

/** Refresh an access token. Returns normalized token (may omit refresh_token). */
async function refreshAccessToken(platform, refreshToken) {
    const p = PLATFORMS[platform];
    const cfg = getClientConfig(platform);
    const tok = await postForm(p.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
    });
    return normalizeToken(tok);
}

function normalizeToken(tok) {
    const expiresIn = parseInt(tok.expires_in, 10);
    return {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token || null,
        scope: Array.isArray(tok.scope) ? tok.scope.join(' ') : (tok.scope || ''),
        expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
    };
}

async function getJson(url, headers) {
    const res = await fetch(url, { headers: { 'Accept': 'application/json', ...headers } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* */ }
    if (!res.ok) {
        const msg = (json && (json.message || json.error?.message || json.error)) || text || res.statusText;
        throw new Error(`${url} -> ${res.status}: ${msg}`);
    }
    return json || {};
}

/**
 * After token exchange, fetch identity + (where possible) ingest URL + key.
 * Returns:
 *   { platform_user_id, platform_username, channel_url,
 *     server_url|null, stream_key|null, needsManualKey }
 */
async function fetchConnection(platform, accessToken) {
    if (platform === 'twitch') return fetchTwitch(accessToken);
    if (platform === 'youtube') return fetchYouTube(accessToken);
    if (platform === 'kick') return fetchKick(accessToken);
    throw new Error(`Unknown platform ${platform}`);
}

async function fetchTwitch(accessToken) {
    const cfg = getClientConfig('twitch');
    const headers = { Authorization: `Bearer ${accessToken}`, 'Client-Id': cfg.clientId };
    const users = await getJson('https://api.twitch.tv/helix/users', headers);
    const u = users.data && users.data[0];
    if (!u) throw new Error('Twitch: could not read user profile');
    let streamKey = null;
    try {
        const keyRes = await getJson(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${u.id}`, headers);
        streamKey = keyRes.data && keyRes.data[0] && keyRes.data[0].stream_key;
    } catch (e) {
        // scope missing or key endpoint failed — fall back to manual key entry
        console.warn('[PlatformOAuth] Twitch stream key fetch failed:', e.message);
    }
    return {
        platform_user_id: String(u.id),
        platform_username: u.display_name || u.login,
        channel_url: `https://twitch.tv/${u.login}`,
        server_url: 'rtmps://live.twitch.tv/app',
        stream_key: streamKey || null,
        needsManualKey: !streamKey,
    };
}

async function fetchYouTube(accessToken) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    // Channel identity
    const ch = await getJson('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', headers);
    const channel = ch.items && ch.items[0];
    const channelId = channel && channel.id;
    const snippet = (channel && channel.snippet) || {};
    const channelUrl = snippet.customUrl
        ? `https://youtube.com/${snippet.customUrl.startsWith('@') ? snippet.customUrl : '@' + snippet.customUrl}`
        : (channelId ? `https://youtube.com/channel/${channelId}` : 'https://youtube.com');

    // Reusable ingest: list the account's live streams (the persistent "Stream key")
    let stream = null;
    const list = await getJson('https://www.googleapis.com/youtube/v3/liveStreams?part=cdn,snippet&mine=true', headers);
    if (list.items && list.items.length) {
        // Prefer a reusable RTMP stream
        stream = list.items.find(s => s.cdn && s.cdn.ingestionType === 'rtmp') || list.items[0];
    }
    if (!stream) {
        // Create a reusable RTMP stream key for this channel
        stream = await createYouTubeStream(headers);
    }
    const ingest = stream && stream.cdn && stream.cdn.ingestionInfo;
    return {
        platform_user_id: channelId ? String(channelId) : null,
        platform_username: snippet.title || 'YouTube',
        channel_url: channelUrl,
        server_url: (ingest && ingest.ingestionAddress) || 'rtmp://a.rtmp.youtube.com/live2',
        stream_key: (ingest && ingest.streamName) || null,
        needsManualKey: !(ingest && ingest.streamName),
    };
}

async function createYouTubeStream(headers) {
    const body = {
        snippet: { title: 'HoboStreamer' },
        cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
    };
    const res = await fetch('https://www.googleapis.com/youtube/v3/liveStreams?part=snippet,cdn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`YouTube liveStreams.insert -> ${res.status}: ${json.error?.message || res.statusText}`);
    return json;
}

async function fetchKick(accessToken) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    let slug = null, name = null, userId = null, serverUrl = null, streamKey = null;
    try {
        const ch = await getJson('https://api.kick.com/public/v1/channels', headers);
        const c = ch.data && ch.data[0];
        if (c) {
            slug = c.slug;
            userId = c.broadcaster_user_id != null ? String(c.broadcaster_user_id) : null;
            // With the streamkey:read scope, /channels includes the RTMP ingest + key.
            if (c.stream) {
                if (c.stream.url) serverUrl = c.stream.url;
                if (c.stream.key) streamKey = c.stream.key;
            }
        }
    } catch (e) {
        console.warn('[PlatformOAuth] Kick channel fetch failed:', e.message);
    }
    if (!slug) {
        try {
            const us = await getJson('https://api.kick.com/public/v1/users', headers);
            const u = us.data && us.data[0];
            if (u) { name = u.name; userId = userId || (u.user_id != null ? String(u.user_id) : null); }
        } catch (e) {
            console.warn('[PlatformOAuth] Kick user fetch failed:', e.message);
        }
    }
    return {
        platform_user_id: userId,
        platform_username: name || slug || 'Kick',
        channel_url: slug ? `https://kick.com/${slug}` : null,
        server_url: serverUrl,
        stream_key: streamKey,
        needsManualKey: !streamKey, // only if the key wasn't returned (e.g. scope not granted)
    };
}

// ── Live ingest resolution from a stored connection (used at restream go-live) ──

/** Return a valid access token for a stored connection, refreshing + persisting if needed. */
async function getValidAccessToken(connection) {
    if (!connection) return null;
    const skew = 60 * 1000;
    if (connection.access_token && connection.token_expires_at && (connection.token_expires_at - Date.now() > skew)) {
        return connection.access_token;
    }
    if (!connection.refresh_token) return connection.access_token || null; // may be non-expiring
    try {
        const tok = await refreshAccessToken(connection.platform, connection.refresh_token);
        db.updatePlatformConnectionTokens(connection.id, {
            access_token: tok.accessToken, refresh_token: tok.refreshToken,
            token_expires_at: tok.expiresAt, scope: tok.scope,
        });
        return tok.accessToken;
    } catch (e) {
        console.warn('[PlatformOAuth] token refresh failed for', connection.platform, e.message);
        return connection.access_token || null;
    }
}

/**
 * Resolve the current ingest URL + stream key for a linked destination at go-live.
 * Twitch: fetches the live stream key. YouTube: gets the persistent key AND creates
 * an auto-start/auto-stop broadcast bound to the stream so it actually goes live.
 * Kick: returns null (its API doesn't expose the key). Returns {server_url, stream_key} or null.
 */
async function resolveIngestForConnection(connection, { title } = {}) {
    const token = await getValidAccessToken(connection);
    if (!token) return null;
    if (connection.platform === 'twitch') {
        const cfg = getClientConfig('twitch');
        const headers = { Authorization: `Bearer ${token}`, 'Client-Id': cfg.clientId };
        const users = await getJson('https://api.twitch.tv/helix/users', headers);
        const u = users.data && users.data[0];
        if (!u) return null;
        const keyRes = await getJson(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${u.id}`, headers);
        const key = keyRes.data && keyRes.data[0] && keyRes.data[0].stream_key;
        return key ? { server_url: 'rtmps://live.twitch.tv/app', stream_key: key } : null;
    }
    if (connection.platform === 'youtube') {
        return youtubeGoLive(token, title);
    }
    if (connection.platform === 'kick') {
        // With streamkey:read, /channels returns the current RTMP ingest + key.
        const ch = await getJson('https://api.kick.com/public/v1/channels', { Authorization: `Bearer ${token}` });
        const c = ch.data && ch.data[0];
        const url = c && c.stream && c.stream.url;
        const key = c && c.stream && c.stream.key;
        return (url && key) ? { server_url: url, stream_key: key } : null;
    }
    return null;
}

/** Get the reusable YouTube ingest and create+bind an auto-start broadcast. */
async function youtubeGoLive(token, title) {
    const H = { Authorization: `Bearer ${token}` };
    let stream = null;
    const list = await getJson('https://www.googleapis.com/youtube/v3/liveStreams?part=cdn,snippet&mine=true', H);
    if (list.items && list.items.length) stream = list.items.find(s => s.cdn && s.cdn.ingestionType === 'rtmp') || list.items[0];
    if (!stream) stream = await createYouTubeStream(H);
    const ingest = stream && stream.cdn && stream.cdn.ingestionInfo;
    if (!ingest || !ingest.streamName) return null;

    // Avoid piling up "Upcoming" broadcasts: reuse an existing upcoming/ready one
    // (and clean up extras) instead of creating a fresh broadcast on every go-live.
    try {
        let reuse = null;
        try {
            const bl = await getJson('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id,status,contentDetails&broadcastStatus=upcoming&broadcastType=all&maxResults=50', H);
            const upcoming = (bl.items || []).filter(b => ['created', 'ready', 'testing'].includes(b.status && b.status.lifeCycleStatus));
            // Prefer one already bound to our stream, else any upcoming one we can rebind.
            reuse = upcoming.find(b => b.contentDetails && b.contentDetails.boundStreamId === stream.id) || upcoming[0] || null;
            // Delete the leftover upcoming duplicates to clear the pileup.
            for (const b of upcoming) {
                if (reuse && b.id !== reuse.id) {
                    try { await fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?id=${b.id}`, { method: 'DELETE', headers: H }); } catch { /* */ }
                }
            }
        } catch { /* listing failed — fall through to create */ }

        let broadcastId;
        if (reuse) {
            broadcastId = reuse.id;
            console.log(`[PlatformOAuth] Reusing YouTube broadcast ${broadcastId} (no new "Upcoming" created)`);
        } else {
            const body = {
                snippet: { title: (title || 'HoboStreamer').slice(0, 100), scheduledStartTime: new Date(Date.now() + 5000).toISOString() },
                status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
                contentDetails: { enableAutoStart: true, enableAutoStop: true },
            };
            const res = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails', {
                method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            const broadcast = await res.json();
            if (!res.ok) throw new Error(broadcast.error?.message || `insert ${res.status}`);
            broadcastId = broadcast.id;
            console.log(`[PlatformOAuth] YouTube broadcast ${broadcastId} created (auto-start)`);
        }
        // Bind broadcast → stream (idempotent — safe to rebind the reused one).
        const bindRes = await fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts/bind?id=${broadcastId}&part=id,contentDetails&streamId=${stream.id}`, { method: 'POST', headers: H });
        if (!bindRes.ok) { const j = await bindRes.json().catch(() => ({})); throw new Error(j.error?.message || `bind ${bindRes.status}`); }
    } catch (e) {
        // Still return the key — if the user has auto-start enabled in YT Studio it works anyway.
        console.warn('[PlatformOAuth] YouTube broadcast setup failed (key still returned):', e.message);
    }
    return { server_url: ingest.ingestionAddress, stream_key: ingest.streamName };
}

module.exports = {
    PLATFORMS,
    isValidPlatform,
    getClientConfig,
    redirectUri,
    buildAuthorize,
    verifyState,
    exchangeCode,
    refreshAccessToken,
    fetchConnection,
    getValidAccessToken,
    resolveIngestForConnection,
};
