import test from 'node:test';
import assert from 'node:assert/strict';
import { run, usage } from './agent';

// D29 (Koragent E2E): `kora agent spawn koragent --help` spawned a real pane in the cwd and the agent wrote AGENTS.md.
test('kora agent spawn <agent> --help prints the usage and never reaches the daemon', async () => {
  const prev = process.env.KORA_SOCKET_PATH;
  process.env.KORA_SOCKET_PATH = '/nonexistent/kora-d29.sock'; // a spawn attempt would fail to connect and throw
  try {
    for (const argv of [['spawn', 'koragent', '--help'], ['spawn', 'koragent', '-h'], ['--help']]) {
      let out = '';
      const code = await run(argv, { out: (s) => { out += s; }, err: () => {} });
      assert.equal(code, 0, argv.join(' '));
      assert.equal(out, usage + '\n');
    }
  } finally { if (prev === undefined) delete process.env.KORA_SOCKET_PATH; else process.env.KORA_SOCKET_PATH = prev; }
});
