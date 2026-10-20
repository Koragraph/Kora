// Helpers shared by the memory tests (not part of the runtime API).
import { DAY_MS, type Extractor } from './index';

export const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

export function clock(start = T0) {
  let t = start;
  return { now: () => t, advanceDays: (d: number) => void (t += d * DAY_MS), set: (v: number) => void (t = v) };
}

/** `F#` alias of the existing-fact line containing `needle` in an ingest prompt. */
export function aliasOf(prompt: string, needle: string): string {
  const line = prompt.split('\n').find((l) => /^F\d+ \[/.test(l) && l.toLowerCase().includes(needle.toLowerCase()));
  return line ? line.split(' ')[0] : 'F99';
}

export const userOf = (prompt: string): string => /USER said:\n([\s\S]*?)\n\nASSISTANT/.exec(prompt)?.[1] ?? '';

export type Script = (user: string, prompt: string) => unknown;

/** Deterministic fake extractor: `script(userText, prompt)` returns an ops object (or a raw string / throws). */
export function fakeExtractor(script: Script): Extractor & { calls: number } {
  const fn = (async (req: { system: string; prompt: string; maxTokens: number }) => {
    fn.calls++;
    const out = script(userOf(req.prompt), req.prompt);
    return typeof out === 'string' ? out : JSON.stringify(out);
  }) as Extractor & { calls: number };
  fn.calls = 0;
  return fn;
}

export const ops = (...o: object[]) => ({ ops: o });

let n = 0;
export const turn = (blobId: string, userText: string, at: number, threadId = 't1') => ({
  blobId,
  threadId,
  messageId: `m${++n}`,
  userText,
  assistantText: 'Got it.',
  at,
});
