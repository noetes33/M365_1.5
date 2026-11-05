# M365 Copilot Console v1.5 — IP/HTTP Docker test deployment

This repository is assembled from `noetes33/M365_V1.4` (original `cramt/m365-copilot-proxy` plus the v1.4 console) and the v1.4 HTTP/IP test overlay. The public repo upload does **not** build or run anything on Windows. The M365 Docker service is independent from existing Sub2API containers, which continue to use port 8080.

## On Ubuntu 24.04 ARM64 VPS (Docker + Compose already installed)

```bash
git clone https://github.com/noetes33/M365_1.5.git /root/M365_1.5
bash /root/M365_1.5/scripts/deploy-m365-v15.sh /root/M365_1.5
```

No host Node.js, host pnpm, domain name, or HTTPS certificate is required for this temporary test. The container builds Node.js 24 + pnpm 10 + Playwright. The image build will **run** `enable-console.mjs`, apply the HTTP test patch, install dependencies and run tests; it stops on errors. On ARM64, real Playwright/browser compatibility must be verified during the build.

If the GitHub uploader pushed a `import-v15-...` branch instead of `main`, merge that branch on GitHub first and only then clone or deploy.

## Access

Open `http://YOUR_VPS_IP:4142/admin/`; administrator username is `admin@local`. The installation script displays a random initial password once, and saves it in `/opt/m365-console-v15/console.env` with restrictive permissions. Data is persisted under `/opt/m365-console-v15/data`.

Cloud firewall/Oracle Cloud ingress must allow TCP/4142. The service deliberately publishes the admin port to all interfaces. The existing Sub2API Docker Compose projects are left unchanged.

## Verification and troubleshooting

```bash
cd /root/M365_1.5
docker compose -f compose.m365-iptest.yaml ps
docker compose -f compose.m365-iptest.yaml logs --tail=100 console
curl -fsS http://127.0.0.1:4142/health
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

To stop **only M365** (no volumes are removed):

```bash
cd /root/M365_1.5
docker compose -f compose.m365-iptest.yaml down
```

Do not run `docker system prune`, `docker compose down -v`, or modify the Sub2API Docker project while deploying this test.

## Security warning

This test mode allows Microsoft account password and TOTP seed submission over **unencrypted public HTTP** at the user's request. It is possible for network intermediaries to intercept them, and Internet scanning is continuous. File-at-rest encryption and admin access controls cannot protect transport. Use throwaway Microsoft test accounts, do not upload real secrets to a public Git repository, and stop public access when testing is complete. This is not a production architecture.

## Limitations

The original project's Microsoft authentication still depends on the identity provider and actual tenant permissions. The login flow may require manual MFA and may not work for every organization. There has not yet been an end-to-end test with this VPS, the ARM64 Chromium runtime, or a real Microsoft account. This release does not implement Responses API or Sub2API's paid billing features.
