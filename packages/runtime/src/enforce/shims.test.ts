import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderShim, renderAgentShim, CAP_NOTE, SHIM_TOOLS, SHIM_AGENTS, RULEBOOK_FILE } from './shims';

// The sh shims run under /bin/sh; on Windows they are off (enforcer.ts) until ported (docs/windows/PORT.md).
const posixOnly = { skip: process.platform === 'win32' ? 'sh shims are off on Windows' : false };

// A shims dir with a rendered launcher shim and a fake agent binary on PATH that prints its argv one per line.
function agentSandbox(agent: string, opts: Parameters<typeof renderAgentShim>[1]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ashim-'));
  const shims = path.join(dir, 'shims'), real = path.join(dir, 'real');
  fs.mkdirSync(shims); fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, agent), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n', { mode: 0o755 });
  fs.writeFileSync(path.join(shims, RULEBOOK_FILE), 'RULEBOOK `explore` "x"\n');
  const none = path.join(dir, 'none.json'), mcp = path.join(dir, 'claude.json');
  fs.writeFileSync(none, '{"mcpServers":{}}\n'); fs.writeFileSync(mcp, '{"mcpServers":{"kora":{}}}\n');
  fs.writeFileSync(path.join(shims, agent), renderAgentShim(agent, { noneJson: none, mcpJson: mcp, ...opts }), { mode: 0o755 });
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('sh', [path.join(shims, agent), ...args], { cwd: dir, encoding: 'utf8', env: { PATH: `${shims}:${real}:/usr/bin:/bin`, ...env } });
    return { argv: r.stdout.split('\n').filter(Boolean), status: r.status, stderr: r.stderr };
  };
  return { dir, none, mcp, run };
}

test('claude shim: inside a pane a plain launch gets strict MCP + the rulebook; a subcommand and a launch outside a pane are untouched', posixOnly, () => {
  const { dir, none, run } = agentSandbox('claude', { strictMcp: true, mcpEnabled: false });
  const a = run(['-p', 'hi'], { KORA_ENV: '1' });
  assert.deepEqual(a.argv, ['-p', 'hi', '--strict-mcp-config', '--mcp-config', none, '--append-system-prompt', 'RULEBOOK `explore` "x"']);
  assert.deepEqual(run([], { KORA_ENV: '1' }).argv, ['--strict-mcp-config', '--mcp-config', none, '--append-system-prompt', 'RULEBOOK `explore` "x"'], 'no-argument launch');
  assert.deepEqual(run(['mcp', 'list'], { KORA_ENV: '1' }).argv, ['mcp', 'list'], 'subcommand passes through');
  assert.deepEqual(run(['-p', 'hi']).argv, ['-p', 'hi'], 'outside a pane: transparent exec');
  assert.deepEqual(run(['-p', 'hi'], { KORA_ENV: '1', KORA_SHIMS: '0' }).argv, ['-p', 'hi'], 'KORA_SHIMS=0 disables');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('claude shim: an existing --mcp-config / --strict-mcp-config / --append-system-prompt suppresses the matching addition; MCP opt-in uses claude.json', posixOnly, () => {
  const { dir, none, mcp, run } = agentSandbox('claude', { strictMcp: true, mcpEnabled: false });
  const a = run(['--mcp-config', 'x'], { KORA_ENV: '1' });
  assert.deepEqual(a.argv.slice(0, 2), ['--mcp-config', 'x']); assert.ok(!a.argv.includes('--strict-mcp-config') && !a.argv.includes(none), 'the strict pair is suppressed');
  assert.ok(a.argv.includes('--append-system-prompt'), 'the rulebook is still added');
  const b = run(['--strict-mcp-config', '--mcp-config=y', '--append-system-prompt', 'mine'], { KORA_ENV: '1' });
  assert.deepEqual(b.argv, ['--strict-mcp-config', '--mcp-config=y', '--append-system-prompt', 'mine'], 'everything present: nothing added (the pane the server spawns goes through unchanged)');
  assert.ok(!run(['--system-prompt', 'mine'], { KORA_ENV: '1' }).argv.includes('--append-system-prompt'), '--system-prompt also suppresses the rulebook');
  const { dir: d2, none: none2, mcp: mcp2, run: run2 } = agentSandbox('claude', { strictMcp: true, mcpEnabled: true });
  assert.deepEqual(run2(['-p', 'hi'], { KORA_ENV: '1' }).argv.slice(0, 5), ['-p', 'hi', '--mcp-config', mcp2, '--strict-mcp-config'], 'KORA_MCP=1: claude.json, strict, no none.json');
  assert.ok(!run2([], { KORA_ENV: '1' }).argv.includes(none2));
  const { dir: d3, run: run3 } = agentSandbox('claude', { strictMcp: false, mcpEnabled: false });
  assert.deepEqual(run3(['-p', 'hi'], { KORA_ENV: '1' }).argv.slice(0, 3), ['-p', 'hi', '--append-system-prompt'], 'strictMcp false: only the rulebook');
  void mcp;
  for (const d of [dir, d2, d3]) fs.rmSync(d, { recursive: true, force: true });
});

test('codex shim: -c mcp_servers.kora.* overrides added once when MCP is on for codex; subcommands and existing overrides untouched', posixOnly, () => {
  const ov = ['-c', 'mcp_servers.kora.command="/opt/node"', '-c', 'mcp_servers.kora.args=["/x/kora.js","mcp"]'];
  const { dir, run } = agentSandbox('codex', { mcpEnabled: true, codexOverrides: ov });
  assert.deepEqual(run([], { KORA_ENV: '1' }).argv, ov);
  assert.deepEqual(run(['-m', 'o3'], { KORA_ENV: '1' }).argv, ['-m', 'o3', ...ov]);
  assert.deepEqual(run(['-c', 'mcp_servers.kora.command="me"'], { KORA_ENV: '1' }).argv, ['-c', 'mcp_servers.kora.command="me"'], 'already configured by hand');
  assert.deepEqual(run(['login'], { KORA_ENV: '1' }).argv, ['login']);
  assert.deepEqual(run(['-m', 'o3']).argv, ['-m', 'o3'], 'outside a pane');
  const { dir: d2, run: run2 } = agentSandbox('codex', { mcpEnabled: false, codexOverrides: ov });
  assert.deepEqual(run2([], { KORA_ENV: '1' }).argv, [], 'KORA_MCP=0: nothing added');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
});

test('render: renderShim dispatches the agent shims; both are sh scripts that mention their version', () => {
  for (const a of SHIM_AGENTS) { const b = renderShim(a); assert.ok(b.startsWith('#!/bin/sh')); assert.match(b, /kora shim v\d+/); assert.ok(b.includes(`tool=${a}`)); }
});

function sandbox(cap: number, realExit = 2, realLines = 10) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-shim-'));
  const shims = path.join(dir, 'shims'), real = path.join(dir, 'real');
  fs.mkdirSync(shims); fs.mkdirSync(real);
  fs.writeFileSync(path.join(shims, 'grep'), renderShim('grep', { grepCap: cap }), { mode: 0o755 });
  fs.writeFileSync(path.join(real, 'grep'), `#!/bin/sh\ni=1\nwhile [ $i -le ${realLines} ]; do echo "match $i: $*"; i=$((i+1)); done\nexit ${realExit}\n`, { mode: 0o755 });
  const run = (env: Record<string, string>) => spawnSync('sh', [path.join(shims, 'grep'), 'needle', 'file.txt'], { cwd: dir, encoding: 'utf8', env: { PATH: `${shims}:${real}:/usr/bin:/bin`, TMPDIR: dir, ...env } });
  return { dir, run };
}

test('grep shim caps stdout inside a pane, appends the refine note, preserves the exit code', posixOnly, () => {
  const { dir, run } = sandbox(3);
  const r = run({ KORA_ENV: '1' });
  const out = r.stdout.split('\n').filter(Boolean);
  assert.deepEqual(out.slice(0, 3), ['match 1: needle file.txt', 'match 2: needle file.txt', 'match 3: needle file.txt']);
  assert.equal(out[3], CAP_NOTE('3'));
  assert.equal(out.length, 4);
  assert.equal(r.status, 2, 'real grep exit code preserved');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('kora-grep.')).length, 0, 'temp file removed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('grep shim: under the cap → untouched; outside a pane → pass-through; KORA_GREP_CAP overrides at runtime', posixOnly, () => {
  const { dir, run } = sandbox(3);
  assert.equal(run({}).stdout.split('\n').filter(Boolean).length, 10, 'outside kora: all 10 lines');
  assert.equal(run({ KORA_ENV: '1', KORA_GREP_CAP: '0' }).stdout.split('\n').filter(Boolean).length, 10, 'runtime cap 0 = off');
  const five = run({ KORA_ENV: '1', KORA_GREP_CAP: '5' }).stdout.split('\n').filter(Boolean);
  assert.equal(five.length, 6); assert.equal(five[5], CAP_NOTE('5'));
  assert.equal(run({ KORA_ENV: '1', KORA_SHIMS: '0' }).stdout.split('\n').filter(Boolean).length, 10, 'KORA_SHIMS=0 disables');
  const { dir: d2, run: run2 } = sandbox(20);
  const r = run2({ KORA_ENV: '1' });
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 10, 'under the cap: no note'); assert.equal(r.status, 2);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
});

test('render: the cap is baked for grep/rg/ag only; find never caps', () => {
  for (const t of SHIM_TOOLS) {
    const body = renderShim(t, { grepCap: 200 });
    if (t === 'find') { assert.ok(!body.includes('output capped'), 'find has no cap block'); assert.ok(body.includes('cap=${KORA_GREP_CAP:-0}')); }
    else { assert.ok(body.includes('cap=${KORA_GREP_CAP:-200}')); assert.ok(body.includes('output capped at $cap lines')); }
    assert.ok(body.startsWith('#!/bin/sh'));
  }
  assert.ok(renderShim('grep', { grepCap: 0 }).includes('cap=${KORA_GREP_CAP:-0}'), 'cap 0 baked → off unless KORA_GREP_CAP set');
});

import { shellLaunch, renderShellRcs } from './shims';
test('shell launch: zsh gets a forwarding ZDOTDIR, bash an rcfile, sh an ENV, others nothing', posixOnly, () => {
  const z = shellLaunch('/bin/zsh', { ZDOTDIR: '/me/zdot' })!; assert.deepEqual(z.args, ['-l']); assert.match(z.env.ZDOTDIR, /shell\/zsh$/); assert.equal(z.env.KORA_USER_ZDOTDIR, '/me/zdot');
  const b = shellLaunch('/opt/homebrew/bin/bash')!; assert.equal(b.args[0], '--rcfile'); assert.match(b.args[1], /shell\/bash\/rc$/);
  const s = shellLaunch('/bin/sh')!; assert.match(s.env.ENV, /shell\/sh\/rc$/); assert.deepEqual(s.args, []);
  assert.equal(shellLaunch('/usr/bin/fish'), null);
  const rcs = renderShellRcs();
  assert.match(rcs['zsh/.zshrc'], /KORA_USER_ZDOTDIR:-\$HOME}\/\.zshrc/, 'sources the user\'s .zshrc');
  assert.match(rcs['zsh/.zshrc'], /path=\("\$KORA_SHIMS_DIR"/, 'then puts the shims first');
  assert.match(rcs['bash/rc'], /\.bash_profile/); assert.match(rcs['sh/rc'], /\.profile/);
});

test('security: a shim never resolves the real tool through a relative PATH entry (a repo file named grep/claude)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-shim-sec-'));
  const shims = path.join(dir, 'shims'), repo = path.join(dir, 'repo');
  fs.mkdirSync(shims); fs.mkdirSync(repo);
  const marker = path.join(dir, 'pwned');
  for (const tool of ['grep', 'claude']) {
    fs.writeFileSync(path.join(repo, tool), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(shims, tool), tool === 'claude' ? renderAgentShim('claude', { strictMcp: false, mcpEnabled: false }) : renderShim(tool, { grepCap: 0 }), { mode: 0o755 });
  }
  const env = { PATH: `.:${shims}:/usr/bin:/bin`, KORA_ENV: '1', KORA_PRELAUNCH: '0' };
  spawnSync('sh', [path.join(shims, 'grep'), 'x', '/dev/null'], { cwd: repo, env });
  spawnSync('sh', [path.join(shims, 'claude'), 'mcp'], { cwd: repo, env });
  assert.equal(fs.existsSync(marker), false, 'the repo-local binary was never executed');
  // The baked node path is a single-quoted shell word: a path with $() or quotes is never expanded.
  assert.match(renderShim('rg', { grepCap: 0 }), /^kora_node_default='[^\n]*'$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});
