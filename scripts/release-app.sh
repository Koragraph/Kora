#!/usr/bin/env bash
# release-app.sh — build what users download and what installed copies update from.
#
#   Signed release (needs a Developer ID Application certificate + notarization credentials, docs/RELEASING.md):
#     dist/release-<version>/Kora-arm64.dmg                 the download (signed, notarized, stapled; a stable name so
#                                                           releases/latest/download/Kora-arm64.dmg always works)
#     dist/release-<version>/Kora-<version>-arm64-mac.zip   the update payload Squirrel installs
#     dist/release-<version>/latest-mac.yml                 the update feed entry electron-updater reads
#     dist/release-<version>/SHA256SUMS.txt
#   --publish uploads them as release v<version> of the public repo (KORA_PUBLIC_REPO, default agilkatakam/kora — keep
#   in step with packages/shared/src/koraRelease.ts), drafted first and published only once every file is up.
#   --draft (with --publish) stops at the draft: the Release workflow's Windows job adds its installer and feed, then
#   its publish job makes the release public (.github/workflows/release.yml).
#
#   --unsigned: the old tester build — ad-hoc signed, not notarized, no update feed — for when no certificate exists:
#     dist/Kora-<version>-arm64-unsigned.dmg (+ .sha256). Gatekeeper blocks its first open (docs/BETA-INSTALL.md).
#
# Signing identity: --identity, else KORA_SIGN_IDENTITY, else the keychain's first "Developer ID Application" identity.
# Notarization: APPLE_API_KEY_PATH + APPLE_API_KEY_ID + APPLE_API_ISSUER (an App Store Connect API key; CI), else the
# notarytool keychain profile KORA_NOTARY_PROFILE (default kora-notary; scripts/release-setup.sh stores it).
#
# Usage: bash scripts/release-app.sh [--unsigned] [--identity <id>] [--keychain <path>] [--no-build] [--publish]
#                                    [--draft] [--out <dir>]                                (pnpm app:release)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
PUBLIC_REPO="${KORA_PUBLIC_REPO:-agilkatakam/kora}"
UNSIGNED=0
PUBLISH=0
DRAFT=0
IDENTITY="${KORA_SIGN_IDENTITY:-}"
KEYCHAIN=""
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --unsigned) UNSIGNED=1 ;;
    --publish) PUBLISH=1 ;;
    --draft) DRAFT=1 ;;
    --identity) IDENTITY="$2"; shift ;;
    --keychain) KEYCHAIN="$2"; shift ;;
    --no-build) PASS+=(--no-build) ;;
    --out) OUT_DIR="$2"; shift ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
  shift
done
say() { printf '\033[1mkora\033[0m %s\n' "$*"; }
die() { printf '\033[1mkora\033[0m %s\n' "$*" >&2; exit 1; }
# Node 24 ships in the app: prefer the nvm one when the Terminal's PATH has another node (Homebrew's 22 failed 2026-10-19).
if [ -z "${KORA_NODE:-}" ]; then
  _n24="$(ls -d "$HOME"/.nvm/versions/node/v24.* 2>/dev/null | sort -V | tail -1)"
  [ -z "$_n24" ] || export PATH="$_n24/bin:$PATH"
fi
NODE_BIN="${KORA_NODE:-$(command -v node)}"
VERSION="$("$NODE_BIN" -p "require('$ROOT/packages/runtime/package.json').version")"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kora-release.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# Kora.app + an Applications link + a read-me → a compressed disk image ($1 = app, $2 = dmg, $3 = read-me text).
make_dmg() {
  local app="$1" dmg="$2"
  rm -rf "$STAGE/dmg" && mkdir -p "$STAGE/dmg"
  ditto "$app" "$STAGE/dmg/Kora.app"
  ln -s /Applications "$STAGE/dmg/Applications"
  printf '%s\n' "$3" >"$STAGE/dmg/Read me first.txt"
  rm -f "$dmg"
  # UDZO (zlib) opens on every macOS; the bundle's node + Claude binaries compress poorly either way.
  hdiutil create -volname "Kora $VERSION" -srcfolder "$STAGE/dmg" -fs HFS+ -format UDZO -imagekey zlib-level=9 \
    -ov "$dmg" >/dev/null
  hdiutil verify "$dmg" >/dev/null
}

# ── unsigned tester build ───────────────────────────────────────────────────────────────────────
if [ "$UNSIGNED" = 1 ]; then
  [ "$PUBLISH" = 0 ] || die "--publish needs a signed build: an unsigned app can't update itself"
  bash "$ROOT/scripts/package-app.sh" ${PASS[@]+"${PASS[@]}"} --out "$OUT_DIR"
  APP="$OUT_DIR/Kora.app"
  ARCH="$(lipo -archs "$APP/Contents/MacOS/Kora" | tr ' ' '-')"
  DMG="$OUT_DIR/Kora-$VERSION-$ARCH-unsigned.dmg"
  say "building $(basename "$DMG")"
  make_dmg "$APP" "$DMG" "Kora $VERSION (unsigned tester build, Apple Silicon, macOS 13.5 Ventura or later)

1. Drag Kora onto Applications.
2. Open Kora from Applications. macOS says it \"cannot verify\" Kora, because this build is not notarized by Apple:
   click Done (or Cancel), open System Settings > Privacy & Security, scroll down to \"Kora was blocked\", click
   Open Anyway and confirm. Only needed once.
   Terminal alternative:  xattr -dr com.apple.quarantine /Applications/Kora.app
3. Kora needs Claude Code logged in. If the first screen says Claude Code is missing, run in Terminal:
      curl -fsSL https://claude.ai/install.sh | bash
   then run  claude  once and log in.

This build does not update itself: install the next one the same way."
  (cd "$OUT_DIR" && shasum -a 256 "$(basename "$DMG")" >"$(basename "$DMG").sha256")
  say "built $DMG ($(du -h "$DMG" | cut -f1)) · sha256 $(cut -d' ' -f1 "$DMG.sha256")"
  exit 0
fi

# ── signed + notarized release ──────────────────────────────────────────────────────────────────
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning ${KEYCHAIN:+"$KEYCHAIN"} 2>/dev/null |
    sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p' | head -1)"
fi
[ -n "$IDENTITY" ] || die "no Developer ID Application certificate found — see docs/RELEASING.md, or build a tester
DMG with: bash scripts/release-app.sh --unsigned"
case "$IDENTITY" in "Developer ID Application:"*) ;; *) say "warning: '$IDENTITY' is not a Developer ID identity; Apple will not notarize it" ;; esac

if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] || die "APPLE_API_KEY_PATH needs APPLE_API_KEY_ID and APPLE_API_ISSUER"
  NOTARY=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
else
  NOTARY=(--keychain-profile "${KORA_NOTARY_PROFILE:-kora-notary}")
fi

RELEASE_TAG="v$VERSION"
if [ "$PUBLISH" = 1 ]; then
  command -v gh >/dev/null || die "--publish needs the GitHub CLI (gh)"
  if gh release view "$RELEASE_TAG" --repo "$PUBLIC_REPO" --json isDraft --jq .isDraft 2>/dev/null | /usr/bin/grep -q false; then
    die "$RELEASE_TAG is already published on $PUBLIC_REPO — bump the version (pnpm release <next>) instead"
  fi
fi

# Submit one file to Apple's notary service and wait; on rejection print Apple's log (it names the offending files).
notarize() {
  local file="$1" out="$STAGE/notary-$(basename "$1").json"
  say "notarizing $(basename "$file") (usually 2–15 minutes)"
  xcrun notarytool submit "$file" "${NOTARY[@]}" --wait --timeout 1h --output-format json >"$out" || true
  local status id
  status="$("$NODE_BIN" -p "try { require('$out').status } catch { 'unknown' }")"
  id="$("$NODE_BIN" -p "try { require('$out').id } catch { '' }")"
  if [ "$status" != "Accepted" ]; then
    cat "$out" >&2 || true
    [ -n "$id" ] && xcrun notarytool log "$id" "${NOTARY[@]}" >&2 || true
    die "Apple did not notarize $(basename "$file") (status: $status)"
  fi
  say "notarized ($id)"
}

# Staple the notarization ticket. Right after notarization Apple's ticket service can lag (stapler exits 65/68,
# "could not validate ticket"): retry for about 3 minutes before giving up (v0.1.7's first build died here).
staple() {
  local file="$1" n
  for n in 1 2 3 4 5 6 7; do
    if xcrun stapler staple "$file" >/dev/null 2>&1; then return 0; fi
    say "stapling $(basename "$file") not ready yet (try $n), retrying in 30 s"
    sleep 30
  done
  xcrun stapler staple "$file" || die "could not staple $(basename "$file")"
  # Validation reads the same ticket and lags the same way (v0.1.9's first run: staple ok, validate exit 68 8 s later).
  for n in 1 2 3 4 5 6 7; do
    if xcrun stapler validate "$file" >/dev/null 2>&1; then return 0; fi
    say "validating the staple on $(basename "$file") not ready yet (try $n), retrying in 30 s"
    sleep 30
  done
  xcrun stapler validate "$file" || die "the stapled ticket on $(basename "$file") does not validate"
}

bash "$ROOT/scripts/package-app.sh" ${PASS[@]+"${PASS[@]}"} --out "$OUT_DIR" --sign "$IDENTITY" \
  ${KEYCHAIN:+--keychain "$KEYCHAIN"} --update-feed "github:$PUBLIC_REPO"
APP="$OUT_DIR/Kora.app"
ARCH="$(lipo -archs "$APP/Contents/MacOS/Kora" | tr ' ' '-')"
[ "$ARCH" = arm64 ] || die "expected an arm64 build, got $ARCH"
RELEASE_DIR="$OUT_DIR/release-$VERSION"
rm -rf "$RELEASE_DIR" && mkdir -p "$RELEASE_DIR"

# 1. The app: notarize (via a zip — notarytool takes zip/dmg/pkg), staple the ticket so it opens offline too.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$STAGE/Kora-notarize.zip"
notarize "$STAGE/Kora-notarize.zip"
staple "$APP"
spctl --assess --type execute "$APP" || die "Gatekeeper rejects the stapled app"

# 2. The update payload: the stapled app, zipped the way Squirrel.Mac expects.
ZIP_NAME="Kora-$VERSION-$ARCH-mac.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$RELEASE_DIR/$ZIP_NAME"

# 3. The download: a disk image around the stapled app, itself signed, notarized and stapled.
DMG="$RELEASE_DIR/Kora-$ARCH.dmg"
say "building $(basename "$DMG")"
make_dmg "$APP" "$DMG" "Kora $VERSION for Mac
Requires Apple Silicon (M1 or later) and macOS 13.5+.

1. Drag Kora onto Applications.
2. Open Kora from Applications.
3. Sign in to any coding agent you use (Claude has a one-click login).

Kora keeps itself up to date. Report a bug: Help > Report a Bug in the app, or
https://github.com/$PUBLIC_REPO/issues"
codesign --force --sign "$IDENTITY" --timestamp ${KEYCHAIN:+--keychain "$KEYCHAIN"} "$DMG"
notarize "$DMG"
staple "$DMG"
spctl --assess --type open --context context:primary-signature "$DMG" || die "Gatekeeper rejects the disk image"

# Versioned DMG copy alongside the static Kora-arm64.dmg
VERSIONED_DMG="$RELEASE_DIR/Kora-$VERSION-$ARCH.dmg"
cp -p "$DMG" "$VERSIONED_DMG"

# 4. The feed entry electron-updater reads (the GitHub provider fetches latest-mac.yml from the newest release).
"$NODE_BIN" "$ROOT/scripts/lib/latest-mac-yml.mjs" "$RELEASE_DIR/$ZIP_NAME" "$VERSION" "$RELEASE_DIR/latest-mac.yml"
(cd "$RELEASE_DIR" && shasum -a 256 "Kora-$ARCH.dmg" "Kora-$VERSION-$ARCH.dmg" "$ZIP_NAME" latest-mac.yml >SHA256SUMS.txt)
say "release files in $RELEASE_DIR:"
ls -lh "$RELEASE_DIR" | sed 1d

[ "$PUBLISH" = 1 ] || { say "not published (add --publish, or push the v$VERSION tag and let CI do it)"; exit 0; }

# 5. Publish: a draft first, so the feed never points at a half-uploaded release; then make it public and latest.
NOTES="$ROOT/docs/releases/$RELEASE_TAG.md"
[ -f "$NOTES" ] || { NOTES="$STAGE/notes.md"; printf 'Bug fixes and improvements.\n' >"$NOTES"; }
PRERELEASE=()
case "$VERSION" in *-*) PRERELEASE=(--prerelease) ;; esac
# A draft left by an earlier failed run is replaced (published releases were refused above).
if [ "$(gh release view "$RELEASE_TAG" --repo "$PUBLIC_REPO" --json isDraft --jq .isDraft 2>/dev/null)" = true ]; then
  gh release delete "$RELEASE_TAG" --repo "$PUBLIC_REPO" --yes
fi
say "uploading to github.com/$PUBLIC_REPO ($RELEASE_TAG)"
gh release create "$RELEASE_TAG" --repo "$PUBLIC_REPO" --draft --title "Kora $VERSION" --notes-file "$NOTES" \
  ${PRERELEASE[@]+"${PRERELEASE[@]}"} \
  "$DMG" "$VERSIONED_DMG" "$RELEASE_DIR/$ZIP_NAME" "$RELEASE_DIR/latest-mac.yml" "$RELEASE_DIR/SHA256SUMS.txt"
if [ "$DRAFT" = 1 ]; then
  say "left as a draft (--draft): https://github.com/$PUBLIC_REPO/releases/tag/$RELEASE_TAG"
  exit 0
fi
if [ ${#PRERELEASE[@]} -eq 0 ]; then
  gh release edit "$RELEASE_TAG" --repo "$PUBLIC_REPO" --draft=false --latest
else
  gh release edit "$RELEASE_TAG" --repo "$PUBLIC_REPO" --draft=false
fi
say "published https://github.com/$PUBLIC_REPO/releases/tag/$RELEASE_TAG"

# 6. The public repo's front page follows a stable release: README and About (description + topics) from docs/public/.
if [ ${#PRERELEASE[@]} -eq 0 ] && [ -f "$ROOT/docs/public/README.md" ]; then
  current="$(gh api "repos/$PUBLIC_REPO/contents/README.md" --jq '.sha + " " + .content' 2>/dev/null || true)"
  sha="${current%% *}"
  if [ "$(printf '%s' "${current#* }" | tr -d '\n' | base64 -d 2>/dev/null)" = "$(cat "$ROOT/docs/public/README.md")" ]; then
    say "public README unchanged"
  elif gh api -X PUT "repos/$PUBLIC_REPO/contents/README.md" -f message="README for Kora $VERSION" \
      -f content="$(base64 <"$ROOT/docs/public/README.md" | tr -d '\n')" ${sha:+-f sha="$sha"} >/dev/null; then
    say "public README updated"
  else
    say "public README NOT updated: paste docs/public/README.md into github.com/$PUBLIC_REPO by hand"
  fi
  if [ -f "$ROOT/docs/public/about.txt" ]; then
    desc="$(sed -n 1p "$ROOT/docs/public/about.txt")"
    want=" $(sed -n 2p "$ROOT/docs/public/about.txt") "
    topics=()
    for t in $want; do topics+=(--add-topic "$t"); done
    # topics no longer listed are removed, so the About box says exactly what about.txt says
    for t in $(gh api "repos/$PUBLIC_REPO/topics" --jq '.names[]' 2>/dev/null); do
      case "$want" in *" $t "*) ;; *) topics+=(--remove-topic "$t") ;; esac
    done
    gh repo edit "$PUBLIC_REPO" --description "$desc" ${topics[@]+"${topics[@]}"} >/dev/null && say "public repo About updated" || say "public repo About NOT updated"
  fi
fi
