// The return-time distribution on disk: <KORA_HOME>/cache-warm.json (see policy.ts parseReturnDist for the shape). The lead
// computes it from observed cost.jsonl gaps; absent or damaged = the bundled default. Re-read at most once a minute.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RETURN_DIST, type ReturnDist, parseReturnDist } from './policy';

export function distFilePath(home: string): string { return path.join(home, 'cache-warm.json'); }

export function makeDistLoader(file: string, now: () => number = Date.now, everyMs = 60_000): () => ReturnDist {
  let at = -Infinity; let cur: ReturnDist = DEFAULT_RETURN_DIST;
  return () => {
    const t = now();
    if (t - at < everyMs) return cur;
    at = t;
    try { cur = parseReturnDist(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { cur = DEFAULT_RETURN_DIST; }
    return cur;
  };
}
