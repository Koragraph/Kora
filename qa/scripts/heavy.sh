#!/bin/bash
# Run a heavy command (build, vitest, tsc) under a shared slot lock: at most KORA_QA_HEAVY_SLOTS (default 2) at once.
# Refuses to start below 4 GB free disk. Usage: qa/scripts/heavy.sh <cmd> [args…]
set -u
SLOTS=${KORA_QA_HEAVY_SLOTS:-2}
LOCKDIR=${KORA_QA_LOCKS:-/tmp/kora-qa-locks}
mkdir -p -m 700 "$LOCKDIR"
# Shared /tmp path: it must be a real directory owned by us (another user could pre-create or symlink it).
if [ -L "$LOCKDIR" ] || [ ! -d "$LOCKDIR" ] || [ ! -O "$LOCKDIR" ]; then
  echo "heavy.sh: $LOCKDIR is not a directory you own — set KORA_QA_LOCKS to a private dir" >&2
  exit 71
fi
chmod 700 "$LOCKDIR" 2>/dev/null || true

free_kb=$(df -k "${TMPDIR:-/tmp}" | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt $((4 * 1024 * 1024)) ]; then
  echo "heavy.sh: refusing to run — less than 4 GB free disk ($((free_kb / 1024)) MB)" >&2
  exit 70
fi

slot=""
while [ -z "$slot" ]; do
  for i in $(seq 1 "$SLOTS"); do
    d="$LOCKDIR/heavy-$i"
    if mkdir "$d" 2>/dev/null; then
      echo $$ > "$d/pid"; slot="$d"; break
    fi
    # reclaim a slot whose owner died
    owner=$(cat "$d/pid" 2>/dev/null || echo "")
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$d"; fi
  done
  [ -z "$slot" ] && sleep 2
done
trap 'rm -rf "$slot"' EXIT INT TERM
"$@"
