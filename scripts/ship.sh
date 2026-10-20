#!/usr/bin/env bash
# ship.sh — push to prod: Kora Dev becomes Kora (docs/DOGFOOD.md).
#   1. in the MAIN checkout (on `main`, clean): merge `dev`, push main
#   2. pnpm release <bump> --yes: gates (typecheck, test, canary), bump, tag, push
#   3. release-app.sh --publish: build, sign, notarize, publish on the public repo. The installed Kora.app updates
#      itself from there, like every user's copy; nothing is installed locally.
#   4. fast-forward `dev` to the released main, so Kora Dev starts again from exactly what Kora is.
# Run it from your own Terminal (signing needs your login keychain), not from inside a Kora chat.
# Release notes: write docs/releases/v<next>.md on `dev` and commit it before shipping; without it step 2 writes a
# template and stops (fill it in on dev, commit, run ship again).
# Usage: pnpm ship [patch|minor|major|x.y.z]     (default: patch)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\033[1mkora\033[0m %s\n' "$*"; }
# Kora's tests and build need Node 24 (package.json engines); a Terminal whose PATH has another node (Homebrew's 22) failed the
# release gate on 2026-10-19. Put the nvm Node 24 first when it is installed.
NODE24="$(ls -d "$HOME"/.nvm/versions/node/v24.* 2>/dev/null | sort -V | tail -1)"
[ -z "$NODE24" ] || export PATH="$NODE24/bin:$PATH"
case "$(node -v 2>/dev/null)" in v24.*) ;; *) say "Node 24 is required (found $(node -v 2>/dev/null || echo none)); install it with nvm install 24 and run again"; exit 1 ;; esac
BUMP="${1:-patch}"

if [ -n "${KORA_ENV:-}${KORA_PANE_ID:-}" ]; then
  say "this is a Kora session: shipping signs with your keychain. Run it from Terminal:"
  say "  cd $ROOT && pnpm ship $BUMP"
  exit 1
fi
MAIN="$(git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{w=$2} /^branch refs\/heads\/main$/{print w}')"
DEV="$(git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{w=$2} /^branch refs\/heads\/dev$/{print w}')"
[ -n "$MAIN" ] || { say "no checkout has main"; exit 1; }
[ -n "$DEV" ] || { say "no checkout has dev"; exit 1; }
[ -z "$(git -C "$MAIN" status --porcelain --untracked-files=no)" ] || { say "$MAIN has uncommitted changes — main must stay clean"; exit 1; }

say "merging dev into main ($MAIN)"
git -C "$MAIN" merge --no-edit dev
git -C "$MAIN" push -q origin main
# The merge moved main's HEAD: catch its code graph up first, or the canary gate times out on a stale index (an
# explore over a big unindexed diff runs past the 7 s injection budget; seen 2026-10-19 with 157 files behind).
(cd "$MAIN" && pnpm install --frozen-lockfile >/dev/null)
(cd "$MAIN" && pnpm --filter @kora/runtime build >/dev/null && node packages/runtime/bin/kora.js ingest . >/dev/null 2>&1) || say "graph catch-up failed; the canary may time out once"
(cd "$MAIN" && pnpm release "$BUMP" --yes)
(cd "$MAIN" && bash scripts/release-app.sh --publish)

# The open-source repository follows releases: stage the release's public tree and commit it locally. Pushing it is
# a separate, deliberate step (docs/RELEASING.md, "Open source").
if (cd "$MAIN" && bash scripts/oss/export.sh); then
  say "public tree committed in ../kora-public; review it, then: (cd $MAIN && bash scripts/oss/export.sh --push)"
else
  say "the open-source export did not pass its gate; the app release is done, fix the export on dev"
fi

say "dev → $(git -C "$MAIN" log --oneline -1)"
git -C "$DEV" merge --ff-only main
say "shipped. Kora updates itself (or Check for Updates now); Kora Dev is Kora again — pnpm app:install:dev to rebuild it."
