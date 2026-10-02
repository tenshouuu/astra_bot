#!/usr/bin/env bash
set -euo pipefail

deploy_host=${1:?Usage: bash configure-github.sh VPS_HOST OWNER/REPO}
repository=${2:?Specify OWNER/REPO}
[[ "$deploy_host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || exit 1
[[ "$repository" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || exit 1
gh auth status

printf '%s' "$deploy_host" | gh secret set DEPLOY_HOST --repo "$repository"
printf '%s' deploy | gh secret set DEPLOY_USER --repo "$repository"
ssh -o StrictHostKeyChecking=yes "root@$deploy_host" 'cat /home/deploy/.ssh/github-actions' |
  gh secret set DEPLOY_SSH_KEY --repo "$repository"
ssh -o StrictHostKeyChecking=yes "root@$deploy_host" 'cat /etc/ssh/ssh_host_ed25519_key.pub' |
  awk -v host="$deploy_host" '{print host, $1, $2}' |
  gh secret set DEPLOY_KNOWN_HOSTS --repo "$repository"

echo "GitHub deployment secrets configured."
