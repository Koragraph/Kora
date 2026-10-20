#!/usr/bin/env bash
# install-app.sh — build the self-contained Kora Dev.app (scripts/package-app.sh) and install it on this Mac:
#   1. package → dist/Kora Dev.app (web client, desktop bundles, kora runtime + pinned node, all inside the bundle)
#   2. copy it to /Applications/Kora Dev.app (KORA_BUNDLE overrides)
#   3. run the bundle's kora-runtime.sh sync: copy the bundled runtime into ~/.kora-dev, link the kora-dev CLI, and
#      restart the daemon from the new copy if one was running (it stops through the socket, never by pattern)
#
# After this the checkout is not needed at runtime: Kora Dev.app starts its daemon itself.
#
# Two apps (developing Kora with Kora — see docs/DOGFOOD.md):
#   stable  Kora.app      never installed from a checkout: it is the published release and updates itself.
#   dev     Kora Dev.app  built from the dev worktree; its own home ~/.kora-dev, port :8790, CLI `kora-dev`.
#                         `pnpm app:install:dev` — quits Kora Dev if it is open, installs, reopens it.
# Usage: bash scripts/install-app.sh --flavor dev [--no-build]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\033[1mkora\033[0m %s\n' "$*"; }

FLAVOR=""
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --flavor) FLAVOR="$2"; PASS+=(--flavor "$2"); shift ;;
    *) PASS+=("$1") ;;
  esac
  shift
done

if [ "$FLAVOR" = dev ]; then
  APP_NAME="Kora Dev"; BUNDLE_ID="com.koraplex.kora.devapp"
else
  say "Kora is the published release only: it updates itself from github.com/agilkatakam/kora/releases."
  say "to try changes use Kora Dev (pnpm app:install:dev); to put them in Kora, ship them (pnpm ship)."
  exit 1
fi
BUNDLE="${KORA_BUNDLE:-/Applications/$APP_NAME.app}"

bash "$ROOT/scripts/package-app.sh" ${PASS[@]+"${PASS[@]}"}

# lsappinfo, not ps: /bin/ps is setuid and Seatbelt refuses setuid execs, so ps fails inside a Kora agent session
# (os-sandbox.ts fences the Claude lane).
running="$(lsappinfo info -only pid -app "$BUNDLE_ID" 2>/dev/null | sed -n 's/^"pid"=\([0-9][0-9]*\)$/\1/p')"
reopen=0
if [ -n "$running" ]; then
  say "quitting $APP_NAME (pid $running) to replace it"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do kill -0 "$running" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$running" 2>/dev/null && { say "$APP_NAME did not quit — close it and re-run with --no-build"; exit 1; }
  reopen=1
fi

say "installing $BUNDLE"
rm -rf "$BUNDLE"
ditto "$ROOT/dist/$APP_NAME.app" "$BUNDLE"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$BUNDLE" \
  >/dev/null 2>&1 || true

# First Kora Dev install: start from the stable app's preferences (not its chats, worktrees or graph) and share its
# downloaded OpenCode binary.
if [ ! -d "$HOME/.kora-dev" ]; then
  say "first Kora Dev install: seeding ~/.kora-dev with your Kora preferences"
  mkdir -p "$HOME/.kora-dev/userdata" "$HOME/.kora-dev/tools"
  if [ -f "$HOME/.kora/config.json" ]; then cp "$HOME/.kora/config.json" "$HOME/.kora-dev/config.json"; fi
  for f in client-prefs.json shell-prefs.json client-settings.json desktop-settings.json settings.json; do
    if [ -f "$HOME/.kora/userdata/$f" ]; then cp "$HOME/.kora/userdata/$f" "$HOME/.kora-dev/userdata/$f"; fi
  done
  if [ -e "$HOME/.kora/tools/opencode" ]; then ln -s "$HOME/.kora/tools/opencode" "$HOME/.kora-dev/tools/opencode"; fi
fi

# A clean env: this often runs from a shell inside a Kora agent session, whose KORA_SOCKET_PATH / KORA_HOME point at
# the daemon driving that session — the sync must only ever touch this flavor's own daemon.
env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" TMPDIR="${TMPDIR:-/tmp}" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  /bin/sh "$BUNDLE/Contents/Resources/kora-runtime.sh" sync
if [ "$reopen" = 1 ]; then open "$BUNDLE"; say "reopened $APP_NAME"; else say "done — open -a \"$APP_NAME\""; fi
