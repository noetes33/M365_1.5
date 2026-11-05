# M365 Console v1.4 — public IP + HTTP test deployment

This overlay is designed for the already cloned `/root/M365_V1.4` source. No domain, SSL certificate, host Node.js, or host pnpm is needed. On the ARM64 VPS with Docker running Sub2API, it adds a *separate* M365 container and binds public `TCP/4142`. It does not stop or reconfigure Sub2API on 8080, PostgreSQL, or Redis.

## Deploy

Upload `M365_V1.4_HTTP_IP_Test_Kit.zip` to `/root` and run:

```bash
mkdir -p /root/m365-ip-kit
python3 -m zipfile -e /root/M365_V1.4_HTTP_IP_Test_Kit.zip /root/m365-ip-kit
bash /root/m365-ip-kit/deploy-ip-http-test.sh /root/M365_V1.4
```

Open **http://YOUR_VPS_IP:4142/admin/** on your laptop. User: `admin@local`. The initial password is displayed one time during installation and saved in `/opt/m365-console/console.env`, owned by root with mode 0600. If an earlier installation already created an env file, the script reuses that password.

Allow **TCP 4142** inbound in Oracle Cloud security lists or NSGs (and any host firewall). The cloud may still block it. This kit *deliberately* binds `0.0.0.0:4142`. Do not forward port 8080 or disrupt Sub2API.

## What changed

* Docker bridge port publishing (`0.0.0.0:4142:4142`) rather than `host` networking + loopback-only bind.
* Explicit `M365_HTTP_TEST_MODE=1` permits `0.0.0.0` and bypasses the HTTPS-only gate for the saved Microsoft password/TOTP form.
* Keeps admin login, CSRF, role checks, admin password re-entry, API-Key checks, rate limiting, vault encryption at rest.
* Browsers without secure-context clipboard API get a fallback so "Copy ID" and "Copy key" work over HTTP.
* The patch applies *only during the Docker image build*; your GitHub source is not modified, although the overlay scripts are copied into the local checkout.

## Important danger

An HTTP connection transmits **admin password, Microsoft password, and TOTP seed in cleartext over the network**, even though credentials are AES-256-GCM encrypted once saved. Anyone who can intercept traffic, or who reaches a vulnerable public test service, may compromise an account. Use a throwaway test account, avoid real passwords/TOTP, restrict incoming 4142 to your own public IP in the cloud firewall, and turn this mode off after testing. "Not in production" does not prevent Internet scanning.

## Verify

```bash
cd /root/M365_V1.4
docker compose -f compose.m365-iptest.yaml ps
docker compose -f compose.m365-iptest.yaml logs --tail=120 console
curl -fsS http://127.0.0.1:4142/health
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

## Remove only the test service

```bash
cd /root/M365_V1.4
docker compose -f compose.m365-iptest.yaml down
```

Do **not** use `down -v` or delete `/opt/m365-console/data`: the latter stores your account records and encrypted credentials. Do not use Docker `prune` because it could affect other projects.

## Limitations

The original project's Microsoft browser authorization behavior and ARM64 Chromium availability still require real VPS build and login testing. This kit is an **HTTP test mode**, not a recommendation for long-term public internet access. It does not bypass Microsoft login requirements or account-based rate limits.
