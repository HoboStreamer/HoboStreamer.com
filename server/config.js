/**
 * HoboStreamer — Config
 */
require('dotenv').config();

module.exports = {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    nodeEnv: process.env.NODE_ENV || 'development',

    // Platform admin (applied on first setup only)
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || 'changeme123',

    jwt: {
        secret: process.env.JWT_SECRET || 'hobostreamer-dev-secret-change-me',
        expiresIn: '7d',
    },

    db: {
        path: process.env.DB_PATH || './data/hobostreamer.db',
    },

    rtmp: {
        port: parseInt(process.env.RTMP_PORT || '1935', 10),
        chunkSize: parseInt(process.env.RTMP_CHUNK_SIZE || '60000', 10),
    },

    jsmpeg: {
        videoPort: parseInt(process.env.JSMPEG_VIDEO_PORT || '9710', 10),
        audioPort: parseInt(process.env.JSMPEG_AUDIO_PORT || '9711', 10),
    },

    // TURN relay for WebRTC NAT traversal (optional but recommended)
    // Without TURN, viewers behind symmetric NAT cannot connect.
    // Set up coturn on your server or use a TURN provider.
    turn: {
        url: process.env.TURN_URL || '',           // e.g. 'turn:turn.example.com:3478'
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || '',
    },

    mediasoup: {
        listenIp: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',
        minPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '10000', 10),
        maxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '10100', 10),
        webrtcPort: parseInt(process.env.WEBRTC_PORT || '4443', 10),
        // Router media codecs
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

    hoboBucks: {
        minCashout: parseFloat(process.env.MIN_CASHOUT || '5.00'),  // $5 minimum cashout
        escrowDays: parseInt(process.env.ESCROW_HOLD_DAYS || '14', 10),
    },

    vod: {
        path: process.env.VOD_PATH || './data/vods',
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
        ffzCacheTtl: parseInt(process.env.FFZ_CACHE_TTL || '3600', 10),  // seconds
        bttvCacheTtl: parseInt(process.env.BTTV_CACHE_TTL || '3600', 10),
        sevenTvCacheTtl: parseInt(process.env.SEVENTV_CACHE_TTL || '3600', 10),
    },

    paypal: {
        clientId: process.env.PAYPAL_CLIENT_ID || '',
        clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
        mode: process.env.PAYPAL_MODE || 'sandbox',
    },
};
