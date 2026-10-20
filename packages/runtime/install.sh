#!/usr/bin/env bash
# kora installer.  Usage:  ./install.sh [<git-url> | <checkout-path>]
#   no argument: install this checkout;  git URL: clone (or pull --ff-only);  path: rsync it.
# Installs into ~/.kora/app, builds, and links ~/.local/bin/kora.  Re-run (or `kora update`) to update.
set -euo pipefail

APP="${KORA_APP:-$HOME/.kora/app}"
BIN_DIR="${KORA_BIN_DIR:-$HOME/.local/bin}"
HOME_DIR="${KORA_HOME:-$HOME/.kora}"
SRC="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\033[1mkora\033[0m %s\n' "$*"; }
die() { printf 'kora: %s\n' "$*" >&2; exit 1; }

# 1. node >= 22
command -v node >/dev/null 2>&1 || die "node not found — install Node 22+ (https://nodejs.org) and re-run"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || die "node $(node -v) is too old — kora needs Node 22+"
command -v npm >/dev/null 2>&1 || die "npm not found"
command -v git >/dev/null 2>&1 || die "git not found"

# 2. source → ~/.kora/app
[ -n "$SRC" ] || SRC="$HERE"
KIND="dir"
case "$SRC" in
  http://*|https://*|git@*|ssh://*|*.git) KIND="git" ;;
esac
# $APP is wiped (clone) or rsync --delete'd (checkout): it must be a dedicated directory, never $HOME, an ancestor
# of it, / or a top-level dir — KORA_APP comes from the environment.
case "$APP" in
  ""|/|/*/..|*/../*|..|../*) die "refusing KORA_APP=$APP" ;;
esac
APP_PARENT="$(dirname "$APP")"
mkdir -p "$APP_PARENT" || die "cannot create $APP_PARENT"
APP_PARENT_ABS="$(cd "$APP_PARENT" && pwd -P)"
APP_ABS="${APP_PARENT_ABS%/}/$(basename "$APP")"
case "$(cd "$HOME" && pwd -P)/" in "$APP_ABS"/*) die "refusing KORA_APP=$APP: it is your home folder or contains it" ;; esac
APP_DEPTH="$(printf %s "$APP_ABS" | tr -cd / | wc -c | tr -d ' ')"
[ "$APP_DEPTH" -ge 2 ] || die "refusing KORA_APP=$APP: too shallow"
mkdir -p "$HOME_DIR"
chmod 700 "$HOME_DIR" 2>/dev/null || true
if [ "$KIND" = "git" ]; then
  if [ -d "$APP/.git" ]; then say "updating $APP from $SRC"; git -C "$APP" pull --ff-only
  else say "cloning $SRC → $APP"; rm -rf "$APP"; git clone --depth 1 -- "$SRC" "$APP"; fi
else
  SRC="$(cd "$SRC" && pwd)"
  [ -f "$SRC/package.json" ] && [ -d "$SRC/src" ] || die "$SRC does not look like a kora checkout"
  if [ "$SRC" = "$APP" ]; then say "installing in place at $APP"
  else
    say "syncing $SRC → $APP"
    mkdir -p "$APP"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude '*.log' "$SRC/" "$APP/"
    else
      (cd "$SRC" && tar --exclude node_modules --exclude dist --exclude .git -cf - .) | (cd "$APP" && tar -xf -)
    fi
  fi
fi

# 3. dependencies + build (typescript is a devDependency, so install everything, build, then prune to runtime deps)
cd "$APP"
say "installing dependencies"
# The lockfile pins every dependency: never fall back to an unpinned `npm install` silently.
# No dependency lifecycle scripts run (--ignore-scripts): a compromised or typo-squatted transitive package can't execute
# code at install time. Only the native modules kora actually needs are then rebuilt, explicitly, by name.
# Keep KORA_NATIVE_DEPS in sync with the prod deps that ship a binding.gyp / install script (check:
# `npm query ':attr(scripts, [install]), :attr(scripts, [postinstall])'` plus packages with binding.gyp).
KORA_NATIVE_DEPS="better-sqlite3 node-pty"
if [ -f package-lock.json ]; then
  npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || {
    [ "${KORA_ALLOW_NPM_INSTALL:-0}" = "1" ] || die "npm ci failed (lockfile out of date or registry error). Fix it, or re-run with KORA_ALLOW_NPM_INSTALL=1 to resolve versions without the lockfile."
    npm install --ignore-scripts --no-audit --no-fund
  }
else npm install --ignore-scripts --no-audit --no-fund; fi
say "building native modules ($KORA_NATIVE_DEPS)"
# shellcheck disable=SC2086 # word-splitting the fixed list is intended
npm rebuild $KORA_NATIVE_DEPS --no-audit --no-fund >/dev/null 2>&1 || die "rebuilding native modules failed ($KORA_NATIVE_DEPS) — check your C/C++ toolchain (Xcode CLT / build-essential) and Python"
node -e 'require("better-sqlite3"); require("node-pty")' 2>/dev/null || die "native modules did not load after rebuild ($KORA_NATIVE_DEPS)"
say "building"
npm run build >/dev/null
npm prune --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true

# 4. ~/.local/bin/kora → ~/.kora/app/bin/kora.js
mkdir -p "$BIN_DIR"
chmod +x "$APP/bin/kora.js"
ln -sfn "$APP/bin/kora.js" "$BIN_DIR/kora"

# 5. record where this came from (kora update re-runs from it)
COMMIT="$(git -C "$APP" rev-parse --short HEAD 2>/dev/null || git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '')"
# JSON via node (a path with a quote or backslash must not break — or inject into — the record kora update reads).
SRC="$SRC" KIND="$KIND" COMMIT="$COMMIT" node -e 'process.stdout.write(JSON.stringify({ source: process.env.SRC, kind: process.env.KIND, commit: process.env.COMMIT, installedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }) + "\n")' > "$HOME_DIR/install-source.json"

say "installed $(node "$APP/bin/kora.js" --version) → $BIN_DIR/kora"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\nAdd this to your shell profile, then open a new terminal:\n  export PATH="%s:$PATH"\n' "$BIN_DIR" ;;
esac
printf 'Next: cd your/project && kora --agent claude\n'
