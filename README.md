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

[**Nuvio**](#-built-for-nuvio) &nbsp;·&nbsp; [**Stremio**](#-stremio-whats-new-since-syncio) &nbsp;·&nbsp; [**Jellyfin**](#-jellyfin-aiostreams-and-aiometadata) &nbsp;·&nbsp; [**AIOSync**](#-aiosync) &nbsp;·&nbsp; [**Install**](#-installation) &nbsp;·&nbsp; [**Everything else**](#-everything-else) &nbsp;·&nbsp; [**Try it live**](https://slicksync.vip)

</div>


---

Nuvio gives you the apps; SlickSync is the control panel behind them — home screens, addons, who's watching what, and a watch history that outlives any device, for the whole household from one page. Stremio keeps everything Syncio did, plus the additions below. Jellyfin, AIOStreams and AIOMetadata servers are a third kind of account. One household can mix them all.

> Can't self-host? **[slicksync.vip](https://slicksync.vip)** runs the same code, free to register.

<sub>Built on [Syncio](https://github.com/iamneur0/syncio) · Vault inspired by [AIOManager](https://github.com/Sonicx161/AIOManager) · Nuvio integration concepts from [Avangelista](https://github.com/Avangelista)</sub>

## Quick start

Needs Docker Compose and a reverse proxy for HTTPS.

```bash
git clone https://github.com/slicknsliding/slicksync.git
cd slicksync
cp env.example .env
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
echo "SLICKSYNC_PRIVATE_USERNAME=admin" >> .env
echo "SLICKSYNC_PRIVATE_PASSWORD=$(openssl rand -base64 18)" >> .env
docker compose -f docker-compose.private.yml up -d
```

Open `:3000` and sign in with the username and password from `.env`. More in [Installation](#-installation).

> [!IMPORTANT]
> Without `SLICKSYNC_PRIVATE_USERNAME` / `SLICKSYNC_PRIVATE_PASSWORD` there's no login — anyone who can reach it can manage it. Only leave them out behind a login proxy (Authelia, Authentik, Cloudflare Access…).

**New here?** **`/guides`** has a page for every screen and setting, and `Ctrl+K` / `Cmd+K` answers questions from them.

---

<a name="-built-for-nuvio"></a>

<img src=".github/readme/nuvio.svg" alt="Built for Nuvio">

None of this exists in the Nuvio app itself.

| 🏠 Home screens | |
|:--|:--|
| **Collections editor** | Folders and sources, drag to reorder, preview before saving |
| **Templates** | Streaming Services and Genres, built from the account's own addons |
| **Cover art** | A URL, a GIF, or Nuvio's Community Covers |
| **Problem folders flagged** | A broken source, or an empty folder that never shows on the device |
| **Copy and share** | Between profiles, as a file, or as a share code |
| **Home rows** | Reorder, rename, hide; copy the whole layout to another profile |

| 🛡️ Guards | |
|:--|:--|
| **Collections and home-row guards** | Nuvio sync is last-write-wins; a sudden wipe alerts you, with one-click Restore |
| **Account Guard** | Addon changes made outside SlickSync, with Re-assert or Accept |

| 👥 Profiles and sign-in | |
|:--|:--|
| **Every profile tracked** | Separate one into its own person, Merge back, or Stop tracking |
| **Profiles with their own addons** | Managed as users of their own |
| **Sign-in** | QR / device code, or email and password |
| **Sign in a Nuvio TV** | Type in the code it shows |
| **Their servers in Nuvio** | Puts their Jellyfin, AIOStreams or AIOMetadata server into Nuvio for them |
| **Merge accounts** | A Nuvio and a Stremio account as one person, with undo |
| **Self-hosted backends** | Point an account at your own Nuvio server |

| ✨ SlickTrax rows | |
|:--|:--|
| **Continue Watching, Watchlist, For You** | Per person, installed as an addon — no Trakt needed |
| **Places itself** | Continue Watching slots in among the home rows |
| **Linked catalogs** | A folder that follows a SlickSync catalog |

| 🍥 Anime | |
|:--|:--|
| **Airing this season** | Next-episode countdowns and watch-order chains |
| **Absolute numbering** | Episode 137 resumes on the right season and episode |
| **List import** | From AniList or MyAnimeList |


<a name="-stremio-whats-new-since-syncio"></a>

<img src=".github/readme/stremio.svg" alt="Stremio">

Everything Syncio did, plus:

| 📺 What it adds | |
|:--|:--|
| **Watch tracking without Trakt** | Live Now Playing and full history: time watched, finished or dropped, rewatches |
| **Live pauses** | With SlickTrax on, play, pause and stop show the moment they happen |
| **SlickTrax rows** | Continue Watching, Watchlist and For You as a normal addon |
| **Patch Cinemeta** | Remove its search, catalogs or metadata per person; restore exactly |
| **Keys that follow the addons** | Rotate a key in the Vault and every account updates |
| **Account Guard** | Addon changes made outside SlickSync, with Re-assert or Accept |
| **QR sign-in and merge** | Sign in without a password; merge with a Nuvio account |

Everything under *Everything else* works for Stremio too.


<a name="-jellyfin-aiostreams-and-aiometadata"></a>

<img src=".github/readme/jellyfin.svg" alt="Jellyfin, AIOStreams, AIOMetadata">

Sign in with a password, PIN or Quick Connect code; SlickSync detects which server it is.

| ▶️ Watching | |
|:--|:--|
| **Now Playing** | Watch time from the server, with the device and app named |
| **Written back** | Watched marks, favourites and resume points |
| **AIOStreams watch history** | Viewing in its apps (Odin, Infuse, Swiftfin…) becomes history; watchlist and ratings go back |
| **Keep Jellyfin in step** | Titles finished or part-watched in other apps are marked there too |
| **Open in your own app** | AIOStreams, Swiftfin, Streamyfin, Infuse, or play on a device |

| 🏡 Households | |
|:--|:--|
| **Household users** | Become profiles — separate, merge back, stop tracking, set PINs |
| **New devices** | Sign one in with its Quick Connect code; see Devices and sign them out |
| **Invites** | Can create the Jellyfin account; switched off when someone leaves or expires |
| **Profile pictures** | Changed on either side, shown on both |

| 🖥️ Your Jellyfin server, for groups | |
|:--|:--|
| **Give it like an addon** | Addons → Add → Jellyfin server; everyone gets their own account |
| **Any Jellyfin app** | Leaving a group switches the account off, never deletes it |

| 🗂️ Collections | |
|:--|:--|
| **AIOStreams Collections** | Per account and per profile; search, drag, copy, share |
| **Jellyfin collections** | Catalogs kept in step on your server every 30 minutes |

| 🛡️ Guarded | |
|:--|:--|
| **Config alerts and history** | AIOStreams changes made elsewhere alert you; Put back restores an earlier one |
| **AIOStreams health** | Per person, with a test search |
| **Shared settings** | Two addons using one configuration are flagged |
| **Server versions** | Shown on Health, with update notices |


<a name="-aiosync"></a>

<img src=".github/readme/aiosync.svg" alt="AIOSync">

Stremio, Nuvio, Jellyfin, AIOStreams and AIOMetadata — in any direction.

| 🔁 What it does | |
|:--|:--|
| **Copy watch history** | Between sign-ins, profiles or people; preview first, undo for 7 days |
| **Nothing goes backwards** | Further-along titles stay put; nothing is removed |
| **Keep in step** | Finish something on one app, it shows on the others within minutes |
| **Per sign-in** | Sends and receives, only receives, or stays out |
| **Where** | Tasks → AIOSync, or on a person's page |


<a name="-everything-else"></a>

<img src=".github/readme/else.svg" alt="Everything else">

<details>
<summary><strong>🎬 Now Playing & Activity</strong></summary>

| Feature | What it does |
|:--|:--|
| **Now Playing** | Every provider, gone the moment playback stops; shared logins credited to the right person |
| **History and watch time** | What really played, finished or dropped, rewatches |
| **Activity** | One card per viewing, filters, right-click menu |
| **Continue Watching and Coming up** | Picture banners; aired episodes get an Out now tag with Play |
| **Graveyard** | Bury, dig up or wipe a title |
| **Watching Together** | An alert when someone gets ahead on a shared show |
| **Caught up to…** | Mark a show watched up to an episode, with undo |
| **Last seen and Dormant** | Spot who stopped watching; leave test people out of the numbers |

</details>

<details>
<summary><strong>⏱️ Limits</strong></summary>

| Feature | What it does |
|:--|:--|
| **Daily limit, Bedtime, Age limit** | For each person, profile or household user |
| **Pauses** | On every provider — instant, no app restart |
| **Held by Jellyfin** | Bedtime keeps working even while SlickSync is down |
| **Resume now** | Gives the rest of the day back |

</details>

<details>
<summary><strong>👤 Each person's own page</strong></summary>

| Feature | What it does |
|:--|:--|
| **Their own sign-in** | With their Stremio, Nuvio, Jellyfin or AIOStreams login |
| **Their own pages** | Home, Library, Activity with a This week panel, and Settings |
| **Their own phone** | Picture, Nuvio profile, history import and push notifications |

</details>

<details>
<summary><strong>🎞️ Discover</strong></summary>

| Feature | What it does |
|:--|:--|
| **One page of posters** | Titles, People, For you, Nobody's seen it, Watchlist |
| **Sort and filter** | Genre, decade, rating, length; Surprise me |
| **Describe it** | Find a title from a half-remembered plot |
| **People pages** | Every actor and director; Only what I haven't seen; Follow |
| **Title details** | Ratings, trailer, where to watch, More Like This, Finish the saga |
| **LumiereDB** | Optional: typo-proof search and IMDb's Trending |

</details>

<details>
<summary><strong>📚 Catalogs</strong></summary>

| Feature | What it does |
|:--|:--|
| **Build or import** | MDBList, TMDb, Trakt, AniList, MyAnimeList, SIMKL, share codes |
| **Describe it** | "90s horror" — review the suggestions first |
| **Smart Catalogs** | Criteria instead of a list, refreshed daily |
| **Keep and share** | Auto-refresh, export, publish to another household |
| **Kid-safe** | A content rating allowlist |

</details>

<details>
<summary><strong>✨ SlickTrax</strong></summary>

| Feature | What it does |
|:--|:--|
| **Watchlist** | Drag to rank; the device row follows |
| **For You and More Like This** | From real household viewing; Not interested tunes it |
| **Scrobble API** | Trakt-compatible, for Infuse or Kodi |
| **Import and export** | Letterboxd, IMDb, Trakt, Netflix, TV Time, Plex, Tautulli, Movary |
| **Rows per person** | Hide or reorder |

</details>

<details>
<summary><strong>🔐 Vault</strong></summary>

| Feature | What it does |
|:--|:--|
| **Every key and login** | Encrypted, with expiry alerts, costs and a spend forecast |
| **Real checks** | Real-Debrid, TorBox, Newznab, IPTV, Stremio, HTTP/TCP |
| **Backup keys and Key Pool** | Take over on failure; rotate across up to ten |
| **IPTV logins** | Test signs in and fills in the end date |
| **Debrid usage** | Live usage and auto-remove for old torrents |

</details>

<details>
<summary><strong>🧩 Addons</strong></summary>

| Feature | What it does |
|:--|:--|
| **Organise** | Drag to reorder, protect, tag, bulk actions |
| **Edit in place** | Change an addon's settings once; every user updates |
| **Health and backups** | Health checks, backup addons, optional proxy |
| **Templates** | Save a set, deploy it or share it as a code |

</details>

<details>
<summary><strong>🎨 Make it yours</strong></summary>

| Feature | What it does |
|:--|:--|
| **Arrange any page** | Move, fold, hide and stretch sections and cards; Undo and Reset |
| **Your own menu bar** | Order, More, hidden pages, one or two rows |
| **Page design** | Classic or v2; grid or list; density; start page |
| **Themes** | Ten built in or your own, synced across devices |
| **Share codes** | Catalogs, collections, templates and themes |

</details>

<details>
<summary><strong>🔔 Notifications</strong></summary>

| Feature | What it does |
|:--|:--|
| **Push and bell first** | Discord optional |
| **What you hear about** | Started watching, new episodes, sign-in problems, Vault, addons, backups, updates |
| **Less noise** | One alert per outage, digest mode, monthly recap |

</details>

<details>
<summary><strong>📱 App & speed</strong></summary>

| Feature | What it does |
|:--|:--|
| **Installs like an app** | Phones and desktops, with push and an icon badge |
| **Instant** | Opens at once; live updates without refreshing |
| **Posters** | Sized and cached on your own box |
| **Command palette** | Ctrl+K / Cmd+K jumps to anything, even a single setting |

</details>

<details>
<summary><strong>⚙️ Automation</strong></summary>

| Feature | What it does |
|:--|:--|
| **Rules on real events** | A watch, an addon going down, a key failover, a schedule |
| **Recipes** | One click; every rule reads as a sentence |

</details>

<details>
<summary><strong>📊 Metrics & health</strong></summary>

| Feature | What it does |
|:--|:--|
| **Metrics** | Leaderboards, streaks, trends, Taste Profiles, Year in Review |
| **Public stats page** | Optional, per person |
| **System Health** | Sync drift, addon uptime, key checks, servers up or down |

</details>

<details>
<summary><strong>💾 Backups</strong></summary>

| Feature | What it does |
|:--|:--|
| **Backups** | Config and full data, checked readable, optional encrypted off-site (S3, WebDAV) |
| **Restore** | Disaster Recovery Kit, Time Machine (whole or one person), 30-day Trash |
| **Move and update** | New server with one code; self-updates with automatic rollback |

</details>

<details>
<summary><strong>🛡️ Security</strong></summary>

| Feature | What it does |
|:--|:--|
| **Sign-in** | Passkeys, 2FA and OIDC/SSO, alongside the password |
| **Your own keys** | Each account's API keys come first; instance keys only as fallback |
| **Limits and checks** | Rate and upload limits; addresses checked before fetching |
| **Your data** | Self-service export and deletion; API docs at `/api/docs` |

</details>


<a name="-installation"></a>

<img src=".github/readme/install.svg" alt="Installation">

**Needs:** Docker Compose and a reverse proxy for HTTPS (Traefik, Caddy, nginx).

```bash
git clone https://github.com/slicknsliding/slicksync.git
cd slicksync
cp env.example .env
openssl rand -base64 32   # put this in .env as JWT_SECRET=
docker compose -f docker-compose.private.yml up -d
```

- Uses `ghcr.io/slicknsliding/slicksync:private` (also on Docker Hub). `:beta` is for testing only.
- Everything is on port `3000`. `ENCRYPTION_KEY` makes itself on first start.
- Open it once from the address your devices use, so SlickSync learns it (or set `PUBLIC_APP_URL`).

**Updating:** `docker compose -f docker-compose.private.yml pull && docker compose -f docker-compose.private.yml up -d` — `/app/data` is kept.

> [!WARNING]
> **Installed before 1.88.0?** Old compose files had no volume. Move your data first — see the [1.88.0 notes](https://github.com/slicknsliding/slicksync/releases/tag/v1.88.0).

<details>
<summary><strong>Public / multi-tenant mode</strong></summary>

| | Private (default) | Public |
|---|---|---|
| For | One household | Many separate groups |
| Database | SQLite | PostgreSQL |
| Accounts | One, no sign-up | Self-registered, kept apart |
| Image | `:private` | `:public` |

Set `JWT_SECRET`, `ENCRYPTION_KEY` (each `openssl rand -base64 32`) and `POSTGRES_PASSWORD` in `.env`, then:

```bash
docker compose -f docker-compose.public.yml up -d
```

`/register` gives each account a UUID login — save it, there's no recovery. `/superadmin` manages accounts with an audit log.
</details>

<details>
<summary><strong>Environment variables</strong></summary>

Everything has a default; see `env.example`. The ones you're likely to change:

| Variable | Purpose |
|---|---|
| `PUBLIC_APP_URL` | Address devices reach it on — only if it's never opened from there |
| `TRUST_CLOUDFLARE` | `true` only behind Cloudflare's proxy (orange cloud), so limits see real visitors |
| `ACCOUNT_TIMEZONE` | Default timezone (default `America/Los_Angeles`) |
| `LUMIERE_DB_URL` | A [LumiereDB](https://github.com/cedya77/aiometadata/blob/dev/docs/lumiere-db.md) to use (self-hosted only) |
| `OIDC_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI` | SSO sign-in (all four) |
| `SIMKL_CLIENT_ID` | Instance-wide SIMKL app |
| `NUVIO_SUPABASE_URL` / `_ANON_KEY` | Another Nuvio backend |
| `AIOSTREAMS_URL` / `_AUTH_USERNAME` / `_AUTH_PASSWORD` | Your AIOStreams, for proxy tracking |
| `AUTH_RATE_LIMIT_MAX_REQUESTS` | Sign-in rate limit (default 20 / 15 min) |
| `ADDON_HEALTH_CHECK_INTERVAL_MINUTES` | Addon checks (default 30) |
</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

- **Decryption errors after an update** — `data/server_secret.key` was lost or changed.
- **"credentials may be invalid" but history still updates** — run `node scripts/consolidate-encryption-keys.js` in the container (add `--apply --sync-keyfile` to fix).
- **SlickTrax missing on a device, or a pause needs an app restart** — open SlickSync from the address devices use, and let `/trax/` past any login gate.
- **Stream links or stats page ask for a login** — let `/stream/` and `/api/users/public-stats/` past the login gate.
- **Home-network server won't sign in on slicksync.vip** — shared instances can't reach private addresses; use a public one or self-host.
- **Jellyfin collections not renamed or no cover** — needs an administrator sign-in.
- **First-start database errors** — `/app/data` must be writable by `1001:1001`.
</details>

---

## Credits

- **[iamneur0](https://github.com/iamneur0)** — [Syncio](https://github.com/iamneur0/syncio) (MIT), the base of SlickSync.
- **[Avangelista](https://github.com/Avangelista)** — Nuvio integration concepts.
- **[Sonicx161](https://github.com/Sonicx161/AIOManager)** — AIOManager, inspiration for the Vault.
- **[0xConstant1](https://github.com/0xConstant1)** — LumiereDB; **[cedya77](https://github.com/cedya77/aiometadata)** — AIOMetadata.

Information courtesy of IMDb (https://www.imdb.com). Used with permission. This product uses the TMDB API but is not endorsed or certified by TMDB.

Original README: [`README.upstream.md`](./README.upstream.md).

## License

MIT — see [`LICENSE`](./LICENSE). Original work © iamneur0 (Syncio); Nuvio integration concepts © Avangelista; Vault design inspiration © Sonicx161 (AIOManager); modifications © slicknsliding (SlickSync).

---

<div align="center">

[🐛 Report a bug](https://github.com/slicknsliding/slicksync/issues/new?template=bug_report.yml) · [💡 Suggest an improvement](https://github.com/slicknsliding/slicksync/issues/new?template=feature_request.yml) · [❓ Ask a question](https://github.com/slicknsliding/slicksync/issues/new?template=question.yml) · [⬆️ Back to top](#slicksync)

</div>
