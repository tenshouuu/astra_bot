#!/usr/bin/env bash
set -euo pipefail
umask 077

IFS= read -r registry_token
IFS= read -r registry_user
IFS= read -r release_image
registry_config=$(mktemp -d)
trap 'rm -rf -- "$registry_config"' EXIT
export DOCKER_CONFIG="$registry_config"
printf '%s' "$registry_token" | docker login ghcr.io -u "$registry_user" --password-stdin
unset registry_token
bash "$(dirname "$0")/deploy.sh" "$release_image"
