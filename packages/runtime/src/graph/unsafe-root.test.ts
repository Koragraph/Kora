// Every ingest path refuses the fs root, the home dir, a parent of it and a too-shallow path unless forced. Measured
// 2026-10-02: `kora ingest / --no-wait` started a detached walk of the whole disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { unsafeIndexRoot } from './embedded';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX paths; the Windows rules have their own test' : false };

test('unsafeIndexRoot: root, home, parents of home and shallow paths are refused; a project is not', posixOnly, () => {
  const home = '/Users/someone';
  assert.equal(unsafeIndexRoot('/', home), 'filesystem root');
  assert.equal(unsafeIndexRoot(home, home), 'home folder');
  assert.equal(unsafeIndexRoot(home + '/', home), 'home folder');
  assert.equal(unsafeIndexRoot('/Users', home), 'parent of the home folder');
  assert.equal(unsafeIndexRoot('/tmp', home), 'too shallow');
  assert.equal(unsafeIndexRoot('/Users/someone/Projects/app', home), null);
  assert.equal(unsafeIndexRoot('/Users/someone-else', home), null, 'a sibling that merely shares the prefix is not a parent');
});

test('graph.ingest refuses the home dir (wait and no-wait) unless forced', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const g = createGraphService();
  await assert.rejects(() => g.ingest(os.homedir(), { wait: false }), (e: any) => e.code === 'unsafe_root' && /home folder/.test(e.message));
  await assert.rejects(() => g.ingest(path.parse(process.cwd()).root, { wait: true }), (e: any) => e.code === 'unsafe_root');
  const r = await g.ingestWithProgress!(os.homedir(), () => {});
  assert.equal(r.ok, false); assert.match(String(r.error), /home folder/);
});

// B2 (night 2026-10-04): a project at /System/Library was offered "Index anyway" — a walk of a huge system tree.
test('unsafeIndexRoot: macOS system and app-data trees are refused; external volumes and temp folders are not', posixOnly, () => {
  const home = '/Users/someone';
  for (const p of ['/System/Library', '/Library/Developer/CommandLineTools', '/usr/local/lib', '/Applications/Xcode.app', '/opt/homebrew/Cellar', '/private/etc/ssh', `${home}/Library/Mobile Documents`, `${home}/.Trash/old-app`])
    assert.equal(unsafeIndexRoot(p, home), 'system folder', p);
  for (const p of ['/Volumes/External/app', '/private/var/folders/x/T/kora-qa/repo', `${home}/Projects/Library`, `${home}/LibraryApp`, '/opt/projects/app'])
    assert.equal(unsafeIndexRoot(p, home), null, p);
});

// pl3 S2-2: `kora ingest /private/tmp` (macOS's real /tmp) walked every scratch folder; the temp and mount ROOTS are
// refused (as given and by realpath), a project below them is not.
test('unsafeIndexRoot: temp and volume roots are refused, projects under them are not', posixOnly, () => {
  const home = '/Users/someone';
  for (const p of ['/private/tmp', '/private/var', '/var/tmp', '/private/var/folders', '/private/var/folders/x1/abc123/T', '/var/folders/x1/abc123', '/Volumes/External', os.tmpdir()])
    assert.ok(unsafeIndexRoot(p, home) !== null, p);
  assert.equal(unsafeIndexRoot('/private/tmp', home), 'temp or volume root');
  for (const p of ['/private/tmp/app', '/tmp/pl3/repo', '/private/var/folders/x/T/kora-qa/repo', '/Volumes/External/app', path.join(os.tmpdir(), 'proj')])
    assert.equal(unsafeIndexRoot(p, home), null, p);
});

test('unsafeIndexRoot (Windows): drive roots, home, its parents, system and program trees are refused; a project is not', { skip: process.platform !== 'win32' }, () => {
  const home = 'C:\\Users\\someone';
  assert.equal(unsafeIndexRoot('C:\\', home), 'filesystem root');
  assert.equal(unsafeIndexRoot('D:\\', home), 'filesystem root');
  assert.equal(unsafeIndexRoot(home, home), 'home folder');
  assert.equal(unsafeIndexRoot('C:\\Users', home), 'parent of the home folder');
  assert.equal(unsafeIndexRoot('D:\\code', home), 'too shallow');
  for (const p of ['C:\\Windows\\System32', 'c:\\windows\\system32', 'C:\\Program Files\\nodejs', 'C:\\ProgramData\\chocolatey', `${home}\\AppData\\Local\\Programs`])
    assert.equal(unsafeIndexRoot(p, home), 'system folder', p);
  for (const p of [`${home}\\Projects\\app`, 'D:\\code\\app', `${home}\\AppDataTools`]) assert.equal(unsafeIndexRoot(p, home), null, p);
});
