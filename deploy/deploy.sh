#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"

release_image=${1:?Usage: bash deploy.sh ghcr.io/OWNER/REPO:COMMIT_SHA}
if [[ ! "$release_image" =~ ^ghcr\.io/[a-z0-9._/-]+:[a-f0-9]{40}$ ]]; then
  echo "Expected a GHCR image tagged with a full commit SHA." >&2
  exit 1
fi
export ASTRA_IMAGE="$release_image"

# The same lock also protects manual deploys from overlapping Actions runs.
exec 9>.deploy.lock
flock -n 9 || { echo "Another deployment is running." >&2; exit 1; }
test -f .env || { echo "Create the server .env first." >&2; exit 1; }
chmod 600 .env
docker compose --profile tools config --quiet
case "${2:-}" in
  "") docker compose --profile tools pull bot migrate postgres ;;
  --loaded-images)
    docker image inspect "$ASTRA_IMAGE" "$ASTRA_IMAGE-migrate" >/dev/null
    docker compose pull postgres
    ;;
  *) echo "Unknown deployment option." >&2; exit 1 ;;
esac
docker compose up -d --wait --wait-timeout 120 postgres

# Keep one polling process; do not restart old code after a failed migration.
docker compose stop bot
mkdir -p backups
backup_path="backups/$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres pg_dump -U astra -d astra -Fc > "$backup_path.tmp"
mv "$backup_path.tmp" "$backup_path"
docker compose run --rm --no-deps migrate
if ! docker compose up -d --no-deps --wait --wait-timeout 180 bot; then
  docker compose stop bot
  echo "Bot startup failed; stopped it to prevent a restart loop. Inspect bot logs." >&2
  exit 1
fi
printf 'ASTRA_IMAGE=%s\n' "$ASTRA_IMAGE" > .release.env.tmp
mv .release.env.tmp .release.env
echo "Deployment healthy. Database backup: $backup_path"
