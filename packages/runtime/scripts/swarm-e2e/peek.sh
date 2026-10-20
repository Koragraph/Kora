#!/bin/bash
# peek <tag> [n]: non-delta events per thread (compact) + server log tail
cd "${SWARM_E2E_DIR:-${TMPDIR:-/tmp}/kora-swarm-e2e}"
tag=$1; n=${2:-20}
for f in results/$tag/thread*.jsonl; do echo "== $f ($(wc -l <"$f") ev)"; python3 - "$f" "$n" <<'PY'
import json,sys
rows=[]
for l in open(sys.argv[1]):
  try: e=json.loads(l)
  except: continue
  t=e.get('type')
  if t=='content.delta': continue
  d={k:v for k,v in e.items() if k not in('threadId','seq','createdAt','eventId')}
  rows.append(json.dumps(d)[:230])
print('\n'.join(rows[-int(sys.argv[2]):]))
PY
done
echo "== server.log"; tail -6 home/server.log | cut -c1-220
