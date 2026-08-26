<div align="center">

<img src="client/public/android-chrome-512x512.png" width="96" alt="SlickSync logo" />

# SlickSync

**One dashboard for a private streaming group.**

Addons, users, shared credentials, watch history and live playback —
kept in sync whether a member is on **Stremio** or **Nuvio**.

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](./LICENSE)
[![Docker Pulls](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/slicknsliding/slicksync/badges/docker-pulls.json&logo=docker&logoColor=white&style=flat-square)](https://hub.docker.com/r/slicknsliding/slicksync)
[![Bun](https://img.shields.io/badge/bun-1%2B-000000?logo=bun&logoColor=white&style=flat-square)](https://bun.sh)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white&style=flat-square)](https://nextjs.org)

[![Fork of Syncio](https://img.shields.io/badge/fork%20of-Syncio-blueviolet?style=flat-square)](https://github.com/iamneur0/syncio)
[![Inspired by AIOManager](https://img.shields.io/badge/inspired%20by-AIOManager-orange?style=flat-square)](https://github.com/Sonicx161/AIOManager)

[**Install**](#-installation) &nbsp;·&nbsp; [**Features**](#-features) &nbsp;·&nbsp; [**Guides**](#new-here-start-with-the-guides) &nbsp;·&nbsp; [**Try it live**](https://slicksync.vip)

</div>

---

SlickSync manages a private streaming group's accounts from one place: groups, addon sets, shared credentials, watch history and live playback — kept in sync whether a member uses Stremio or Nuvio.

> **Private, single-instance fork.** Built and run for one household's streaming group, not a general-purpose multi-tenant product.
>
> Can't self-host? **[slicksync.vip](https://slicksync.vip)** runs the same code in public/multi-tenant mode, free to register — a courtesy option for anyone who wants SlickSync without running a server.

<sub>Built on [Syncio](https://github.com/iamneur0/syncio) · Vault inspired by [AIOManager](https://github.com/Sonicx161/AIOManager)</sub>

### New here? Start with the Guides

Once SlickSync is running, **`/guides`** is the fastest way to actually learn it — 83 topic pages covering every page and setting, organized by category and searchable, each with step-by-step instructions and the gotchas that actually come up. The same content answers free-text questions straight from the **command palette** (`Ctrl+K` / `Cmd+K`) — no AI key required.

## Quick start

Docker and Docker Compose, plus a reverse proxy in front for HTTPS — SlickSync doesn't terminate TLS itself.

```bash
git clone https://github.com/slicknsliding/slicksync.git
cd slicksync
cp env.example .env
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
docker compose -f docker-compose.private.yml up -d
```

Everything is served on `:3000`. `ENCRYPTION_KEY` generates itself on first boot — you only need to set `JWT_SECRET`. Full walkthrough, including the public/multi-tenant variant, in [Installation](#-installation).

## Contents

- [Multi-Provider Sync](#-multi-provider-sync)
- [Activity & Now Playing](#-activity--now-playing)
- [Discover & Media Details](#-discover--media-details)
- [Catalogs](#-catalogs)
- [Nuvio Collections](#-nuvio-collections)
- [SlickTrax](#-slicktrax)
- [Vault](#-vault)
- [Notifications](#-notifications)
- [PWA, Speed & Offline](#-pwa-speed--offline)
- [Addons](#-addons)
- [Automation](#-automation)
- [Command Palette](#-command-palette)
- [Themes](#-themes)
- [Sharing & Portability](#-sharing--portability)
- [Metrics](#-metrics)
- [System Health](#-system-health)
- [Backup, Maintenance & Updates](#-backup-maintenance--updates)
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
- **Account merge** — absorb a second provider's identity into one existing user instead of managing them as two separate people, with a preview before merging and a full **Undo** afterward that restores both identities and their original watch history exactly.
- **Silent account-mismatch detection** — if a title is seen streaming but no connected account ever records it in History, that usually means playback happened on an account not yet added to SlickSync; a notification explains this and points at the fix.
- **SIMKL linking** — any user can optionally connect their own SIMKL account (PIN-based, no password ever touches SlickSync). Bidirectional: pulls SIMKL's own watch history in, and pushes SlickSync's already-unified record back out.
- **Self-hosted Nuvio backends** — point an account at your own Nuvio server instead of the official one; paste the backend URL and SlickSync reads that server's own discovery document to configure itself.

### 🎬 Activity & Now Playing
- Live **Now Playing** panel, fed by a 30s poll of AIOStreams' proxy — real-time presence, gone the instant playback stops.
- **History & Watch Time** come from each provider's own library state (1-minute poll) — the permanent record, including sources the proxy can't see (usenet).
- **Real completion tracking** — finished vs. started-and-dropped, distinct from a raw "watched" flag, plus **rewatch counts**.
- **Per-day watch history for series** — a title rewatched across several days shows one entry per day, not one lump.
- **Airing Calendar** — a date-grouped agenda of upcoming episodes for everything anyone's actively watching, with a "Coming Up" panel on the Dashboard.
- Correct-or-nothing posters: provider poster + Cinemeta-by-ID backfill for library items; strict exact-title matching for proxy-detected items, never a guessed poster; optional **RPDB** integration for rating-embedded art.
- Explicit per-account timezone for correct day-bucketing (Watch Time Today, streaks) — auto-detected from your browser once, then stored so background jobs always know what "today" means.
- Cross-account library-sync dedup so a shared-login watch never double-counts.

### 🎞️ Discover & Media Details
- Click any poster for cast, rating, genres, director, runtime, and awards — plus an inline YouTube trailer.
- Rotten Tomatoes/Metacritic via an optional (free) OMDb key; **box office** figures and **"Part of the X Collection"** franchise grouping on the detail popup.
- **Cast & crew deep-dive** — click any actor/director to see their real filmography and jump straight into any of it.
- **Discover**: browse Popular / New / Top Rated, genre filter, infinite scroll, "Open in Stremio/Nuvio" on every result. Sort by title, year, or rating; filter to unwatched/watched.
- **People search** — a separate mode from title search, so looking up an actor shows only their verified credits.
- Four sources side by side: Discover, ★ Watchlist, ✨ For You, and household "nobody's seen it yet" picks, plus an optional **SIMKL Trending** row.
- **Where to watch** — TMDb watch-provider logos and an **MDBList score** on the detail popup.
- Deep links use each provider's real format — no guessing, no account-specific data in the link.
- Continue Watching row on the Dashboard — drag to scroll, right-click/long-press to remove.
- Right-click (desktop) or long-press (mobile) any poster for quick actions — Add to Watchlist, Add to Catalogs, Mark Watched.

### 📚 Catalogs
Named collections of titles, separate from the Watchlist — build a "Halloween Marathon" or "Kids' Night" list and share the idea, not just watch it alone.

- Create, rename, delete; add titles from any poster's right-click menu or its detail popup.
- **Watchlist/watched badges** and the same right-click quick-actions as Discover, on every catalog's poster grid.
- **Custom cover art** — upload an image or pick a color.
- **Import from a URL** (MDBList/TMDb), from a linked user's SIMKL Plan to Watch, or from a pasted **share code**.
- **Describe it in plain English** ("90s horror") and review what it suggests before anything is added.
- **Content Rating allowlist** turns a catalog into an enforced list — useful for a genuinely kid-safe catalog.
- **Auto-refresh** (opt-in, per catalog) keeps a URL-sourced catalog following its source.
- **Export** to MDBList, to a linked user's SIMKL, or as a share code.

### 🗂️ Nuvio Collections
Organize a Nuvio account's own home-screen collections — the folders and catalog sources Nuvio itself shows a user — directly from SlickSync instead of hand-editing them in the Nuvio app.

- Build folders of catalog sources, drag to reorder folders and sources within them; grid or list view.
- Start from a template (Streaming Services, Genres) instead of building from scratch.
- **Cover art** for a collection and each folder individually — pick a URL/GIF or browse nuvio.tv's own **Community Covers** gallery with search and infinite scroll.
- **Broken-source detection** flags a folder whose catalog source no longer resolves, and separately flags a folder with **zero sources**, since that syncs fine but silently never renders on-device.
- **Genres template** builds one folder per genre from your account's own installed addons, skipping catalogs that only claim to support genre filtering.
- **Pin** any collection to the top of the Nuvio home screen.
- **Layout preview** — see exactly how a collection will lay out before saving.
- **Copy a whole collection between profiles**, export/import as JSON, or hand the whole layout over as a **share code**.

### ✨ SlickTrax
A built-in Trakt alternative — no external service, no tokens.

- **Watchlist** — bookmark from any poster.
- **Watched indicators** — real watch-history based, with a manual override.
- **For You recommendations** — up to 3 genre rows from real weighted watch time (recency-decayed), independently toggleable.
- **More Like This** on every detail popup, biased by real household affinity, always fresh/unwatched results.
- **✨ Real match** badge on any row backed by genuine household viewing — reads differently at a glance from a pure genre-fallback guess.
- Optional **AI "why this matches"** explanation using your own OpenAI-compatible key — never required.
- **Not Interested** feedback downweights similar titles, not just the one dismissed.
- **Trakt-compatible scrobble-in API** (`/api/scrobble`) — point a real Trakt-scrobbling client (Infuse, Kodi's Trakt plugin) at it with a per-user API key and it writes straight into SlickTrax history.
- **Watch-history import/export** — import a Trakt/Letterboxd/IMDb CSV, or export as a Letterboxd-compatible CSV.

### 🔐 Vault
- AES-GCM encrypted at rest.
- Expiry/renewal alerts with configurable lead time, plus cost + billing-cycle spend tracking.
- Real active-checks: Real-Debrid/TorBox/Newznab against their own APIs, Stremio via real login, generic HTTP/TCP for the rest.
- Nightly encrypted export to `data/backup/vault/`, or on-demand.
- **Rotate Now** — one click opens both the provider dashboard and the edit form together.
- Drag-and-drop reordering; move addons between Addons and Vault without deleting them.
- **Live Real-Debrid/TorBox usage** on the entry card — active downloads and premium days remaining.
- **Auto-remove** (opt-in, per entry) clears finished/idle torrents past a day count you choose.
- **Renewal calendar & spend forecast** — a 90-day forward projection of every cost-tracked entry's billing cycle.

### 🔔 Notifications
**Push + the in-app bell are primary; Discord is entirely optional** — every type works with zero Discord setup, and a webhook just adds Discord delivery on top.

- Per-type toggles: activity, sync, invites, Vault, addon health, backups, **proxy connectivity**, updates, and monthly recap.
- Instant "started watching" ping from the live proxy signal.
- **Unconfirmed-device alert** when a stream shows up from an IP not yet seen on that account.
- Per-user notification opt-out and personal webhook override.
- New-episode alerts + a "Coming up" calendar on the Dashboard.
- **Monthly poster-mosaic recap** on the 1st — a real collage to Discord if a webhook's set, otherwise a plain push+bell summary.
- Addon down/back-up alerts, and an alert if the AIOStreams proxy itself goes unreachable.
- **Recovery Kit reminders** (opt-in) — a nudge when your Disaster Recovery Kit is stale or was never made while the Vault holds credentials. Nothing is ever uploaded on your behalf.
- **Digest mode** — batch everything into one daily/weekly summary instead of a ping per event.

### 📱 PWA, Speed & Offline
- Installs like a native app — Home Screen on iOS/Android, desktop install on Chrome/Edge.
- Per-device push for every notification type once installed, zero setup — VAPID keys self-generate on first boot.
- Manage subscribed devices (rename, revoke) from Settings; a revoked device stops getting pushed to immediately.
- **Opens instantly** — the app shell is cached, so an installed SlickSync starts from disk rather than loading from scratch. API data is never cached, so nothing shown is stale.
- **Pages you've already visited appear immediately** with what they showed last time, then refresh in place, instead of a loading spinner every visit.
- **Poster images are served at the size actually displayed**, resized and cached by your own server — far less data on phones and TV, and repeat views never leave your box.
- **Large grids stay fast at any depth** — Discover mounts only what's near the viewport, so sorting, opening a title and leaving the page cost the same after a thousand items as after ten.

### 🧩 Addons
Drag-and-drop reordering, drag-to-protect or drag-to-label with color-coded custom tags, order-insensitive sync comparison, provider-agnostic live addon counts, and multi-select for bulk actions.

- **Edit an addon's configuration in place** — most addons keep their settings inside their install URL. Open the addon, press **Edit config**, and those settings appear as editable fields (keys masked); saving rebuilds the URL and updates every user and group carrying that addon, with no remove-and-re-import. Addons whose configuration is encrypted or stored on their own server keep using their own configure page.
- **Per-addon health checks** — set a custom URL to probe when a manifest isn't a reliable signal, decide how many consecutive failures count as offline so a single blip can't trigger a failover or an alert, and set how often that addon is checked. An **Automate** button builds an offline rule for that addon in one step.
- **Backup addon** — assign a fallback used automatically when the primary goes offline, with a visible failover chain.
- **Proxy** — serve an addon through a URL on your own instance that hides its real manifest URL, regenerable at any time.
- **Addon Templates** — save a user's or group's addon set and deploy it onto anyone later, or hand it over as a share code.

### ⚙️ Automation
Rule-based actions that fire on real events, no external workflow tool needed — trigger on a new user, an addon going offline or coming back, or a schedule, and act by sending a notification or calling an outgoing **webhook**. Runs on the same engine that already drives notifications and health checks.

### ⌨️ Command Palette
**Ctrl+K** / **Cmd+K** from anywhere — jump straight to any page, user, addon, or catalog by typing a few letters, or ask a free-text question and get an answer from the built-in guides. No AI key required.

### 🎨 Themes
Ten full themes, switchable live, synced across devices. Build your own on top of any base — accent colors, success/error overrides, corner-roundness, text scale, and a choice of 11 display fonts — with a live preview. Two layout modes: the original sidebar, or **Nebula** (top nav + glass panels, default).

### 🔁 Sharing & Portability
Any piece of a SlickSync setup travels as one copy-paste code — no accounts, no files, no external service:

- **Catalogs**, **Nuvio collection layouts**, **addon templates**, and **themes** each export as a code another SlickSync can import.
- Every share is two steps on purpose: the dialog states exactly what the code contains before producing one. Nothing is shared by flipping a switch.
- Codes are produced entirely in your browser, so generating one sends nothing anywhere.
- Each kind carries its own prefix, so a wrong paste fails cleanly instead of importing something unexpected.
- Addon template codes include install URLs, which often contain API keys — the dialog warns before generating, and those codes should be treated like a password.

### 📊 Metrics
User leaderboard, watch streaks, watch-time trend, Top Viewers/Recent Activity/Recent Addons on the Dashboard, provider parity view, and a per-group activity dashboard.

- Same-email Stremio/Nuvio pairs are deduped in every leaderboard and total — one household member never counts as two.
- **Taste Profiles** — a per-user viewing fingerprint built from real watch history, not a guess.
- **Year in Review** — a Wrapped-style yearly recap: total watch time, top shows, most-rewatched titles, a by-month chart, and a per-user breakdown.
- **Public stats page** — an opt-in, unauthenticated share link for a single user's own watch time, top titles, and streak, off by default.

### 🩺 System Health
One page answering "is everything actually working right now" — sync drift, addon reachability, Vault credential checks, and AIOStreams proxy connectivity, all read from state background monitors already maintain.

- **Ignore** a known, accepted failure to drop it out of Attention and its notifications — reversible any time.
- **Addon uptime %** over the last 7/30 days, reconstructed from health-check history.
- Optional **AI-generated incident summary** on an addon-down alert — off unless you've set a key.
- **Version card** — what's actually running, and whether a newer stable release exists, without checking GitHub.

### 💾 Backup, Maintenance & Updates
Scheduled + on-demand config backups, validated for real restorability rather than just valid JSON, plus a separate **Disaster Recovery Kit** — the same export plus every Vault secret, re-encrypted under a passphrase you choose, fully portable to a brand-new instance.

- **Off-site backups** — send every scheduled backup to **S3** (AWS, Backblaze B2, Wasabi, Cloudflare R2, MinIO, anything S3-compatible) or **WebDAV** (Nextcloud, rsync.net). A Test button confirms the destination works before you rely on it, and optional local retention cleans up old copies. A failed upload never fails the backup — the local copy is already written, and a notification tells you rather than it failing quietly. These carry configuration only, never Vault credentials.
- **Database upkeep**, running quietly in the background: a read-only **integrity check** (on by default, since it can only ever read), plus opt-in compaction and old-log trimming. Compaction refuses to run if the disk lacks the space to do it safely, and nothing here touches watch history, users, catalogs, or the Vault.
- **Applying updates** from inside the app where the setup allows it — it backs up, downloads, then restarts, in that order, so a failed download leaves the running version untouched. Otherwise the page shows the exact command to run. Updating in place requires the Docker socket, which grants control of the host's Docker, so it is never enabled for you.

### 🛡️ Security
Rate limiting actually enabled (including a separate per-account limit on public-mode API traffic), strict limits on credential/OAuth endpoints, correct `trust proxy` hop count, no hardcoded default key, and a self-generating anti-lockout encryption key with decrypt-only fallback on rotation. Every external API key (RPDB, MDBList, TMDb, OMDb) resolves an account's own Settings key first — a shared instance-wide key in `.env` is only ever a fallback.

- **Two-factor authentication** — opt-in per account, authenticator-app QR setup, 10 one-time backup codes shown once. Disabling 2FA or regenerating codes both require a fresh code, so a hijacked session alone can't turn your second factor off.
- **OIDC/SSO login** — a "Continue with..." option for any OIDC-compliant provider (Authentik, Authelia, Keycloak, Google), configured via env vars. Fully additive: password login keeps working, and 2FA still applies after an SSO sign-in.
- **Interactive API docs** (Swagger UI) at `/api/docs` for the external developer API, generated from the same route handlers documented in [`API.md`](./API.md) so the two can't silently drift.
- **Self-service data export** — download your own watch history plus the household watchlist as JSON, no admin needed.
- **Self-service account deletion** at two scopes: an admin can wipe their entire account (public mode), and any managed user can delete just their own data from their own panel without touching shared addons, groups, or anyone else's data.

---

## 🚀 Installation

**Prerequisites**: Docker + Docker Compose, and a reverse proxy in front for HTTPS (Traefik/Caddy/nginx — SlickSync doesn't terminate TLS itself).

```bash
git clone https://github.com/slicknsliding/slicksync.git
cd slicksync
cp env.example .env
```

Generate a real secret and set it in `.env` — this signs your login sessions, so it needs actual randomness, not a made-up phrase:
```bash
openssl rand -base64 32
```
```
JWT_SECRET=<paste the output above>
```
`ENCRYPTION_KEY` can stay unset — one generates itself on first boot.

```bash
docker compose -f docker-compose.private.yml up -d
docker compose -f docker-compose.private.yml logs -f   # watch it come up
```

This pulls the pre-built `ghcr.io/slicknsliding/slicksync:private` image — the stable release built from `main`. (There's also a `:beta` image used for testing upcoming changes; don't use it unless you specifically want something not yet released.) The same image is published to Docker Hub as `slicknsliding/slicksync:private`.

Frontend and API are both served through `:3000` — the frontend proxies `/api`, `/uploads`, `/invite`, and `/proxy` requests to the API internally, so only `:3000` needs a port mapping or a reverse proxy pointed at it.

**Verify it's up**: `docker exec slicksync sh -c 'echo APP_VERSION=$APP_VERSION'` should print the current release tag (matching the latest on the [Releases page](https://github.com/slicknsliding/slicksync/releases)), and `https://your-domain/` should load the login page.

**Updating**: `docker compose -f docker-compose.private.yml pull && docker compose -f docker-compose.private.yml up -d` — your `/app/data` volume (database, encryption key, Vault backups, avatars) survives updates. No `git pull` or rebuild needed.

<details>
<summary><strong>Public / multi-tenant mode</strong> — hosting for more than one separate group</summary>

Private and public are genuinely different modes:

| | Private (default) | Public |
|---|---|---|
| Who it's for | One household running their own copy | Hosting for multiple separate groups |
| Database | SQLite, embedded | PostgreSQL (required) |
| Accounts | One shared instance, no signup | Self-registered, isolated per account |
| Image | `ghcr.io/slicknsliding/slicksync:private` | `ghcr.io/slicknsliding/slicksync:public` |

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

First visit shows a "Create one" registration link. `/register` generates a random account UUID once — that UUID *is* the login ID, so save it; there's no recovery if it's lost.

A **Superadmin** panel (`/superadmin`) lets the operator search tenant accounts, bulk enable/disable/delete them, see a health summary with an abandoned-account flag, and review an **audit log** of every action taken — without ever exposing a tenant's own credentials or private data.

**Updating**: `docker compose -f docker-compose.public.yml pull && docker compose -f docker-compose.public.yml up -d`.
</details>

<details>
<summary><strong>Environment variables</strong></summary>

Everything beyond `JWT_SECRET`/`ENCRYPTION_KEY` has a sensible default — see `env.example` for the full list. Most likely to actually change:

| Variable | Purpose | Default |
|---|---|---|
| `NUVIO_SUPABASE_URL` / `NUVIO_SUPABASE_ANON_KEY` | Override Nuvio's backend endpoint (also settable per account in Settings) | `https://api.nuvio.tv` / — |
| `SIMKL_CLIENT_ID` | Instance-wide SIMKL app registration (each account can bring its own) | — |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | Enable "Continue with..." SSO login (all four required) | — |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX_REQUESTS` | Credential-endpoint rate limit | 20 / 15 min |
| `POLL_RATE_LIMIT_MAX_REQUESTS` | OAuth device-flow poll limit | 60/min |
| `VAULT_BACKUP_INTERVAL_HOURS` | Vault export interval | 24 |
| `ADDON_HEALTH_CHECK_INTERVAL_MINUTES` | Global addon health-check cadence (overridable per addon) | 30 |
| `ACCOUNT_TIMEZONE` | Default day-bucketing timezone (overridable in Settings) | `America/Los_Angeles` |
| `AIOSTREAMS_URL` | Base URL of your AIOStreams instance | — |
| `AIOSTREAMS_AUTH_USERNAME` / `AIOSTREAMS_AUTH_PASSWORD` | Matching AIOStreams' own `AIOSTREAMS_AUTH` | — |
| `AIOSTREAMS_FALLBACK_USER_IDS` | Fallback user IDs for unresolvable proxy activity | — |
</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

- **Decryption errors after an update** (`Unsupported state or unable to authenticate data`): the running code is deriving a different key than what encrypted your data — check `data/server_secret.key` wasn't lost, and don't modify the key-derivation constants on a fork.
- **"credentials may be invalid" on Sync, but library/history still updates fine**: a decrypt-key rotation split your data across key generations. Every read path falls back to the previous key automatically, but some secrets stay encrypted under the old one. Fix it permanently: `docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" <container> node scripts/consolidate-encryption-keys.js` (dry-run; add `--apply --sync-keyfile` to re-encrypt everything onto the current key).
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
