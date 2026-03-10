# HoboStreamer Setup Guide

This guide reflects the current HoboStreamer codebase and is aimed at a small production deployment on Linux.

Recommended baseline:

- Ubuntu or Debian server
- Node 20 LTS
- Nginx reverse proxy
- Cloudflare for the website
- `systemd` for process management
- only expose the streaming ports you actually use

---

## 1. What you are deploying

The current server in [server/index.js](server/index.js) includes:

- HTTP app on `PORT` with default `3000`
- WebSocket upgrades for `/ws/chat`, `/ws/broadcast`, `/ws/control`, `/ws/call`, and `/ws/game`
- JSMPEG relay support
- RTMP ingest support
- optional WebRTC / `mediasoup` support
- VOD, clip, thumbnail, avatar, emote, and media storage under [data](data)

### Common ports

Typical ports used by the codebase:

- `3000` — main HTTP app behind Nginx
- `1935` — RTMP ingest
- `9710` — JSMPEG video relay
- `9711` — JSMPEG audio relay
- `4443` — WebRTC TCP/UDP entry point in many setups
- `10000-10100/udp` — common `mediasoup` RTP range
- `9935` — HTTP-FLV playback if your RTMP stack exposes it

Do not expose all of them by default.

---

## 2. Recommended exposure strategy

### Lowest-risk deployment

For a small VPS, the safest starting model is:

1. expose only `80` and `443`
2. keep the website behind Cloudflare and Nginx
3. keep registration closed after bootstrap
4. leave RTMP, JSMPEG, HTTP-FLV, and raw WebRTC ports closed until needed
5. keep VOD and clip limits conservative

### Why

After reviewing the current codebase, the biggest abuse and bandwidth risks are:

- auth endpoints
- upload endpoints
- public media serving
- raw media ports that bypass normal web protections

That makes feature minimization one of the best security controls.

---

## 3. System packages

Install the baseline dependencies:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y \
  git curl wget unzip ca-certificates gnupg \
  nginx ffmpeg ufw fail2ban sqlite3 \
  build-essential python3 python3-pip
```

---

## 4. Install Node.js

Use Node 20 LTS.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Node 18+ is allowed by [package.json](package.json), but Node 20 LTS is the safer production default.

---

## 5. Clone and install

```bash
cd /opt
sudo git clone https://github.com/HoboStreamer/HoboStreamer.com.git hobostreamer
sudo chown -R $USER:$USER /opt/hobostreamer
cd /opt/hobostreamer
npm install
```

If native modules need rebuilding:

```bash
npm rebuild
```

If `mediasoup` fails to compile, WebRTC broadcasting will not be production-ready until that is resolved.

---

## 6. Configure `.env`

Copy the example file:

```bash
cp .env.example .env
nano .env
```

### Minimum production values

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-now

NODE_ENV=production
HOST=0.0.0.0
PORT=3000
BASE_URL=https://your-domain.example
JWT_SECRET=replace-with-a-long-random-secret

DB_PATH=./data/hobostreamer.db

RTMP_PORT=1935
JSMPEG_VIDEO_PORT=9710
JSMPEG_AUDIO_PORT=9711
WEBRTC_PORT=4443
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=YOUR_PUBLIC_IP
MEDIASOUP_MIN_PORT=10000
MEDIASOUP_MAX_PORT=10100

VOD_PATH=./data/vods
CLIPS_PATH=./data/clips
THUMBNAILS_PATH=./data/thumbnails
EMOTES_PATH=./data/emotes

MAX_VOD_SIZE_MB=128
MAX_EMOTE_SIZE_KB=128
MAX_EMOTES_PER_USER=10

MIN_CASHOUT=5
ESCROW_HOLD_DAYS=14
```

### Important notes

- set `BASE_URL` to the public HTTPS site URL
- set `JWT_SECRET` to a long random secret
- change the default admin password immediately
- set `MEDIASOUP_ANNOUNCED_IP` to the real public server IP if you use WebRTC
- keep media-size limits low unless you have the disk and bandwidth budget
- if you do not use a protocol, do not expose its firewall ports

Generate a secret with:

```bash
openssl rand -hex 32
```

---

## 7. Create runtime directories

The app creates missing runtime folders on boot, but it is still useful to ensure ownership is correct:

```bash
mkdir -p data/vods data/clips data/media data/thumbnails data/emotes data/avatars
```

---

## 8. Bootstrap the database

Start the server once to initialize the database, or run:

```bash
npm run init-db
```

Then start the app normally.

---

## 9. Close registration after onboarding

The current codebase checks the `site_settings` table for `registration_open`.

After creating your admin and trusted tester accounts, close public registration:

```bash
sqlite3 data/hobostreamer.db "UPDATE site_settings SET value='false' WHERE key='registration_open';"
```

Verify:

```bash
sqlite3 data/hobostreamer.db "SELECT key, value FROM site_settings WHERE key='registration_open';"
```

This is one of the simplest and most effective anti-abuse controls in the project.

---

## 10. Nginx reverse proxy

Use Nginx in front of the Node app.

Example server block:

```nginx
server {
    listen 80;
    server_name your-domain.example www.your-domain.example;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.example www.your-domain.example;

    ssl_certificate /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    client_max_body_size 128M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600;
    }
}
```

Enable it and reload Nginx.

---

## 11. TLS and Cloudflare

### Cloudflare

For the website:

- proxy the main web hostname through Cloudflare
- use **Full (strict)** SSL mode
- enable basic bot and rate-limit protections if available

### DNS-only records

Protocols like RTMP, JSMPEG, and raw WebRTC media ports usually need direct hostnames or direct IP access because they are not normal proxied website traffic.

Only create those DNS records if you actually need them.

---

## 12. Firewall policy

### Minimal website-only deployment

Open only:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### If you need RTMP ingest

```bash
sudo ufw allow 1935/tcp
```

### If you need JSMPEG

```bash
sudo ufw allow 9710/tcp
sudo ufw allow 9711/tcp
```

### If you need WebRTC / mediasoup

```bash
sudo ufw allow 4443/tcp
sudo ufw allow 4443/udp
sudo ufw allow 10000:10100/udp
```

Then enable the firewall:

```bash
sudo ufw enable
sudo ufw status
```

Open only what is actively required.

---

## 13. Run with `systemd`

Create `/etc/systemd/system/hobostreamer.service`:

```ini
[Unit]
Description=HoboStreamer
After=network.target

[Service]
Type=simple
User=deck
WorkingDirectory=/opt/hobostreamer
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable hobostreamer
sudo systemctl start hobostreamer
sudo systemctl status hobostreamer
```

---

## 14. Protocol-specific setup notes

### JSMPEG

Use JSMPEG when you want a simple FFmpeg-based broadcaster path. Keep in mind:

- it exposes extra relay ports
- it is harder to hide behind normal web protection layers
- it can increase origin bandwidth exposure

### RTMP

Use RTMP for OBS or FFmpeg broadcasters. Keep in mind:

- `1935/tcp` is a direct ingest port
- any HTTP-FLV or related playback path should be treated as additional exposure
- if you do not need RTMP this week, keep it closed this week

### WebRTC

Use WebRTC when you want browser-native streaming. Keep in mind:

- `mediasoup` must compile correctly on the host
- announced IP and UDP routing must be correct
- media ports are direct and not protected like ordinary proxied web traffic

---

## 15. Storage and bandwidth controls

The current codebase has upload and media systems for:

- avatars
- emotes
- thumbnails
- VODs
- clips
- media files

To reduce bandwidth and disk abuse:

- keep upload limits low
- prune old VODs and clips
- watch `data/` growth closely
- do not make every feature public at once
- keep registration closed when practical

Recent clip logic already adds:

- duplicate-clip reuse for near-simultaneous requests
- per-user clip cooldowns
- per-IP clip cooldowns

That helps, but it does not replace disk monitoring and sane retention policies.

---

## 16. Operational checks

### Health endpoint

After startup, verify:

- [server/index.js](server/index.js) health endpoint at `/api/health`
- website loads through Nginx
- WebSocket upgrade paths work
- only intended ports are reachable from the internet

### Logs

Check logs with:

```bash
journalctl -u hobostreamer -f
```

### Native module problems

If `better-sqlite3` or `mediasoup` fail after upgrades, rebuild modules before assuming the app is broken.

---

## 17. Recommended rollout order

The safest rollout order is:

1. website and API only
2. chat and auth
3. one streaming protocol
4. VODs and clips
5. optional calls, game, and hardware integrations
6. optional second and third broadcast protocols

That keeps blast radius and bandwidth waste down while you validate the deployment.

---

## 18. Summary

For most operators, the best production pattern is:

- Nginx + Cloudflare for the website
- Node 20 LTS
- `systemd` service supervision
- small upload limits
- closed registration by default
- only one streaming protocol exposed at a time unless there is a real need for more

See also [README.md](README.md) and the deployment helpers in [deploy](deploy).
