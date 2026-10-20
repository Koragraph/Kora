import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirtySourceFilesSince } from './service';

test('dirtySourceFilesSince: uncommitted source edits newer than the last ingest count; docs, old edits and clean trees do not', async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-dirty-')));
  const git = (...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
  git('init', '-q'); fs.writeFileSync(path.join(d, 'a.js'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'init');
  assert.equal(await dirtySourceFilesSince(d, Date.now() - 60_000), 0, 'clean tree');
  const ingestedAt = Date.now();
  await new Promise((r) => setTimeout(r, 800));
  fs.appendFileSync(path.join(d, 'a.js'), 'export function newThing() {}\n');
  fs.writeFileSync(path.join(d, 'notes.md'), '# docs\n');
  fs.writeFileSync(path.join(d, 'b.ts'), 'export const b = 2;\n');
  assert.equal(await dirtySourceFilesSince(d, ingestedAt), 2, 'a.js (modified) + b.ts (untracked); notes.md is not source');
  assert.equal(await dirtySourceFilesSince(d, Date.now() + 5000), 0, 'an ingest started after the edits covers them');
});
