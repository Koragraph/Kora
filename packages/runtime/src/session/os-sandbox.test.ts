import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { osSandboxSupported, resetOsSandboxProbeForTests, sandboxProfile, sandboxedEngineFor, withBrowserGuard, wrapReadDeny } from './os-sandbox';

const posixOnly = { skip: process.platform === 'win32' ? "macOS Seatbelt profiles" : false };

const home = os.homedir();

test('profile: denies credential paths, carves out the engine\'s own login, refuses `open` for agy only', posixOnly, () => {
  const agy = sandboxProfile('antigravity', home, '/x/.kora-dev');
  assert.match(agy, /\(allow default\)/);
  assert.ok(agy.includes(`(subpath "${home}/.ssh")`));
  assert.ok(agy.includes(`(subpath "${home}/.codex/auth.json")`), 'agy may not read Codex\'s login');
  assert.ok(!agy.includes('antigravity-oauth-token"'), 'agy keeps its own login');
  assert.ok(agy.includes('(literal "/x/.kora-dev/ui-token")'));
  assert.match(agy, /deny process-exec \(literal "\/usr\/bin\/open"\)/);
  const codex = sandboxProfile('codex', home, null);
  assert.ok(!codex.includes(`"${home}/.codex/auth.json"`), 'codex keeps its own login');
  assert.ok(codex.includes('antigravity-oauth-token'));
  assert.ok(!/process-exec/.test(codex));
  // A3-4: unattended workers and done-checks cannot open a browser tab by absolute path either.
  for (const e of ['opencode', 'koragent', 'check'] as const) assert.match(sandboxProfile(e, home, null), /deny process-exec \(literal "\/usr\/bin\/open"\)/, e);
});

test('profile: never fences ~/Library/Keychains (a fenced keychain user gets macOS\'s "Reset To Defaults" prompt)', posixOnly, () => {
  for (const e of ['antigravity', 'codex', 'opencode', 'koragent', 'check'] as const) {
    assert.ok(!sandboxProfile(e, home, '/x/.kora-dev').includes('Library/Keychains'), e);
  }
  assert.ok(sandboxProfile('opencode', home, null).includes(`(subpath "${home}/.ssh")`), 'the rest of the fence stays');
});

test('real fence (macOS): a private key file (.p8) anywhere cannot be read, an ordinary file beside it can', { skip: !osSandboxSupported() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-p8-'));
  try {
    fs.writeFileSync(path.join(dir, 'AuthKey_TEST123.p8'), 'secret');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ok');
    const run = (f: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', sandboxProfile('opencode', home, null), '/bin/cat', path.join(dir, f)], { encoding: 'utf8' });
    assert.notEqual(run('AuthKey_TEST123.p8').status, 0);
    assert.equal(run('notes.txt').stdout, 'ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wrapReadDeny: unchanged when unsupported or overridden, wrapped when the fence applies', posixOnly, () => {
  resetOsSandboxProbeForTests(false);
  assert.deepEqual(wrapReadDeny('codex', '/bin/echo', ['hi']), { command: '/bin/echo', args: ['hi'] });
  resetOsSandboxProbeForTests(true);
  const w = wrapReadDeny('codex', '/bin/echo', ['hi']);
  assert.equal(w.command, '/usr/bin/sandbox-exec'); assert.deepEqual(w.args.slice(-2), ['/bin/echo', 'hi']);
  process.env.KORA_ALLOW_SENSITIVE_PATHS = '1';
  try { assert.equal(wrapReadDeny('codex', '/bin/echo', []).command, '/bin/echo'); } finally { delete process.env.KORA_ALLOW_SENSITIVE_PATHS; }
  resetOsSandboxProbeForTests(null);
  assert.equal(sandboxedEngineFor('claude'), 'claude'); assert.equal(sandboxedEngineFor('shell'), null); assert.equal(sandboxedEngineFor('opencode'), 'opencode');
});

test('2026-10-15 #4: Claude\'s profile fences only the control token (no other credential, no `open` refusal)', posixOnly, () => {
  const p = sandboxProfile('claude', '/Users/u', '/k/home');
  assert.match(p, /ui-token/); assert.match(p, /\(literal "\/k\/home\/ui-token"\)/);
  assert.doesNotMatch(p, /\.ssh|claude\.json|Keychains|\/usr\/bin\/open|engines/, p);
});

test('real fence (macOS) 2026-10-15 #4: a fenced Claude cannot read the token by any spelling; its other files stay readable', { skip: !osSandboxSupported() }, async () => {
  resetOsSandboxProbeForTests(null);
  const kh = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ct-'));
  const saved = process.env.KORA_HOME; process.env.KORA_HOME = kh;
  try {
    fs.writeFileSync(path.join(kh, 'ui-token'), 'TOKEN-CANARY'); fs.writeFileSync(path.join(kh, 'other.txt'), 'fine');
    const sh = (line: string) => { const w = wrapReadDeny('claude', '/bin/sh', ['-c', line]); return spawnSync(w.command, w.args, { encoding: 'utf8' }); };
    for (const line of [`cat ${kh}/ui-token`, `cat ${kh}/ui-tok?n`, `d=${kh}; cat $d/ui-token`, `cd ${kh} && cat ./ui-*`]) {
      const r = sh(line); assert.ok(!r.stdout.includes('TOKEN-CANARY'), line);
    }
    assert.equal(sh(`cat ${kh}/other.txt`).stdout, 'fine');
    // The SDK lane's spawner: the same fence around the CLI it is handed.
    const { fencedClaudeSpawn } = await import('./os-sandbox');
    const spawnFn = fencedClaudeSpawn(); assert.ok(spawnFn);
    const child = spawnFn!({ command: '/bin/cat', args: [path.join(kh, 'ui-token')], env: { ...process.env } });
    let out = ''; child.stdout!.on('data', (d) => { out += d; }); child.stdin!.end();
    const code = await new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    assert.notEqual(code, 0); assert.ok(!out.includes('TOKEN-CANARY'));
  } finally { if (saved === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = saved; fs.rmSync(kh, { recursive: true, force: true }); }
});

test('real fence (macOS): a canary under ~/.ssh cannot be read, a link to it cannot, an ordinary file can', { skip: !osSandboxSupported() }, () => {
  resetOsSandboxProbeForTests(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-sb-'));
  const canary = path.join(home, '.ssh', `kora-sb-canary-${process.pid}`);
  fs.mkdirSync(path.dirname(canary), { recursive: true }); fs.writeFileSync(canary, 'CANARY-VALUE');
  try {
    fs.symlinkSync(canary, path.join(dir, 'link.txt')); fs.writeFileSync(path.join(dir, 'ok.txt'), 'fine');
    const run = (engine: any, file: string) => { const w = wrapReadDeny(engine, '/bin/cat', [file]); return spawnSync(w.command, w.args, { encoding: 'utf8' }); };
    for (const engine of ['antigravity', 'codex', 'opencode'] as const) {
      const direct = run(engine, canary); assert.notEqual(direct.status, 0, `${engine} direct`); assert.ok(!direct.stdout.includes('CANARY'));
      const viaLink = run(engine, path.join(dir, 'link.txt')); assert.notEqual(viaLink.status, 0, `${engine} link`); assert.ok(!viaLink.stdout.includes('CANARY'));
      assert.equal(run(engine, path.join(dir, 'ok.txt')).stdout, 'fine');
    }
  } finally { fs.rmSync(canary, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('browser guard: `open` resolves to a refusing stand-in first on PATH, the rest of PATH stays', posixOnly, () => {
  const kh = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-bg-')); const prev = process.env.KORA_HOME; process.env.KORA_HOME = kh;
  try {
    const env = withBrowserGuard<Record<string, string | undefined>>({ PATH: '/usr/bin:/bin:/opt/tools', HOME: home });
    assert.equal(env.PATH!.split(path.delimiter)[0], path.join(kh, 'agy-guard'));
    assert.ok(env.PATH!.includes('/opt/tools')); assert.equal(env.BROWSER, '/usr/bin/true');
    const r = spawnSync('sh', ['-c', 'open https://accounts.google.com/o/oauth2/auth'], { env: env as any, encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /blocked/);
  } finally { if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev; fs.rmSync(kh, { recursive: true, force: true }); }
});

test('control files are write-denied but readable and other Kora-home files stay writable (deep A1 D2)', { skip: !osSandboxSupported() }, () => {
  resetOsSandboxProbeForTests(null);
  const kh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ctl-')));
  fs.mkdirSync(path.join(kh, 'chat', 't1'), { recursive: true }); fs.mkdirSync(path.join(kh, 'mcp'), { recursive: true });
  for (const f of ['config.json', 'engines.json', 'chat/t1/meta.json', 'mcp/a.json']) fs.writeFileSync(path.join(kh, f), '{}');
  fs.mkdirSync(path.join(kh, 'opencode', 'plugins'), { recursive: true }); fs.mkdirSync(path.join(kh, 'shell', 'zsh'), { recursive: true }); fs.mkdirSync(path.join(kh, 'swarm', 'reports'), { recursive: true }); fs.mkdirSync(path.join(kh, 'workers'), { recursive: true });
  const prev = process.env.KORA_HOME; process.env.KORA_HOME = kh;
  try {
    const sh = (engine: any, cmd: string) => { const w = wrapReadDeny(engine, '/bin/sh', ['-c', cmd]); return spawnSync(w.command, w.args, { encoding: 'utf8' }); };
    for (const engine of ['opencode', 'codex', 'check'] as const) {
      for (const f of ['config.json', 'engines.json', 'settings.json', 'chat/t1/meta.json', 'mcp/a.json', 'mcp/new.json', 'shims/x']) {
        const r = sh(engine, `echo X > '${path.join(kh, f)}'`); assert.notEqual(r.status, 0, `${engine} wrote ${f}`);
      }
      // S6 2026-10-14: what the daemon, a Kora terminal or the next worker executes or trusts is write-denied too.
      for (const f of ['trust.json', 'claude-accounts.json', 'savings.json', 'prune-forks.json', 'blob-defaults.json', 'shell/zsh/.zshenv', 'tools/opencode/current/opencode', 'agy-guard/open', 'opencode/plugins/kora-state.js', 'workers/w_1.json', 'swarm/tasks.json']) {
        const r = sh(engine, `echo X > '${path.join(kh, f)}'`); assert.notEqual(r.status, 0, `${engine} wrote ${f}`);
      }
      assert.equal(sh(engine, `echo ok > '${path.join(kh, 'opencode', 'package.json')}'`).status, 0, 'opencode keeps its own deps folder writable');
      assert.equal(sh(engine, `echo ok > '${path.join(kh, 'swarm', 'reports', 'r.md')}'`).status, 0, 'a worker still writes its report');
      assert.equal(sh(engine, `cat '${path.join(kh, 'config.json')}'`).stdout, '{}', 'reads stay allowed');
      assert.equal(sh(engine, `echo ok > '${path.join(kh, 'chat', 't1', 'notes.txt')}'`).status, 0, 'other files stay writable');
    }
  } finally { if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev; fs.rmSync(kh, { recursive: true, force: true }); }
});

test('ACP engines run under the read-deny with their own login carved out (deep A1 D6)', { skip: !osSandboxSupported() }, async () => {
  const { acpFence } = await import('./os-sandbox');
  const { defaultAcpSpawn } = await import('./drivers/acp-driver');
  assert.deepEqual(acpFence('gemini', '/usr/bin/gemini'), { engine: 'gemini', extraOwn: [] });
  assert.deepEqual(acpFence('acp-mine', '/opt/bin/claude-code-acp').extraOwn, ['.claude.json', '.claude/.credentials.json']);
  assert.deepEqual(acpFence('kimi', '/opt/bin/kimi'), { engine: 'acp', extraOwn: [] });
  const prof = sandboxProfile('acp', home, null, ['.claude.json']);
  assert.ok(prof.includes(`(subpath "${home}/.ssh")`) && !prof.includes(`"${home}/.claude.json"`) && prof.includes(`"${home}/.codex/auth.json"`));
  resetOsSandboxProbeForTests(null);
  const canary = path.join(home, '.ssh', `kora-acp-canary-${process.pid}`);
  fs.mkdirSync(path.dirname(canary), { recursive: true }); fs.writeFileSync(canary, 'ACP-CANARY');
  try {
    const out = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const c: any = defaultAcpSpawn({ command: '/bin/cat', args: [canary], env: process.env, cwd: os.tmpdir(), engineId: 'kimi' });
      let buf = ''; c.stdout.on('data', (d: Buffer) => { buf += d; }); c.on('close', (code: number | null) => resolve({ code, out: buf }));
    });
    assert.notEqual(out.code, 0); assert.ok(!out.out.includes('ACP-CANARY'), 'an ACP agent cannot read ~/.ssh');
  } finally { fs.rmSync(canary, { force: true }); }
});
