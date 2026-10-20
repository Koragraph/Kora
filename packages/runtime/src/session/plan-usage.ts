// "How much of my plan is left?" — read on demand for Settings → Usage and the composer's usage line. Each provider is
// asked through its own local CLI, the same way the model catalog is (list-models.ts / the ui-server's codexModels):
//   claude → a live chat session's control channel, else a short idle `query()` (starts `claude`, sends no turn);
//            the SDK's experimental /usage request makes one call to the claude.ai usage endpoint.
//   codex  → `codex app-server` `account/rateLimits/read`.
// Never a turn, never tokens, never a credential read by Kora. Bounded; any failure resolves to null.
import { spawn } from 'node:child_process';
import { winCommand } from '../util/win-exec';
import type { UsageLimitsReport } from './events';
import { engineSpawnEnv, resolveEngineBinary } from '../detect/engine-binary';
import { idleProbeOptions } from './list-models';
import { claudeUsageReport, codexAppServerRateLimitsReport } from './usage';

export async function probeClaudePlanUsage(timeoutMs = 12_000): Promise<UsageLimitsReport | null> {
  let sdk: any;
  try { sdk = require('@anthropic-ai/claude-agent-sdk'); } catch { return null; }
  if (typeof sdk?.query !== 'function') return null;
  const ac = new AbortController();
  async function* idlePrompt(): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      if (ac.signal.aborted) return resolve();
      ac.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  let q: any;
  try { q = sdk.query({ prompt: idlePrompt(), options: idleProbeOptions(ac, 'default') }); } catch { return null; }
  try {
    if (typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') return null;
    const resp = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), timeoutMs); t.unref?.(); }),
    ]);
    return resp ? claudeUsageReport(resp) : null;
  } catch {
    return null;
  } finally {
    try { ac.abort(); } catch { /* best effort */ }
    try { const r = q?.return?.(undefined); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* best effort */ }
  }
}

/** `command` defaults to the Codex engine's own binary resolution: the daemon's bare PATH (/usr/bin:/bin) cannot see `codex` (ENOENT, aud3 S2-1). */
export function probeCodexPlanUsage(timeoutMs = 8_000, command: string = resolveEngineBinary('codex') ?? 'codex'): Promise<UsageLimitsReport | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { const env = engineSpawnEnv(process.env, command); const w = winCommand(command, ['app-server'], env); child = spawn(w.command, w.args, { stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments }); } catch { resolve(null); return; }
    let done = false;
    let buf = '';
    const finish = (r: UsageLimitsReport | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    const send = (o: unknown) => { try { child.stdin?.write(`${JSON.stringify(o)}\n`); } catch { finish(null); } };
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null });
        else if (msg?.id === 2) { finish(msg.result ? codexAppServerRateLimitsReport(msg.result) : null); return; }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'kora', title: null, version: '0.0.0' }, capabilities: null } });
  });
}
