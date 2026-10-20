#!/usr/bin/env bash
# release.sh — cut a Kora release: bump the version, commit, tag v<version> and push. The tag push starts
# .github/workflows/release.yml, which builds, signs, notarizes and publishes the release on the public repo;
# installed copies download it within the hour and install it on their next restart.
#
# Run from a clean `main` that matches origin/main (koraplex/kora). The version lives in
# packages/runtime/package.json (the app, web client, daemon and CLI all read it from there).
# Release notes are public: docs/releases/v<version>.md becomes the release text users see. Without one this script
# writes a template and stops so you can fill it in; --no-notes ships "Bug fixes and improvements." instead.
#
# Usage: pnpm release <x.y.z | patch | minor | major> [--no-notes] [--yes]
#   pnpm release patch        0.2.0 → 0.2.1
#   pnpm release 0.3.0-beta.1 a prerelease: published, but installed copies stay on the latest full release
#
# Release gates: runs pnpm typecheck, pnpm test, and pnpm canary before bumping/tagging.
# Set KORA_SKIP_RELEASE_CHECKS=1 (or KORA_SKIP_CHECKS=1) to skip these checks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say() { printf '\033[1mkora\033[0m %s\n' "$*"; }
die() { printf '\033[1mkora\033[0m %s\n' "$*" >&2; exit 1; }

BUMP=""
NO_NOTES=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-notes) NO_NOTES=1 ;;
    --yes | -y) YES=1 ;;
    -*) die "unknown flag $1" ;;
    *) BUMP="$1" ;;
  esac
  shift
done
[ -n "$BUMP" ] || die "usage: pnpm release <x.y.z | patch | minor | major> [--no-notes] [--yes]"

[ "$(git branch --show-current)" = main ] || die "releases are cut from main (this is $(git branch --show-current))"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "main has uncommitted changes"
git fetch -q origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
  die "main and origin/main differ — push or pull first, so the tag points at what is on GitHub"

CURRENT="$(node -p "require('./packages/runtime/package.json').version")"
NEXT="$(node -e '
  const [current, bump] = process.argv.slice(1);
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) { console.error(`cannot parse version ${current}`); process.exit(1); }
  const [maj, min, pat] = m.slice(1).map(Number);
  const next = bump === "major" ? `${maj + 1}.0.0` : bump === "minor" ? `${maj}.${min + 1}.0`
    : bump === "patch" ? `${maj}.${min}.${pat + 1}` : bump;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) { console.error(`not a version: ${next}`); process.exit(1); }
  console.log(next);
' "$CURRENT" "$BUMP")"
[ "$NEXT" != "$CURRENT" ] || die "the version is already $CURRENT"
git rev-parse -q --verify "refs/tags/v$NEXT" >/dev/null && die "tag v$NEXT already exists"

NOTES="docs/releases/v$NEXT.md"
if [ ! -f "$NOTES" ] && [ "$NO_NOTES" = 0 ]; then
  mkdir -p docs/releases
  LAST_TAG="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
  {
    echo "<!-- Release notes for Kora $NEXT. Users read this on GitHub and in the app: say what changed for them."
    echo "     Delete this comment. Commits since ${LAST_TAG:-the start}, for reference only:"
    git log --no-merges --format='     - %s' ${LAST_TAG:+"$LAST_TAG"..HEAD} | head -40
    echo "-->"
    echo
    echo "## What's new"
    echo
    echo "- "
    echo
    echo "## Fixes"
    echo
    echo "- "
  } >"$NOTES"
  die "wrote $NOTES — fill it in, commit it on main, push, then run this again (or pass --no-notes)"
fi
if [ -f "$NOTES" ] && /usr/bin/grep -q '<!--' "$NOTES"; then
  die "$NOTES still has the template comment — finish the notes first"
fi
if [ -f "$NOTES" ] && [ -n "$(git status --porcelain -- "$NOTES")" ]; then
  die "$NOTES is not committed — commit and push it first"
fi

if [ "${KORA_SKIP_RELEASE_CHECKS:-0}" = 1 ] || [ "${KORA_SKIP_CHECKS:-0}" = 1 ]; then
  say "skipping pre-release checks (KORA_SKIP_RELEASE_CHECKS is set)"
else
  say "running pre-release gates: typecheck, test, canary"
  pnpm typecheck || die "pre-release gate failed: pnpm typecheck"
  pnpm test || die "pre-release gate failed: pnpm test"
  pnpm canary || die "pre-release gate failed: pnpm canary"
fi

say "release $CURRENT → $NEXT (tag v$NEXT)"
if [ "$YES" = 0 ]; then
  printf 'Push it? CI then builds, notarizes and publishes it to every Kora user. [y/N] '
  read -r answer
  case "$answer" in y | Y | yes) ;; *) die "stopped" ;; esac
fi

node -e '
  const fs = require("node:fs"); const file = "packages/runtime/package.json";
  const text = fs.readFileSync(file, "utf8");
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${process.argv[1]}$2`);
  if (next === text) process.exit(1);
  fs.writeFileSync(file, next);
' "$NEXT" || die "could not update packages/runtime/package.json"
git add packages/runtime/package.json
git commit -q -m "Release $NEXT"
git tag -a "v$NEXT" -m "Kora $NEXT"
git push -q origin main "v$NEXT"
SOURCE_REPO="$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')"
say "pushed v$NEXT — the build (≈10–20 min): https://github.com/$SOURCE_REPO/actions/workflows/release.yml"
say "when it finishes: https://github.com/agilkatakam/kora/releases/tag/v$NEXT"
