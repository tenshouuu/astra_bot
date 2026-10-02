#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"

test -f .release.env || { echo "Deploy a healthy release first." >&2; exit 1; }
IFS= read -r release_entry < .release.env
if [[ ! "$release_entry" =~ ^ASTRA_IMAGE=ghcr\.io/[a-z0-9._/-]+:[a-f0-9]{40}$ ]]; then
  echo "Invalid release image; deploy a healthy release first." >&2
  exit 1
fi
export ASTRA_IMAGE="${release_entry#ASTRA_IMAGE=}"
exec 9>.deploy.lock
flock -w 300 9
mkdir -p backups
backup_path="backups/$(date -u +%Y%m%dT%H%M%SZ)-daily.dump"
docker compose exec -T postgres pg_dump -U astra -d astra -Fc > "$backup_path.tmp"
mv "$backup_path.tmp" "$backup_path"
# Keep deployment backups until the operator removes them.
find backups -type f -name '*-daily.dump' -mtime +7 -delete
echo "Database backup: $backup_path"
