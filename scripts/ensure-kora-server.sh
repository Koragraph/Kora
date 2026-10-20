#!/bin/sh
# ensure-kora-server.sh — make sure the ONE backend is up: `kora server` (the installed copy in ~/.kora/app), which
# serves the unix socket (~/.kora/kora.sock: CLI, hooks, orchestrator workers) AND the chat UI's API on
# http://127.0.0.1:$KORA_UI_PORT (default 8797: `/ws` RPC + `/api/*`). The desktop app only attaches to that port.
#
# Used by `pnpm start`, `pnpm dev` and the /Applications/Kora.app launcher. POSIX sh (the launcher runs it from Finder
# with a minimal PATH). Exit 0 once the UI port answers; non-zero with a reason otherwise. Never kills a process: a
# running kora server without the UI (uiPort=0) is reported, not killed.
#   KORA_APP=<dir>  run the runtime from <dir> instead of ~/.kora/app (e.g. packages/runtime of a checkout)
set -u

PORT="${KORA_UI_PORT:-8797}"
APP="${KORA_APP:-$HOME/.kora/app}"
KORA_JS="$APP/bin/kora.js"
say() { printf '\033[36m[kora-server]\033[0m %s\n' "$*"; }

[ -f "$KORA_JS" ] || { say "no kora runtime at $APP (install Kora from github.com/agilkatakam/kora/releases)"; exit 1; }

# The runtime's native modules (better-sqlite3, node-pty) are built for the node that installed them: pick the first
# candidate that can actually load them, instead of whatever node happens to be first on PATH.
NODE_BIN="${KORA_NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME"/.nvm/versions/node/v24*/bin/node "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    if (cd "$APP" && "$c" -e "require('better-sqlite3'); require('node-pty')") >/dev/null 2>&1; then NODE_BIN="$c"; break; fi
  done
fi
[ -n "$NODE_BIN" ] || { say "no node on this machine can load $APP's native modules (reinstall Kora)"; exit 1; }

ui_up() { curl -fsS -m 2 "http://127.0.0.1:$PORT/.well-known/kora/host" >/dev/null 2>&1; }
server_json() { "$NODE_BIN" "$KORA_JS" server status --json 2>/dev/null; }

if ! "$NODE_BIN" "$KORA_JS" server status >/dev/null 2>&1; then
  holder="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$holder" ]; then
    say "port $PORT is held by pid $holder ($(ps -o command= -p "$holder" | cut -c1-80)) — stop it first"; exit 1
  fi
  say "starting kora server ($NODE_BIN $KORA_JS)"
  # env -u: a server started from inside an agent session must not carry that session's markers.
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SSE_PORT KORA_UI_PORT="$PORT" \
    "$NODE_BIN" "$KORA_JS" server start >/dev/null || { say "kora server failed to start (see ~/.kora/server.log)"; exit 1; }
fi

i=0
while [ $i -lt 40 ]; do
  # the UI must be served BY the kora server (server.status reports it), not by some other process on the port
  if server_json | /usr/bin/grep -q '"url"' && ui_up; then say "ready: socket ~/.kora/kora.sock + chat UI http://127.0.0.1:$PORT"; exit 0; fi
  i=$((i + 1)); sleep 0.5
done
if server_json | /usr/bin/grep -Eq '"ui": ?null'; then
  say "kora server is running WITHOUT the chat UI (uiPort=0 or no ui bundle). Restart it:"
  say "  kora server stop, then open Kora again"
else
  say "chat UI did not come up on :$PORT within 20s (see ~/.kora/server.log)"
fi
exit 1
