#!/usr/bin/env bash
# test-update-flow.sh — prove Kora's self-update end to end on this Mac, beside (never touching) Kora and Kora Dev.
#
# Builds "Kora QA" (package-app.sh --flavor qa: its own bundle id com.koraplex.kora.qa and home ~/.kora-qa) twice from
# this checkout — 0.0.1 and 0.0.2 — both with an update feed on a local HTTP server. Installs 0.0.1 as
# /Applications/Kora QA.app, opens it, waits for it to find and download 0.0.2, quits it (Squirrel installs on quit),
# then opens it again and checks it is 0.0.2, still validly signed, and starts.
#
# Updating is the Electron shell's job alone, so Kora QA runs WITHOUT its daemon (shell-prefs localHostEnabled:false):
# no agent CLI ever starts, so nothing can reach a model, Claude Code's login or ~/.claude. Chromium uses its mock
# keychain (no keychain prompts). Never fake HOME instead: a Claude Code started with one can't find the login
# keychain, pops "A keychain cannot be found" and writes its token to a plain file. The daemon's half of an update —
# re-syncing ~/.kora/app when the bundle's BUILD_ID changes — is the path every `pnpm app:install` already takes.
#
# Squirrel installs only an update signed like the running app, so the full run needs a code-signing identity in your
# keychain (Developer ID Application, or Apple Development). --ad-hoc runs without one and stops at Squirrel's
# signature check: it proves the feed, the download, the checksum and that a rejected update is reported as an error.
# Everything is removed at the end (--keep to look around first).
#
# Usage: bash scripts/test-update-flow.sh [--identity <name>] [--ad-hoc] [--no-build] [--keep]   (pnpm app:test-update)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDENTITY="${KORA_SIGN_IDENTITY:-}"
ADHOC=0
BUILD=1
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift ;;
    --ad-hoc) ADHOC=1 ;;
    --no-build) BUILD=0 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
  shift
done
say() { printf '\033[1mupdate-test\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mupdate-test FAIL\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$ADHOC" = 0 ] && [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null |
    sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p; s/.*"\(Apple Development: .*\)"$/\1/p' | head -1)"
  [ -n "$IDENTITY" ] || fail "no signing identity in your keychain: pass --identity, or --ad-hoc for the download-only check"
fi
[ "$ADHOC" = 1 ] && IDENTITY=""
SIGN=()
[ -z "$IDENTITY" ] || SIGN=(--sign "$IDENTITY")

PORT="${KORA_TEST_FEED_PORT:-47911}"
! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || fail "port $PORT is in use (set KORA_TEST_FEED_PORT)"
APP_NAME="Kora QA"
BUNDLE_ID="com.koraplex.kora.qa"
INSTALLED="/Applications/$APP_NAME.app"   # Electron's "is it in Applications?" check passes without asking to move
QA_HOME="$HOME/.kora-qa"
[ -e "$INSTALLED" ] && fail "$INSTALLED already exists (a previous run with --keep?): remove it first"
[ -e "$QA_HOME" ] && fail "$QA_HOME already exists (a previous run with --keep?): remove it first"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kora-update-test.XXXXXX")"
mkdir -p "$WORK/feed" "$QA_HOME/userdata"
printf '{"localHostEnabled":false}\n' >"$QA_HOME/userdata/shell-prefs.json"   # no daemon (see above)
SERVER_PID=""

app_pid() { pgrep -f "^$INSTALLED/Contents/MacOS/Kora( |$)" | head -1 || true; }
quit_app() {
  local pid; pid="$(app_pid)"
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  kill -KILL "$pid" 2>/dev/null || true
}
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  if [ "$KEEP" = 1 ]; then say "kept: $INSTALLED, $QA_HOME and $WORK"; return; fi
  quit_app
  rm -rf "$INSTALLED" "$WORK" "$QA_HOME"
  rm -rf "$HOME/Library/Caches/kora-qa-updater" "$HOME/Library/Caches/$BUNDLE_ID" "$HOME/Library/Caches/$BUNDLE_ID.ShipIt" \
    "$HOME/Library/Application Support/kora-qa-app" "$HOME/Library/Saved Application State/$BUNDLE_ID.savedState" \
    "$HOME/Library/HTTPStorages/$BUNDLE_ID" "$HOME/Library/Preferences/$BUNDLE_ID.plist" 2>/dev/null || true
}
trap cleanup EXIT

# Open the installed app; exec'd directly so the mock-keychain switch reaches Chromium. Waits for its updater.
launch() {
  ( cd / && nohup "$INSTALLED/Contents/MacOS/Kora" --use-mock-keychain >"$WORK/app-$1.log" 2>&1 & )
  for _ in $(seq 1 60); do
    if /usr/bin/grep -a -q "automatic updates off" "$WORK/app-$1.log" 2>/dev/null; then
      fail "Kora QA says updates are off: $(/usr/bin/grep -a -A3 'automatic updates off' "$WORK/app-$1.log" | tail -2)"
    fi
    /usr/bin/grep -a -q "automatic updates on" "$WORK/app-$1.log" 2>/dev/null && return 0
    sleep 1
  done
  fail "Kora QA never started its updater (see $WORK/app-$1.log)"
}
wait_log() { # wait_log <log> <pattern> <seconds>
  for _ in $(seq 1 "$3"); do
    /usr/bin/grep -a -q -E "$2" "$1" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# ── 1. two builds of one checkout ───────────────────────────────────────────────────────────────
if [ "$BUILD" = 1 ]; then say "building the checkout"; bash "$ROOT/scripts/build.sh"; fi
for v in 0.0.1 0.0.2; do
  say "packaging $APP_NAME $v${IDENTITY:+ (signed: $IDENTITY)}"
  bash "$ROOT/scripts/package-app.sh" --no-build --flavor qa --version "$v" --out "$WORK/$v" \
    --update-feed "generic:http://127.0.0.1:$PORT/" ${SIGN[@]+"${SIGN[@]}"} | tail -1
done

# ── 2. the feed: 0.0.2's zip + latest-mac.yml, served locally ──────────────────────────────────
ZIP="$WORK/feed/Kora-QA-0.0.2-arm64-mac.zip"
ditto -c -k --sequesterRsrc --keepParent "$WORK/0.0.2/$APP_NAME.app" "$ZIP"
node "$ROOT/scripts/lib/latest-mac-yml.mjs" "$ZIP" 0.0.2 "$WORK/feed/latest-mac.yml"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WORK/feed" >"$WORK/feed.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 20); do curl -fsS -m 1 "http://127.0.0.1:$PORT/latest-mac.yml" >/dev/null 2>&1 && break; sleep 0.5; done

# ── 3. install 0.0.1 and let it find 0.0.2 ──────────────────────────────────────────────────────
ditto "$WORK/0.0.1/$APP_NAME.app" "$INSTALLED"
say "opening $APP_NAME 0.0.1 (a window appears; leave it alone)"
launch first
say "updater on; waiting for its first check (~20 s after launch) and the download"
if [ "$ADHOC" = 1 ]; then
  wait_log "$WORK/app-first.log" "update status: (error|downloaded)" 180 || fail "no update result; see $WORK/app-first.log"
  if /usr/bin/grep -a -q "update status: downloaded" "$WORK/app-first.log"; then
    fail "an ad-hoc update was reported as ready to install (Squirrel can't install it)"
  fi
  /usr/bin/grep -a -q "GET /Kora-QA-0.0.2-arm64-mac.zip" "$WORK/feed.log" || fail "the app never downloaded the update zip"
  /usr/bin/grep -a -q "failed the code-signature check" "$WORK/app-first.log" ||
    fail "the update failed, but not at the signature check: $(/usr/bin/grep -a -A3 'update status: error' "$WORK/app-first.log" | tail -2)"
  say "PASS (ad-hoc): 0.0.1 read the feed, downloaded and checksummed 0.0.2, and reported Squirrel's signature refusal as an error"
  exit 0
fi
wait_log "$WORK/app-first.log" "update status: (downloaded|error)" 300 || fail "no update result; see $WORK/app-first.log"
/usr/bin/grep -a -q "update status: downloaded" "$WORK/app-first.log" ||
  fail "the update failed: $(/usr/bin/grep -a -A3 'update status: error' "$WORK/app-first.log" | tail -2)"
say "0.0.2 downloaded and accepted by Squirrel; quitting (Squirrel installs on quit)"
quit_app
for _ in $(seq 1 60); do
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALLED/Contents/Info.plist" 2>/dev/null)" = 0.0.2 ] && break
  sleep 1
done
INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALLED/Contents/Info.plist")"
[ "$INSTALLED_VERSION" = 0.0.2 ] || fail "the bundle is still $INSTALLED_VERSION after quitting"
codesign --verify --deep --strict "$INSTALLED" || fail "the installed update does not verify"

# ── 4. reopen the updated app ───────────────────────────────────────────────────────────────────
say "reopening the updated app"
launch second
/usr/bin/grep -a -A6 "automatic updates on" "$WORK/app-second.log" | /usr/bin/grep -q "0\.0\.2" ||
  fail "the reopened app doesn't report 0.0.2 (see $WORK/app-second.log)"
say "PASS: 0.0.1 found, downloaded and installed 0.0.2; the reopened app runs 0.0.2"
