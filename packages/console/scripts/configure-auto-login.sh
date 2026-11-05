#!/usr/bin/env bash
# Run locally on the host. Credentials never appear in command-line arguments.
set -euo pipefail
ACTION="${1:-set}"
ACCOUNT_ID="${2:-}"
if [[ -z "$ACCOUNT_ID" ]]; then read -r -p 'Isolated Microsoft account UUID: ' ACCOUNT_ID; fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$ACTION" != "set" ]]; then
  node "$SCRIPT_DIR/account-credentials.mjs" "$ACTION" "$ACCOUNT_ID"
  exit
fi
read -r -s -p 'Microsoft account password (input hidden): ' PASSWORD
printf '\n'
read -r -s -p 'TOTP Base32 seed (input hidden): ' TOTP_SEED
printf '\n'
# The passwords travel only via stdin pipes, never argv or the web server.
printf '%s\0%s\0' "$PASSWORD" "$TOTP_SEED" | node -e '
const chunks=[];process.stdin.on("data",b=>chunks.push(b));
process.stdin.on("end",()=>{const [password,mfaSecret]=Buffer.concat(chunks).toString("utf8").split("\0");process.stdout.write(JSON.stringify({password,mfaSecret}));});
' | node "$SCRIPT_DIR/account-credentials.mjs" set "$ACCOUNT_ID"
unset PASSWORD TOTP_SEED
