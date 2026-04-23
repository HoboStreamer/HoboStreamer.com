# HoboStreamer Setup

This document describes the current HoboStreamer runtime setup, local development, and integration points with `hobo.tools`.

## What this repo needs

HoboStreamer is a live streaming backend that depends on the central `hobo.tools` SSO/internal service for authentication, OAuth2 login, and URL registry values.

It also expects a local shared package dependency at `../packages/hobo-shared` from the `HoboStreamer.com` folder, so verify your workspace layout before running `npm install`.

## Prerequisites

- Node.js 18 or later.
- npm.
- FFmpeg for media ingest, recording, and clip workflows.
- A running `hobo.tools` instance for OAuth2 authorization and internal API calls.
- Linux is recommended for production deployments because `mediasoup` and `node-media-server` are more reliable there.

## Install dependencies

```bash
npm install
```

If the install fails while resolving `file:../packages/hobo-shared`, ensure the shared package is available at that path relative to `HoboStreamer.com` or create a workspace symlink from `HoboApp/packages/hobo-shared`.

## Environment configuration

Copy the environment template into `.env`:

```bash
cp .env.example .env
```

### Required values

- `BASE_URL` — public URL used by the browser client, e.g. `http://localhost:3000`.
- `JWT_SECRET` — app-specific secret used by HoboStreamer for its own JWT operations.
- `HOBO_TOOLS_INTERNAL_URL` — internal URL for hobo.tools, default `http://127.0.0.1:3100`.
- `INTERNAL_API_KEY` — shared internal API key matching `hobo.tools`.
- `HOBO_TOOLS_PUBLIC_KEY` — path to the hobo.tools public key used for token verification.

### Important integration values

- `HOBO_TOOLS_INTERNAL_URL` — internal URL to call `hobo.tools`.
- `INTERNAL_API_KEY` — header `X-Internal-Key` used for internal API requests.
- `HOBO_TOOLS_URL` — public URL to the auth provider, if not using the default `https://hobo.tools`.
- `HOBO_OAUTH_CLIENT_ID` — optional override for the OAuth client ID (`hobostreamer` by default).
- `HOBO_OAUTH_CLIENT_SECRET` — optional override for the OAuth client secret.

#### Public key for token verification

HoboStreamer verifies RS256 tokens from `hobo.tools` using one of these paths:

1. `HOBO_TOOLS_PUBLIC_KEY` environment variable.
2. `./data/keys/hobo-tools-public.pem`.
3. `/opt/hobo/hobo-tools/data/keys/public.pem`.

If the public key cannot be loaded, authentication will fail.

## Database initialization

HoboStreamer provides a schema init script:

```bash
npm run init-db
```

This creates the SQLite database at `data/hobostreamer.db` and initializes schema from `server/db/schema.sql`.

### Automatic migrations

On normal startup, `server/index.js` runs lightweight schema migrations and fills in missing columns. That means `npm run init-db` is still the safe first step, but the server can also recover existing databases automatically.

## Required storage directories

The server writes to the following directories under `data/`:

- `data/vods`
- `data/clips`
- `data/thumbnails`
- `data/emotes`
- `data/analytics.db`
- `data/keys` (if you store public keys there)

The server creates these directories automatically when needed, but ensure the process has write permission to `data/`.

## Local development setup

For the simplest local setup:

1. Start `hobo.tools` locally.
2. Configure `HOBO_TOOLS_INTERNAL_URL=http://127.0.0.1:3100`.
3. Set `BASE_URL=http://localhost:3000`.
4. Share the same `INTERNAL_API_KEY` between HoboStreamer and `hobo.tools`.
5. Provide the hobo.tools public key via `HOBO_TOOLS_PUBLIC_KEY` or copy it to `./data/keys/hobo-tools-public.pem`.
6. Run `npm run init-db`.
7. Run `npm run dev`.

### Raspberry Pi / local multi-domain setup

When testing on a Raspberry Pi or if you want local `raspi.*` hostnames instead of `localhost`, configure your `.env` values and local DNS/hosts accordingly.

- `BASE_URL=http://raspi.hobostreamer.com`
- `HOBO_TOOLS_URL=http://raspi.hobo.tools`
- `HOBO_TOOLS_INTERNAL_URL=http://127.0.0.1:3100`
- `INTERNAL_API_KEY` must still match the value used by `hobo.tools`

If your Pi is the host running both services, `HOBO_TOOLS_INTERNAL_URL` can stay `http://127.0.0.1:3100`.
If you access the Pi from another machine, point these hostnames to the Pi’s IP in `/etc/hosts` or your local DNS provider:

```text
<pi-ip> raspi.hobo.tools raspi.hobostreamer.com raspi.hobo.quest
```

This makes the local auth issuer and the streamed app resolve consistently across browsers and devices.

### Recommended local values

```env
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
BASE_URL=http://raspi.hobostreamer.com
HOBO_TOOLS_INTERNAL_URL=http://127.0.0.1:3100
INTERNAL_API_KEY=your-shared-secret
HOBO_TOOLS_PUBLIC_KEY=./data/keys/hobo-tools-public.pem
```

## Admin/bootstrap behavior

On startup, the server:

- refreshes URL registry values from `hobo.tools` when `HOBO_TOOLS_INTERNAL_URL` and `INTERNAL_API_KEY` are configured.
- initializes the database and schema.
- seeds built-in themes if the theme table is empty.
- creates an admin user from `ADMIN_USERNAME` and `ADMIN_PASSWORD` if no admin account exists.

### Admin account behavior

If no admin user exists, the server uses `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env` to create one. In development, default values are `admin` / `changeme123` if these are unset.

## Protocol-specific notes

### WebRTC / mediasoup

WebRTC support is optional. `server/index.js` attempts to initialize `mediasoup` and logs a warning if it fails.

Required environment values for WebRTC:

- `MEDIASOUP_LISTEN_IP` — local listen address.
- `MEDIASOUP_ANNOUNCED_IP` — public address announced to clients.
- `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT` — UDP port range.
- `WEBRTC_PORT` — signaling port.
- `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` — required in production for reliable NAT traversal.
- `ALLOW_P2P_FALLBACK` — optional emergency rollback flag. Leave this at `false` unless you explicitly want to re-enable legacy peer-to-peer viewer relays.

If TURN is missing, some viewers may fail to connect behind NAT.
If `ALLOW_P2P_FALLBACK=true`, legacy browser-to-browser relay can expose viewer IPs and should only be used as a short-lived emergency switch.

### WHIP

WHIP is optional. Use:

- `WHIP_PUBLIC_URL` — public ingest URL for WHIP.
- `WHIP_PUBLIC_URL_ENABLED` — boolean to enable or disable WHIP.

If `WHIP_PUBLIC_URL` is configured but the feature is disabled, the server logs a warning and falls back to `WEBRTC_PUBLIC_URL` for client WHIP endpoints.

### RTMP

- `RTMP_PORT` — RTMP ingest port.
- `RTMP_CHUNK_SIZE` — RTMP packet chunk size.
- `RTMP_HOST` — host name used in RTMP-related URLs.

The RTMP server starts if `node-media-server` is available and the port is free.

### JSMPEG

- `JSMPEG_VIDEO_PORT`
- `JSMPEG_AUDIO_PORT`
- `JSMPEG_PUBLIC_URL`

### Optional production settings

- `VOD_PATH`, `CLIPS_PATH`, `THUMBNAILS_PATH`, `EMOTES_PATH` for custom media storage.
- `COLD_STORAGE_PATH` for offloaded VODs.
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_MODE` for Hobo Bucks cashout.

## Troubleshooting

### Common issues

- **Auth fails**: `HOBO_TOOLS_PUBLIC_KEY` is missing or invalid.
- **Invalid redirect_uri**: local HoboStreamer callback URIs are not registered on the `hobostreamer` OAuth client.
- **CORS rejects browser traffic**: `BASE_URL` is set to localhost in production.
- **Registry refresh skipped**: `HOBO_TOOLS_INTERNAL_URL` or `INTERNAL_API_KEY` is missing.
- **WebRTC fails**: `mediasoup` could not initialize or TURN is not configured.
- **RTMP fails to start**: port conflict on `RTMP_PORT`.
- **Package install fails**: local `hobo-shared` dependency path may be missing.

### How to verify local startup

1. Run `npm run dev`.
2. Confirm the server logs show `HTTP server` and WebSocket endpoints.
3. Confirm `Effective BASE_URL` and `Effective HOBO_TOOLS_URL` are correct.
4. Confirm the server created or migrated `data/hobostreamer.db`.

### Local OAuth callback URI details

For local development, `hobotools` seeds the following HoboStreamer redirect URIs in `local-dev` mode:

- `http://localhost:3000/api/auth/callback`
- `http://localhost:3000/auth/callback`

If you run into `invalid redirect_uri`, verify that `hobotools` is running and `HOBO_TOOLS_INTERNAL_URL`, `INTERNAL_API_KEY`, and `HOBO_TOOLS_PUBLIC_KEY` are configured correctly.

## What this setup does not cover

- production Nginx / Cloudflare deployment.
- real TLS certificate configuration.
- full Hobo Network multi-domain registry setup.
- HoboStreamer client-side build optimization.

For further HoboStreamer client and stream-specific guidance, see `docs/broadcasting.md`.
