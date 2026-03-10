#!/usr/bin/env sh
set -eu

DOMAIN="${1:-hobostreamer.com}"
SERVICE="${2:-hobostreamer}"

echo "== systemd =="
sudo systemctl status "$SERVICE" --no-pager || true

echo
 echo "== nginx test =="
sudo nginx -t

echo
 echo "== health check =="
curl -fsS "https://$DOMAIN/api/health" || true

echo
 echo "== listening ports =="
ss -tulpn | grep -E ':(80|443|1935|9935|9710|9711|4443|3000)\b' || true

echo
 echo "== ufw =="
sudo ufw status || true

echo
 echo "== fail2ban =="
sudo fail2ban-client status || true

echo
 echo "== recent service logs =="
journalctl -u "$SERVICE" -n 50 --no-pager || true
