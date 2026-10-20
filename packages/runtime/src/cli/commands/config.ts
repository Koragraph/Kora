// `kora config` — read/write ~/.kora/config.json. Goes through the running server when there is one (so the
// Runtime re-reads at once); otherwise edits the file directly. Keys are dot paths; values parse as JSON when they can.
import type { IO } from '../main';
import { parseArgs, json } from './_shared';
import { loadConfig, saveConfig, configPath, getPath, patchFromPath, parseConfigValue, DEFAULTS } from '../../config';
import { defaultSocketPath } from '../../protocol/types';

export const summary = 'Read or set ~/.kora/config.json: get [key] | set <key> <value> | path';
export const usage = `kora config get [key]            print the whole config, or one dot-path key (autoCompact.enabled)
kora config set <key> <value>    value is JSON when it parses (true, 150000, ["/a","/b"]), else a string
kora config path                 where the file lives ($KORA_HOME/config.json)
kora config defaults             the built-in defaults

Keys: restartMode resume|cheap|fresh · autoCompact.enabled/contextTokens/onlyWhenIdle · compactWarnTokens
      autoAnswer.trustFolder/mcpFound/readOutsideWorktree · trustedRoots [..] · defaultBudgetUsd
      strictMcp · mcp auto|on|off · worktrees auto|always|never · waitIndex · grepCap · concise · minimalCode · readDedupe · graphCache · cacheTtlMs
A running server picks a change up within 2s.`;

async function viaServer<T>(fn: (c: import('../../protocol/client').KoraClient) => Promise<T>): Promise<T | null> {
  const { isSocketAlive } = require('../../server/daemon') as typeof import('../../server/daemon');
  if (!(await isSocketAlive(defaultSocketPath(), 300))) return null;
  const { KoraClient } = require('../../protocol/client') as typeof import('../../protocol/client');
  const c = new KoraClient(defaultSocketPath()); await c.connect(2000);
  try { return await fn(c); } finally { c.close(); }
}

export async function run(argv: string[], io: IO): Promise<number> {
  const { positional, flags } = parseArgs(argv, [], ['json']);
  const sub = positional[0] || 'get';
  switch (sub) {
    case 'path': io.out(configPath() + '\n'); return 0;
    case 'defaults': json(io, DEFAULTS); return 0;
    case 'get': {
      const r = await viaServer((c) => c.call('config.get', {}));
      const cfg: any = r?.config ?? loadConfig();
      if (positional[1]) { const v = getPath(cfg, positional[1]); if (v === undefined) { io.err(`kora config: unknown key ${positional[1]}\n`); return 1; } io.out((typeof v === 'string' && !flags.json ? v : JSON.stringify(v)) + '\n'); return 0; }
      json(io, cfg); return 0;
    }
    case 'set': {
      const key = positional[1]; const raw = positional.slice(2).join(' ');
      if (!key || raw === '') { io.err('usage: kora config set <key> <value>\n'); return 2; }
      if (getPath(DEFAULTS, key) === undefined && !key.startsWith('trustedRoots')) io.err(`kora config: note — ${key} is not a known key (set anyway)\n`);
      const patch = patchFromPath(key, parseConfigValue(raw));
      const r = await viaServer((c) => c.call('config.set', { patch }));
      const cfg: any = r?.config ?? saveConfig(patch);
      io.out(`${key} = ${JSON.stringify(getPath(cfg, key))}${r ? ' (server updated)' : ''}\n`); return 0;
    }
    default: io.err(usage + '\n'); return 2;
  }
}
