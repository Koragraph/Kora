// End-to-end for the merge keystone with a REAL koragraph index and REAL git worktrees (no fakes).
// Proves the product's core claim: two workers make textually-disjoint edits that git merges CLEAN, but the
// composition is broken (worker A changed limit()'s arity; worker B still calls it the old way in a file it also
// changed) — and crossWorktreeConflicts flags it `semantic` with blame on A, where `git merge` reports no conflict.
// Run:  npm run build && node scripts/e2e-merge-keystone.js
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const N = path.resolve(__dirname, '..'); const BIN = path.join(N, 'bin', 'kora.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-merge-'));
// Same DB for the child ingest and the in-process GraphService: set it in THIS process's env before requiring dist.
process.env.KORAGRAPH_DB = path.join(tmp, 'g.db');
process.env.KORAGRAPH_PRACTICE_DB = path.join(tmp, 'p.db');
process.env.KORAGRAPH_HOME = tmp;
const env = { ...process.env };
const { crossWorktreeConflicts } = require(path.join(N, 'dist', 'graph', 'cross-worktree'));
const { createGraphService } = require(path.join(N, 'dist', 'graph'));

const repo = path.join(tmp, 'repo'); const wtA = path.join(tmp, 'wtA'); const wtB = path.join(tmp, 'wtB'); const merged = path.join(tmp, 'merged');
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${extra ? ' — ' + extra : ''}`); c ? pass++ : fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

(async () => {
  try {
    // 1. A tiny repo: lib.js declares limit(n); api.js calls limit(req.count). Commit, then REALLY index it.
    fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'lib.js'), 'export function limit(n){ return n > 100 ? 100 : n; }\n');
    fs.writeFileSync(path.join(repo, 'api.js'), "import { limit } from './lib.js';\nexport function handle(req){ return limit(req.count); }\n");
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    const indexedSha = git(repo, 'rev-parse', 'HEAD');
    execFileSync('node', [BIN, 'ingest', repo], { env, stdio: 'ignore' });

    const svc = createGraphService();
    // sanity: the base graph really resolves the dependency limit ← api.js (via neighbours --direction in)
    const br = await svc.callTool('neighbours', { symbol: 'limit', direction: 'in' }, { cwd: repo, fresh: false }).catch((e) => ({ text: 'ERR ' + e.message }));
    ok(/api\.js/.test(br.text || ''), 'baseline: real graph knows api.js depends on limit', (br.text || '').split('\n').find((l) => /api\.js/.test(l)) || '');

    // 2. Worker A: change limit()'s ARITY in lib.js (needs a 2nd arg now). Only lib.js changes on this branch.
    git(repo, 'worktree', 'add', '-q', '-b', 'kora/a', wtA, 'HEAD');
    fs.writeFileSync(path.join(wtA, 'lib.js'), 'export function limit(n, ceiling){ return n > ceiling ? ceiling : n; }\n');
    git(wtA, 'add', '.'); git(wtA, 'commit', '-q', '-m', 'A: limit takes a ceiling');

    // 3. Worker B: edit api.js but STILL call limit with the old single arg. Only api.js changes on this branch.
    git(repo, 'worktree', 'add', '-q', '-b', 'kora/b', wtB, 'HEAD');
    fs.writeFileSync(path.join(wtB, 'api.js'), "import { limit } from './lib.js';\nexport function handle(req){ const capped = limit(req.count); return capped; }\n");
    git(wtB, 'add', '.'); git(wtB, 'commit', '-q', '-m', 'B: tidy handle()');

    // 4. THE CONTRAST — git merges both branches CLEAN (different files, no textual overlap).
    git(repo, 'worktree', 'add', '-q', '-b', 'merge-test', merged, 'HEAD');
    git(merged, 'merge', '--no-edit', '-q', 'kora/a');
    let gitClean = true; try { git(merged, 'merge', '--no-edit', '-q', 'kora/b'); } catch { gitClean = false; }
    ok(gitClean, 'git merge of both workers reports NO conflict (the composition looks fine to git)');

    // 5. THE KEYSTONE — the graph, given the two worktrees, flags the semantic conflict git missed.
    const workers = [{ paneId: 'A', path: wtA, indexedSha }, { paneId: 'B', path: wtB, indexedSha }];
    const rep = await crossWorktreeConflicts(workers, svc);
    console.log('  report:', JSON.stringify(rep));
    const pair = (rep.pairs || [])[0];
    ok(!!pair, 'crossWorktreeConflicts returned a pair for A ⇄ B');
    ok(pair && (pair.status === 'semantic' || pair.status === 'needs-human'), 'the pair is flagged as a conflict, not clean', pair && pair.status);
    const blames = (pair && pair.blame) || [];
    ok(pair && pair.status === 'semantic' && blames.some((b) => /limit/.test(b.symbol) && b.byWorker === 'A'), 'blame names limit, broken by worker A', JSON.stringify(blames));
    ok(Array.isArray(rep.order) && rep.order.length === 2, 'a merge order is returned');

    for (const w of [wtA, wtB, merged]) { try { git(repo, 'worktree', 'remove', '--force', w); } catch { /* ignore */ } }

    // 6. THE STANDALONE ENGINE — same conflict, but reached through verifyMerge on BRANCH refs (materialize +
    //    merge-base + changedSinceRef), the path `kora merge`/`kora pr` use. Proves the tool works on branches,
    //    not just live worktrees. (branches kora/a, kora/b still exist in `repo`.)
    const { verifyMerge, exitCodeFor } = require(path.join(N, 'dist', 'merge', 'engine'));
    const vr = await verifyMerge(repo, [{ kind: 'branch', name: 'kora/a' }, { kind: 'branch', name: 'kora/b' }], svc);
    console.log('  engine report:', JSON.stringify(vr));
    ok(vr.pairs && vr.pairs[0], 'verifyMerge(branches) returned a pair');
    ok(vr.pairs[0] && vr.pairs[0].status === 'semantic', 'engine flags the branch pair semantic (git merges it clean)', vr.pairs[0] && vr.pairs[0].status);
    ok(vr.base && vr.base.length > 0, 'engine resolved a merge-base', vr.base);
    ok(exitCodeFor(vr.pairs) === 3, 'exit-code contract: semantic → 3');
  } catch (e) { ok(false, 'threw', e.stack || e.message); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
  console.log(`\n${fail ? 'FAIL' : 'OK'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
