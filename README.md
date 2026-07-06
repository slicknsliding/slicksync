# SlickSync

*Multi-provider addon, user, and credential management for **Stremio** and
**Nuvio**.*

SlickSync manages a private streaming group's accounts from one dashboard:
create groups, curate addon sets, track shared credentials, and keep every
member's account in sync — whether they use Stremio or Nuvio.

---

## Credits

SlickSync stands on the work of several people. This project would not exist
without them:

- **[iamneur0](https://github.com/iamneur0)** — creator of the original
  [Syncio](https://github.com/iamneur0/syncio) (MIT), the addon/user
  management engine SlickSync is built on top of. The sync engine, group
  management, watch-history metrics, and the whole underlying architecture
  are their work.
- **[Avangelista](https://github.com/Avangelista/syncio)** — the Nuvio
  provider integration concepts (OAuth device-code flow, credential auth)
  that SlickSync's Nuvio support is adapted from.
- **[Sonicx161](https://github.com/Sonicx161/AIOManager)** — creator of
  AIOManager, whose credential vault design (categorized secrets, expiry
  tracking, active-checks) is the direct inspiration for SlickSync's Vault
  feature. Also incidentally the source that confirmed Nuvio's actual current
  backend endpoint when SlickSync's own reference had gone stale.

See `README.upstream.md` for the original Syncio documentation — most setup,
env var, and Docker instructions there still apply unchanged.

---

## What SlickSync adds on top of Syncio

### Nuvio as a first-class provider
- Users connect via **Nuvio** (OAuth device-code/QR flow or email+password)
  or **Stremio** — the sync engine, group management, watch-history metrics,
  and expiration handling work identically for both
- Same email can exist as both a Stremio and a Nuvio user
- Nuvio refresh tokens encrypted at rest; access tokens auto-refresh
- Nuvio's library is read-only by nature — library edits return a clear
  error instead of failing silently
- A Stremio/Nuvio badge shows next to every user, everywhere they appear

### Vault — credential tracking with expiry alerts and active-checks
Track API keys, accounts, and credentials (debrid services, Usenet
providers/indexers, VPN, AI services, or your own Stremio/Nuvio-specific
secrets) in one place:
- Encrypted at rest, same AES-GCM scheme as the rest of the app
- Expiry tracking with configurable days-before-expiry alerts
- Real active-checks: Real-Debrid, TorBox, and Newznab indexers validate the
  actual key against the provider's API (not just "is the server up"); generic
  HTTP and TCP-reachability checks for anything else
- ntfy and/or Discord notifications when something's expiring or a check
  starts failing
- Scheduled export: a decrypted snapshot writes to `data/backup/vault/`
  nightly (`VAULT_BACKUP_INTERVAL_HOURS` to change the interval), so Vault
  data can be pulled off-server for backup or synced into an external
  password manager. On-demand backup via `POST /api/vault/backup-now`.

### Addon snapshots (template library)
Save any user's or group's current addon set as a named template, then
deploy it to any user with one call. Manifest URLs are encrypted at rest;
deploys re-fetch fresh manifests.

- `GET/POST /api/snapshots`, `GET/DELETE /api/snapshots/:id`,
  `POST /api/snapshots/:id/deploy`

### Provider parity view
`GET /api/users/parity` — every user side-by-side: provider, groups,
assigned addon count, and (with `?live=true`) live addon count.

### Group activity dashboard
`GET /api/groups/:id/dashboard?period=30d` — member roster with sync
status, addon count, and per-member watch time.

### Anti-lockout encryption key
`ENCRYPTION_KEY` is optional: if unset, a random key is generated and
persisted to `data/server_secret.key`. If you later rotate the key, the old
one is kept as a decrypt-only fallback so existing data stays readable.

### Visual redesign
A distinct "Slick" theme (bold violet + electric cyan) as the new default
look, alongside all the original themes. Properly-loaded typography
(Space Grotesk / Outfit), gradient card accents, redesigned sidebar and
navigation, and an in-app Changelog that actually reflects this project's
own history instead of upstream's.

### Security hardening
- API rate limiting actually mounted (upstream defined it but never enabled it)
- Strict limits + per-IP session caps on credential/OAuth endpoints
- Hardcoded default encryption key removed
- `trust proxy` set to trust exactly one hop (the reverse proxy in front of
  it) instead of trusting all hops, which would let a client spoof their IP
  and dodge rate limiting entirely

## Quick start (build from source)

```bash
git clone <your-repo-url> slicksync
cd slicksync
cp env.example .env   # fill in JWT_SECRET; ENCRYPTION_KEY optional now
docker compose -f docker-compose.private.yml up -d --build
```

Persist `/app/data` in a volume — it holds the SQLite DB, backups (including
the Vault export), and the auto-generated encryption key.

## New environment variables (all optional)

| Variable | Purpose |
|---|---|
| `NUVIO_SUPABASE_URL` | Override Nuvio's backend endpoint (default: `https://api.nuvio.tv`) |
| `NUVIO_SUPABASE_ANON_KEY` | Override Nuvio's anon key |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX_REQUESTS` | Credential-endpoint rate limit (default 20 / 15 min) |
| `POLL_RATE_LIMIT_MAX_REQUESTS` | OAuth device-flow poll limit (default 60/min) |
| `VAULT_BACKUP_INTERVAL_HOURS` | How often the Vault export runs (default 24) |

## License

MIT — see `LICENSE`. Original work © iamneur0 (Syncio); Nuvio integration
concepts © Avangelista; Vault design inspiration © Sonicx161 (AIOManager);
modifications © Slick.

