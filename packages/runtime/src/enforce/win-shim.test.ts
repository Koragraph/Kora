import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRealBinary, launchArgs, searchPattern, capOutput, SHIMS_MARKER, RULEBOOK_FILE, CAP_NOTE, type LaunchFlagOpts } from './win-shim';
import {
  renderWinAgentCmd, renderWinAgentSh, renderWinLauncherCmd, renderAgentShim, ensureShims, removeShims, shimsDir,
  managedShimFiles, pathWithShims, shimsOnPath, batQuote, renderShim, renderWinSearchCmd, renderShellRcs, shellLaunch,
} from './shims';
import { hookCommand, isKoraHook } from './adapters/claude';
import { koraShimTarget, whichSync, envPath, withEnvPath } from '../util/win-exec';

const posixOnly = { skip: process.platform === 'win32' ? 'runs the sh launcher shim under /bin/sh' : false };
const winOnly = { skip: process.platform !== 'win32' ? 'spawns a Windows .cmd through the real shim' : false };
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const base: LaunchFlagOpts = {
  strictMcp: true, mcpEnabled: false, mcpJson: '/k/mcp/claude.json', noneJson: '/k/mcp/none.json',
  rulebook: 'RULEBOOK `explore` "x"\nline 2', codexOverrides: ['-c', 'mcp_servers.kora.command="node"'], exists: () => true,
};

test('launchArgs: claude gets strict MCP + the rulebook on a plain launch; a subcommand passes through', () => {
  assert.deepEqual(launchArgs('claude', ['-p', 'hi'], base),
    ['-p', 'hi', '--strict-mcp-config', '--mcp-config', '/k/mcp/none.json', '--append-system-prompt', base.rulebook!]);
  assert.deepEqual(launchArgs('claude', [], base), ['--strict-mcp-config', '--mcp-config', '/k/mcp/none.json', '--append-system-prompt', base.rulebook!]);
  assert.deepEqual(launchArgs('claude', ['mcp', 'list'], base), ['mcp', 'list']);
});

test('launchArgs: what the user passed wins, as in the sh shim', () => {
  assert.deepEqual(launchArgs('claude', ['--mcp-config', 'mine.json'], base), ['--mcp-config', 'mine.json', '--append-system-prompt', base.rulebook!]);
  assert.deepEqual(launchArgs('claude', ['--strict-mcp-config', '--system-prompt=x'], base), ['--strict-mcp-config', '--system-prompt=x']);
  assert.deepEqual(launchArgs('claude', [], { ...base, mcpEnabled: true }),
    ['--mcp-config', '/k/mcp/claude.json', '--strict-mcp-config', '--append-system-prompt', base.rulebook!]);
  assert.deepEqual(launchArgs('claude', [], { ...base, strictMcp: false, rulebook: null }), []);
  assert.deepEqual(launchArgs('claude', [], { ...base, exists: () => false }), ['--strict-mcp-config', '--append-system-prompt', base.rulebook!]);
});

test('launchArgs: codex gets the kora MCP overrides once, only when MCP is on', () => {
  assert.deepEqual(launchArgs('codex', [], { ...base, mcpEnabled: true }), base.codexOverrides);
  assert.deepEqual(launchArgs('codex', ['-c', 'mcp_servers.kora.x=1'], { ...base, mcpEnabled: true }), ['-c', 'mcp_servers.kora.x=1']);
  assert.deepEqual(launchArgs('codex', ['exec', 'x'], { ...base, mcpEnabled: true }), ['exec', 'x']);
  assert.deepEqual(launchArgs('codex', [], base), []);
});

test('launchArgs matches the sh shim on the same inputs', posixOnly, () => {
  const dir = tmp('kora-parity-'); const shims = path.join(dir, 'shims'), real = path.join(dir, 'real');
  fs.mkdirSync(shims); fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'claude'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n', { mode: 0o755 });
  fs.writeFileSync(path.join(shims, RULEBOOK_FILE), 'RULEBOOK one-line\n');
  const none = path.join(dir, 'none.json'); fs.writeFileSync(none, '{}');
  fs.writeFileSync(path.join(shims, 'claude'), renderAgentShim('claude', { strictMcp: true, mcpEnabled: false, noneJson: none, mcpJson: path.join(dir, 'x.json') }), { mode: 0o755 });
  const sh = spawnSync('sh', [path.join(shims, 'claude'), '-p', 'hi'], { encoding: 'utf8', env: { PATH: `${shims}:${real}:/usr/bin:/bin`, KORA_ENV: '1' } });
  const js = launchArgs('claude', ['-p', 'hi'], { ...base, noneJson: none, mcpJson: path.join(dir, 'x.json'), rulebook: 'RULEBOOK one-line', exists: fs.existsSync });
  assert.deepEqual(sh.stdout.split('\n').filter(Boolean), js);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findRealBinary skips its own dir, any other kora shims dir and relative PATH entries (no recursion)', () => {
  const dir = tmp('kora-real-');
  const mk = (d: string, f: string) => { fs.mkdirSync(path.join(dir, d), { recursive: true }); fs.writeFileSync(path.join(dir, d, f), 'x'); return path.join(dir, d); };
  const self = mk('shims', 'claude'); mk('shims', 'claude.cmd');
  const other = mk('dev-shims', 'claude.cmd'); fs.writeFileSync(path.join(other, SHIMS_MARKER), '');
  const real = mk('npm', 'claude.cmd'); mk('npm', 'claude');
  const PATH = [self + path.sep, other, '.', 'relative', real].join(path.delimiter);
  assert.equal(findRealBinary('claude', { PATH, PATHEXT: '.EXE;.CMD' }, self, 'win32'), path.join(real, 'claude.cmd'), 'Windows: PATHEXT first');
  assert.equal(findRealBinary('claude', { PATH }, self, 'darwin'), path.join(real, 'claude'));
  assert.equal(findRealBinary('claude', { PATH: self }, self, 'win32'), null);
  // Windows compares folders case-insensitively (on a case-insensitive disk the upper-case spelling IS the shims dir).
  assert.equal(findRealBinary('claude', { PATH: [self.toUpperCase(), real].join(path.delimiter), PATHEXT: '.CMD' }, self, 'win32'), path.join(real, 'claude.cmd'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Windows .cmd shims: quoted paths with spaces, % doubled, CRLF, and winCommand can unwrap them (no cmd.exe)', () => {
  const node = 'C:\\Users\\First Last\\.kora\\app\\bin\\node.exe', entry = 'C:\\Users\\First Last\\100%\\dist\\enforce\\win-shim.js';
  const cmd = renderWinAgentCmd('claude', node, entry);
  assert.match(cmd, /^@echo off\r\n/);
  assert.ok(cmd.includes(`"C:\\Users\\First Last\\.kora\\app\\bin\\node.exe" "C:\\Users\\First Last\\100%%\\dist\\enforce\\win-shim.js" --shims-dir "%~dp0." claude %*\r\n`));
  assert.ok(!cmd.replace(/\r\n/g, '').includes('\n'), 'every line ends in CRLF');
  const dir = tmp('kora-cmd-'); const file = path.join(dir, 'claude.cmd'); fs.writeFileSync(file, cmd);
  assert.deepEqual(koraShimTarget(file), { node, args: [entry, '--shims-dir', dir, 'claude'] });
  fs.writeFileSync(file, '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\x\\cli.js" %*\r\n');
  assert.equal(koraShimTarget(file), null, 'an npm shim is not ours');
  fs.rmSync(dir, { recursive: true, force: true });

  const launcher = renderWinLauncherCmd(node, 'C:\\Users\\First Last\\.kora\\app\\bin\\kora.js');
  assert.ok(launcher.includes('set "_kn=C:\\Users\\First Last\\.kora\\app\\bin\\node.exe"\r\n'));
  assert.ok(launcher.includes('if defined KORA_BIN set "_kb=%KORA_BIN%"\r\n'));
  assert.ok(launcher.includes('"%_kn%" "%_kb%" %*\r\n'));
  assert.equal(batQuote('C:\\a b\\50%'), '"C:\\a b\\50%%"');

  const sh = renderWinAgentSh('codex', node, entry);
  assert.ok(sh.includes(`exec 'C:/Users/First Last/.kora/app/bin/node.exe' 'C:/Users/First Last/100%/dist/enforce/win-shim.js' --shims-dir "$self_dir" codex "$@"`));
});

test('ensureShims on Windows writes the .cmd launchers, the Git bash copies and the marker; remove takes them all', () => {
  const dir = shimsDir();
  const out = ensureShims('win32');
  assert.deepEqual(managedShimFiles('win32'), ['kora', 'kora.cmd', 'claude', 'claude.cmd', 'codex', 'codex.cmd', 'rg.cmd', 'ag.cmd', 'grep', 'rg', 'ag', 'find']);
  for (const f of managedShimFiles('win32')) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.ok(fs.existsSync(path.join(dir, SHIMS_MARKER)));
  // Never a find.cmd (Windows' own find.exe stays what cmd.exe/PowerShell run) or a grep.cmd (Windows has no grep).
  assert.ok(!fs.existsSync(path.join(dir, 'find.cmd')) && !fs.existsSync(path.join(dir, 'grep.cmd')));
  assert.ok(out.every((r) => r.action === 'installed' || r.action === 'managed'));
  assert.ok(ensureShims('win32').every((r) => r.action === 'managed'), 'idempotent');
  removeShims('win32');
  for (const f of [...managedShimFiles('win32'), SHIMS_MARKER]) assert.ok(!fs.existsSync(path.join(dir, f)), f);
});

test('pathWithShims puts the shims dir first exactly once; shimsOnPath reads it back', () => {
  const dir = shimsDir();
  const p = pathWithShims(['/a', dir, '/b'].join(path.delimiter));
  assert.deepEqual(p.split(path.delimiter), [dir, '/a', '/b']);
  assert.ok(shimsOnPath({ PATH: p }));
  assert.ok(!shimsOnPath({ PATH: '/a' }));
});

test('Windows: PATH entries compare case-insensitively and Path is read from an env copy', { skip: process.platform !== 'win32' }, () => {
  const dir = shimsDir();
  assert.deepEqual(pathWithShims([dir.toUpperCase() + '\\', 'C:\\x'].join(';')).split(';'), [dir, 'C:\\x']);
  assert.ok(shimsOnPath({ Path: `C:\\x;${dir.toLowerCase()}` } as NodeJS.ProcessEnv));
});

test('Claude hook command on Windows: both paths double-quoted with forward slashes, so spaces survive Git bash', () => {
  const cmd = hookCommand('stop', { nodeBin: 'C:\\Users\\First Last\\.kora\\app\\bin\\node.exe', binPath: 'C:\\Users\\First Last\\.kora\\app\\bin\\kora.js' }, 'win32');
  assert.equal(cmd, '"C:/Users/First Last/.kora/app/bin/node.exe" "${KORA_BIN:-C:/Users/First Last/.kora/app/bin/kora.js}" hook stop');
  assert.ok(isKoraHook(cmd));
  assert.equal(hookCommand('stop', { nodeBin: '/a b/node', binPath: '/a b/kora.js' }, 'darwin'), '"/a b/node" "${KORA_BIN:-/a b/kora.js}" hook stop');
});

// The real thing on Windows: claude.cmd (ours) → node win-shim.js → the real claude (an npm-style .cmd shim, unwrapped
// to node, so a multi-line rulebook argument arrives whole).
test('Windows: the .cmd shim runs the real npm claude with the pane flags, from a folder with spaces', winOnly, () => {
  const dir = tmp('kora win shim ');
  const shims = path.join(dir, 'my shims'), npm = path.join(dir, 'npm dir');
  fs.mkdirSync(path.join(npm, 'node_modules', 'fake'), { recursive: true }); fs.mkdirSync(shims);
  fs.writeFileSync(path.join(npm, 'node_modules', 'fake', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(path.join(npm, 'claude.cmd'), '@ECHO off\r\nnode "%~dp0\\node_modules\\fake\\cli.js" %*\r\n');
  fs.writeFileSync(path.join(shims, SHIMS_MARKER), '');
  fs.writeFileSync(path.join(shims, RULEBOOK_FILE), 'line one\nline "two"\n');
  const entry = path.join(__dirname, 'win-shim.js');
  fs.writeFileSync(path.join(shims, 'claude.cmd'), renderWinAgentCmd('claude', process.execPath, entry));
  const env = { ...process.env, KORA_ENV: '1', KORA_PRELAUNCH: '0' } as NodeJS.ProcessEnv;
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  env.PATH = [shims, npm, path.dirname(process.execPath), process.env.SystemRoot + '\\System32'].join(';');
  const t = require('../util/win-exec').winCommand('claude', ['-p', 'hi there'], env);
  assert.equal(t.command, process.execPath, 'our .cmd is unwrapped, not run through cmd.exe');
  const r = spawnSync(t.command, t.args, { env, encoding: 'utf8' });
  const argv = JSON.parse(r.stdout);
  assert.deepEqual(argv.slice(0, 3), ['-p', 'hi there', '--strict-mcp-config']);
  assert.equal(argv[argv.length - 1], 'line one\nline "two"');
  // And typed by hand in cmd.exe: the batch file itself.
  const viaCmd = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'claude', 'mcp', 'list'], { cwd: dir, env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(viaCmd.stdout), ['mcp', 'list']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── search shims ──────────────────────────────────────────────────────────────────────────────────────────────────
test('searchPattern reads the pattern the same way as the sh shim', () => {
  assert.deepEqual(searchPattern('rg', ['-n', 'fooBar', 'src']), { pat: 'fooBar', readsFiles: true });
  assert.deepEqual(searchPattern('rg', ['-e', 'x1', '-A', '3']), { pat: 'x1', readsFiles: null });
  assert.deepEqual(searchPattern('grep', ['-rn', '/api/v1']), { pat: '/api/v1', readsFiles: true });
  assert.deepEqual(searchPattern('grep', ['foo', '-']), { pat: 'foo', readsFiles: false });
  assert.deepEqual(searchPattern('rg', ['--', '-dash']), { pat: '-dash', readsFiles: null });
  assert.deepEqual(searchPattern('find', ['.', '-type', 'f', '-iname', '*.ts']), { pat: '*.ts', readsFiles: true });
});

test('capOutput keeps the first cap lines and adds the note only when lines were dropped (wc -l semantics)', () => {
  const b = (t: string) => Buffer.from(t);
  assert.equal(capOutput(b('a\nb\n'), 2).toString(), 'a\nb\n');
  assert.equal(capOutput(b('a\nb\nc'), 2).toString(), 'a\nb\nc', 'an unterminated last line is not counted');
  assert.equal(capOutput(b('a\nb\nc\nd\n'), 2).toString(), `a\nb\n${CAP_NOTE('2')}\n`);
});

test('rg.cmd: node entry + --cap baked in, paths quoted, CRLF; no find.cmd shadowing find.exe', () => {
  const cmd = renderWinSearchCmd('rg', { grepCap: 150 }, 'C:\\a b\\node.exe', 'C:\\a b\\win-shim.js');
  assert.ok(cmd.includes('\r\n') && !/[^\r]\n/.test(cmd));
  assert.match(cmd, /^"C:\\a b\\node\.exe" "C:\\a b\\win-shim\.js" --shims-dir "%~dp0\." --cap 150 rg %\*\r$/m);
  assert.ok(!managedShimFiles('win32').some((f) => /^(find|grep)\.cmd$/i.test(f)));
});

test('win-shim.js as rg.cmd runs it: graph hits on stderr, real tool from PATH (shims dirs skipped), cap + exit code', posixOnly, () => {
  const root = fs.realpathSync(tmp('kora-ws-'));
  const self = path.join(root, 'shims'), other = path.join(root, 'other'), work = path.join(root, 'repo');
  for (const d of [self, other, work]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(other, SHIMS_MARKER), ''); fs.writeFileSync(path.join(other, 'grep'), '#!/bin/sh\necho WRONG\n', { mode: 0o755 });
  fs.writeFileSync(path.join(work, 'a.txt'), 'hit1\nhit2\nhit3\nhit4\n');
  const kb = path.join(root, 'kora.js');
  fs.writeFileSync(kb, 'console.log("src/x.ts:1 " + process.argv.slice(2).join(" "));');
  const run = (extra: Record<string, string>, args: string[]) => spawnSync(process.execPath,
    [path.join(__dirname, 'win-shim.js'), '--shims-dir', self, '--cap', '2', 'grep', ...args],
    { cwd: work, encoding: 'utf8', input: '', env: { PATH: `${self}${path.delimiter}${other}${path.delimiter}/usr/bin${path.delimiter}/bin`, KORA_ENV: '1', KORA_BIN: kb, KORA_REPO_ROOT: work, ...extra } });
  const r = run({}, ['-n', 'hit', 'a.txt']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `1:hit1\n2:hit2\n${CAP_NOTE('2')}\n`);
  assert.match(r.stderr, /^\[kora graph\] src\/x\.ts:1 graph search_code --limit 5 -- hit$/m);
  assert.equal(run({}, ['-q', 'nomatch', 'a.txt']).status, 1, 'exit code kept');
  const out = run({ KORA_ENV: '0' }, ['hit', 'a.txt']);
  assert.equal(out.stdout, 'hit1\nhit2\nhit3\nhit4\n', 'outside a pane: untouched, uncapped');
  assert.equal(out.stderr, '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Git bash search copy (win32 render) under sh: skips other shims dirs, pattern untouched, MSYS_NO_PATHCONV on the graph call, cap', posixOnly, () => {
  const root = fs.realpathSync(tmp('kora-gb-'));
  const self = path.join(root, 'shims'), other = path.join(root, 'other'), work = path.join(root, 'repo');
  for (const d of [self, other, work]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(other, SHIMS_MARKER), ''); fs.writeFileSync(path.join(other, 'grep'), '#!/bin/sh\necho WRONG\n', { mode: 0o755 });
  fs.writeFileSync(path.join(self, 'grep'), renderShim('grep', { grepCap: 2, platform: 'win32' }), { mode: 0o755 });
  fs.writeFileSync(path.join(work, 'a.txt'), '/api/v1 a\n/api/v1 b\n/api/v1 c\n');
  const kb = path.join(root, 'kora.js');
  fs.writeFileSync(kb, 'console.log(process.env.MSYS_NO_PATHCONV + " " + process.argv.slice(-1)[0]);');
  const r = spawnSync('/bin/sh', [path.join(self, 'grep'), '-n', '/api/v1', 'a.txt'], { cwd: work, encoding: 'utf8', input: '',
    env: { PATH: `${self}:${other}:/usr/bin:/bin`, KORA_ENV: '1', KORA_BIN: kb, KORA_NODE: process.execPath, KORA_REPO_ROOT: work } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `1:/api/v1 a\n2:/api/v1 b\n${CAP_NOTE('2')}\n`);
  assert.match(r.stderr, /^\[kora graph\] 1 \/api\/v1$/m);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Git bash panes start with the kora rc (shims back in front of /usr/bin); cmd.exe/PowerShell get none', posixOnly, () => {
  assert.deepEqual(shellLaunch('C:\\Program Files\\Git\\bin\\bash.exe', {}, 'win32')?.args[0], '--rcfile');
  assert.ok(!shellLaunch('C:\\Program Files\\Git\\bin\\bash.exe', {}, 'win32')!.args[1]!.includes('\\'));
  assert.equal(shellLaunch('C:\\Windows\\System32\\cmd.exe', {}, 'win32'), null);
  assert.equal(shellLaunch('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', {}, 'win32'), null);
  const rcs = renderShellRcs('win32');
  assert.deepEqual(Object.keys(rcs), ['bash/rc']);
  // The PATH line itself, under sh (no cygpath here: the fallback keeps the value as is).
  const line = rcs['bash/rc']!.trim().split('\n').pop()!;
  const r = spawnSync('/bin/sh', ['-c', `${line}; printf %s "$PATH"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/k/shims:/bin', KORA_SHIMS_DIR: '/k/shims' } });
  assert.equal(r.stdout, '/k/shims:/usr/bin:/bin');
});

test('Windows: with the shims dir first on PATH, find still resolves to Windows\' own find.exe', winOnly, () => {
  ensureShims();
  const env = withEnvPath({ ...process.env }, `${shimsDir()}${path.delimiter}${envPath(process.env) ?? ''}`);
  const find = whichSync('find', env);
  assert.ok(find && !find.toLowerCase().startsWith(shimsDir().toLowerCase()), String(find));
  const rg = whichSync('rg', env);
  assert.equal(rg?.toLowerCase(), path.join(shimsDir(), 'rg.cmd').toLowerCase());
  removeShims();
});
