import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { briefBlockBody, isTrackedInGit } from './types';
import type { AdapterCtx } from './types';

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-brief-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

test('a TRACKED AGENTS.md gets the rulebook only (no volatile brief → no git change per daemon start); an untracked one keeps the brief', () => {
  const dir = repo();
  const ctx = { root: dir, brief: 'kora session brief — STALE: graph at abc, HEAD def' } as unknown as AdapterCtx;
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, '# notes\n');
  assert.equal(isTrackedInGit(file), false);
  assert.match(briefBlockBody(ctx, file), /STALE/);

  const tracked = path.join(dir, 'GEMINI.md');
  fs.writeFileSync(tracked, '# notes\n');
  execFileSync('git', ['-C', dir, 'add', 'GEMINI.md']);
  assert.equal(isTrackedInGit(tracked), true);
  assert.doesNotMatch(briefBlockBody(ctx, tracked), /STALE/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('outside a git repo: not tracked, brief kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-brief-nogit-'));
  const file = path.join(dir, 'AGENTS.md');
  assert.equal(isTrackedInGit(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
