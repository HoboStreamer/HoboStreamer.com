/**
 * HoboStreamer — Streaming & Channel API Routes
 * 
 * Channels (permanent, static URL per user):
 * GET    /api/streams/channel/:username  - Get channel + live stream
 * PUT    /api/streams/channel            - Update own channel
 * 
 * Managed Streams (persistent per-account stream definitions):
 * GET    /api/streams/managed            - List own managed streams
 * POST   /api/streams/managed            - Create a managed stream
 * PUT    /api/streams/managed/:id        - Update a managed stream
 * DELETE /api/streams/managed/:id        - Delete a managed stream
 * 
 * Streams (sessions on a managed stream):
 * GET    /api/streams                    - List live streams
 * GET    /api/streams/recent             - List recently ended streams
 * GET    /api/streams/:id                - Get stream details
 * POST   /api/streams                    - Go live (creates session on managed stream)
 * PUT    /api/streams/:id                - Update stream info
 * DELETE /api/streams/:id                - End a stream
 * GET    /api/streams/:id/endpoint       - Get streaming endpoint info
 * POST   /api/streams/:id/follow         - Follow/unfollow streamer
 */
const express = require('express');
const db = require('../db/database');
const config = require('../config');
const { requireAuth, requireStreamer, optionalAuth } = require('../auth/auth');
const jsmpegRelay = require('./jsmpeg-relay');
const webrtcSFU = require('./webrtc-sfu');
const recorder = require('../vod/recorder');
const robotStreamerService = require('../integrations/robotstreamer-service');
const chatRelayService = require('../integrations/chat-relay-service');
const chatServer = require('../chat/chat-server');
const { pushNotification, actorInfo } = require('../utils/notify');

const router = express.Router();
const ALLOWED_PROTOCOLS = new Set(['jsmpeg', 'webrtc', 'rtmp']);
const ALLOWED_VISIBILITY = new Set(['public', 'unlisted', 'private']);
const ALLOWED_CALL_MODES = new Set(['mic', 'mic+cam', 'cam+mic']);
const MAX_TITLE_LENGTH = 140;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_CATEGORY_LENGTH = 60;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;
const MAX_PANELS_LENGTH = 20000;

// ── Go-Live Notification Push ────────────────────────────────
const { pushBulkNotification } = require('../utils/notify');
const { notifyDiscordGoLive } = require('../integrations/discord-webhook');

const INTERNAL_API_KEY = config.internalApiKey || process.env.INTERNAL_API_KEY || process.env.HOBO_INTERNAL_KEY || '';

/**
 * Push "X went live" notification via hobo.tools unified event endpoint.
 * This lets hobo.tools handle Discord bot alerts + push notifications centrally.
 * Falls back to direct webhook + bulk push if hobo.tools is unreachable.
 */
function notifyFollowersGoLive(streamer, stream) {
    // Try unified event endpoint first (handles Discord bot + push)
    fetch(`${config.hoboToolsInternalUrl}/internal/events/stream-live`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': INTERNAL_API_KEY,
        },
        body: JSON.stringify({
            streamer: {
                id: streamer.id,
                username: streamer.username,
                display_name: streamer.display_name || null,
                avatar_url: streamer.avatar_url || null,
            },
            stream: {
                id: stream.id,
                title: stream.title || null,
                protocol: stream.protocol || null,
            },
        }),
    }).then(r => {
        if (r.ok) {
            console.log(`[GoLive] Unified event sent for ${streamer.username}`);
        } else {
            console.warn(`[GoLive] Unified event failed (${r.status}), using fallback`);
            _fallbackNotify(streamer, stream);
        }
    }).catch(err => {
        console.warn('[GoLive] Unified event error, using fallback:', err.message);
        _fallbackNotify(streamer, stream);
    });
}

/** Fallback: direct Discord webhook + bulk push (if hobo.tools is down) */
function _fallbackNotify(streamer, stream) {
    notifyDiscordGoLive(streamer, stream);

    const followerIds = db.getFollowerIds(streamer.id);
    if (!followerIds.length) return;

    pushBulkNotification(followerIds, {
        type: 'STREAM_LIVE',
        title: `${streamer.display_name || streamer.username} is live!`,
        message: stream.title || 'Started streaming',
        icon: '🔴',
        sender_id: streamer.id,
        sender_name: streamer.display_name || streamer.username,
        sender_avatar: streamer.avatar_url || null,
        url: `${config.baseUrl}/${streamer.username}`,
        rich_content: {
            thumbnail: streamer.avatar_url || null,
            context: {
                stream_id: stream.id,
                username: streamer.username,
                title: stream.title || 'Started streaming',
            },
        },
    });
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function cleanText(value, { maxLength, allowEmpty = false } = {}) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (!cleaned) return allowEmpty ? '' : null;
    return cleaned.slice(0, maxLength);
}

function cleanProtocol(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return null;
    const cleaned = value.trim().toLowerCase();
    return ALLOWED_PROTOCOLS.has(cleaned) ? cleaned : null;
}

function cleanVisibility(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return null;
    const cleaned = value.trim().toLowerCase();
    return ALLOWED_VISIBILITY.has(cleaned) ? cleaned : null;
}

function cleanCallMode(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') return null;
    const cleaned = value.trim().toLowerCase();
    return ALLOWED_CALL_MODES.has(cleaned) ? cleaned : null;
}

function cleanTags(tags) {
    if (tags === undefined) return undefined;
    if (!Array.isArray(tags)) return null;
    const cleaned = [];
    const seen = new Set();
    for (const tag of tags) {
        if (typeof tag !== 'string') continue;
        const normalized = tag.replace(/\s+/g, ' ').trim().toLowerCase();
        if (!normalized || normalized.length > MAX_TAG_LENGTH || seen.has(normalized)) continue;
        seen.add(normalized);
        cleaned.push(normalized);
        if (cleaned.length >= MAX_TAGS) break;
    }
    return cleaned;
}

function cleanPanels(panels) {
    if (panels === undefined) return undefined;
    if (typeof panels === 'string') {
        return panels.length <= MAX_PANELS_LENGTH ? panels : null;
    }
    try {
        const serialized = JSON.stringify(panels ?? []);
        return serialized.length <= MAX_PANELS_LENGTH ? serialized : null;
    } catch {
        return null;
    }
}

function cleanBooleanFlag(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

function resolveWhipUrlBase(config, req) {
    const requestHostOrigin = `${req.protocol}://${req.get('host')}`;
    const fallbackUrl = config.webrtc?.publicUrl || requestHostOrigin;
    let whipUrlBase = fallbackUrl;
    let whipUrlSource = config.webrtc?.publicUrl ? 'webrtc_public_url' : 'request_host';
    let whipUrlWarning;

    if (config.whip?.publicUrl && config.whip?.enabled) {
        whipUrlBase = config.whip.publicUrl;
        whipUrlSource = 'whip_public_url';
        try {
            const baseHost = new URL(config.baseUrl).hostname;
            const whipHost = new URL(whipUrlBase).hostname;
            if (whipHost !== baseHost && config.nodeEnv !== 'development') {
                whipUrlWarning = 'Dedicated WHIP hostname differs from BASE_URL host. Ensure DNS/vhost/TLS are configured for this host before using it.';
            }
        } catch {
            // invalid URL parsing should not block endpoint generation
        }
    } else if (config.whip?.publicUrl && !config.whip?.enabled) {
        whipUrlWarning = 'Dedicated WHIP hostname is configured but not enabled. Falling back to the safe public WebRTC origin.';
    }

    return { whipUrlBase, whipUrlSource, whipUrlWarning };
}

// ── Get Channel by Username ──────────────────────────────────
router.get('/channel/:username', optionalAuth, (req, res) => {
    try {
        let channel = db.getChannelByUsername(req.params.username);
        if (!channel) {
            const user = db.getUserByUsername(req.params.username);
            if (!user) return res.status(404).json({ error: 'Channel not found' });
            db.ensureChannel(user.id);
            channel = db.getChannelByUsername(req.params.username);
            if (!channel) return res.status(404).json({ error: 'Channel not found' });
        }

        // Get live streams (may be multiple with different protocols)
        const liveStreams = db.getLiveStreamsByUserId(channel.user_id) || [];
        for (const liveStream of liveStreams) {
            // Use managed stream key from the JOIN, else fall back to user key
            const lsKey = liveStream.managed_stream_key
                || db.getUserById(liveStream.user_id)?.stream_key;
            if (liveStream.protocol === 'jsmpeg') {
                liveStream.endpoint = jsmpegRelay.getChannelInfo(lsKey);
            } else if (liveStream.protocol === 'webrtc') {
                liveStream.endpoint = { roomId: `stream-${liveStream.id}` };
            } else if (liveStream.protocol === 'rtmp') {
                liveStream.endpoint = {
                    flvUrl: `/api/streams/rtmp-proxy/${liveStream.id}.flv`,
                };
            }
            delete liveStream.stream_key;
            delete liveStream.managed_stream_key;
        }

        // Show private VODs/clips to the channel owner, only public to others
        const isOwner = req.user && req.user.id === channel.user_id;
        const vodLimit = Math.min(Math.max(parseInt(req.query.vodLimit || '12', 10), 1), 48);
        const vodOffset = Math.max(parseInt(req.query.vodOffset || '0', 10), 0);
        const ALLOWED_VOD_ORDERS = new Set(['newest', 'oldest', 'views', 'peak_viewers']);
        const vodOrderBy = ALLOWED_VOD_ORDERS.has(req.query.vodOrderBy) ? req.query.vodOrderBy : 'newest';
        // Accept managed stream by numeric ID or slug
        let vodManagedStreamId = null;
        if (req.query.vodManagedStreamId) {
            const rawMsId = req.query.vodManagedStreamId;
            const numId = parseInt(rawMsId, 10);
            if (!isNaN(numId) && String(numId) === String(rawMsId)) {
                vodManagedStreamId = numId;
            } else {
                // Try slug resolution
                const msRow = db.getManagedStreamBySlug(channel.user_id, rawMsId);
                if (msRow) vodManagedStreamId = msRow.id;
            }
        } else if (req.query.vodManagedStreamSlug) {
            const msRow = db.getManagedStreamBySlug(channel.user_id, req.query.vodManagedStreamSlug);
            if (msRow) vodManagedStreamId = msRow.id;
        }
        const clipLimit = Math.min(Math.max(parseInt(req.query.clipLimit || '12', 10), 1), 48);
        const clipOffset = Math.max(parseInt(req.query.clipOffset || '0', 10), 0);
        const vods = db.getVodsByUserFiltered(channel.user_id, { includePrivate: isOwner, managedStreamId: vodManagedStreamId, orderBy: vodOrderBy, limit: vodLimit, offset: vodOffset }) || [];
        const vodTotal = db.countVodsByUserFiltered(channel.user_id, { includePrivate: isOwner, managedStreamId: vodManagedStreamId });
        const clips = db.getClipsByUser(channel.user_id, isOwner, clipLimit, clipOffset) || [];
        const clipTotal = db.countClipsByUser(channel.user_id, isOwner);
        // Clips of this user's streams (by others)
        const clipsOfLimit = Math.min(Math.max(parseInt(req.query.clipsOfLimit || '12', 10), 1), 48);
        const clipsOfOffset = Math.max(parseInt(req.query.clipsOfOffset || '0', 10), 0);
        const clipsOfStreams = db.getClipsOfUserStreamsPaginated(channel.user_id, clipsOfLimit, clipsOfOffset) || [];
        const clipsOfTotal = db.countClipsOfUserStreams(channel.user_id);
        const followerCount = db.getFollowerCount(channel.user_id);
        const isFollowing = req.user ? db.isFollowing(req.user.id, channel.user_id) : false;
        // Managed streams for this channel
        const managedStreams = db.getManagedStreamsByUserId(channel.user_id) || [];

        // Include RS restream status for each live stream
        const rsInfo = {};
        const rsViewerCount = robotStreamerService.getRsViewerCount(channel.user_id);
        for (const ls of liveStreams) {
            const hasBridge = robotStreamerService.chatBridges.has(ls.id);
            const hasPublish = robotStreamerService._activePublish?.has(ls.id);
            if (hasBridge || hasPublish) {
                const integration = db.getRobotStreamerIntegrationByUserId(ls.user_id);
                rsInfo[ls.id] = {
                    active: true,
                    robot_id: integration?.robot_id || null,
                    robot_name: integration?.stream_name || integration?.robot_id || 'RS Robot',
                    chat_mirrored: hasBridge,
                    video_restreamed: !!hasPublish,
                    viewer_count: rsViewerCount,
                };
            }
        }

        // Include restream destination links (Twitch/Kick/YouTube) for live streams
        let restreamLinks = null;
        let externalViewers = null;
        if (liveStreams.length > 0) {
            const restreamManager = require('./restream-manager');
            const dests = db.getRestreamDestinationsByUserId(channel.user_id) || [];
            const enabledWithUrl = dests.filter(d => d.enabled && d.channel_url);
            if (enabledWithUrl.length > 0) {
                restreamLinks = enabledWithUrl.map(d => {
                    // Check if this destination is actively streaming
                    const streamStatuses = liveStreams.flatMap(ls => restreamManager.getStreamStatus(ls.id));
                    const activeSession = streamStatuses.find(s => s.destId === d.id && (s.status === 'live' || s.status === 'starting'));
                    const relayInfo = chatRelayService.getRelayInfo(liveStreams[0].id);
                    const hasRelay = relayInfo?.some(r => r.destId === d.id);

                    // Determine if actually live on the platform:
                    // - If we have a platform-level signal (Twitch Helix, Kick Pusher), use it
                    // - Otherwise fall back to session status with a 60s grace period for new sessions
                    let isLive = false;
                    if (activeSession) {
                        const platformLive = restreamManager.isPlatformLive(d.id);
                        if (platformLive != null) {
                            // We have a definitive platform signal — trust it
                            isLive = platformLive;
                        } else {
                            // No platform signal yet — show as live during grace period (first 60s)
                            const sessionAge = Date.now() - (activeSession.startedAt || Date.now());
                            isLive = sessionAge < 60000;
                        }
                    }

                    return {
                        platform: d.platform,
                        name: d.name,
                        channel_url: d.channel_url,
                        is_live: isLive,
                        chat_relayed: !!hasRelay,
                        viewer_count: restreamManager.getCachedViewerCount(d.id),
                    };
                });
            }

            // Build external viewers summary (Kick/Twitch/YouTube + RS)
            const ext = restreamManager.getExternalViewerCountsForUser(channel.user_id);
            const rsVc = rsViewerCount;
            const totalExternal = ext.total + rsVc;
            if (totalExternal > 0 || ext.breakdown.length > 0 || Object.keys(rsInfo).length > 0) {
                externalViewers = {
                    total: totalExternal,
                    platform_viewers: ext.breakdown,
                    rs_viewers: rsVc,
                };
            }
        }

        // Strip private fields from public channel response
        const publicChannel = { ...channel, follower_count: followerCount, is_following: isFollowing };
        delete publicChannel.weather_zip;
        delete publicChannel.stream_key;
        delete publicChannel.vod_recording_enabled;
        delete publicChannel.force_vod_recording_disabled;

        res.json({
            channel: publicChannel,
            stream: liveStreams[0] || null,
            streams: liveStreams,
            managed_streams: managedStreams,
            rs_restream: Object.keys(rsInfo).length ? rsInfo : null,
            restream_links: restreamLinks,
            external_viewers: externalViewers,
            vods,
            vodTotal,
            vodLimit,
            vodOffset,
            vodOrderBy,
            vodManagedStreamId: vodManagedStreamId || null,
            vodHasMore: vodOffset + vods.length < vodTotal,
            clips,
            clipTotal,
            clipLimit,
            clipOffset,
            clipHasMore: clipOffset + clips.length < clipTotal,
            clipsOfStreams,
            clipsOfTotal,
            clipsOfLimit,
            clipsOfOffset,
            clipsOfHasMore: clipsOfOffset + clipsOfStreams.length < clipsOfTotal,
        });
    } catch (err) {
        console.error('[Channels] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get channel' });
    }
});

// ── Lightweight live-only channel endpoint (fast player init) ──
// Returns ONLY the data needed to start the player — no VODs, clips, or heavy queries
router.get('/channel/:username/live', (req, res) => {
    try {
        const channel = db.getChannelByUsername(req.params.username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const liveStreams = db.getLiveStreamsByUserId(channel.user_id) || [];
        for (const liveStream of liveStreams) {
            // Use managed stream key from the JOIN, else fall back to user key
            const lsKey = liveStream.managed_stream_key
                || db.getUserById(liveStream.user_id)?.stream_key;
            if (liveStream.protocol === 'jsmpeg') {
                liveStream.endpoint = jsmpegRelay.getChannelInfo(lsKey);
            } else if (liveStream.protocol === 'webrtc') {
                liveStream.endpoint = { roomId: `stream-${liveStream.id}` };
            } else if (liveStream.protocol === 'rtmp') {
                liveStream.endpoint = {
                    flvUrl: `/api/streams/rtmp-proxy/${liveStream.id}.flv`,
                };
            }
            delete liveStream.stream_key;
            delete liveStream.managed_stream_key;
        }

        res.json({
            channel: { username: channel.username, display_name: channel.display_name, user_id: channel.user_id },
            streams: liveStreams,
        });
    } catch (err) {
        console.error('[Channels] Live-only error:', err.message);
        res.status(500).json({ error: 'Failed to get live stream data' });
    }
});

// ── Get Own Channel ──────────────────────────────────────────
router.get('/channel', requireAuth, (req, res) => {
    try {
        db.ensureChannel(req.user.id);
        const channel = db.getChannelByUserId(req.user.id);
        res.json(channel || {});
    } catch (err) {
        console.error('[Channels] Get own error:', err.message);
        res.status(500).json({ error: 'Failed to get channel' });
    }
});

// ── Update Own Channel ───────────────────────────────────────
router.put('/channel', requireAuth, (req, res) => {
    try {
        db.ensureChannel(req.user.id);
        const { is_nsfw, auto_record, vod_recording_enabled } = req.body;
        const title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH });
        const description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true });
        const category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH });
        const protocol = cleanProtocol(req.body.protocol);
        const panels = cleanPanels(req.body.panels);
        const defaultVodVisibility = cleanVisibility(req.body.default_vod_visibility);
        const defaultClipVisibility = cleanVisibility(req.body.default_clip_visibility);

        // Weather settings
        let weatherZip;
        if (hasOwn(req.body, 'weather_zip')) {
            const raw = (req.body.weather_zip || '').toString().trim();
            weatherZip = raw === '' ? null : raw.replace(/[^0-9a-zA-Z\s-]/g, '').slice(0, 10);
        }
        const ALLOWED_WEATHER_DETAIL = new Set(['off', 'basic', 'hourly', 'detailed']);
        let weatherDetail;
        if (hasOwn(req.body, 'weather_detail')) {
            const wd = (req.body.weather_detail || '').toString().trim();
            weatherDetail = ALLOWED_WEATHER_DETAIL.has(wd) ? wd : undefined;
        }

        if ((hasOwn(req.body, 'title') && title === null)
            || (hasOwn(req.body, 'description') && description === null)
            || (hasOwn(req.body, 'category') && category === null)
            || (hasOwn(req.body, 'protocol') && protocol === null)
            || (hasOwn(req.body, 'panels') && panels === null)
            || (hasOwn(req.body, 'default_vod_visibility') && defaultVodVisibility === null)
            || (hasOwn(req.body, 'default_clip_visibility') && defaultClipVisibility === null)) {
            return res.status(400).json({ error: 'Invalid channel settings' });
        }

        const fields = {};
        if (title !== undefined) fields.title = title;
        if (description !== undefined) fields.description = description;
        if (category !== undefined) fields.category = category;
        if (protocol !== undefined) fields.protocol = protocol;
        if (is_nsfw !== undefined) fields.is_nsfw = cleanBooleanFlag(is_nsfw) ? 1 : 0;
        if (auto_record !== undefined) fields.auto_record = cleanBooleanFlag(auto_record) ? 1 : 0;
        if (vod_recording_enabled !== undefined) {
            fields.vod_recording_enabled = cleanBooleanFlag(vod_recording_enabled) ? 1 : 0;
        }
        if (panels !== undefined) fields.panels = panels;
        if (defaultVodVisibility !== undefined) {
            fields.default_vod_visibility = defaultVodVisibility;
        }
        if (defaultClipVisibility !== undefined) {
            fields.default_clip_visibility = defaultClipVisibility;
        }
        if (weatherZip !== undefined) fields.weather_zip = weatherZip;
        if (weatherDetail !== undefined) fields.weather_detail = weatherDetail;
        if (hasOwn(req.body, 'weather_show_location')) {
            fields.weather_show_location = cleanBooleanFlag(req.body.weather_show_location) ? 1 : 0;
        }

        if (Object.keys(fields).length > 0) {
            db.updateChannel(req.user.id, fields);
        }

        const channel = db.getChannelByUserId(req.user.id);
        res.json({ channel });
    } catch (err) {
        console.error('[Channels] Update error:', err.message);
        res.status(500).json({ error: 'Failed to update channel' });
    }
});

// ── Weather for Channel (privacy-preserving) ─────────────────
const weatherCache = new Map(); // key: zip, value: { data, ts }
const WEATHER_CACHE_TTL = 15 * 60 * 1000; // 15 min
const GEOCODE_CACHE = new Map();

async function geocodeZip(zip) {
    if (GEOCODE_CACHE.has(zip)) return GEOCODE_CACHE.get(zip);
    try {
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(zip)}&count=1&language=en&format=json`;
        const resp = await fetch(url);
        const json = await resp.json();
        if (json.results && json.results.length > 0) {
            const r = json.results[0];
            const result = { lat: r.latitude, lon: r.longitude, name: r.name, region: r.admin1 || '', country: r.country_code || '' };
            GEOCODE_CACHE.set(zip, result);
            return result;
        }
    } catch (e) { console.warn('[Weather] Geocode error:', e.message); }
    // Fallback: try US zip via zip-coordinates API
    try {
        const url = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
        const resp = await fetch(url);
        if (resp.ok) {
            const json = await resp.json();
            const place = json.places?.[0];
            if (place) {
                const result = { lat: parseFloat(place.latitude), lon: parseFloat(place.longitude), name: place['place name'], region: place['state abbreviation'] || '', country: 'US' };
                GEOCODE_CACHE.set(zip, result);
                return result;
            }
        }
    } catch (e) { /* silent fallback */ }
    return null;
}

async function fetchWeather(zip) {
    const now = Date.now();
    const cached = weatherCache.get(zip);
    if (cached && (now - cached.ts) < WEATHER_CACHE_TTL) return cached.data;

    const geo = await geocodeZip(zip);
    if (!geo) return null;

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}`
            + `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,visibility,uv_index`
            + `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset`
            + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day`
            + `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`
            + `&timezone=auto&forecast_days=7`;
        const resp = await fetch(url);
        const data = await resp.json();
        const result = { ...data, location: { name: geo.name, region: geo.region, country: geo.country } };
        weatherCache.set(zip, { data: result, ts: now });
        return result;
    } catch (e) {
        console.warn('[Weather] Fetch error:', e.message);
        return null;
    }
}

router.get('/channel/:username/weather', async (req, res) => {
    try {
        const channel = db.getChannelByUsername(req.params.username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        if (!channel.weather_zip || channel.weather_detail === 'off') {
            return res.json({ enabled: false });
        }

        const weather = await fetchWeather(channel.weather_zip);
        if (!weather) return res.json({ enabled: false, error: 'Weather data unavailable' });

        const detail = channel.weather_detail || 'basic';

        // Shape response based on detail level — never expose zip code
        const response = { enabled: true, detail };
        // Include UTC offset so frontend can convert streamer-local times to viewer-local
        if (weather.utc_offset_seconds != null) response.utc_offset_seconds = weather.utc_offset_seconds;
        if (channel.weather_show_location) {
            response.location = weather.location;
        }

        // Current conditions (always included if not 'off')
        if (weather.current) {
            response.current = {
                temperature: weather.current.temperature_2m,
                feels_like: weather.current.apparent_temperature,
                humidity: weather.current.relative_humidity_2m,
                weather_code: weather.current.weather_code,
                wind_speed: weather.current.wind_speed_10m,
                wind_direction: weather.current.wind_direction_10m,
                is_day: weather.current.is_day,
            };
        }

        // Hourly forecast — amount depends on detail level
        if (weather.hourly && detail !== 'basic') {
            // Open-Meteo times are naive in the location's timezone.
            // Convert server "now" to the location's local time for comparison.
            const utcOff = weather.utc_offset_seconds || 0;
            const nowUtcMs = Date.now();
            const locationNowMs = nowUtcMs + utcOff * 1000;
            const locationNow = new Date(locationNowMs);
            // Compare as naive strings (YYYY-MM-DDTHH:MM) since hourly times have no TZ
            const locationNowIso = locationNow.toISOString().slice(0, 16);

            const times = weather.hourly.time;
            const startIdx = times.findIndex(t => t >= locationNowIso);
            const hours = detail === 'hourly' ? 8 : 24; // hourly=8h, detailed=24h
            const end = Math.min(startIdx + hours, times.length);

            response.hourly = [];
            for (let i = Math.max(0, startIdx); i < end; i++) {
                const entry = { time: weather.hourly.time[i], temperature: weather.hourly.temperature_2m[i], feels_like: weather.hourly.apparent_temperature[i], weather_code: weather.hourly.weather_code[i], precipitation_probability: weather.hourly.precipitation_probability[i], wind_speed: weather.hourly.wind_speed_10m[i] };
                if (detail === 'detailed') {
                    entry.humidity = weather.hourly.relative_humidity_2m[i];
                    entry.precipitation = weather.hourly.precipitation[i];
                    entry.wind_gusts = weather.hourly.wind_gusts_10m[i];
                    entry.wind_direction = weather.hourly.wind_direction_10m[i];
                    entry.cloud_cover = weather.hourly.cloud_cover[i];
                    entry.visibility = weather.hourly.visibility[i];
                    entry.uv_index = weather.hourly.uv_index[i];
                }
                response.hourly.push(entry);
            }
        }

        // 7-day daily forecast — included for hourly and detailed levels
        if (weather.daily && detail !== 'basic') {
            const d = weather.daily;
            response.daily = [];
            for (let i = 0; i < (d.time || []).length; i++) {
                response.daily.push({
                    date: d.time[i],
                    temp_max: d.temperature_2m_max[i],
                    temp_min: d.temperature_2m_min[i],
                    weather_code: d.weather_code[i],
                    precipitation_sum: d.precipitation_sum[i],
                    precipitation_probability: d.precipitation_probability_max[i],
                    wind_speed_max: d.wind_speed_10m_max[i],
                    sunrise: d.sunrise[i],
                    sunset: d.sunset[i],
                });
            }
        }

        res.json(response);
    } catch (err) {
        console.error('[Weather] Route error:', err.message);
        res.status(500).json({ error: 'Failed to fetch weather' });
    }
});

// ── List Live Streams ────────────────────────────────────────
router.get('/', optionalAuth, (req, res) => {
    try {
        const restreamManager = require('./restream-manager');
        const streams = db.getLiveStreams();
        const enriched = streams.map(s => {
            const channel = db.getChannelByUserId(s.user_id);
            // Add external viewer counts (Kick/Twitch/YouTube + RS) to each stream
            const ext = restreamManager.getExternalViewerCountsForUser(s.user_id);
            const rsVc = robotStreamerService.getRsViewerCount(s.user_id);
            const externalTotal = ext.total + rsVc;
            return {
                ...s,
                channel: channel || null,
                external_viewer_count: externalTotal,
                total_viewer_count: (s.viewer_count || 0) + externalTotal,
            };
        });
        res.json({ streams: enriched });
    } catch (err) {
        console.error('[Streams] List error:', err.message);
        res.status(500).json({ error: 'Failed to list streams' });
    }
});

// ── List My Streams (all streams for current user) ───────────
router.get('/mine', requireAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const streams = db.getStreamsByUserId(req.user.id, limit);
        res.json({ streams });
    } catch (err) {
        console.error('[Streams] My streams error:', err.message);
        res.status(500).json({ error: 'Failed to list streams' });
    }
});

// ── List Recently Ended Streams ──────────────────────────────
router.get('/recent', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '20'), 100);
        const streams = db.getRecentStreams(limit);
        const enriched = streams.map(s => {
            const channel = db.getChannelByUserId(s.user_id);
            return { ...s, channel: channel || null };
        });
        res.json({ streams: enriched });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to list recent streams' });
    }
});

// ── Recently Online (grouped by user) ────────────────────────
router.get('/recently-online', (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const streamers = db.getRecentlyOnlineStreamers(limit, offset);
        const total = db.countRecentlyOnlineStreamers();
        // Parse the JSON aggregate column; sort managed streams by last_live_at desc
        for (const s of streamers) {
            try {
                const parsed = JSON.parse(s.managed_streams_json || '[]');
                // Sort by most recently live first; put null last
                s.managed_streams = parsed.sort((a, b) => {
                    if (!a.last_live_at && !b.last_live_at) return 0;
                    if (!a.last_live_at) return 1;
                    if (!b.last_live_at) return -1;
                    return a.last_live_at < b.last_live_at ? 1 : -1;
                });
            } catch { s.managed_streams = []; }
            delete s.managed_streams_json;
        }
        res.json({ streamers, total, limit, offset, hasMore: offset + streamers.length < total });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to list recently online' });
    }
});

// ── Recent VODs ──────────────────────────────────────────────
router.get('/recent-vods', (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '12', 10), 1), 48);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const vods = db.getRecentVods(limit, offset);
        const total = db.countRecentVods();
        res.json({ vods, total, limit, offset, hasMore: offset + vods.length < total });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to list recent VODs' });
    }
});

/* ── Voice Channels (global, non-stream) ───────────────────── */

router.get('/voice-channels', (req, res) => {
    try {
        res.json({ channels: callServer.listChannels() });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to list voice channels' });
    }
});

router.get('/voice-channels/:channelId', (req, res) => {
    try {
        const ch = callServer.getChannel(req.params.channelId);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        res.json({ channel: ch });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to get voice channel' });
    }
});

router.post('/voice-channels', requireAuth, (req, res) => {
    try {
        const { name, mode, maxParticipants } = req.body;
        const ch = callServer.createChannel({ name, mode, createdBy: req.user.id, maxParticipants });
        res.status(201).json({ channel: ch });
    } catch (err) {
        if (err.code === 'CHANNEL_LIMIT') return res.status(400).json({ error: err.message });
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to create voice channel' });
    }
});

router.delete('/voice-channels/:channelId', requireAuth, (req, res) => {
    try {
        const ok = callServer.deleteChannel(req.params.channelId, req.user.id);
        if (!ok) return res.status(403).json({ error: 'Cannot delete this channel' });
        res.json({ deleted: true });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to delete voice channel' });
    }
});

router.post('/voice-channels/call-user', requireAuth, (req, res) => {
    try {
        const targetUserId = Number(req.body?.user_id || 0);
        const targetUsername = String(req.body?.username || '').trim();

        let targetUser = null;
        if (targetUserId > 0) targetUser = db.getUserById(targetUserId);
        if (!targetUser && targetUsername) targetUser = db.getUserByUsername(targetUsername);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        if (targetUser.id === req.user.id) return res.status(400).json({ error: 'You cannot call yourself' });

        // Reuse caller's existing temp channel if present; otherwise create one.
        const existing = (callServer.listChannels() || []).find(ch => !ch.permanent && !ch.streamId && ch.createdBy === req.user.id) || null;
        const channel = existing || callServer.createChannel({
            name: `${req.user.display_name || req.user.username}'s call`,
            mode: 'mic+cam',
            createdBy: req.user.id,
            maxParticipants: 8,
        });

        const callerName = req.user.display_name || req.user.username || 'Someone';
        const payload = {
            type: 'vc-call-invite',
            channelId: channel.id,
            channelName: channel.name,
            fromUserId: req.user.id,
            fromUsername: req.user.username,
            fromDisplayName: callerName,
            fromAvatarUrl: req.user.avatar_url || null,
            createdAt: Date.now(),
        };

        // Real-time invite for online users via existing chat WS connections.
        chatServer.sendDm(targetUser.id, payload);

        // Persistent cross-site notification for offline users / later join.
        pushNotification({
            user_id: targetUser.id,
            type: 'VC_CALL_INVITE',
            title: `${callerName} is calling you`,
            message: `Join voice channel: ${channel.name}`,
            url: `${config.baseUrl}/?vcInvite=${encodeURIComponent(channel.id)}`,
            rich_content: {
                context: {
                    channel_id: channel.id,
                    channel_name: channel.name,
                    caller_username: req.user.username,
                },
            },
            ...actorInfo(req.user, callerName),
        });

        return res.json({ invited: true, reusedChannel: !!existing, channel });
    } catch (err) {
        if (err.code === 'CHANNEL_LIMIT') return res.status(400).json({ error: err.message });
        console.error('[Streaming]', err.message);
        return res.status(500).json({ error: 'Failed to call user' });
    }
});

router.post('/voice-channels/call-user/respond', requireAuth, (req, res) => {
    try {
        const callerUserId = Number(req.body?.caller_user_id || 0);
        const channelId = String(req.body?.channel_id || '').trim();
        const channelName = String(req.body?.channel_name || 'Voice Channel').trim() || 'Voice Channel';
        const status = String(req.body?.status || '').trim().toLowerCase();

        const allowed = new Set(['accepted', 'declined', 'busy', 'no-answer', 'canceled']);
        if (!callerUserId) return res.status(400).json({ error: 'caller_user_id is required' });
        if (!channelId) return res.status(400).json({ error: 'channel_id is required' });
        if (!allowed.has(status)) return res.status(400).json({ error: 'Invalid response status' });
        if (callerUserId === req.user.id) return res.status(400).json({ error: 'Invalid caller target' });

        const fromDisplayName = req.user.display_name || req.user.username || 'Someone';
        chatServer.sendDm(callerUserId, {
            type: 'vc-call-response',
            status,
            channelId,
            channelName,
            fromUserId: req.user.id,
            fromUsername: req.user.username,
            fromDisplayName,
            fromAvatarUrl: req.user.avatar_url || null,
            createdAt: Date.now(),
        });

        return res.json({ ok: true });
    } catch (err) {
        console.error('[Streaming]', err.message);
        return res.status(500).json({ error: 'Failed to send call response' });
    }
});

// ── Broadcast Settings ──────────────────────────────────────
router.get('/broadcast-settings', requireAuth, (req, res) => {
    try {
        const managedStreamId = req.query.managed_stream_id ? parseInt(req.query.managed_stream_id) : null;
        if (managedStreamId) {
            const settings = db.getManagedStreamBroadcastSettings(managedStreamId, req.user.id);
            return res.json({ settings, managed_stream_id: managedStreamId });
        }
        // Fallback: return defaults when no managed stream specified
        res.json({
            settings: {},
        });
    } catch (err) {
        console.error('[Streaming] broadcast-settings error:', err.message);
        res.status(500).json({ error: 'Failed to get broadcast settings' });
    }
});

router.put('/broadcast-settings', requireAuth, (req, res) => {
    try {
        const managedStreamId = req.body.managed_stream_id ? parseInt(req.body.managed_stream_id) : null;
        if (!managedStreamId) {
            return res.status(400).json({ error: 'managed_stream_id is required' });
        }
        const managed = db.getManagedStreamById(managedStreamId);
        if (!managed || managed.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your managed stream' });
        }
        const settings = req.body.settings || {};
        db.updateManagedStreamBroadcastSettings(managedStreamId, req.user.id, settings);
        res.json({ settings, managed_stream_id: managedStreamId });
    } catch (err) {
        console.error('[Streaming] broadcast-settings save error:', err.message);
        res.status(500).json({ error: 'Failed to save broadcast settings' });
    }
});

// ── Channel Stream Resolution ────────────────────────────────
// Resolve a managed stream ref (slug or ID) to the currently live session for a channel.
// Used by the SPA to deep-link /@username/:managedStreamRef to the correct live stream.
router.get('/channel/:username/resolve/:ref', optionalAuth, (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '');
        const ref = req.params.ref;
        const channel = db.getChannelByUsername(username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        // Resolve the ref to a managed stream
        const managed = db.getManagedStreamByIdOrSlug(channel.user_id, ref);
        if (!managed) return res.status(404).json({ error: 'Managed stream not found' });

        // Find a live session linked to this managed stream
        const liveStreams = db.getLiveStreamsByUserId(channel.user_id);
        const liveSession = liveStreams.find(s => s.managed_stream_id === managed.id);

        res.json({
            managed_stream: {
                id: managed.id,
                slug: managed.slug,
                title: managed.title,
                protocol: managed.protocol,
            },
            live_stream_id: liveSession?.id || null,
            is_live: !!liveSession,
        });
    } catch (err) {
        console.error('[Streaming] resolve error:', err.message);
        res.status(500).json({ error: 'Failed to resolve stream' });
    }
});

// ── Managed Stream CRUD ──────────────────────────────────────

// Get past stream sessions for a managed stream (workspace history panel)
router.get('/managed/:managedStreamId/history', requireAuth, (req, res) => {
    const managedStreamId = parseInt(req.params.managedStreamId);
    if (!Number.isFinite(managedStreamId)) return res.status(400).json({ error: 'Invalid ID' });
    try {
        const sessions = db.getStreamHistoryByManagedStream(managedStreamId, req.user.id);
        res.json({ sessions });
    } catch (err) {
        console.error('[ManagedStreams] History error:', err.message);
        res.status(500).json({ error: 'Could not load history' });
    }
});

// ── Get full managed stream profile (structured fields + broadcast settings blob) ──
// Returned to the workspace panel for a single round-trip load.
router.get('/managed/:managedStreamId/profile', requireAuth, (req, res) => {
    const managedStreamId = parseInt(req.params.managedStreamId);
    if (!Number.isFinite(managedStreamId)) return res.status(400).json({ error: 'Invalid ID' });
    try {
        const ms = db.getManagedStreamById(managedStreamId);
        if (!ms) return res.status(404).json({ error: 'Managed stream not found' });
        if (ms.user_id !== req.user.id) return res.status(403).json({ error: 'Not your managed stream' });

        const broadcastSettings = db.getManagedStreamBroadcastSettings(managedStreamId, req.user.id);
        const { whipUrlBase, whipUrlSource, whipUrlWarning } = resolveWhipUrlBase(config, req);

        // Do NOT expose stream_key to the broader response — return it in a dedicated key
        // so the caller can display/copy it in the authenticated UI.
        const { stream_key: streamKey, ...msPublic } = ms;

        // Slot-level restream destinations
        const restreamDestinations = db.getRestreamDestinationsByManagedStream(managedStreamId);

        res.json({
            managed_stream: msPublic,
            stream_key: streamKey,
            broadcast_settings: broadcastSettings,
            whip_url_base: whipUrlBase,
            whip_url_source: whipUrlSource,
            whip_url_warning: whipUrlWarning,
            restream_destinations: restreamDestinations,
        });
    } catch (err) {
        console.error('[ManagedStreams] Profile error:', err.message);
        res.status(500).json({ error: 'Could not load profile' });
    }
});

// List own managed streams
router.get('/managed', requireAuth, (req, res) => {
    try {
        const managed = db.getManagedStreamsByUserId(req.user.id);
        const limit = db.getManagedStreamLimit(req.user);
        res.json({ managed_streams: managed, limit });
    } catch (err) {
        console.error('[ManagedStreams] List error:', err.message);
        res.status(500).json({ error: 'Failed to list managed streams' });
    }
});

// Create a managed stream
router.post('/managed', requireAuth, (req, res) => {
    try {
        const limit = db.getManagedStreamLimit(req.user);
        const count = db.countManagedStreamsByUser(req.user.id);
        if (count >= limit) {
            return res.status(403).json({ error: `Managed stream limit reached (${limit})` });
        }

        const title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH }) || 'Untitled Stream';
        const description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true }) || '';
        const category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH }) || 'irl';
        const protocol = cleanProtocol(req.body.protocol) || 'webrtc';
        const is_nsfw = cleanBooleanFlag(req.body.is_nsfw);
        let slug = req.body.slug ? req.body.slug.trim().toLowerCase() : null;

        if (slug) {
            if (!db.isValidManagedStreamSlug(slug)) {
                return res.status(400).json({ error: 'Invalid slug. Must be 2-32 chars, start with a letter, alphanumeric/hyphens/underscores only, not purely numeric.' });
            }
            if (db.isManagedStreamSlugTaken(req.user.id, slug)) {
                return res.status(409).json({ error: 'Slug already in use for your account' });
            }
        }

        const channel = db.ensureChannel(req.user.id);

        // Generate unique stream key for this managed stream
        const crypto = require('crypto');
        const stream_key = crypto.randomBytes(20).toString('hex');

        const result = db.createManagedStream({
            user_id: req.user.id,
            channel_id: channel.id,
            slug,
            title,
            description,
            category,
            protocol,
            streaming_method: cleanText(req.body.streaming_method, { maxLength: 20 }) || null,
            stream_key,
            is_nsfw,
            control_config_id: req.body.control_config_id ? parseInt(req.body.control_config_id) : null,
        });

        const managedStream = db.getManagedStreamById(result.lastInsertRowid);
        res.status(201).json({ managed_stream: managedStream });
    } catch (err) {
        console.error('[ManagedStreams] Create error:', err.message);
        res.status(500).json({ error: 'Failed to create managed stream' });
    }
});

// Update a managed stream
router.put('/managed/:id', requireAuth, (req, res) => {
    try {
        const msId = parseInt(req.params.id);
        const ms = db.getManagedStreamById(msId);
        if (!ms) return res.status(404).json({ error: 'Managed stream not found' });
        if (ms.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your managed stream' });
        }

        const fields = {};
        if (hasOwn(req.body, 'title')) {
            fields.title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH });
            if (fields.title === null) return res.status(400).json({ error: 'Invalid title' });
        }
        if (hasOwn(req.body, 'description')) {
            fields.description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true });
            if (fields.description === null) return res.status(400).json({ error: 'Invalid description' });
        }
        if (hasOwn(req.body, 'category')) {
            fields.category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH });
            if (fields.category === null) return res.status(400).json({ error: 'Invalid category' });
        }
        if (hasOwn(req.body, 'protocol')) {
            fields.protocol = cleanProtocol(req.body.protocol);
            if (fields.protocol === null) return res.status(400).json({ error: 'Invalid protocol' });
        }
        if (hasOwn(req.body, 'is_nsfw')) {
            fields.is_nsfw = cleanBooleanFlag(req.body.is_nsfw) ? 1 : 0;
        }
        if (hasOwn(req.body, 'tags')) {
            fields.tags = cleanTags(req.body.tags);
            if (fields.tags === null) return res.status(400).json({ error: 'Invalid tags' });
        }
        if (hasOwn(req.body, 'control_config_id')) {
            fields.control_config_id = req.body.control_config_id === null ? null : parseInt(req.body.control_config_id);
        }
        if (hasOwn(req.body, 'sort_order')) {
            fields.sort_order = parseInt(req.body.sort_order) || 0;
        }
        if (hasOwn(req.body, 'slug')) {
            const slug = req.body.slug ? req.body.slug.trim().toLowerCase() : null;
            if (slug) {
                if (!db.isValidManagedStreamSlug(slug)) {
                    return res.status(400).json({ error: 'Invalid slug format' });
                }
                if (db.isManagedStreamSlugTaken(req.user.id, slug, msId)) {
                    return res.status(409).json({ error: 'Slug already in use' });
                }
            }
            fields.slug = slug;
        }

        // Slot-level settings
        if (hasOwn(req.body, 'streaming_method')) {
            const validMethods = new Set(['browser', 'whip', 'cli', 'rtmp']);
            const method = String(req.body.streaming_method || '').trim().toLowerCase();
            if (!validMethods.has(method)) return res.status(400).json({ error: 'Invalid streaming_method' });
            fields.streaming_method = method;
            // Auto-derive protocol from method
            if (method === 'browser' || method === 'whip') fields.protocol = 'webrtc';
            else if (method === 'cli') fields.protocol = 'jsmpeg';
            else if (method === 'rtmp') fields.protocol = 'rtmp';
        }
        if (hasOwn(req.body, 'browser_mode')) {
            const validModes = new Set(['camera', 'camera_only', 'mic_only', 'screen']);
            const mode = String(req.body.browser_mode || '').trim().toLowerCase();
            if (!validModes.has(mode)) return res.status(400).json({ error: 'Invalid browser_mode' });
            fields.browser_mode = mode;
        }
        if (hasOwn(req.body, 'default_vod_visibility')) {
            const vis = String(req.body.default_vod_visibility || 'public').trim().toLowerCase();
            fields.default_vod_visibility = vis === 'private' ? 'private' : 'public';
        }
        if (hasOwn(req.body, 'default_clip_visibility')) {
            const vis = String(req.body.default_clip_visibility || 'public').trim().toLowerCase();
            fields.default_clip_visibility = vis === 'private' ? 'private' : 'public';
        }
        if (hasOwn(req.body, 'slot_vod_recording_enabled')) {
            fields.slot_vod_recording_enabled = cleanBooleanFlag(req.body.slot_vod_recording_enabled) ? 1 : 0;
        }
        if (hasOwn(req.body, 'weather_zip')) {
            fields.weather_zip = req.body.weather_zip ? String(req.body.weather_zip).trim().slice(0, 20) : null;
        }
        if (hasOwn(req.body, 'weather_detail')) {
            const detail = String(req.body.weather_detail || 'basic').trim().toLowerCase();
            fields.weather_detail = ['basic', 'detailed', 'off'].includes(detail) ? detail : 'basic';
        }
        if (hasOwn(req.body, 'weather_show_location')) {
            fields.weather_show_location = cleanBooleanFlag(req.body.weather_show_location) ? 1 : 0;
        }
        if (hasOwn(req.body, 'mic_only_image')) {
            fields.mic_only_image = req.body.mic_only_image ? String(req.body.mic_only_image).trim().slice(0, 500) : null;
        }

        db.updateManagedStream(msId, ms.user_id, fields);
        const updated = db.getManagedStreamById(msId);
        res.json({ managed_stream: updated });
    } catch (err) {
        console.error('[ManagedStreams] Update error:', err.message);
        res.status(500).json({ error: 'Failed to update managed stream' });
    }
});

// Delete a managed stream
router.delete('/managed/:id', requireAuth, (req, res) => {
    try {
        const msId = parseInt(req.params.id);
        const ms = db.getManagedStreamById(msId);
        if (!ms) return res.status(404).json({ error: 'Managed stream not found' });
        if (ms.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your managed stream' });
        }

        // Prevent deleting a managed stream that has an active live session
        const liveSessions = db.getLiveStreamsByUserId(ms.user_id) || [];
        const isLive = liveSessions.some(s => s.managed_stream_id === msId);
        if (isLive) {
            return res.status(409).json({ error: 'Cannot delete a managed stream that is currently live. End the stream first.' });
        }

        db.deleteManagedStream(msId, ms.user_id);
        res.json({ message: 'Managed stream deleted' });
    } catch (err) {
        console.error('[ManagedStreams] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete managed stream' });
    }
});

// Regenerate stream key for a managed stream
router.post('/managed/:id/regenerate-key', requireAuth, (req, res) => {
    try {
        const msId = parseInt(req.params.id);
        const ms = db.getManagedStreamById(msId);
        if (!ms) return res.status(404).json({ error: 'Managed stream not found' });
        if (ms.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your managed stream' });
        }

        const crypto = require('crypto');
        const newKey = crypto.randomBytes(20).toString('hex');
        db.run('UPDATE managed_streams SET stream_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newKey, msId]);
        res.json({ stream_key: newKey });
    } catch (err) {
        console.error('[ManagedStreams] Regenerate key error:', err.message);
        res.status(500).json({ error: 'Failed to regenerate key' });
    }
});

// ── Get Stream Details ───────────────────────────────────────
router.get('/:id', optionalAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });

        delete stream.stream_key;
        delete stream.managed_stream_key;

        if (stream.is_live) {
            if (stream.protocol === 'jsmpeg') {
                const jsmpegKey = stream.managed_stream_key || db.getUserById(stream.user_id)?.stream_key;
                stream.endpoint = jsmpegRelay.getChannelInfo(jsmpegKey);
            } else if (stream.protocol === 'webrtc') {
                stream.endpoint = { roomId: `stream-${stream.id}` };
            } else if (stream.protocol === 'rtmp') {
                stream.endpoint = {
                    flvUrl: `/api/streams/rtmp-proxy/${stream.id}.flv`,
                };
            }
        }

        stream.cameras = db.all('SELECT * FROM cameras WHERE stream_id = ?', [stream.id]);
        stream.controls = db.getStreamControls(stream.id);
        stream.channel = db.getChannelByUserId(stream.user_id) || null;

        if (req.user) stream.isFollowing = db.isFollowing(req.user.id, stream.user_id);
        stream.follower_count = db.getFollowerCount(stream.user_id);

        res.json({ stream });
    } catch (err) {
        console.error('[Streams] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get stream' });
    }
});

// ── Start a New Stream (Go Live) ─────────────────────────────
router.post('/', requireAuth, (req, res) => {
    try {
        const managedStreamId = req.body.managed_stream_id ? parseInt(req.body.managed_stream_id) : null;

        // Look up managed stream — no auto-creation
        let managedStream = null;
        if (managedStreamId) {
            managedStream = db.getManagedStreamById(managedStreamId);
            if (!managedStream) return res.status(404).json({ error: 'Managed stream not found' });
            if (managedStream.user_id !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Not your managed stream' });
            }
        } else {
            // Auto-select first managed stream (but never auto-create)
            const existing = db.getManagedStreamsByUserId(req.user.id);
            if (existing.length > 0) {
                managedStream = existing[0];
            } else {
                return res.status(400).json({ error: 'Create a stream slot first' });
            }
        }

        const title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH });
        const description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true });
        const category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH });
        const protocol = cleanProtocol(req.body.protocol);
        const tags = cleanTags(req.body.tags);
        const callMode = cleanCallMode(req.body.call_mode);

        if ((hasOwn(req.body, 'title') && title === null)
            || (hasOwn(req.body, 'description') && description === null)
            || (hasOwn(req.body, 'category') && category === null)
            || (hasOwn(req.body, 'protocol') && protocol === null)
            || (hasOwn(req.body, 'tags') && tags === null)
            || (hasOwn(req.body, 'call_mode') && callMode === null)) {
            return res.status(400).json({ error: 'Invalid stream settings' });
        }

        const channel = db.ensureChannel(req.user.id);

        // Streamer role promotion deferred — applied on first real feed ingest
        // (see whip-handler.js, webrtc-sfu producer, jsmpeg relay, rtmp handler)

        // Use managed stream's settings as defaults, allow per-session overrides
        const streamProtocol = protocol || cleanProtocol(managedStream.protocol) || cleanProtocol(channel.protocol) || 'webrtc';
        const streamCategory = category || cleanText(managedStream.category, { maxLength: MAX_CATEGORY_LENGTH }) || cleanText(channel.category, { maxLength: MAX_CATEGORY_LENGTH }) || 'irl';
        const requestedControlConfigId = req.body.control_config_id !== undefined ? (req.body.control_config_id === null ? null : parseInt(req.body.control_config_id)) : undefined;

        if (requestedControlConfigId !== undefined && requestedControlConfigId !== null) {
            const config = db.getControlConfig(requestedControlConfigId);
            if (!config) {
                return res.status(404).json({ error: 'Control config not found' });
            }
            if (config.user_id !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Not authorized for this control profile' });
            }
        }

        const result = db.createStream({
            user_id: req.user.id,
            channel_id: channel.id,
            managed_stream_id: managedStream.id,
            control_config_id: requestedControlConfigId !== undefined ? requestedControlConfigId : (managedStream.control_config_id || null),
            title: title || cleanText(managedStream.title, { maxLength: MAX_TITLE_LENGTH }) || `${req.user.display_name}'s Stream`,
            description: description ?? cleanText(managedStream.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true }) ?? '',
            category: streamCategory,
            protocol: streamProtocol,
            is_nsfw: channel.force_nsfw ? 1 : (hasOwn(req.body, 'is_nsfw') ? cleanBooleanFlag(req.body.is_nsfw) : !!channel.is_nsfw),
        });

        const streamId = result.lastInsertRowid;

        // Initialize heartbeat
        db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);

        if (tags && tags.length > 0) {
            db.run('UPDATE streams SET tags = ? WHERE id = ?', [JSON.stringify(tags), streamId]);
        }

        // Set call mode if provided — create a stream voice channel
        if (callMode) {
            db.run('UPDATE streams SET call_mode = ? WHERE id = ?', [callMode, streamId]);
            callServer.createStreamChannel(streamId, callMode, req.user.id);
        }

        let endpoint = {};
        if (streamProtocol === 'jsmpeg') {
            endpoint = jsmpegRelay.createChannel(managedStream.stream_key);
        } else if (streamProtocol === 'webrtc') {
            endpoint = { roomId: `stream-${streamId}` };
        }

        db.run(
            `INSERT INTO cameras (stream_id, camera_index, label, protocol) VALUES (?, 0, 'Main', ?)`,
            [streamId, streamProtocol]
        );

        // Apply the selected per-stream control config if provided.
        if (requestedControlConfigId !== undefined) {
            if (requestedControlConfigId !== null) {
                try {
                    const applied = db.applyConfigToStream(requestedControlConfigId, streamId);
                    console.log(`[Streams] Applied explicit control config ${requestedControlConfigId} to stream ${streamId} (${applied} buttons)`);
                } catch (cfgErr) {
                    console.warn(`[Streams] Failed to apply explicit control config:`, cfgErr.message);
                }
            }
        } else if (channel.active_control_config_id) {
            // No explicit per-stream selection: use the channel default for this new stream
            try {
                const applied = db.applyConfigToStream(channel.active_control_config_id, streamId);
                console.log(`[Streams] Auto-applied channel default control config ${channel.active_control_config_id} to stream ${streamId} (${applied} buttons)`);
            } catch (cfgErr) {
                console.warn(`[Streams] Failed to auto-apply channel default control config:`, cfgErr.message);
            }
        }

        const stream = db.getStreamById(streamId);
        robotStreamerService.startForStream(stream).catch((rsErr) => {
            console.warn(`[RS] Failed to start integration for stream ${streamId}:`, rsErr.message);
        });
        chatRelayService.startForStream(stream).catch((relayErr) => {
            console.warn(`[ChatRelay] Failed to start relay for stream ${streamId}:`, relayErr.message);
        });

        // Notify followers that this streamer went live (fire-and-forget)
        notifyFollowersGoLive(req.user, stream);

        res.status(201).json({ stream, endpoint });
    } catch (err) {
        console.error('[Streams] Create error:', err.message);
        res.status(500).json({ error: 'Failed to create stream' });
    }
});

// ── Update Stream Info ───────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }

        const title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH });
        const description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true });
        const category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH });
        const tags = cleanTags(req.body.tags);

        if ((hasOwn(req.body, 'title') && title === null)
            || (hasOwn(req.body, 'description') && description === null)
            || (hasOwn(req.body, 'category') && category === null)
            || (hasOwn(req.body, 'tags') && tags === null)) {
            return res.status(400).json({ error: 'Invalid stream update' });
        }

        const updates = [];
        const params = [];

        if (title !== undefined) { updates.push('title = ?'); params.push(title); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (category !== undefined) { updates.push('category = ?'); params.push(category); }
        if (hasOwn(req.body, 'is_nsfw')) {
            // Admin force_nsfw cannot be overridden by streamer
            const channel = db.getChannelByUserId(req.user.id);
            if (channel && channel.force_nsfw) {
                updates.push('is_nsfw = 1');
            } else {
                updates.push('is_nsfw = ?'); params.push(cleanBooleanFlag(req.body.is_nsfw) ? 1 : 0);
            }
        }
        if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }

        if (updates.length > 0) {
            params.push(req.params.id);
            db.run(`UPDATE streams SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        const updated = db.getStreamById(req.params.id);
        res.json({ stream: updated });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to update stream' });
    }
});

// ── End a Stream ─────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }

        db.endStream(stream.id);

        // Stop server-side recording (RTMP is handled in rtmp-server.js, but JSMPEG needs it here)
        if (stream.protocol === 'jsmpeg') {
            recorder.stopRecording(stream.id);
        }

        // Auto-finalize VOD recording server-side (catches cases where client didn't finalize)
        const vodRoutes = require('../vod/routes');
        vodRoutes.finalizeVodRecording(stream.id).catch(err => {
            console.warn(`[VOD] Auto-finalize on stream end failed for ${stream.id}:`, err.message);
        });

        const user = db.getUserById(stream.user_id);
        const endKey = stream.managed_stream_key || user.stream_key;
        if (stream.protocol === 'jsmpeg') {
            jsmpegRelay.destroyChannel(endKey);
        } else if (stream.protocol === 'webrtc') {
            webrtcSFU.closeRoom(`stream-${stream.id}`);
        }

        // End any active group call / remove stream voice channel
        callServer.removeStreamChannel(stream.id);

        robotStreamerService.stopForStream(stream.id);
        chatRelayService.stopForStream(stream.id);

        // Close signaling room and notify viewers
        const broadcastServer = require('./broadcast-server');
        broadcastServer.endStream(stream.id);

        res.json({ message: 'Stream ended' });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to end stream' });
    }
});

// ── Get Streaming Endpoint Info ──────────────────────────────
router.get('/:id/endpoint', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }

        const user = db.getUserById(stream.user_id);
        // Use managed stream key from the JOIN, else fallback to user key
        const msKey = stream.managed_stream_key || user.stream_key;
        let endpoint = {};

        const hostname = config.host === '0.0.0.0' ? req.hostname : config.host;

        if (stream.protocol === 'jsmpeg') {
            endpoint = jsmpegRelay.getChannelInfo(msKey) || jsmpegRelay.createChannel(msKey);

            // Start server-side VOD recording for JSMPEG (taps the relay WebSocket, zero delay to live)
            const vodPolicy = db.getChannelVodRecordingPolicyByUserId(stream.user_id);
            if (stream.is_live && vodPolicy.recordingEnabled && !recorder.isRecording(stream.id)) {
                recorder.startRecording(stream.id, 'jsmpeg', {
                    streamKey: msKey,
                    videoPort: endpoint.videoPort,
                });
            }

            const jsmpegOrigin = new URL(config.jsmpeg.publicUrl || `http://${hostname}`);
            const videoUrl = new URL(`${msKey}/640/480/`, jsmpegOrigin);
            videoUrl.port = endpoint.videoPort;
            const urlHD = new URL(`${msKey}/1280/720/`, jsmpegOrigin);
            urlHD.port = endpoint.videoPort;
            const audioUrl = new URL(`${msKey}/`, jsmpegOrigin);
            audioUrl.port = endpoint.audioPort;
            const lowLatencyFlags = '-fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0 -muxdelay 0.001 -flush_packets 1';
            endpoint.ffmpegCommand = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f v4l2 -framerate 24 -i /dev/video0 -thread_queue_size 512 -f alsa -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -maxrate 350k -bufsize 700k -g 12 -bf 0 -codec:a mp2 -b:a 96k -ar 44100 -ac 1 ${videoUrl}`;
            endpoint.ffmpegVideoOnly = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f v4l2 -framerate 24 -i /dev/video0 -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -maxrate 350k -bufsize 700k -g 12 -bf 0 ${videoUrl}`;
            endpoint.ffmpegScreen = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f x11grab -s 1920x1080 -r 20 -i :0.0 -thread_queue_size 512 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 450k -maxrate 450k -bufsize 900k -g 10 -bf 0 -codec:a mp2 -b:a 96k -ar 44100 -ac 1 ${videoUrl}`;
            endpoint.ffmpegOBS = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f v4l2 -framerate 24 -i /dev/video2 -thread_queue_size 512 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 450k -maxrate 450k -bufsize 900k -g 12 -bf 0 -codec:a mp2 -b:a 96k -ar 44100 -ac 1 ${videoUrl}`;
            endpoint.ffmpegAudioOnly = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f alsa -i default -f mpegts -codec:a mp2 -b:a 96k -ar 44100 -ac 1 ${audioUrl}`;
            endpoint.ffmpegHD = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f v4l2 -video_size 1280x720 -framerate 30 -i /dev/video0 -thread_queue_size 512 -f alsa -i default -f mpegts -codec:v mpeg1video -s 1280x720 -b:v 1200k -maxrate 1200k -bufsize 2400k -r 30 -g 15 -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 2 ${urlHD}`;
        } else if (stream.protocol === 'webrtc') {
            const { whipUrlBase, whipUrlSource, whipUrlWarning } = resolveWhipUrlBase(config, req);
            endpoint = {
                roomId: `stream-${stream.id}`,
                signalingUrl: `/ws/broadcast?streamId=${stream.id}`,
                whipUrlBase,
                whipUrlSource,
                ...(whipUrlWarning ? { whipUrlWarning } : {}),
            };
        } else if (stream.protocol === 'rtmp') {
            const rtmpHost = config.rtmp.host || (() => {
                try { return new URL(config.baseUrl).hostname; } catch { return hostname; }
            })();
            endpoint = {
                rtmpUrl: `rtmp://${rtmpHost}:${config.rtmp.port}/live`,
                streamKey: msKey,
                flvUrl: `/api/streams/rtmp-proxy/${stream.id}.flv`,
            };
        }

        res.json({ endpoint, stream_key: msKey });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to get endpoint' });
    }
});

// ── Stream Heartbeat ─────────────────────────────────────────
router.post('/:id/heartbeat', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) return res.status(400).json({ error: 'Stream is not live' });

        db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [stream.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Heartbeat failed' });
    }
});

// ── RTMP Feed Status ─────────────────────────────────────────
router.get('/:id/rtmp-status', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (stream.protocol !== 'rtmp') {
            return res.status(400).json({ error: 'Not an RTMP stream' });
        }
        const rtmpKey = stream.managed_stream_key || db.getUserById(stream.user_id)?.stream_key;
        const rtmpServer = require('./rtmp-server');
        const status = rtmpServer.getStatus(rtmpKey);
        res.json(status);
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to check RTMP status' });
    }
});

// ── Follow/Unfollow Streamer ─────────────────────────────────
router.post('/:id/follow', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });

        if (db.isFollowing(req.user.id, stream.user_id)) {
            db.unfollowUser(req.user.id, stream.user_id);
            res.json({ following: false, count: db.getFollowerCount(stream.user_id) });
        } else {
            db.followUser(req.user.id, stream.user_id);
            // Award Hobo Coins for following
            try {
                const hoboCoins = require('../monetization/hobo-coins');
                hoboCoins.awardFollow(req.user.id, stream.user_id);
            } catch { /* non-critical */ }
            // Notify the followed user
            try {
                const { pushNotification, actorInfo } = require('../utils/notify');
                const follower = db.getUserById(req.user.id);
                pushNotification({
                    user_id: stream.user_id,
                    type: 'FOLLOW',
                    title: 'New Follower',
                    message: `${follower?.display_name || follower?.username || 'Someone'} followed you`,
                    url: `${config.baseUrl}/${follower?.username || ''}`,
                    ...actorInfo(follower),
                });
            } catch { /* non-critical */ }
            res.json({ following: true, count: db.getFollowerCount(stream.user_id) });
        }
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to follow/unfollow' });
    }
});

// ── Follow/Unfollow by Username ──────────────────────────────
router.post('/channel/:username/follow', requireAuth, (req, res) => {
    try {
        const user = db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (db.isFollowing(req.user.id, user.id)) {
            db.unfollowUser(req.user.id, user.id);
            res.json({ following: false, count: db.getFollowerCount(user.id) });
        } else {
            db.followUser(req.user.id, user.id);
            // Award Hobo Coins for following
            try {
                const hoboCoins = require('../monetization/hobo-coins');
                hoboCoins.awardFollow(req.user.id, user.id);
            } catch { /* non-critical */ }
            // Notify the followed user
            try {
                const { pushNotification, actorInfo } = require('../utils/notify');
                const follower = db.getUserById(req.user.id);
                pushNotification({
                    user_id: user.id,
                    type: 'FOLLOW',
                    title: 'New Follower',
                    message: `${follower?.display_name || follower?.username || 'Someone'} followed you`,
                    url: `${config.baseUrl}/${follower?.username || ''}`,
                    ...actorInfo(follower),
                });
            } catch { /* non-critical */ }
            res.json({ following: true, count: db.getFollowerCount(user.id) });
        }
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to follow/unfollow' });
    }
});

// ── Group Call: Enable / Disable / Get Status ────────────────
const callServer = require('./call-server');

router.put('/:id/call', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) {
            return res.status(400).json({ error: 'Stream is not live' });
        }

        const { call_mode } = req.body;
        const validModes = ['mic', 'mic+cam', 'cam+mic', null];
        if (!validModes.includes(call_mode)) {
            return res.status(400).json({ error: 'Invalid call mode. Use: mic, mic+cam, cam+mic, or null to disable' });
        }

        db.run('UPDATE streams SET call_mode = ? WHERE id = ?', [call_mode, stream.id]);

        // Create or remove stream voice channel
        const channelId = `stream-${stream.id}`;
        if (call_mode) {
            callServer.createStreamChannel(stream.id, call_mode, stream.user_id);
        } else {
            callServer.removeStreamChannel(stream.id);
        }

        res.json({
            call_mode,
            channelId: call_mode ? channelId : null,
            participants: callServer.getParticipants(channelId),
            participant_count: callServer.getParticipantCount(channelId),
        });
    } catch (err) {
        console.error('[Streams] Call mode error:', err.message);
        res.status(500).json({ error: 'Failed to update call mode' });
    }
});

router.get('/:id/call', optionalAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        const channelId = `stream-${stream.id}`;

        res.json({
            call_mode: stream.call_mode || null,
            channelId: stream.call_mode ? channelId : null,
            participants: callServer.getParticipants(channelId),
            participant_count: callServer.getParticipantCount(channelId),
        });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to get call status' });
    }
});

// ── RTMP FLV Proxy ───────────────────────────────────────────
// Proxies HTTP-FLV from the internal NMS server so the browser fetches
// from the same HTTPS origin, avoiding CSP / mixed-content issues.
router.get('/rtmp-proxy/:streamId.flv', (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || !stream.is_live || stream.protocol !== 'rtmp') {
            return res.status(404).end();
        }
        const flvKey = stream.managed_stream_key || db.getUserById(stream.user_id)?.stream_key;
        if (!flvKey) return res.status(404).end();

        const nmsPort = config.rtmp.port + 8000;
        const url = `http://127.0.0.1:${nmsPort}/live/${flvKey}.flv`;

        const http = require('http');
        const upstream = http.get(url, (nmsRes) => {
            if (nmsRes.statusCode !== 200) {
                res.status(502).end();
                nmsRes.resume();
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'video/x-flv',
                'Cache-Control': 'no-cache, no-store',
                'Transfer-Encoding': 'chunked',
                'Access-Control-Allow-Origin': '*',
            });
            nmsRes.pipe(res);
        });
        upstream.on('error', () => res.status(502).end());
        req.on('close', () => upstream.destroy());
    } catch (err) {
        console.error('[FLV Proxy]', err.message);
        if (!res.headersSent) res.status(500).end();
    }
});

module.exports = router;
