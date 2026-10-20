// S6 2026-10-14: an agent process cannot run the CLI commands that trust folders, rewrite config or delete data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentOnlyRefusal, run } from './main';

const agent = { KORA_AGENT: 'claude' } as NodeJS.ProcessEnv;
const user = {} as NodeJS.ProcessEnv;

test('agentOnlyRefusal: trust, config set, uninstall, takeover, update and swarm key/setup/install/backend are refused for an agent', () => {
  for (const [name, rest] of [
    ['setup', ['--trust']], ['setup', ['/repo', '--trust=true']], ['config', ['set', 'workerPermission', 'full']], ['uninstall', ['--purge', '--yes']], ['uninstall', []],
    ['takeover', []], ['update', []], ['swarm', ['key', 'clear', 'zen']], ['swarm', ['setup']], ['swarm', ['install', '--yes']], ['swarm', ['backend', 'koragent']],
    ['ext', ['add', 'x', '--', 'npx', 'y']], ['ext', ['remove', 'x']], ['ext', ['enable', 'x']], ['ext', ['skill', 'add', '/tmp/s']], ['ext', ['import', '--yes']],
  ] as [string, string[]][]) {
    assert.match(String(agentOnlyRefusal(name, rest, agent)), /only the person at a terminal/, `${name} ${rest.join(' ')}`);
    assert.equal(agentOnlyRefusal(name, rest, user), null, `${name} for the user`);
  }
});

test('agentOnlyRefusal: reads, dry runs and everything an agent legitimately runs stay open', () => {
  for (const [name, rest] of [
    ['setup', []], ['config', ['get']], ['config', ['path']], ['uninstall', ['--dry-run']], ['takeover', ['--dry-run']], ['swarm', ['status']], ['swarm', ['usage']],
    ['graph', ['explore', 'x']], ['agent', ['spawn', 'claude']], ['fleet', ['get']], ['worktree', ['list']], ['merge', ['check']], ['doctor', []], ['version', []],
    ['ext', ['list']], ['ext', ['test', 'x']], ['ext', ['catalog']], ['ext', ['import']], ['ext', ['exec', 'x']],
  ] as [string, string[]][]) assert.equal(agentOnlyRefusal(name, rest, agent), null, `${name} ${rest.join(' ')}`);
  assert.equal(agentOnlyRefusal('hook', ['pre-tool'], { KORA_AGENT: 'shell' } as NodeJS.ProcessEnv), null, 'a plain terminal pane is the user');
});

test('run(): the refusal is exit 2 with the text on stderr, before the command loads', async () => {
  const prev = process.env.KORA_AGENT; process.env.KORA_AGENT = 'codex';
  try {
    let err = ''; const code = await run(['setup', '--trust'], { out: () => {}, err: (s) => { err += s; } });
    assert.equal(code, 2); assert.match(err, /only the person at a terminal/);
  } finally { if (prev === undefined) delete process.env.KORA_AGENT; else process.env.KORA_AGENT = prev; }
});
