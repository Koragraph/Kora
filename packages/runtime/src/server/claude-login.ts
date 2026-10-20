// "Log in to Claude" from inside the app. A Mac without the Claude Code CLI could not sign in at all (chat runs on the
// copy the Agent SDK bundles, but logging in meant installing the CLI first). The bundled binary has the same
// `auth login` command: it opens the browser itself, listens on a localhost callback, and also prints a manual URL
// whose page shows a code to paste back. This runs that command as a child of the daemon (the CLI when installed,
// else the bundled copy — both write the same login the chat lane reads), exposes its URL, forwards a pasted code to
// its stdin, and reports how it ended. One login at a time; the child is killed by its own PID only.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { winCommand } from '../util/win-exec';
import { scrubChildEnv } from '../util/child-env';
import { killChild } from '../util/kill-child';

export type ClaudeLoginPhase = 'idle' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface ClaudeLoginState {
  phase: ClaudeLoginPhase;
  /** The sign-in page (the manual fallback URL the CLI prints); null until it is printed. */
  url: string | null;
  /** A plain one-line reason when the login failed. */
  message: string | null;
  /** Which binary runs the login. */
  via: 'cli' | 'bundled' | null;
  startedAt: number | null;
}

export interface ClaudeLoginDeps {
  /** The `claude` to run: the CLI on the search path, else Kora's bundled copy; null when there is neither. */
  resolveBinary: () => Promise<{ bin: string; via: 'cli' | 'bundled' } | null>;
  spawn?: typeof nodeSpawn;
  env?: NodeJS.ProcessEnv;
  /** Give up (and kill the child) after this long; the browser step is the user's, so it is generous. */
  timeoutMs?: number;
  now?: () => number;
}

export interface ClaudeLogin {
  start(): Promise<ClaudeLoginState>;
  status(): ClaudeLoginState;
  submitCode(code: string): ClaudeLoginState;
  cancel(): ClaudeLoginState;
}

const URL_RE = /https:\/\/\S+/;

/** The sign-in URL the CLI prints ("If the browser didn't open, visit: https://…"), or null. */
export function loginUrlFrom(output: string): string | null {
  const line = output.split('\n').find((l) => /visit:/i.test(l) && URL_RE.test(l)) ?? output.split('\n').find((l) => URL_RE.test(l));
  const m = line ? URL_RE.exec(line) : null;
  return m ? m[0].replace(/[).,]+$/, '') : null;
}

/** A failed login's last meaningful line, without ANSI escapes or the "Paste code here" prompt. */
export function loginFailureFrom(output: string, code: number | null): string {
  const lines = output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.replace(/Paste code here if prompted >/i, '').trim())
    .filter((l) => l && !URL_RE.test(l) && !/^Opening browser/i.test(l));
  const last = lines.at(-1);
  // A pasted code the token exchange refused (expired, or copied only in part) reads as a bare HTTP 400.
  if (last && /status code 400|invalid_grant/i.test(last)) return 'That code was not accepted: it may have expired or been copied only in part. Start again.';
  if (!last) return `The login ended without signing in (exit ${code ?? 'signal'}).`;
  const line = last.slice(0, 300);
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

export function makeClaudeLogin(deps: ClaudeLoginDeps): ClaudeLogin {
  const spawn = deps.spawn ?? nodeSpawn;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;
  let state: ClaudeLoginState = { phase: 'idle', url: null, message: null, via: null, startedAt: null };
  let child: ChildProcess | null = null;
  let output = '';
  let timer: NodeJS.Timeout | null = null;
  let cancelled = false;

  const snapshot = (): ClaudeLoginState => ({ ...state });
  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const kill = (c: ChildProcess) => { try { killChild(c); } catch { /* gone */ } };

  return {
    async start() {
      if (state.phase === 'waiting' && child) return snapshot();
      const found = await deps.resolveBinary();
      if (!found) {
        state = { phase: 'failed', url: null, message: 'Claude Code was not found, not even the copy bundled with Kora. Reinstall Kora, or install Claude Code.', via: null, startedAt: now() };
        return snapshot();
      }
      output = '';
      cancelled = false;
      state = { phase: 'waiting', url: null, message: null, via: found.via, startedAt: now() };
      let c: ChildProcess;
      try {
        const w = winCommand(found.bin, ['auth', 'login']);
        c = spawn(w.command, w.args, { env: scrubChildEnv(deps.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments });
      } catch (e: any) {
        state = { ...state, phase: 'failed', message: `Could not start the login (${String(e?.message ?? e)}).` };
        return snapshot();
      }
      child = c;
      const onData = (b: Buffer) => {
        output = (output + b.toString('utf8')).slice(-20_000);
        if (!state.url && child === c) {
          const url = loginUrlFrom(output);
          if (url) state = { ...state, url };
        }
      };
      c.stdout?.on('data', onData);
      c.stderr?.on('data', onData);
      c.stdin?.on('error', () => { /* the child exited before a pasted code arrived */ });
      c.on('error', (e) => {
        if (child !== c) return;
        child = null; stopTimer();
        state = { ...state, phase: 'failed', message: `Could not run the login (${e.message}).` };
      });
      c.on('exit', (code) => {
        if (child !== c) return;
        child = null; stopTimer();
        if (cancelled) state = { ...state, phase: 'cancelled', message: null };
        else if (code === 0) state = { ...state, phase: 'done', message: null };
        else state = { ...state, phase: 'failed', message: loginFailureFrom(output, code) };
      });
      timer = setTimeout(() => {
        if (child !== c) return;
        state = { ...state, phase: 'failed', message: 'The sign-in was not finished within 10 minutes. Try again.' };
        child = null;
        kill(c);
      }, timeoutMs);
      timer.unref?.();
      // Give the CLI a moment to print its URL so the first answer can already carry it.
      for (let i = 0; i < 20 && state.phase === 'waiting' && !state.url; i++) await new Promise((r) => setTimeout(r, 100));
      return snapshot();
    },
    status: snapshot,
    submitCode(code: string) {
      const clean = code.trim();
      if (state.phase === 'waiting' && child?.stdin && clean && clean.length < 4096 && !/[\r\n]/.test(clean)) {
        child.stdin.write(`${clean}\n`);
      }
      return snapshot();
    },
    cancel() {
      const c = child;
      if (c && state.phase === 'waiting') {
        cancelled = true;
        kill(c);
      }
      return snapshot();
    },
  };
}
