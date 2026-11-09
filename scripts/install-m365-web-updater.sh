#!/usr/bin/env bash
# Run one time on the original M365 VPS as root. Later updates use the web UI.
set -euo pipefail
if [ "$(id -u)" != "0" ]; then echo 'Run as root' >&2; exit 1; fi
cd /root/M365_1.5
test -f compose.m365-iptest.yaml
test -f scripts/m365-console-web-updater.py
test -d /opt/m365-console-v15/data
test -f /opt/m365-console-v15/console.env
origin=$(git remote get-url origin)
case "$origin" in
  https://github.com/noetes33/M365_1.5|https://github.com/noetes33/M365_1.5.git|git@github.com:noetes33/M365_1.5|git@github.com:noetes33/M365_1.5.git) ;;
  *) echo "Unexpected git origin; stopping" >&2; exit 1;;
esac

install -o root -g root -m 0755 scripts/m365-console-web-updater.py /usr/local/sbin/m365-console-web-updater
install -d -o 1000 -g 1000 -m 0700 /opt/m365-console-v15/data/updates
python3 - <<'PY'
import json,os,tempfile,subprocess
from pathlib import Path
p=Path('/opt/m365-console-v15/data/updates/release.json')
if not p.exists():
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd='/root/M365_1.5',text=True).strip()
    p.write_text(json.dumps({'commit':commit,'updatedAt':'initial setup'})+'\n',encoding='utf-8')
    p.chmod(0o644)
PY
cat > /etc/systemd/system/m365-console-web-update.service <<'UNIT'
[Unit]
Description=M365 Console fixed-source web updater
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
User=root
Group=root
ExecStart=/usr/local/sbin/m365-console-web-updater
WorkingDirectory=/root/M365_1.5
TimeoutStartSec=0
NoNewPrivileges=true
UNIT
cat > /etc/systemd/system/m365-console-web-update.path <<'UNIT'
[Unit]
Description=Watch for M365 Console web update requests

[Path]
PathExists=/opt/m365-console-v15/data/updates/request.json
Unit=m365-console-web-update.service

[Install]
WantedBy=multi-user.target
UNIT

touch /opt/m365-console-v15/data/updates/ready
chown root:root /opt/m365-console-v15/data/updates/ready
chmod 0644 /opt/m365-console-v15/data/updates/ready
systemctl daemon-reload
systemctl enable --now m365-console-web-update.path
systemctl is-active m365-console-web-update.path
printf '\nHost updater installed. Future updates: M365 Console top-left button.\n'
