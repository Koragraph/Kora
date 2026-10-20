// Deep audit 2026-10-13 A2-3: "never index on open" — only the user starts a first index. An agent's `kora ingest`
// of a repository nobody indexed is refused; a re-index of one the user indexed is not; the user's own CLI always runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { agentFirstIndexRefusal } from './index-consent';

const BIN = path.resolve(__dirname, '..', '..', 'bin', 'kora.js');
function mkrepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), `${name}-`));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export function consentProbe() { return 1; }\n');
  execFileSync('git', ['init', '-q'], { cwd: dir }); execFileSync('git', ['add', '-A'], { cwd: dir }); execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}
const kora = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--liftoff-only', BIN, ...args], { env, encoding: 'utf8' });
const agentEnv = (): NodeJS.ProcessEnv => ({ ...process.env, KORA_AGENT: 'claude' });
const userEnv = (): NodeJS.ProcessEnv => { const e = { ...process.env }; delete e.KORA_AGENT; return e; };

test('agentFirstIndexRefusal: only an agent, and only for a repo with no index of any kind', async () => {
  const st = (s: object) => ({ status: async () => ({ indexed: false, ...s }) });
  assert.match(String(await agentFirstIndexRefusal(st({}), '/r', { KORA_AGENT: 'codex' })), /only the user starts a first index/);
  assert.equal(await agentFirstIndexRefusal(st({}), '/r', {}), null, 'the user');
  assert.equal(await agentFirstIndexRefusal(st({}), '/r', { KORA_AGENT: 'shell' }), null, 'a plain terminal pane is the user');
  for (const s of [{ indexed: true }, { incomplete: true }, { firstIndexRunning: true }, { staleForCheckout: true }, { nodes: 12 }]) {
    assert.equal(await agentFirstIndexRefusal(st(s), '/r', { KORA_AGENT: 'claude' }), null, JSON.stringify(s));
  }
});

test('kora ingest / kora graph ingest from an agent refuse a first index; the user indexes, then the agent may re-index', () => {
  const repo = mkrepo('consent');
  for (const args of [['ingest', repo], ['graph', 'ingest', repo], ['ingest', repo, '--force'], ['ingest', repo, '--no-wait']]) {
    const r = kora(args, agentEnv());
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`); assert.match(r.stderr, /only the user starts a first index/);
  }
  const u = kora(['ingest', repo], userEnv());
  assert.equal(u.status, 0, u.stderr);
  fs.appendFileSync(path.join(repo, 'a.ts'), 'export function later() { return 2; }\n');
  execFileSync('git', ['commit', '-qam', 'more'], { cwd: repo });
  const again = kora(['ingest', repo], agentEnv());
  assert.equal(again.status, 0, again.stderr);
});
