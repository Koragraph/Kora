#!/usr/bin/env bash
# Browser-preview dev server for apps/web: single-origin mode proxying the
# already-running kora daemon on :8797. Used by .claude/launch.json.
export PATH="$HOME/.nvm/versions/node/v24.11.1/bin:$PATH"
export KORA_SINGLE_ORIGIN_DEV=1
export KORA_PORT=8797
export PORT=5733
cd "$(dirname "$0")/../apps/web"
exec pnpm vp dev --port 5733
