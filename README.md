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

## Contents

- [Multi-Provider Sync](#-multi-provider-sync)
- [Activity Tracking & Now Playing](#-activity-tracking--now-playing)
- [Media Details, Continue Watching & Discover](#-media-details-continue-watching--discover)
- [SlickTrax: Watchlist, Watched Indicators & Recommendations](#-slicktrax-watchlist-watched-indicators--recommendations)
- [Vault](#-vault)
- [Notifications & New-Episode Alerts](#-notifications--new-episode-alerts)
- [Progressive Web App & Push Notifications](#-progressive-web-app--push-notifications)
- [Addons](#-addons)
- [Addon Snapshots](#-addon-snapshots)
- [Profiles](#-profiles)
- [Themes](#-themes)
- [Metrics & Dashboard](#-metrics--dashboard)
- [Security Hardening](#-security-hardening)
- [Installation](#-installation)
- [License](#license)

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

**Two independent signals feed this, each doing the job the other can't:**

| Signal | Source | Owns |
|---|---|---|
| **Proxy** | Polls AIOStreams' built-in stream proxy every 30s | Live presence — the Now Playing panel and the instant "started watching" notification |
| **Native** | Polls each provider's own library/watch state every 1m | The record — History, duration, and Watch Time, for every source |

The proxy sees streams open and close in real time, but is blind to anything
routed outside it (usenet via newznab, for instance). The provider only
checkpoints at pause/stop, so it learns of a session late and then holds it
"active" for ~18 minutes — accurate for history, useless for liveness. Hence
the split:

- **The proxy is a presence signal only** — it never writes watch history or
  durations. A proxy connection's wall-clock lifetime isn't watch time
  (AIOStreams holds stale connections open for hours), so all duration comes
  from the provider's own counters.
- **Now Playing is never based on native alone**, which would leave an
  already-exited stream showing as playing for ~18 minutes.
- **Reconciliation is per-title, not per-user** — the proxy is authoritative
  only for content it actually carries, so usenet playback it never saw is
  left to native and shows up correctly.
- **Usenet is fully covered** in Now Playing, History, and Watch Time, despite
  never touching the proxy.
- **1-minute poll cycle** for fast detection of new activity, library changes,
  and session state, across every connected account and profile.
- **Per-day, per-user Activity feed** grouped by date, with poster art,
  season/episode for series, and which profile the watch came from.
- **Request-count detail** on Activity cards, matching AIOStreams' own Proxy
  History tab.
- **Correct-or-nothing posters.** Library items use the provider's own poster
  with a Cinemeta-by-ID backfill. Proxy-detected items — where all we have is
  a title parsed out of a filename — go through a strict Cinemeta title
  search that returns a poster *only* on an exact normalized-title match,
  plus an exact year match when the filename carries a year. No confident
  match means no poster, never a guessed one.
- **Explicit account timezone** (Settings → Privacy & Display). Background
  pollers have no request context to infer a viewer's timezone from, so
  "today" is a setting rather than a guess — otherwise Watch Time Today
  silently bucketed by UTC and rolled over at the wrong hour. Defaults to the
  `ACCOUNT_TIMEZONE` env var.
- **Top Watched / Recent Activity / Top Viewers** on the Dashboard and each
  user's detail page, built from real session duration — not just a count of
  events.
- **Cross-user library-sync dedup** — if two accounts share a Stremio email
  (e.g. a Nuvio-only account still signed into Stremio's cloud), Stremio's own
  library sync can replicate a single watch to both accounts' history down to
  the millisecond. The Activity feed and per-user stats collapse those into
  the one real watch (keeping whichever side has an actual recorded
  duration) instead of double-counting or misattributing it. Two people on
  separate accounts genuinely watching the same title stay fully independent.

### 🎞️ Media Details, Continue Watching & Discover

- **Click any poster** — on the Activity page, a Continue Watching card, or
  anywhere in Discover — for cast (with photos), IMDb rating, genres,
  director, runtime, and awards, pulled from Cinemeta, the same free, keyless
  service already used for posters elsewhere in the app, so this adds no new
  API key or external account to manage.
- **Trailers play inline** via an embedded YouTube player, right in the modal
  — no bouncing out to youtube.com.
- **Discover**: browse Cinemeta's real catalogs — Popular, New, and Top
  Rated — for movies and series, or search by title, with a **genre filter**
  (18 genres) that stacks with the catalog choice and **infinite scroll**
  past the first page. Every result opens the same detail modal, with
  **"Open in Stremio" / "Open in Nuvio" buttons** (color-matched to each
  provider's own identity badge) to jump straight into either app — not
  limited to things already in someone's watch history. Three switchable
  sources sit side by side: **Discover** (the catalogs above), **★
  Watchlist** (your own saved list), and **✨ For You** (recommendations —
  see below).
- **Rating/year consistency**: Cinemeta actually runs two separate backends
  that can disagree on the same title's rating or release year. The detail
  modal keeps whichever number you already saw on the poster instead of
  silently overwriting it with the other backend's different answer.
- **Continue Watching** on the Dashboard: the next unwatched episode for any
  show someone's partway through, most recently watched first. Click-and-drag
  to scroll the row (works with mouse, touch, or pen — no scrollbar to grab).
  Right-click (desktop) or long-press (mobile) a card to remove it.
- **Deep links open straight into the app**, with each provider's real
  format used correctly rather than assumed:
  - **Stremio**: `stremio:///detail/{type}/{imdbId}/{videoId}` — documented
    directly by Stremio's own SDK. Movies and no-specific-episode series
    links resolve correctly (`videoId = id` for movies, empty for a series
    overview page); Continue Watching adds a season/episode to land on the
    right one.
  - **Nuvio**: `nuvio://meta?type={movie|series}&id={imdbId}` — an entirely
    different format, confirmed by reading Nuvio Desktop's own source rather
    than guessed at. Nuvio's format has no season/episode concept, so it
    always opens the show's own page.
  - Either way, only the title's public IMDb ID (and season/episode, for
    Stremio) is in the link — nothing account-specific, no credentials. A
    fallback link is always shown alongside the app link too, since a
    browser has no way to detect whether the target app was actually
    installed to catch it.

### ✨ SlickTrax: Watchlist, Watched Indicators & Recommendations

SlickTrax is SlickSync's own built-in tracking system — a Trakt-alternative
with no external service to connect, no tokens, no per-app connection limits:

- **Watchlist**: bookmark anything from its poster (right-click on Discover,
  or the button in the detail modal) to build a list of what to watch next.
  Shows up as its own "★ Watchlist" source in Discover.
- **Watched indicators**: an emerald checkmark badge on any Discover poster
  you've already watched, sourced from your own real watch history (either
  provider). An **Unwatched / Watched filter** lets you browse minus what
  you've seen, or the reverse. A manual override (right-click → Mark as
  watched/unwatched) lets you correct a false positive or mark something
  watched off-platform, without touching the underlying watch-history record.
- **Recommendations ("✨ For You")**: up to three genre rows on Discover,
  built from real weighted watch-time — every title with recorded activity is
  scored by how much time you actually spent on it (recency-decayed, so a
  show you're bingeing this week outweighs a movie watched once months ago),
  Watchlist adds count too at a lighter weight, and each row's genre is
  whichever scored highest overall rather than just your 3 most recent
  titles. Filtered to exclude anything already watched or already on the
  Watchlist.
- Each of the three is **independently toggleable** in Settings → SlickTrax —
  turning one off hides its UI and stops its background work without
  touching any data, so re-enabling picks up exactly where you left off.

### 🔐 Vault

Credential tracking with expiry alerts and active-checks. Track API keys,
accounts, and credentials (debrid services, Usenet providers/indexers, VPN,
AI services, or your own Stremio/Nuvio-specific secrets) in one place:

- **Encrypted at rest**, same AES-GCM scheme as the rest of the app.
- **Expiry / renewal tracking** with a configurable days-before alert —
  works equally for a credential's real expiry date or a subscription's next
  billing/renewal date, alongside the optional cost + billing-cycle fields
  used for the Vault page's spend summary.
- **Real active-checks**, not just "is the server up":
  - Real-Debrid, TorBox, and Newznab indexers validate the actual key against
    the provider's own API.
  - Stremio credentials are verified with a real login attempt against
    Stremio's API — checked against the account's actual auth state (not
    inferred from a wrapper's return value), so it correctly distinguishes a
    genuinely bad password from a transient issue.
  - Generic HTTP/TCP-reachability checks for anything else.
- **Alerts when something's expiring or a check starts failing** — Vault
  alerts ride the same webhook as every other notification, configured once
  in Settings → Notifications with a per-type toggle. There's deliberately no
  separate Vault notification config to keep in sync.
- **Scheduled export**: a decrypted snapshot writes to `data/backup/vault/`
  nightly (`VAULT_BACKUP_INTERVAL_HOURS` to change the interval), so Vault
  data can be pulled off-server for backup or synced into an external
  password manager. On-demand backup via `POST /api/vault/backup-now`.
- **Drag-and-drop reordering** within the Vault.
- **Move addons directly from the Addons page into the Vault** to store ones
  you're not actively using without deleting them — keeps the Addons page
  focused on what's actually deployed, and they can be moved back out just
  as easily.

### 🔔 Notifications & New-Episode Alerts

One Discord webhook, configured once in Settings → Notifications, with
per-type toggles for activity, sync, invites, and Vault alerts. The "started
watching" notification fires from the proxy pipeline the moment a stream
opens, rather than at stop time — which read as an end-of-watch notification
and defeated the point. Watch activity that never reaches the proxy at all
(usenet via newznab is the confirmed real case) still gets a "watched"
notification once the native poller records it — delayed by a poll cycle
instead of instant, but no longer silent. Each toggle also mirrors to
**native phone/desktop push** (see PWA section below) — independent of
whether a Discord webhook is even configured.

- **Per-user watch notification control**: each managed user can opt out of
  notifications for their own watch activity from their self-service Settings
  page, independent of everyone else's. If they set their own personal
  Discord webhook there too, their watch pings route to it instead of the
  shared account webhook — useful for keeping one household member's activity
  off a shared channel, or giving them their own.
- **New-episode alerts**: a background poller watches Cinemeta's episode
  lists for every show anyone here is mid-season on, and pings Discord + the
  notification bell + push when a genuinely new episode drops. Only
  past-dated releases count, and the first sighting of a show only records a
  baseline — no backlog spam for a show newly picked up.
- **"Coming up" calendar** on the Dashboard: the same poller's data surfaced
  as a forward-looking view of what's airing next, with friendly air-date
  labels (Today / Tomorrow / weekday / date). Right-click (desktop) or
  long-press (mobile) any row to hide that specific episode — it reappears on
  its own once the show advances past it.

### 📱 Progressive Web App & Push Notifications

SlickSync installs like a native app — add to your phone's Home Screen
(iOS/Android) or install from the browser on desktop, and it launches
fullscreen with its own icon. Once installed, **Settings → Notifications**
has a per-device toggle for native push: activity, sync, invite, Vault, and
new-episode alerts all arrive as real lock-screen notifications, even with
SlickSync closed. Zero setup — the required VAPID keypair generates itself
on first boot and persists on the data volume; there's nothing to configure
in env vars. (iOS specifically requires the Home Screen install first — Apple
only exposes the Push API to installed web apps.)

### 🧩 Addons

- **Drag-and-drop reordering** on the Addons page (grid view), matching
  Vault's pattern. Order persists server-side rather than resetting on
  refresh.
- **Drag onto "Protected"** to protect an addon (account-wide, by name,
  mirroring how default-addon protection already worked), or **drag onto a
  custom label pill** to tag it with your own categories — e.g. "Kids", "4K",
  "Backup". Create labels with "+ New Tag", click a pill to filter by it,
  hover for a × to delete one. Both actions also work without dragging: an
  addon card's right-click menu has a **Label** entry that opens a picker —
  every existing label to choose from, a checkmark on the current one
  (clicking it again deselects), and a "New label" row that creates and
  applies a label in one step.
- **Color-code your labels** — click the swatch dot on any label pill to pick
  a color; it tints that label everywhere it shows up (the pill, the card
  badge, the picker), so labels stay visually distinct at a glance.
- **Order-insensitive sync comparison** — a user whose addons are the same set
  in a different order no longer reports as out of sync.
- **Provider-agnostic live addon count**, correct for Nuvio users rather than
  Stremio-only.

### 📦 Addon Snapshots

A template library: save any user's or group's current addon set as a named
template, then deploy it to any user with one call. Manifest URLs are
encrypted at rest; deploys re-fetch fresh manifests rather than reusing a
stale copy.

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

Theme picking and the theme builder live on their own dedicated **Themes**
page (account menu, next to Settings and Changelog) rather than buried in
Settings — reachable from both the Original sidebar and Nebula's account
dropdown.

**Build your own theme**: save as many named custom themes as you want, each
layered on top of one of the ten built-ins. Picking a different base updates
every optional override's starting color to match that base's real palette,
so customizing "from" a theme actually starts from what it really looks
like. Every custom theme gets:

- Primary/secondary accent, plus optional overrides for text, muted text,
  background, surface, subtle-fill, and card-border colors.
- **Success/Error accent overrides** — recolors health-check dots, badges,
  and confirmation toasts app-wide instead of each theme's fixed green/red.
- **A Continue Watching progress-bar color override**, independent of the
  primary→secondary gradient it uses by default.
- A corner-roundness preset (Square / Standard / Rounded / Extra rounded)
  and a text-size preset (Default / Small / Large / Extra large) that scales
  body text and most UI chrome app-wide.
- One of **eleven** genuinely distinct display fonts — Space Grotesk,
  Poppins, Merriweather, Playfair Display, JetBrains Mono, Bungee, Bangers,
  Press Start 2P, Permanent Marker, Luckiest Guy, Orbitron — spanning
  rounded sans, classic and elegant serif, monospace, poster/comic/graffiti
  display, retro pixel, handwritten, and sci-fi.
- A live preview mockup (brand header, stat tiles, an actual Continue
  Watching progress bar, tag pills, buttons, a toggle) that samples nearly
  everything the builder controls in one place, instead of a couple of
  isolated color swatches.

Custom themes sit alongside the built-ins in the picker with their own
delete button. **Theme choice and your whole custom-theme library sync
across every device** on the account — pick a theme on your desktop, it's
there on your phone next time you open the app.

**Layout** (same Themes page): two structurally different admin UIs — the
original sidebar layout, or **Nebula** (top nav + floating glass panels,
the default), with full coverage across every admin page.

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

### Public (multi-tenant / hosted)

Private and public are genuinely different modes, not just a config toggle:

| | Private (default, recommended for most people) | Public |
|---|---|---|
| **Who it's for** | One household/group running their own copy | Someone hosting SlickSync for multiple separate groups |
| **Database** | SQLite, embedded, single file | PostgreSQL (required) |
| **Accounts** | One shared instance, no self-signup | Each admin self-registers their own isolated account via `/register` |
| **Login** | Optional shared username/password gate (or none at all if unset) | Per-account login, separate credentials per account |
| **Image** | Builds locally from the `Dockerfile` in this repo | Pulls the pre-built `ghcr.io/slicknsliding/slicksync:public` image |

If you're not intentionally hosting this for more than one separate
group, use **private mode** (the default throughout this README) - public
mode's multi-tenant signup and Postgres requirement add real operational
overhead (a second service to run, back up, and keep healthy) that private
mode doesn't need at all.

To run public mode instead:

```bash
git clone <your-repo-url> slicksync
cd slicksync
cp env.example .env
```

Set at minimum:
```
JWT_SECRET=<any long random string>
ENCRYPTION_KEY=<any 32+ character string>
DATABASE_URL=postgresql://slicksync:slicksync@db:5432/slicksync
```

(`docker-compose.public.yml` already defines a `db` Postgres service with
matching credentials, so the values above work as-is if you don't change
that file.)

```bash
docker compose -f docker-compose.public.yml up -d --build
```

First visit to the frontend will show a login screen with a "Create one"
link rather than going straight to a dashboard - that's expected. Registration
(`/register`) generates a random account UUID server-side and shows it once;
that UUID *is* the login ID (public mode has no separate username/email), so
there's no recovery if it's lost. Set a password, and you're straight into
that account's own isolated dashboard.

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
| `ACCOUNT_TIMEZONE` | Default timezone for day-bucketing (Watch Time Today, streaks). Overridden per-account in Settings → Privacy & Display | `America/Los_Angeles` |
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
