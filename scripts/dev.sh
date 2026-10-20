#!/usr/bin/env bash
# dev.sh — the desktop app in development: the web client from Vite (hot reload) on :5733 and the Electron main
# process rebuilt on change, both attached to the kora daemon on :8797 (started if down; see ensure-kora-server.sh).
# Daemon-side changes (packages/runtime, packages/ui-server) need `pnpm build` + a daemon restart
# (`kora server stop`, then re-run this).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export KORA_APP="${KORA_APP:-$ROOT/packages/runtime}"
sh "$ROOT/scripts/ensure-kora-server.sh"
export KORA_PORT="${KORA_UI_PORT:-8797}"
export PORT="${KORA_WEB_PORT:-5733}"
export VITE_DEV_SERVER_URL="http://127.0.0.1:$PORT"
cd "$ROOT"
exec pnpm vp run --filter @kora/web --filter @kora/desktop --parallel dev
