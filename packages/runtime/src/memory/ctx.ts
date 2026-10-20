import type { DatabaseSync } from 'node:sqlite';
import type { Embedder, Extractor } from './types';
import { extractJson } from './text';

export interface Ctx {
  db: DatabaseSync;
  now: () => number;
  extractor: Extractor;
  embedder?: Embedder;
  extractTimeoutMs: number;
  closed: boolean;
}

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Yield to the event loop so the daemon's websocket keeps breathing. */
export const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Time-slicer: `await slice()` in a loop yields at most every ~15 ms of work. */
export function slicer(ms = 15): () => Promise<void> {
  let last = Date.now();
  return async () => {
    if (Date.now() - last >= ms) {
      await yieldNow();
      last = Date.now();
    }
  };
}

/**
 * Ask the extractor for JSON and validate it. ONE overall deadline (`extractTimeoutMs`) covers every attempt, so the
 * caller (the memory worker host) can promise a bound. A thrown error or a timeout is final - the extractor chain
 * has already tried everything it has, and asking again would only double the load on a free model. Only a reply that
 * came back but was not valid JSON gets one retry with a stricter nudge, and only while enough of the deadline is left.
 * Returns null on any failure so callers can skip safely.
 */
export async function askJson<T>(
  ctx: Ctx,
  req: { system: string; prompt: string; maxTokens: number },
  validate: (raw: unknown) => T | null,
): Promise<T | null> {
  const deadline = Date.now() + ctx.extractTimeoutMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left < (attempt === 0 ? 1 : 5_000)) return null;
    const prompt = attempt === 0 ? req.prompt : `${req.prompt}\n\nYour previous reply was not valid. Reply with ONLY the JSON object, no prose, no code fences.`;
    let timer: NodeJS.Timeout | undefined;
    try {
      const raw = await Promise.race([
        ctx.extractor({ ...req, prompt }),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('extractor timeout')), left);
        }),
      ]);
      const parsed = validate(extractJson(raw));
      if (parsed !== null) return parsed;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return null;
}
