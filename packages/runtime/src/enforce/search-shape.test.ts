import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashSearchPattern, identifierOf, shimHits } from './search-shape';

function tree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-shape-'));
  fs.mkdirSync(path.join(dir, 'src', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x\n');
  return dir;
}

test('bashSearchPattern: one recursive rg/grep over directories yields its pattern', () => {
  const cwd = tree();
  const yes: [string, string][] = [
    ['rg -n createWorktree', 'createWorktree'],
    ['rg -n "createWorktree" src', 'createWorktree'],
    ["rg -n -g '*.ts' -A3 parse_transcript src/pkg", 'parse_transcript'],
    ['cd src && rg -n createWorktree . | head -20', 'createWorktree'],
    ['grep -rn "config.grepCap" .', 'config.grepCap'],
    ['grep -R --include "*.ts" createWorktree src', 'createWorktree'],
    ['/usr/bin/grep -rn createWorktree src | wc -l', 'createWorktree'],
    ['rg -e createWorktree src', 'createWorktree'],
    ['rg --type ts -- createWorktree', 'createWorktree'],
    ['rg -n "\\bcreateWorktree\\b" src src/pkg', '\\bcreateWorktree\\b'],
    ['grep -r "createWorktree" . --include="*.ts" | grep -v node_modules', 'createWorktree'], // seen live: Haiku's first search
  ];
  for (const [cmd, want] of yes) assert.equal(bashSearchPattern(cmd, cwd), want, cmd);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('bashSearchPattern: compound commands, named files, plain grep, pattern files and odd shells are not one search', () => {
  const cwd = tree();
  for (const cmd of [
    'rg -n createWorktree src; sed -n 1,20p src/a.ts',       // the deny would cost the sed too
    'rg -n createWorktree src && echo done',
    'rg -n createWorktree src | xargs sed -n 1p',
    'rg -n createWorktree src/a.ts',                          // a file the agent already located
    'grep -n createWorktree src/a.ts',
    'grep createWorktree',                                    // not recursive: reads stdin
    'rg -e foo -e createWorktree src',                        // two patterns
    'rg -f patterns.txt src',
    'rg -n "$(echo createWorktree)" src',
    'rg -n createWorktree src > out.txt',
    "rg -n 'createWorktree src",                              // unbalanced quote
    'sed -n 1,40p src/a.ts',
    'cat src/a.ts',
    'git grep createWorktree',
    '',
  ]) assert.equal(bashSearchPattern(cmd, cwd), null, cmd);
  assert.equal(bashSearchPattern(undefined, cwd), null);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a Bash search is classified like a Grep pattern: identifiers yes, text no', () => {
  const cwd = tree();
  const id = (cmd: string) => identifierOf(bashSearchPattern(cmd, cwd));
  assert.equal(id('rg -n createWorktree src'), 'createWorktree');
  assert.equal(id('rg -n "function\\s+createWorktree" src'), 'createWorktree');
  for (const cmd of ['rg -n "retry|backoff" src', 'rg -n database src', 'rg -n "error: failed" .', 'rg -n my-config-key .', 'grep -rn TODO .']) assert.equal(id(cmd), null, cmd);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('shimHits keeps only entries that declare the identifier', () => {
  const text = [
    '5 match(es) for "CLAUDE_CONFIG_DIR" across 2 file(s)',
    '  packages/runtime/src/session/claude-accounts.ts: METHOD write:52, DOC shellQuote — quoted for a shell.:23',
    '  packages/runtime/src/session/env.ts: CONSTANT CLAUDE_CONFIG_DIR:12, METHOD other:40',
  ].join('\n');
  assert.equal(shimHits(text, 'CLAUDE_CONFIG_DIR'), '1 file(s) declare CLAUDE_CONFIG_DIR:\n  packages/runtime/src/session/env.ts: CONSTANT CLAUDE_CONFIG_DIR:12');
  assert.equal(shimHits('2 match(es)\n  a.ts: FIELD state:18\n  b.ts: METHOD blobPreToolUseHooks:81', 'PreToolUse'), null, 'a longer name containing it is not a declaration of it');
  assert.equal(shimHits('1 match(es)\n  a.ts: METHOD grepCap:3', 'config.grepCap'), '1 file(s) declare config.grepCap:\n  a.ts: METHOD grepCap:3', 'dotted: the member is the declaration');
  assert.equal(shimHits('', 'createWorktree'), null);
});
