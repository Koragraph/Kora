// `kora setup [path]` — one shot: ingest if needed, enforcement for every installed agent, git
// re-index hooks, PATH shims. Prints a summary table.
import path from 'node:path';
import type { IO } from '../main';
import { parseArgs, str } from '../args';
import type { AgentId } from '../../protocol/types';
import type { AdapterResult } from '../../enforce/index';
import { createEnforcer } from '../../enforce/enforcer';
import { createGraphService } from '../../graph/index';
import { KORA_BIN, NODE_BIN, gitTopLevel, kg } from '../../graph/embedded';
import { renderResults } from './enforce';

export const summary = 'One-shot: ingest, enforcement adapters, git hooks, shims';
export const usage = `Usage: kora setup [path] [--agent claude|codex|gemini|opencode|cursor|all] [--project P]
                      [--no-ingest] [--no-git-hooks] [--no-shims] [--replace-koragraph-hooks] [--trust]

1. ingest <path> into the graph if it is not indexed yet (incremental if it is)
2. install enforcement for --agent (default: every agent found on PATH, plus AGENTS.md)
3. install git hooks (post-commit/checkout/merge/rewrite) that re-run \`kora ingest\` in the background
4. write the PATH shims (~/.kora/shims/{grep,rg,ag,find})
5. with --trust: trust the folder in Kora, so agents load its own config (.claude hooks, project MCP servers,
   .codex/.opencode/.koragent config). Without it a new folder runs in restricted mode until trusted in the app.`;

export async function run(argv: string[], io: IO): Promise<number> {
  const { flags, positional } = parseArgs(argv, ['agent', 'project']);
  if (flags.help) { io.out(usage + '\n'); return 0; }
  const cwd = path.resolve(positional[0] || process.cwd());
  const root = gitTopLevel(cwd) || cwd;
  const agent = (str(flags.agent) || 'all') as AgentId | 'all';
  const project = str(flags.project) || 'default';
  const graph = createGraphService();
  const rows: AdapterResult[] = [];
  let failed = false;

  // 1. ingest
  if (flags.ingest !== false) {
    const st = await graph.status(root);
    if (st.indexed) rows.push({ agent: 'graph', action: 'managed', file: root, detail: `indexed: ${st.nodes} nodes, ${st.edges} edges (re-index with \`kora ingest\`)` });
    else {
      io.err(`Indexing ${root} — this takes a minute on a large repository…\n`);
      try {
        const r = await graph.ingest(root, { project, wait: true, io: { out: io.err, err: io.err } } as any);
        rows.push({ agent: 'graph', action: 'installed', file: root, detail: r.nodes != null ? `${r.nodes} nodes, ${r.edges} edges` : 'ingested' });
      } catch (e: any) { failed = true; rows.push({ agent: 'graph', action: 'skipped', file: root, detail: `ingest failed: ${e.message}` }); }
    }
  } else rows.push({ agent: 'graph', action: 'skipped', file: root, detail: '--no-ingest' });

  // 2. enforcement (adapters + shims)
  const enforcer = createEnforcer({ graph });
  const { results } = await (enforcer.install as any)({ agent, cwd: root, replaceKoragraphHooks: flags['replace-koragraph-hooks'] === true });
  for (const r of results) { if (r.agent === 'shims' && flags.shims === false) continue; rows.push(r); }
  if (flags.shims === false) rows.push({ agent: 'shims', action: 'skipped', file: '~/.kora/shims', detail: '--no-shims' });

  // 3. git hooks (koragraph's installer, pointed at kora's bin)
  if (flags['git-hooks'] !== false) {
    try {
      const gh = kg('src/services/git-hooks.js');
      const { dir, results: hr } = gh.installHooks(root, { nodeBin: NODE_BIN, cliEntry: KORA_BIN, repoPath: root, project });
      for (const h of hr) rows.push({ agent: 'git', action: h.action === 'unchanged' ? 'managed' : h.action === 'created' || h.action === 'appended' ? 'installed' : h.action === 'skipped-symlink' ? 'skipped' : 'refreshed', file: path.join(dir, h.hook), detail: h.action });
    } catch (e: any) { rows.push({ agent: 'git', action: 'skipped', file: root, detail: `git hooks: ${e.message}` }); }
  } else rows.push({ agent: 'git', action: 'skipped', file: root, detail: '--no-git-hooks' });

  // 5. folder trust (trust/store.ts) — only when asked: running setup is not consent to run the repo's own config.
  {
    const { trustFolder, trustStatus } = require('../../trust/store') as typeof import('../../trust/store');
    if (flags.trust === true) {
      try { const t = trustFolder(root, 'cli'); rows.push({ agent: 'trust', action: 'installed', file: t.root, detail: 'trusted: agents load this folder\'s own config' }); }
      catch (e: any) { failed = true; rows.push({ agent: 'trust', action: 'skipped', file: root, detail: e.message }); }
    } else {
      const t = trustStatus(root);
      rows.push({ agent: 'trust', action: t.trusted ? 'managed' : 'skipped', file: t.root, detail: t.trusted ? `trusted (${t.source})` : 'not trusted: restricted mode (re-run with --trust, or trust it in the app)' });
    }
  }

  io.out(`kora setup — ${root}\n${renderResults(rows)}`);
  io.out(`\nNext: launch an agent inside kora (\`kora agent spawn claude\`), or just run \`kora graph explore "<query>"\` here.\n`);
  return failed ? 1 : 0;
}
