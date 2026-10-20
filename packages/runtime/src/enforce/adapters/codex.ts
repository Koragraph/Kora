// Codex: AGENTS.md managed block (rulebook + session brief, regenerated at every prepare so laws
// and open loops are fresh) + MCP via `-c mcp_servers.kora.*` overrides on the command line
// and a [mcp_servers.kora] section in ~/.codex/config.toml.
//
// Codex has no per-session hook kora can drive from the outside that is stable enough to rely
// on (`notify` is a single global value the user may already use; the `hooks` feature flag exists
// but its file format was not verified here), so the brief travels inside the AGENTS.md block.
import path from 'node:path';
import type { AdapterResult, PrepareInput } from '../index';
import { upsertBlock, removeBlock, blockStatus } from '../agentsmd';
import { upsertCodexMcp, removeCodexMcp, codexMcpStatus, mcpServerSpec, upsertCodexTrust } from '../mcpconfig';
import { loadConfig } from '../../config';
import { isFolderTrusted } from '../../trust/store';
import { codexLimitArgs, codexSavingsOn } from '../../session/drivers/codex-savings';
import { briefBlockBody, type Adapter, type AdapterCtx, type PrepareDelta } from './types';

export function codexOverrides(): string[] {
  const spec = mcpServerSpec();
  return ['-c', `mcp_servers.kora.command=${JSON.stringify(spec.command)}`, '-c', `mcp_servers.kora.args=${JSON.stringify(spec.args)}`];
}

export const codexAdapter: Adapter = {
  id: 'codex',
  bin: 'codex',
  needsBrief: true,
  install(ctx) {
    return [
      upsertBlock(path.join(ctx.root, 'AGENTS.md'), briefBlockBody(ctx, path.join(ctx.root, 'AGENTS.md'), { shell: true }), { root: ctx.root, create: ctx.create, agent: 'codex' }),
      upsertCodexMcp(),
    ];
  },
  uninstall(ctx) {
    return [removeBlock(path.join(ctx.root, 'AGENTS.md'), 'codex', ctx.root), removeCodexMcp()];
  },
  status(ctx) {
    return [blockStatus(path.join(ctx.root, 'AGENTS.md'), 'codex'), codexMcpStatus()];
  },
  prepare(input: PrepareInput, ctx: AdapterCtx): PrepareDelta {
    const notes: string[] = [];
    const args = input.args.slice();
    if (ctx.readOnly) notes.push('untrusted folder: no AGENTS.md block written');
    else {
      const r: AdapterResult = upsertBlock(path.join(ctx.root, 'AGENTS.md'), briefBlockBody(ctx, path.join(ctx.root, 'AGENTS.md'), { shell: true }), { root: ctx.root, create: ctx.create, agent: 'codex' });
      notes.push(`AGENTS.md block ${r.action}${ctx.brief ? ' (with brief)' : ''}`);
    }
    // Token levers for a Codex pane: cap a tool's output and compact earlier (a value in the user's own config.toml wins).
    try {
      if (codexSavingsOn() && !args.some((a) => /tool_output_token_limit|model_auto_compact_token_limit/.test(a))) {
        const lim = codexLimitArgs();
        if (lim.length) { args.push(...lim); notes.push('-c tool_output_token_limit / model_auto_compact_token_limit'); }
      }
    } catch { /* optional */ }
    if (!args.some((a) => a.includes('mcp_servers.kora'))) { args.push(...codexOverrides()); notes.push('-c mcp_servers.kora overrides'); }
    // The user's extension servers marked for workers (secrets via env / `kora ext exec`, never argv).
    const extensions = (require('../../extensions') as typeof import('../../extensions')).codexSessionWiring({ cwd: input.cwd, isWorker: true, threadId: input.paneId });
    if (extensions.args.length) { args.push(...extensions.args); notes.push('extensions: worker MCP servers added'); }
    // Codex asks "Do you trust the contents of this directory?" on every path it has not seen — every worktree.
    // Granting it loads the project's own `.codex/` config, so only for a folder the USER trusted in Kora
    // (trust/store.ts; a worktree counts through its main checkout). `trustedRoots` (~/Projects) no longer implies it.
    try {
      const cfg = loadConfig();
      if (cfg.autoAnswer.trustFolder && isFolderTrusted(ctx.root)) {
        const t = upsertCodexTrust(ctx.root);
        if (t.action === 'installed') notes.push(`codex trust granted for ${ctx.root}`);
      } else if (!isFolderTrusted(ctx.root)) notes.push(`codex trust NOT granted: ${ctx.root} is not a trusted folder in Kora`);
    } catch { /* advisory: the manifest rule + auto-answer still catch the dialog */ }
    return { args, env: extensions.env, notes };
  },
};
