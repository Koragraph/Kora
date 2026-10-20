#!/usr/bin/env bash
# package-app.sh — build a self-contained Kora.app (macOS). Nothing in the bundle refers to this checkout, nvm,
# Homebrew or PATH:
#
#   Contents/MacOS/Kora                 Electron's binary, renamed (no wrapper script)
#   Contents/Frameworks/…               Electron framework + helpers (bundle ids patched)
#   Contents/Resources/app/             the desktop main/preload bundles (dist-electron) + package.json
#   Contents/Resources/web/             the built web client, served over kora://app
#   Contents/Resources/runtime/         the kora runtime: bin/kora.js, dist/, ui/, koragraph/, production node_modules,
#                                       and bin/node — the pinned Node the native modules were installed for
#   Contents/Resources/kora-runtime.sh  syncs runtime/ → ~/.kora/app and starts the daemon (run by the app on launch)
#
# Usage: bash scripts/package-app.sh [--no-build] [--out <dir>] [--flavor dev|qa] [--sign <identity> [--keychain <path>]]
#                                     [--update-feed github:<owner>/<repo>|generic:<url>] [--version <x.y.z>]
#                                                                                   (default out: dist/Kora.app)
#
# Signing: ad-hoc by default (runs on this Mac only). --sign "Developer ID Application: … (TEAMID)" (or
# KORA_SIGN_IDENTITY) signs every Mach-O with the hardened runtime and per-binary entitlements
# (apps/desktop/scripts/sign-mac-app.mjs) — what notarization and Squirrel's update check need. release-app.sh does it.
# --update-feed writes Contents/Resources/app-update.yml, which turns on self-update (ShellUpdater.ts); only release
# builds get one, so local installs and Kora Dev never update from the public feed.
# --version overrides packages/runtime/package.json's version (update-flow tests build two versions of one checkout).
#
# --flavor dev builds "Kora Dev.app" (dist/Kora Dev.app): a second app that runs beside the stable Kora with nothing
# shared — bundle id com.koraplex.kora.devapp, home ~/.kora-dev, chat UI :8790, graph store ~/.kora-dev/koragraph,
# CLI `kora-dev`, a DEV-badged icon. The bundle carries Contents/Resources/flavor.env, read by the desktop main
# process (ShellFlavor.ts) and by kora-runtime.sh.
# --flavor qa builds "Kora QA.app" the same way (com.koraplex.kora.qa, ~/.kora-qa, :8791, `kora-qa`) for testing a
# release candidate — e.g. the self-update flow (scripts/test-update-flow.sh) — beside the apps in daily use.
# Needs Node 24 (see package.json engines) first on PATH, or KORA_NODE=/path/to/node: that binary is what ships.
# Set KORA_SKIP_SMOKE=1 to skip the post-package launch smoke test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
BUILD=1
FLAVOR=""
SIGN_IDENTITY="${KORA_SIGN_IDENTITY:-}"
KEYCHAIN=""
UPDATE_FEED=""
VERSION_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --out) OUT_DIR="$2"; shift ;;
    --flavor) FLAVOR="$2"; shift ;;
    --sign) SIGN_IDENTITY="$2"; shift ;;
    --keychain) KEYCHAIN="$2"; shift ;;
    --update-feed) UPDATE_FEED="$2"; shift ;;
    --version) VERSION_OVERRIDE="$2"; shift ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Darwin ] || { echo "package-app.sh builds a macOS bundle"; exit 1; }
command -v rg >/dev/null || { echo "package-app.sh needs ripgrep for its bundle checks (brew install ripgrep)"; exit 1; }
case "$FLAVOR" in
  "") APP_NAME="Kora"; BUNDLE_ID="com.koraplex.kora"; URL_SCHEME="kora"; ICON_PNG="$ROOT/assets/icons/release/mac-1024.png" ;;
  dev) APP_NAME="Kora Dev"; BUNDLE_ID="com.koraplex.kora.devapp"; URL_SCHEME="kora-dev"; ICON_PNG="$ROOT/assets/icons/kora-dev/mac-1024.png" ;;
  qa) APP_NAME="Kora QA"; BUNDLE_ID="com.koraplex.kora.qa"; URL_SCHEME="kora-qa"; ICON_PNG="$ROOT/assets/icons/kora-dev/mac-1024.png" ;;
  *) echo "unknown flavor $FLAVOR (dev, qa)"; exit 2 ;;
esac
# A generic feed must be https: the feed tells installed copies what to download. Plain http only on loopback (the
# local update-flow test, scripts/test-update-flow.sh).
case "$UPDATE_FEED" in
  "" | github:*/* | generic:https://* | generic:http://127.0.0.1:* | generic:http://127.0.0.1/* | generic:http://localhost:* | generic:http://localhost/*) ;;
  generic:http://*) echo "--update-feed generic:http:// is only allowed on 127.0.0.1/localhost; use https"; exit 2 ;;
  *) echo "--update-feed takes github:<owner>/<repo> or generic:<https url>"; exit 2 ;;
esac
say() { printf '\033[1mkora\033[0m %s\n' "$*"; }

NODE_BIN="${KORA_NODE:-$(command -v node)}"
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
[ -L "$NODE_BIN" ] && NODE_BIN="$(readlink -f "$NODE_BIN")"
NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
# The shipped node must satisfy the workspace engines range (root package.json), since it is what pnpm built the
# runtime's native modules with and what runs the daemon, the CLI and every hook.
"$NODE_BIN" -e '
  const want = require(process.argv[1]).engines.node; const [maj, min, pat] = process.versions.node.split(".").map(Number);
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(want); if (!m) process.exit(0);
  const ok = maj === +m[1] && (min > +m[2] || (min === +m[2] && pat >= +m[3]));
  if (!ok) { console.error(`node ${process.versions.node} does not satisfy engines ${want}`); process.exit(1); }
' "$ROOT/package.json" || { echo "put a Node matching package.json engines first on PATH (or set KORA_NODE)"; exit 1; }
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [ "$BUILD" = 1 ]; then bash "$ROOT/scripts/build.sh"; fi
DESKTOP="$ROOT/apps/desktop"
for f in "$DESKTOP/dist-electron/main.cjs" "$DESKTOP/dist-electron/preload.cjs" "$ROOT/apps/web/dist/index.html" \
  "$ROOT/packages/runtime/dist/cli/main.js" "$ROOT/packages/runtime/ui/ui-server.cjs"; do
  [ -f "$f" ] || { echo "missing $f — run pnpm build"; exit 1; }
done

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kora-package.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/$APP_NAME.app"
C="$APP/Contents"
# `require("electron")` downloads the Electron binary on first use and prints "Downloading Electron binary..." to
# stdout first (a fresh worktree / pnpm store), so keep only the last line: the path.
ELECTRON_APP="$(cd "$DESKTOP" && "$NODE_BIN" -p 'require("node:path").resolve(require("electron"), "../../..")' | tail -n 1)"
[ -x "$ELECTRON_APP/Contents/MacOS/Electron" ] || { echo "no Electron app at $ELECTRON_APP"; exit 1; }
VERSION="${VERSION_OVERRIDE:-$("$NODE_BIN" -p "require('$ROOT/packages/runtime/package.json').version")}"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git -C "$ROOT" status --porcelain 2>/dev/null | head -1)"
BUILD_ID="$VERSION-$COMMIT${DIRTY:+-dirty}-$(date -u +%Y%m%d%H%M%S)"

# ── 1. Electron shell ───────────────────────────────────────────────────────────────────────────
say "staging Electron $("$NODE_BIN" -p "require('$DESKTOP/node_modules/electron/package.json').version")"
ditto "$ELECTRON_APP" "$APP"   # ditto keeps the framework's relative symlinks
mv "$C/MacOS/Electron" "$C/MacOS/Kora"
# Security fuses (no Electron-as-node / NODE_OPTIONS / --inspect / file:// privileges), before anything signs the binary.
(cd "$DESKTOP" && "$NODE_BIN" scripts/flip-fuses.mjs "$C/MacOS/Kora")
rm -f "$C/Resources/default_app.asar" "$C/Resources/electron.icns"
# Chromium's UI strings for ~60 languages (~49 MB). Kora's UI is English; Chromium falls back to en-US for any other
# system language (electron-builder's `electronLanguages` does the same pruning).
for l in "$C/Frameworks/Electron Framework.framework/Versions/A/Resources/"*.lproj; do
  case "$(basename "$l")" in en.lproj | en_GB.lproj | en_*.lproj | Base.lproj) ;; *) rm -rf "$l" ;; esac
done
PL="$C/Info.plist"
plutil -replace CFBundleExecutable -string Kora "$PL"
plutil -replace CFBundleName -string "$APP_NAME" "$PL"
plutil -replace CFBundleDisplayName -string "$APP_NAME" "$PL" 2>/dev/null || plutil -insert CFBundleDisplayName -string "$APP_NAME" "$PL"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PL"
plutil -replace CFBundleIconFile -string icon.icns "$PL"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PL"
plutil -replace CFBundleVersion -string "$VERSION" "$PL"
# The bundled node (Node 24) needs macOS 13.5; say so to Finder instead of shipping a daemon that cannot start.
plutil -replace LSMinimumSystemVersion -string 13.5 "$PL"
plutil -replace LSApplicationCategoryType -string public.app-category.developer-tools "$PL" 2>/dev/null ||
  plutil -insert LSApplicationCategoryType -string public.app-category.developer-tools "$PL"
plutil -replace NSDocumentsFolderUsageDescription -string "Kora reads project files you open in the desktop app." "$PL" 2>/dev/null ||
  plutil -insert NSDocumentsFolderUsageDescription -string "Kora reads project files you open in the desktop app." "$PL"
URL_TYPES="[{\"CFBundleURLName\":\"$BUNDLE_ID\",\"CFBundleURLSchemes\":[\"$URL_SCHEME\"]}]"
plutil -replace CFBundleURLTypes -json "$URL_TYPES" "$PL" 2>/dev/null || plutil -insert CFBundleURLTypes -json "$URL_TYPES" "$PL"
for pair in "Electron Helper.app:helper:Kora Helper" "Electron Helper (GPU).app:helper.gpu:Kora Helper (GPU)" \
  "Electron Helper (Plugin).app:helper.plugin:Kora Helper (Plugin)" "Electron Helper (Renderer).app:helper.renderer:Kora Helper (Renderer)"; do
  IFS=: read -r bundle suffix name <<<"$pair"
  HP="$C/Frameworks/$bundle/Contents/Info.plist"
  [ -f "$HP" ] || continue
  plutil -replace CFBundleIdentifier -string "$BUNDLE_ID.$suffix" "$HP"
  plutil -replace CFBundleName -string "$name" "$HP"
done

# ── 2. icon ─────────────────────────────────────────────────────────────────────────────────────
ICONSET="$STAGE/icon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$C/Resources/icon.icns"
sips -z 512 512 "$ICON_PNG" --out "$C/Resources/icon.png" >/dev/null   # dock / about / window icon (ShellAssets)

# ── 3. desktop app + web client ─────────────────────────────────────────────────────────────────
say "staging the desktop bundles and the web client"
mkdir -p "$C/Resources/app"
rsync -a --exclude '*.map' "$DESKTOP/dist-electron/" "$C/Resources/app/dist-electron/"
"$NODE_BIN" -e '
  const fs = require("node:fs"); const [out, version, koraCommitHash, productName] = process.argv.slice(1);
  fs.writeFileSync(out, JSON.stringify({ name: "kora", productName, version, private: true,
    main: "dist-electron/main.cjs", koraCommitHash }, null, 2) + "\n");
' "$C/Resources/app/package.json" "$VERSION" "$COMMIT" "$APP_NAME"
# Packages the main-process bundle leaves external (scripts/lib/desktop-external-packages.ts) must ship as real
# node_modules next to it.
EXTERNALS="$("$NODE_BIN" -e '
  const deps = require(process.argv[1]).dependencies ?? {};
  const src = require("node:fs").readFileSync(process.argv[2], "utf8");
  const prefixes = [...src.matchAll(/^\s*"([^"]+)",\s*$/gm)].map((m) => m[1]);
  console.log(Object.keys(deps).filter((d) => prefixes.some((p) => d.startsWith(p))).join(" "));
' "$DESKTOP/package.json" "$ROOT/scripts/lib/desktop-external-packages.ts")"
if [ -n "$EXTERNALS" ]; then
  say "desktop externals: $EXTERNALS"
  mkdir -p "$C/Resources/app/node_modules"
  # Each external plus its dependency closure (incl. installed platform-specific optional packages such as
  # @napi-rs/keyring-darwin-arm64), resolved through pnpm's layout and copied flat.
  "$NODE_BIN" -e '
    const fs = require("node:fs"), path = require("node:path");
    const [from, ...roots] = process.argv.slice(1); const seen = new Map();
    const visit = (name, baseDir) => {
      let dir = null;   // node resolution by hand: package.json may be missing from the exports map
      for (let d = baseDir; ; d = path.dirname(d)) {
        const c = path.join(d, "node_modules", name, "package.json");
        if (fs.existsSync(c)) { dir = fs.realpathSync(path.dirname(c)); break; }
        if (path.dirname(d) === d) break;
      }
      if (dir === null) return;   // an optional dependency for another platform is simply not installed
      if (seen.has(name)) return; seen.set(name, dir);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, dir);
    };
    for (const r of roots) visit(r, from);
    for (const [name, dir] of seen) console.log(name + "\t" + dir);
  ' "$DESKTOP" $EXTERNALS | while IFS="$(printf '\t')" read -r dep real; do
    mkdir -p "$C/Resources/app/node_modules/$(dirname "$dep")"
    rsync -aL --exclude .bin --exclude node_modules "$real/" "$C/Resources/app/node_modules/$dep/"
  done
fi
rsync -a --exclude '*.map' "$ROOT/apps/web/dist/" "$C/Resources/web/"

# ── 4. kora runtime + node ──────────────────────────────────────────────────────────────────────
say "deploying the kora runtime (production node_modules)"
# `deploy --prod` leaves node_modules itself alone but records "production" in the workspace state file, after which
# every `pnpm run` tries `pnpm install --production` (and would purge dev deps). Keep the state file as it was.
WS_STATE="$ROOT/node_modules/.pnpm-workspace-state-v1.json"
[ -f "$WS_STATE" ] && cp "$WS_STATE" "$STAGE/ws-state.json"
(cd "$ROOT" && pnpm --filter @kora/runtime deploy --prod --legacy "$STAGE/runtime" >/dev/null)
[ -f "$STAGE/ws-state.json" ] && cp "$STAGE/ws-state.json" "$WS_STATE"
for f in dist ui bin koragraph manifests scripts; do
  [ -e "$STAGE/runtime/$f" ] || rsync -a "$ROOT/packages/runtime/$f" "$STAGE/runtime/"
done
rsync -a --delete "$ROOT/packages/runtime/dist/" "$STAGE/runtime/dist/"
rsync -a --delete "$ROOT/packages/runtime/ui/" "$STAGE/runtime/ui/"
find "$STAGE/runtime/dist" -name '*.test.js' -delete
rm -f "$STAGE/runtime/node_modules/.package-map.json"   # pnpm deploy bookkeeping with absolute build paths
find "$STAGE/runtime" -name '*.map' -delete
# prune what the daemon never loads: other platforms' prebuilds and native sources
ARCH="$(uname -m)"; [ "$ARCH" = x86_64 ] && ARCH=x64
find "$STAGE/runtime/node_modules" -type d -name prebuilds 2>/dev/null | while read -r p; do
  for d in "$p"/*; do case "$(basename "$d")" in "darwin-$ARCH" | "darwin-$ARCH".*) ;; *) rm -rf "$d" ;; esac; done
done
for d in "$STAGE"/runtime/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3; do
  # it loads prebuilds/<platform>.node; build/ holds only node-gyp leftovers (with absolute build paths)
  [ -n "$(find "$d/build" -name '*.node' 2>/dev/null)" ] || rm -rf "$d/build"
  rm -rf "$d/deps" "$d/src"
done
rm -f "$STAGE/runtime/node_modules/.modules.yaml"
# pnpm hoists a link to the workspace package itself (.pnpm/node_modules/@kora/runtime -> the checkout): drop every
# symlink that leaves the runtime tree, and test-coverage leftovers some packages publish.
find "$STAGE/runtime" -type l | while read -r l; do
  t="$(cd "$(dirname "$l")" && cd "$(dirname "$(readlink "$l")")" 2>/dev/null && pwd -P)" || { rm -f "$l"; continue; }
  case "$t" in "$STAGE/runtime"*|"$(cd "$STAGE" && pwd -P)/runtime"*) ;; *) rm -f "$l" ;; esac
done
find "$STAGE/runtime/node_modules" -type d -name .nyc_output -prune -exec rm -rf {} +
cp "$NODE_BIN" "$STAGE/runtime/bin/node"
chmod 755 "$STAGE/runtime/bin/node"
echo "$BUILD_ID" >"$STAGE/runtime/BUILD_ID"
# node-pty chmods its own spawn-helper to 0755 the first time it runs. Ship it executable so the sealed manifest already
# says so (the integrity check also ignores mode bits: it verifies content, not permissions).
find "$STAGE/runtime/node_modules" -name spawn-helper -type f -exec chmod 755 {} + 2>/dev/null || true
(cd "$STAGE/runtime" && ./bin/node -e "require('better-sqlite3'); require('node-pty')") ||
  { echo "the runtime's native modules do not load under the bundled node $NODE_VERSION"; exit 1; }
# The SDK's native `claude` binary ships as a platform optional package. If the pnpm store lost its files, `pnpm deploy`
# leaves an EMPTY package folder and the build still "succeeds" -- but every chat thread (and the model probe) then dies
# with "Native CLI binary for darwin-arm64 not found" (found 2026-10-14 in a Kora Dev install). Refuse such a bundle.
(cd "$STAGE/runtime" && ./bin/node -e "
  const p = require('node:path'), fs = require('node:fs');
  const sdkDir = fs.realpathSync('node_modules/@anthropic-ai/claude-agent-sdk');
  const bin = p.join(fs.realpathSync(p.join(sdkDir, '..', 'claude-agent-sdk-darwin-$ARCH')), 'claude');
  if (fs.statSync(bin).size < 1e6) throw new Error('claude binary is truncated: ' + bin);
") || { echo "the runtime lacks the SDK's native claude binary (empty pnpm store entry?): run 'pnpm store prune' and 'pnpm install --force', then rebuild"; exit 1; }
# Integrity manifest of the runtime, sealed by the bundle signature (outside runtime/ so it is never copied with it):
# kora-runtime.sh checks the user-writable ~/.kora/app copy against it before every daemon start. Generated before
# signing — Mach-O files are flagged and compared against the bundle's own copy instead of hashed.
"$NODE_BIN" "$DESKTOP/resources/kora-runtime-manifest.cjs" generate "$STAGE/runtime" "$STAGE/runtime-manifest.json" "$BUILD_ID" ||
  { echo "could not generate the runtime manifest"; exit 1; }
"$NODE_BIN" "$DESKTOP/resources/kora-runtime-manifest.cjs" verify "$STAGE/runtime" "$STAGE/runtime-manifest.json" "$STAGE/runtime" ||
  { echo "the fresh runtime does not match its own manifest"; exit 1; }
mv "$STAGE/runtime" "$C/Resources/runtime"
install -m 644 "$STAGE/runtime-manifest.json" "$C/Resources/runtime-manifest.json"
install -m 644 "$DESKTOP/resources/kora-runtime-manifest.cjs" "$C/Resources/kora-runtime-manifest.cjs"
install -m 755 "$DESKTOP/resources/kora-runtime.sh" "$C/Resources/kora-runtime.sh"
# Licence notices for code Kora is derived from (MIT: the copyright + permission notice must ship with every copy).
install -m 644 "$ROOT/THIRD_PARTY_NOTICES.md" "$C/Resources/THIRD_PARTY_NOTICES.md"
if [ "$FLAVOR" = dev ]; then
  printf 'KORA_APP_FLAVOR=dev\nKORA_APP_NAME="Kora Dev"\nKORA_HOME_NAME=.kora-dev\nKORA_PORT=8790\nKORA_CLI_NAME=kora-dev\nKORA_BLOBS_ROOT="$HOME/Blobs-Dev"\n' \
    >"$C/Resources/flavor.env"
elif [ "$FLAVOR" = qa ]; then
  printf 'KORA_APP_FLAVOR=qa\nKORA_APP_NAME="Kora QA"\nKORA_HOME_NAME=.kora-qa\nKORA_PORT=8791\nKORA_CLI_NAME=kora-qa\nKORA_BLOBS_ROOT="$HOME/Blobs-QA"\n' \
    >"$C/Resources/flavor.env"
fi
# The self-update feed electron-updater reads (ShellUpdater.ts turns updates on only when this file exists).
if [ -n "$UPDATE_FEED" ]; then
  CACHE_DIR_NAME="$(printf '%s' "$APP_NAME" | tr 'A-Z ' 'a-z-')-updater"
  case "$UPDATE_FEED" in
    github:*)
      REPO="${UPDATE_FEED#github:}"
      printf 'provider: github\nowner: %s\nrepo: %s\nreleaseType: release\nupdaterCacheDirName: %s\n' \
        "${REPO%%/*}" "${REPO#*/}" "$CACHE_DIR_NAME" >"$C/Resources/app-update.yml" ;;
    generic:*)
      printf 'provider: generic\nurl: %s\nupdaterCacheDirName: %s\n' "${UPDATE_FEED#generic:}" "$CACHE_DIR_NAME" \
        >"$C/Resources/app-update.yml" ;;
  esac
  say "update feed: $UPDATE_FEED"
fi

# ── 5. relocatability gate + sign ───────────────────────────────────────────────────────────────
# (Homebrew/nvm *directories* appear legitimately as fallback search locations, e.g. the shell-PATH probe; a baked
# checkout path or a specific nvm node install would be a real dependency on this machine.)
say "checking the bundle for checkout / nvm paths"
LEAKS="$(rg -l -uu --no-messages -e "$ROOT" -e '\.nvm/versions/' "$C/Resources/app" "$C/Resources/web" \
  "$C/Resources/kora-runtime.sh" "$C/Resources/kora-runtime-manifest.cjs" "$C/Resources/runtime/bin" "$C/Resources/runtime/dist" "$C/Resources/runtime/ui" \
  "$C/Resources/runtime/koragraph" 2>/dev/null || true)"
if [ -n "$LEAKS" ]; then echo "bundle references build-machine paths:"; echo "$LEAKS"; exit 1; fi
# Secrets gate: a local build copies untracked files too (e.g. a .env next to a tracked .env.example under
# runtime/koragraph), so refuse any key, certificate, keychain, credentials or env file before the bundle is signed.
say "checking the bundle for key / env / credential files"
SECRET_FILES="$(find "$C" -type f \( -name '.env' -o -name '.env.*' ! -name '.env.example' -o -name '*.p8' -o -name '*.p12' \
  -o -name '*.pfx' -o -name '*.pem' -o -name '*.key' -o -name '*.keychain' -o -name '*.keychain-db' -o -name '.npmrc' \
  -o -name '.netrc' -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name 'id_ecdsa*' -o -name '.env.release' \
  -o -name 'credentials.json' -o -name 'ui-token' \) 2>/dev/null || true)"
if [ -n "$SECRET_FILES" ]; then echo "bundle contains key / env / credential files:"; echo "$SECRET_FILES"; exit 1; fi
if [ -n "$SIGN_IDENTITY" ]; then
  say "signing with $SIGN_IDENTITY (hardened runtime, secure timestamp)"
  "$NODE_BIN" "$DESKTOP/scripts/sign-mac-app.mjs" --app "$APP" --identity "$SIGN_IDENTITY" ${KEYCHAIN:+--keychain "$KEYCHAIN"}
else
  codesign --force --deep --sign - --timestamp=none "$APP" >/dev/null 2>&1 || codesign --force --deep --sign - --timestamp=none "$APP"
fi

mkdir -p "$OUT_DIR"
rm -rf "$OUT_DIR/$APP_NAME.app"
mv "$APP" "$OUT_DIR/$APP_NAME.app"
say "built $OUT_DIR/$APP_NAME.app ($BUILD_ID, node $NODE_VERSION, $(du -sh "$OUT_DIR/$APP_NAME.app" | cut -f1))"

# ── 6. launch smoke test ────────────────────────────────────────────────────────────────────────
if [ "${KORA_SKIP_SMOKE:-0}" = 1 ] || [ "${KORA_SKIP_SMOKE_TEST:-0}" = 1 ]; then
  say "skipping launch smoke test (KORA_SKIP_SMOKE is set)"
elif [ -n "$FLAVOR" ]; then
  say "skipping launch smoke test for flavored bundle ($FLAVOR)"
else
  SMOKE_APP="$OUT_DIR/$APP_NAME.app"
  [ -d "$SMOKE_APP" ] || { echo "smoke test: bundle $SMOKE_APP not found" >&2; exit 1; }

  SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/kora-smoke.XXXXXX")"
  SMOKE_LOG="$SMOKE_HOME/smoke-app.log"
  # Non-default UI port
  SMOKE_PORT="$("$NODE_BIN" -e 'const s = require("node:net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });' 2>/dev/null || true)"
  if [ -z "$SMOKE_PORT" ] || [ "$SMOKE_PORT" -le 1024 ] || [ "$SMOKE_PORT" -eq 8797 ] || [ "$SMOKE_PORT" -eq 8790 ] || [ "$SMOKE_PORT" -eq 8791 ]; then
    SMOKE_PORT=8798
  fi

  SMOKE_APP_PID=""
  cleanup_smoke() {
    if [ -n "$SMOKE_APP_PID" ] && kill -0 "$SMOKE_APP_PID" 2>/dev/null; then
      say "stopping smoke test app (pid $SMOKE_APP_PID)"
      kill -TERM "$SMOKE_APP_PID" 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        if ! kill -0 "$SMOKE_APP_PID" 2>/dev/null; then break; fi
        sleep 1
      done
      kill -0 "$SMOKE_APP_PID" 2>/dev/null && kill -KILL "$SMOKE_APP_PID" 2>/dev/null || true
    fi
    if [ -d "$SMOKE_HOME/app" ] && [ -x "$SMOKE_HOME/app/bin/node" ]; then
      env KORA_HOME="$SMOKE_HOME" KORA_UI_PORT="$SMOKE_PORT" "$SMOKE_HOME/app/bin/node" "$SMOKE_HOME/app/bin/kora.js" server stop >/dev/null 2>&1 || true
    fi
    # The stopping daemon / app can still be writing into the temp home for a moment: "Directory not empty" killed the
    # 0.1.13 release after a passing smoke test (set -e). Retry, and never fail the build over scratch files.
    for _ in 1 2 3 4 5; do rm -rf "$SMOKE_HOME" 2>/dev/null && break; sleep 1; done
    rm -rf "$SMOKE_HOME" 2>/dev/null || true
    rm -rf "$STAGE" 2>/dev/null || true
  }
  trap cleanup_smoke EXIT INT TERM

  say "running launch smoke test on $APP_NAME.app (port $SMOKE_PORT, temp home $SMOKE_HOME)"
  ELECTRON_ENABLE_LOGGING=1 \
  KORA_HOME="$SMOKE_HOME" \
  KORA_PORT="$SMOKE_PORT" \
  KORA_UI_PORT="$SMOKE_PORT" \
  KORA_SOCKET_PATH="$SMOKE_HOME/kora.sock" \
  "$SMOKE_APP/Contents/MacOS/Kora" >"$SMOKE_LOG" 2>&1 &
  SMOKE_APP_PID=$!

  START_TIME=$SECONDS
  TIMEOUT_SECONDS=60
  HANDSHAKE_OK=0
  WINDOW_OK=0

  while [ $((SECONDS - START_TIME)) -lt $TIMEOUT_SECONDS ]; do
    if ! kill -0 "$SMOKE_APP_PID" 2>/dev/null; then
      echo "smoke test failed: app exited unexpectedly (pid $SMOKE_APP_PID)" >&2
      if [ -f "$SMOKE_LOG" ]; then cat "$SMOKE_LOG" >&2; fi
      exit 1
    fi

    # Check for renderer errors in log or trace
    if [ -f "$SMOKE_LOG" ] && grep -q -E "main window failed to load|main window render process gone|fatal startup error" "$SMOKE_LOG" 2>/dev/null; then
      echo "smoke test failed: renderer error detected in app log" >&2
      cat "$SMOKE_LOG" >&2
      exit 1
    fi
    TRACE_LOG="$SMOKE_HOME/userdata/logs/shell.trace.ndjson"
    if [ -f "$TRACE_LOG" ] && grep -q -E "main window failed to load|main window render process gone|fatal startup error" "$TRACE_LOG" 2>/dev/null; then
      echo "smoke test failed: renderer error detected in shell trace" >&2
      cat "$TRACE_LOG" >&2
      exit 1
    fi

    # 1. Daemon /.well-known/kora/identity or host handshake
    if [ "$HANDSHAKE_OK" = 0 ]; then
      if curl -fsS -m 2 "http://127.0.0.1:$SMOKE_PORT/.well-known/kora/identity?nonce=smoke" >/dev/null 2>&1 || \
         curl -fsS -m 2 "http://127.0.0.1:$SMOKE_PORT/.well-known/kora/host" >/dev/null 2>&1; then
        HANDSHAKE_OK=1
        say "daemon handshake answered on port $SMOKE_PORT"
      fi
    fi

    # 2. Main window loaded: web client connects to ws or main window created without error
    if [ "$HANDSHAKE_OK" = 1 ] && [ "$WINDOW_OK" = 0 ]; then
      if [ -f "$SMOKE_HOME/server.log" ] && grep -q "ws client connected" "$SMOKE_HOME/server.log" 2>/dev/null; then
        WINDOW_OK=1
        say "main window loaded and connected to daemon"
      fi
    fi

    if [ "$HANDSHAKE_OK" = 1 ] && [ "$WINDOW_OK" = 1 ]; then
      say "smoke test passed (elapsed $((SECONDS - START_TIME))s)"
      break
    fi

    sleep 1
  done

  if [ "$HANDSHAKE_OK" = 0 ] || [ "$WINDOW_OK" = 0 ]; then
    echo "smoke test timed out after ${TIMEOUT_SECONDS}s (handshake=$HANDSHAKE_OK, window=$WINDOW_OK)" >&2
    if [ -f "$SMOKE_LOG" ]; then echo "--- App Log ---" >&2; cat "$SMOKE_LOG" >&2; fi
    if [ -f "$SMOKE_HOME/server.log" ]; then echo "--- Server Log ---" >&2; cat "$SMOKE_HOME/server.log" >&2; fi
    exit 1
  fi

  # Cleanly quit app by exact PID and stop daemon
  cleanup_smoke
  trap 'rm -rf "$STAGE"' EXIT INT TERM
fi
