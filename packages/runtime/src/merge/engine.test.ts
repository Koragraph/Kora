import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyMerge, exitCodeFor, mergeScratchRoot, type MergeRef } from './engine';
import type { GraphLike } from '../graph/cross-worktree';

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout || '').trim();
}

// A fake koragraph: fileA declares `foo`; `foo`'s only dependent is at b.ts:2 (the caller). Everything else empty.
const fakeGraph: GraphLike = {
  async callTool(name, args) {
    if (name === 'file_symbols') {
      const p = String((args as any).path || '');
      if (p.endsWith('a.ts')) return { text: 'FUNCTION foo @ a.ts:1 — foo(x)', data: { symbols: [{ name: 'foo' }] }, ms: 0 };
      return { text: '', data: { symbols: [] }, ms: 0 };
    }
    if (name === 'neighbours') {
      if (String((args as any).symbol) === 'foo' && (args as any).direction === 'in')
        return { text: 'caller @ b.ts:2', data: { neighbours: { in: [{ file: 'b.ts', line: 2 }] } }, ms: 0 };
      return { text: '', data: { neighbours: { in: [] } }, ms: 0 };
    }
    return { text: '', data: {}, ms: 0 };
  },
};

function makeRepo(): { root: string; cleanupHome: () => void } {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-merge-home-'));
  process.env.HOME = tmpHome; // so the engine's throwaway worktrees land under a temp ~/.kora
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-merge-repo-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function foo(x){ return x; }\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'import {foo} from "./a";\nfoo(1);\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  return { root, cleanupHome: () => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

test('verifyMerge flags a cross-diff semantic conflict git would merge clean', async () => {
  const { root, cleanupHome } = makeRepo();
  try {
    // feat-a: rewrite foo's signature (the symbol b.ts calls)
    git(root, 'checkout', '-q', '-b', 'feat-a');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function foo(x, y){ return x + y; }\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'a: change foo arity');
    // feat-b: edit the caller file b.ts (disjoint lines → git merges clean)
    git(root, 'checkout', '-q', 'main'); git(root, 'checkout', '-q', '-b', 'feat-b');
    fs.writeFileSync(path.join(root, 'b.ts'), 'import {foo} from "./a";\nfoo(1);\nconsole.log("added");\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'b: touch caller file');
    git(root, 'checkout', '-q', 'main');

    const refs: MergeRef[] = [{ kind: 'branch', name: 'feat-a' }, { kind: 'branch', name: 'feat-b' }];
    const res = await verifyMerge(root, refs, fakeGraph);

    assert.equal(res.pairs.length, 1, 'one pair');
    assert.equal(res.pairs[0].status, 'semantic', 'graph flags the cross-diff coupling git cannot see');
    assert.ok(res.pairs[0].blame?.some((b) => b.symbol === 'foo' && b.file === 'b.ts'), 'blame names foo reaching into b.ts');
    assert.equal(exitCodeFor(res.pairs), 3, 'semantic → exit 3');
    assert.ok(res.base, 'a merge-base was resolved');

    // Sanity: git itself merges the two branches with no textual conflict.
    git(root, 'checkout', '-q', '-b', 'trymerge', 'feat-a');
    const m = spawnSync('git', ['-C', root, 'merge', '--no-edit', 'feat-b'], { encoding: 'utf8' });
    assert.equal(m.status, 0, 'git merges clean — proving the graph caught what git could not');
  } finally { cleanupHome(); }
});

test('verifyMerge returns clean for genuinely independent edits', async () => {
  const { root, cleanupHome } = makeRepo();
  try {
    git(root, 'checkout', '-q', '-b', 'feat-a');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function foo(x, y){ return x + y; }\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'a: change foo');
    // feat-c edits an unrelated file with no dependency link to foo
    git(root, 'checkout', '-q', 'main'); git(root, 'checkout', '-q', '-b', 'feat-c');
    fs.writeFileSync(path.join(root, 'c.ts'), 'export const unrelated = 1;\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'c: unrelated');
    git(root, 'checkout', '-q', 'main');

    const res = await verifyMerge(root, [{ kind: 'branch', name: 'feat-a' }, { kind: 'branch', name: 'feat-c' }], fakeGraph);
    assert.equal(res.pairs[0].status, 'clean', 'no shared dependency → clean');
    assert.equal(exitCodeFor(res.pairs), 0, 'clean → exit 0');
  } finally { cleanupHome(); }
});

// D30 (Koragent E2E): an isolated daemon (own KORA_HOME) wrote its throwaway merge checkouts into the real ~/.kora.
test('merge scratch checkouts live under KORA_HOME', () => {
  const prev = process.env.KORA_HOME;
  process.env.KORA_HOME = path.join(os.tmpdir(), 'kora-home-d30');
  try { assert.equal(mergeScratchRoot('/repos/app'), path.join(os.tmpdir(), 'kora-home-d30', 'merge-check', 'app')); }
  finally { if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev; }
});
