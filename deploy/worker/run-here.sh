#!/usr/bin/env bash
# Run the worker on this machine (a Mac with Docker Desktop, or any Linux with Docker),
# with every repository command in a sandbox container. For the free beta: no server
# to pay for, and the worker runs while this machine is awake.
#
#   cp deploy/worker/worker.env.example deploy/worker/worker.env   # fill it in
#   deploy/worker/run-here.sh
#
# It reads only deploy/worker/worker.env, never the repository's .env, so no key
# meant for something else is picked up.
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v docker >/dev/null || { echo "Docker is not installed. On a Mac: brew install colima docker (or Docker Desktop)." >&2; exit 1; }
# Colima's daemon when it is running, without changing the docker CLI's default
# context for anything else on this machine.
if [ -z "${DOCKER_HOST:-}" ] && command -v colima >/dev/null && colima status >/dev/null 2>&1; then
  export DOCKER_HOST="$(docker context inspect colima --format '{{.Endpoints.docker.Host}}')"
fi
docker info >/dev/null 2>&1 || { echo "No Docker daemon is reachable. Start one (colima start --mount \"\$HOME/.pager:w\", or Docker Desktop) and try again." >&2; exit 1; }
[ -f deploy/worker/worker.env ] || { echo "Copy deploy/worker/worker.env.example to deploy/worker/worker.env and fill it in." >&2; exit 1; }

echo "building the sandbox image (first time: a few minutes)…"
docker build -q -f docker/sandbox.Dockerfile -t pager-sandbox:latest . >/dev/null
echo "building the worker…"
pnpm install --frozen-lockfile >/dev/null
pnpm -r --filter './packages/**' build >/dev/null

# Set here, so worker.env cannot switch the sandbox off.
export PAGER_SANDBOX_RUNNER=docker
export PAGER_SANDBOX_IMAGE=pager-sandbox:latest
# Under ~/.pager: a Docker VM (Colima, Docker Desktop) can bind-mount only the host
# paths it shares, and the OS temp directory is not one of them under Colima.
export PAGER_SANDBOX_ROOT="${PAGER_SANDBOX_ROOT:-$HOME/.pager/sandboxes}"
export PAGER_DEPENDENCY_CACHE="${PAGER_DEPENDENCY_CACHE:-$HOME/.pager/dependency-cache}"
mkdir -p "$PAGER_SANDBOX_ROOT" "$PAGER_DEPENDENCY_CACHE"

cd apps/worker
run=(node --env-file=../../deploy/worker/worker.env --experimental-strip-types src/main.ts)
# On a Mac, keep it from idle-sleeping while the worker runs (closing the lid still sleeps).
if command -v caffeinate >/dev/null; then exec caffeinate -i "${run[@]}"; else exec "${run[@]}"; fi
