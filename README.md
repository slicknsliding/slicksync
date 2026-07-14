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

- **[iamneur0](https://github.com/iamneur0)** — creator of the original
  [SlickSync](https://github.com/iamneur0/slicksync) (MIT), the addon/user
  management engine SlickSync is built on top of. The sync engine, group
  management, watch-history metrics, and the whole underlying architecture
  are their work.
- **[Avangelista](https://github.com/Avangelista/slicksync)** — the Nuvio
  provider integration concepts (OAuth device-code flow, credential auth)
  that SlickSync's Nuvio support is adapted from.
- **[Sonicx161](https://github.com/Sonicx161/AIOManager)** — creator of
  AIOManager, whose credential vault design (categorized secrets, expiry
  tracking, active-checks) is the direct inspiration for SlickSync's Vault
  feature. Also incidentally the source that confirmed Nuvio's actual current
  backend endpoint when SlickSync's own reference had gone stale.

See `README.upstream.md` for the original SlickSync documentation — most setup,
env var, and Docker instructions there still apply unchanged.

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
  someone uses both apps on different devices.
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

- **Accurate "was this actually watched" detection.** A title only counts as
  watched once real playback progress reaches at least 5% of its runtime —
  filters out library bookmarks and brief hover/preview autoplay while
  browsing, which would otherwise show up as false "watched" entries.
- **Live "Now Playing" panel** on the Activity page, with a pulsing indicator,
  shows what's actively being streamed right now and disappears automatically
  once playback stops. Detection is time-based (recent watch-progress
  timestamp within a rolling window) to account for how Nuvio's backend
  actually reports progress — via periodic checkpoints on pause/stop, not a
  continuous live feed.
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

### 📦 Addon Snapshots (template library)

Save any user's or group's current addon set as a named template, then
deploy it to any user with one call. Manifest URLs are encrypted at rest;
deploys re-fetch fresh manifests rather than reusing a stale copy.

- `GET/POST /api/snapshots`, `GET/DELETE /api/snapshots/:id`,
  `POST /api/snapshots/:id/deploy`

### 🎨 Themes

Ten full themes, each with its own background, surface, text, accent, and
chart-color palette — switchable live from Settings, applied everywhere
instantly:

| Theme | Description |
|---|---|
| **Slick** *(default)* | Soft violet with muted teal accents, near-black background |
| **Velvet** | Deep plum with dusty rose-gold accents |
| **Nebula** | Deep blue-black with violet-to-cyan accents |
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

### Docker (recommended)

```bash
git clone <your-repo-url> slicksync
cd slicksync
cp env.example .env   # fill in JWT_SECRET; ENCRYPTION_KEY optional
docker compose -f docker-compose.private.yml up -d --build
```

Persist `/app/data` in a volume — it holds the SQLite DB, backups (including
the Vault export), and the auto-generated encryption key.

### New environment variables (all optional)

| Variable | Purpose |
|---|---|
| `NUVIO_SUPABASE_URL` | Override Nuvio's backend endpoint (default: `https://api.nuvio.tv`) |
| `NUVIO_SUPABASE_ANON_KEY` | Override Nuvio's anon key |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX_REQUESTS` | Credential-endpoint rate limit (default 20 / 15 min) |
| `POLL_RATE_LIMIT_MAX_REQUESTS` | OAuth device-flow poll limit (default 60/min) |
| `VAULT_BACKUP_INTERVAL_HOURS` | How often the Vault export runs (default 24) |

---

## License

MIT — see `LICENSE`. Original work © iamneur0 (SlickSync); Nuvio integration
concepts © Avangelista; Vault design inspiration along with Nuvio integration
© Sonicx161 (AIOManager); modifications © Slick.

