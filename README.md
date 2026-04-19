# HoboStreamer

HoboStreamer is a self-hosted live streaming platform for the Hobo Network. It provides streaming ingest, chat, VOD/clip management, monetization, and moderation features.

This repository contains the HoboStreamer server, browser assets, and runtime configuration. It relies on the sibling `hobo.tools` service for central SSO/OAuth2 authentication, JWT verification, and internal URL registry values.

---

## What this repo contains

- `server/` — Node/Express backend, WebSocket handling, streaming routes, chat, auth, monetization, and media services.
- `public/` — static browser UI assets.
- `data/` — runtime storage for SQLite, VODs, clips, thumbnails, emotes, analytics, and other media artifacts.
- `.env.example` — runtime configuration template.
- `docs/broadcasting.md` — broadcast mode and streaming UX guidance.
- `server/db/init.js` — SQLite schema initialization script.
- `package.json` — Node scripts and dependencies.

> Note: `package.json` depends on a local `hobo-shared` package at `../packages/hobo-shared` relative to `HoboStreamer.com`.
> If that path does not exist in your workspace, create a matching symlink or clone the package to that location before `npm install`.

---

## Runtime architecture

### Core server

`server/index.js` is the entrypoint. It loads environment configuration, initializes the database, and starts the HTTP server and WebSocket upgrade handler.

### Streaming support

- RTMP ingest using `node-media-server`.
- optional WebRTC SFU via `mediasoup`.
- JSMPEG relay.
- WHIP/HTTP ingestion support.
- real-time broadcast and control channels.

### Authentication

- User auth is handled via `hobo.tools` OAuth2 and JWT.
- HoboStreamer verifies RS256 tokens using the hobo.tools public key.
- Local user records are joined to hobo.tools identities via `linked_accounts`.
- The local login redirect URI is typically `http://localhost:3000/api/auth/callback`.

### Data storage

- `data/hobostreamer.db` — primary SQLite database.
- `data/vods` — VOD storage.
- `data/clips` — extracted clips.
- `data/thumbnails` — generated thumbnails.
- `data/emotes` — uploaded emotes.
- `data/analytics.db` — analytics tracker.

---

## Ownership and dependencies

### HoboStreamer owns

- streaming ingest and viewer playback.
- chat, moderation, and anonymous chat support.
- VODs, clips, thumbnails, avatars, and emotes.
- streamer controls, admin endpoints, and restream management.

### HoboStreamer depends on hobo.tools for

- SSO/OAuth2 provider.
- JWT public key verification.
- internal URL registry overrides for `BASE_URL`, `WEBRTC_PUBLIC_URL`, `WHIP_PUBLIC_URL`, and related values.
- internal API access for notifications and registry resolution.
- optional admin proxy integration.

---

## Important files

- `server/config.js` — env defaults, hobo.tools registry overrides, media and protocol settings.
- `server/index.js` — app startup, database migrations, chat and streaming initialization.
- `server/auth/auth.js` — hobo.tools token verification and local account resolution.
- `server/db/init.js` — create the database schema.
- `docs/broadcasting.md` — broadcast protocol and stream page guidance.

---

## Package scripts

The current `package.json` includes:

- `npm install` — install dependencies.
- `npm start` — start the server.
- `npm run dev` — start in development mode (`NODE_ENV=development`).
- `npm run init-db` — initialize the SQLite database schema.

> `package.json` also includes a `seed` script, but this repository does not contain `server/db/seed.js`. Use `npm run init-db` instead.

---

## Quick start

### Requirements

- Node.js 18 or newer.
- npm.
- FFmpeg for media workflows.
- A running `hobo.tools` instance for authentication.
- Linux is preferred for production.

### Install dependencies

```bash
npm install
```

### Configure the environment

```bash
cp .env.example .env
```

Edit `.env` and configure at minimum:

- `BASE_URL`
- `JWT_SECRET`
- `HOBO_TOOLS_INTERNAL_URL`
- `INTERNAL_API_KEY`
- `HOBO_TOOLS_PUBLIC_KEY` or copy the public key to `./data/keys/hobo-tools-public.pem`

Optional protocol settings:

- `RTMP_HOST`, `RTMP_PORT`
- `JSMPEG_VIDEO_PORT`, `JSMPEG_AUDIO_PORT`
- `MEDIASOUP_ANNOUNCED_IP`, `WEBRTC_PORT`
- `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`
- `WHIP_PUBLIC_URL`, `WHIP_PUBLIC_URL_ENABLED`

### Initialize the database

```bash
npm run init-db
```

### Start the server

```bash
npm start
```

For development:

```bash
npm run dev
```

---

## Setup guidance

See [SETUP.md](SETUP.md) for complete first-time setup, local development, and protocol-specific configuration.

### Notes

- `server/index.js` attempts to refresh registry values from `hobo.tools` on startup when `HOBO_TOOLS_INTERNAL_URL` and `INTERNAL_API_KEY` are configured.
- If the `hobo.tools` public key cannot be found, authentication will fail.
- `mediasoup` must compile successfully for WebRTC support; the server can continue without SFU if it fails.
- This repo expects a local `hobo-shared` package at `../packages/hobo-shared` from the `HoboStreamer.com` folder.
- The `INTERNAL_API_KEY` environment variable is used by default; the code also honors `HOBO_INTERNAL_KEY` as an alternate name.
- The default OAuth client ID is `hobostreamer`; the local redirect callback URI must match one of the allowed URIs registered in `hobo.tools`.

---

## Local login callback details

For local development, `hobo.tools` now seeds HoboStreamer with local redirect URIs when running in `local-dev` mode. The expected local login callback URIs include:

- `http://localhost:3000/api/auth/callback`
- `http://localhost:3000/auth/callback`

If you see `invalid redirect_uri`, confirm that `HOBO_TOOLS_INTERNAL_URL`, `INTERNAL_API_KEY`, and `HOBO_TOOLS_PUBLIC_KEY` are configured correctly and that `hobotools` is running.

---

## Additional docs

- [docs/broadcasting.md](docs/broadcasting.md) — streaming method and broadcast page guide.
- [SETUP.md](SETUP.md) — first-time setup and local development guide.
