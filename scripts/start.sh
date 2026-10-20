#!/usr/bin/env bash
# start.sh — run the desktop app from this checkout's current build (pnpm build first): make sure the kora daemon
# is up (~/.kora/app, or KORA_APP=packages/runtime to run the workspace build), then launch Electron through
# apps/desktop/scripts/start.mjs. `pnpm dev` is the same with a hot-reloading web client.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sh "$ROOT/scripts/ensure-kora-server.sh"
cd "$ROOT/apps/desktop"
export KORA_PORT="${KORA_UI_PORT:-8797}"
exec node scripts/start.mjs "$@"
