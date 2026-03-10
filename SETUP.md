# HoboStreamer Setup Guide

This guide is for deploying HoboStreamer on an OVH Public Cloud instance running Ubuntu 25.04, fronted by Cloudflare, with Nginx and Let's Encrypt on the origin.

It covers:

- creating the OVH instance
- generating an OVH-compatible SSH key
- first login and base hardening
- Cloudflare DNS and SSL/TLS setup
- Let's Encrypt origin certificates
- restoring the original visitor IP from Cloudflare
- Nginx reverse proxy setup
- Node.js, systemd, firewall, and HoboStreamer configuration
- protocol-specific port exposure for RTMP, JSMPEG, and WebRTC

This document reflects the current HoboStreamer codebase in [server/index.js](server/index.js).

---

## 1. Recommended production model

For a small or medium public deployment, the safest baseline is:

- OVH Public Cloud instance in the nearest region to your users
- Ubuntu 25.04
- Cloudflare proxy for the main website
- Nginx on the origin server
- Let's Encrypt certificate on the origin
- Cloudflare SSL/TLS mode set to **Full (strict)**
- Node 20 LTS for the application runtime
- `systemd` for process supervision
- `ufw` on the box
- only open the extra streaming ports you actively use

For most operators, expose only `80` and `443` first. Add RTMP, JSMPEG, or WebRTC ports later only if you really need them.

---

## 2. What HoboStreamer exposes

The current server in [server/index.js](server/index.js) provides:

- HTTP on `PORT`, default `3000`
- WebSocket upgrades on `/ws/chat`, `/ws/broadcast`, `/ws/control`, `/ws/call`, and `/ws/game`
- optional RTMP ingest
- optional JSMPEG relay
- optional WebRTC / `mediasoup`
- persistent data under [data](data)

Typical ports used by the codebase:

- `3000` — internal Node app port behind Nginx
- `80` — HTTP for redirect and Let's Encrypt validation
- `443` — HTTPS to Nginx
- `1935` — RTMP ingest
- `9710` — JSMPEG video relay
- `9711` — JSMPEG audio relay
- `4443` — WebRTC entry point in many setups
- `10000-10100/udp` — common `mediasoup` RTP range
- `9935` — HTTP-FLV playback if enabled in your RTMP stack

Do not expose all of them by default.

---

## 3. OVH instance creation choices

From the OVH “Create an instance” flow:

- template: your chosen instance flavor, for example `B3-16`
- region: nearest to your users, for example Seattle / `US-WEST-LZ-SEA-A`
- image: `Ubuntu 25.04`
- SSH key: required

### Important OVH SSH key note

In the OVH flow you provided, the dashboard explicitly states:

- only **RSA** and **ECDSA** SSH keys are accepted
- **ED25519** keys are not accepted in that flow

So for this deployment, generate either:

- **ECDSA P-384** — recommended if OVH accepts it in your project flow
- **RSA 4096** — safest fallback if you want maximum compatibility

---

## 4. Generate an SSH key for OVH

Run these commands on your local machine, not on the server.

### Option A: ECDSA P-384 key

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ecdsa -b 384 -f ~/.ssh/ovh_hobostreamer_ecdsa -C "ovh-hobostreamer"
```

### Option B: RSA 4096 key

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t rsa -b 4096 -o -a 100 -f ~/.ssh/ovh_hobostreamer_rsa -C "ovh-hobostreamer"
```

### Lock down the private key

```bash
chmod 600 ~/.ssh/ovh_hobostreamer_ecdsa
chmod 644 ~/.ssh/ovh_hobostreamer_ecdsa.pub
```

Or for RSA:

```bash
chmod 600 ~/.ssh/ovh_hobostreamer_rsa
chmod 644 ~/.ssh/ovh_hobostreamer_rsa.pub
```

### Print the public key to paste into OVH

ECDSA:

```bash
cat ~/.ssh/ovh_hobostreamer_ecdsa.pub
```

RSA:

```bash
cat ~/.ssh/ovh_hobostreamer_rsa.pub
```

Copy the entire single-line public key into the OVH SSH key field.

### Test the key fingerprint locally

ECDSA:

```bash
ssh-keygen -lf ~/.ssh/ovh_hobostreamer_ecdsa.pub
```

RSA:

```bash
ssh-keygen -lf ~/.ssh/ovh_hobostreamer_rsa.pub
```

---

## 5. Import the SSH key into OVH

In OVH Public Cloud:

1. go to your Public Cloud project
2. open the SSH keys area, or paste the key directly during instance creation
3. give the key a clear name, for example `hobostreamer-seattle-prod`
4. paste the public key line from the `.pub` file
5. create the instance with that key attached

OVH documentation also notes that SSH keys can be stored in the control panel and reused across regions.

---

## 6. Connect to the new Ubuntu 25.04 instance

After the instance is created and shows as ready, connect over SSH.

Most OVH Ubuntu cloud images use the `ubuntu` user first.

ECDSA example:

```bash
ssh -i ~/.ssh/ovh_hobostreamer_ecdsa ubuntu@YOUR_SERVER_IP
```

RSA example:

```bash
ssh -i ~/.ssh/ovh_hobostreamer_rsa ubuntu@YOUR_SERVER_IP
```

Optional: add a host alias to your local SSH config:

```sshconfig
Host hobostreamer-ovh
    HostName YOUR_SERVER_IP
    User ubuntu
    IdentityFile ~/.ssh/ovh_hobostreamer_ecdsa
    IdentitiesOnly yes
```

Then connect with:

```bash
ssh hobostreamer-ovh
```

---

## 7. First-login hardening on Ubuntu 25.04

Run these commands on the server.

### Update the box

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt autoremove -y
```

### Install baseline packages

```bash
sudo apt install -y \
  git curl wget unzip ca-certificates gnupg \
  nginx ffmpeg ufw fail2ban sqlite3 \
  build-essential python3 python3-pip jq
```

### Optional: create a dedicated app user

If you do not want to run from the default `ubuntu` user:

```bash
sudo adduser --disabled-password --gecos "" hobostreamer
sudo usermod -aG sudo hobostreamer
```

Then add your public key for that user:

```bash
sudo mkdir -p /home/hobostreamer/.ssh
sudo nano /home/hobostreamer/.ssh/authorized_keys
sudo chown -R hobostreamer:hobostreamer /home/hobostreamer/.ssh
sudo chmod 700 /home/hobostreamer/.ssh
sudo chmod 600 /home/hobostreamer/.ssh/authorized_keys
```

### Harden SSH a bit

Edit:

```bash
sudo nano /etc/ssh/sshd_config
```

Recommended settings:

```text
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
UsePAM yes
X11Forwarding no
```

Then reload SSH:

```bash
sudo systemctl reload ssh
```

Do not disable password auth until you have confirmed key login works.

---

## 8. Install Node.js 20 LTS

Although [package.json](package.json) allows Node 18+, Node 20 LTS is the recommended production baseline.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Verify the binary is visible at `/usr/bin/node`. On some Ubuntu versions the
NodeSource package installs to `/usr/local/bin` or doesn't create a symlink:

```bash
which node            # should print /usr/bin/node
ls -l /usr/bin/node   # should exist
```

If `which node` returns a different path (e.g. `/usr/local/bin/node`) or is
missing, create a symlink so `systemd` and `npm` scripts can find it:

```bash
sudo ln -sf "$(which node)" /usr/bin/node
```

---

## 9. Clone HoboStreamer

```bash
cd /opt
sudo git clone https://github.com/HoboStreamer/HoboStreamer.com.git hobostreamer
sudo chown -R $USER:$USER /opt/hobostreamer
cd /opt/hobostreamer
npm install
```

If native modules later need rebuilding:

```bash
npm rebuild
```

If `mediasoup` fails to compile, browser-native WebRTC broadcasting will not be ready until that is fixed.

---

## 10. Configure HoboStreamer environment

Copy the example file:

```bash
cd /opt/hobostreamer
cp .env.example .env
nano .env
```

### Recommended starting `.env`

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

Generate a strong JWT secret:

```bash
openssl rand -hex 32
```

### Notes

- set `BASE_URL` to your final public HTTPS hostname
- set `MEDIASOUP_ANNOUNCED_IP` to the real public OVH IP if you use WebRTC
- keep upload and media limits low on small servers
- do not expose unused protocols just because they are available in the codebase

---

## 11. Create runtime directories

The app creates them on boot, but it is still fine to pre-create them:

```bash
cd /opt/hobostreamer
mkdir -p data/vods data/clips data/media data/thumbnails data/emotes data/avatars
```

---

## 12. Bootstrap the app once

Initialize the database if needed:

```bash
cd /opt/hobostreamer
npm run init-db
```

Or just start it once manually:

```bash
npm start
```

Then stop it and move on to `systemd` setup.

---

## 13. Cloudflare DNS setup

In Cloudflare DNS:

### Main website

Create:

- `A` record for `@` → `YOUR_OVH_PUBLIC_IP`
- `CNAME` for `www` → your apex hostname

Set both to **Proxied** after the origin is working.

### Optional direct-hostname records for non-HTTP protocols

Only create these if you really need them:

- `A` record `rtmp` → `YOUR_OVH_PUBLIC_IP` for RTMP ingest
- optional `A` record `webrtc` → `YOUR_OVH_PUBLIC_IP`
- optional `A` record `jsmpeg` → `YOUR_OVH_PUBLIC_IP`

These are usually **DNS only** because they are not standard proxied website traffic.

---

## 14. Let's Encrypt on Ubuntu 25.04

For end-to-end encryption with Cloudflare, the origin must present a valid certificate.

Cloudflare’s **Full (strict)** mode requires the origin certificate to be:

- unexpired
- valid for the requested hostname
- issued by a publicly trusted CA or Cloudflare Origin CA

This guide uses **Let's Encrypt** on the OVH origin.

### Install Certbot

On Ubuntu 25.04, a reliable approach is the snap-based install:

```bash
sudo apt install -y snapd
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/local/bin/certbot
certbot --version
```

### Temporary Nginx HTTP site

Before requesting the cert, create a plain HTTP Nginx site so your domain answers on port 80.

Create:

```bash
sudo nano /etc/nginx/sites-available/hobostreamer
```

Add:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.example www.your-domain.example;

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

Enable it:

```bash
sudo ln -sf /etc/nginx/sites-available/hobostreamer /etc/nginx/sites-enabled/hobostreamer
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### Request the certificate

If Cloudflare proxying causes validation issues, temporarily set the DNS records to **DNS only** until issuance succeeds, then proxy them again.

Run:

```bash
sudo certbot --nginx -d your-domain.example -d www.your-domain.example
```

### Verify auto-renewal

```bash
sudo systemctl list-timers | grep certbot || true
sudo certbot renew --dry-run
```

---

## 15. Cloudflare end-to-end encryption setup

Once the origin has a valid Let's Encrypt cert:

1. open the Cloudflare dashboard
2. go to **SSL/TLS**
3. set encryption mode to **Full (strict)**

This gives you encrypted browser-to-Cloudflare and encrypted Cloudflare-to-origin traffic, with origin certificate validation.

### Recommended Cloudflare settings

Under Cloudflare, also consider enabling:

- **Always Use HTTPS**
- **Automatic HTTPS Rewrites**
- WAF / bot protections if available on your plan
- rate limiting for sensitive paths if available

### Optional stronger origin protection

If you want an extra check that only Cloudflare is hitting your HTTPS origin, add Cloudflare IP allowlists at the firewall or Nginx layer, or configure Authenticated Origin Pulls later.

---

## 16. Restore the real visitor IP from Cloudflare

By default, your origin sees Cloudflare edge IPs. Cloudflare provides the original visitor IP in the `CF-Connecting-IP` header.

Cloudflare recommends using `CF-Connecting-IP` instead of `X-Forwarded-For` when you want one stable client IP value.

### Current Cloudflare IP ranges

At the time of writing, Cloudflare publishes these ranges.

IPv4:

```text
173.245.48.0/20
103.21.244.0/22
103.22.200.0/22
103.31.4.0/22
141.101.64.0/18
108.162.192.0/18
190.93.240.0/20
188.114.96.0/20
197.234.240.0/22
198.41.128.0/17
162.158.0.0/15
104.16.0.0/13
104.24.0.0/14
172.64.0.0/13
131.0.72.0/22
```

IPv6:

```text
2400:cb00::/32
2606:4700::/32
2803:f800::/32
2405:b500::/32
2405:8100::/32
2a06:98c0::/29
2c0f:f248::/32
```

You should periodically verify these against Cloudflare’s published `ips-v4` and `ips-v6` lists.

### Nginx real IP config

Create:

```bash
sudo nano /etc/nginx/conf.d/cloudflare-realip.conf
```

Add:

```nginx
real_ip_header CF-Connecting-IP;

set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
set_real_ip_from 2400:cb00::/32;
set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;
set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;
set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;
real_ip_recursive on;
```

Then test and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Optional custom log format including Cloudflare info

Create or edit an Nginx logging config:

```bash
sudo nano /etc/nginx/conf.d/log_format_cloudflare.conf
```

Example:

```nginx
log_format cloudflare_combined '$remote_addr - $remote_user [$time_local] '
                                '"$request" $status $body_bytes_sent '
                                '"$http_referer" "$http_user_agent" '
                                'cf_ray=$http_cf_ray cf_ip=$http_cf_connecting_ip';
```

Then apply it in your site with:

```nginx
access_log /var/log/nginx/hobostreamer.access.log cloudflare_combined;
```

### Why this matters for HoboStreamer

HoboStreamer uses Express with `trust proxy` enabled in [server/index.js](server/index.js). Correct Nginx real-IP handling helps ensure logs, moderation decisions, rate limiting, and security signals use the real visitor IP instead of a Cloudflare edge IP.

---

## 17. Final Nginx HTTPS config

After Certbot runs, tighten the site config.

A good final config looks like this:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.example www.your-domain.example;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.example www.your-domain.example;

    ssl_certificate /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    access_log /var/log/nginx/hobostreamer.access.log cloudflare_combined;
    error_log /var/log/nginx/hobostreamer.error.log;

    client_max_body_size 128M;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

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

Then:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 18. Firewall on Ubuntu

### Minimal website-only deployment

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
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

Only open what you actively use.

---

## 19. OVH networking and security-group note

OVH’s OpenStack-based Public Cloud documentation notes that the default security group can allow broad traffic by default.

That means you should not rely on OVH defaults alone.

Use at least one of these:

- `ufw` on the instance
- OVH/OpenStack security groups if you manage networking that way
- Nginx allowlists for sensitive origin access paths

If you build custom OVH security groups, follow the same principle: start from least privilege and only open the exact ports you need.

---

## 20. Run HoboStreamer with `systemd`

Create:

```bash
sudo nano /etc/systemd/system/hobostreamer.service
```

Use:

```ini
[Unit]
Description=HoboStreamer
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/hobostreamer
Environment=NODE_ENV=production
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If you created a dedicated `hobostreamer` user, change `User=ubuntu` to `User=hobostreamer` and ensure ownership of `/opt/hobostreamer` matches.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable hobostreamer
sudo systemctl start hobostreamer
sudo systemctl status hobostreamer
```

Logs:

```bash
journalctl -u hobostreamer -f
```

---

## 21. Close registration after bootstrap

After you create your initial admin and trusted test accounts, close public registration.

```bash
cd /opt/hobostreamer
sqlite3 data/hobostreamer.db "UPDATE site_settings SET value='false' WHERE key='registration_open';"
sqlite3 data/hobostreamer.db "SELECT key, value FROM site_settings WHERE key='registration_open';"
```

This is one of the cheapest and strongest anti-abuse controls in the project.

---

## 22. Optional fail2ban baseline

Install:

```bash
sudo apt install -y fail2ban
```

Basic jail file:

```bash
sudo nano /etc/fail2ban/jail.local
```

Example:

```ini
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
```

Then:

```bash
sudo systemctl enable fail2ban
sudo systemctl restart fail2ban
sudo fail2ban-client status
```

If most web traffic is behind Cloudflare, make sure your Nginx real-IP config is correct before relying on log-based web jails.

---

## 23. Protocol-specific exposure guidance

### RTMP

Expose `1935/tcp` only if you need OBS or FFmpeg ingest.

### JSMPEG

Expose `9710/tcp` and `9711/tcp` only if you use the relay.

### WebRTC

Expose only the exact WebRTC TCP/UDP and RTP ports you need. Make sure:

- `MEDIASOUP_ANNOUNCED_IP` matches your public OVH IP
- your firewall allows the RTP range
- your Cloudflare setup is not expected to proxy raw media ports

---

## 24. Operational checks

### App health

Verify:

- `http://127.0.0.1:3000/api/health` on the server
- `https://your-domain.example/api/health` through Nginx and Cloudflare

### TLS

Verify:

- browser sees a valid certificate
- Cloudflare SSL/TLS mode is **Full (strict)**
- no redirect loops
- no mixed-content warnings

### Visitor IP restoration

Check Nginx logs and confirm the client IP is not just a Cloudflare edge IP.

### Port audit

Check that only intended ports are reachable from the internet.

Example:

```bash
sudo ss -tulpn
sudo ufw status verbose
```

---

## 25. Full beginning-to-end command summary

If you want the short version, the high-level order is:

1. generate an OVH-compatible SSH key locally
2. create the OVH Ubuntu 25.04 instance with that public key
3. SSH into the new instance
4. update packages and install Nginx, Node 20, FFmpeg, `ufw`, and `fail2ban`
5. clone HoboStreamer into `/opt/hobostreamer`
6. configure `.env`
7. start the app once and verify `/api/health`
8. set Cloudflare DNS to the OVH IP
9. configure Nginx
10. issue a Let's Encrypt certificate with Certbot
11. enable Cloudflare **Full (strict)**
12. add Cloudflare real-IP config in Nginx
13. enable `systemd` for HoboStreamer
14. close public registration after bootstrap
15. open only the extra media ports you actually need

---

## 26. Security reminders

- never use ED25519 if the OVH flow in your account rejects it
- keep your private SSH key only on trusted admin machines
- disable password SSH once key auth is confirmed
- keep `JWT_SECRET` long and random
- keep the website behind Cloudflare
- do not expose raw media ports unnecessarily
- keep upload limits low on small servers
- close registration when not actively onboarding users
- monitor `data/` growth for VODs, clips, thumbnails, avatars, and emotes

---

## 27. References behind this setup

This guide was aligned with current public guidance from:

- OVH Public Cloud instance creation and SSH-key setup guidance
- Cloudflare documentation for `CF-Connecting-IP` and restoring original visitor IPs
- Cloudflare documentation for **Full (strict)** mode
- current Certbot installation and Nginx integration guidance

---

## 28. Summary

For OVH + Ubuntu 25.04, the best HoboStreamer deployment pattern is:

- RSA or ECDSA SSH key uploaded to OVH
- Ubuntu 25.04 on OVH Public Cloud
- Node 20 LTS
- Nginx reverse proxy on the box
- Let's Encrypt certificate on the origin
- Cloudflare proxy with **Full (strict)**
- Cloudflare real-IP restoration in Nginx
- `systemd`, `ufw`, `fail2ban`
- only one streaming protocol exposed at a time unless you have a real need for more

See also [README.md](README.md) and [deploy](deploy).
