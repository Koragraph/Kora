// "Log in to Claude": the daemon runs `claude auth login` for the app (no CLI install needed — the bundled copy works).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { makeClaudeLogin, loginUrlFrom, loginFailureFrom } from './claude-login';

const SAMPLE = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ";

function fakeChild() {
  const c = new EventEmitter() as any;
  c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
  c.written = '';
  c.stdin.on('data', (b: Buffer) => { c.written += b.toString(); });
  c.killed = false;
  c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null, 'SIGTERM')); return true; };
  return c;
}

test('the sign-in URL and a failure line are read from the CLI output', () => {
  assert.equal(loginUrlFrom(SAMPLE), 'https://claude.com/cai/oauth/authorize?code=true&state=abc');
  assert.equal(loginUrlFrom('nothing yet'), null);
  assert.equal(loginFailureFrom(`${SAMPLE}\n\x1b[31mOAuth error: invalid code\x1b[0m\n`, 1), 'OAuth error: invalid code.');
  assert.match(loginFailureFrom('Login failed: Request failed with status code 400\n', 1), /code was not accepted/);
  assert.match(loginFailureFrom(SAMPLE, 1), /exit 1/);
});

test('start runs `<bin> auth login`, exposes the URL, forwards a pasted code, and settles done on exit 0', async () => {
  const child = fakeChild();
  const spawned: string[][] = [];
  const login = makeClaudeLogin({
    resolveBinary: async () => ({ bin: '/App/claude', via: 'bundled' }),
    spawn: ((bin: string, args: string[]) => { spawned.push([bin, ...args]); setImmediate(() => child.stdout.write(SAMPLE)); return child; }) as any,
  });
  const s = await login.start();
  assert.deepEqual(spawned, [['/App/claude', 'auth', 'login']]);
  assert.equal(s.phase, 'waiting');
  assert.equal(s.via, 'bundled');
  assert.match(s.url ?? '', /^https:\/\/claude\.com\/cai\/oauth/);
  // A second start while waiting reuses the running login.
  assert.equal((await login.start()).phase, 'waiting');
  assert.equal(spawned.length, 1);
  login.submitCode('  abc#123  ');
  login.submitCode('evil\nsecond line'); // never forwards a multi-line value
  await new Promise((r) => setImmediate(r));
  assert.equal(child.written, 'abc#123\n');
  child.emit('exit', 0, null);
  assert.equal(login.status().phase, 'done');
});

test('a non-zero exit is a failure with the CLI\'s reason; cancel kills only its own child', async () => {
  const a = fakeChild();
  const login = makeClaudeLogin({ resolveBinary: async () => ({ bin: 'claude', via: 'cli' }), spawn: (() => { setImmediate(() => a.stdout.write(SAMPLE)); return a; }) as any });
  await login.start();
  a.stderr.write('Login failed: Request failed with status code 400\n');
  await new Promise((r) => setImmediate(r));
  a.emit('exit', 1, null);
  assert.equal(login.status().phase, 'failed');
  assert.match(login.status().message ?? '', /code was not accepted/);

  const b = fakeChild();
  const login2 = makeClaudeLogin({ resolveBinary: async () => ({ bin: 'claude', via: 'cli' }), spawn: (() => { setImmediate(() => b.stdout.write(SAMPLE)); return b; }) as any });
  await login2.start();
  login2.cancel();
  assert.equal(b.killed, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(login2.status().phase, 'cancelled');
});

test('no binary at all: a failure that says what to do', async () => {
  const login = makeClaudeLogin({ resolveBinary: async () => null });
  const s = await login.start();
  assert.equal(s.phase, 'failed');
  assert.match(s.message ?? '', /Reinstall Kora, or install Claude Code/);
});

test('a login left open past the deadline is killed and reported', async () => {
  const c = fakeChild();
  const login = makeClaudeLogin({ resolveBinary: async () => ({ bin: 'claude', via: 'cli' }), spawn: (() => { setImmediate(() => c.stdout.write(SAMPLE)); return c; }) as any, timeoutMs: 30 });
  await login.start();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.killed, true);
  assert.equal(login.status().phase, 'failed');
  assert.match(login.status().message ?? '', /10 minutes/);
});
