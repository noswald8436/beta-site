#!/usr/bin/env bash
# Run on the web VM: bash scripts/deploy.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/beta
WEB=/var/www/beta
STATE=/var/lib/beta

git -C "$SRC" pull --ff-only

sudo install -d -o webapp -g webapp "$APP/server"
sudo install -o webapp -g webapp -m 644 "$SRC/server/server.js" "$APP/server/server.js"
sudo install -o webapp -g webapp -m 644 "$SRC/package.json" "$APP/package.json"
sudo install -d -o webapp -g webapp -m 750 "$STATE"

sudo install -d -m 755 "$WEB"
sudo rsync -a --delete "$SRC/public/" "$WEB/"

sudo systemctl restart beta
sleep 1
curl -fsS http://127.0.0.1:3001/api/health >/dev/null && echo "beta API is healthy"
curl -fsS http://127.0.0.1:3001/api/signal >/dev/null && echo "Signal Watch API is healthy"
echo "deployed $(date)"
