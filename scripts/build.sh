#!/usr/bin/env bash
# Build everything: the runtime (tsc), the chat UI server bundle (into packages/runtime/ui), the web client and
# the Electron main/preload bundles. Usage: pnpm build   (or: bash scripts/build.sh [runtime|ui|web|desktop]…)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LOG="${TMPDIR:-/tmp}/kora-build"; mkdir -p "$LOG"
steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(runtime ui web desktop)

run() { # name, filter, task
  local name="$1" filter="$2" task="$3"
  printf '[build] %-8s … ' "$name"
  if ! pnpm vp run --filter "$filter" "$task" >"$LOG/$name.log" 2>&1; then
    echo "FAILED"; tail -30 "$LOG/$name.log"; exit 1
  fi
  # A stale filter makes pnpm print this, exit 0 and build nothing — never ship that silently.
  if /usr/bin/grep -q "No packages matched the filter" "$LOG/$name.log"; then echo "FAILED (no package matched $filter)"; exit 1; fi
  echo "ok"
}

for s in "${steps[@]}"; do
  case "$s" in
    runtime) run runtime @kora/runtime build ;;
    ui) run ui @kora/ui-server bundle ;;
    web) run web @kora/web build && node scripts/third-party-notices.mjs apps/web/dist/third-party-licenses.json >/dev/null ;;
    desktop) run desktop @kora/desktop build ;;
    *) echo "unknown step: $s"; exit 2 ;;
  esac
done
