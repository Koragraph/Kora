// Built-in bench tasks. Each is a realistic mid-task question on a real repository, phrased WITHOUT any
// mention of a graph, so the baseline is neutral.
//
// v2: tasks are PINNED to a repository at a SHA (runs are comparable across weeks), cover every savings regime
// (not only the flattering one), and carry a mechanical success check — a cheaper wrong answer is worth negative
// money, so savings are only counted on tasks where BOTH arms produced an acceptable answer.
export type TaskKind = 'understand' | 'callers' | 'change-plan' | 'edit' | 'strings';
/** indexed: the pinned repo, already in the graph. cold: a copy the graph has never seen. dirty: indexed, with
 *  uncommitted edits to source files (the regime where injection used to die silently). */
export type Regime = 'indexed' | 'cold' | 'dirty';
export interface Expect {
  /** every one of these (case-insensitive) must appear in the final answer */
  all?: string[];
  /** at least one of these must appear */
  anyOf?: string[];
  /** for edits: `git diff --name-only` in the copy must include each of these paths */
  diffFiles?: string[];
  /** for edits: the unified diff must match this regex */
  diffRegex?: string;
}
export interface BenchTask { id: string; prompt: string; kind: TaskKind; regime?: Regime; expect?: Expect }
export interface BenchSuite {
  version: 2;
  name: string;
  /** The repository the tasks are written against, at the SHA the answers were checked at. */
  repo: { path: string; sha: string; name: string };
  tasks: BenchTask[];
  /** One continuous session, prompts in order (≥10 turns): the whole-mix number the pitch rests on. */
  mixed: BenchTask[];
}

export const KORAGRAPH_TASKS: BenchTask[] = [
  {
    id: 'edit-status-json',
    kind: 'edit',
    prompt: 'Add a `--json` flag to the `koragraph status` CLI command (src/cli/status.js) that emits the same information as machine-readable JSON instead of text, following the conventions the other commands in src/cli use for their --json flags and option parsing. Edit the files; do not run the tests. Finish with a 3-line summary of what changed.',
    expect: { diffFiles: ['src/cli/status.js'], diffRegex: 'json' },
  },
  {
    id: 'incremental',
    kind: 'understand',
    prompt: 'Explain how incremental re-indexing works in this repository: how a changed file is detected, what gets re-extracted for it, and how the old nodes for that file are replaced. Cite the functions involved with file:line. Keep the whole answer under 300 words.',
    // Either detection story is acceptable: the reactive one (live-freshness / repo-watcher) or the sha-skip inside
    // runIncrementalIngest itself — both arms answered the latter in Phase 0 and were right.
    expect: { all: ['runIncrementalIngest'], anyOf: ['live-freshness', 'repo-watcher', 'computeChanges', 'ensureRepoFresh', 'ensureFilesFresh', 'file_sha', 'filterIncrementalPaths', 'extractIngestFile', 'sha_skipped', 'archiveDeletedFileNodes'] },
  },
  {
    id: 'callers',
    kind: 'callers',
    prompt: 'List every function that calls resolveSymbol (the one defined in src/mcp/symbol-resolver.js), giving file:line for each call site. Then, in two sentences, say what the resolver does when a symbol name is ambiguous across files.',
    expect: { all: ['tool-handlers.js', 'cochange.js'], anyOf: ['neighbours', 'changesWith', 'changes_with'] },
  },
  {
    id: 'rename-plan',
    kind: 'strings',
    prompt: 'I want to rename runIncrementalIngest to runIncrementalReindex. List every file and line that would have to change (callers, tests, docs, anything referencing it by string). Do not make the edit. Be complete and concise.',
    // pinned repo @1e6472e: declared in src/services/ingest.js, called from src/cli/ingest.js, src/cli/watch.js, src/services/graph-diff.js
    expect: { all: ['ingest.js', 'watch.js'] },
  },
  {
    id: 'dirty-understand',
    kind: 'understand',
    regime: 'dirty',
    prompt: 'How does debounceStep decide when the watcher should re-index, and what state does it keep between polls? Cite functions with file:line. Under 200 words.',
    expect: { all: ['repo-watcher.js', 'debounceStep'], anyOf: ['applied', 'signature', 'prev'] },
  },
  {
    id: 'cold-callers',
    kind: 'callers',
    regime: 'cold',
    prompt: 'Who calls parseSymbol (src/mcp/symbol-resolver.js)? file:line for each call site, one line each.',
    expect: { all: ['symbol-resolver.js'] },
  },
];

export const KORAGRAPH_MIXED: BenchTask[] = [
  { id: 'm1-understand', kind: 'understand', prompt: 'How does the MCP server decide which repository a tool call is scoped to? Walk through it with the functions involved and file:line. Under 250 words.', expect: { anyOf: ['resolveProjectScope', 'serverRepoId', 'repoIdentity', 'resolveBranch'] } },
  { id: 'm2-callers', kind: 'callers', prompt: 'Who calls resolveProjectScope, and what does each caller pass as the scope value? file:line for each call site.', expect: { all: ['resolveProjectScope'] } },
  { id: 'm3-edit', kind: 'edit', prompt: 'In src/cli/stderr-filter.js, add a summarised rule (same shape as the existing INGEST_SUMMARISED entries) that collapses lines starting with `[lsp]` into one line reading "N LSP notice(s)". Keep the file\'s style. Edit the file; do not run tests. One-line summary when done.', expect: { diffFiles: ['src/cli/stderr-filter.js'], diffRegex: 'LSP notice' } },
  { id: 'm4-strings', kind: 'strings', prompt: 'List every place the string practice.db appears in code comments, docs or help text (not in code paths that build the filename). file:line each. Be complete and concise.', expect: { anyOf: ['practice.db'] } },
  { id: 'm5-plan', kind: 'change-plan', prompt: 'I want graphStaleness() to also return an ageMs field (milliseconds since the last ingest). What would need to change, and what depends on its return shape today? file:line. Do not edit.', expect: { all: ['graph-staleness.js'] } },
  { id: 'm6-edit2', kind: 'edit', prompt: 'Now make that change: add ageMs to what graphStaleness() returns, computed from the latest ingest timestamp it already reads, and thread it to wherever the staleness note is rendered so the note can say "(Ns ago)". Minimal diff. Do not run tests. Two-line summary.', expect: { diffFiles: ['src/services/graph-staleness.js'], diffRegex: 'ageMs' } },
  { id: 'm7-test', kind: 'edit', prompt: 'Add a unit test for the new stderr-filter rule, in the same style and location as the existing stderr-filter tests. Do not run it. One-line summary.', expect: { diffRegex: 'LSP' } },
  // the CALLER lives in watch.js (tick); a correct answer need not mention the callee's own file — both arms answered
  // 'tick at src/cli/watch.js:114' and the old expectation failed them 5 times in 6
  { id: 'm8-callers2', kind: 'callers', prompt: 'Which functions call signatureOf (src/services/repo-watcher.js), and what does each pass? file:line for each call site.', expect: { all: ['watch.js'], anyOf: ['tick', 'signatureOf', 'computeChanges'] } },
  { id: 'm9-understand2', kind: 'understand', prompt: 'How does graphStaleness work out whether the graph is behind the checkout, and what does the MCP layer do with what it returns? file:line. Under 150 words.', expect: { all: ['graph-staleness.js'], anyOf: ['tool-handlers.js', 'stale', 'HEAD', 'commit'] } },
  { id: 'm10-summary', kind: 'understand', prompt: 'Summarise everything we changed in this session in five bullets, each with the file touched.', expect: { anyOf: ['stderr-filter', 'graph-staleness'] } },
];

export const KORAGRAPH_SUITE: BenchSuite = {
  version: 2,
  name: 'koragraphmcp-v2',
  // The pinned checkout: KORA_BENCH_REPO, else ~/Projects/KoragraphMCP (no developer's absolute path in the shipped bundle).
  repo: { path: process.env.KORA_BENCH_REPO || require('node:path').join(require('node:os').homedir(), 'Projects', 'KoragraphMCP'), sha: '1e6472ed083a8c810603a8720496ba376aa7908b', name: 'KoragraphMCP' },
  tasks: KORAGRAPH_TASKS,
  mixed: KORAGRAPH_MIXED,
};

/** Mechanical success verdict for one task's final answer (+ the copy's git diff for edits). */
export function judge(task: BenchTask, answer: string, diff: { files: string[]; text: string } | null): { success: boolean; detail: string[] } {
  const e = task.expect; const detail: string[] = [];
  if (!e) return { success: !!answer.trim(), detail: ['no expectation: non-empty answer'] };
  const a = (answer || '').toLowerCase();
  let ok = true;
  for (const s of e.all || []) { const hit = a.includes(s.toLowerCase()); if (!hit) { ok = false; detail.push(`missing "${s}"`); } }
  if (e.anyOf && e.anyOf.length && !e.anyOf.some((s) => a.includes(s.toLowerCase()))) { ok = false; detail.push(`none of ${e.anyOf.join('|')}`); }
  if (e.diffFiles) { for (const f of e.diffFiles) if (!diff || !diff.files.includes(f)) { ok = false; detail.push(`no diff in ${f}`); } }
  if (e.diffRegex) { if (!diff || !new RegExp(e.diffRegex, 'i').test(diff.text)) { ok = false; detail.push(`diff !~ /${e.diffRegex}/`); } }
  if (ok) detail.push('ok');
  return { success: ok, detail };
}
