// Gemini CLI, opencode, cursor-agent and the generic AGENTS.md adapter. All four share one shape:
// a managed block (rulebook + session brief, regenerated at every prepare) in the file the agent
// loads unconditionally, plus that agent's MCP config file where it has one.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from '../../protocol/types';
import type { AdapterResult, PrepareInput } from '../index';
import { upsertBlock, removeBlock, blockStatus, excludeCreatedFile } from '../agentsmd';
import { upsertJsonKey, removeJsonKey, jsonKeyStatus, mcpServerSpec, SERVER_NAME } from '../mcpconfig';
import { briefBlockBody, type Adapter, type AdapterCtx, type PrepareDelta } from './types';

interface FileAdapterSpec {
  id: AgentId;
  bin: string | null;
  file: string;                       // instruction file, repo-relative
  frontmatter?: string;               // written only when the file is created
  mcp?: { file: string; keys: string[]; value: () => unknown };
  /** the agent reads code through the shell (no ranged Read tool): its block carries the `sed -n` read-range line */
  shell?: boolean;
}

const CURSOR_FRONTMATTER = '---\ndescription: kora code graph — mandatory retrieval layer\nalwaysApply: true\n---\n\n';

function fileAdapter(spec: FileAdapterSpec): Adapter {
  const agent = spec.id;
  const instr = (ctx: AdapterCtx) => path.join(ctx.root, spec.file);
  const mcpFile = (ctx: AdapterCtx) => (spec.mcp ? path.join(ctx.root, spec.mcp.file) : null);
  /** Write the MCP entry; a config file Kora created goes into .git/info/exclude (`?? .gemini/` dirtied repos, pl5 S2-1). */
  const writeMcp = (mf: string, ctx: AdapterCtx): AdapterResult => {
    const existed = fs.existsSync(mf);
    const r = upsertJsonKey(mf, spec.mcp!.keys, spec.mcp!.value(), agent, ctx.root);
    if (!existed && fs.existsSync(mf)) excludeCreatedFile(mf);
    return r;
  };
  return {
    id: spec.id,
    bin: spec.bin,
    needsBrief: true,
    install(ctx) {
      const out: AdapterResult[] = [upsertBlock(instr(ctx), briefBlockBody(ctx, instr(ctx), { shell: spec.shell }), { root: ctx.root, create: ctx.create, frontmatter: spec.frontmatter, agent })];
      const mf = mcpFile(ctx);
      if (spec.mcp && mf) out.push(writeMcp(mf, ctx));
      return out;
    },
    uninstall(ctx) {
      const out: AdapterResult[] = [removeBlock(instr(ctx), agent, ctx.root)];
      const mf = mcpFile(ctx);
      if (spec.mcp && mf) out.push(removeJsonKey(mf, spec.mcp.keys, agent, ctx.root));
      return out;
    },
    status(ctx) {
      const out: AdapterResult[] = [blockStatus(instr(ctx), agent)];
      const mf = mcpFile(ctx);
      if (spec.mcp && mf) out.push(jsonKeyStatus(mf, spec.mcp.keys, agent));
      return out;
    },
    prepare(_input: PrepareInput, ctx: AdapterCtx): PrepareDelta {
      const notes: string[] = [];
      if (ctx.readOnly) return { args: _input.args.slice(), env: {}, notes: ['untrusted folder: nothing written into the repo'] };
      const r = upsertBlock(instr(ctx), briefBlockBody(ctx, instr(ctx), { shell: spec.shell }), { root: ctx.root, create: ctx.create, frontmatter: spec.frontmatter, agent });
      notes.push(`${spec.file} block ${r.action}${ctx.brief ? ' (with brief)' : ''}`);
      const mf = mcpFile(ctx);
      if (spec.mcp && mf) { const m = writeMcp(mf, ctx); if (m.action !== 'managed') notes.push(`${spec.mcp.file} ${m.action}`); }
      return { args: _input.args.slice(), env: {}, notes };
    },
  };
}

export const geminiAdapter = fileAdapter({
  id: 'gemini', bin: 'gemini', file: 'GEMINI.md', shell: true,
  mcp: { file: path.join('.gemini', 'settings.json'), keys: ['mcpServers', SERVER_NAME], value: () => mcpServerSpec() },
});

export const opencodeAdapter = fileAdapter({
  id: 'opencode', bin: 'opencode', file: 'AGENTS.md',
  mcp: { file: 'opencode.json', keys: ['mcp', SERVER_NAME], value: () => { const s = mcpServerSpec(); return { type: 'local', command: [s.command, ...s.args], enabled: true }; } },
});

export const cursorAdapter = fileAdapter({
  id: 'cursor', bin: 'cursor-agent', file: path.join('.cursor', 'rules', 'kora.mdc'), frontmatter: CURSOR_FRONTMATTER,
  mcp: { file: path.join('.cursor', 'mcp.json'), keys: ['mcpServers', SERVER_NAME], value: () => mcpServerSpec() },
});

/** AGENTS.md only — amp, droid, copilot, grok, kimi, qwen, aider and anything unknown. */
export function genericAdapter(id: AgentId, bin: string | null = null): Adapter {
  return fileAdapter({ id, bin, file: 'AGENTS.md', shell: true });
}
