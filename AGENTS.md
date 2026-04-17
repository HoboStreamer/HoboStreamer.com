# AGENTS.md — HoboStreamer.com

## Project Overview

Self-hosted live streaming platform — Node.js/Express monolith, vanilla JS SPA frontend, SQLite (better-sqlite3). Part of the **Hobo Network** with SSO via hobo.tools. See [README.md](README.md) for features and [docs/architecture.md](docs/architecture.md) for system design.

**Network context:** This service now uses hobo.tools OAuth2 SSO. See [../HoboApp/ARCHITECTURE.md](../HoboApp/ARCHITECTURE.md) for the full network architecture and [../HoboApp/scripts/](../HoboApp/scripts/) for historical migration utilities.

## Commands

```bash
npm run dev               # Start dev server (NODE_ENV=development)
npm start                 # Start production server (node server/index.js)
npm run init-db           # Initialize database from schema.sql
npm run seed              # Seed sample data
node --check <file.js>    # Syntax check (no linter configured)
node test/<file>.test.js  # Run individual test (no test runner)
```

**No build step.** Frontend is plain JS served directly — no bundler, no transpiler. Bump `?v=N` on script tags in `index.html` to bust cache on deploy.

**Deploy:** `ssh hobo.tools 'sudo /opt/hobostreamer/deploy/scripts/deploy.sh'` — pulls main, restarts systemd, checks health. See [deploy/README.md](deploy/README.md).

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — Express app, middleware, route mounting, WS upgrade handler, sub-service init
- **Config:** [server/config.js](server/config.js) reads `.env` ([.env.example](.env.example))
- **Database:** [server/db/database.js](server/db/database.js) — all queries, schema in [server/db/schema.sql](server/db/schema.sql)
- **Auth:** [server/auth/auth.js](server/auth/auth.js) — RS256 JWT from hobo.tools SSO + `hbt_` API tokens
- **Permissions:** [server/auth/permissions.js](server/auth/permissions.js) — role hierarchy: `user < streamer < global_mod < admin`
- **Frontend shell:** [public/index.html](public/index.html) — all pages as `<section id="page-*">`, routing via `history.pushState` in [public/js/app.js](public/js/app.js)

Each feature lives in its own `server/<feature>/` directory with `routes.js` + service files. Frontend: one JS file per feature in `public/js/`.

## Conventions

- **CommonJS** (`require`/`module.exports`) everywhere. No ES modules except dynamic `import()` for mediasoup-client.
- **Style:** 4-space indent, single quotes, semicolons. No linter/formatter configured.
- **Naming:** `camelCase` for JS, `snake_case` for SQLite columns/tables.
- **DB access:** Direct `better-sqlite3` calls in `database.js` (e.g., `db.getUserById()`, `db.run()`, `db.get()`, `db.all()`).
- **Auth middleware:** `requireAuth` from `auth.js`. Permission checks via `permissions.js`.
- **DB migrations:** Inline `ALTER TABLE` wrapped in `try/catch` for idempotency — no migration framework.
- **WebSocket servers:** Each has `init(server)` and `handleUpgrade(req, socket, head)` methods.
- **Frontend globals:** `currentUser`, `api()`, `navigate()`, `handleLinkClick()`. Cross-component sync via `CustomEvent` (e.g., `hobo-auth-changed`).
- **ChatServer:** Singleton — `chat-server.js` exports `new ChatServer()`, not the class.

## Key Pitfalls

- **No build step:** Changes to `public/js/*.js` take effect immediately on deploy. Cache busting is manual (`?v=N` in script tags).
- **innerHTML usage:** Frontend has heavy `innerHTML` — prefer DOM node creation for new code to avoid XSS.
- **WebSocket auth lifecycle:** WS connections can start anonymous and upgrade via `join` message. On account switch, the socket must be rebuilt (not just re-joined) — see `hobo-auth-changed` handling in `chat.js`.
- **hobo-shared:** Local package at `../packages/hobo-shared` linked via `file:` in package.json. Shared across Hobo Network services.
- **DM delivery:** Server verifies `dm.isParticipant()` before delivering — always maintain this check.
- **Schema:** `ensureTables()` functions create tables on first use. Some modules (DMs, game, etc.) have their own `ensureTables()`.

## WebSocket Endpoints

`/ws/chat`, `/ws/broadcast`, `/ws/control`, `/ws/call`, `/ws/robotstreamer-publish` — all upgraded via handler in `server/index.js` with origin checks and IP bans.

## Testing

Standalone Node scripts in `test/` using `assert`. They create temp SQLite databases. Always `node --check` modified files before committing.

## Documentation

- [docs/architecture.md](docs/architecture.md) — System design, data flows, module map
- [docs/broadcasting.md](docs/broadcasting.md) — Streaming protocols (WebRTC/RTMP/JSMPEG/WHIP)
- [docs/chat-system.md](docs/chat-system.md) — Chat features and moderation
- [docs/api-tokens.md](docs/api-tokens.md) — Bot/integration token system
- [docs/vods-and-clips.md](docs/vods-and-clips.md) — VOD/clip pipeline
- [docs/dashboard.md](docs/dashboard.md) — Streamer dashboard
- [docs/onboarding.md](docs/onboarding.md) — New user flow
- [SETUP.md](SETUP.md) — Full deployment guide
- [SECURITY_AUDIT.md](SECURITY_AUDIT.md) — Security audit findings
- [hardware/README.md](hardware/README.md) — Raspberry Pi integration
