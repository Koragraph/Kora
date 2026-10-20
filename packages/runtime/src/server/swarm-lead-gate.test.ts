import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadGate, isCheckCommand, leadGateHooks, LEAD_GATE_FREE_BEFORE, LEAD_GATE_FREE_AFTER } from './swarm-lead-gate';

test('lead gate: a few orienting calls, then delegate; checks always pass', () => {
  const g = createLeadGate({});
  for (let i = 0; i < LEAD_GATE_FREE_BEFORE; i++) assert.ok(g.decide('Read', { file_path: '/r/a.js' }).allow);
  const v = g.decide('Grep', { pattern: 'x' });
  assert.equal(v.allow, false); assert.match((v as any).reason, /kora_spawn/);
  assert.equal(g.decide('Edit', {}).allow, false);
  assert.ok(g.decide('Bash', { command: 'cd api && npx vitest run' }).allow);
  assert.ok(g.decide('Bash', { command: 'git diff --stat' }).allow);
  assert.ok(g.decide('Bash', { command: 'kora graph explore "in-flight limiter"' }).allow);
  assert.equal(g.decide('Bash', { command: 'cat src/x.js' }).allow, false);
  assert.ok(g.decide('mcp__kora__kora_wait', {}).allow);
  assert.ok(g.decide('mcp__kora__kora_spawn', {}).allow);
  assert.ok(g.spawned);
  for (let i = 0; i < LEAD_GATE_FREE_AFTER; i++) assert.ok(g.decide('Read', {}).allow);
  const w = g.decide('Edit', {}); assert.equal(w.allow, false); assert.match((w as any).reason, /back to a worker/);
  assert.ok(g.decide('AskUserQuestion', {}).allow);
});

test('lead gate: KORA_SWARM_LEAD_GATE=0 turns it off; check-command detection', () => {
  const g = createLeadGate({ KORA_SWARM_LEAD_GATE: '0' });
  for (let i = 0; i < 20; i++) assert.ok(g.decide('Read', {}).allow);
  for (const c of ['pnpm test', 'npm run typecheck', 'pytest -q', 'go test ./...', 'tsc -p .', 'node --test x.js', 'git status']) assert.ok(isCheckCommand(c), c);
  for (const c of ['ls src', 'cat a.js', 'grep -rn foo src', 'find . -name x']) assert.ok(!isCheckCommand(c), c);
});

test('lead gate hooks: SDK PreToolUse shape, deny carries the reason', async () => {
  const h: any = leadGateHooks({});
  const fn = h.PreToolUse[0].hooks[0];
  for (let i = 0; i < LEAD_GATE_FREE_BEFORE; i++) assert.deepEqual(await fn({ tool_name: 'Read', tool_input: {} }), {});
  const out = await fn({ tool_name: 'Read', tool_input: {} });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Delegate now/);
});

test('lead gate: with plan-on-delegate the deny points at planning from the graph; =0 keeps the verbatim-paste advice', () => {
  const deny = (env: NodeJS.ProcessEnv) => {
    const g = createLeadGate(env);
    for (let i = 0; i < LEAD_GATE_FREE_BEFORE; i++) g.decide('Read', {});
    const v = g.decide('Read', {});
    return v.allow ? '' : v.reason;
  };
  assert.match(deny({}), /plan from the graph/);
  assert.match(deny({}), /one worker per slice with its edit sites/);
  assert.match(deny({ KORA_DELEGATE_PLAN: '0' }), /verbatim/);
  // graph calls are still free while the lead plans
  const g = createLeadGate({});
  for (let i = 0; i < 20; i++) assert.ok(g.decide('Bash', { command: 'kora graph neighbours allocate --direction in' }).allow);
});
