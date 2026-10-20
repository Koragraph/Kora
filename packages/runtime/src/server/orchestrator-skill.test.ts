// The delegation note every code thread gets, and the worker side of a planned slice (plan-on-delegate, 2026-10-15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDelegationPrompt, chatWorkerPrompt, delegatePlanOn, PLANNED_SLICE_RULE } from './orchestrator-skill';
import { swarmWorkerPreamble } from './swarm-skill';

test('delegation note: plan with the graph only when delegating; doing it yourself needs no plan', () => {
  const s = chatDelegationPrompt({});
  assert.match(s, /When you delegate \(it pays, or the user asks\), plan with the code graph first/);
  assert.match(s, /kora graph neighbours X --direction in/);
  assert.match(s, /Work you do yourself\s+needs no plan/);
  assert.match(s, /kora_plan\s+slices:\[\{title,files,symbols\}\]/);
  assert.match(s, /Answer the user yourself/);
  const old = chatDelegationPrompt({ KORA_DELEGATE_PLAN: '0' });
  assert.doesNotMatch(old, /code graph|kora_plan/);
  assert.match(old, /Don't delegate a one-file answer/);
});

test('workers: a planned slice is followed, and a wrong plan is reported, not redesigned', () => {
  assert.equal(delegatePlanOn({}), true);
  assert.equal(delegatePlanOn({ KORA_DELEGATE_PLAN: '0' }), false);
  assert.ok(chatWorkerPrompt({}).includes(PLANNED_SLICE_RULE));
  assert.ok(!chatWorkerPrompt({ KORA_DELEGATE_PLAN: '0' }).includes(PLANNED_SLICE_RULE));
  assert.match(PLANNED_SLICE_RULE, /stay in the files it names/);
  assert.match(PLANNED_SLICE_RULE, /instead of designing a different change/);
  assert.ok(swarmWorkerPreamble({ reportPath: '/tmp/r.md', taskId: 's1' }).includes(PLANNED_SLICE_RULE));
});

test('lead hand-off: off by default; on, a chat thread hears that a 5+ command run is cheaper in a worker', () => {
  assert.doesNotMatch(chatDelegationPrompt({}), /five or more commands/);
  const on = chatDelegationPrompt({ KORA_LEAD_HANDOFF: '1' });
  assert.match(on, /five or more commands/);
  assert.match(on, /One or two commands: run them yourself/);
  assert.match(on, /Don't delegate a one-file answer/);
});
