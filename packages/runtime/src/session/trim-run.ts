// `kora trim-run -- <program> <args…>` (SAV-D, 2026-10-15): run a test / build command unchanged and print its output trimmed.
//
// Why a wrapper: Claude Code reports a command that exits non-zero as PostToolUseFailure, which can attach context but cannot
// replace the output, so a failing test suite or build (the biggest outputs) was never trimmable. The PreToolUse hook puts this
// wrapper in front of a recognised runner (session/trim-wrap.ts); the model's own command text stays in the transcript.
//
// What it guarantees: the program gets the same cwd, environment, stdin and arguments; its exit code is returned as is (a signal
// becomes 128+n, as a shell reports it); SIGINT / SIGTERM / SIGHUP reach it. Output under COMPRESS_MIN_CHARS (or output the
// compressors cannot shrink by a fifth) is replayed chunk for chunk to the stream it came from, in order. Anything bigger is
// compressed with the same content-aware compressors as the PostToolUse path (output-compress.ts: errors, failures and warnings
// kept, passing-test noise gone) and printed with a footer naming a spill file that holds the FULL output, stdout and stderr
// interleaved in arrival order, byte for byte. Fail open: any error in the trimming replays the original.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compressBashOutput, IMPORTANT, KEEP_HEAD_LINES, KEEP_TAIL_LINES, MAX_INPUT_CHARS, COMPRESS_MIN_CHARS } from './output-compress';
import { toolOutDir, trimFooter, sweepOnce } from './bash-trim';
import { logCostSync } from '../util/cost-log';
import { winCommand } from '../util/win-exec';

/** Held in memory; past this the output goes to the spill file as it arrives and only a head / errors / tail view is built. */
export const MEM_LIMIT_BYTES = MAX_INPUT_CHARS;
const HUGE_MAX_ERROR_LINES = 80;

export interface TrimRunOptions {
  argv: string[];
  home: string;
  thread: string;
  /** below this many chars the output is replayed untouched (tests lower it) */
  minChars?: number;
  env?: NodeJS.ProcessEnv;
  stdout?: (b: Buffer) => void;
  stderr?: (b: Buffer) => void;
}

interface Chunk { fd: 1 | 2; buf: Buffer }

const sigNum = (sig: NodeJS.Signals | null): number => (sig ? ((require('node:os') as typeof import('node:os')).constants.signals[sig] ?? 0) : 0);

function spillPath(thread: string, home: string): string {
  const dir = toolOutDir(thread, home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepOnce(home); // spill files older than a week go, as for the daemon's own spills
  return path.join(dir, `${Date.now().toString(36)}-run${process.pid.toString(36)}.txt`);
}

/** First lines, the lines mentioning errors / failures / warnings (capped), last lines of a file too big to hold: one pass, bounded memory. */
function hugeView(file: string, size: number): { text: string; totalLines: number } {
  const fd = fs.openSync(file, 'r');
  const head: string[] = []; const tail: string[] = []; const imp: string[] = [];
  let lines = 0, carry = '';
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let pos = 0; pos < size;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const parts = (carry + buf.toString('utf8', 0, n)).split('\n');
      carry = parts.pop() ?? '';
      for (const l of parts) {
        lines++;
        if (head.length < KEEP_HEAD_LINES) head.push(l);
        else { tail.push(l); if (tail.length > KEEP_TAIL_LINES) { const old = tail.shift()!; if (imp.length < HUGE_MAX_ERROR_LINES && IMPORTANT.test(old)) imp.push(old.length > 300 ? `${old.slice(0, 300)}...` : old); } }
      }
    }
    if (carry) { lines++; if (head.length < KEEP_HEAD_LINES) head.push(carry); else tail.push(carry); }
  } finally { fs.closeSync(fd); }
  const omitted = Math.max(0, lines - head.length - tail.length);
  const text = [...head, `[... ${omitted} line${omitted === 1 ? '' : 's'} omitted${imp.length ? '; lines with error, fail or warning kept below' : ''} ...]`, ...imp, ...(imp.length ? ['[... end of kept lines ...]'] : []), ...tail].join('\n');
  return { text, totalLines: lines };
}

export function runTrimmed(opts: TrimRunOptions): Promise<number> {
  const out = opts.stdout ?? ((b: Buffer) => { process.stdout.write(b); });
  const err = opts.stderr ?? ((b: Buffer) => { process.stderr.write(b); });
  const env = opts.env ?? process.env;
  const min = opts.minChars ?? COMPRESS_MIN_CHARS;
  const [program, ...args] = opts.argv;
  if (!program) { err(Buffer.from('kora trim-run: no command given\n')); return Promise.resolve(2); }
  return new Promise<number>((resolve) => {
    const t = winCommand(program, args, env);
    let child;
    try {
      child = spawn(t.command, t.args, { stdio: ['inherit', 'pipe', 'pipe'], env, ...(t.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    } catch (e: any) { err(Buffer.from(`kora trim-run: ${e?.message ?? e}\n`)); resolve(127); return; }

    const chunks: Chunk[] = [];
    let held = 0, total = 0, spillFile: string | null = null, spillFd: number | null = null, spillOk = true;
    const toSpill = (c: Chunk): void => {
      if (spillFd == null) return;
      try { fs.writeSync(spillFd, c.buf); } catch { spillOk = false; }
    };
    const onData = (fd: 1 | 2) => (buf: Buffer): void => {
      total += buf.length;
      const c: Chunk = { fd, buf };
      if (spillFd != null) { toSpill(c); return; }
      chunks.push(c); held += buf.length;
      if (held > MEM_LIMIT_BYTES) {
        // too big to hold: everything so far goes to the spill file, and the rest follows as it arrives
        try {
          spillFile = spillPath(opts.thread, opts.home);
          spillFd = fs.openSync(spillFile, 'w', 0o600);
          for (const k of chunks) toSpill(k);
          chunks.length = 0; held = 0;
        } catch { spillFd = null; spillFile = null; /* keep holding: memory is the lesser evil than losing output */ }
      }
    };
    child.stdout!.on('data', onData(1));
    child.stderr!.on('data', onData(2));
    const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* gone */ } };
    const handlers: Array<[NodeJS.Signals, () => void]> = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => [s, forward(s)] as [NodeJS.Signals, () => void]);
    if (process.platform !== 'win32') for (const [s, h] of handlers) process.on(s, h);
    else process.on('SIGINT', handlers[0]![1]);

    let done = false;
    const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (done) return; done = true;
      for (const [s, h] of handlers) process.removeListener(s, h);
      const exit = code != null ? code : sig ? 128 + sigNum(sig) : 1;
      const replay = (): void => { for (const c of chunks) (c.fd === 1 ? out : err)(c.buf); };
      try {
        if (spillFd != null) {
          try { fs.closeSync(spillFd); } catch { /* best effort */ }
          const file = spillFile!;
          if (!spillOk) { resolve(exit); return; }
          const view = hugeView(file, total);
          const footer = trimFooter({ what: 'output', compressor: 'head-tail', note: `kept the first ${KEEP_HEAD_LINES} lines, the lines mentioning errors, failures or warnings, and the last ${KEEP_TAIL_LINES}`, rawChars: total, totalLines: view.totalLines, file });
          out(Buffer.from(`${view.text}${footer}\n`));
          logCostSync({ k: 'bash-trim', ts: Date.now(), thread: opts.thread, bytes: total, lines: view.totalLines, errors: view.text.split('\n').filter((l) => IMPORTANT.test(l)).length, saved: Math.floor(Math.max(0, total - view.text.length - footer.length) / 4), c: 'head-tail@run' }, opts.home);
          resolve(exit); return;
        }
        if (total < min) { replay(); resolve(exit); return; }
        const merged = Buffer.concat(chunks.map((c) => c.buf));
        const text = merged.toString('utf8');
        const res = compressBashOutput(text, { command: opts.argv.join(' '), minChars: min });
        if (!res) { replay(); resolve(exit); return; }
        let file: string;
        try { file = spillPath(opts.thread, opts.home); fs.writeFileSync(file, merged, { mode: 0o600 }); } catch { replay(); resolve(exit); return; }
        const footer = trimFooter({ what: 'output', compressor: res.compressor, note: res.note, rawChars: text.length, totalLines: res.totalLines, file });
        out(Buffer.from(`${res.text}${footer}\n`));
        logCostSync({ k: 'bash-trim', ts: Date.now(), thread: opts.thread, bytes: text.length, lines: res.totalLines, errors: res.keptErrorLines, saved: Math.floor(Math.max(0, text.length - res.text.length - footer.length) / 4), c: `${res.compressor}@run` }, opts.home);
        resolve(exit);
      } catch {
        try { replay(); } catch { /* nothing more to do */ }
        resolve(exit);
      }
    };
    child.on('error', (e: any) => {
      if (done) return;
      done = true;
      for (const [s, h] of handlers) process.removeListener(s, h);
      err(Buffer.from(`kora trim-run: could not start ${program}: ${e?.code === 'ENOENT' ? 'command not found' : e?.message ?? e}\n`));
      resolve(e?.code === 'ENOENT' ? 127 : 126);
    });
    // 'close' fires after the pipes ended: every chunk is in
    child.on('close', (code, sig) => finish(code, sig));
  });
}
