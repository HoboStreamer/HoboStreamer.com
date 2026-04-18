/**
 * HoboStreamer — Config
 *
 * Loads defaults from env, then resolves registry overrides from hobo.tools
 * when available. Registry overrides take precedence over env values.
 */
require('dotenv').config();

const { resolveRegistryValues, URL_DEFINITIONS } = require('hobo-shared/url-resolver');

const DEFAULTS = {
    BASE_URL: 'http://localhost:3000',
    WEBRTC_PUBLIC_URL: 'http://localhost:3000',
    WHIP_PUBLIC_URL: 'http://localhost:3000',
    JSMPEG_PUBLIC_URL: 'http://localhost:3000',
    MEDIASOUP_ANNOUNCED_IP: 'localhost',
    RTMP_HOST: '',
    TURN_URL: '',
    HOBO_TOOLS_INTERNAL_URL: 'http://127.0.0.1:3100',
};

function buildConfig(registryValues) {
    const baseUrl = registryValues.BASE_URL.source !== 'default' ? registryValues.BASE_URL.value : DEFAULTS.BASE_URL;
    const whipPublicUrl = registryValues.WHIP_PUBLIC_URL.source !== 'default'
        ? registryValues.WHIP_PUBLIC_URL.value
        : (registryValues.BASE_URL.source !== 'default' ? registryValues.BASE_URL.value : DEFAULTS.WHIP_PUBLIC_URL);
    const webRtcPublicUrl = registryValues.WEBRTC_PUBLIC_URL.source !== 'default'
        ? registryValues.WEBRTC_PUBLIC_URL.value
        : (registryValues.BASE_URL.source !== 'default'
            ? registryValues.BASE_URL.value
            : (registryValues.WHIP_PUBLIC_URL.source !== 'default'
                ? registryValues.WHIP_PUBLIC_URL.value
                : DEFAULTS.WEBRTC_PUBLIC_URL));
    const jsmpegPublicUrl = registryValues.JSMPEG_PUBLIC_URL.source !== 'default'
        ? registryValues.JSMPEG_PUBLIC_URL.value
        : (registryValues.BASE_URL.source !== 'default' ? registryValues.BASE_URL.value : DEFAULTS.JSMPEG_PUBLIC_URL);
    const mediasoupAnnouncedIp = process.env.MEDIASOUP_ANNOUNCED_IP
        || (registryValues.MEDIASOUP_ANNOUNCED_IP.source !== 'default' ? registryValues.MEDIASOUP_ANNOUNCED_IP.value : new URL(baseUrl).hostname);

    const baseUrlSource = registryValues.BASE_URL.source || 'default';
    const webRtcSource = registryValues.WEBRTC_PUBLIC_URL.source !== 'default'
        ? registryValues.WEBRTC_PUBLIC_URL.source
        : (registryValues.BASE_URL.source !== 'default'
            ? registryValues.BASE_URL.source
            : (registryValues.WHIP_PUBLIC_URL.source !== 'default'
                ? registryValues.WHIP_PUBLIC_URL.source
                : 'default'));
    const whipSource = registryValues.WHIP_PUBLIC_URL.source !== 'default'
        ? registryValues.WHIP_PUBLIC_URL.source
        : registryValues.BASE_URL.source;
    const mediaSoupSource = registryValues.MEDIASOUP_ANNOUNCED_IP.source !== 'default'
        ? registryValues.MEDIASOUP_ANNOUNCED_IP.source
        : 'default';

    console.log('[Config] Effective URLs:');
    console.log('[Config]  BASE_URL=', baseUrl, `(${baseUrlSource})`);
    console.log('[Config]  WEBRTC_PUBLIC_URL=', webRtcPublicUrl, `(${webRtcSource})`);
    console.log('[Config]  WHIP_PUBLIC_URL=', whipPublicUrl, `(${whipSource})`);
    console.log('[Config]  MEDIASOUP_ANNOUNCED_IP=', mediasoupAnnouncedIp, `(${mediaSoupSource})`);

    return {
        port: parseInt(process.env.PORT || '3000', 10),
        host: process.env.HOST || '0.0.0.0',
        baseUrl,
        nodeEnv: process.env.NODE_ENV || 'development',
        internalApiKey: process.env.INTERNAL_API_KEY || process.env.HOBO_INTERNAL_KEY || '',
        webrtc: {
            publicUrl: webRtcPublicUrl,
        },
        whip: {
            publicUrl: whipPublicUrl,
        },
        hoboToolsInternalUrl: registryValues.HOBO_TOOLS_INTERNAL_URL.value || DEFAULTS.HOBO_TOOLS_INTERNAL_URL,
        rtmp: {
            port: parseInt(process.env.RTMP_PORT || '1935', 10),
            chunkSize: parseInt(process.env.RTMP_CHUNK_SIZE || '60000', 10),
            host: process.env.RTMP_HOST || registryValues.RTMP_HOST.value || '',
        },
        turn: {
            url: process.env.TURN_URL || registryValues.TURN_URL.value || '',
            username: process.env.TURN_USERNAME || '',
            credential: process.env.TURN_CREDENTIAL || '',
        },
        mediasoup: {
            listenIp: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
            announcedIp: mediasoupAnnouncedIp,
            minPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '10000', 10),
            maxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '10100', 10),
            webrtcPort: parseInt(process.env.WEBRTC_PORT || '4443', 10),
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    parameters: { 'x-google-start-bitrate': 1000 },
                },
                {
                    kind: 'video',
                    mimeType: 'video/H264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '42e01f',
                        'level-asymmetry-allowed': 1,
                    },
                },
            ],
        },
        adminUsername: process.env.ADMIN_USERNAME || 'admin',
        adminPassword: process.env.ADMIN_PASSWORD || 'changeme123',
        jwt: {
            secret: process.env.JWT_SECRET || 'hobostreamer-dev-secret-change-me',
            expiresIn: '7d',
        },
        db: {
            path: process.env.DB_PATH || './data/hobostreamer.db',
        },
        jsmpeg: {
            publicUrl: jsmpegPublicUrl,
            videoPort: parseInt(process.env.JSMPEG_VIDEO_PORT || '9710', 10),
            audioPort: parseInt(process.env.JSMPEG_AUDIO_PORT || '9711', 10),
        },
        hoboBucks: {
            minCashout: parseFloat(process.env.MIN_CASHOUT || '5.00'),
            escrowDays: parseInt(process.env.ESCROW_HOLD_DAYS || '14', 10),
        },
        vod: {
            path: process.env.VOD_PATH || './data/vods',
            coldPath: process.env.COLD_STORAGE_PATH || '',
            clipsPath: process.env.CLIPS_PATH || './data/clips',
            maxSizeMb: parseInt(process.env.MAX_VOD_SIZE_MB || '2048', 10),
        },
        thumbnails: {
            path: process.env.THUMBNAILS_PATH || './data/thumbnails',
        },
        emotes: {
            path: process.env.EMOTES_PATH || './data/emotes',
            maxSizeKb: parseInt(process.env.MAX_EMOTE_SIZE_KB || '256', 10),
            maxPerUser: parseInt(process.env.MAX_EMOTES_PER_USER || '50', 10),
            ffzCacheTtl: parseInt(process.env.FFZ_CACHE_TTL || '3600', 10),
            bttvCacheTtl: parseInt(process.env.BTTV_CACHE_TTL || '3600', 10),
            sevenTvCacheTtl: parseInt(process.env.SEVENTV_CACHE_TTL || '3600', 10),
        },
        paypal: {
            clientId: process.env.PAYPAL_CLIENT_ID || '',
            clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
            mode: process.env.PAYPAL_MODE || 'sandbox',
        },
    };
}

const initialRegistry = resolveRegistryValues(process.env, {}, {}, URL_DEFINITIONS);
const config = buildConfig(initialRegistry);

async function refreshRegistry() {
    if (!config.hoboToolsInternalUrl || !config.internalApiKey) {
        return config;
    }

    try {
        const url = `${config.hoboToolsInternalUrl.replace(/\/$/, '')}/internal/url-registry/resolved`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'X-Internal-Key': config.internalApiKey,
                'Accept': 'application/json',
            },
        });
        if (!res.ok) {
            console.warn('[Config] Failed to refresh URL registry from hobo.tools:', res.status);
            return config;
        }
        const body = await res.json();
        if (!body.registry) {
            console.warn('[Config] Invalid registry response from hobo.tools');
            return config;
        }

        const overrides = Object.fromEntries(
            Object.entries(body.registry)
                .filter(([, entry]) => entry && entry.source === 'admin' && entry.value != null)
                .map(([key, entry]) => [key, entry.value])
        );
        const registry = resolveRegistryValues(process.env, overrides, {}, URL_DEFINITIONS);
        const updated = buildConfig(registry);
        Object.assign(config, updated);
        console.log('[Config] URL registry overrides loaded from hobo.tools');
    } catch (err) {
        console.warn('[Config] Unable to load URL registry from hobo.tools:', err.message);
    }
    return config;
}

config.refreshRegistry = refreshRegistry;
module.exports = config;
