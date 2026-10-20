import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsertBlock, removeBlock, hasBlock, BEGIN, END } from './agentsmd';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'kora-agentsmd-')); }

test('managed block: create, idempotent refresh, replace in place, never touch outside markers', () => {
  const dir = tmp();
  const file = path.join(dir, 'AGENTS.md');
  const r1 = upsertBlock(file, 'RULE ONE');
  assert.equal(r1.action, 'installed');
  assert.ok(hasBlock(file));
  const r2 = upsertBlock(file, 'RULE ONE');
  assert.equal(r2.action, 'managed', 'same body is a no-op');
  assert.equal(fs.readFileSync(file, 'utf8').split(BEGIN).length, 2, 'exactly one block');

  // developer content above and below survives a refresh
  fs.writeFileSync(file, `# Mine\nabove\n\n${fs.readFileSync(file, 'utf8')}\nbelow\n`);
  const r3 = upsertBlock(file, 'RULE TWO');
  assert.equal(r3.action, 'refreshed');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /# Mine\nabove/);
  assert.match(body, /below\n$/);
  assert.ok(body.includes('RULE TWO') && !body.includes('RULE ONE'));
  assert.equal(body.split(BEGIN).length, 2);
  assert.equal(body.split(END).length, 2);

  const r4 = removeBlock(file);
  assert.equal(r4.action, 'removed');
  assert.ok(!hasBlock(file));
  assert.match(fs.readFileSync(file, 'utf8'), /above[\s\S]*below/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('managed block: --no-create leaves a missing file alone; a block-only file is removed on uninstall', () => {
  const dir = tmp();
  const file = path.join(dir, 'GEMINI.md');
  assert.equal(upsertBlock(file, 'x', { create: false }).action, 'absent');
  assert.ok(!fs.existsSync(file));
  upsertBlock(file, 'x', { frontmatter: '---\nalwaysApply: true\n---\n\n' });
  assert.match(fs.readFileSync(file, 'utf8'), /^---\nalwaysApply: true\n---\n\n<!-- kora:begin -->/);
  assert.equal(removeBlock(file).action, 'removed');
  assert.ok(!fs.existsSync(file), 'file held only our block (plus our frontmatter) so it is gone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('managed block: an orphan begin marker (end deleted by hand) never swallows the user text after it', () => {
  const dir = tmp();
  const file = path.join(dir, 'CLAUDE.md');
  // The user deleted our END marker (and kept the rest of the old block as their own notes), then wrote more below.
  fs.writeFileSync(file, `# Team notes\n${BEGIN}\nold rules the user kept editing\n\n## Deploy\nnever deploy on fridays\n`);
  upsertBlock(file, 'RULE ONE');
  upsertBlock(file, 'RULE TWO'); // the second refresh used to match from the ORPHAN begin to our end marker
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /never deploy on fridays/, 'user text after the orphan marker survives');
  assert.match(body, /old rules the user kept editing/);
  assert.ok(body.includes('RULE TWO') && !body.includes('RULE ONE'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('managed block: duplicated blocks (a merge that kept both sides) collapse into one', () => {
  const dir = tmp();
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, `top\n\n${BEGIN}\nA\n${END}\nmiddle\n\n${BEGIN}\nB\n${END}\nbottom\n`);
  assert.equal(upsertBlock(file, 'C').action, 'refreshed');
  const body = fs.readFileSync(file, 'utf8');
  assert.equal(body.split(BEGIN).length, 2, 'one block left');
  assert.match(body, /top[\s\S]*C[\s\S]*middle[\s\S]*bottom/);
  assert.equal(removeBlock(file).action, 'removed');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(BEGIN), 'remove takes every copy');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a CLAUDE.md Kora creates is kept out of git; one the user already had is not', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-excl-'));
  execFileSync('git', ['init', '-q', repo]);
  upsertBlock(path.join(repo, 'CLAUDE.md'), 'rules', { agent: 'claude' });
  const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/CLAUDE\.md$/m);
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).includes('CLAUDE.md'), false);
  // Idempotent, and a pre-existing file is never excluded.
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# mine\n');
  upsertBlock(path.join(repo, 'AGENTS.md'), 'rules', { agent: 'codex' });
  upsertBlock(path.join(repo, 'CLAUDE.md'), 'rules v2', { agent: 'claude' });
  const after = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(after.match(/^\/CLAUDE\.md$/gm)?.length, 1);
  assert.equal(/AGENTS\.md/.test(after), false);
});

test('security: a repo-committed symlink never redirects the managed block (or an MCP json) outside the repo', () => {
  const repo = fs.realpathSync(tmp()); const outside = fs.realpathSync(tmp());
  const victim = path.join(outside, 'zshrc');
  fs.writeFileSync(victim, 'export MINE=1\n');
  fs.symlinkSync(victim, path.join(repo, 'CLAUDE.md'));
  const r = upsertBlock(path.join(repo, 'CLAUDE.md'), 'RULES', { root: repo, agent: 'claude' });
  assert.equal(r.action, 'skipped'); assert.match(String(r.detail), /outside/);
  assert.equal(removeBlock(path.join(repo, 'CLAUDE.md'), 'claude', repo).action, 'skipped');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'export MINE=1\n', 'the link target is untouched');
  // A symlinked directory (.cursor -> elsewhere) is refused the same way; the json writer too.
  fs.symlinkSync(outside, path.join(repo, '.gemini'));
  const { upsertJsonKey } = require('./mcpconfig') as typeof import('./mcpconfig');
  assert.equal(upsertJsonKey(path.join(repo, '.gemini', 'settings.json'), ['mcpServers', 'kora'], { command: 'x' }, 'gemini', repo).action, 'skipped');
  assert.equal(fs.existsSync(path.join(outside, 'settings.json')), false);
  // CLAUDE.md -> AGENTS.md inside the repo still works (a common layout).
  fs.unlinkSync(path.join(repo, 'CLAUDE.md'));
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# mine\n');
  fs.symlinkSync('AGENTS.md', path.join(repo, 'CLAUDE.md'));
  assert.equal(upsertBlock(path.join(repo, 'CLAUDE.md'), 'RULES', { root: repo, agent: 'claude' }).action, 'installed');
  assert.ok(hasBlock(path.join(repo, 'AGENTS.md')));
  fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
});
