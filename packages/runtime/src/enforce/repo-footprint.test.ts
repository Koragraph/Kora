// "Remove project" takes Kora's managed entries out of the repo and its folder trust; the ledger keeps the repo findable
// by `kora uninstall` even after the project record is gone (aud1 S2-2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createEnforcer } from './index';
import { touchedRepos, removeRepoFootprint } from './repo-footprint';
import { trustFolder, trustStatus } from '../trust/store';
import { knownRepos, uninstallPaths } from '../cli/commands/uninstall';

test('prepare records the repo; removeRepoFootprint cleans Kora entries, keeps the user\'s, revokes trust, forgets the repo', async () => {
  const home = os.homedir();
  assert.notEqual(home, process.env.KORA_TEST_REAL_HOME, 'never run this against the real home');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, 'fp-')));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# mine\n\nkeep this line\n');
  trustFolder(repo, 'user');
  await createEnforcer().prepare({ agent: 'claude', cwd: repo, paneId: 'chat:t', socketPath: '/tmp/none.sock', binPath: path.resolve(__dirname, '..', '..', 'bin', 'kora.js'), command: 'claude', args: [], env: { PATH: process.env.PATH || '' } });
  assert.match(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), /THIS REPOSITORY HAS A CODE GRAPH|kora/i, 'block written');
  assert.ok(touchedRepos().includes(repo), 'ledger has the repo');
  // The project record is gone, but uninstall still finds the repo through the ledger.
  assert.ok(knownRepos(uninstallPaths(), () => []).includes(repo), 'uninstall --dry-run lists it');

  const r = await removeRepoFootprint(repo);
  assert.ok(r.removed.length > 0, 'something removed');
  assert.equal(r.trustRevoked, true);
  assert.equal(trustStatus(repo).trusted, false);
  const md = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
  assert.match(md, /keep this line/);
  assert.doesNotMatch(md, /THIS REPOSITORY HAS A CODE GRAPH/);
  const settings = path.join(repo, '.claude', 'settings.local.json');
  assert.ok(!fs.existsSync(settings) || !/kora/i.test(fs.readFileSync(settings, 'utf8')), 'hooks gone');
  assert.ok(!touchedRepos().includes(repo), 'ledger forgets it');
});
