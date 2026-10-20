// End-to-end PRECISION suite for the merge gate, with a REAL koragraph index and REAL git branches (no fakes).
// The keystone (e2e-merge-keystone.js) proves the gate catches the conflict git misses. This proves it is PRECISE:
//   1. no false positive: A edits a symbol in a shared file that B's file does NOT depend on → clean
//   2. rename: A renames the symbol B's file calls → semantic, blame says the old name no longer exists
//   3. delete: A deletes the file that declares it → semantic
//   4. new caller: B adds a brand-new file calling A's re-signatured function (no edge in the base index) → semantic
//   5. target semantics: once A is merged into main, verifying [A, B] against main shows A has nothing left → clean
//   6. 3-way: A, B, C where only A×C couple → exactly one semantic pair and an order that puts A last
// Run:  npm run build && node scripts/e2e-merge-precision.js
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const N = path.resolve(__dirname, '..'); const BIN = path.join(N, 'bin', 'kora.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-merge-prec-'));
process.env.KORAGRAPH_DB = path.join(tmp, 'g.db');
process.env.KORAGRAPH_PRACTICE_DB = path.join(tmp, 'p.db');
process.env.KORAGRAPH_HOME = tmp;
process.env.HOME = tmp; // throwaway worktrees under a temp ~/.kora
const env = { ...process.env };
const { createGraphService } = require(path.join(N, 'dist', 'graph'));
const { verifyMerge } = require(path.join(N, 'dist', 'merge', 'engine'));

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${extra ? ' — ' + extra : ''}`); c ? pass++ : fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const write = (root, rel, txt) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), txt); };
const branch = (repo, name, edits) => {
  git(repo, 'checkout', '-q', '-b', name, 'main');
  for (const [rel, txt] of Object.entries(edits)) { if (txt === null) { fs.rmSync(path.join(repo, rel)); git(repo, 'rm', '-q', rel); } else { write(repo, rel, txt); git(repo, 'add', rel); } }
  git(repo, 'commit', '-q', '-m', name);
  git(repo, 'checkout', '-q', 'main');
};
const pairOf = (r, a, b) => r.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));

(async () => {
  try {
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    // lib.js declares limit() (called by api.js) and fmt() (called by nobody in api.js). report.js calls fmt().
    write(repo, 'lib.js', 'export function limit(n){ return n > 100 ? 100 : n; }\n\nexport function fmt(x){ return String(x); }\n');
    write(repo, 'api.js', "import { limit } from './lib.js';\nexport function handle(req){ return limit(req.count); }\n");
    write(repo, 'report.js', "import { fmt } from './lib.js';\nexport function render(v){ return fmt(v); }\n");
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    execFileSync('node', [BIN, 'ingest', repo], { env, stdio: 'ignore' });
    const svc = createGraphService();
    const sanity = await svc.callTool('neighbours', { symbol: 'fmt', direction: 'in' }, { cwd: repo, fresh: false }).catch((e) => ({ text: 'ERR ' + e.message }));
    ok(/report\.js/.test(sanity.text || ''), 'baseline: graph knows report.js depends on fmt');

    // ---- 1. precision: A edits ONLY fmt (in lib.js); B edits api.js (depends on limit, not fmt) → clean ----
    branch(repo, 'p/a-fmt', { 'lib.js': 'export function limit(n){ return n > 100 ? 100 : n; }\n\nexport function fmt(x, pad){ return String(x).padStart(pad); }\n' });
    branch(repo, 'p/b-api', { 'api.js': "import { limit } from './lib.js';\nexport function handle(req){ const c = limit(req.count); return c; }\n" });
    let r = await verifyMerge(repo, [{ kind: 'branch', name: 'p/a-fmt' }, { kind: 'branch', name: 'p/b-api' }], svc, { targetRef: 'main' });
    console.log('  1:', JSON.stringify(r.pairs));
    ok(r.pairs[0] && r.pairs[0].status === 'clean', '1. no false positive: an untouched symbol in a shared file does not couple the branches', r.pairs[0] && r.pairs[0].status);

    // ---- 2. rename: A renames limit → clamp; B edits api.js (still calls limit) → semantic, removed ----
    branch(repo, 'p/a-rename', { 'lib.js': 'export function clamp(n){ return n > 100 ? 100 : n; }\n\nexport function fmt(x){ return String(x); }\n' });
    r = await verifyMerge(repo, [{ kind: 'branch', name: 'p/a-rename' }, { kind: 'branch', name: 'p/b-api' }], svc, { targetRef: 'main' });
    console.log('  2:', JSON.stringify(r.pairs));
    let p = r.pairs[0];
    ok(p && p.status === 'semantic' && (p.blame || []).some((b) => b.symbol === 'limit' && b.removed && b.byWorker === 'p/a-rename'), '2. rename: the OLD name\'s callers in the other diff are flagged, marked removed', p && p.reason);

    // ---- 3. delete: A deletes lib.js; B edits api.js → semantic ----
    branch(repo, 'p/a-delete', { 'lib.js': null });
    r = await verifyMerge(repo, [{ kind: 'branch', name: 'p/a-delete' }, { kind: 'branch', name: 'p/b-api' }], svc, { targetRef: 'main' });
    console.log('  3:', JSON.stringify(r.pairs));
    p = r.pairs[0];
    ok(p && p.status === 'semantic' && (p.blame || []).some((b) => b.symbol === 'limit' && b.removed), '3. delete: a deleted declaration still called by the other diff is semantic', p && p.reason);

    // ---- 4. new caller: A re-signatures limit (lib.js only); B adds feature.js calling limit (no edge in the index) ----
    branch(repo, 'p/a-arity', { 'lib.js': 'export function limit(n, ceiling){ return n > ceiling ? ceiling : n; }\n\nexport function fmt(x){ return String(x); }\n' });
    branch(repo, 'p/b-feature', { 'feature.js': "import { limit } from './lib.js';\nexport function feature(q){ return limit(q.n); }\n" });
    r = await verifyMerge(repo, [{ kind: 'branch', name: 'p/a-arity' }, { kind: 'branch', name: 'p/b-feature' }], svc, { targetRef: 'main' });
    console.log('  4:', JSON.stringify(r.pairs));
    p = r.pairs[0];
    ok(p && p.status === 'semantic' && (p.blame || []).some((b) => b.kind === 'reference' && b.file === 'feature.js' && b.symbol === 'limit'), '4. new caller in a brand-new file (no base edge) is caught by the reference scan', p && p.reason);
    // and the contrast: B adds a file that does NOT mention limit → clean
    branch(repo, 'p/b-quiet', { 'quiet.js': 'export function quiet(){ return 1; }\n' });
    r = await verifyMerge(repo, [{ kind: 'branch', name: 'p/a-arity' }, { kind: 'branch', name: 'p/b-quiet' }], svc, { targetRef: 'main' });
    ok(r.pairs[0] && r.pairs[0].status === 'clean', '4b. a new file that never names the changed symbol stays clean', r.pairs[0] && r.pairs[0].status);

    // ---- 5. target semantics: merge A into main, then verify [A, B] against main → A has nothing left → clean ----
    git(repo, 'merge', '-q', '--no-edit', 'p/a-arity');
    r = await verifyMerge(repo, [{ kind: 'branch', name: 'p/a-arity' }, { kind: 'branch', name: 'p/b-feature' }], svc, { targetRef: 'main' });
    console.log('  5:', JSON.stringify(r.pairs), 'bases', JSON.stringify(r.bases));
    ok(r.pairs[0] && r.pairs[0].status === 'clean', '5. an already-merged ref contributes no changes against the target (no stale blame)', r.pairs[0] && r.pairs[0].status);
    // whereas the fork-point mode (no target) still relates them to each other
    r = await verifyMerge(repo, [{ kind: 'branch', name: 'p/a-arity' }, { kind: 'branch', name: 'p/b-feature' }], svc);
    ok(r.pairs[0] && r.pairs[0].status === 'semantic', '5b. fork-point mode (no target) still shows how the two branches relate', r.pairs[0] && r.pairs[0].status);
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');

    // ---- 6. three-way: A (arity), B (quiet), C (feature calls limit) → only A×C semantic; order ends with A or C ----
    r = await verifyMerge(repo, [{ kind: 'branch', name: 'p/a-arity' }, { kind: 'branch', name: 'p/b-quiet' }, { kind: 'branch', name: 'p/b-feature' }], svc, { targetRef: 'main' });
    console.log('  6:', JSON.stringify(r.pairs.map((x) => [x.a, x.b, x.status])), 'order', r.order.join(' → '));
    const sem = r.pairs.filter((x) => x.status === 'semantic');
    ok(r.pairs.length === 3 && sem.length === 1 && pairOf(r, 'p/a-arity', 'p/b-feature').status === 'semantic', '6. three refs: exactly the coupled pair is flagged', r.pairs.map((x) => `${x.a}×${x.b}:${x.status}`).join(' '));
    ok(r.order[0] === 'p/b-quiet', '6b. the uncoupled ref merges first', r.order.join(' → '));

    // ---- 7. uncommitted work in a live worktree counts (the fleet case) ----
    const wt = path.join(tmp, 'wt-live'); git(repo, 'worktree', 'add', '-q', '-b', 'p/live', wt, 'main');
    write(wt, 'api.js', "import { limit } from './lib.js';\nexport function handle(req){ return limit(req.count, 50); }\n"); // NOT committed
    r = await verifyMerge(repo, [{ kind: 'worktree', path: wt, label: 'live' }, { kind: 'branch', name: 'p/a-arity' }], svc, { targetRef: 'main' });
    console.log('  7:', JSON.stringify(r.pairs));
    ok(r.pairs[0] && r.pairs[0].status === 'clean' && /matches the new signature/.test(r.pairs[0].reason || '') && r.refs.includes('live'), '7. a live worktree whose (uncommitted) call already fits the new signature is clean, and says why', r.pairs[0] && (r.pairs[0].status + ' — ' + r.pairs[0].reason));
    // 7b. the same worktree calling with the OLD arity → a real break → semantic
    write(wt, 'api.js', "import { limit } from './lib.js';\nexport function handle(req){ return limit(req.count) + 1; }\n");
    r = await verifyMerge(repo, [{ kind: 'worktree', path: wt, label: 'live' }, { kind: 'branch', name: 'p/a-arity' }], svc, { targetRef: 'main' });
    console.log('  7b:', JSON.stringify(r.pairs));
    ok(r.pairs[0] && r.pairs[0].status === 'semantic', '7b. the same call with the old arity is a semantic conflict', r.pairs[0] && r.pairs[0].status);
    git(repo, 'worktree', 'remove', '--force', wt);
  } catch (e) { ok(false, 'threw', e.stack || e.message); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
  console.log(`\n${fail ? 'FAIL' : 'OK'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
