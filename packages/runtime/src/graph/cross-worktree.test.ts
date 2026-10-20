import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { crossWorktreeConflicts, parseDependents, type GraphLike, type WorktreeInput } from './cross-worktree';

// ---- real tiny git repos (changedSinceIndex shells out to real git, so we give it real ones) ----
const g = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const cleanup: string[] = [];
function newRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@t');
  g(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  return repo;
}
// Commit the given files, then apply `edits` (repo-relative → new content) WITHOUT committing, so the edited files
// diverge from the returned indexed sha exactly the way a worker's dirty worktree does.
function repoAt(prefix: string, seed: Record<string, string>, edits: Record<string, string>): WorktreeInput & { root: string } {
  const root = newRepo(prefix);
  for (const [rel, content] of Object.entries(seed)) fs.writeFileSync(path.join(root, rel), content);
  g(root, 'add', '.');
  g(root, 'commit', '-q', '-m', 'seed');
  const indexedSha = g(root, 'rev-parse', 'HEAD');
  for (const [rel, content] of Object.entries(edits)) fs.writeFileSync(path.join(root, rel), content);
  return { paneId: prefix.replace(/-$/, ''), path: root, indexedSha, root };
}
test.after(() => { for (const d of cleanup) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } });

// ---- a fake GraphLike: canned koragraph responses keyed by tool + subject ----
type Canned = { text?: string; data?: unknown } | 'throw';
function fakeGraph(responses: Record<string, Canned>): GraphLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async callTool(name, args, _opts) {
      const key = `${name}:${(args.path as string) ?? (args.symbol as string) ?? ''}`;
      calls.push(key);
      const r = responses[key];
      if (r === 'throw') throw new Error(`no declaration named ${args.symbol ?? args.path}`);
      return { text: r?.text ?? '', data: r?.data ?? null, ms: 1 };
    },
  };
}

// ---- pure parsers ----
test('parseDependents: named and bare refs, excluding the declaring file', () => {
  const res = { text: 'Dependents:\n  consumer @ src/consumer.ts:12\n  self @ src/foo.ts:1', data: null };
  assert.deepEqual(parseDependents(res, 'src/foo.ts'), [{ file: 'src/consumer.ts', line: 12 }]);
});

// ---- 1. the decisive case: a graph-only conflict git would merge clean ----
test('semantic: A changed a symbol whose dependent lives in a file B also changed', async () => {
  const A = repoAt('pA-', { 'src/foo.ts': 'export function foo(){ return 1; }\n', 'src/other.ts': 'export const x=1;\n' },
    { 'src/foo.ts': 'export function foo(a: number){ return a; }\n' }); // signature changed
  const B = repoAt('pB-', { 'src/consumer.ts': 'import { foo } from "./foo";\nexport const y = foo();\n' },
    { 'src/consumer.ts': 'import { foo } from "./foo";\nexport const y = foo();\nexport const z = 2;\n' });

  const svc = fakeGraph({
    'file_symbols:src/foo.ts': { text: '■ FUNCTION foo @ src/foo.ts:1 — foo(a)' },
    'neighbours:foo': { text: 'Dependents:\n  y @ src/consumer.ts:12' }, // dependent is IN B's diff
    // B's changed file declares nothing the graph resolves → B->A direction is empty
  });

  const { pairs, order } = await crossWorktreeConflicts([B, A], svc); // pass out of order; result must sort
  assert.equal(pairs.length, 1);
  const p = pairs[0];
  assert.equal(p.a, 'pA'); assert.equal(p.b, 'pB'); // a<b by paneId
  assert.equal(p.status, 'semantic');
  assert.ok(p.blame && p.blame.length >= 1);
  const bl = p.blame![0];
  assert.equal(bl.file, 'src/consumer.ts');
  assert.equal(bl.symbol, 'foo');
  assert.equal(bl.byWorker, 'pA'); // A's change reaches into B's diff
  assert.equal(bl.line, 12);
  assert.deepEqual([...order].sort(), ['pA', 'pB']);
});

// ---- 2. disjoint changes, no cross-dependency → clean ----
test('clean: unrelated files, dependents fall outside the other worker diff', async () => {
  const A = repoAt('wA-', { 'src/alpha.ts': 'export const alpha=1;\n' }, { 'src/alpha.ts': 'export const alpha=2;\n' });
  const B = repoAt('wB-', { 'src/beta.ts': 'export const beta=1;\n' }, { 'src/beta.ts': 'export const beta=2;\n' });
  const svc = fakeGraph({
    'file_symbols:src/alpha.ts': { text: '■ CONST alpha @ src/alpha.ts:1' },
    'neighbours:alpha': { text: 'Dependents:\n  far @ src/faraway.ts:3' }, // NOT in B's diff
    'file_symbols:src/beta.ts': { text: '■ CONST beta @ src/beta.ts:1' },
    'neighbours:beta': { text: 'Dependents:\n  none @ src/nowhere.ts:5' }, // NOT in A's diff
  });
  const { pairs, order } = await crossWorktreeConflicts([A, B], svc);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].status, 'clean');
  assert.ok(!pairs[0].blame);
  assert.deepEqual([...order].sort(), ['wA', 'wB']);
});

// ---- 3. a NEW-on-branch symbol nobody else references → CLEAN (not a false needs-human) ----
// A adds a brand-new symbol the base graph never indexed. The graph can't list its callers, but B's diff does not
// mention it at all, so there is provably no cross-diff edge through it. Marking this needs-human would bury the
// signal (every added file would trip it), so the gate must return clean.
test('clean: a new-on-branch symbol that the other diff never references', async () => {
  const A = repoAt('nA-', { 'src/keep.ts': 'export const keep=1;\n' },
    { 'src/fresh.ts': 'export function freshOne(){ return 42; }\n' }); // untracked, brand-new file+symbol
  const B = repoAt('nB-', { 'src/unrelated.ts': 'export const u=1;\n' }, { 'src/unrelated.ts': 'export const u=2;\n' });
  const svc = fakeGraph({
    'file_symbols:src/fresh.ts': { text: '■ FUNCTION freshOne @ src/fresh.ts:1' },
    'neighbours:freshOne': 'throw', // base graph never indexed it → errors (new-on-branch, not a tool failure)
  });
  const { pairs, order } = await crossWorktreeConflicts([A, B], svc);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].status, 'clean'); // freshOne is nowhere in B's diff → no hidden edge
  assert.deepEqual([...order].sort(), ['nA', 'nB']);
});

// ---- 3b. a NEW-on-branch symbol that the OTHER diff DOES reference → needs-human (the safety case kept) ----
// Same new symbol, but now B's changed file actually calls freshOne. The graph can't see that edge (freshOne is
// new), so we cannot rule out a semantic break → a human must look.
test('needs-human: a new-on-branch symbol referenced inside the other worker diff', async () => {
  const A = repoAt('rA-', { 'src/keep.ts': 'export const keep=1;\n' },
    { 'src/fresh.ts': 'export function freshOne(){ return 42; }\n' });
  const B = repoAt('rB-', { 'src/caller.ts': 'export const u=1;\n' },
    { 'src/caller.ts': 'import { freshOne } from "./fresh";\nexport const u = freshOne();\n' }); // references freshOne
  const svc = fakeGraph({
    'file_symbols:src/fresh.ts': { text: '■ FUNCTION freshOne @ src/fresh.ts:1' },
    'neighbours:freshOne': 'throw',
    'file_symbols:src/caller.ts': { text: '■ CONST u @ src/caller.ts:2' },
    'neighbours:u': { text: 'Dependents:\n  none @ src/nowhere.ts:1' },
  });
  const { pairs } = await crossWorktreeConflicts([A, B], svc);
  assert.equal(pairs[0].status, 'needs-human'); // hidden edge possible → not a false clean
});

// ---- 3c. file_symbols itself throws for an added file (not in the base index) → the gate extracts the file's
//         symbols textually from disk and treats them as new-on-branch, NOT as a blind spot. Independent → clean. ----
test('clean: an added file whose symbols the graph cannot enumerate (file_symbols throws) is read from disk', async () => {
  const A = repoAt('tA-', { 'src/keep.ts': 'export const keep=1;\n' },
    { 'src/added.ts': 'export function brandNew(){ return 1; }\n' }); // added file, real content on disk
  const B = repoAt('tB-', { 'src/other.ts': 'export const o=1;\n' }, { 'src/other.ts': 'export const o=2;\n' });
  const svc = fakeGraph({
    'file_symbols:src/added.ts': 'throw', // graph has never seen the file
    'file_symbols:src/other.ts': { text: '■ CONST o @ src/other.ts:1' },
    'neighbours:o': { text: 'Dependents:\n  none @ src/nowhere.ts:1' },
  });
  const { pairs } = await crossWorktreeConflicts([A, B], svc);
  assert.equal(pairs[0].status, 'clean'); // brandNew is nowhere in B's diff → no hidden edge, not blind
});

// ---- 4. order is always a permutation of the worker paneIds (here across 3 workers) ----
test('order: a deterministic permutation of all worker paneIds', async () => {
  const mk = (p: string, f: string) => repoAt(p, { [f]: 'export const v=1;\n' }, { [f]: 'export const v=2;\n' });
  const w1 = mk('z1-', 'src/a.ts');
  const w2 = mk('m2-', 'src/b.ts');
  const w3 = mk('a3-', 'src/c.ts');
  const svc = fakeGraph({}); // everything empty → all clean, order decided by paneId tiebreak
  const { pairs, order } = await crossWorktreeConflicts([w1, w2, w3], svc);
  assert.equal(pairs.length, 3); // C(3,2)
  assert.deepEqual([...order].sort(), ['a3', 'm2', 'z1']);
  assert.equal(new Set(order).size, 3);
});

test('kora-managed untracked files (AGENTS.md) and non-source files never make a worker blind; a blind pair says why', async () => {
  // Two disjoint NEW .py files, each worktree also carrying the enforcer's untracked AGENTS.md (as every real
  // worktree does) — this exact shape read as `needs-human` in three live fleet runs.
  const A = repoAt('wA-', { 'README.md': '# r\n' }, { 'greeting.py': 'def greet(n):\n    return f"Hello, {n}!"\n', 'AGENTS.md': '# managed\n', 'notes.txt': 'scratch\n' });
  const B = repoAt('wB-', { 'README.md': '# r\n' }, { 'shout.py': 'def shout(t):\n    return t.upper() + "!"\n', 'AGENTS.md': '# managed\n' });
  const svc = fakeGraph({ 'file_symbols:greeting.py': 'throw', 'file_symbols:shout.py': 'throw', 'file_symbols:notes.txt': 'throw', 'file_symbols:AGENTS.md': 'throw' }); // nothing here is in the base index
  const { pairs } = await crossWorktreeConflicts([A, B], svc);
  assert.equal(pairs[0].status, 'clean', JSON.stringify(pairs[0]));
  assert.ok(!svc.calls.some((c) => c.includes('AGENTS.md')), 'managed files must not be analysed at all');
  // A readable source file that declares nothing (a test of bare asserts) is NOT a blind spot …
  const C = repoAt('wC-', { 'README.md': '# r\n' }, { 'test_x.py': 'from app.x import x\nassert x(1) == 2\n' });
  const D = repoAt('wD-', { 'README.md': '# r\n' }, { 'other.ts': 'export const other = 1;\n' });
  const r2 = await crossWorktreeConflicts([C, D], fakeGraph({ 'file_symbols:test_x.py': 'throw', 'file_symbols:other.ts': 'throw' }));
  assert.equal(r2.pairs[0].status, 'clean', JSON.stringify(r2.pairs[0]));
  // … but a source file we cannot READ is, and the pair says which.
  const E = repoAt('wE-', { 'README.md': '# r\n' }, { 'huge.ts': 'x'.repeat(600 * 1024) });
  const r3 = await crossWorktreeConflicts([E, D], fakeGraph({ 'file_symbols:huge.ts': 'throw', 'file_symbols:other.ts': 'throw' }));
  assert.equal(r3.pairs[0].status, 'needs-human');
  assert.match(r3.pairs[0].reason ?? '', /huge\.ts/);
});

test('phantom symbols: names the index attributes to a file that does not declare them are skipped, not blind spots', async () => {
  // The index answered for another checkout's copy of the file (four test names that exist only there).
  const A = repoAt('wA-', { 'README.md': '# r\n' }, { 'test_greeting.py': 'from app.greeting import greet\n\ndef test_greet():\n    assert greet("x")\n' });
  const B = repoAt('wB-', { 'README.md': '# r\n' }, { 'shout.py': 'def shout(t):\n    return t.upper()\n' });
  const svc = fakeGraph({
    'file_symbols:test_greeting.py': { text: '■ METHOD test_greet_alice @ test_greeting.py:8\n■ METHOD test_greet @ test_greeting.py:3\n■ DEPENDENCY app.greeting @ test_greeting.py:1' },
    'neighbours:test_greet': 'throw',        // new on branch → declared here → newSymbol, fine
    'neighbours:test_greet_alice': 'throw',  // phantom: must never be queried
    'file_symbols:shout.py': 'throw',
  });
  const { pairs } = await crossWorktreeConflicts([A, B], svc);
  assert.equal(pairs[0].status, 'clean', JSON.stringify(pairs[0]));
  assert.ok(!svc.calls.includes('neighbours:test_greet_alice'), 'phantom symbol was queried');
  assert.ok(!svc.calls.includes('neighbours:app.greeting'), 'import row was queried');
});

// ---- live false positives (2026-10-17, five review workers): locals, namesakes and body-only edits are not edges ----
test('clean: a body-only edit, a local variable and a common word the other side also uses', async () => {
  const seedA = 'export function run(x: number) {\n  const first = x;\n  return first;\n}\n';
  const A = repoAt('fA-', { 'src/run.ts': seedA }, { 'src/run.ts': 'export function run(x: number) {\n  const first = x + 1;\n  resolve(first);\n  return first;\n}\n' });
  const B = repoAt('fB-', { 'src/use.ts': 'import { run } from "./run";\nexport const y = run(1);\n' },
    { 'src/use.ts': 'import { run } from "./run";\nexport const y = run(1);\nexport const first = [1].map((v) => v)[0];\nexport const z = run(2);\n' });
  const svc = fakeGraph({
    'file_symbols:src/run.ts': { text: '■ FUNCTION run @ src/run.ts:1\n■ VARIABLE first @ src/run.ts:2\n■ FUNCTION resolve @ src/run.ts:3' },
    'neighbours:run': { text: 'Dependents:\n  y @ src/use.ts:2' }, // a caller B did not edit
    'neighbours:first': { text: 'Dependents:\n  z @ src/use.ts:3' },
  });
  const { pairs } = await crossWorktreeConflicts([A, B], svc);
  assert.equal(pairs[0].status, 'clean', JSON.stringify(pairs[0]));
});

test('semantic: a re-signatured function the other side newly calls is still caught by name', async () => {
  const A = repoAt('sA-', { 'src/run.ts': 'export function run(x: number) {\n  return x;\n}\n' }, { 'src/run.ts': 'export function run(x: number, y: number) {\n  return x + y;\n}\n' });
  const B = repoAt('sB-', { 'src/use.ts': 'export const k = 1;\n' }, { 'src/use.ts': 'export const k = 1;\nexport const z = run(2);\n' });
  const svc = fakeGraph({ 'file_symbols:src/run.ts': { text: '■ FUNCTION run @ src/run.ts:1' }, 'neighbours:run': { text: '' } });
  const { pairs } = await crossWorktreeConflicts([A, B], svc);
  assert.equal(pairs[0].status, 'semantic');
  assert.equal(pairs[0].blame?.[0].symbol, 'run');
});
