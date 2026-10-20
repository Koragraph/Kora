// Codex writes every session to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<stamp>-<thread id>.jsonl`, and after
// each model request a `token_count` event: the last request's tokens (= what is in the context window), the model's
// effective context window, and the account's rate-limit snapshot. `codex exec --json` prints none of that, so the
// CodexDriver reads it back from the rollout once a turn's process has exited. Local file reads only, async, bounded.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexRequestUsages, codexRolloutUsage, type CodexRequestUsage } from '../usage';
import type { TokenUsage, UsageLimitsReport } from '../events';

const TAIL_BYTES = 512 * 1024;
/** How far back the cost log reads when the tail starts after the last logged request. */
const FULL_READ_BYTES = 32 * 1024 * 1024;

export function codexHomeDir(env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

async function listDesc(dir: string): Promise<string[]> {
  try { return (await fs.readdir(dir)).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a)); } catch { return []; }
}

/** The rollout file of Codex thread `threadId`, newest day folders first (a resumed thread keeps its first file). */
export async function findCodexRollout(home: string, threadId: string, maxDays = 60): Promise<string | null> {
  if (!/^[\w-]{8,}$/.test(threadId)) return null;
  const root = path.join(home, 'sessions');
  let seen = 0;
  for (const y of await listDesc(root)) {
    for (const m of await listDesc(path.join(root, y))) {
      for (const d of await listDesc(path.join(root, y, m))) {
        if (++seen > maxDays) return null;
        const dir = path.join(root, y, m, d);
        let files: string[] = [];
        try { files = await fs.readdir(dir); } catch { continue; }
        const hit = files.find((f) => f.endsWith(`${threadId}.jsonl`));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}

/** The last `TAIL_BYTES` of a file as lines (the first, possibly cut, line dropped). */
export async function readTailLines(file: string, bytes = TAIL_BYTES): Promise<string[]> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await fh.close();
  }
}

/** Context occupancy + rate limits from a Codex thread's rollout, and its model requests (for the cost log); nulls and
 *  no requests when the file or the events are missing. */
export async function readCodexRolloutUsage(file: string, requestsSince = 0): Promise<{ context: TokenUsage | null; limits: UsageLimitsReport | null; requests: CodexRequestUsage[] }> {
  try {
    const lines = await readTailLines(file);
    let requests = codexRequestUsages(lines);
    // A long turn (big tool outputs) can push its first requests out of the tail: read further back, bounded.
    if (requestsSince > 0 && (requests[0]?.ts ?? Infinity) > requestsSince && (await fs.stat(file)).size > TAIL_BYTES) requests = codexRequestUsages(await readTailLines(file, FULL_READ_BYTES));
    return { ...codexRolloutUsage(lines), requests };
  } catch { return { context: null, limits: null, requests: [] }; }
}
