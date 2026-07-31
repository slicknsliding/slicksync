#                                 SlickSync

*Multi-provider addon, user, and credential management for **Stremio** and **Nuvio**.*

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](./LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white)](https://nextjs.org)
[![Docker Pulls](https://img.shields.io/docker/pulls/slicknsliding/slicksync?logo=docker&logoColor=white&color=2496ED)](https://hub.docker.com/r/slicknsliding/slicksync)
[![Fork of Syncio](https://img.shields.io/badge/fork%20of-Syncio-blueviolet)](https://github.com/iamneur0/syncio)
[![Inspired by AIOManager](https://img.shields.io/badge/inspired%20by-AIOManager-orange)](https://github.com/Sonicx161/AIOManager)

SlickSync manages a private streaming group's accounts from one dashboard: groups, addon sets, shared credentials, watch history, and live playback — kept in sync whether a member uses Stremio or Nuvio.

> **Private, single-instance fork.** Built and run for one household's streaming group, not a general-purpose multi-tenant product.

## Contents

- [Multi-Provider Sync](#-multi-provider-sync)
- [Activity & Now Playing](#-activity--now-playing)
- [Discover & Media Details](#-discover--media-details)
- [Catalogs](#-catalogs)
- [SlickTrax](#-slicktrax)
- [Vault](#-vault)
- [Notifications](#-notifications)
- [PWA & Push](#-pwa--push)
- [Addons](#-addons)
- [Themes](#-themes)
- [Metrics](#-metrics)
- [System Health](#-system-health)
- [Backup & Disaster Recovery](#-backup--disaster-recovery)
- [Security](#-security)
- [Installation](#-installation)
- [Credits](#credits)
- [License](#license)

## ⚡ Features

### 🔗 Multi-Provider Sync
- Nuvio is a first-class provider alongside Stremio — not bolted on.
- OAuth device-code/QR or direct email+password to connect Nuvio.
- Every Nuvio profile syncs (not just the primary), library + progress + addons merged with a per-profile label.
- Same email can hold both a Stremio and a Nuvio user — auto-disambiguated by username → email → recent history → configured fallback.
- Nuvio refresh tokens encrypted at rest, auto-refreshing access tokens.
- Provider badge everywhere a user shows up — purple for Stremio, blue/orange split for Nuvio, fixed regardless of theme.
- Addon import fetches real manifest data for both providers, not just a bare URL+name.

### 🎬 Activity & Now Playing
- Live **Now Playing** panel, fed by a 30s poll of AIOStreams' proxy — real-time presence, gone the instant playback stops.
- **History & Watch Time** come from each provider's own library state (1-minute poll) — the permanent record, including sources the proxy can't see (usenet).
- **Real completion tracking** — finished vs. started-and-dropped, distinct from a raw "watched" flag, plus **rewatch counts** for movies watched again after a first finish.
- **Airing Calendar** — a date-grouped agenda of upcoming episodes for everything anyone's actively watching, with a "Coming Up" panel on the Dashboard.
- Correct-or-nothing posters: provider poster + Cinemeta-by-ID backfill for library items; strict exact-title Cinemeta match for proxy-detected items, never a guessed poster; optional **RPDB** integration for rating-embedded poster art if you have a (free) API key.
- Explicit per-account timezone for correct day-bucketing (Watch Time Today, streaks) — auto-detected from your browser the first time you open Settings, stored explicitly from then on so background jobs (which have no browser to ask) always know what "today" means.
- Dashboard/user-page widgets: Top Watched, Recent Activity, Top Viewers — built from real session duration.
- Cross-account library-sync dedup so a shared-login watch never double-counts.

### 🎞️ Discover & Media Details
- Click any poster for cast, rating, genres, director, runtime, and awards (Cinemeta) — plus an inline YouTube trailer.
- **Cast & crew deep-dive** — click any actor/director on a detail popup to see their real filmography (optional TMDb key) and jump straight into any of it.
- **Discover**: browse Popular / New / Top Rated, genre filter, infinite scroll, "Open in Stremio/Nuvio" on every result. Sort by title, year, or rating; filter to unwatched/watched only.
- **People search** — a separate mode from title search, so looking up an actor/director shows only their verified credits, never an unrelated title that happened to loosely match the name.
- Four sources side by side: Discover, ★ Watchlist, ✨ For You, and household "nobody's seen it yet" picks.
- Deep links use each provider's real format (`stremio:///detail/...`, `nuvio://meta?...`) — no guessing, no account-specific data in the link.
- Continue Watching row on the Dashboard — drag to scroll, right-click/long-press to remove.
- Right-click (desktop) or long-press (mobile) any poster for a quick-action menu — Add to Watchlist, Add to Catalogs, Mark Watched — without opening the detail popup first.

### 📚 Catalogs
Named collections of titles, separate from the Watchlist — build a "Halloween Marathon" or "Kids' Night" list and share the idea, not just watch it alone.
- Create, rename, delete; add titles from any poster's right-click menu or its detail popup.
- **Import** an existing list straight from a **MDBList** or **TMDb** list URL (TMDb import is movies-only; MDBList supports both).
- Sort by title, year, or rating; each entry opens the same rich detail popup as everywhere else.

### ✨ SlickTrax
Built-in Trakt-alternative — no external service, no tokens.
- **Watchlist** — bookmark from any poster.
- **Watched indicators** — real watch-history based, with a manual override.
- **For You recommendations** — up to 3 genre rows from real weighted watch time (recency-decayed), independently toggleable.
- **More Like This** on every detail popup, biased by real household affinity, always fresh/unwatched results.
- **✨ Real match** badge on any For You/More Like This row backed by genuine household viewing — reads differently at a glance from a pure genre-fallback guess.
- **Not Interested** feedback downweights similar titles, not just the one dismissed.

### 🔐 Vault
Credential tracking with expiry alerts and real active-checks.
- AES-GCM encrypted at rest.
- Expiry/renewal alerts with configurable lead time, plus cost + billing-cycle spend tracking.
- Real active-checks: Real-Debrid/TorBox/Newznab against their own APIs, Stremio via real login, generic HTTP/TCP for the rest.
- Nightly encrypted export to `data/backup/vault/`, or on-demand.
- "Fix now" links straight from an alert to the entry, ready to edit.
- Drag-and-drop reordering; move addons between Addons and Vault without deleting them.

### 🔔 Notifications
**Push + the in-app bell are primary; Discord is entirely optional** — every notification type below works with zero Discord setup, and a webhook just adds Discord delivery on top for whichever types you want it for.
- Per-type toggles: activity, sync, invites, Vault, addon health, backups, **proxy connectivity**, and monthly recap.
- Instant "started watching" ping from the live proxy signal.
- Per-user notification opt-out and personal webhook override.
- New-episode alerts + a "Coming up" calendar on the Dashboard.
- **Monthly poster-mosaic recap**, posted automatically on the 1st — a real collage image to Discord if a webhook's set, otherwise a plain push+bell text summary ("14 titles watched this month").
- Addon down/back-up alerts from a background health check, and an alert if the AIOStreams proxy itself goes unreachable.
- **Digest mode** — batch everything above into one daily/weekly push+bell summary instead of a ping per event.

### 📱 PWA & Push
- Installs like a native app — Home Screen on iOS/Android, desktop install on Chrome/Edge.
- Per-device push for every notification type once installed, zero setup — VAPID keys self-generate on first boot.
- Manage subscribed devices (rename, revoke) from Settings; a revoked device stops getting pushed to immediately, no re-install needed.

### 🧩 Addons
Drag-and-drop reordering, drag-to-protect or drag-to-label with color-coded custom tags, order-insensitive sync comparison, provider-agnostic live addon counts, and a template library (**Addon Snapshots**) to save/deploy a named addon set to any user.

### 🎨 Themes
Ten full themes, switchable live, synced across devices. Build your own on top of any base — accent colors, success/error overrides, corner-roundness, text scale, and a choice of 11 display fonts — with a live preview mockup. Two layout modes: the original sidebar, or **Nebula** (top nav + glass panels, default).

### 📊 Metrics
User leaderboard, watch streaks, watch-time trend, Top Viewers/Recent Activity/Recent Addons on the Dashboard, provider parity view, and a per-group activity dashboard.
- Same-email Stremio/Nuvio pairs are deduped in every leaderboard and total — one household member never counts as two.
- **Taste Profiles** — a per-user viewing fingerprint (favorite genres, habits) built from real watch history, not a guess.
- **Year in Review** — a Wrapped-style yearly recap: total watch time, top shows, most-rewatched titles, a by-month chart, and a per-user breakdown.

### 🩺 System Health
One page answering "is everything actually working right now" — Sync drift, addon reachability, Vault credential checks, and AIOStreams proxy connectivity, all read from state existing background monitors already maintain.
- **Ignore** a known, accepted failure (an addon you've intentionally left offline, an indexer that blocks your server's IP) to drop it out of Attention and its notifications — reversible any time from the same card.
- **Addon uptime %** over the last 7/30 days, reconstructed from the same health-check history the offline/online alerts already log.
- **Version card** — what's actually running, and whether a newer stable release has been published, without needing to check GitHub or `docker exec` in to find out.

### 💾 Backup & Disaster Recovery
Scheduled + on-demand config backups (validated for real restorability, not just valid JSON) and a separate **Disaster Recovery Kit** — the same export plus every Vault secret, re-encrypted under a passphrase you choose, fully portable to a brand-new instance.

### 🛡️ Security
Rate limiting actually enabled, strict limits on credential/OAuth endpoints, correct `trust proxy` hop count, no hardcoded default key, and a self-generating anti-lockout encryption key with decrypt-only fallback on rotation.

---

## 🚀 Installation

**Prerequisites**: Docker + Docker Compose, and a reverse proxy in front for HTTPS (Traefik/Caddy/nginx — SlickSync doesn't terminate TLS itself).

```bash
git clone https://github.com/slicknsliding/slicksync.git
cd slicksync
cp env.example .env
```

Generate a real secret and set it in `.env` — this is what signs your login sessions, so it needs actual randomness, not just a made-up phrase:
```bash
openssl rand -base64 32
```
```
JWT_SECRET=<paste the output above>
```
`ENCRYPTION_KEY` can stay unset — one generates itself on first boot (see Security above).

```bash
docker compose -f docker-compose.private.yml up -d
docker compose -f docker-compose.private.yml logs -f   # watch it come up
```
This pulls the pre-built `ghcr.io/slicknsliding/slicksync:private` image — the stable release built from `main`. (There's also a `:beta` image used for testing upcoming changes before they land on `main` — don't use it unless you specifically want to try something not yet released.)

Frontend on `:3000`, API on `:4000` — point your reverse proxy at `:3000` only.

**Verify it's actually up**: `docker exec slicksync sh -c 'echo APP_VERSION=$APP_VERSION'` should print the current release tag (e.g. `v1.61.2`), and `https://your-domain/` should load the login page.

**Updating**: `docker compose -f docker-compose.private.yml pull && docker compose -f docker-compose.private.yml up -d` — your `/app/data` volume (database, encryption key, Vault backups, avatars) survives updates. No `git pull` or rebuild needed since the default config just pulls the published image. (If you switched to the commented-out `build:` block instead, use `git pull && docker compose -f docker-compose.private.yml up -d --build`.)

<details>
<summary><strong>Public / multi-tenant mode</strong> — hosting for more than one separate group</summary>

Private and public are genuinely different modes:

| | Private (default) | Public |
|---|---|---|
| Who it's for | One household running their own copy | Hosting for multiple separate groups |
| Database | SQLite, embedded | PostgreSQL (required) |
| Accounts | One shared instance, no signup | Self-registered, isolated per account |
| Image | Pre-built `ghcr.io/slicknsliding/slicksync:private` | Pre-built `ghcr.io/slicknsliding/slicksync:public` |

```bash
cp env.example .env
openssl rand -base64 32   # run twice - once for JWT_SECRET, once for ENCRYPTION_KEY
```
```
JWT_SECRET=<first generated value>
ENCRYPTION_KEY=<second generated value>
DATABASE_URL=postgresql://slicksync:slicksync@db:5432/slicksync
```
```bash
docker compose -f docker-compose.public.yml up -d
```
Pulls `ghcr.io/slicknsliding/slicksync:public` — same `main`-built release channel as private mode, not `:beta`.
First visit shows a "Create one" registration link. `/register` generates a random account UUID once — that UUID *is* the login ID, so save it; there's no recovery if it's lost.

**Updating**: `docker compose -f docker-compose.public.yml pull && docker compose -f docker-compose.public.yml up -d`.
</details>

<details>
<summary><strong>Environment variables</strong></summary>

Everything beyond `JWT_SECRET`/`ENCRYPTION_KEY` has a sensible default — see `env.example` for the full list. Most likely to actually change:

| Variable | Purpose | Default |
|---|---|---|
| `NUVIO_SUPABASE_URL` / `NUVIO_SUPABASE_ANON_KEY` | Override Nuvio's backend endpoint | `https://api.nuvio.tv` / — |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX_REQUESTS` | Credential-endpoint rate limit | 20 / 15 min |
| `POLL_RATE_LIMIT_MAX_REQUESTS` | OAuth device-flow poll limit | 60/min |
| `VAULT_BACKUP_INTERVAL_HOURS` | Vault export interval | 24 |
| `ACCOUNT_TIMEZONE` | Default day-bucketing timezone (overridable in Settings) | `America/Los_Angeles` |
| `AIOSTREAMS_URL` | Base URL of your AIOStreams instance | — |
| `AIOSTREAMS_AUTH_USERNAME` / `AIOSTREAMS_AUTH_PASSWORD` | Matching AIOStreams' own `AIOSTREAMS_AUTH` | — |
| `AIOSTREAMS_FALLBACK_USER_IDS` | Fallback user IDs for unresolvable proxy activity | — |
</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

- **Decryption errors after an update** (`Unsupported state or unable to authenticate data`): the running code is deriving a different key than what encrypted your data — check `data/server_secret.key` wasn't lost, and don't modify `server/utils/encryption.js`'s key-derivation constants on a fork.
- **"credentials may be invalid" on Sync, but the same user's library/history still updates fine**: a decrypt-key rotation split your data across key generations — every read path falls back to the previous key automatically, but that leaves some secrets still encrypted under the old one. Boot logs show `[keyManager] ENCRYPTION_KEY differs from the previously persisted key` when this is the case. Fix it once and for all: `docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" <container> node scripts/consolidate-encryption-keys.js` (dry-run; add `--apply --sync-keyfile` to actually re-encrypt everything onto your current key and stop the warning from recurring).
- **"Detected additional lockfiles" during build**: delete any stray `package-lock.json` — this project runs on `bun`.
- **First-boot database errors**: confirm `/app/data` is writable by the container's user (`1001:1001`).
</details>

---

## Credits

- **[iamneur0](https://github.com/iamneur0)** — creator of [Syncio](https://github.com/iamneur0/syncio) (MIT), the engine SlickSync is built on.
- **[Avangelista](https://github.com/Avangelista)** — Nuvio provider integration concepts (OAuth device-code flow, credential auth).
- **[Sonicx161](https://github.com/Sonicx161/AIOManager)** — creator of AIOManager, direct inspiration for the Vault feature.

See [`README.upstream.md`](./README.upstream.md) for the original project's own README.

## License

MIT — see [`LICENSE`](./LICENSE). Original work © iamneur0 (Syncio); Nuvio integration concepts © Avangelista; Vault design inspiration © Sonicx161 (AIOManager); modifications © slicknsliding (SlickSync).
