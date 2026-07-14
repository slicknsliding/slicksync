# SlickSync

*Multi-provider addon, user, and credential management for **Stremio** and
**Nuvio**.*

SlickSync manages a private streaming group's accounts from one dashboard:
create groups, curate addon sets, track shared credentials, watch history,
and live playback — all kept in sync whether a member uses Stremio or Nuvio.

---

## Credits

SlickSync stands on the work of several people. This project would not exist
without them:

- **[neur0](https://github.com/iamneur0)** — creator of the original
  [Syncio](https://github.com/iamneur0/syncio) (MIT), the addon/user
  management engine SlickSync is built on top of. The sync engine, group
  management, watch-history metrics, and the whole underlying architecture
  are their work.
- **[Avangelista](https://github.com/Avangelista)** — the Nuvio provider
  integration concepts (OAuth device-code flow, credential auth) that
  SlickSync's Nuvio support is adapted from.
- **[Sonicx161](https://github.com/Sonicx161/AIOManager)** — creator of
  AIOManager, whose credential vault design (categorized secrets, expiry
  tracking, active-checks) is the direct inspiration for SlickSync's Vault
  feature.

See [`README.upstream.md`](./README.upstream.md) for a shorter credits/license
summary. The original Syncio project, unmodified, is here:
**https://github.com/iamneur0/syncio**

> **Note — Private, single-instance fork.** SlickSync is built and run for
> one household's private streaming group, not as a general-purpose
> multi-tenant product. Some defaults (rate limits, backup intervals, poll
> frequency) are tuned for a small handful of accounts rather than large-scale
> deployments.

---

## ⚡ Features

### 🔗 Multi-Provider Sync

The core of SlickSync is treating **Nuvio as a first-class provider**,
side-by-side with Stremio, rather than bolting it on:

- **Two connection methods for Nuvio** — OAuth device-code/QR flow, or direct
  email+password — matching how Stremio accounts already connect.
- **Every Nuvio profile syncs, not just the primary one.** Nuvio accounts
  support multiple profiles (like Netflix profiles); SlickSync pulls library,
  watch progress, and addon data from all of them and merges the results,
  labeling which profile each activity came from.
- **Same email can exist as both a Stremio and a Nuvio user** — useful when
  someone uses both apps on different devices. When both profiles share one
  underlying account (e.g. one AIOStreams login used by both), disambiguation
  falls back through username match → email match → recent watch history
  match → a configured fallback list, in that order.
- **Nuvio refresh tokens are encrypted at rest**; access tokens auto-refresh
  without user interaction.
- **Nuvio's library is read-only by nature.** Attempted edits return a clear
  error instead of silently failing.
- **A provider badge shows on every user, everywhere they appear** — purple
  for Stremio, a two-tone blue/orange split for Nuvio — fixed colors
  independent of the active theme, so the two are always visually
  distinguishable.
- **Addon import** pulls real manifest data (icon, version, description) for
  both providers — Nuvio's own storage only keeps a bare URL+name per addon,
  so SlickSync fetches each addon's actual `manifest.json` to fill in the
  rest.

### 🎬 Activity Tracking & Now Playing

- **Live "Now Playing" panel** on the Activity page, with a pulsing indicator,
  shows what's actively being streamed right now and disappears automatically
  once playback stops.
- **AIOStreams proxy integration** *(experimental / still in testing)* —
  supplements the library-poll detection above with a second signal: real
  connections observed through AIOStreams' built-in stream proxy, giving
  near-real-time detection independent of how often the source app
  checkpoints its own watch progress. Reconnections from seeking are grouped
  so reported duration stays continuous instead of resetting, and completed
  proxy-detected streams are written into watch history once playback ends
  — the same as any other completed session.
- **AIOMetadata poster enrichment** *(experimental / still in testing)* —
  fetches posters for proxy-detected streams that have no library metadata
  match yet, matched by parsed title and release year. Configurable from
  Settings (manifest URL), no redeploy required to change it.
- **1-minute poll cycle** for fast detection of new activity, library changes,
  and session state, across every connected account and profile.
- **Per-day, per-user Activity feed** grouped by date, with poster art,
  season/episode for series, and which profile the watch came from.
- **Top Watched / Recent Activity / Top Viewers** on the Dashboard and each
  user's detail page, built from real session duration — not just a count of
  events.

### 🔐 Vault — credential tracking with expiry alerts and active-checks

Track API keys, accounts, and credentials (debrid services, Usenet
providers/indexers, VPN, AI services, or your own Stremio/Nuvio-specific
secrets) in one place:

- **Encrypted at rest**, same AES-GCM scheme as the rest of the app.
- **Expiry tracking** with configurable days-before-expiry alerts.
- **Real active-checks**, not just "is the server up":
  - Real-Debrid, TorBox, and Newznab indexers validate the actual key against
    the provider's own API.
  - Stremio credentials are verified with a real login attempt against
    Stremio's API — checked against the account's actual auth state (not
    inferred from a wrapper's return value), so it correctly distinguishes a
    genuinely bad password from a transient issue.
  - Generic HTTP/TCP-reachability checks for anything else.
- **ntfy and/or Discord notifications** when something's expiring or a check
  starts failing.
- **Scheduled export**: a decrypted snapshot writes to `data/backup/vault/`
  nightly (`VAULT_BACKUP_INTERVAL_HOURS` to change the interval), so Vault
  data can be pulled off-server for backup or synced into an external
  password manager. On-demand backup via `POST /api/vault/backup-now`.
- **Drag-and-drop reordering** within the Vault.
- **Move addons directly from the Addons page into the Vault** to store ones
  you're not actively using without deleting them — keeps the Addons page
  focused on what's actually deployed, and they can be moved back out just
  as easily.

### 📦 Addon Snapshots (template library)

Save any user's or group's current addon set as a named template, then
deploy it to any user with one call. Manifest URLs are encrypted at rest;
deploys re-fetch fresh manifests rather than reusing a stale copy.

- `GET/POST /api/snapshots`, `GET/DELETE /api/snapshots/:id`,
  `POST /api/snapshots/:id/deploy`

### 👤 Profiles

- **Custom avatar/profile picture upload** per user, alongside the existing
  generated/Gravatar avatar options.

### 🎨 Themes

Ten full themes, each with its own background, surface, text, accent, and
chart-color palette — switchable live from Settings, applied everywhere
instantly:

| Theme | Description |
|---|---|
| **Nebula** *(default)* | Deep blue-black with violet-to-cyan accents |
| **Slick** | Soft violet with muted teal accents, near-black background |
| **Velvet** | Deep plum with dusty rose-gold accents |
| **Midnight** | Deep blue-black with warm amber accents |
| **Ember** | Charcoal warmth with fiery accents |
| **Nord** | Arctic cool with icy blue tones |
| **Verdant** | Deep forest with emerald greens |
| **Slate** | Minimal grayscale with blue accents |
| **Rose** | Elegant dark with rose gold |
| **Daylight** | Light theme with soft neutrals and blue accents |

The app logo (a chain-link mark, representing "sync") is a theme-reactive
inline SVG rather than a static image — it recolors automatically with
whichever theme is active, everywhere it renders: sidebar, login page,
invite pages, and the user-connect modal.

### 📊 Metrics & Dashboard

- **User Leaderboard** — ranked by total watch time, with movie/series
  counts and current streak.
- **Watch Streaks** — current and best consecutive-day streaks per user.
- **Watch Time Trend** — daily watch time over a configurable period.
- **Top Viewers / Recent Activity / Recent Addons** widgets on the Dashboard
  for an at-a-glance overview.
- **Provider parity view** — `GET /api/users/parity` — every user
  side-by-side: provider, groups, assigned addon count, and (with
  `?live=true`) live addon count.
- **Group activity dashboard** — `GET /api/groups/:id/dashboard?period=30d` —
  member roster with sync status, addon count, and per-member watch time.

### 🛡️ Security hardening

- API rate limiting actually mounted (upstream defined it but never enabled
  it).
- Strict limits + per-IP session caps on credential/OAuth endpoints.
- Hardcoded default encryption key removed.
- `trust proxy` set to trust exactly one hop (the reverse proxy in front of
  it) instead of trusting all hops, which would let a client spoof their IP
  and dodge rate limiting entirely.
- **Anti-lockout encryption key** — `ENCRYPTION_KEY` is optional: if unset, a
  random key is generated and persisted to `data/server_secret.key`. If you
  later rotate the key, the old one is kept as a decrypt-only fallback so
  existing data stays readable.

---

## 🚀 Installation

### Prerequisites

- Docker and Docker Compose installed on the host.
- A reverse proxy in front of it if you want HTTPS/a real domain (SlickSync
  itself doesn't handle TLS termination) — Traefik, Caddy, or nginx all work.
  This README covers running the container itself; proxy setup is separate.

### Docker (recommended)

```bash
git clone <your-repo-url> slicksync
cd slicksync
cp env.example .env
```

Open `.env` and fill in at minimum:

```
JWT_SECRET=<any long random string>
```

`ENCRYPTION_KEY` can be left unset — see **Anti-lockout encryption key**
above; a key will be generated automatically on first boot and persisted to
`data/server_secret.key`.

Then build and start:

```bash
docker compose -f docker-compose.private.yml up -d --build
```

First boot takes a minute or two (Prisma client generation, Next.js build).
Watch it come up with:

```bash
docker compose -f docker-compose.private.yml logs -f
```

Once you see `🚀 SlickSync (Database) running on port 4000` and
`✓ Ready` from the frontend, the app is up. By default:

- Frontend: `http://<host>:3000`
- Backend API: `http://<host>:4000`

If you're running a reverse proxy in front, point it at port `3000` for the
UI (the frontend proxies its own API calls internally — you don't need to
separately expose port `4000` through your reverse proxy for normal use).

### Persisting data

Make sure `/app/data` is mounted to a volume or bind mount — it holds:

- The SQLite database
- `server_secret.key` (your anti-lockout encryption key)
- Vault backup exports (`data/backup/vault/`)
- Uploaded avatars

Losing this directory without a backup means losing all users, groups,
addons, and Vault entries — there's no separate remote database to fall back
on unless you've configured `DB_TYPE=postgres` with an external
`DATABASE_URL`.

### Updating

```bash
git pull
docker compose -f docker-compose.private.yml up -d --build
```

Docker Compose will rebuild only what changed. Your `/app/data` volume is
untouched by a rebuild — user data, Vault entries, and the encryption key all
persist across updates.

### Environment variables

Beyond `JWT_SECRET` and the optional `ENCRYPTION_KEY`, everything else has a
sensible default. The ones you're most likely to actually want to change:

| Variable | Purpose | Default |
|---|---|---|
| `NUVIO_SUPABASE_URL` | Override Nuvio's backend endpoint | `https://api.nuvio.tv` |
| `NUVIO_SUPABASE_ANON_KEY` | Override Nuvio's anon key | — |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX_REQUESTS` | Credential-endpoint rate limit | 20 / 15 min |
| `POLL_RATE_LIMIT_MAX_REQUESTS` | OAuth device-flow poll limit | 60/min |
| `VAULT_BACKUP_INTERVAL_HOURS` | How often the Vault export runs | 24 |
| `AIOSTREAMS_URL` | Base URL of your AIOStreams instance, for the proxy-based Now Playing integration | — |
| `AIOSTREAMS_AUTH_USERNAME` / `AIOSTREAMS_AUTH_PASSWORD` | Credentials matching AIOStreams' own `AIOSTREAMS_AUTH` | — |
| `AIOSTREAMS_FALLBACK_USER_IDS` | Comma-separated SlickSync user IDs to attribute proxy-detected activity to when username/email matching can't resolve one | — |

See `env.example` for the complete list, including things you're unlikely to
need to touch (CORS origins, log level, DB connection pooling).

### Troubleshooting

- **Decryption errors after an update** (`Unsupported state or unable to
  authenticate data` in the logs, addons/Vault entries showing "Error"):
  this means the running code is deriving a different encryption key than
  whatever encrypted your existing data — almost always caused by something
  changing `server/utils/encryption.js`'s internal key-derivation constants,
  or `data/server_secret.key` being lost/replaced. These constants are
  **not** meant to ever change on an existing install; if you're building
  from a modified fork, don't touch that file.
- **"Detected additional lockfiles" warning during build**: means both
  `bun.lock` and a stray `package-lock.json` exist. Delete the
  `package-lock.json` file(s) — this project runs on `bun`, not `npm`.
- **First-boot database errors**: confirm `/app/data` is actually writable by
  the container's user (`user: "1001:1001"` in the compose file) — a bind
  mount owned by a different UID on the host can cause silent permission
  failures.

---

## License

MIT — see [`LICENSE`](./LICENSE). Original work © iamneur0 (syncio); Nuvio
integration concepts © Avangelista; Vault design inspiration © Sonicx161
(AIOManager); modifications © slicknsliding (SlickSync).
