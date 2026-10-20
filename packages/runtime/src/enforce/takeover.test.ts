// Takeover from the previous runtime: exactly its entries go, the developer's survive, a second run is a no-op,
// a dry run writes nothing. Runs against a temp HOME (scripts/test-isolate.cjs) and a temp repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRepo, planHome, applyPlan, removeTomlSections, stripLegacyBlocks, isLegacyHookCommand, takeoverOnce, resetTakeoverMemo } from './takeover';
import { hookText } from './adapters/claude';

const OLD = 'nh' + 'ands';
const OLD_BIN = `/Users/x/Projects/koraplex/${OLD}/bin/${OLD}.js`;
const oldHook = (ev: string) => ({ hooks: [{ type: 'command', command: `"/usr/bin/node" "\${${OLD.toUpperCase()}_BIN:-${OLD_BIN}}" hook ${ev}`, timeout: 10 }] });
const userHook = { hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/mine.sh' }] };
const koraHook = { hooks: [{ type: 'command', command: '"/usr/bin/node" "${KORA_BIN:-/opt/kora/bin/kora.js}" hook prompt' }] };
const block = (body: string) => `<!-- ${OLD}:begin -->\n${body}\n<!-- ${OLD}:end -->\n`;
const w = (f: string, s: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const r = (f: string) => fs.readFileSync(f, 'utf8');

function fixtureRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-takeover-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  w(path.join(repo, 'CLAUDE.md'), `# Team notes\nkeep this\n\n${block('THIS REPOSITORY HAS A CODE GRAPH AND A MEMORY LAYER')}`);
  w(path.join(repo, 'AGENTS.md'), block('rulebook only'));
  w(path.join(repo, 'GEMINI.md'), `${block('rules')}\n# Mine\nhuman text\n`);
  w(path.join(repo, '.cursor', 'rules', `${OLD}.mdc`), `---\ndescription: old\nalwaysApply: true\n---\n\n${block('rules')}`);
  w(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { SessionStart: [oldHook('session-start')], UserPromptSubmit: [oldHook('prompt'), koraHook] } }));
  w(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] }, hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "/Users/x/Projects/koraplex/${OLD}/koragraph/.claude/hooks/context.mjs"` }] }, userHook],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'node "/Users/x/koragraph/.claude/hooks/nudge.mjs"' }] }], // a standalone koragraph: not ours to remove
  } }));
  w(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { [OLD]: { command: 'node', args: [OLD_BIN, 'mcp'] }, other: { command: 'x' } } }));
  w(path.join(repo, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { [OLD]: { command: 'somewhere-else' } } })); // same name, not its path: kept
  const hooks = path.join(repo, '.git', 'hooks');
  w(path.join(hooks, 'post-commit'), `#!/bin/sh\necho mine\n\n# >>> koragraph auto-reindex >>> (managed — edit above/below, not between) v1\n( '/usr/bin/node' '/Users/x/Projects/koraplex/${OLD}/koragraph/bin/koragraph.js' ingest '${repo}' --project 'proj' >/dev/null 2>&1 & )\n# <<< koragraph auto-reindex <<<\n`);
  return repo;
}

test('hook-command and block recognisers are precise', () => {
  assert.equal(isLegacyHookCommand(oldHook('prompt').hooks[0].command), true);
  assert.equal(isLegacyHookCommand(koraHook.hooks[0].command), false);
  assert.equal(isLegacyHookCommand(userHook.hooks[0].command), false);
  assert.equal(isLegacyHookCommand('node "/Users/x/koragraph/.claude/hooks/context.mjs"'), false, 'a standalone koragraph hook is not the legacy product\'s');
  assert.equal(stripLegacyBlocks('# none\n'), null);
  assert.equal(stripLegacyBlocks(`a\n\n${block('x')}\nb\n`), 'a\n\nb\n');
});

test('planRepo removes only the legacy entries; apply is idempotent; dry plan writes nothing', () => {
  const repo = fixtureRepo();
  const before = new Map(['CLAUDE.md', '.mcp.json', '.claude/settings.json'].map((f) => [f, r(path.join(repo, f))]));
  const plan = planRepo(repo);
  assert.deepEqual(plan.agents.sort(), ['claude', 'cursor', 'gemini', 'unknown']);
  assert.equal(plan.steps.length, 8, plan.steps.map((s) => `${s.kind} ${s.file}`).join('\n'));
  for (const [f, s] of before) assert.equal(r(path.join(repo, f)), s, `planning alone must not write ${f}`);

  const res = applyPlan(plan);
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.equal(r(path.join(repo, 'CLAUDE.md')), '# Team notes\nkeep this\n');
  assert.equal(fs.existsSync(path.join(repo, 'AGENTS.md')), false, 'a file that was only the block is removed');
  assert.equal(r(path.join(repo, 'GEMINI.md')), '# Mine\nhuman text\n');
  assert.equal(fs.existsSync(path.join(repo, '.cursor', 'rules', `${OLD}.mdc`)), false);
  const local = JSON.parse(r(path.join(repo, '.claude', 'settings.local.json')));
  assert.deepEqual(local, { hooks: { UserPromptSubmit: [koraHook] } }, 'kora\'s own hook stays');
  const shared = JSON.parse(r(path.join(repo, '.claude', 'settings.json')));
  assert.deepEqual(shared.permissions, { allow: ['Bash(*)'] });
  assert.deepEqual(shared.hooks.UserPromptSubmit, [userHook]);
  assert.equal(shared.hooks.PreToolUse.length, 1, 'standalone koragraph hook kept');
  assert.deepEqual(Object.keys(JSON.parse(r(path.join(repo, '.mcp.json'))).mcpServers), ['other']);
  assert.ok(JSON.parse(r(path.join(repo, '.gemini', 'settings.json'))).mcpServers[OLD], 'same name, foreign command: kept');
  const hook = r(path.join(repo, '.git', 'hooks', 'post-commit'));
  assert.match(hook, /echo mine/); assert.doesNotMatch(hook, new RegExp(`/${OLD}/`)); assert.match(hook, /kora\.js' ingest .* --project 'proj'/);

  assert.equal(planRepo(repo).steps.length, 0, 'second run plans nothing');
});

// The legacy product this takes over never ran on Windows (and its fixture's POSIX trust paths are not TOML-safe there).
test('planHome: skill, codex server + legacy worktree trust, home blocks; kora equivalents requested', { skip: process.platform === 'win32' }, () => {
  const home = os.homedir();
  assert.ok(home.startsWith('/tmp/') || home.includes('kt-'), `isolated HOME expected, got ${home}`);
  w(path.join(home, 'CLAUDE.md'), `mine\n\n${block('MEMORY LAYER — recall')}`);
  w(path.join(home, '.claude', 'skills', `${OLD}-orchestrator`, 'SKILL.md'), `---\nname: ${OLD}-orchestrator\n---\nbody\n`);
  w(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
  const wt = path.join(home, `.${OLD}`, 'worktrees', 'r5', 'codex-a');
  const toml = `model = "x"\n\n[projects."/Users/x/Projects/app"]\ntrust_level = "trusted"\n\n[mcp_servers.${OLD}]\ncommand = "/usr/bin/node"\nargs = ["${OLD_BIN}", "mcp"]\n\n[mcp_servers.${OLD}.env]\nA = "1"\n\n[projects."${wt}"]\ntrust_level = "trusted"\n\n[mcp_servers.other]\ncommand = "y"\n`;
  w(path.join(process.env.CODEX_HOME!, 'config.toml'), toml);
  const plan = planHome();
  assert.deepEqual(plan.agents, ['skill', 'codex']);
  applyPlan(plan);
  assert.equal(r(path.join(home, 'CLAUDE.md')), 'mine\n');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', `${OLD}-orchestrator`)), false);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md')));
  const after = r(path.join(process.env.CODEX_HOME!, 'config.toml'));
  const parsed = require('smol-toml').parse(after);
  assert.equal(parsed.mcp_servers[OLD], undefined); assert.ok(parsed.mcp_servers.other);
  assert.ok(parsed.projects['/Users/x/Projects/app']); assert.equal(parsed.projects[wt], undefined);
  assert.equal(parsed.model, 'x');
  assert.equal(planHome().steps.length, 0, 'idempotent');
});

test('removeTomlSections keeps everything outside the dropped tables', () => {
  const { text, removed } = removeTomlSections('a = 1\n[x]\nb = 2\n[y.z]\nc = 3\n[[arr]]\nd = 4\n', (h) => h === 'x');
  assert.deepEqual(removed, ['x']); assert.equal(text, 'a = 1\n[y.z]\nc = 3\n[[arr]]\nd = 4\n');
});

test('takeoverOnce (the enforcer path) cleans the repo and the home dir, then kora installs its own', async () => {
  resetTakeoverMemo();
  const repo = fixtureRepo();
  w(path.join(os.homedir(), 'AGENTS.md'), block('home rules'));
  const notes = takeoverOnce(repo);
  assert.ok(notes.some((n) => n.includes('AGENTS.md')), notes.join('\n'));
  assert.equal(fs.existsSync(path.join(os.homedir(), 'AGENTS.md')), false);
  assert.equal(planRepo(repo).steps.length, 0);
  const { createEnforcer } = require('./enforcer');
  await createEnforcer().install({ agent: 'claude', cwd: repo });
  const local = JSON.parse(r(path.join(repo, '.claude', 'settings.local.json')));
  const cmds = Object.values(local.hooks).flat().flatMap((e: any) => e.hooks.map((h: any) => hookText(h)));
  assert.ok(cmds.length >= 7 && cmds.every((c: string) => /kora/.test(c) && !new RegExp(OLD).test(c)), cmds.join('\n'));
  assert.match(r(path.join(repo, 'CLAUDE.md')), /<!-- kora:begin -->/);
});
