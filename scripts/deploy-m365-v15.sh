#!/usr/bin/env bash
# Deploys only the M365 v1.5 test service; leaves other Docker projects intact.
set -euo pipefail
umask 077
ROOT_DIR="${1:-/root/M365_1.5}"
DATA_DIR=/opt/m365-console-v15
COMPOSE_FILE="$ROOT_DIR/compose.m365-iptest.yaml"

if [ "$(id -u)" -ne 0 ]; then echo 'Run this script as root.' >&2; exit 1; fi
if [ ! -f "$ROOT_DIR/scripts/enable-console.mjs" ] || [ ! -f "$ROOT_DIR/scripts/m365-ip-http-patch.mjs" ] || [ ! -f "$COMPOSE_FILE" ]; then
  echo "M365_1.5 source files missing in $ROOT_DIR. Push and clone the full repository first." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo 'Docker and Docker Compose plugin are required.' >&2
  exit 1
fi
if ss -H -lnt | awk '{print $4}' | grep -Eq '(^|:)4142$'; then
  echo 'TCP 4142 is occupied; no services were modified.' >&2
  exit 1
fi

install -d -m 700 "$DATA_DIR" "$DATA_DIR/data"
chown 1000:1000 "$DATA_DIR/data"
NEW_PASSWORD=''
if [ ! -f "$DATA_DIR/console.env" ]; then
  NEW_PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'M365_ADMIN_PASSWORD=%s\n' "$NEW_PASSWORD" > "$DATA_DIR/console.env"
  chmod 600 "$DATA_DIR/console.env"
  echo 'New M365 admin credentials generated (will be shown after startup).'
else
  echo "Existing $DATA_DIR/console.env kept; administrator password unchanged."
fi

cd "$ROOT_DIR"
docker compose -f "$COMPOSE_FILE" config --quiet
printf '\nBuilding isolated M365 test container (this can download Chromium and take time)...\n'
docker compose -f "$COMPOSE_FILE" build
if ss -H -lnt | awk '{print $4}' | grep -Eq '(^|:)4142$'; then
  echo 'TCP 4142 became occupied during build. No new container started.' >&2
  exit 1
fi
docker compose -f "$COMPOSE_FILE" up -d --no-build
printf '\n========== M365 container status ==========\n'
docker compose -f "$COMPOSE_FILE" ps
printf '\n========== M365 local health check ==========\n'
curl -fsS --max-time 15 http://127.0.0.1:4142/health || true
printf '\nLogin address: http://VPS_PUBLIC_IP:4142/admin/\n'
if [ -n "$NEW_PASSWORD" ]; then
  echo 'Initial administrator username: admin@local'
  echo "Initial administrator password: $NEW_PASSWORD"
  unset NEW_PASSWORD
else
  echo "Administrator password was preserved at $DATA_DIR/console.env"
fi
printf '\nTCP 4142 must be allowed in your cloud ingress rules. Sub2API on port 8080 is untouched.\n'
printf 'WARNING: HTTP sends login credentials and TOTP seeds over the network without encryption. Use isolated test accounts only.\n'
