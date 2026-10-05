<div align="center">

<img src="client/public/android-chrome-512x512.png" width="96" alt="SlickSync logo" />

# SlickSync

**One dashboard for a private streaming group — built around Nuvio.**

Collections, home rows, addons, shared credentials, watch history and live playback,
kept in sync across every profile — on **Nuvio**, **Stremio**, **Jellyfin**, **AIOStreams** and **AIOMetadata** alike.

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](./LICENSE)
[![Docker Pulls](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/slicknsliding/slicksync/badges/docker-pulls.json&logo=docker&logoColor=white&style=flat-square)](https://hub.docker.com/r/slicknsliding/slicksync)
[![Bun](https://img.shields.io/badge/bun-1%2B-000000?logo=bun&logoColor=white&style=flat-square)](https://bun.sh)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white&style=flat-square)](https://nextjs.org) [![Fork of Syncio](https://img.shields.io/badge/fork%20of-Syncio-blueviolet?style=flat-square)](https://github.com/iamneur0/syncio)

[**Nuvio**](#-built-for-nuvio) &nbsp;·&nbsp; [**Stremio**](#-stremio-whats-new-since-syncio) &nbsp;·&nbsp; [**Jellyfin | AIOStreams**](#-jellyfin-aiostreams-and-aiometadata) &nbsp;·&nbsp; [**Install**](#-installation) &nbsp;·&nbsp; [**Everything else**](#-everything-else) &nbsp;·&nbsp; [**Try it live**](https://slicksync.vip)

</div>

---

Nuvio gives you the apps. SlickSync gives you the control panel behind them: what each profile's home screen looks like, which addons everyone has, who is watching what right now, and a full watch history that outlives any one device — from one page, for the whole household. Stremio, where this started, keeps everything Syncio did and gains the additions below. Jellyfin, AIOStreams and AIOMetadata servers are the third kind of account: sign in to one and its viewing, households and collections are managed from the same place. One household can mix all of them.

> **Private, single-instance fork.** Built and run for one household's streaming group, not a general-purpose multi-tenant product.
>
> Can't self-host? **[slicksync.vip](https://slicksync.vip)** runs the same code in public mode, free to register.

<sub>Built on [Syncio](https://github.com/iamneur0/syncio) · Vault inspired by [AIOManager](https://github.com/Sonicx161/AIOManager) · Nuvio integration concepts from [Avangelista](https://github.com/Avangelista)</sub>

## Quick start

Docker and Docker Compose, plus a reverse proxy in front for HTTPS — SlickSync doesn't terminate TLS itself.

```bash
git clone https://github.com/slicknsliding/slicksync.git
cd slicksync
cp env.example .env
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
docker compose -f docker-compose.private.yml up -d
```

Everything is served on `:3000`. `ENCRYPTION_KEY` generates itself on first boot — you only need `JWT_SECRET`. Full walkthrough in [Installation](#-installation).

**New here?** Once it's running, **`/guides`** is the fastest way to learn it — a topic page for every page and setting, searchable, each with the gotchas that actually come up. The same content answers free-text questions from the command palette (`Ctrl+K` / `Cmd+K`), no AI key required.

---

# ⭐ Built for Nuvio

Nuvio is a first-class provider here, not a compatibility layer bolted onto a Stremio tool. Everything below is Nuvio-specific and has no equivalent in the Nuvio app itself.

### Home screens you can actually design

**Nuvio Collections** — build the folders and catalog sources Nuvio shows on the home screen, from a real editor instead of hand-arranging them on a phone.

- Build folders of catalog sources, drag to reorder both, grid or list view, and **preview the exact layout** before saving.
- Start from a **template** (Streaming Services, Genres) — the Genres template builds one folder per genre from that account's own installed addons.
- **Cover art** per collection and per folder: paste a URL or GIF, or browse nuvio.tv's own **Community Covers** gallery.
- **Pin** a collection to the top of the home screen.
- **Broken-source detection** flags a folder whose source no longer resolves — and separately flags an empty folder, which syncs fine but silently never renders on-device.
- **Copy a whole collection between profiles**, export/import as JSON, or hand it over as a **share code** with a picker for exactly which collections travel.

**Home-row editor** — reorder, rename and hide the rows on a profile's Nuvio home screen, then **copy that whole arrangement onto another profile** instead of re-dragging every row.

### Guards against Nuvio's own sync

Nuvio's collection sync is last-write-wins: another logged-in app pushing a stale state can silently erase everything you built. So SlickSync keeps rolling snapshots.

- **Collections Guard** — a mass-vanish raises a push alert and a banner naming the profile, with one-click **Restore** from the last good snapshot or **Accept** the new state. Edits made in SlickSync are the baseline immediately and never trigger it.
- **Home-row layout guard** — the same protection for each profile's row arrangement, which one bad write from any client can wipe.
- **Account Guard** — watches for addon changes SlickSync didn't make, with **Re-assert** or **Accept**.

### Every profile, not just the first

- **Every Nuvio profile syncs** — library, progress and addons, merged with a per-profile label.
- **A profile can be its own person** — every profile counts toward its account's person to begin with; **Separate** one into its own person with its own history, **Merge it back** later, or **Stop tracking** it (handy for a Kids or Guest profile).
- **Profiles with their own addon list** can be managed as users of their own; syncing one never touches another.
- Connect by **OAuth device-code/QR** or email + password; refresh tokens are encrypted at rest and refresh themselves.
- One person can hold both a Nuvio and a Stremio identity — **merge them into one user**, with a preview first and a full undo that restores both.
- **Self-hosted Nuvio backends** — point an account at your own Nuvio server; SlickSync reads that server's own discovery document to configure itself.

### SlickTrax on the device

A built-in Trakt alternative that installs into Nuvio as a real addon — no external service, no tokens.

- A single mixed **Continue Watching** row (films and shows together, by last watched), plus **Watchlist** and **For You** rows, per user.
- On Nuvio the Continue Watching row **places itself** among your existing home rows under its exact name — and if you move it later, your arrangement wins.
- **Linked catalogs** — add a SlickSync catalog as a folder source and the folder follows it from then on: edit the catalog here, the Nuvio home screen updates on its own.
- Set your instance's public address once (Settings → Sync) and it installs itself on the next sync.

### Anime, the way Nuvio libraries actually look

- An optional **Airing this season** row with next-episode countdowns, plus **watch-order chains** for franchises that split into prequels, sequels and side stories.
- Shows numbered **absolutely** (episode 137) are translated to the season and episode a library actually lists, so Continue Watching resumes on the right one instead of dropping the show.
- **Import an anime list** from AniList or MyAnimeList by pasting its URL — a whole list or just one section.

---

# 📺 Stremio: what's new since Syncio

Syncio already synced addons to a group of Stremio accounts. Everything below is what SlickSync added on top of that for a Stremio account.

- **Watch tracking without Trakt** — a live Now Playing for the whole group, and a complete history built from each Stremio library's own progress: durations, what was finished versus dropped, rewatches, and resume-on-another-device links straight into Stremio.
- **SlickTrax inside Stremio** — Continue Watching, Watchlist and For You rows installed as a normal addon by the next sync, fed by that history. No external service, no tokens.
- **Patch Cinemeta per user** — remove its search, its catalogs or its metadata without uninstalling it, and restore the original exactly.
- **Credentials that follow the addons** — the Vault holds debrid and other keys once; rotate one and every addon config on every Stremio account is rewritten to match, with health checks and backup keys that take over on failure.
- **Account Guard** — addon changes made outside SlickSync are detected within minutes, with Re-assert or Accept.
- **Sign-in by device code or QR** — connect a Stremio account without typing a password into SlickSync; the key is encrypted at rest.
- **Discover, Catalogs and share codes** — browse Cinemeta's real catalogs, build catalogs by hand, by URL or by criteria, and open any title directly in Stremio.
- **Two identities, one person** — a Stremio and a Nuvio account can be merged into one user, with a preview first and a full undo.

Everything under *Everything else* applies to Stremio accounts as much as to Nuvio.

---

# 🍿 Jellyfin, AIOStreams and AIOMetadata

A third kind of account, next to Nuvio and Stremio. Sign in to a **Jellyfin**, **AIOStreams** or **AIOMetadata** server — with a password, a PIN or a **Quick Connect** code — from Add User, the login page or an invite. SlickSync works out on its own which kind of server it is.

### Watching

- Watch history comes in, and what's playing shows in **Now Playing** with real watch time, straight from the server's sessions.
- Watched marks, favourites and resume points are **written back** to the server.
- **AIOStreams watch history** — turn it on per person and viewing in AIOStreams' own apps (Odin, Infuse, Swiftfin, the desktop app) becomes history and Now Playing; watched marks, the watchlist, drops and ratings flow back the other way. One link serves the whole household.
- **Keep Jellyfin in step** — what someone finishes in Stremio, Nuvio or AIOStreams is marked played on their Jellyfin server, and what they stop part-way picks up at the same spot there.
- On a Jellyfin server, Now Playing names the **device and app**, and a device someone hasn't used before can raise a notification.
- **Posters for anime and other titles without an IMDb id**, straight from the server's own artwork.

### Households

- AIOStreams and AIOMetadata **household users become profiles** of the person who signed in, all on one card on the Users page.
- **Separate** a profile into its own person, **Merge it back**, or **Stop tracking** it. PIN users sign in with their PIN.
- **Sign in a new device with its code** — pick who it's for, type the Quick Connect code the device shows, and the server signs it in as them.
- **Devices** — everything signed in as someone on a Jellyfin server, with Sign out next to each.
- **Age limit** — the highest age rating someone's Jellyfin account can play, from the server's own list, enforced in every Jellyfin app.
- **Invites that make the account** — an invitation can create the person's Jellyfin account with a password they choose; it stays off until you accept them, and switches off again if they expire or are removed.
- **AIOStreams household users** — add one, or set or remove their PIN, from the household card.

### Collections

**Catalogs → Jellyfin | AIOStreams** — one page for both.

- **AIOStreams Collections** — each collection opens as its own page with its titles: search to add, add from Discover, drag to reorder; everything saves as you go.
- **Per profile**, like Nuvio Collections — give a household profile collections of its own and SlickSync sets that profile up in AIOStreams so its apps load them.
- **Copy, export and share** — copy one profile's collections to another, save them to a file, or hand them over as a share code; catalogs a code needs are made on import.
- **Catalogs as Jellyfin collections** — switch a catalog on and it becomes a real collection on your own Jellyfin server, holding the titles the server has. Kept in step every 30 minutes, named after its catalog and given its cover.

### Guarded

- A change made to an AIOStreams configuration outside SlickSync raises a bell and push notification. SlickSync writes there only for a profile's own collections setup, and — if you switch it on for a person — to swap a debrid key the Vault rotated or failed over.
- Exports and Disaster Recovery Kits carry households, their sign-ins and their collections.
- **AIOStreams history** — every version of a configuration is kept, with what changed from the one before; **Put back** restores an earlier one, keeping today's debrid services, household users and API keys unless you untick them.
- **AIOStreams health** on a person's page — each addon's errors, empty answers and slow responses as AIOStreams itself reports them, and a one-off test search.

---

# 📚 Everything else

<details>
<summary><strong>🎬 Activity &amp; Now Playing</strong> — who's watching what, right now and historically</summary>

- Live **Now Playing** for every provider — Jellyfin and AIOStreams sessions, AIOStreams' proxy and each library's own progress — gone the moment playback stops.
- **History &amp; Watch Time** come from each provider's own library state, including sources the proxy can't see.
- **Real completion tracking** — finished vs. started-and-dropped, plus **rewatch counts**, and per-day entries for a series rewatched across several days. You choose when something counts as finished (75–98%).
- **Activity filters** — person, the app it was watched on, profile, movies or shows, finished or not, and any date range; **Copy link** shares the exact view.
- **Airing Calendar** — a date-grouped agenda of upcoming episodes for everything anyone's actively watching.
- Correct-or-nothing posters, with optional **RPDB** rating-embedded art.
- Explicit per-account timezone so "today" means the same thing to every background job.
- **The Graveyard** — bury a title to keep it out of Continue Watching, dig it up any time, or wipe it (optionally reaching the device's own library too).
- **Watching Together** — an alert the moment someone starts an episode past the shared frontier.
- **Device claims** — on a shared login, claim a device and its activity is attributed to the right person.
- **Leave someone out of household numbers** — a test or guest person keeps their own page but stops counting toward totals, charts, Top Viewers and the year in review.
- **Daily limits** — so many minutes a day on the days you choose, counted across every app. At the limit you're told — or, per person, their streaming pauses until midnight or a time you pick: the addons that play streams come off on Stremio and Nuvio, and the server's own parental schedule applies on Jellyfin. **Resume now** gives the rest of the day back.
- **Caught up to…** — mark a show watched up to an episode, in SlickSync and on their server, with **Undo** and un-ticking a single episode.
- **Last seen** on every person, a **Dormant** filter for people who stopped watching, and an automation that can switch them off after a quiet stretch.
</details>

<details>
<summary><strong>🎞️ Discover &amp; media details</strong> — find something to watch, and know what it is</summary>

- Any poster opens cast, rating, genres, director, runtime, awards and an inline trailer; Rotten Tomatoes/Metacritic, box office and franchise grouping with a free OMDb key.
- **Cast &amp; crew deep-dive** — click an actor to see their real filmography and jump into any of it.
- Browse Popular / New / Top Rated with genre filters and infinite scroll; **people search** as its own mode.
- **Describe it** — type the plot you half-remember and get the real title, verified against a real record before it's shown.
- Four sources side by side: Discover, ★ Watchlist, ✨ For You, and "nobody here has seen it yet".
- **Where to watch** provider logos, **MDBList** score, **franchise completion** and a **Finish the Saga** row.
- Right-click or long-press any poster for Watchlist / Catalogs / Mark Watched.
</details>

<details>
<summary><strong>📚 Catalogs</strong> — named lists you build, share and keep updated</summary>

- Create, rename, delete; add titles from any poster or its detail popup; custom cover art.
- **Import** from MDBList, TMDb, a public Trakt list, AniList/MyAnimeList, a linked SIMKL account, or a pasted share code.
- **Describe it in plain English** ("90s horror") and review the suggestions before anything is added.
- **Smart Catalogs** — give a catalog criteria instead of a fixed list and it re-evaluates itself.
- **Content Rating allowlist** turns a catalog into an enforced, genuinely kid-safe list.
- **Auto-refresh** keeps a URL-sourced catalog following its source; **export** to MDBList, SIMKL or a share code.
- **Publish to another household** — a published catalog gets a link; pasted into another SlickSync's Import, it arrives as a normal catalog that plays through *their* addons and debrid. Only titles travel — no credentials, addons, users or watch history — and if they turn on Auto-refresh it keeps following yours. Unpublishing stops future pulls without reaching into what they already have.
</details>

<details>
<summary><strong>✨ SlickTrax</strong> — watch tracking without an external service</summary>

- **Watchlist**, **watched indicators** with manual override, and **For You** rows built from real weighted watch time.
- **More Like This** on every detail popup, biased by real household affinity, with a **Real match** badge when it's backed by genuine viewing.
- **Not Interested** feedback downweights similar titles, not just the one dismissed.
- **Trakt-compatible scrobble-in API** — point Infuse or Kodi's Trakt plugin at it with a per-user key.
- **Watch-history import/export** — Letterboxd, IMDb, Trakt, Netflix, TV Time, Plex, Tautulli and Movary exports in; Letterboxd-compatible CSV out.
- **Watchlist ranking** — drag it into the order you actually want, and the device row follows.
- **Rows per person** — each person can hide any SlickTrax row or change their order.
</details>

<details>
<summary><strong>🔐 Vault</strong> — every shared credential in one encrypted place</summary>

- AES-GCM encrypted at rest, with expiry/renewal alerts, cost tracking and a 90-day spend forecast.
- Real active-checks: Real-Debrid/TorBox/Newznab against their own APIs, Stremio via real login, generic HTTP/TCP for the rest.
- **Backup keys with automatic failover** — a failing primary hands over, every addon carrying the key updates in place, and the pair swaps back when the original recovers.
- **The Key Pool** — up to ten keys per service, rotating across them, skipping bad ones, with optional quota-aware weighting and auto-retire.
- **Live Real-Debrid/TorBox usage**, **auto-remove** for finished torrents, and an **OMDb usage meter** against the free daily limit.
- Nightly encrypted export, plus **Rotate Now** which opens the provider dashboard and the edit form together.
</details>

<details>
<summary><strong>🔔 Notifications</strong> — push and bell first, Discord optional</summary>

Every type works with zero Discord setup; a webhook only adds Discord delivery on top.

- Per-type toggles: activity, sync, invites, Vault, addon health, connection problems, backups, proxy connectivity, updates and monthly recap.
- **Connection problems** — told the moment someone's sign-in needs reconnecting (after 15 minutes if their server is just unreachable), and again when it's back. One alert per outage, on by default.
- A whole Jellyfin, AIOStreams or AIOMetadata server going down is **one alert**, naming who's affected — not one per person.
- Instant "started watching" ping, **unconfirmed-device alerts**, new-episode alerts and a Coming Up calendar.
- **Monthly poster-mosaic recap**, **Recovery Kit reminders**, and **digest mode** to batch everything into one summary.
- Per-user opt-out and personal webhook override.
</details>

<details>
<summary><strong>📱 App, speed &amp; offline</strong> — installs like a native app and opens instantly</summary>

- Home Screen on iOS/Android, desktop install on Chrome/Edge, with per-device push and an unread badge on the icon.
- **Opens instantly** — the app shell is cached; API data never is, so nothing shown is stale.
- **Live updates** push changes to open pages, so Now Playing appears the instant a stream starts.
- Posters are served at the size actually displayed, as **WebP** where the browser accepts it, cached on your own box.
- Discover's lists are kept warm, hovering a poster preloads its details, and large grids stay fast at any depth.
- **Share into SlickSync** from another app, and **app shortcuts** straight to Activity, Discover or Health.
- **On a phone**, popups stay on screen, the bell and command palette sit in the top bar, and a notification swipes away to dismiss.
</details>

<details>
<summary><strong>🧩 Addons</strong> — one set, everywhere, with health checks</summary>

- Drag to reorder, protect or tag; multi-select for bulk actions; order-insensitive sync comparison.
- **Edit an addon's configuration in place** — its settings appear as editable fields, and saving rebuilds the URL for every user and group carrying it.
- **Per-addon health checks** with a custom probe URL, a failure threshold and its own cadence.
- **Backup addon** with visible failover chain, and a **proxy** URL that hides an addon's real manifest.
- **Addon Templates** — save a user's or group's whole set and deploy it onto anyone later, or share it as a code.
</details>

<details>
<summary><strong>⚙️ Automation &amp; command palette</strong> — rules that fire on real events</summary>

- Trigger on a new user, an addon going offline or recovering, a watch starting or finishing, a key failover, or a schedule — and notify, call a webhook, run a backup, check keys or promote a backup key.
- **Recipes** are pre-built rules, one click to enable; every rule reads back as a plain-English sentence.
- **Ctrl+K / Cmd+K** jumps to any page, user, addon or catalog, answers free-text questions from the built-in guides, and finds individual settings — picking one lands on it and flashes the control.
</details>

<details>
<summary><strong>🎨 Themes &amp; sharing</strong> — make it yours, then hand pieces to someone else</summary>

- Ten themes, switchable live and synced across devices; build your own on any base with a live preview.
- Two layouts: the original sidebar, or **Nebula** (top nav + glass panels).
- **Catalogs, Nuvio collection layouts, addon templates and themes** each export as a copy-paste code — produced in your browser, so generating one sends nothing anywhere.
- Every share states exactly what the code contains first; template codes can carry API keys, and the dialog says so.
</details>

<details>
<summary><strong>📊 Metrics &amp; health</strong> — what happened, and whether everything still works</summary>

- Leaderboards, streaks, watch-time trends and per-group dashboards, with same-person Stremio/Nuvio pairs deduped.
- **Taste Profiles** and a Wrapped-style **Year in Review**; an opt-in **public stats page** for a single user.
- **System Health** answers "is everything working right now" — sync drift, addon reachability, credential checks, proxy connectivity.
- **Servers** — every Jellyfin, AIOStreams and AIOMetadata server people use, shown as up, down or partly failing.
- **Addon uptime %** over 7/30 days, ignorable known failures, and a version card showing what's running.
</details>

<details>
<summary><strong>💾 Backups, restore &amp; updates</strong> — including the watch history itself</summary>

- Scheduled and on-demand **config backups**, validated for real restorability, plus a **Disaster Recovery Kit** carrying every Vault secret re-encrypted under your own passphrase.
- **Full-data backups** snapshot the database — your watch history's only home — verify each snapshot is readable, and can send an encrypted copy off-site.
- **Off-site targets**: S3 (AWS, B2, Wasabi, R2, MinIO) or WebDAV, with a Test button and optional encryption passphrase.
- **Time Machine** restores to any point with a diff preview, or scoped to a **single user**.
- **Trash with 30-day undo** for every destructive action, and **one-code instance migration** to a brand-new box.
- **Config import keeps watch history** — re-importing into the same SlickSync leaves everyone's history, stats and Activity attached.
- **Database upkeep** runs quietly: read-only integrity checks by default, opt-in compaction and log trimming, never touching history, users, catalogs or the Vault.
</details>

<details>
<summary><strong>🛡️ Security</strong> — passkeys, 2FA, SSO, and keys that stay yours</summary>

- **Passkeys** — sign in with Face ID, a fingerprint, a PIN or a security key. Always additive: the password keeps working, so a lost device can't lock you out.
- **Two-factor authentication** with backup codes; disabling it or regenerating codes needs a fresh code.
- **OIDC/SSO login** for any compliant provider (Authentik, Authelia, Keycloak, Google), fully additive.
- Every external API key resolves the account's own Settings key first — an instance-wide key is only ever a fallback.
- Rate limiting on credential endpoints, a self-generating anti-lockout encryption key, and **self-service export and deletion** for any managed user.
- **Interactive API docs** at `/api/docs`, generated from the same handlers documented in [`API.md`](./API.md).
</details>

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

This pulls the pre-built `ghcr.io/slicknsliding/slicksync:private` image — the stable release built from `main`. (A `:beta` image exists for testing upcoming changes; don't use it unless you specifically want something not yet released.) The same image is published to Docker Hub as `slicknsliding/slicksync:private`.

Frontend and API are both served through `:3000` — only that port needs a mapping or a reverse proxy pointed at it.

**Verify it's up**: `docker exec slicksync sh -c 'echo APP_VERSION=$APP_VERSION'` should print the current release tag (matching the latest on the [Releases page](https://github.com/slicknsliding/slicksync/releases)), and `https://your-domain/` should load the login page.

**One setting worth doing straight away**: Settings → Sync → **Public address**. SlickTrax installs itself onto devices during a sync, and a sync has no browser request to learn a hostname from — without it, SlickTrax can't be installed automatically.

**Updating**: `docker compose -f docker-compose.private.yml pull && docker compose -f docker-compose.private.yml up -d` — your `/app/data` volume (database, encryption key, Vault backups, avatars) survives updates. No `git pull` or rebuild needed.

> [!WARNING]
> **Installed before 1.88.0 from this repository's compose file? Move your data before your next update.**
> Older copies of `docker-compose.private.yml` declared no volume, so your database lives inside the container. Switching to the current file without moving it first starts SlickSync empty. Copy it out while the old setup is running, switch, then copy it back:
>
> ```bash
> docker compose -f docker-compose.private.yml cp slicksync:/app/data ./slicksync-data
> docker compose -f docker-compose.private.yml down
> git pull
> docker compose -f docker-compose.private.yml up -d
> docker compose -f docker-compose.private.yml cp ./slicksync-data/. slicksync:/app/data
> docker compose -f docker-compose.private.yml exec -u root slicksync chown -R 1001:1001 /app/data
> docker compose -f docker-compose.private.yml restart
> ```
>
> Keep `./slicksync-data` until you've checked everything is there. If your compose file already mounts a volume at `/app/data`, none of this applies. Full details in the [1.88.0 release notes](https://github.com/slicknsliding/slicksync/releases/tag/v1.88.0).

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
POSTGRES_PASSWORD=<any password you choose>
```

The app and the bundled Postgres container both read `POSTGRES_PASSWORD`, so the connection string builds itself — there's no `DATABASE_URL` to assemble by hand.

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
| `PUBLIC_APP_URL` | The address devices reach this instance on, used to install SlickTrax (also settable in Settings → Sync) | — |
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
- **SlickTrax is enabled but never appears on the device**: set Settings → Sync → Public address (or `PUBLIC_APP_URL`). A sync has no browser request to learn the hostname from.
- **A Jellyfin or AIOStreams server on your home network won't sign in on a shared instance**: a public-mode SlickSync (like slicksync.vip) never connects to private-network addresses. Use the server's public address, or run your own instance.
- **Jellyfin collections aren't renamed or don't get a cover**: Jellyfin only lets administrators do that. Without an administrator's sign-in, a renamed catalog's collection is made again under the new name instead.
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
