// Security sweep 2026-10-04: `chat.diff` ran `git diff --no-index /dev/null <untracked path>` with the path straight
// from `git ls-files`, so an untracked file named `--output=<f>` was parsed as an OPTION — git opened and truncated <f>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeWorkingDiff } from './daemon';

test('an untracked file named like a git option is diffed as a file, never parsed as an option', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-diff-')));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'victim.txt'), 'keep me\n');
    execFileSync('git', ['add', 'victim.txt'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '--output=victim.txt'), 'evil\n');
    const r = await computeWorkingDiff(dir) as { files: Array<{ path: string; additions: number }> };
    assert.equal(fs.readFileSync(path.join(dir, 'victim.txt'), 'utf8'), 'keep me\n');
    const f = r.files.find((x) => x.path === '--output=victim.txt');
    assert.ok(f, `untracked file listed: ${JSON.stringify(r.files.map((x) => x.path))}`);
    assert.equal(f!.additions, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
