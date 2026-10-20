// Rate limits of an `opencode run` child, found fast. OpenCode retries a 429 by itself, forever, and `run --format json`
// prints nothing while it does (found live 2026-10-08: a blob sat "working" for 13 minutes). The retry IS visible in
// three places, all read here:
//   1. stdout JSON `error` events (opencode-parse.ts, already mapped),
//   2. stderr text (a wrapper or a provider SDK complaining),
//   3. opencode's own log file, which records the failure about a second after the request:
//        timestamp=2026-10-08T22:59:52.845Z level=ERROR run=f46f008b message="stream error" providerID=opencode
//        modelID=space-bunny-free session.id=ses_… small=false agent=build mode=primary
//        error.error="AI_APICallError: Rate limit exceeded. Please try again later."
//      (`small=true agent=title` lines are the session-title helper failing and say nothing about the turn).
// Pure functions + one tail reader, so the fixtures in opencode-limits.test.ts cover them without a process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 429 / quota / free-limit wording (same family as server/swarm.ts RATE_LIMIT_RE, plus opencode's retry texts). */
export const OPENCODE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|Free limit reached|Free usage exceeded|FreeUsageLimitError|resource.?exhausted|quota exceeded|insufficient[_ ]quota|usage limit/i;

export interface LogLimitHit { at: number; model: string; sessionId: string | null; line: string }

/** Where `opencode` writes its log (XDG data dir; override for tests). */
export function opencodeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'log', 'opencode.log');
}

/**
 * Rate-limit failures of the MAIN agent in a chunk of opencode log text, newest last. `model` filters on `modelID`
 * (the id after the provider slash), `sessionId` on `session.id` when known, `since` drops older lines.
 */
export function scanOpencodeLog(text: string, o: { model?: string | null; sessionId?: string | null; since?: number } = {}): LogLimitHit[] {
  const hits: LogLimitHit[] = [];
  const bare = o.model ? o.model.replace(/^[^/]+\//, '').replace(/:free$/i, '') : null;
  for (const line of text.split('\n')) {
    if (!line.includes('level=ERROR') || !/message="?stream error/.test(line)) continue;
    if (/\bsmall=true\b/.test(line) || /\bagent=title\b/.test(line)) continue;
    const err = /error\.error="([^"]*)"/.exec(line)?.[1] ?? line;
    if (!OPENCODE_LIMIT_RE.test(err)) continue;
    const ts = /timestamp=(\S+)/.exec(line)?.[1];
    const at = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(at)) continue;
    if (o.since !== undefined && at < o.since) continue;
    const model = /modelID=(\S+)/.exec(line)?.[1] ?? '';
    if (bare && model && model !== bare) continue;
    const sid = /session\.id=(\S+)/.exec(line)?.[1] ?? null;
    if (o.sessionId && sid && sid !== o.sessionId) continue;
    hits.push({ at, model, sessionId: sid, line: line.slice(0, 400) });
  }
  return hits;
}

/** Reads what was appended to a file since `offset` (bounded), returns the text and the new offset. Never throws. */
export function readAppended(file: string, offset: number, maxBytes = 512 * 1024): { text: string; offset: number } {
  try {
    const size = fs.statSync(file).size;
    if (size < offset) offset = 0; // rotated
    if (size === offset) return { text: '', offset };
    const start = Math.max(offset, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return { text: buf.toString('utf8'), offset: size };
    } finally { fs.closeSync(fd); }
  } catch { return { text: '', offset }; }
}

export function currentSize(file: string): number { try { return fs.statSync(file).size; } catch { return 0; } }

/** True when stderr text reads as a rate limit (a provider SDK or a wrapper printing the 429). */
export function stderrLooksRateLimited(stderr: string): boolean { return OPENCODE_LIMIT_RE.test(stderr); }

/** What the person reads. `model` is the friendly slug when known. */
export function rateLimitMessage(model: string | null): string {
  const who = model ? model.replace(/^[^/]+\//, '').replace(/:free$/i, '') : 'This free model';
  return `${who} is rate-limited right now (free models have shared quotas). I stopped waiting on it - continue on another free model, or try again in a few minutes.`;
}
