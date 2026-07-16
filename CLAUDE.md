# SlickSync

SlickSync is a private fork of [Syncio](https://github.com/slicknsliding/slicksync) — a Stremio addon and user
management system. This fork adds:

- A **Nuvio** provider alongside the original Stremio provider (auth, connect, OAuth flows).
- A credential **Vault** for storing/managing account secrets.
- A custom **Slick** theme and full rebrand (logo, badges, UI polish) on top of upstream Syncio.

Repo: `github.com/slicknsliding/slicksync` (private).

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
Dockerfile               Multi-stage build; ARG INSTANCE=private|public selects the Prisma schema at build time
docker-compose.private.yml / docker-compose.public.yml   Local/dev compose files for each mode
src/index.ts             Unused stub (empty export)
*.patch, fix_*.py, patch_*.py at repo root   Ad-hoc historical patches/scripts from past fixes, not part of the build
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
| `/api/aiometadata` | `aiometadata.js` | AIOMetadata addon integration |
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
