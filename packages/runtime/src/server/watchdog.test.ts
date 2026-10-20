import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mod = path.join(__dirname, 'watchdog.js');

function runChild(body: string, logFile: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> {
  const t0 = Date.now();
  const src = `const { startWatchdog, noteWatchdogLabel } = require(${JSON.stringify(mod)});
    startWatchdog({ stallMs: 2500, tickMs: 200, logFile: ${JSON.stringify(logFile)} });
    ${body}`;
  const c = spawn(process.execPath, ['-e', src], { stdio: 'ignore' });
  return new Promise((resolve) => c.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - t0 })));
}

test('watchdog: a main thread blocked past the limit is logged with the last request and the process is killed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-watchdog-'));
  const logFile = path.join(dir, 'server.log');
  const r = await runChild(`setTimeout(() => { noteWatchdogLabel('HTTP GET /api/graph/status'); for (;;) {} }, 300);`, logFile);
  // Windows has no signals: a killed process exits with code 1 (TerminateProcess) and no signal.
  if (process.platform === 'win32') assert.equal(r.code, 1); else assert.equal(r.signal, 'SIGKILL');
  assert.ok(r.ms < 8000, `killed promptly (${r.ms} ms)`);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /WATCHDOG: the daemon main thread has not run for \d+ ms \(last request: HTTP GET \/api\/graph\/status\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchdog: a busy-but-alive main thread (short stalls) is left alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-watchdog-'));
  const logFile = path.join(dir, 'server.log');
  const r = await runChild(`
    const end = Date.now() + 3000;
    (function tick() { const t = Date.now(); while (Date.now() - t < 300) {} if (Date.now() < end) setTimeout(tick, 50); else process.exit(0); })();`, logFile);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(logFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchdog: KORA_WATCHDOG_MS=0 turns it off', async () => {
  const { watchdogMsFromEnv, startWatchdog } = require('./watchdog');
  assert.equal(watchdogMsFromEnv({ KORA_WATCHDOG_MS: '0' } as any), 0);
  assert.equal(watchdogMsFromEnv({} as any), 60000);
  startWatchdog({ stallMs: 0 })(); // returns a no-op stop, starts nothing
});
