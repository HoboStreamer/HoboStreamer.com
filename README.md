# HoboStreamer

HoboStreamer is a self-hosted live streaming platform for stealth campers, nomads, outdoor IRL creators, and adjacent communities.

It pairs a Node/Express backend with WebSocket real-time systems, SQLite storage, three broadcast paths, chat, VODs, clips, cosmetics, moderation, hardware controls, calls, and a browser game.

**Community:** [Join the Discord](https://discord.gg/M6MuRUaeJj)

---

## What the current codebase includes

The server entrypoint in [server/index.js](server/index.js) wires together:

- Express API routes under `/api/*`
- WebSocket endpoints under `/ws/*`
- JSMPEG relay support
- RTMP ingest support via `node-media-server`
- optional WebRTC SFU support via `mediasoup`
- chat, control, broadcast, call, and game realtime services
- SQLite persistence via `better-sqlite3`
- VOD, clip, thumbnail, emote, avatar, and media storage under `data/`

---

## Major features

### Streaming

HoboStreamer currently supports three live broadcast paths:

- **JSMPEG** — low-latency FFmpeg-to-browser workflow
- **WebRTC** — browser-based live broadcast path
- **RTMP** — OBS/FFmpeg ingest path

The codebase also exposes supporting systems for:

- multi-camera streams
- live thumbnails
- stream discovery and follow data
- private/public VOD workflows
- clip creation from recorded VODs or browser-side live recording

### Chat

The chat server in [server/chat/chat-server.js](server/chat/chat-server.js) supports:

- authenticated and anonymous chat
- stable anon IDs such as `anon123`
- global chat and per-stream chat rooms
- moderation tools
- rate limiting and spam controls
- word filtering / opsec-focused filtering
- WebSocket chat history and presence updates
- chat-linked cosmetics and username metadata

### HoboGame and realtime extras

The codebase also includes:

- HoboGame REST and WebSocket services in [server/game](server/game)
- anon-capable game identity resolution
- browser group-call signaling in [server/streaming/call-server.js](server/streaming/call-server.js)
- broadcaster/viewer control channels in [server/controls](server/controls)
- Raspberry Pi / hardware integration helpers in [hardware](hardware)

### Monetization and identity

HoboStreamer includes:

- JWT auth
- profile and stream-key management
- Hobo Bucks / coin systems
- donations, goals, and cashout flows
- cosmetics, themes, emotes, and avatars
- admin and moderation routes

### VODs and clips

The current codebase supports:

- automatic or live-assisted recording flows depending on protocol
- clip extraction from VODs
- browser-uploaded live clip support
- near-duplicate clip reuse
- clip anti-spam throttling
- thumbnail generation and serving

Recent backend changes also reduce duplicate clip creation when multiple users clip the same moment at nearly the same time.

---

## Architecture overview

### HTTP and API

[server/index.js](server/index.js) mounts route groups including:

- `/api/auth`
- `/api/streams`
- `/api/chat`
- `/api/funds`
- `/api/coins`
- `/api/cosmetics`
- `/api/vods`
- `/api/clips`
- `/api/comments`
- `/api/controls`
- `/api/admin`
- `/api/thumbnails`
- `/api/themes`
- `/api/emotes`
- `/api/game`

### WebSocket endpoints

The main server upgrades connections for:

- `/ws/chat`
- `/ws/broadcast`
- `/ws/control`
- `/ws/call`
- `/ws/game`

### Storage

Persistent app data lives under [data](data), including:

- SQLite database
- VODs
- clips
- thumbnails
- avatars
- emotes
- other media assets

---

## Tech stack

The checked-in package metadata in [package.json](package.json) currently uses:

- Node.js
- Express
- ws
- better-sqlite3
- bcryptjs
- jsonwebtoken
- multer
- helmet
- cors
- express-rate-limit
- node-media-server
- mediasoup

---

## Current implementation notes

### Protocol caveats

- **JSMPEG** is implemented and remains useful for low-latency FFmpeg-driven broadcasting.
- **RTMP** ingest is implemented, with endpoint exposure for playback URLs in the server responses.
- **WebRTC** support exists in the codebase, but deployment depends on `mediasoup` compiling correctly for the target machine.

### Clip and VOD behavior

The current implementation uses different recording paths depending on protocol. Recent changes improved:

- live clip timing accuracy
- MediaRecorder fallback behavior
- RTMP/JSMPEG/WebRTC clip handling consistency
- duplicate clip reuse
- per-user and per-IP clip throttling

### Anonymous access

Anonymous users are supported in:

- chat
- calls
- HoboGame access paths

The game auth flow in [server/game/game-auth.js](server/game/game-auth.js) resolves either authenticated users or chat-style anon identities.

---

## Quick start

### Requirements

- Node.js 18+
- npm
- FFmpeg for media workflows
- Linux recommended for production deployment

Node 20 LTS is the safest production baseline if you want the fewest native-module surprises.

### Install

```bash
npm install
```

### Environment

Copy and edit your environment file:

```bash
cp .env.example .env
```

At minimum, configure:

- `PORT`
- `HOST`
- `BASE_URL`
- `JWT_SECRET`
- media storage paths if you want custom locations
- RTMP/JSMPEG/WebRTC values only for the protocols you actually plan to expose

### Run

```bash
npm start
```

Development mode:

```bash
npm run dev
```

Optional schema initialization script:

```bash
npm run init-db
```

---

## Security and deployment guidance

For real deployment, read [SETUP.md](SETUP.md).

Key operational guidance from the current codebase:

- keep the website behind Nginx and Cloudflare
- only open media ports for protocols you actively use
- keep registration closed when you are not onboarding users
- keep upload limits low on small servers
- monitor VOD, clip, thumbnail, avatar, and emote storage growth
- prefer least-exposed protocol combinations for small VPS deployments

The server already includes:

- `helmet`
- CORS origin checks
- route-level rate limits
- upload-size limits
- clip dedupe and anti-spam protection

---

## Repository layout

- [server](server) — backend API, WebSockets, chat, streaming, auth, admin, game
- [public](public) — web UI assets
- [hardware](hardware) — controller and streaming helpers for hardware clients
- [scripts](scripts) — utility and startup scripts
- [deploy](deploy) — deployment examples for Nginx, Cloudflare, fail2ban, systemd
- [data](data) — runtime storage

Useful starting points:

- [server/index.js](server/index.js)
- [server/config.js](server/config.js)
- [server/chat/chat-server.js](server/chat/chat-server.js)
- [server/streaming/routes.js](server/streaming/routes.js)
- [server/vod/routes.js](server/vod/routes.js)
- [server/game/routes.js](server/game/routes.js)
- [public/js/stream-player.js](public/js/stream-player.js)
- [public/js/chat.js](public/js/chat.js)

---

## Project status

- package version is currently `1.0.0`
- the platform is broad in scope and mixes streaming, social, game, and hardware systems
- some features depend on optional infrastructure or native components
- deployment quality depends heavily on how many public-facing media ports you expose

---

## License

See [LICENSE](LICENSE).
