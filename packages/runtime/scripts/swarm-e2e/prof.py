# Analyze a V8 .cpuprofile: find the longest contiguous non-idle stretches (event-loop stalls) and, inside them,
# the heaviest stacks by self time. Usage: python3 prof.py <file.cpuprofile> [minStallMs]
import json,sys,collections
p=json.load(open(sys.argv[1])); MIN=float(sys.argv[2]) if len(sys.argv)>2 else 1500
nodes={n['id']:n for n in p['nodes']}
parent={}
for n in p['nodes']:
  for c in n.get('children',[]): parent[c]=n['id']
def name(i):
  cf=nodes[i]['callFrame']; u=cf['url'].split('/')[-1]; return f"{cf['functionName'] or '(anon)'} {u}:{cf['lineNumber']+1}"
def stack(i,depth=14):
  out=[]
  while i in nodes and len(out)<depth:
    nm=nodes[i]['callFrame']['functionName']
    if nm in('(root)',): break
    out.append(name(i)); i=parent.get(i)
  return out
samples=p['samples']; deltas=p['timeDeltas']
t=p['startTime']; times=[]
for d in deltas: t+=d; times.append(t)
idle={i for i,n in nodes.items() if n['callFrame']['functionName'] in('(idle)','(program)','(garbage collector)')}
# stalls = runs of consecutive non-idle samples
runs=[];start=None;last=None
for s,tm in zip(samples,times):
  if nodes[s]['callFrame']['functionName']=='(idle)':
    if start is not None and (last-start)/1000>=MIN: runs.append((start,last))
    start=None
  else:
    if start is None: start=tm
    last=tm
print('stalls >=',MIN,'ms:',[(round((b-a)/1000)) for a,b in runs])
for a,b in sorted(runs,key=lambda r:r[0]-r[1])[:4]:
  self_=collections.Counter(); stk=collections.Counter()
  for s,tm in zip(samples,times):
    if a<=tm<=b:
      self_[name(s)]+=1; st=stack(s); 
      # attribute to the first frame inside kora code
      k=[f for f in st if ('dist' in f or '.js' in f) and 'node:' not in f]
      stk[' < '.join(st[:6])]+=1
  tot=sum(self_.values())
  print(f'\n=== stall {round((b-a)/1000)} ms, {tot} samples')
  for k,v in self_.most_common(8): print(f'  self {v*100//tot:3d}% {k}')
  for k,v in stk.most_common(5): print(f'  stack {v*100//tot:3d}% {k[:400]}')
