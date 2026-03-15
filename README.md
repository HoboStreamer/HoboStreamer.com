# 🏕️ HoboStreamer

**Open source live streaming platform for stealth campers, nomads & outdoor culture.**

HoboStreamer is a self-hosted streaming platform inspired by [RobotStreamer.com](https://robotstreamer.com), built specifically for the stealth camping and nomad community. It pairs with [HoboApp](https://github.com/user/hoboapp) — a desktop app with 300+ curated stealth camping locations in Washington State.

> Stream from your camp, control hardware remotely, chat anonymously, and support creators with Hobo Bucks.

---

## Tested & Working (v1.0.0)

All API endpoints have been systematically tested via curl. Here's the verified status:

| Module | Status | Notes |
|--------|--------|-------|
| **Auth** | ✅ Fully working | Register, login, profile, stream keys, JWT |
| **Streaming** | ✅ Fully working | Start/stop/update/list/follow/multi-cam (JSMPEG) |
| **Chat (API)** | ✅ Fully working | History & user count endpoints |
| **Chat (WebSocket)** | ✅ Functional | Anon chat, commands, word filter, mod tools |
| **Hobo Bucks** | ✅ Fully working | Purchase, donate, cashout, goals, leaderboard |
| **Controls** | ✅ Fully working | CRUD buttons, API keys, keyboard bindings |
| **Admin** | ✅ Fully working | Stats, users, bans, streams, cashout management |
| **VODs** | ✅ Routes working | CRUD verified; recording requires FFmpeg + active stream |
| **Frontend** | ✅ Serving | HTML, CSS, 7 JS files, logo all load correctly |
| **JSMPEG Relay** | ✅ Active | WebSocket relay on port 9710/9711 |
| **RTMP Server** | ⚠️ Partial | Ingest works; HLS transcoding disabled (NMS v2.7.4 + Node 24 bug) |
| **WebRTC/Mediasoup** | ❌ Not compiled | Requires native worker binary (`npm install mediasoup` separately) |

---

## Features

### 🎥 Multi-Protocol Streaming
- **JSMPEG** — Ultra-low latency via FFmpeg → HTTP POST → WebSocket relay → browser canvas. Perfect for Raspberry Pi.
- **WebRTC** — Browser-based streaming via Mediasoup SFU. Requires native binary compilation.
- **RTMP** — OBS/FFmpeg ingest via node-media-server. HLS transcoding currently disabled on Node 24.

### 💬 WebSocket Chat
- Anonymous chat with auto-numbered anon IDs (anon10000, anon10001, ...)
- Role badges: Streamer, Mod, Admin, Subscriber
- Mod commands: `/ban`, `/timeout`, `/clear`, `/slow`, `/tts`, `/color`
- OpSec-focused word filter (safe/unsafe modes) — blocks location disclosure
- Rate limiting (1 msg/sec default) & spam detection
- Global and per-stream chat rooms
- Text-to-Speech integration

### 🪙 Hobo Bucks (Virtual Currency)
- 1 Hobo Buck = $1.00 USD
- Purchase via PayPal (simulated in demo)
- Donate to streamers with optional messages
- Donation goals with progress bars
- Escrow-based cashout system with admin approval (14-day hold, min $5.00)
- Leaderboards per stream

### 📹 VODs & Clips
- Automatic recording of JSMPEG and RTMP streams (requires FFmpeg)
- VODs are **private by default** (OpSec for stealth campers!)
- Publish when ready, or keep private forever
- Create clips from VODs (1–60 seconds) via FFmpeg extraction

### 🎮 Interactive Controls
- Hardware control API: viewers send commands → WebSocket → Raspberry Pi
- Built-in support for motors, servos, LEDs, TTS, horn
- Configurable button grid with icons and cooldowns
- Keyboard shortcuts (WASD / Arrow keys)
- Per-command cooldown enforcement
- API key generation for hardware clients

### 🛡️ Admin Panel
- Dashboard with platform stats (users, streams, funds, VODs, chat)
- User management (role changes, search, bans with time limits)
- Stream force-end
- Cashout approval/denial with escrow management
- VPN approval queue
- Ban management (site-wide and per-stream)

### 📷 Multi-Camera
- Add multiple cameras per stream
- Viewers can switch between camera feeds

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    HoboStreamer Server                     │
│                                                          │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Express  │  │  JSMPEG    │  │ WebRTC   │  │  RTMP   │ │
│  │   API    │  │  Relay     │  │  SFU     │  │ Server  │ │
│  │         │  │ (WS→WS)   │  │(Mediasoup)│  │(NMS)    │ │
│  └────┬────┘  └─────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │             │              │              │       │
│  ┌────┴─────────────┴──────────────┴──────────────┴────┐ │
│  │                   HTTP Server (:3000)                │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                         │                                │
│  ┌──────────┐  ┌───────┴──────┐  ┌──────────────────┐  │
│  │  Chat WS │  │  Control WS  │  │    SQLite DB      │  │
│  │  Server  │  │   Server     │  │  (better-sqlite3) │  │
│  └──────────┘  └──────────────┘  └──────────────────┘  │
└──────────────────────────────────────────────────────────┘
         ↑                ↑                ↑
    ┌────┴────┐     ┌────┴──────┐    ┌───┴──────┐
    │ Browser │     │ Raspberry │    │  FFmpeg/  │
    │ Viewer  │     │    Pi     │    │   OBS     │
    └─────────┘     └───────────┘    └──────────┘
```

---

## Quick Start

### Prerequisites
- **Node.js 18+** (tested with Node 24; 20 LTS recommended for full RTMP HLS support)
- **FFmpeg** (for JSMPEG streaming and VOD recording)
- **npm**

### Installation

```bash
git clone https://github.com/user/hobostreamer.git
cd hobostreamer

# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Edit .env with your settings (JWT secret, ports, etc.)
nano .env

# Start the server (database auto-initializes on first boot)
npm start

# Or development mode
npm run dev
```

The server starts on `http://localhost:3000` by default.

**Default admin account:** `admin` / `admin123` (change this immediately!)

> **Note:** The database initializes automatically on first `npm start` — no separate init step is required. If you prefer to initialize the schema manually: `npm run init-db`

### Known Issues (Node 24)

| Issue | Workaround |
|-------|-----------|
| Mediasoup worker binary not found | Install & compile: `npm install mediasoup` (requires C++ toolchain) |
| RTMP HLS transcoding crash (`version is not defined`) | NMS v2.7.4 bug on Node 24 — trans section disabled. Use Node 20 LTS for full RTMP+HLS. |
| `better-sqlite3` native module | If build fails: `npm rebuild better-sqlite3` |

### Streaming Setup

#### JSMPEG (Low Latency — Recommended for Pi)

1. Register an account or login as admin
2. Start a stream via API (or the Dashboard UI):
```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Start stream
curl -s -X POST http://localhost:3000/api/streams \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"My Camp Stream","protocol":"jsmpeg"}'
```
3. On your streaming device:
```bash
# Get your stream key
curl -s http://localhost:3000/api/auth/stream-key \
  -H "Authorization: Bearer $TOKEN"

# Stream with FFmpeg
ffmpeg -f v4l2 -framerate 24 -video_size 640x480 -i /dev/video0 \
  -f alsa -i default \
  -c:v mpeg1video -b:v 800k -r 24 -bf 0 \
  -c:a mp2 -ar 44100 -ac 1 -b:a 64k \
  -f mpegts http://YOUR_SERVER:9710/YOUR_STREAM_KEY/640/480/

# Or use the included script
./scripts/start-stream.sh YOUR_STREAM_KEY localhost 9710
```

#### WebRTC (Browser-Based)

> **Requires Mediasoup native worker binary.** Run `npm install mediasoup` with a C++ toolchain available. Falls back gracefully if not compiled.

1. Select WebRTC protocol when going live
2. Browser will request camera/mic permission
3. Stream starts automatically via Mediasoup SFU

#### RTMP (OBS / Broadcasting Software)

1. Start a stream with `"protocol": "rtmp"`
2. In OBS: **Settings → Stream → Custom**
   - Server: `rtmp://your-server:1935/live`
   - Stream Key: your stream key from the dashboard
3. Click "Start Streaming" in OBS

> **Note:** HLS transcoding is currently disabled on Node 24 due to a node-media-server v2.7.4 bug. RTMP ingest still works for direct playback.

### Hardware Control (Raspberry Pi)

```bash
cd hardware

# Install Python dependencies
pip3 install websocket-client

# Run the streamer
python3 streamer.py --key YOUR_KEY --server your-server.com

# Run the controller (in another terminal)
python3 controller.py --key YOUR_KEY --server your-server.com --enable-gpio
```

See [hardware/README.md](hardware/README.md) for full GPIO setup guide.

---

## Configuration

All configuration is via `.env` file. See [.env.example](.env.example) for all options.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | HTTP server port |
| `JWT_SECRET` | (dev default) | Secret for JWT tokens — **change in production** |
| `DB_PATH` | ./data/hobostreamer.db | SQLite database path |
| `JSMPEG_VIDEO_PORT` | 9710 | JSMPEG video relay port |
| `JSMPEG_AUDIO_PORT` | 9711 | JSMPEG audio relay port |
| `RTMP_PORT` | 1935 | RTMP ingest port |
| `MEDIASOUP_LISTEN_IP` | 0.0.0.0 | WebRTC SFU listen IP |
| `MEDIASOUP_ANNOUNCED_IP` | 127.0.0.1 | WebRTC SFU public IP |
| `VOD_PATH` | ./data/vods | VOD storage directory |
| `CLIPS_PATH` | ./data/clips | Clips storage directory |
| `MIN_CASHOUT` | 5 | Minimum cashout (Hobo Bucks) |
| `ESCROW_HOLD_DAYS` | 14 | Escrow hold period |
| `PAYPAL_CLIENT_ID` | (empty) | PayPal API credentials |
| `PAYPAL_MODE` | sandbox | PayPal mode (sandbox/live) |

---

## API Reference

All endpoints are prefixed with `/api`. Authentication is via JWT Bearer token in the `Authorization` header.

### Health
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Server status & uptime |

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | — | Create account (3-24 char username, 6+ char password) |
| POST | `/auth/login` | — | Login (returns JWT, valid 7 days) |
| GET | `/auth/me` | ✅ | Current user profile |
| PUT | `/auth/profile` | ✅ | Update display name, bio, avatar, email, color |
| GET | `/auth/stream-key` | ✅ | Get your stream key |
| POST | `/auth/stream-key/regenerate` | ✅ | Regenerate stream key |
| GET | `/auth/user/:username` | — | Public user profile |

### Streams
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/streams` | opt | List live streams |
| GET | `/streams/recent` | — | Recently ended streams (limit param, max 100) |
| GET | `/streams/:id` | opt | Stream details + endpoints + cameras + controls |
| POST | `/streams` | ✅ | Start a stream (auto-upgrades to streamer role) |
| PUT | `/streams/:id` | ✅ | Update title/desc/category/nsfw/tags (owner/admin) |
| DELETE | `/streams/:id` | ✅ | End a stream (owner/admin) |
| GET | `/streams/:id/endpoint` | ✅ | FFmpeg command & endpoint info (owner/admin) |
| POST | `/streams/:id/camera` | ✅ | Add camera to stream (owner/admin) |
| POST | `/streams/:id/follow` | ✅ | Toggle follow/unfollow |

### Chat
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/chat/:streamId/history` | opt | Chat history (limit, before params) |
| GET | `/chat/:streamId/users` | — | Chat user count |

### Hobo Bucks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/funds/balance` | ✅ | Your balance (Hobo Bucks + USD) |
| POST | `/funds/purchase` | ✅ | Buy Hobo Bucks (amount, paypal_transaction_id) |
| POST | `/funds/donate` | ✅ | Donate (streamer_id, stream_id, amount, message) |
| POST | `/funds/cashout` | ✅ | Request cashout (min $5, goes to escrow) |
| GET | `/funds/history` | ✅ | Transaction history (limit param) |
| GET | `/funds/leaderboard/:streamId` | — | Top donors for a stream |
| POST | `/funds/goals` | ✅ | Create donation goal (title, target_amount) |
| GET | `/funds/goals/:userId` | — | Get user's active goals |
| GET | `/funds/cashouts/pending` | 🔐 | Pending cashout queue (admin only) |
| POST | `/funds/cashout/:id/approve` | 🔐 | Approve cashout (admin) |
| POST | `/funds/cashout/:id/deny` | 🔐 | Deny cashout + refund (admin) |

### VODs
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/vods` | — | Public VODs (limit, offset) |
| GET | `/vods/mine` | ✅ | Your VODs (private + public) |
| GET | `/vods/:id` | opt | VOD details (private = owner/admin only) |
| PUT | `/vods/:id` | ✅ | Update title, public/private (owner/admin) |
| DELETE | `/vods/:id` | ✅ | Delete VOD + file (owner/admin) |
| POST | `/vods/:id/publish` | ✅ | Make VOD public |
| POST | `/vods/clips` | ✅ | Create clip (1-60s, via FFmpeg) |

### Controls
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/controls/api-key` | ✅ | Generate API key (returned once!) |
| GET | `/controls/api-keys` | ✅ | List your API keys |
| GET | `/controls/:streamId` | — | Get stream control buttons |
| POST | `/controls/:streamId` | ✅ | Add control button (owner/admin) |
| PUT | `/controls/:streamId/:id` | ✅ | Update control |
| DELETE | `/controls/:streamId/:id` | ✅ | Delete control |

### Admin (all require admin role)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/stats` | Platform statistics dashboard |
| GET | `/admin/users` | List users (search, limit, offset) |
| PUT | `/admin/users/:id` | Update user role/display name |
| POST | `/admin/users/:id/ban` | Ban user (reason, duration_hours) |
| DELETE | `/admin/users/:id/ban` | Unban user |
| GET | `/admin/streams` | All active streams |
| DELETE | `/admin/streams/:id` | Force-end stream |
| GET | `/admin/bans` | List all bans |
| GET | `/admin/vpn-queue` | VPN approval queue |
| PUT | `/admin/vpn-queue/:id` | Approve/deny VPN request |

### WebSocket Endpoints
| Path | Description |
|------|-------------|
| `/ws/chat?stream=ID&token=JWT` | Chat (anonymous or authenticated) |
| `/ws/control?stream=ID&token=JWT` | Hardware control relay |

#### Chat Commands
| Command | Who | Description |
|---------|-----|-------------|
| `/help` | All | Show available commands |
| `/tts <msg>` | All | Text-to-speech (forwarded to stream) |
| `/color #RRGGBB` | Users | Set chat name color |
| `/viewers` | All | Show viewer count |
| `/ban <user>` | Mod+ | Ban user/anon from stream |
| `/unban <user>` | Mod+ | Unban user |
| `/timeout <user> <sec>` | Mod+ | Temporary ban (default 300s) |
| `/clear` | Mod+ | Clear chat |
| `/slow <sec>` | Mod+ | Set slow mode |

---

## Project Structure

```
hobostreamer/
├── server/
│   ├── index.js              # Main server entry point
│   ├── config.js             # Configuration (.env loader)
│   ├── db/
│   │   ├── schema.sql        # Database schema (14 tables)
│   │   ├── database.js       # Database helpers (30+ functions)
│   │   └── init.js           # Manual DB init script
│   ├── auth/
│   │   ├── auth.js           # JWT middleware (require/optional/admin/streamer)
│   │   └── routes.js         # Auth API routes
│   ├── streaming/
│   │   ├── jsmpeg-relay.js   # JSMPEG WebSocket relay
│   │   ├── webrtc-sfu.js     # Mediasoup SFU (optional)
│   │   ├── rtmp-server.js    # RTMP server (HLS disabled on Node 24)
│   │   └── routes.js         # Stream API routes
│   ├── chat/
│   │   ├── chat-server.js    # WebSocket chat (441 lines)
│   │   ├── word-filter.js    # Safe/unsafe word filter
│   │   ├── unsafe-words.txt  # Default word list
│   │   └── routes.js         # Chat API routes
│   ├── monetization/
│   │   ├── camp-funds.js     # Currency engine (purchase/donate/cashout/goals)
│   │   └── routes.js         # Funds API routes
│   ├── vod/
│   │   ├── recorder.js       # FFmpeg recorder (JSMPEG + RTMP)
│   │   └── routes.js         # VOD/clip routes
│   ├── controls/
│   │   ├── control-server.js # WebSocket control relay
│   │   └── routes.js         # Controls + API key routes
│   └── admin/
│       └── routes.js         # Admin API routes
├── public/
│   ├── index.html            # SPA entry point
│   ├── css/style.css         # Stylesheet (30KB)
│   ├── js/
│   │   ├── app.js            # Core SPA router & auth
│   │   ├── stream-player.js  # Video player (JSMPEG/WebRTC/HLS)
│   │   ├── chat.js           # Chat client
│   │   ├── controls.js       # Control client
│   │   ├── dashboard.js      # Streamer dashboard
│   │   ├── admin.js          # Admin panel
│   │   └── camp-funds.js     # Currency UI
│   └── assets/
│       └── logo.svg          # Logo
├── hardware/
│   ├── streamer.py           # Pi streaming script
│   ├── controller.py         # Pi control client
│   └── README.md             # Hardware setup guide
├── scripts/
│   └── start-stream.sh       # Quick stream launcher
├── data/                     # Auto-created on first boot
│   ├── hobostreamer.db       # SQLite database
│   ├── vods/                 # VOD recordings
│   └── clips/                # Clip extracts
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

---

## Database Schema

14 tables with full foreign key constraints:

| Table | Purpose |
|-------|---------|
| `users` | Accounts, roles, profiles, stream keys, Hobo Bucks balances |
| `streams` | Active + historical streams, multi-protocol |
| `cameras` | Multi-camera support per stream |
| `chat_messages` | Stored chat (for moderation & VOD replay) |
| `follows` | User → streamer follow relationships |
| `subscriptions` | Tier 1/2/3 subscription tracking |
| `transactions` | Hobo Bucks ledger (purchases, donations, cashouts) |
| `donation_goals` | Streamer donation goals with progress |
| `vods` | Recorded streams (private by default) |
| `clips` | Short clips extracted from VODs |
| `stream_controls` | Interactive control buttons per stream |
| `api_keys` | Hardware API keys (hashed) |
| `bans` | User/IP/anon bans (site-wide or per-stream, with expiry) |
| `vpn_approvals` | VPN connection approval queue |

---

## Paired with HoboApp 🗺️

HoboStreamer is designed to pair with **HoboApp** — an Electron desktop app featuring 300+ curated stealth camping locations across Washington State, complete with:

- Interactive map with colored marker clusters
- Rain Cover intel & Crime data overlays
- 16-tab survival guide
- WiFi finder & Harm Reduction resources
- Photo attachments for locations

Together, HoboApp helps you **find** the spots — HoboStreamer lets you **share** the experience.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Server | Node.js / Express 4.21 |
| Database | SQLite 3 (better-sqlite3 11.3, WAL mode) |
| Auth | JWT (jsonwebtoken 9) + bcryptjs |
| WebSocket | ws 8.18 |
| JSMPEG Relay | HTTP → WebSocket bridge |
| WebRTC SFU | Mediasoup 3.14 (optional, requires native compilation) |
| RTMP Server | node-media-server 2.7 (ingest only on Node 24) |
| VOD Recording | FFmpeg |
| Frontend | Vanilla HTML/CSS/JS SPA |
| Icons | Font Awesome 6.5 |
| Hardware | Python 3 + websocket-client + gpiozero |
| Security | helmet, cors, express-rate-limit (120 req/min) |

---

## Security Notes

- JWT tokens expire after 7 days
- Passwords hashed with bcryptjs (salt rounds: 10)
- API keys hashed with bcrypt, shown once on generation
- Rate limiting: 120 requests/minute per IP on API routes
- Chat rate limiting: 1 message/second per IP
- VODs are **private by default** (OpSec for stealth campers)
- Word filter blocks location-disclosure keywords
- Ban system supports user, IP, and anonymous ID bans
- Supports both site-wide and per-stream bans with optional expiry

---

## Contributing

HoboStreamer is **open source and community driven**. Contributions welcome!

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -am 'Add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

### Ideas for Contributions
- Mobile-responsive improvements
- Docker deployment
- Cloud VOD storage (S3)
- Chat emotes system
- Follower email/push notifications
- Multi-language support
- Improved WebRTC browser capture UI
- Stream categories & discovery page
- Thumbnail generation from live streams

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

**Built with ☕ and 🏕️ by the HoboStreamer community.**
