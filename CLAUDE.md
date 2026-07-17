# SlickSync

SlickSync is a fork of [Syncio](https://github.com/iamneur0/syncio) by **neur0** — a Stremio addon and user
management system. (Additional feature ideas credited to [AIOManager](https://github.com/Sonicx161/AIOManager) by
**Sonicx161**.) This fork adds:

- A **Nuvio** provider alongside the original Stremio provider (auth, connect, OAuth flows).
- A credential **Vault** for storing/managing account secrets.
- Live **Now Playing** + watch history via an AIOStreams proxy integration (see Watch tracking below).
- A custom **Slick** theme and full rebrand (logo, badges, UI polish) on top of upstream Syncio.

Repo: `github.com/slicknsliding/slicksync` — **public**. Never commit real credentials, personal emails,
private hostnames, or instance UUIDs — including in code comments, example values, test fixtures, or one-off
scripts. (An `archive/` folder of dead patch scripts was removed for exactly this: it leaked an email and an
instance UUID.) Use placeholders like `someuser@example.com` / `example.com` in comments and tests.
Runtime config comes from env vars — see the compose file, not the repo.

Upstream docs preserved for reference: [README.upstream.md](README.upstream.md), [API.md](API.md), [DOCKER.md](DOCKER.md).

## Deploy flow

1. Edit code locally on Windows (this checkout).
2. Commit and push to GitHub (`origin` = `github.com/slicknsliding/slicksync.git`).
3. On the VPS, in `/opt/docker/build/slicksync`:
   ```
   git pull
   docker compose --profile slicksync up -d --build
   ```

There is no separate migration step to run by hand — see below.

Note: `docker-compose.private.yml` / `docker-compose.public.yml` in this repo (see Directory structure below) are
repo-local files for building/running standalone (`docker compose -f docker-compose.private.yml up -d --build`,
per [README.md](README.md)) — neither defines a `slicksync` profile. The actual VPS deploy command above targets a
host-level compose file that lives outside this repo (elsewhere under `/opt/docker/`, likely orchestrating several
apps), which gates this service behind a `slicksync` profile. If the VPS deploy command ever needs to change,
check that host-level file, not the compose files checked into this repo.

## Watch tracking: two signals, one job each

Now Playing / History / Watch Time are fed by **two independent pipelines**. Which one owns what is not arbitrary —
each was chosen because the other physically cannot do that job. Changing this split has repeatedly reintroduced
old bugs, so read this before touching it.

| Signal | Source | Owns | Why not the other |
|---|---|---|---|
| **Proxy** (`proxyStreamMonitor.js`) | Polls AIOStreams' built-in proxy stats every 30s | **Live presence only**: Now Playing + the instant "started watching" Discord notification | It sees streams open/close in real time, but is blind to anything routed outside the proxy (e.g. usenet via newznab) |
| **Native** (`sessionTracker.js`, `metricsProcessor.js`) | Polls the provider's own library/watch state every 1m | **The record**: History, duration, Watch Time — for *every* source, usenet included | The provider only checkpoints at pause/stop, so it learns of a session late and then holds it "active" for ~15min — useless as a liveness signal |

Rules that keep falling out of this, each fixing a real reported bug:

- **The proxy must never write watch history or durations.** A proxy connection's wall-clock lifetime is not watch
  time (AIOStreams keeps stale connections alive for hours; a 5-minute view once recorded as 22h, then accumulated
  across replays and inflated Watch Time Today to 54h). Native's `overallTimeWatched` deltas are the only real
  duration source.
- **Native must never be the sole basis for Now Playing.** Its freshness window kept an already-exited stream
  showing as playing for ~15 minutes.
- **`mergeProxyNowPlaying` reconciles them per-title, not per-user.** The proxy is authoritative only for content it
  actually carries: it replaces native's entry for a title it's carrying, and suppresses native's *stale echo* of a
  title it recently finished. A title the proxy never carried (usenet) is left alone — native is the only truth for
  it. Suppressing per-user instead blanks out unrelated usenet playback.
- **Duration merges take `max()`, not `sum()`.** Both pipelines observe the *same* minutes; summing double-counted.
- **Recording a delta and advancing the snapshot baseline must be one transaction** — a restart between them made
  the next poll re-record the identical delta.
- **Day bucketing goes through `dateUtils.js`**, never `toISOString()` (which is always UTC). See Timezone below.

## Timezone

Background pollers have no request context to infer a viewer's timezone from, so "today" is an explicit setting:
`AppAccount.sync.accountTimezone` (Settings → Privacy & Display), read via `resolveAccountTimezone()` in
[server/utils/dateUtils.js](server/utils/dateUtils.js), defaulting to `ACCOUNT_TIMEZONE` env / `America/Los_Angeles`.
Anything deciding what day something happened must use `getAccountDateString()`.

## Notifications

One Discord webhook, configured once in Settings → Notifications, with per-type toggles on `AppAccount.sync`:
`notifyOnActivity` / `notifyOnSync` / `notifyOnInvite` / `notifyOnVault`. Vault alerts ride the same webhook
(`vaultMonitor.js`) — there is deliberately no separate Vault notification config. The "started watching"
notification fires from the **proxy** (instant); the native pipeline must not also send it (it fired at stop time,
which read as an end-of-watch notification).

## Posters

- Native/library items: the provider's own poster, with a Cinemeta-by-ID backfill (`libraryHelpers.js`).
- Proxy-detected items (filename-parsed title only): **strict** Cinemeta title search —
  `searchCinemetaPosterByTitle()` returns a poster *only* on an exact normalized-title match, plus an exact year
  match when the filename carries a year. No confident match ⇒ no poster, never a guessed one. A previous fuzzy
  lookup (the removed AIOMetadata integration) routinely picked the wrong same-titled film.

## Database: SQLite in "private" instance mode

- This deployment always runs with `INSTANCE=private`, using SQLite. The Postgres schema
  (`prisma/schema.postgres.prisma`) exists for the upstream "public" multi-tenant mode but is not used here.
- Active schema: [prisma/schema.sqlite.prisma](prisma/schema.sqlite.prisma). The Dockerfile copies whichever
  schema matches `INSTANCE` to `prisma/schema.prisma` at build time.
- **Schema changes require an image rebuild, not a manual migration.** [scripts/start.sh](scripts/start.sh) runs
  automatically on container boot and does `bunx prisma db push --schema ... --accept-data-loss` (skipping
  `migrate deploy`, which is Postgres-only). So: edit the sqlite schema, commit, push, `git pull` + rebuild on the
  VPS, and `db push` applies it on startup.
- DB file lives at `/app/data/sqlite.db` inside the container (mounted volume in the VPS compose file).

## Directory structure

```
server/                  Express backend (entry: server/index.js)
  routes/                One router per API area (see below)
  providers/              stremio.js, stremioAuth.js, nuvio.js, nuvioAuth.js, supabase.js, index.js
  middleware/             auth.js, accountScoping.js, errorHandler.js, userApiKey.js, validation.js
  utils/                  helpers/, handlers/, shared utility modules
client/                  Next.js frontend (App Router)
  app/(admin)/           Authenticated admin UI — see routes below
  app/(public)/          login/, invite/ — unauthenticated pages
  app/(user)/            user/ — end-user self-service pages
  components/            admin/, invite/, layout/, modals/, providers/, ui/, user/
  lib/                   hooks/, shared client-side utilities
prisma/
  schema.sqlite.prisma   Active schema for this (private) deployment
  schema.postgres.prisma Upstream "public" mode schema, unused here
  migrations/            Postgres migration history (not used for the private/SQLite path)
scripts/start.sh         Container entrypoint: picks schema by INSTANCE, runs db push, starts backend + frontend
scripts/debug-*.js       Read-only diagnostics (AIOStreams proxy stats, captured proxy sessions, watch-time rows)
scripts/*fix*|reconcile* One-off maintenance, run via `docker exec`. Dry-run by default; pass --apply to write.
                         They need DATABASE_URL passed explicitly:
                         docker exec -it -e DATABASE_URL="file:///app/data/sqlite.db" slicksync node scripts/<name>.js
Dockerfile               Multi-stage build; ARG INSTANCE=private|public selects the Prisma schema at build time
docker-compose.private.yml / docker-compose.public.yml   Standalone compose files for each mode (not what the VPS uses — see Deploy flow note above)
src/index.ts             Unused stub (empty export)
test/                    node:test regression tests (node --test test/) - not exhaustive, covers the most-patched-over-time logic
```

## Server routes (`server/routes/`, mounted in `server/index.js`)

| Mount path | File | Purpose |
|---|---|---|
| `/api/auth`, `/api/public-auth` | `publicAuth.js` | Login/auth for public instance mode |
| `/api/addons` | `addons.js` | Addon CRUD, manifest handling |
| `/api/groups` | `groups.js` | User groups |
| `/api/users` | `users.js` | Managed Stremio users |
| `/api/stremio` | `stremio.js` | Stremio provider integration |
| `/api/nuvio` | `nuvio.js` | Nuvio provider integration (auth/connect/OAuth; rate-limited) |
| `/api/snapshots` | `snapshots.js` | Library/addon snapshots |
| `/api/avatars` | `avatars.js` | Avatar upload/serving |
| `/api/vault` | `vault.js` | Credential vault |
| `/api/settings` | `settings.js` | Instance/account settings |
| `/api/ext` | `externalApi.js` | External API surface |
| `/api/invitations`, `/invite` | `invitations.js` | Invitations (authenticated admin + public accept flow) |
| `/api/public-library` | `publicLibrary.js` | Public-mode library reads |
| `/proxy` | `proxy.js`, `streamProxy.js` | Stream/manifest proxying |
| — | `activity.js`, `debug.js` | Activity feed, debug endpoints |

`accountScopingMiddleware` wraps groups/users/addons/stremio/nuvio/snapshots/vault so multi-account data stays scoped.

## Client routes (`client/app/(admin)/`)

Each folder is a Next.js route segment with its own `layout.tsx` + `page.tsx`:

- `activity/` — activity feed
- `addons/` (+ `[id]`) — addon list and detail/edit
- `changelog/` — release changelog viewer
- `groups/` (+ `[id]`) — group list and detail
- `invitations/` (+ `[id]`) — invitation list and detail
- `metrics/` — dashboard metrics
- `settings/` — instance/account settings
- `tasks/` — task/export tooling
- `users/` (+ `[id]`) — user list and detail
- `vault/` — credential vault UI

Other top-level route groups: `app/(public)/` (login, invite acceptance — no auth required), `app/(user)/user/`
(end-user self-service pages).
