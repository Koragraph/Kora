import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeHooks, stripHooks, HOOK_EVENTS, isKoraHook, isKoraHookEntry, hookCommand, hookText, hooksInstalled, withGuardSettings, withPaneSettings, koraHookSpec } from './adapters/claude';
import { upsertCodexMcp, removeCodexMcp, codexMcpStatus } from './mcpconfig';

// The shell-string form (macOS/Linux) on every OS; the Windows exec form has its own tests below.
const ctx = { binPath: '/abs/bin/kora.js', nodeBin: '/usr/bin/node', platform: 'darwin' as const };

test('settings.json merge: idempotent, preserves user hooks and other keys, one entry per event', () => {
  const settings: any = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
  };
  const r1 = mergeHooks(settings, ctx);
  assert.ok(r1.changed);
  for (const [event] of HOOK_EVENTS) {
    const ours = r1.settings.hooks[event].filter((e: any) => e.hooks.some((h: any) => isKoraHook(h.command)));
    assert.equal(ours.length, 1, `${event} carries exactly one kora entry`);
  }
  assert.equal(r1.settings.hooks.PreToolUse.length, 2, 'user PreToolUse hook kept');
  assert.equal(r1.settings.hooks.PreToolUse[0].hooks[0].command, 'echo user-hook');
  assert.deepEqual(r1.settings.permissions, { allow: ['Bash(ls)'] });

  const r2 = mergeHooks(JSON.parse(JSON.stringify(r1.settings)), ctx);
  assert.equal(r2.changed, false, 'second merge is a no-op');
  assert.equal(r2.settings.hooks.PreToolUse.length, 2, 'no duplicates on re-install');

  // A stale entry (old bin path) is refreshed in place, not duplicated.
  r2.settings.hooks.Stop[0].hooks[0].command = '"/usr/bin/node" "${KORA_BIN:-/old/kora.js}" hook stop';
  const r3 = mergeHooks(r2.settings, ctx);
  assert.ok(r3.changed);
  assert.equal(r3.settings.hooks.Stop.length, 1);
  assert.equal(r3.settings.hooks.Stop[0].hooks[0].command, hookCommand('stop', ctx, 'darwin'));

  const s = stripHooks(r3.settings);
  assert.ok(s.changed);
  assert.deepEqual(Object.keys(s.settings.hooks), ['PreToolUse']);
  assert.equal(s.settings.hooks.PreToolUse[0].hooks[0].command, 'echo user-hook');
  assert.deepEqual(s.settings.permissions, { allow: ['Bash(ls)'] });
});

test('settings.json merge: --replace-koragraph-hooks removes koragraph script entries only', () => {
  const settings: any = { hooks: {
    PreToolUse: [
      { hooks: [{ type: 'command', command: 'node "/x/koragraph/.claude/hooks/nudge.mjs"' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/x/koragraph/.claude/hooks/preflight.mjs"' }] },
      { hooks: [{ type: 'command', command: 'echo mine' }] },
    ],
  } };
  const r = mergeHooks(settings, { ...ctx, replaceKoragraphHooks: true });
  assert.equal(r.removedKoragraph, 2);
  const cmds = r.settings.hooks.PreToolUse.map((e: any) => e.hooks[0].command);
  assert.ok(cmds.includes('echo mine'));
  assert.ok(!cmds.some((c: string) => c.includes('koragraph')));
});

// ── Windows: the exec form (command + args, no shell) ─────────────────────────────────────────────────────────────
const winCtx = { nodeBin: 'C:\\Users\\First Last\\.kora\\app\\bin\\node.exe', binPath: 'C:\\Users\\First Last\\.kora\\app\\bin\\kora.js', platform: 'win32' as const };

test('Windows hooks: exec form, paths passed as-is (spaces need no quoting), and every matcher still finds them', () => {
  assert.deepEqual(koraHookSpec('stop', winCtx, 15), { type: 'command', command: winCtx.nodeBin, args: [winCtx.binPath, 'hook', 'stop'], timeout: 15 });
  const r = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, winCtx);
  for (const [event, hookEvent] of HOOK_EVENTS) {
    const ours = r.settings.hooks[event].flatMap((e: any) => e.hooks).filter(isKoraHookEntry);
    assert.equal(ours.length, 1, event);
    assert.deepEqual(ours[0].args, [winCtx.binPath, 'hook', hookEvent]);
    assert.ok(!('shell' in ours[0]));
  }
  assert.equal(mergeHooks(JSON.parse(JSON.stringify(r.settings)), winCtx).changed, false, 'idempotent');
  assert.match(hookText(r.settings.hooks.Stop[1].hooks[0]), /kora\.js hook stop$/);
  // Uninstall takes exactly ours.
  const s = stripHooks(r.settings);
  assert.deepEqual(s.settings.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
  // The credential guard flag settings use the same form.
  const g = JSON.parse(withGuardSettings([], winCtx).args[1]!);
  assert.deepEqual(g.hooks.PreToolUse[0].hooks[0].args, [winCtx.binPath, 'hook', 'pre-tool']);
});

test('Windows hooks: a shell-string kora hook from an older build is replaced, never duplicated', () => {
  const old = { type: 'command', command: '"C:/Users/First Last/.kora/app/bin/node.exe" "${KORA_BIN:-C:/Users/First Last/.kora/app/bin/kora.js}" hook stop', timeout: 15 };
  const r = mergeHooks({ hooks: { Stop: [{ hooks: [old] }] } }, winCtx);
  assert.equal(r.settings.hooks.Stop.length, 1);
  assert.ok(Array.isArray(r.settings.hooks.Stop[0].hooks[0].args));
});

test('isKoraHookEntry: exec form with kora.js / kora / kora.cmd before `hook`; other exec hooks are not ours', () => {
  assert.ok(isKoraHookEntry({ command: 'C:\\n\\node.exe', args: ['D:\\x y\\bin\\kora.js', 'hook', 'prompt'] }));
  assert.ok(isKoraHookEntry({ command: 'C:\\Users\\a\\.local\\bin\\kora.cmd', args: ['hook', 'stop'] }));
  assert.ok(!isKoraHookEntry({ command: 'node', args: ['C:\\tools\\mykora-helper.js', 'hook', 'stop'] }));
  assert.ok(!isKoraHookEntry({ command: 'node', args: ['C:\\tools\\other.js', 'stop'] }));
  assert.ok(isKoraHookEntry({ command: '"/usr/bin/node" "${KORA_BIN:-/a/kora.js}" hook stop' }));
  assert.ok(!isKoraHookEntry({ command: 'echo hook' }));
  assert.equal(isKoraHook('"/usr/bin/node" "${KORA_BIN:-/a/kora.js}" hook stop'), true);
});

test('hooksInstalled counts only the form this platform writes, so an upgrade rewrites the old one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-hooks-'));
  fs.mkdirSync(path.join(root, '.claude'));
  const write = (s: any) => fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify(s));
  write(mergeHooks({}, ctx).settings);
  assert.equal(hooksInstalled(root, 'darwin').all, true);
  assert.equal(hooksInstalled(root, 'win32').all, false, 'a shell-string hook on Windows is outdated');
  write(mergeHooks({}, winCtx).settings);
  assert.equal(hooksInstalled(root, 'win32').all, true);
  assert.equal(hooksInstalled(root, 'darwin').all, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex config.toml: append section, idempotent, remove leaves the rest byte-for-byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-codex-'));
  const file = path.join(dir, 'config.toml');
  const original = '# my codex config\nmodel = "gpt-5"\nnotify = ["a", "b"]\n\n[mcp_servers.other]\ncommand = "y"\nargs = ["1", "2"]\n\n[projects."/x"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(file, original);
  assert.equal(upsertCodexMcp(file).action, 'installed');
  assert.equal(codexMcpStatus(file).action, 'managed');
  assert.equal(upsertCodexMcp(file).action, 'managed');
  const parsed = require('smol-toml').parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.mcp_servers.other.command, 'y');
  assert.deepEqual({ ...parsed.projects['/x'] }, { trust_level: 'trusted' }); // smol-toml 1.9 tables have a null prototype
  assert.ok(Array.isArray(parsed.mcp_servers.kora.args) && parsed.mcp_servers.kora.args[1] === 'mcp');
  assert.equal(removeCodexMcp(file).action, 'removed');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), original.trim());
  assert.equal(codexMcpStatus(file).action, 'absent');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('codex config.toml: upsertCodexTrust appends a projects entry once and respects an existing one', () => {
  const { upsertCodexTrust } = require('./mcpconfig');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-codex-trust-'));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'model = "gpt-5"\n\n[projects."/Users/me/app"]\ntrust_level = "trusted"\n');
  const a = upsertCodexTrust('/Users/me/.kora/worktrees/r/wt', file);
  assert.equal(a.action, 'installed');
  const b = upsertCodexTrust('/Users/me/.kora/worktrees/r/wt', file);
  assert.equal(b.action, 'managed');
  const parsed = require('smol-toml').parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.projects['/Users/me/.kora/worktrees/r/wt'].trust_level, 'trusted');
  assert.equal(parsed.projects['/Users/me/app'].trust_level, 'trusted');
  assert.equal(parsed.model, 'gpt-5');
  // Only the line Kora added is in its ledger; uninstall removes that one and keeps the one that was already there.
  const { readCodexTrustLedger, removeCodexTrustAdded } = require('./mcpconfig');
  assert.ok(readCodexTrustLedger().includes('/Users/me/.kora/worktrees/r/wt'));
  assert.equal(readCodexTrustLedger().includes('/Users/me/app'), false);
  assert.deepEqual(removeCodexTrustAdded(file, ['/Users/me/.kora/worktrees/r/wt']), ['/Users/me/.kora/worktrees/r/wt']);
  const after = require('smol-toml').parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.projects['/Users/me/.kora/worktrees/r/wt'], undefined);
  assert.equal(after.projects['/Users/me/app'].trust_level, 'trusted');
});

test('a flavored home (Kora Dev) never writes the machine-wide ~/.codex/config.toml; stable entry is not removed by another install', () => {
  const prev = process.env.KORA_HOME;
  process.env.KORA_HOME = path.join(os.tmpdir(), 'kora-flavored-x');
  try {
    const r = upsertCodexMcp();
    assert.equal(r.action, 'skipped');
    assert.match(r.detail ?? '', /separate install/);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cx-')), 'config.toml');
    fs.writeFileSync(file, '[mcp_servers.kora]\ncommand = "/stable/node"\nargs = ["/stable/kora.js", "mcp"]\n');
    process.env.CODEX_HOME = path.dirname(file);
    assert.equal(removeCodexMcp().action, 'skipped');
    assert.ok(fs.readFileSync(file, 'utf8').includes('/stable/node'));
  } finally { if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev; delete process.env.CODEX_HOME; }
});

// bin/kora.js: a Windows exec-form hook bakes the install's kora.js; the pane's KORA_BIN (another checkout) takes over.
test('Windows: a hook run of bin/kora.js hands over to $KORA_BIN once', { skip: process.platform !== 'win32' ? 'the redirect is Windows-only' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora bin '));
  const other = path.join(dir, 'kora.js'), mark = path.join(dir, 'ran.txt');
  fs.writeFileSync(other, `require('node:fs').writeFileSync(${JSON.stringify(mark)}, process.argv.slice(2).join(' ') + '|' + process.env.KORA_BIN_REDIRECTED);`);
  const bin = path.join(__dirname, '..', '..', 'bin', 'kora.js');
  const r = require('node:child_process').spawnSync(process.execPath, [bin, 'hook', 'stop'], { env: { ...process.env, KORA_BIN: other, KORA_BIN_REDIRECTED: '' }, input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(mark, 'utf8'), 'hook stop|1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pane settings pin promptSuggestionEnabled:false: added alone, merged into the guard settings, a user settings file left alone', () => {
  const alone = withPaneSettings(['--model', 'x']);
  assert.deepEqual(alone.args.slice(-2), ['--settings', JSON.stringify({ promptSuggestionEnabled: false })]);
  assert.ok(alone.note);
  // merged into Kora's own guard --settings (Claude takes one flag)
  const guard = withGuardSettings([], ctx).args;
  const merged = withPaneSettings(guard);
  assert.equal(merged.args.filter((a) => a === '--settings').length, 1);
  const j = JSON.parse(merged.args[merged.args.indexOf('--settings') + 1]!);
  assert.equal(j.promptSuggestionEnabled, false);
  assert.ok(j.hooks.PreToolUse, 'the guard hooks survive the merge');
  // an explicit user choice in JSON wins; a settings FILE is not touched
  const mine = withPaneSettings(['--settings', '{"promptSuggestionEnabled":true}']);
  assert.equal(JSON.parse(mine.args[1]!).promptSuggestionEnabled, true);
  const file = withPaneSettings(['--settings', '/tmp/own.json']);
  assert.deepEqual(file.args, ['--settings', '/tmp/own.json']);
  assert.equal(file.note, null);
  // Kora's compaction point rides as flag settings env (a user env block in ~/.claude/settings.json would beat the process env)
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' };
  assert.deepEqual(JSON.parse(withPaneSettings(['--model', 'x'], env).args.at(-1)!).env, env);
  assert.deepEqual(JSON.parse(withPaneSettings(guard, env).args[guard.indexOf('--settings') + 1]!).env, env);
  assert.equal(JSON.parse(withPaneSettings(['--settings', '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"500000"}}'], env).args[1]!).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '500000', 'a caller\'s own JSON wins');
});
