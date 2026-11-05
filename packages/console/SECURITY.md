# Security and trust boundaries — M365 Console v1.2

- Only use explicitly authorized Microsoft 365 school/work identities. Never automate MFA bypass, account sharing to evade licensing, or rate-limit circumvention.
- Admin console binds to loopback. The per-account worker binds to loopback on a random port and verifies an in-memory 384-bit worker secret. Never make these ports public.
- Each isolated account uses a separate worker process, separate `M365_CACHE_FILE`, `M365_BROWSER_PROFILE`, and isolated API-key session pools. No raw Microsoft tokens are returned by admin endpoints.
- No password, browser cookies, TOTP secrets, or OAuth refresh tokens are accepted by the management UI. However, **MSAL cache and browser profiles on disk contain sensitive credentials** and require disk encryption, restricted OS permissions, secure backups, and careful unlink/retirement.
- Starting interactive authorization is admin-only and CSRF-protected. The upstream Microsoft login window opens **locally on the server desktop**, not in a remote browser tab. Ensure the running desktop belongs to the legitimate account user.
- Configure expected Microsoft email before linking; a mismatch or multiple identities in the cache blocks routing. A GUID-format tenant hint enforces tenant equality; a freeform hint is informational only.
- Channels can only point to their linked `account://uuid` worker, or loopback local endpoints for old proxy accounts. A new API key must bind to an explicitly granted account, and account grants are rechecked on every API request. A revoked grant invalidates existing keys immediately.
- API keys are random and are stored as SHA-256 digests. Admin passwords are salted scrypt hashes. Management sessions use HttpOnly/SameSite cookies and CSRF checks. Avoid reverse-proxying this service directly to the public internet.
- Usage and audit logs intentionally omit prompts, generated answers, Microsoft tokens and API key secrets. Historical usage remains after account unlink.
- Legacy channels and CLI modules remain available separately; they are not protected by the new admin gateway if you start an old proxy service on a public port. Do not expose raw upstream services.
- Request credits are an application-level counter, not authentic M365 token accounting. SQLite single-instance quota enforcement is not production-grade distributed billing.
- No live Microsoft account tests have been conducted for this release. Validate organization compliance, tenant consent and security before any real use.

## v1.3：Password + TOTP unattended login

The optional automated login path uses the upstream project's plaintext `secrets.json` format. This is **not encrypted at rest**. Secrets are provisioned locally over stdin, never through the web management API. Only admin can trigger auto-login; no admin/API response includes passwords or TOTP seeds. Each isolated account has a separate secrets path, MSAL cache and browser profile. The upstream credential page HTML/screenshots are disabled by a narrowly scoped integration patch in console workers.

Keep `M365_ADMIN_DATA` on an encrypted drive, restrict POSIX/NTFS access to the dedicated service user, and exclude identity-profiles from ordinary diagnostic uploads, source control and unencrypted backups. Rotate both password and TOTP enrollment on suspected compromise. Microsoft Conditional Access, push MFA, FIDO2 and similar checks remain enforced. Disable auto-login by deleting the local secrets file with the provisioning helper; revoking authorization additionally requires unlinking the profile or revoking sessions at Microsoft.

## v1.4: Admin-only HTTPS credential administration

This replaces the v1.3 note above regarding HTTP acceptance: v1.4 **optionally accepts the Microsoft password and software TOTP Base32 seed from an authenticated administrator through the management UI**, but only over a trusted HTTPS endpoint. On each write or delete, the user must reenter the admin password. CSRF, role checks, per-admin limits, and origin checks are enforced. The API never reveals the submitted secrets again.

Credentials are AES-256-GCM encrypted in `credentials.enc`; the master key (`identity-vault.key`) is stored separately within the same restricted data directory and must be protected by host ACLs, encrypted disks and controlled backups. When running automatic login, the isolated worker creates a temporary plaintext file that is deleted in a `finally` block. On Linux this prefers `/dev/shm`, on other systems it uses system temp. Crashes and privileged host access can still expose this data; the vault is not a hardware security module.

The original project uses password + software TOTP only in supported environments. This console cannot bypass Conditional Access, FIDO2, passkeys, push MFA, tenant consent or licensing. The safest long-term route is a properly registered Microsoft Entra OAuth application, but that may not receive the original project's private Sydney scope.
