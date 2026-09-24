# Docker

How the image is built and what runs inside it. For installing and updating,
follow the [README](./README.md#-installation) — this describes the machinery
behind it.

## One image, two processes

Frontend and backend are built into a single image and started together by
`scripts/start.sh`, which is PID 1 in the container.

```
container
├── Next.js frontend   :3000   ← the only port you need to expose
└── Express backend    :4000   ← internal; the frontend proxies /api to it
```

Both ports are declared, but only `3000` is worth publishing. Put a reverse
proxy in front of it for TLS; SlickSync does not terminate TLS itself.

Override with `FRONTEND_PORT` and `BACKEND_PORT` if either collides.

## Build stages

The Dockerfile is multi-stage, and the last stage deliberately does not
inherit the build's dependency tree.

| Stage | What it does |
|---|---|
| `base` | Bun on Alpine, plus openssl and curl |
| `deps` | Installs everything, including what is only needed to build |
| `prod-deps` | Installs runtime dependencies only |
| `builder` | Generates the Prisma client and builds the frontend |
| `production` | Copies the runtime tree from `prod-deps`, the built app and the generated Prisma client from `builder` |

That split is why the published image does not carry ESLint, nodemon or the
rest of the build tooling. Note that `prisma` itself is a runtime dependency,
not a build one: the start script applies the schema on every boot, so an
image without it would reach for the network at startup.

## Instance types

`INSTANCE` is a build argument, and the two published images differ by it.

| | `:private` | `:public` |
|---|---|---|
| Database | SQLite in `/app/data` | PostgreSQL, separate container |
| Accounts | one instance, no signup | self-registered, isolated per account |
| Schema applied by | `prisma db push` on boot | `migrate deploy`, then a guarded push |

`:beta` is the private image built from the beta branch. Use it only to test
something that has not shipped.

## Compose files

```
docker-compose.private.yml   # SQLite, single household
docker-compose.public.yml    # PostgreSQL, multi-tenant
docker-compose.beta.yml      # private, beta channel
```

Each reads `.env` (copy `env.example`) and refuses to start if a required
secret is missing, rather than falling back to a value everyone else also has.

## The data volume

Every one of those files mounts a volume at `/app/data`. That directory holds
the SQLite database on private instances, and on every instance it holds the
generated encryption key, Vault backups, avatars and the poster cache.

It has to outlive the container. `docker compose pull && docker compose up -d`
replaces the container, and without the volume it takes the encryption key
with it — which would leave every stored provider credential unreadable.

## Looking inside

```bash
docker compose -f docker-compose.private.yml logs -f
docker exec -it slicksync sh
docker exec slicksync sh -c 'echo $APP_VERSION'
```

The image declares a healthcheck against the frontend, so `docker ps` reports
health without you polling anything.

## Environment

Everything configurable is documented in `env.example`, which is the
authoritative list. Only `JWT_SECRET` is always required; in public mode
`ENCRYPTION_KEY` and `POSTGRES_PASSWORD` are as well. On a private instance an
encryption key generates itself on first boot and is kept in the data volume.
