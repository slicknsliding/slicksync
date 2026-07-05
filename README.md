# SlickSync

*Multi-provider addon and user management for **Stremio** and **Nuvio**.*

SlickSync manages a private streaming group's accounts from one dashboard:
create groups, curate addon sets, and keep every member's account in sync —
whether they use Stremio or Nuvio.

Based on [iamneur0/syncio](https://github.com/iamneur0/syncio) (MIT), with
Nuvio provider integration adapted from work by
[Avangelista](https://github.com/Avangelista/syncio). See
`README.upstream.md` for the original Syncio documentation — setup, env vars,
and Docker instructions there all still apply.

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

### Security hardening
- API rate limiting actually mounted (upstream defined it but never enabled it)
- Strict limits + per-IP session caps on credential/OAuth endpoints
- Hardcoded default encryption key removed

## Quick start (build from source)

```bash
git clone <your-repo-url> slicksync
cd slicksync
cp env.example .env   # fill in JWT_SECRET; ENCRYPTION_KEY optional now
docker compose -f docker-compose.private.yml up -d --build
```

Persist `/app/data` in a volume — it holds the SQLite DB, backups, and the
auto-generated encryption key.

## New environment variables (all optional)

| Variable | Purpose |
|---|---|
| `NUVIO_SUPABASE_URL` | Override Nuvio's public Supabase endpoint |
| `NUVIO_SUPABASE_ANON_KEY` | Override Nuvio's public anon key |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX_REQUESTS` | Credential-endpoint rate limit (default 20 / 15 min) |
| `POLL_RATE_LIMIT_MAX_REQUESTS` | OAuth device-flow poll limit (default 60/min) |

## License

MIT — see `LICENSE`. Original work © the Syncio authors; Nuvio integration
concepts © Avangelista; modifications © Slick.
