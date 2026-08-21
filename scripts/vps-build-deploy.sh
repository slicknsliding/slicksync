#!/usr/bin/env bash
#
# Fallback release path: build the image on the VPS itself and deploy it,
# for when GitHub Actions can't produce one.
#
# On 2026-08-21 the release workflows wedged on the "Build and push Docker
# image" step and sat there for seven hours - runs that normally finish in
# 14-20 minutes - which left every instance stuck on the previous release
# with no way to ship. This is the way out of that: it needs nothing from
# Actions, nothing from GHCR, and no registry credentials.
#
# It builds for the host's own architecture only. That is deliberate and is
# also why it's fast: the CI images are linux/amd64 + linux/arm64, and the
# arm64 half runs under QEMU emulation. Every SlickSync host is amd64, so
# emulating a second architecture here would buy nothing.
#
# The image is tagged with exactly the name the compose file already refers
# to (ghcr.io/slicknsliding/slicksync:<tag>), so compose picks up the local
# build with no edits. Nothing is pushed anywhere. Deliberately never runs
# `docker compose pull` - that would replace the freshly built image with
# whatever stale thing is still in the registry, which is the one mistake
# that would make this script actively harmful.
#
# Usage:
#   ./vps-build-deploy.sh <git-ref> <instance> <compose-dir> [compose-file] [service]
#
# Examples (run ON the target VPS):
#   ./vps-build-deploy.sh v1.74.5 public  /opt/slicksync docker-compose.yml
#   ./vps-build-deploy.sh v1.74.5 private /opt/docker    compose.yaml
#
# `sudo` in front if that host's compose needs it to read its .env.

set -euo pipefail

REF="${1:?usage: vps-build-deploy.sh <git-ref> <instance:public|private|beta> <compose-dir> [compose-file] [service]}"
INSTANCE_ARG="${2:?missing instance (public|private|beta)}"
COMPOSE_DIR="${3:?missing compose dir}"
COMPOSE_FILE="${4:-docker-compose.yml}"
SERVICE="${5:-slicksync}"

REPO_URL="${REPO_URL:-https://github.com/slicknsliding/slicksync.git}"
SRC_DIR="${SRC_DIR:-/opt/slicksync-build-src}"
IMAGE="${IMAGE:-ghcr.io/slicknsliding/slicksync}"

# Image tag, and the INSTANCE build-arg. These MUST match the workflows:
# beta and private are both built with INSTANCE=private and differ only in
# the tag they publish under - getting this wrong produces an image that
# boots in the wrong mode.
case "$INSTANCE_ARG" in
  public)  TAG=public;  BUILD_INSTANCE=public  ;;
  private) TAG=private; BUILD_INSTANCE=private ;;
  beta)    TAG=beta;    BUILD_INSTANCE=private ;;
  *) echo "!! unknown instance '$INSTANCE_ARG' (expected public|private|beta)" >&2; exit 2 ;;
esac

say() { echo ""; echo "==> $*"; }

say "Fetching $REF into $SRC_DIR"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch --all --tags --prune
else
  git clone "$REPO_URL" "$SRC_DIR"
  git -C "$SRC_DIR" fetch --tags
fi
git -C "$SRC_DIR" checkout --force "$REF"
git -C "$SRC_DIR" reset --hard "$REF"
echo "    at: $(git -C "$SRC_DIR" log -1 --oneline)"

# The version baked into the image, surfaced by Metrics -> Health and by
# `docker exec <container> sh -c 'echo $APP_VERSION'`. CI passes the tag
# name, so pass the same thing here or the running app will misreport which
# release it is.
APP_VERSION="$REF"

say "Building $IMAGE:$TAG  (INSTANCE=$BUILD_INSTANCE, APP_VERSION=$APP_VERSION, $(uname -m) only)"
docker build \
  --build-arg "INSTANCE=$BUILD_INSTANCE" \
  --build-arg "APP_VERSION=$APP_VERSION" \
  -t "$IMAGE:$TAG" \
  "$SRC_DIR"

say "Restarting $SERVICE from $COMPOSE_DIR/$COMPOSE_FILE"
cd "$COMPOSE_DIR"
docker compose -f "$COMPOSE_FILE" up -d --no-deps "$SERVICE"

say "Waiting for health"
CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE")"
for _ in $(seq 1 30); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo none)"
  [ "$state" = "healthy" ] && break
  # A container with no healthcheck reports 'none' - fall back to running.
  if [ "$state" = "none" ] && [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = "true" ]; then
    break
  fi
  sleep 5
done

echo ""
docker ps --format '{{.Names}} :: {{.Status}}' | grep -F "$(docker inspect -f '{{.Name}}' "$CONTAINER" | sed 's|^/||')" || true
echo "    version: $(docker exec "$CONTAINER" sh -c 'grep -m1 version /app/package.json' 2>/dev/null || echo unknown)"
echo "    health:  $(docker exec "$CONTAINER" sh -c 'curl -s http://localhost:3000/api/health' 2>/dev/null | head -c 60 || echo unreachable)"

say "Recent errors (empty is good)"
docker logs "$CONTAINER" --since 3m 2>&1 | grep -iE 'error|fatal' | head -5 || true

say "Done - $IMAGE:$TAG built locally and running. Nothing was pushed."
echo "    When Actions recovers, a normal 'docker compose pull && up -d' will"
echo "    replace this with the registry image for the same release."
