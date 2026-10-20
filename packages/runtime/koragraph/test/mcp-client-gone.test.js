'use strict';
// An MCP client that disconnects must end the stdio server quietly (common-services/pipe-guard.js). Before the fix,
// the EPIPE from writing a tool's answer to the closed stdout was logged to the equally dead stderr, which failed
// again and was logged again: ~70 MB/s into the file logs, and the process never exited (3.6 GB in five minutes).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isPipeGone, makeLimitedReporter } = require('../src/common-services/pipe-guard');

const START = path.resolve(__dirname, '..', 'src', 'mcp', 'start.js');
const dirBytes = (d) => fs.readdirSync(d).reduce((n, f) => n + fs.statSync(path.join(d, f)).size, 0);

function server(logDir) {
  const child = spawn(process.execPath, [START], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, KORAGRAPH_LOG_DIR: logDir, KORAGRAPH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kg-gone-home-')) },
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? signal)));
  return { child, exited };
}
const call = (child, id) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_code', arguments: { query: 'x' } } }) + '\n');
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('still running'), ms))]);

test('client gone (stdout and stderr closed, stdin still open): exits 0 and does not flood the logs', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-gone-logs-'));
  const { child, exited } = server(logDir);
  await new Promise((r) => setTimeout(r, 1200));
  child.stdout.destroy();
  child.stderr.destroy();
  for (let i = 1; i <= 3; i++) call(child, i);
  const code = await within(exited, 8000);
  if (code === 'still running') child.kill('SIGKILL');
  assert.equal(code, 0);
  assert.ok(dirBytes(logDir) < 64 * 1024, `${dirBytes(logDir)} bytes of logs`);
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('client stops reading stdout only: exits 0', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-gone-logs-'));
  const { child, exited } = server(logDir);
  await new Promise((r) => setTimeout(r, 1200));
  child.stdout.destroy();
  call(child, 1);
  const code = await within(exited, 8000);
  if (code === 'still running') child.kill('SIGKILL');
  assert.equal(code, 0);
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('pipe-guard: isPipeGone and the rate-limited reporter', () => {
  assert.equal(isPipeGone(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true);
  assert.equal(isPipeGone(new Error('boom')), false);
  assert.equal(isPipeGone(null), false);
  let t = 0;
  const lines = [];
  const report = makeLimitedReporter((label, err) => lines.push(`${label} ${err?.message ?? ''}`.trim()), { perWindow: 2, windowMs: 1000, now: () => t });
  for (let i = 0; i < 50; i++) report('x:', new Error('same'));
  report('x:', new Error('other'));
  assert.deepEqual(lines, ['x: same', 'x: same', 'x: other']);
  t = 1500;
  report('x:', new Error('same'));
  assert.deepEqual(lines.slice(3), ['x: 48 repeat(s) suppressed in the last 1 s', 'x: same']);
});
