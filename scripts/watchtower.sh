#!/usr/bin/env bash
# Watchtower: auto-pull and restart djinn services when new commits land.
# Usage: pm2 start scripts/watchtower.sh --name watchtower --cron "*/30 * * * *" --no-autorestart

set -euo pipefail
cd "$(dirname "$0")/.."

LOCAL=$(git rev-parse HEAD)
git fetch origin main --quiet
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "$(date -Iseconds) Up to date at $(git rev-parse --short HEAD)"
    exit 0
fi

echo "$(date -Iseconds) Updating: $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
git pull --ff-only origin main

# Restart whichever djinn services are running
for svc in djinn-validator djinn-miner; do
    if pm2 describe "$svc" > /dev/null 2>&1; then
        echo "Restarting $svc"
        pm2 restart "$svc" --update-env
    fi
done

echo "$(date -Iseconds) Done. Now at $(git rev-parse --short HEAD)"
