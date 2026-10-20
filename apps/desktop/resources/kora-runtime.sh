#!/bin/sh
# kora-runtime.sh — shipped inside Kora.app as Contents/Resources/kora-runtime.sh, next to Contents/Resources/runtime
# (the kora daemon + CLI + hooks + koragraph engine + a pinned node binary). It keeps this machine's kora runtime in
# step with the app and makes sure the daemon is up.
#
#   kora-runtime.sh ensure   sync ~/.kora/app when this bundle's runtime differs from it (stopping and restarting a
#                            running daemon), link the CLI, start the daemon when it is down, wait for the chat UI port.
#                            The Electron main process runs this on every launch.
#   kora-runtime.sh sync     only the sync half; restarts the daemon only if it was running (used by install-app.sh).
#
# Why a copy in ~/.kora/app and not the bundle itself: hooks written into repos, the `kora` CLI shim and the
# orchestrator's agent shims bake ABSOLUTE paths to node and bin/kora.js. ~/.kora/app/… survives the app being moved,
# renamed, replaced or App-Translocated, and replacing Kora.app never pulls files out from under a running daemon.
#
# Integrity: the copy is user-writable, the bundle is not (code signature + macOS App Management). Before every daemon
# start the copy is checked against runtime-manifest.json — generated at package time and sealed inside the signed
# bundle — by kora-runtime-manifest.cjs running under the BUNDLE's node. Any difference (edited/added code, retargeted
# symlink, swapped binary) and the copy is replaced from the bundle before the daemon runs. Bundles without a
# manifest (checkout builds older than this) skip the check.
#
# POSIX sh: it runs from a Finder-launched app with a minimal environment. It never kills a process by pattern — the
# daemon is stopped through its socket (`kora server stop`).
set -u

RES="$(cd "$(dirname "$0")" && pwd -P)"
SRC="$RES/runtime"
# A flavored bundle ("Kora Dev", package-app.sh --flavor dev) ships flavor.env: its own home, port and CLI name, so it
# runs beside the stable Kora with nothing shared. The flavor always wins over inherited KORA_* (this script may run
# from a shell inside a stable-Kora agent session, whose KORA_SOCKET_PATH points at the stable daemon).
KORA_APP_FLAVOR=""
if [ -f "$RES/flavor.env" ]; then
  . "$RES/flavor.env"
  unset KORA_ENV KORA_PANE_ID KORA_BIN
  KORA_HOME="$HOME/$KORA_HOME_NAME"
  KORA_SOCKET_PATH="$KORA_HOME/kora.sock"
  KORA_UI_PORT="$KORA_PORT"
  KORAGRAPH_HOME="$KORA_HOME/koragraph"
  KORAGRAPH_DB="$KORAGRAPH_HOME/graph.db"
  KORAGRAPH_PRACTICE_DB="$KORAGRAPH_HOME/practice.db"
  export KORA_HOME KORA_SOCKET_PATH KORA_UI_PORT KORAGRAPH_HOME KORAGRAPH_DB KORAGRAPH_PRACTICE_DB
  # The flavor's Blobs folder (flavor.env sets it unexported): the daemon also derives it from the home name.
  [ -n "${KORA_BLOBS_ROOT:-}" ] && export KORA_BLOBS_ROOT
  mkdir -p "$KORAGRAPH_HOME"
fi
KHOME="${KORA_HOME:-$HOME/.kora}"
DST="$KHOME/app"
PORT="${KORA_UI_PORT:-8797}"
BIN_DIR="${KORA_BIN_DIR:-$HOME/.local/bin}"
CLI_NAME="${KORA_CLI_NAME:-kora}"
MODE="${1:-ensure}"

say() { printf '[kora-runtime %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { say "$*"; exit 1; }

[ -x "$SRC/bin/node" ] && [ -f "$SRC/bin/kora.js" ] || die "no bundled runtime at $SRC"
mkdir -p "$KHOME"
cd "$HOME" || cd /

# A daemon started from inside an agent session (or from Electron) must not inherit that session's markers.
clean_env() {
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SSE_PORT -u ELECTRON_RUN_AS_NODE \
    -u ELECTRON_NO_ATTACH_CONSOLE -u NODE_OPTIONS KORA_UI_PORT="$PORT" "$@"
}
kora() { clean_env "$DST/bin/node" "$DST/bin/kora.js" "$@"; }
running() { [ -x "$DST/bin/node" ] && kora server status >/dev/null 2>&1; }
# Stopping only needs the socket protocol, so the bundled node + CLI can stop a daemon an older install started.
stop_daemon() {
  clean_env "$SRC/bin/node" "$SRC/bin/kora.js" server stop >/dev/null 2>&1 || true
  i=0
  while [ $i -lt 40 ] && curl -fsS -m 1 "http://127.0.0.1:$PORT/.well-known/kora/host" >/dev/null 2>&1; do
    i=$((i + 1)); sleep 0.25
  done
}
ui_up() { curl -fsS -m 2 "http://127.0.0.1:$PORT/.well-known/kora/host" >/dev/null 2>&1; }

build_id() { cat "$1/BUILD_ID" 2>/dev/null || echo none; }

MANIFEST="$RES/runtime-manifest.json"
VERIFIER="$RES/kora-runtime-manifest.cjs"
# 0 = the copy matches the signed bundle (or this bundle predates manifests); 1 = it does not.
verify_copy() {
  [ -f "$MANIFEST" ] && [ -f "$VERIFIER" ] || return 0
  [ -d "$DST" ] || return 1
  report="$(clean_env "$SRC/bin/node" "$VERIFIER" verify "$DST" "$MANIFEST" "$SRC" 2>&1)" && return 0
  say "${report:-runtime copy verification failed}"
  return 1
}

# A crashed earlier run may have left the live copy moved aside: put it back before anything else.
recover_swap() {
  if [ ! -d "$DST" ] && [ -d "$DST.old" ]; then say "restoring the runtime from an interrupted update"; mv "$DST.old" "$DST"; fi
}

# One ensure/sync at a time per home (an app relaunched while another run was copying raced and left ~/.kora/app
# empty, 2026-10-14). mkdir is atomic; a lock whose pid is gone is stale.
LOCK="$KHOME/runtime.lock"
acquire_lock() {
  n=0
  while ! mkdir "$LOCK" 2>/dev/null; do
    holder="$(cat "$LOCK/pid" 2>/dev/null)"
    if [ -n "$holder" ]; then
      kill -0 "$holder" 2>/dev/null || { say "breaking a stale lock (pid $holder is gone)"; mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null && rm -rf "$LOCK.stale.$$"; continue; }
    elif [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null && rm -rf "$LOCK.stale.$$"; continue
    fi
    n=$((n + 1)); [ $n -gt "${KORA_LOCK_WAIT_HALFSEC:-360}" ] && die "another kora-runtime run (pid ${holder:-?}) holds $LOCK"
    sleep 0.5
  done
  printf '%s\n' "$$" >"$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
  trap 'rm -rf "$LOCK"; exit 1' INT TERM HUP
}

# ---- a daemon that is up but not answering (2026-10-14: a graph query pinned its main thread for an hour; the app waited
# on it forever). Only an exact pid is ever signalled: <KORA_HOME>/daemon.pid, else the listener on our UI port, and only
# when that process's command line is a `server run` daemon.
daemon_pid() {
  p="$(cat "$KHOME/daemon.pid" 2>/dev/null)"
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && ps -o command= -p "$p" 2>/dev/null | /usr/bin/grep -q 'server run'; then printf '%s\n' "$p"; return 0; fi
  p="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$p" ] && ps -o command= -p "$p" 2>/dev/null | /usr/bin/grep -q 'server run'; then printf '%s\n' "$p"; return 0; fi
  return 1
}
# Seconds the process has been running (ps etime is [[dd-]hh:]mm:ss).
proc_age_sec() {
  ps -o etime= -p "$1" 2>/dev/null | awk '{ n = split($1, t, /[-:]/); if (n == 4) print t[1]*86400 + t[2]*3600 + t[3]*60 + t[4]; else if (n == 3) print t[1]*3600 + t[2]*60 + t[3]; else if (n == 2) print t[1]*60 + t[2]; else print 0 }' | { read -r v; echo "${v:-0}"; }
}
ui_answers() {
  i=0
  while [ $i -lt "${KORA_HEALTH_TRIES:-3}" ]; do
    curl -fsS -m "${KORA_HEALTH_TIMEOUT:-5}" "http://127.0.0.1:$PORT/.well-known/kora/host" >/dev/null 2>&1 && return 0
    i=$((i + 1)); [ $i -lt "${KORA_HEALTH_TRIES:-3}" ] && sleep 1
  done
  return 1
}
# Stop a daemon whose UI port stays silent (a few checks of KORA_HEALTH_TIMEOUT seconds each). A daemon younger than
# KORA_UNRESPONSIVE_MIN_AGE_SEC (default 120) is still starting: left alone.
recover_unresponsive() {
  pid="$(daemon_pid)" || return 0
  ui_answers && return 0
  age="$(proc_age_sec "$pid")"
  if [ "$age" -lt "${KORA_UNRESPONSIVE_MIN_AGE_SEC:-120}" ]; then say "the daemon (pid $pid, ${age}s old) is not answering yet; it is still starting"; return 0; fi
  say "the kora daemon (pid $pid) is up but not answering on :$PORT; restarting it"
  kill -TERM "$pid" 2>/dev/null
  i=0; while [ $i -lt 20 ] && kill -0 "$pid" 2>/dev/null; do i=$((i + 1)); sleep 0.25; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null; sleep 0.5; fi
  rm -f "$KHOME/daemon.pid"
}

# sync_runtime: 1 = already current and intact (nothing done), 0 = replaced and the daemon was running, 2 = replaced.
sync_runtime() {
  want="$(build_id "$SRC")"
  have="$(build_id "$DST")"
  if [ "$want" = "$have" ] && [ -x "$DST/bin/node" ]; then
    if verify_copy; then return 1; fi
    say "the runtime copy at $DST was modified outside Kora; reinstalling it from the signed bundle"
  fi
  say "runtime $have -> $want"
  # Build the new copy completely and prove it works BEFORE touching the live one (and before stopping the daemon):
  # a failed copy must leave ~/.kora/app exactly as it was.
  rm -rf "$DST.new"
  # clonefile(2) on APFS: near-instant and no extra disk; fall back to a real copy across volumes.
  if ! cp -Rc "$SRC" "$DST.new" 2>/dev/null; then
    rm -rf "$DST.new"
    ditto "$SRC" "$DST.new" || { rm -rf "$DST.new"; die "copying the runtime failed (the existing runtime is untouched)"; }
  fi
  # A downloaded Kora.app carries the quarantine flag on every file inside it, and the copy inherits it. The user
  # already approved (and Apple notarized) the bundle; without this, Gatekeeper would assess the copied node again
  # as a loose download each time the daemon starts — and refuse it offline.
  xattr -dr com.apple.quarantine "$DST.new" 2>/dev/null || true
  if ! "$DST.new/bin/node" -e "process.chdir('$DST.new'); require('$DST.new/node_modules/better-sqlite3'); require('$DST.new/node_modules/node-pty')" >/dev/null 2>&1; then
    rm -rf "$DST.new"
    die "the new runtime copy does not load its native modules; keeping the existing runtime"
  fi
  was_running=0
  if curl -fsS -m 1 "http://127.0.0.1:$PORT/.well-known/kora/host" >/dev/null 2>&1 || [ -S "$KHOME/kora.sock" ]; then
    if clean_env "$SRC/bin/node" "$SRC/bin/kora.js" server status >/dev/null 2>&1; then
      was_running=1; say "stopping the running daemon (its code is being replaced)"; stop_daemon
    fi
  fi
  # Two renames, rolled back on failure: ~/.kora/app is never missing or half-copied. The old copy is deleted only
  # after the new one is in place.
  rm -rf "$DST.old"
  if [ -d "$DST" ]; then mv "$DST" "$DST.old" || { rm -rf "$DST.new"; die "cannot move the old runtime aside; keeping it"; }; fi
  if ! mv "$DST.new" "$DST"; then
    [ -d "$DST.old" ] && mv "$DST.old" "$DST"
    rm -rf "$DST.new"
    die "cannot install the runtime; restored the previous one"
  fi
  rm -rf "$DST.old"
  printf '{ "source": "%s", "build": "%s", "node": "%s", "installedAt": "%s" }\n' "$RES/.." "$want" "$DST/bin/node" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$KHOME/install-source.json"
  link_cli
  [ "$was_running" = 1 ] && return 0
  return 2
}

# ~/.local/bin/kora: a tiny sh shim with absolute paths into ~/.kora/app (never `#!/usr/bin/env node`, which would run
# whatever node is first on PATH). Only replaced when absent or already kora-managed.
link_cli() {
  shim="$BIN_DIR/$CLI_NAME"
  if [ -e "$shim" ] || [ -L "$shim" ]; then
    if [ -L "$shim" ]; then
      case "$(readlink "$shim")" in *"/.kora/app/"*|*"/kora/packages/runtime/"*) ;; *) return 0 ;; esac
    elif ! /usr/bin/grep -q "kora-managed-shim" "$shim" 2>/dev/null; then
      return 0
    fi
  fi
  mkdir -p "$BIN_DIR"
  rm -f "$shim"
  if [ -n "$KORA_APP_FLAVOR" ]; then
    # A flavor's CLI talks to the flavor's daemon and graph store, wherever it is run from.
    printf '#!/bin/sh\n# kora-managed-shim (written by %s.app; points at the runtime copy the app maintains)\nunset KORA_ENV KORA_PANE_ID KORA_BIN\nexport KORA_HOME="%s" KORA_SOCKET_PATH="%s" KORA_UI_PORT="%s" KORAGRAPH_HOME="%s" KORAGRAPH_DB="%s" KORAGRAPH_PRACTICE_DB="%s"\nexec "%s" "%s" "$@"\n' \
      "$KORA_APP_NAME" "$KHOME" "$KORA_SOCKET_PATH" "$PORT" "$KORAGRAPH_HOME" "$KORAGRAPH_DB" "$KORAGRAPH_PRACTICE_DB" "$DST/bin/node" "$DST/bin/kora.js" >"$shim"
  else
    printf '#!/bin/sh\n# kora-managed-shim (written by Kora.app; points at the runtime copy the app maintains)\nexec "%s" "%s" "$@"\n' \
      "$DST/bin/node" "$DST/bin/kora.js" >"$shim"
  fi
  chmod +x "$shim"
}

start_daemon() {
  if running; then return 0; fi
  holder="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  [ -z "$holder" ] || die "port $PORT is held by pid $holder ($(ps -o command= -p "$holder" | cut -c1-80)) — not starting"
  say "starting the kora daemon ($DST/bin/node)"
  # `server start` waits 5 s for the socket; the first exec of a freshly copied node can take longer (the OS scans a
  # new binary), so a timeout here is not a failure — wait_ui decides.
  kora server start >/dev/null 2>&1 || say "kora server start did not confirm within 5s; waiting for the UI port"
}

wait_ui() {
  i=0
  while [ $i -lt 60 ]; do
    if ui_up; then say "ready: chat UI http://127.0.0.1:$PORT"; return 0; fi
    i=$((i + 1)); sleep 0.5
  done
  die "chat UI did not come up on :$PORT within 30s (see $KHOME/server.log)"
}

case "$MODE" in sync|ensure) acquire_lock; recover_swap; recover_unresponsive ;; esac

case "$MODE" in
  sync)
    sync_runtime; r=$?
    link_cli
    if [ $r = 0 ]; then start_daemon && wait_ui; fi
    [ $r = 1 ] && say "runtime already current ($(build_id "$DST"))"
    exit 0
    ;;
  ensure)
    sync_runtime
    link_cli
    start_daemon
    wait_ui
    ;;
  *) die "usage: kora-runtime.sh ensure|sync" ;;
esac
