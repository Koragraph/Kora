// Builds the Blobs runtime for the daemon (docs/bots/ARCH.md section 3): the profile store, the memory worker, the
// extractor chain wired to the swarm's free models, and the OpenCode chat-engine hooks. Exposed as `handle.blobs`
// (daemon.ts), passed to the SessionManager (`ManagerRuntime.blobs`) and to the ui-server (`UiHost.blobs`).
import path from 'node:path';
import { execFile } from 'node:child_process';
import { winCommand } from '../util/win-exec';
import { BlobStore } from '../blobs/store';
import { BlobRuntimeImpl } from '../blobs/runtime';
import { memoryHost } from '../blobs/memory-host';
import { makeClaudeSignedIn, makeOneShot, makeWarmClaude, runClaudeHaiku, runOpencodeFast, stubExtractor } from '../blobs/extractor';
import { blobsStoreDir } from '../blobs/home';
import { cooldownUntil } from './swarm';
import { providerOfModel } from './swarm-health';
import { loadConfig } from '../config';
import { agentCommand } from '../detect/agents';
import type { OpencodeDeps } from '../session/session-driver';
import type { Runtime } from './workspace';
import { log } from './log';

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The env a chat turn on a free model needs: the swarm worker's provider env, minus everything that is worker-only. */
export function opencodeChatEnv(model: string, apiKey: (provider: string) => string | null): Record<string, string> {
  const { swarmPaneEnv } = require('./swarm-opencode') as typeof import('./swarm-opencode');
  const provider = providerOfModel(model);
  const env = swarmPaneEnv({ provider, model, taskId: 'blob-chat', reportPath: '' } as never, { apiKey: apiKey(provider) });
  for (const k of Object.keys(env)) if (/^KORA_/.test(k) || k === 'OPENCODE_CONFIG_DIR' || k === 'OPENCODE_PERMISSION') delete env[k];
  return env;
}

export function makeOpencodeDeps(rt: Runtime): OpencodeDeps {
  const apiKey = (p: string): string | null => { if (p === 'zen' || p === 'ollama' || p === 'lmstudio') return null; try { return (require('./swarm-secrets') as typeof import('./swarm-secrets')).getSwarmKey(p as never); } catch { return null; } };
  return {
    binary: () => { try { return (require('./swarm-install') as typeof import('./swarm-install')).resolveOpencodeBinary().path ?? null; } catch { return null; } },
    pickModel: (exclude = []) => { try { return rt.swarm.pickModel(exclude)?.id ?? null; } catch { return null; } },
    env: (model) => { try { return opencodeChatEnv(model, apiKey); } catch (e: any) { log(`blobs: opencode env unavailable: ${e?.message ?? e}`); return {}; } },
    markCooling: (model, reason) => { try { rt.swarm.deps.health.markCooling(model, cooldownUntil(model, 'rate-limited', Date.now()), reason); } catch { /* advisory */ } },
  };
}

/** A model its provider says does not exist (any more): off the swarm catalog's rotation for a day (health `gone`). */
function markModelGone(rt: Runtime, model: string): void {
  try { rt.swarm.deps.health.markCooling(model, Date.now() + 24 * 3_600_000, 'model gone (reported by the provider)', { gone: true }); } catch { /* advisory */ }
}

export function makeBlobRuntime(rt: Runtime): BlobRuntimeImpl {
  const store = new BlobStore();
  const memory = memoryHost(path.join(blobsStoreDir(), 'memory.db'));
  const oc = makeOpencodeDeps(rt);
  const stub = process.env.KORA_BLOBS_EXTRACTOR === 'stub';
  const warmClaude = makeWarmClaude(agentCommand('claude'));
  const claudeSignedIn = stub ? () => false : makeClaudeSignedIn(async () => {
    if (process.env.ANTHROPIC_API_KEY) return true;
    return new Promise<boolean>((resolve) => {
      try {
        const w = winCommand(agentCommand('claude'), ['auth', 'status', '--json']);
        execFile(w.command, w.args, { timeout: 15_000, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments }, (_err, stdout) => {
          try { resolve(JSON.parse(String(stdout ?? ''))?.loggedIn === true); } catch { resolve(false); }
        });
      } catch { resolve(false); }
    });
  });
  const oneShot = stub
    ? Object.assign(async (prompt: string) => ({ text: stubExtractor(prompt), model: 'stub' }), { claudeCallsToday: () => 0 })
    : makeOneShot({
      // Chat text goes to a free third-party endpoint: only with the user's swarm consent (ruling 2).
      consent: () => { try { const c = loadConfig().swarm.consent; return !!c && c.noticeVersion >= (rt.swarmSetup as unknown as { requiredNotice(): number }).requiredNotice(); } catch { return false; } },
      opencodePath: () => oc.binary(),
      pickFree: (exclude) => { const id = oc.pickModel(exclude); return id ? { id, env: oc.env(id) } : null; },
      runOpencode: (i) => runOpencodeFast(i),
      markCooling: (m) => oc.markCooling(m, 'rate-limited'),
      markGone: (m) => markModelGone(rt, m),
      claudeFallback: () => store.memorySettings().claudeFallback,
      claudeReady: claudeSignedIn,
      runClaudeWarm: (prompt, budgetMs) => warmClaude.ask(prompt, budgetMs),
      prewarmClaude: () => warmClaude.warm(),
      runClaude: (prompt, budgetMs) => runClaudeHaiku(agentCommand('claude'), prompt, budgetMs),
      counterFile: path.join(blobsStoreDir(), 'claude-memory-calls.json'),
      log,
    });
  // The webhook receiver listens on the UI port + 3 (8797 -> 8800, Kora Dev 8790 -> 8793, QA 88N0 -> 88N3); KORA_WEBHOOK_PORT overrides.
  let webhookPort: number | undefined;
  try { const ui = loadConfig().uiPort; if (!process.env.KORA_WEBHOOK_PORT && ui > 0 && ui + 3 < 65536) webhookPort = ui + 3; } catch { webhookPort = undefined; }
  // the blob policy lets exactly this `<node> <kora.js> blob-tools …` through on Auto (session/blob-policy.ts)
  (require('../session/blob-policy') as typeof import('../session/blob-policy')).setBlobToolsCommand(process.execPath, rt.binPath);
  return new BlobRuntimeImpl({ store, memory, oneShot, koraCmd: `${sq(process.execPath)} ${sq(rt.binPath)}`, log, ...(webhookPort ? { webhookPort } : {}) });
}
