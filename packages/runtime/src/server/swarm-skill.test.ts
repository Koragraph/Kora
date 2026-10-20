import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  swarmPlaybook, swarmPlaybookPath, claudeSwarmSkillDoc, installSwarmSkill, swarmModeNotice, swarmWorkerPreamble, chatSwarmPrompt, swarmLeaderSessionOptions, SWARM_LEADER_DISALLOWED_TOOLS,
} from './swarm-skill';

test('claudeSwarmSkillDoc: frontmatter name: koraswarm + a description, then the playbook', () => {
  const doc = claudeSwarmSkillDoc();
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(doc);
  assert.ok(fm, 'frontmatter block');
  assert.match(fm![1], /^name: koraswarm$/m);
  assert.match(fm![1], /^description: .+kora_spawn agent:'swarm'/m);
  assert.ok(doc.includes(swarmPlaybook()));
});

test('swarmPlaybook: the principles are there (leader reasons, swarm does legwork, capable juniors, rewrite not redo)', () => {
  const p = swarmPlaybook();
  for (const needle of [
    /You think and reason/, /gathers, distills, acts and verifies/, /Your tokens are scarce; theirs are free/,
    /capable juniors/i, /not incapable/, /runnable done-check/, /What to report back/, /Read reports, not screens/,
    /Rewrite it or split it/, /kora_merge_verify before kora_merge/, /principles, not a script/, /agent:'swarm'/,
  ]) assert.match(p, needle);
  assert.doesNotMatch(p, /\$\d/, 'no dollar figures');
});

test('swarmPlaybookPath: under KORA_HOME/skills', () => {
  assert.equal(swarmPlaybookPath(), path.join(process.env.KORA_HOME || path.join(os.homedir(), '.kora'), 'skills', 'swarm.md'));
});

test('installSwarmSkill: writes the playbook, the Claude skill and the opencode plugin; idempotent', () => {
  installSwarmSkill();
  const skill = path.join(os.homedir(), '.claude', 'skills', 'koraswarm', 'SKILL.md');
  const plugin = path.join(process.env.KORA_HOME || path.join(os.homedir(), '.kora'), 'opencode', 'plugins', 'kora-state.js');
  assert.equal(fs.readFileSync(swarmPlaybookPath(), 'utf8'), swarmPlaybook() + '\n');
  assert.equal(fs.readFileSync(skill, 'utf8'), claudeSwarmSkillDoc());
  assert.ok(fs.existsSync(plugin));
  const m = fs.statSync(skill).mtimeMs;
  installSwarmSkill();
  assert.equal(fs.statSync(skill).mtimeMs, m, 'unchanged content is not rewritten');
});

test('swarmModeNotice: entering, leaving to chat / orchestrator, and non-swarm switches', () => {
  const enter = swarmModeNotice('chat', 'swarm')!;
  assert.match(enter, /^\[kora\] User has switched to Swarm mode\. Follow the Swarm-mode rules in your system prompt/);
  assert.match(enter, /\/koraswarm skill/);
  assert.ok(enter.includes(swarmPlaybookPath()), 'file-path fallback for a lane that cannot load skills');
  assert.equal(swarmModeNotice('orchestrator', 'swarm'), enter);
  const toChat = swarmModeNotice('swarm', 'chat')!;
  assert.match(toChat, /^\[kora\] User left Swarm mode \(now Chat\)\. Stop dispatching swarm workers\./);
  assert.match(toChat, /keep running in their panes; you can no longer control them/);
  const toOrch = swarmModeNotice('swarm', 'orchestrator')!;
  assert.match(toOrch, /\(now Orchestrator\)/);
  assert.doesNotMatch(toOrch, /no longer control/, 'fleet tools remain in Orchestrator');
  assert.equal(swarmModeNotice('chat', 'orchestrator'), null);
  assert.equal(swarmModeNotice('swarm', 'swarm'), null);
});

test('swarmWorkerPreamble: the $KORA_REPORT contract — absolute path first and last, facts-only report sections', () => {
  const rp = '/tmp/wt/.kora/swarm/s3.md';
  const p = swarmWorkerPreamble({ reportPath: rp, taskId: 's3' });
  const lines = p.split('\n');
  assert.ok(lines[0].includes(rp) && lines[0].includes('$KORA_REPORT'), 'path in the first line');
  assert.ok(lines.slice(-4).some((l) => l.includes(rp)), 'path again at the end');
  assert.match(p, /s3/);
  for (const h of ['## Status', '## Changes', '## Check', '## Findings', '## Blockers']) assert.ok(p.includes(h), h);
  assert.match(p, /verbatim/);
  assert.match(p, /file:line/);
  assert.match(p, /no guesses, no conclusions/);
  assert.match(p, /Write it even if you failed/);
  assert.match(p, /nobody will answer questions/);
});

test('chatSwarmPrompt: short (≤44 lines), names kora_spawn swarm, reports, merge verify; no dollars', () => {
  for (const env of [{}, { KORA_DELEGATE_PLAN: '0' }]) {
    const s = chatSwarmPrompt(env);
    assert.ok(s.split('\n').length <= 45, `${s.split('\n').length} lines`);
    assert.match(s, /kora_spawn agent:'swarm'/);
    assert.match(s, /kora_merge_verify before kora_merge/);
    assert.match(s, /FEW calls/);
    assert.match(s, /Tiers \(Stretch/);
    assert.match(s, /kora_ask_workers \(claude = Haiku 5\.5 or codex = GPT Luna/);
    // the graph, never reading code, tells the lead where things are; the user's message rides along
    assert.match(s, /Do not explore the code yourself/);
    assert.match(s, /ONE\s+kora_locate queries:\[…\] call/);
    assert.match(s, /pastes the user's message into every task verbatim/);
    assert.match(s, /Never\s+retype the spec or paste code/);
    // the dynamic loop: races, event waits, replacement with carry-over
    assert.match(s, /race it/);
    assert.match(s, /kora_wait paneIds:\[ALL of them\] mode:"event"/);
    assert.match(s, /continues:<paneId>/);
    assert.match(s, /kora_merge paneIds:\[…\]/);
    for (const needle of [/evidence, not verdicts/, /hard override/, /and say so/]) assert.match(s, needle);
    assert.ok(s.length < 4000, `${s.length} chars`); // 3,600 before the Stretch tiers paragraph (+~100 tokens per lead call)
  }
});

test('chatSwarmPrompt: plan-on-delegate plans from the graph and hands out executable slices; =0 keeps "aim"', () => {
  const s = chatSwarmPrompt({});
  assert.match(s, /Plan with the graph, then hand out slices/);
  assert.match(s, /kora graph neighbours X --direction in/);
  assert.match(s, /kora graph blast_radius --file <path>/);
  assert.match(s, /edit sites \(file:line, what changes\), callers to update, files not\s+to touch, the check/);
  assert.match(s, /kora_plan slices:\[\{title,files,symbols\}\]/);
  assert.doesNotMatch(s, /Aim, don't explore/);
  const old = chatSwarmPrompt({ KORA_DELEGATE_PLAN: '0' });
  assert.match(old, /Aim, don't explore/);
  assert.doesNotMatch(old, /kora_plan|neighbours/);
});

test('swarmLeaderSessionOptions: the lean lane drops delegation/scheduling tools and the skill listing, keeps the basics', () => {
  const o = swarmLeaderSessionOptions({});
  for (const t of ['Agent', 'Task', 'Workflow', 'Skill', 'ScheduleWakeup', 'ListAgents']) assert.ok(o.disallowedTools.includes(t), t);
  for (const t of ['Bash', 'Read', 'Edit', 'Write', 'AskUserQuestion', 'ToolSearch']) assert.ok(!o.disallowedTools.includes(t), t);
  // kora_merge verifies before merging, so only kora_merge_verify goes; kora_plan stays for plan-on-delegate
  assert.deepEqual(o.disallowedTools.filter((t) => t.startsWith('mcp__kora')).sort(), ['mcp__kora__kora_merge_verify'], 'the other kora fleet tools stay');
  assert.deepEqual(swarmLeaderSessionOptions({ KORA_DELEGATE_PLAN: '0' }).disallowedTools.filter((t) => t.startsWith('mcp__kora')).sort(), ['mcp__kora__kora_merge_verify', 'mcp__kora__kora_plan']);
  assert.deepEqual(o.skills, []);
  assert.deepEqual(o.settings, { autoMemoryEnabled: false });
  assert.equal(swarmLeaderSessionOptions({ KORA_SWARM_LEADER_MEMORY: '1' }).settings, undefined);
  assert.deepEqual([...SWARM_LEADER_DISALLOWED_TOOLS], o.disallowedTools);
});
