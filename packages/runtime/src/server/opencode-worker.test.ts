// A plain OpenCode worker (kora_spawn agent:"opencode"): found live exiting with code 1 at once because the daemon
// launched a bare `opencode` off PATH with no model. prepareOpencodeSpawn must hand agentSpawn the resolved binary
// and a picked free model, and refuse with a clear error (no pane) when OpenCode is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Methods } from '../protocol/types';
import { OPENCODE_NOT_INSTALLED, defaultOpencodeSpawnDeps, prepareOpencodeSpawn, type OpencodeSpawnDeps } from './opencode-worker';
import { fleetToolSpecs } from '../session/fleet-tools';

type SpawnParams = Methods['agent.spawn']['params'];
const BIN = '/fake/kora-home/tools/opencode/current/opencode';
const deps = (bin: string | null, model: string | null, calls: string[] = []): OpencodeSpawnDeps => ({
  resolveBinary: async () => { calls.push('resolve'); return bin; },
  pickModel: async (task) => { calls.push(`pick:${task ?? ''}`); return model; },
});

test('plain opencode spawn: resolved binary + -m <picked model>, caller argv and prompt kept', async () => {
  const calls: string[] = [];
  const out = await prepareOpencodeSpawn({ agent: 'opencode', cwd: '/r', prompt: 'fix the bug', args: ['--auto'], orchestratorId: 'chat:t1' }, deps(BIN, 'opencode/ling-3.0-flash-fin-free', calls));
  assert.equal(out.command, BIN);
  assert.deepEqual(out.args, ['-m', 'opencode/ling-3.0-flash-fin-free', '--auto']);
  // no "Update Available" dialog in front of the task (found live 2026-10-19)
  assert.equal(out.env?.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(out.prompt, 'fix the bug');
  assert.equal(out.orchestratorId, 'chat:t1');
  assert.deepEqual(calls, ['resolve', 'pick:fix the bug']);
});

test('plain opencode spawn: no pickable model (or a failed pick) keeps OpenCode\'s own default — never fails', async () => {
  const none = await prepareOpencodeSpawn({ agent: 'opencode', args: ['--auto'] }, deps(BIN, null));
  assert.equal(none.command, BIN);
  assert.deepEqual(none.args, ['--auto']);
  const threw = await prepareOpencodeSpawn({ agent: 'opencode' }, { resolveBinary: async () => BIN, pickModel: async () => { throw new Error('zen probe timed out'); } });
  assert.equal(threw.command, BIN);
  assert.deepEqual(threw.args, []);
});

test('plain opencode spawn: an explicit model is kept and nothing is picked', async () => {
  const calls: string[] = [];
  const out = await prepareOpencodeSpawn({ agent: 'opencode', args: ['-m', 'opencode/big-pickle'] }, deps(BIN, 'opencode/other', calls));
  assert.equal(out.command, BIN);
  assert.deepEqual(out.args, ['-m', 'opencode/big-pickle']);
  assert.deepEqual(calls, ['resolve']);
});

test('not opencode, or a caller-supplied command (swarm): params untouched, nothing resolved', async () => {
  const calls: string[] = [];
  const claude: SpawnParams = { agent: 'claude', args: ['--x'] };
  assert.equal(await prepareOpencodeSpawn(claude, deps(null, null, calls)), claude);
  const swarm: SpawnParams = { agent: 'opencode', command: '/swarm/opencode', args: ['-m', 'opencode/a', '--auto'] };
  assert.equal(await prepareOpencodeSpawn(swarm, deps(null, null, calls)), swarm);
  assert.deepEqual(calls, []);
});

test('missing binary: a clear error, and agentSpawn never reaches a pane', async () => {
  await assert.rejects(prepareOpencodeSpawn({ agent: 'opencode', prompt: 'x' }, deps(null, 'opencode/a')), (e: Error) => e.message === OPENCODE_NOT_INSTALLED);
  await assert.rejects(prepareOpencodeSpawn({ agent: 'opencode' }, { resolveBinary: async () => { throw new Error('stat EACCES'); }, pickModel: async () => null }), /OpenCode is not installed/);

  // End to end through the leader's kora_spawn: the host's spawnWorker runs agentSpawn (prepare first, then the pane).
  const panes: SpawnParams[] = [];
  const agentSpawn = async (p: SpawnParams) => { const q = await prepareOpencodeSpawn(p, deps(null, 'opencode/a')); panes.push(q); return { id: 'p1', agent: q.agent, account: null }; };
  // kora_spawn only starts what the user approved in the worker picker (no askWorkers host = the proposal is approved).
  const approvedSpawn = async (tools: ReturnType<typeof fleetToolSpecs>) => {
    await tools.find((t) => t.name === 'kora_ask_workers')!.handler({ tasks: [{ title: 'slice', agent: 'opencode' }] });
    return tools.find((t) => t.name === 'kora_spawn')!;
  };
  const noCatalog = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-oc-'));
  const spawn = await approvedSpawn(fleetToolSpecs({
    fleet: undefined, orchestratorId: 'chat:t1', agent: 'claude', cwd: '/r', account: null, runtimeMode: 'full-access', koraHome: noCatalog,
    spawnWorker: (p) => agentSpawn({ agent: p.agent, cwd: p.cwd, prompt: p.prompt, args: p.args, orchestratorId: p.orchestratorId, name: p.name }),
  }));
  const r = await spawn.handler({ agent: 'opencode', prompt: 'do the thing', title: 'slice' });
  assert.equal(r.isError, true);
  assert.match(r.text, /OpenCode is not installed — run `kora swarm install` or Settings → Swarm/);
  assert.equal(panes.length, 0);

  // …and with the binary present the same kora_spawn launches it with a model and the thread's --auto posture.
  const ok = await approvedSpawn(fleetToolSpecs({
    fleet: undefined, orchestratorId: 'chat:t1', agent: 'claude', cwd: '/r', account: null, runtimeMode: 'full-access', koraHome: noCatalog,
    spawnWorker: async (p) => { const q = await prepareOpencodeSpawn({ agent: p.agent, args: p.args, prompt: p.prompt }, deps(BIN, 'opencode/ling-3.0-flash-fin-free')); panes.push(q); return { id: 'p2', agent: q.agent, account: null }; },
  }));
  const r2 = await ok.handler({ agent: 'opencode', prompt: 'do the thing', title: 'slice' });
  assert.equal(r2.isError, undefined);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].command, BIN);
  assert.deepEqual(panes[0].args, ['-m', 'opencode/ling-3.0-flash-fin-free', '--auto']);
});

test('default picker: the swarm picker over the live list, limited to Zen free models (no key, no swarm env)', async () => {
  const seen: { exclude: string[]; opts: unknown }[] = [];
  let fresh = 0;
  const setup = {
    ensureFresh: async (ms: number) => { fresh = ms; },
    pickableModels: () => [
      { id: 'openrouter/qwen:free', provider: 'openrouter' }, { id: 'opencode/ling-3.0-flash-fin-free', provider: 'zen' },
      { id: 'cerebras/llama', provider: 'cerebras' },
    ],
  };
  const swarm = { pickModel: (exclude: string[], opts: unknown) => { seen.push({ exclude, opts }); return { id: 'opencode/ling-3.0-flash-fin-free' }; } };
  const d = defaultOpencodeSpawnDeps({ swarm, swarmSetup: setup });
  assert.equal(await d.pickModel('write tests'), 'opencode/ling-3.0-flash-fin-free');
  assert.ok(fresh > 0 && fresh <= 10_000, 'bounded wait for the live free lists');
  assert.deepEqual(seen[0].exclude, ['openrouter/qwen:free', 'cerebras/llama']);
  assert.deepEqual(seen[0].opts, { task: 'write tests' });
  // Nothing pickable → null (OpenCode default); no swarm service → null.
  const none = defaultOpencodeSpawnDeps({ swarm: { pickModel: () => null }, swarmSetup: setup });
  assert.equal(await none.pickModel(), null);
  assert.equal(await defaultOpencodeSpawnDeps({}).pickModel('x'), null);
});
