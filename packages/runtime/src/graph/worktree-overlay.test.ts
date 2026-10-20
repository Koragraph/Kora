import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedSinceIndex, declaredInChanged, subjectSymbol, overlayNotes, fileChange, reresolveLines, ADDED_FILE_MAX_BYTES } from './worktree-overlay';

// ---- pure helpers ----
test('subjectSymbol: symbol arg wins; a lone identifier query counts; a phrase does not', () => {
  assert.equal(subjectSymbol('blast_radius', { symbol: 'updatePrice' }), 'updatePrice');
  assert.equal(subjectSymbol('neighbours', { symbol: 'Session.get' }), 'Session.get');
  assert.equal(subjectSymbol('explore', { query: 'roundMoney' }), 'roundMoney');
  assert.equal(subjectSymbol('explore', { query: 'how does pricing work' }), null);
  assert.equal(subjectSymbol('search_code', { query: 'a' }), null); // too short
});

test('declaredInChanged: finds a symbol declared in a changed file, across languages; ignores non-symbols', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-decl-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export function roundMoney(n: number) { return Math.round(n); }\n');
  fs.writeFileSync(path.join(dir, 'b.py'), 'def compute_total(items):\n    return sum(items)\n');
  fs.writeFileSync(path.join(dir, 'c.js'), 'const helper = () => 1;\nclass Widget {}\n');
  assert.equal(declaredInChanged(dir, ['a.ts', 'b.py', 'c.js'], 'roundMoney'), 'a.ts');
  assert.equal(declaredInChanged(dir, ['a.ts', 'b.py', 'c.js'], 'compute_total'), 'b.py');
  assert.equal(declaredInChanged(dir, ['a.ts', 'b.py', 'c.js'], 'helper'), 'c.js');
  assert.equal(declaredInChanged(dir, ['a.ts', 'b.py', 'c.js'], 'Widget'), 'c.js');
  assert.equal(declaredInChanged(dir, ['a.ts', 'b.py', 'c.js'], 'nonexistent'), null);
  assert.equal(declaredInChanged(dir, ['a.ts'], 'not an ident'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- overlayNotes: the honesty logic (pure) ----
const bl = (args: any, text: string, changed: string[], root: string) =>
  overlayNotes({ name: 'blast_radius', args, text, root, div: { changed, truncated: false } });

test('overlayNotes: no divergence → no note (never cries wolf on a clean checkout)', () => {
  assert.equal(overlayNotes({ name: 'blast_radius', args: { symbol: 'x' }, text: 'dependents: a@f.ts:1', root: '/r', div: { changed: [], truncated: false } }), '');
  assert.equal(overlayNotes({ name: 'explore', args: { query: 'x' }, text: '■ X @ f.ts:1', root: '/r', div: { changed: [], truncated: false } }), '');
});

test('overlayNotes: blast_radius on a target FILE that changed → warns about missing call sites', () => {
  const note = bl({ files_changed: ['src/pricing.ts'] }, 'Changed: src/pricing.ts\nDependents: checkout @ src/cart/checkout.ts:12', ['src/pricing.ts'], '/r');
  assert.match(note, /pricing\.ts changed on this branch/);
  assert.match(note, /grep/);
});

test('overlayNotes: blast_radius on an UNCHANGED pre-existing symbol → no wolf', () => {
  // symbol edited nowhere; the file it lives in is not in the changed set; base answer is correct.
  const note = bl({ symbol: 'updatePrice' }, '■ METHOD updatePrice @ src/pricing.ts:42\nDependents: a @ src/x.ts:1', ['README.md'], '/r');
  assert.equal(note, '', 'a pre-existing symbol whose file did not change gets no warning');
});

test('overlayNotes: blast_radius on a BRAND-NEW symbol → explicit "new, grep for callers"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-new-'));
  fs.writeFileSync(path.join(dir, 'pricing.ts'), 'export function roundMoney(n){return n;}\n');
  // base graph returned nothing for roundMoney (no ■/@/dependent), and it is declared in a changed file
  const note = overlayNotes({ name: 'blast_radius', args: { symbol: 'roundMoney' }, text: 'No dependents found.', root: dir, div: { changed: ['pricing.ts'], truncated: false } });
  assert.match(note, /roundMoney is NEW on this branch/);
  assert.match(note, /pricing\.ts/);
  assert.match(note, /grep/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('overlayNotes: explore/search hits in changed files are labelled "may have moved"', () => {
  const note = overlayNotes({ name: 'explore', args: { query: 'updatePrice' }, text: '■ METHOD updatePrice @ src/pricing.ts:42', root: '/r', div: { changed: ['src/pricing.ts'], truncated: false } });
  assert.match(note, /worktree:/);
  assert.match(note, /pricing\.ts changed on this branch/);
  assert.match(note, /may have moved/);
});

test('overlayNotes: explore of a NEW symbol not in the graph → points at the changed file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-new2-'));
  fs.writeFileSync(path.join(dir, 'm.js'), 'function freshOne(){}\n');
  const note = overlayNotes({ name: 'explore', args: { query: 'freshOne' }, text: 'PARTIAL: no strong match', root: dir, div: { changed: ['m.js'], truncated: false } });
  assert.match(note, /freshOne is NEW on this branch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- changedSinceIndex against a real git repo ----
test('changedSinceIndex: reports committed-on-branch + unstaged + untracked vs the indexed sha; empty when clean', () => {
  const g = (cwd: string, ...a: string[]) => { const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-div-'));
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
  const indexed = g(repo, 'rev-parse', 'HEAD');
  assert.deepEqual(changedSinceIndex(repo, indexed).changed, [], 'clean at the indexed sha → nothing');
  assert.deepEqual(changedSinceIndex(repo, null).changed, [], 'no indexed sha → nothing');
  // a committed change on top, an unstaged edit, and an untracked file
  fs.appendFileSync(path.join(repo, 'a.js'), 'export const b = 2;\n'); g(repo, 'commit', '-qam', 'more');
  fs.writeFileSync(path.join(repo, 'c.js'), 'export const c = 3;\n'); // untracked
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\nexport const b = 2;\nexport const d = 4;\n'); // unstaged on top
  const div = changedSinceIndex(repo, indexed);
  assert.ok(div.changed.includes('a.js'), 'a.js differs from the indexed sha');
  assert.ok(div.changed.includes('c.js'), 'untracked c.js is reported');
  fs.rmSync(repo, { recursive: true, force: true });
});

import { primaryHitFiles } from './worktree-overlay';
test('primaryHitFiles: only ■ top-hit files, not callees/imports it references', () => {
  const text = [
    '■ METHOD checkout @ src/checkout.js:2 — checkout(x)',
    '  callees: updatePrice @ src/pricing.js:1',
    '  --- source src/checkout.js:2-3 ---',
    'other matches:',
    '  METHOD updatePrice @ src/pricing.js:1',
  ].join('\n');
  assert.deepEqual(primaryHitFiles(text), ['src/checkout.js']); // NOT src/pricing.js (a callee / other match)
});

test('overlayNotes: neighbours / search_code answers from a changed file are labelled (their line numbers ARE the answer)', () => {
  const div = { changed: ['src/hook.ts'], truncated: false };
  const nb = [
    'METHOD graphReady @ src/hook.ts:L289',
    '2 caller(s), 0 callee(s) shown of 2 relation(s).',
    '  in   ← CALLS ←  METHOD preTool @ src/hook.ts:L337 (line 335)',
    '  in   ← CALLS ←  METHOD run @ src/main.ts:L20 (line 22)',
  ].join('\n');
  assert.deepEqual(primaryHitFiles(nb, 'neighbours'), ['src/hook.ts', 'src/main.ts']);
  assert.match(overlayNotes({ name: 'neighbours', args: { symbol: 'graphReady' }, text: nb, root: '/r', div }), /src\/hook\.ts changed on this branch since the index/);
  const sc = '2 match(es) for "graphReady" across 1 file(s)\n  src/hook.ts: METHOD graphReady:289, METHOD graphReady:306';
  assert.match(overlayNotes({ name: 'search_code', args: { query: 'graphReady' }, text: sc, root: '/r', div }), /src\/hook\.ts changed on this branch/);
  // an answer that lives only in unchanged files stays unlabelled
  assert.equal(overlayNotes({ name: 'search_code', args: { query: 'graphReady' }, text: sc.replace(/src\/hook\.ts/g, 'src/other.ts'), root: '/r', div: { changed: ['src/x.ts'], truncated: false } }), '');
  // explore keeps its ■-only rule: a relation-shaped line there is not an answer
  assert.deepEqual(primaryHitFiles('  in   ← CALLS ←  METHOD preTool @ src/hook.ts:L337', 'explore'), []);
});

test('security: fileChange never reads an ADDED symlink (it could point at ~/.ssh) or an oversized added file', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-overlay-sec-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-overlay-out-'));
  const g = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  try {
    g('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(outside, 'id_rsa'), 'SECRET-KEY-MATERIAL\n');
    fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(repo, 'notes.txt'));
    const link = fileChange(repo, base, 'notes.txt');
    assert.equal(link.opaque, true);
    assert.ok(!JSON.stringify(link).includes('SECRET'), 'the link target was not read');
    fs.writeFileSync(path.join(repo, 'big.txt'), Buffer.alloc(ADDED_FILE_MAX_BYTES + 1, 0x61));
    const big = fileChange(repo, base, 'big.txt');
    assert.equal(big.opaque, true); assert.equal(big.added.length, 0);
    fs.writeFileSync(path.join(repo, 'small.ts'), 'x\ny\n');
    assert.deepEqual(fileChange(repo, base, 'small.ts').added.map((l) => l.text), ['x', 'y'], 'a normal added file still reads');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('reresolveLines: neighbours / search_code lines in a changed file are re-read from the checkout; stale duplicates collapse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rr-'));
  fs.mkdirSync(path.join(dir, 'src'));
  const src = [
    'import x from "y";',                                  // 1
    '',                                                    // 2
    'export function graphReady(cwd: string): boolean {',  // 3
    '  return !!cwd;',                                     // 4
    '}',                                                   // 5
    '// graphReady is mentioned in a comment',             // 6
    'export function preTool(input: any): void {',         // 7
    '  if (graphReady(input.cwd)) return;',                // 8
    '}',                                                   // 9
    'export const hooks = {',                              // 10
    '  indexed: async () => graphReady(cwd),',             // 11
    '};',                                                  // 12
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'src', 'hook.ts'), src);
  const changed = new Set(['src/hook.ts']);
  const nb = [
    'METHOD graphReady @ src/hook.ts:L289',
    'METHOD graphReady @ src/hook.ts:L306',
    '3 caller(s), 0 callee(s) shown of 3 relation(s).',
    '(2 declarations share this name — relations below are the union)',
    '  in   ← CALLS ←  METHOD indexed @ src/hook.ts:L517 (line 517)',
    '  in   ← CALLS ←  METHOD preTool @ src/hook.ts:L337 (line 335)',
    '  in   ← CALLS ←  METHOD preTool @ src/hook.ts:L354 (line 379)',
    '  in   ← CONTAINS ←  FILE src/hook.ts @ src/hook.ts:L1',
  ].join('\n');
  const r = reresolveLines('neighbours', nb, dir, changed, 'graphReady');
  assert.deepEqual(r.files, ['src/hook.ts']);
  assert.equal(r.text, [
    'METHOD graphReady @ src/hook.ts:L3',
    '3 caller(s), 0 callee(s) shown of 3 relation(s).',
    '  in   ← CALLS ←  METHOD indexed @ src/hook.ts:L11 (line 11)',
    '  in   ← CALLS ←  METHOD preTool @ src/hook.ts:L7 (line 8)',
    '  in   ← CONTAINS ←  FILE src/hook.ts @ src/hook.ts:L1',
    '(1 relation(s) dropped: the call site is no longer in this checkout)',
  ].join('\n'), 'the second preTool relation has no use left inside preTool (the next one is in `indexed`)');
  const sc = '2 match(es) for "graphReady" across 1 file(s)\n  src/hook.ts: METHOD graphReady:289, METHOD graphReady:306';
  assert.equal(reresolveLines('search_code', sc, dir, changed, 'graphReady').text, '2 match(es) for "graphReady" across 1 file(s)\n  src/hook.ts: METHOD graphReady:3');
  // a name that is gone stays as it was and is reported unresolved (the "may have moved" label keeps it honest)
  const gone = reresolveLines('search_code', '  src/hook.ts: METHOD removedFn:40', dir, changed, 'removedFn');
  assert.deepEqual([gone.files, gone.unresolved, gone.text], [[], ['src/hook.ts'], '  src/hook.ts: METHOD removedFn:40']);
  // unchanged files and other tools are never touched
  assert.equal(reresolveLines('search_code', sc, dir, new Set(), 'graphReady').text, sc);
  assert.equal(reresolveLines('blast_radius', nb, dir, changed, 'graphReady').text, nb);
  // the note says re-read, not "may have moved"
  const note = overlayNotes({ name: 'neighbours', args: { symbol: 'graphReady' }, text: r.text, root: dir, div: { changed: [...changed], truncated: false }, reresolved: r.files });
  assert.match(note, /re-read from this checkout/); assert.doesNotMatch(note, /may have moved/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reresolveLines: explore re-reads a changed file\'s source excerpt, headline, callers and other matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rx-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'hook.ts'), [
    'import x from "y";',                                  // 1
    '',                                                    // 2
    'export function graphReady(cwd: string): boolean {',  // 3
    '  return !!cwd;',                                     // 4
    '}',                                                   // 5
    '// graphReady is mentioned in a comment',             // 6
    'export function preTool(input: any): void {',         // 7
    '  if (graphReady(input.cwd)) return;',                // 8
    '}',                                                   // 9
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'other.ts'), 'export function graphReady() {}\n');
  const changed = new Set(['src/hook.ts']);
  const ex = [
    '3 match(es) for "graphReady". Focus: 2 symbol(s) with callers/callees + source.',
    '',
    '■ METHOD graphReady @ src/hook.ts:289 — graphReady(cwd: string): boolean',
    '  callers: preTool@src/hook.ts:354 (call at :379)',
    '  --- source src/hook.ts:289-291 ---',
    'stale line a',                                        // what the INDEXED range shows of today's file
    'stale line b',
    'stale line c',
    '',
    '■ METHOD graphReady @ src/other.ts:1 — graphReady()',
    '  --- source src/other.ts:1-1 ---',
    'export function graphReady() {}',
    '',
    'other matches:',
    '  METHOD graphReady @ src/hook.ts:306',
    '  METHOD preTool @ src/hook.ts:354',
  ].join('\n');
  const r = reresolveLines('explore', ex, dir, changed, 'graphReady');
  assert.deepEqual(r.files, ['src/hook.ts']);
  assert.equal(r.text, [
    '3 match(es) for "graphReady". Focus: 2 symbol(s) with callers/callees + source.',
    '',
    '■ METHOD graphReady @ src/hook.ts:3 — graphReady(cwd: string): boolean',
    '  callers: preTool@src/hook.ts:7 (call at :8)',
    '  --- source src/hook.ts:3-5 ---',
    'export function graphReady(cwd: string): boolean {',
    '  return !!cwd;',
    '}',
    '',
    '■ METHOD graphReady @ src/other.ts:1 — graphReady()',
    '  --- source src/other.ts:1-1 ---',
    'export function graphReady() {}',
    '',
    'other matches:',
    '  METHOD preTool @ src/hook.ts:7',
  ].join('\n'), 'the stale duplicate (hook.ts:306) collapses into the hit already shown; unchanged files are untouched');
  // a declaration gone from the checkout keeps its block as it was (the "may have moved" label stays)
  const gone = reresolveLines('explore', '■ METHOD removedFn @ src/hook.ts:40 — removedFn()\n  --- source src/hook.ts:40-41 ---\nx\ny\n', dir, changed, 'removedFn');
  assert.deepEqual([gone.files, gone.unresolved], [[], ['src/hook.ts']]);
  fs.rmSync(dir, { recursive: true, force: true });
});
