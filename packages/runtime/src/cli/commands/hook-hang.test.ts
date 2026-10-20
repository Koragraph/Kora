// A pane hook is a short-lived process Claude waits on: a daemon that ACCEPTS the connection but never answers (a stalled event
// loop) must not keep it alive past its budget (S7: the bounded-Read outline call and the graph-use report lingered ~60 s).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ipcAddress } from '../../util/ipc-path';

test('the Read hook exits within a few seconds when the daemon accepts but never replies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-hh-'));
  const sock = path.join(dir, 'h.sock');
  const server = net.createServer((c) => { c.on('data', () => {}); c.on('error', () => {}); });
  await new Promise<void>((r) => server.listen(ipcAddress(sock), r));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'big.js'), Array.from({ length: 420 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n') + '\n');
  const bin = path.join(__dirname, '..', '..', '..', 'bin', 'kora.js');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'hang-test', cwd: repo, tool_name: 'Read', tool_input: { file_path: path.join(repo, 'big.js') } });
  const t0 = Date.now();
  const child = spawn(process.execPath, [bin, 'hook', 'pre-tool', '--stdin-json', input], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, KORA_HOME: path.join(dir, 'home'), KORA_SOCKET_PATH: sock, KORA_PANE_ID: 'p1', KORA_BOUNDED_READS: 'on', KORA_ASSUME_GRAPH: '1', KORAGRAPH_HOME: path.join(dir, 'kg') },
  });
  let out = ''; child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise<number | null>((resolve) => {
    const kill = setTimeout(() => { child.kill('SIGKILL'); resolve(-1); }, 12_000);
    child.on('exit', (c) => { clearTimeout(kill); resolve(c); });
  });
  const took = Date.now() - t0;
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, `hook did not exit by itself (code ${code})`);
  assert.ok(took < 8000, `hook lingered ${took} ms`);
  assert.ok(out.includes('updatedInput'), 'the Read is still bounded (the outline is optional)');
});
