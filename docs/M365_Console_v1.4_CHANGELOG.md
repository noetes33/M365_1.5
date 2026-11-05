# v1.4: Web-only account credential provisioning

- Adds admin-only HTTPS form for password + TOTP Base32 seed with mandatory admin-password reauthentication.
- Removes the post-install requirement to SSH into the VPS for account credential provisioning.
- Adds encrypted AES-256-GCM credential vault; stores no plaintext credentials in SQLite or responses.
- Adds per-account IPC delivery to isolated upstream worker; login-time plaintext file is removed immediately after login.
- Adds web credential deletion, status, secure-cookie support behind HTTPS reverse proxy, and password-input DOM clearing.
- Retains original MSAL + Playwright getToken login path and model/chat capabilities.
- Adds four integration tests for web administration security and simulated auto-login; 29 tests pass.
- Does not implement an official browser OAuth callback or bypass unsupported MFA methods. No real M365 account tested.
