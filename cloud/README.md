# Capyra account and device service

`cloud/` is an optional self-hosted account service for Capyra. It manages account sessions, trusted device pairing, workspace/capability scopes, revocation and optional Cloudflare Named Tunnel provisioning. It does not store local workspace files, terminal output or task results.

Quick Tunnel and stdio usage do not require this service.

## Local start

Requirements: Node.js 22.16 or newer.

```sh
npm ci
npm run build
CAPYRA_IDENTITY_ORIGIN=http://127.0.0.1:4320 \
CAPYRA_IDENTITY_STATE=.capyra/identity-cloud \
node cloud/start.mjs
```

The service listens on `127.0.0.1:4320` by default. Check it with:

```sh
curl http://127.0.0.1:4320/health
```

## Production deployment

1. Run the Node process as a dedicated unprivileged user.
2. Keep it bound to loopback and place it behind an existing HTTPS reverse proxy.
3. Copy `cloud/environment.example` to a secret environment file outside the repository and set mode `0600`.
4. Persist `CAPYRA_IDENTITY_STATE` on a private volume with mode `0700`.
5. Preserve the original `Host` header at the proxy.
6. Complete an actual two-account pairing, scope, cross-account denial and revocation check before use.

`cloud/capyra-identity.service`, `cloud/Caddyfile.example`, `cloud/nginx-prefix.conf.example` and `cloud/Dockerfile` are templates. Review paths, users, ports and the existing proxy before installing them; do not overwrite an existing site configuration.

### Environment

```text
CAPYRA_IDENTITY_HOST=127.0.0.1
CAPYRA_IDENTITY_PORT=4320
CAPYRA_IDENTITY_ORIGIN=https://accounts.example.com
CAPYRA_IDENTITY_STATE=/var/lib/capyra-identity
```

The following optional variables enable product-managed Named Tunnel provisioning:

```text
CF_ACCOUNT_ID=
CF_ZONE_ID=
CF_BASE_DOMAIN=devices.example.com
CF_API_TOKEN=
```

Keep the Cloudflare management token only on this service. A device receives only its own runtime tunnel credential and cannot manage the Cloudflare account or other devices.

## Security model

- Passwords use random salt and scrypt.
- Browser sessions are random, stored as digests, short lived and protected by HttpOnly/SameSite cookies and CSRF checks.
- Device pairing requires proof from a locally generated Ed25519 private key.
- Account login, device binding, OAuth and individual task approval are separate checks.
- Device scope and local Capyra scope are intersected for every remote capability call.
- Revocation is persisted before best-effort provider cleanup.
- Forwarded headers do not select an account, device or local caller.

Do not expose the account service directly over plain HTTP, store environment secrets in Git, or use an email-shaped login string as proof that an email address was verified.

## Backup and recovery

```sh
node cloud/admin.mjs inspect /var/lib/capyra-identity
node cloud/admin.mjs backup /var/lib/capyra-identity /secure-backups/capyra.json
```

Backups contain password hashes, account/device relationships and provider credentials. Store them on encrypted media with restricted access.

Restore while the service is stopped:

```sh
node cloud/admin.mjs restore /var/lib/capyra-identity /secure-backups/capyra.json
```

Restore invalidates sessions and revokes restored devices so an old backup cannot reactivate access that was revoked later.
