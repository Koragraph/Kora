// End-to-end for the worktree graph overlay (option 2). Isolated store, real koragraph index, a real git worktree.
// Proves: main stays unlabelled (freshness handles it); a worktree labels changed-file hits, flags a brand-new
// symbol, and warns on blast_radius of a changed file; an unchanged symbol in an unchanged file gets no label.
// Run:  npm run build && node scripts/e2e-worktree-graph.js
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const N = path.resolve(__dirname, '..'); const BIN = path.join(N, 'bin', 'kora.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-wtg-'));
const env = { ...process.env, KORAGRAPH_DB: path.join(tmp, 'g.db'), KORAGRAPH_PRACTICE_DB: path.join(tmp, 'p.db'), KORAGRAPH_HOME: tmp, KORA_HOME: path.join(tmp, 'home') };
const repo = path.join(tmp, 'repo'); const wt = path.join(tmp, 'wt');
let pass = 0, fail = 0;
const ok = (c, m, extra='') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${extra ? ' — ' + extra : ''}`); c ? pass++ : fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const graph = (cwd, ...a) => { const r = spawnSync('node', [BIN, 'graph', ...a], { cwd, env, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
try {
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'pricing.js'), 'export function updatePrice(cents){ return cents+1; }\nexport function total(items){ return items.reduce((a,b)=>a+b,0); }\n');
  fs.writeFileSync(path.join(repo, 'checkout.js'), "import { updatePrice } from './pricing.js';\nexport function checkout(x){ return updatePrice(x); }\n");
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  execFileSync('node', [BIN, 'ingest', repo], { env, stdio: 'ignore' });
  ok(/updatePrice/.test(graph(repo, 'explore', 'updatePrice')), 'baseline: main resolves updatePrice');

  // main, uncommitted edit → NO worktree label (freshness handles main)
  fs.appendFileSync(path.join(repo, 'pricing.js'), 'export function mainOnly(){ return 0; }\n');
  ok(!/worktree:/.test(graph(repo, 'explore', 'updatePrice')), 'main with an uncommitted edit is NOT labelled');
  git(repo, 'checkout', '--', 'pricing.js');

  // worktree with edits
  git(repo, 'worktree', 'add', '-q', '-b', 'kora/e2e', wt, 'HEAD');
  fs.writeFileSync(path.join(wt, 'pricing.js'), 'export function updatePrice(cents, currency){ return cents+(currency?2:1); }\nexport function total(items){ return items.reduce((a,b)=>a+b,0); }\nexport function roundMoney(n){ return Math.round(n); }\n');

  const eUpd = graph(wt, 'explore', 'updatePrice');
  ok(/worktree:/.test(eUpd) && /pricing\.js changed/.test(eUpd) && /moved/.test(eUpd), 'worktree: hit in a changed file is labelled "may have moved"');

  const eNew = graph(wt, 'explore', 'roundMoney');
  ok(/roundMoney is NEW on this branch/.test(eNew) && /pricing\.js/.test(eNew), 'worktree: brand-new symbol flagged NEW, points at the file');

  const bl = graph(wt, 'blast_radius', '--file', 'pricing.js');
  ok(/⚠/.test(bl) && /pricing\.js changed on this branch/.test(bl) && /grep/.test(bl), 'worktree: blast_radius on a changed file warns + says grep');

  // a subject entirely in an UNCHANGED file → no label (checkout.js was not touched in the worktree)
  const fchk = graph(wt, 'file_symbols', 'checkout.js');
  ok(!/worktree:/.test(fchk), 'worktree: a subject in an unchanged file gets no label', fchk.split('\n').filter(Boolean).pop());
  // explore that co-surfaces a changed file among its top hits IS labelled — honest, not noise
  ok(/worktree:/.test(graph(wt, 'explore', 'checkout')), 'worktree: a result that surfaces a changed file among top hits is labelled');

  git(repo, 'worktree', 'remove', '--force', wt);
} catch (e) { ok(false, 'threw', e.message); }
finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${fail ? 'FAIL' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
