# Deploy M365 Copilot Console v1.4 on a VPS

This repo combines the upstream `cramt/m365-copilot-proxy` source and an additive `packages/console/` overlay. The overlay deliberately has NOT been built on the upload PC.

Requirements on the VPS: Git, Node.js 24+, pnpm 10+. After cloning this repo on the VPS, run:

```bash
git clone https://github.com/noetes33/M365_V1.4.git
cd M365_V1.4
node scripts/enable-console.mjs
pnpm install
pnpm build
pnpm console:test
```

The `enable-console.mjs` step registers `pnpm console` and applies the console-specific authentication isolation/privacy patch. DO NOT SKIP IT. Its compatibility with the upstream commit included here must be checked; if it fails, stop instead of ignoring errors.

The console binds to localhost by default. Set an administrator password securely and configure a trusted HTTPS reverse proxy before using the web UI. Read `docs/M365_Console_v1.4_README.md` for the complete deployment/security requirements. This system has not been validated against a real Microsoft tenant. Never commit credential caches, passwords, TOTP seeds, databases, or `.env` files.
