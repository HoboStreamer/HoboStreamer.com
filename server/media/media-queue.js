const db = require('../db/database');

const DEFAULTS = {
    enabled: 1,
    request_cost: 25,
    max_per_user: 3,
    max_duration_seconds: 600,
    allow_youtube: 1,
    allow_vimeo: 1,
    allow_direct_media: 1,
    auto_advance: 1,
};

const DIRECT_AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)(\?.*)?$/i;
const DIRECT_VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v)(\?.*)?$/i;

class MediaQueue {
    getSettings(streamerId) {
        return { ...DEFAULTS, ...(db.upsertMediaRequestSettings(streamerId, {}) || {}) };
    }

    updateSettings(streamerId, fields) {
        return { ...DEFAULTS, ...(db.upsertMediaRequestSettings(streamerId, fields) || {}) };
    }

    async addRequest({ streamerId, streamId, userId, username, input }) {
        const settings = this.getSettings(streamerId);
        if (!settings.enabled) throw new Error('Media requests are disabled for this channel');

        const trimmed = String(input || '').trim();
        if (!trimmed) throw new Error('Usage: !sr <media url>');

        const normalized = await this.normalizeInput(trimmed, settings);
        const pendingCount = db.countPendingMediaRequestsForUser(streamerId, userId);
        if (pendingCount >= Number(settings.max_per_user || DEFAULTS.max_per_user)) {
            throw new Error(`You already have ${pendingCount} active request(s) in queue`);
        }

        const duplicate = db.findActiveMediaRequestByCanonicalUrl(streamerId, normalized.canonical_url);
        if (duplicate) throw new Error('That media is already in the queue');

        const cost = Math.max(1, Number(settings.request_cost || DEFAULTS.request_cost));
        if (!db.deductHoboCoins(userId, cost)) {
            throw new Error(`Not enough Hobo Coins. This channel charges ${cost} coins per request.`);
        }

        const queuePosition = db.getMediaRequestMaxQueuePosition(streamerId) + 1;
        const result = db.createMediaRequest({
            streamer_id: streamerId,
            stream_id: streamId,
            user_id: userId,
            username,
            input: trimmed,
            canonical_url: normalized.canonical_url,
            embed_url: normalized.embed_url,
            provider: normalized.provider,
            title: normalized.title,
            thumbnail_url: normalized.thumbnail_url,
            duration_seconds: normalized.duration_seconds,
            cost,
            queue_position: queuePosition,
        });

        db.createCoinTransaction({
            user_id: userId,
            stream_id: streamId,
            amount: -cost,
            type: 'redeem',
            message: `Media request: ${normalized.title}`,
        });

        const request = db.getMediaRequestById(result.lastInsertRowid);
        this.broadcastQueueUpdate(streamerId);
        return request;
    }

    startNext(streamerId) {
        const active = db.getActiveMediaRequestByStreamer(streamerId);
        if (active) return active;

        const next = db.getNextPendingMediaRequest(streamerId);
        if (!next) return null;

        db.updateMediaRequest(next.id, {
            status: 'playing',
            started_at: new Date().toISOString(),
        });
        db.renormalizePendingMediaRequestPositions(streamerId);

        const request = db.getMediaRequestById(next.id);
        this.broadcastQueueUpdate(streamerId);
        this.broadcastNowPlaying(streamerId, request);
        return request;
    }

    finishCurrent(streamerId, status = 'played') {
        const active = db.getActiveMediaRequestByStreamer(streamerId);
        if (!active) return null;

        db.updateMediaRequest(active.id, {
            status,
            ended_at: new Date().toISOString(),
        });

        const ended = db.getMediaRequestById(active.id);
        db.renormalizePendingMediaRequestPositions(streamerId);
        this.broadcastQueueUpdate(streamerId);
        return ended;
    }

    advance(streamerId) {
        this.finishCurrent(streamerId, 'played');
        return this.startNext(streamerId);
    }

    skip(streamerId, requestId) {
        const request = db.getMediaRequestByStreamerAndId(streamerId, requestId);
        if (!request) throw new Error('Request not found');

        const nextStatus = request.status === 'playing' ? 'skipped' : 'removed';
        db.updateMediaRequest(request.id, {
            status: nextStatus,
            ended_at: new Date().toISOString(),
        });
        db.renormalizePendingMediaRequestPositions(streamerId);
        this.broadcastQueueUpdate(streamerId);
        return db.getMediaRequestById(request.id);
    }

    move(streamerId, requestId, direction) {
        const pending = db.getPendingMediaRequestsByStreamer(streamerId, 100);
        const index = pending.findIndex(item => item.id === requestId);
        if (index === -1) throw new Error('Pending request not found');

        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        if (swapIndex < 0 || swapIndex >= pending.length) return pending[index];

        const current = pending[index];
        const other = pending[swapIndex];
        db.updateMediaRequest(current.id, { queue_position: other.queue_position });
        db.updateMediaRequest(other.id, { queue_position: current.queue_position });
        db.renormalizePendingMediaRequestPositions(streamerId);
        this.broadcastQueueUpdate(streamerId);
        return db.getMediaRequestById(current.id);
    }

    getState(streamerId) {
        return {
            settings: this.getSettings(streamerId),
            now_playing: db.getActiveMediaRequestByStreamer(streamerId),
            queue: db.getPendingMediaRequestsByStreamer(streamerId, 50),
            history: db.getRecentMediaRequestsByStreamer(streamerId, 20),
        };
    }

    async normalizeInput(rawInput, settings) {
        let url;
        try {
            url = new URL(rawInput);
        } catch {
            throw new Error('Only direct media URLs are supported right now');
        }

        const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
        const href = url.toString();

        const ytId = this.extractYouTubeId(url);
        if (ytId) {
            if (!settings.allow_youtube) throw new Error('YouTube requests are disabled for this channel');
            const canonical = `https://www.youtube.com/watch?v=${ytId}`;
            const meta = await this.fetchOEmbed(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`);
            return {
                canonical_url: canonical,
                embed_url: `https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0`,
                provider: 'youtube',
                title: meta?.title || `YouTube video ${ytId}`,
                thumbnail_url: meta?.thumbnail_url || `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
                duration_seconds: null,
            };
        }

        const vimeoMatch = hostname === 'vimeo.com' || hostname === 'player.vimeo.com'
            ? url.pathname.match(/\/(?:video\/)?(\d+)/)
            : null;
        if (vimeoMatch) {
            if (!settings.allow_vimeo) throw new Error('Vimeo requests are disabled for this channel');
            const videoId = vimeoMatch[1];
            const canonical = `https://vimeo.com/${videoId}`;
            const meta = await this.fetchOEmbed(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonical)}`);
            if (Number.isFinite(meta?.duration) && meta.duration > Number(settings.max_duration_seconds || DEFAULTS.max_duration_seconds)) {
                throw new Error(`That video is too long. Max allowed is ${settings.max_duration_seconds} seconds.`);
            }
            return {
                canonical_url: canonical,
                embed_url: `https://player.vimeo.com/video/${videoId}?autoplay=1`,
                provider: 'vimeo',
                title: meta?.title || `Vimeo video ${videoId}`,
                thumbnail_url: meta?.thumbnail_url || null,
                duration_seconds: Number.isFinite(meta?.duration) ? meta.duration : null,
            };
        }

        if (DIRECT_AUDIO_EXT.test(href)) {
            if (!settings.allow_direct_media) throw new Error('Direct media requests are disabled for this channel');
            return {
                canonical_url: href,
                embed_url: href,
                provider: 'audio',
                title: this.filenameTitle(url.pathname),
                thumbnail_url: null,
                duration_seconds: null,
            };
        }

        if (DIRECT_VIDEO_EXT.test(href)) {
            if (!settings.allow_direct_media) throw new Error('Direct media requests are disabled for this channel');
            return {
                canonical_url: href,
                embed_url: href,
                provider: 'video',
                title: this.filenameTitle(url.pathname),
                thumbnail_url: null,
                duration_seconds: null,
            };
        }

        throw new Error('Unsupported media URL. Supported: YouTube, Vimeo, direct audio/video files');
    }

    extractYouTubeId(url) {
        const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
        if (hostname === 'youtu.be') {
            const id = url.pathname.slice(1).split('/')[0];
            return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
        }
        if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
            if (url.pathname === '/watch') {
                const id = url.searchParams.get('v');
                return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
            }
            const match = url.pathname.match(/\/(embed|shorts)\/([A-Za-z0-9_-]{11})/);
            return match ? match[2] : null;
        }
        return null;
    }

    filenameTitle(pathname) {
        const last = decodeURIComponent((pathname || '').split('/').pop() || 'Media request');
        return last.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Media request';
    }

    async fetchOEmbed(url) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'HoboStreamer/1.0 media requests' } });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    broadcastNowPlaying(streamerId, request) {
        this.broadcast(streamerId, {
            type: 'media_now_playing',
            request,
            timestamp: new Date().toISOString(),
        });
    }

    broadcastQueueUpdate(streamerId) {
        this.broadcast(streamerId, {
            type: 'media_queue_update',
            state: this.getState(streamerId),
            timestamp: new Date().toISOString(),
        });
    }

    broadcast(streamerId, payload) {
        try {
            const chatServer = require('../chat/chat-server');
            const streams = db.getLiveStreamsByUserId(streamerId) || [];
            for (const stream of streams) {
                chatServer.broadcastToStream(stream.id, payload);
            }
        } catch {
            // optional
        }
    }
}

module.exports = new MediaQueue();
