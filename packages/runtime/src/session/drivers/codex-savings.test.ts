import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexDriver } from './codex-driver';
import {
  CODEX_AUTO_COMPACT_TOKEN_LIMIT, CODEX_TOOL_OUTPUT_TOKEN_LIMIT, FEATURE_CACHE_TTL_MS, FEATURE_FAIL_TTL_MS, codexFeatures, codexLimitArgs, codexSavingsArgs, codexSavingsOn, parseFeatureList, resetCodexFeatureCache, userConfigSets,
} from './codex-savings';
import type { DriverDeps } from '../session-driver';

const FEATURES = `apps                                     stable             true
apps_mcp_path_override                   removed            false
browser_use                              stable             true
browser_use_external                     stable             true
computer_use                             stable             true
image_generation                         stable             true
hooks                                    stable             true
multi_agent                              stable             true
memories                                 stable             false
guardianv2.thread_context                under development  false
`;
const emptyHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-codexhome-'));

test('parseFeatureList: name -> enabled, from the real `codex features list` layout', () => {
  const m = parseFeatureList(FEATURES);
  assert.equal(m.get('apps'), true); assert.equal(m.get('memories'), false); assert.equal(m.get('guardianv2.thread_context'), false);
  assert.equal(m.size, 10);
  assert.equal(parseFeatureList('garbage\n\nError: nope').size, 0);
});

test('userConfigSets: a key in the user\'s own config.toml wins; absent file/key is false', () => {
  const home = emptyHome();
  assert.equal(userConfigSets('tool_output_token_limit', home), false);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n  tool_output_token_limit = 4000\n# model_auto_compact_token_limit = 1\n');
  assert.equal(userConfigSets('tool_output_token_limit', home), true);
  assert.equal(userConfigSets('model_auto_compact_token_limit', home), false, 'a commented line is not a setting');
});

test('codexLimitArgs: both limits by default, skipping any the user set', () => {
  const home = emptyHome();
  assert.deepEqual(codexLimitArgs({ codexHome: home }), ['-c', `tool_output_token_limit=${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}`, '-c', `model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKEN_LIMIT}`]);
  assert.equal(CODEX_TOOL_OUTPUT_TOKEN_LIMIT, 10000); assert.equal(CODEX_AUTO_COMPACT_TOKEN_LIMIT, 150000);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model_auto_compact_token_limit = 200000\n');
  assert.deepEqual(codexLimitArgs({ codexHome: home }), ['-c', 'tool_output_token_limit=10000']);
});

test('codexSavingsArgs: disables only features the binary lists as enabled; one probe per binary; failure = limits only; off = nothing', async () => {
  resetCodexFeatureCache();
  const home = emptyHome();
  let probes = 0;
  const run = async () => { probes++; return FEATURES; };
  const a = await codexSavingsArgs('/bin/codex-a', { codexHome: home, run });
  assert.deepEqual(a.filter((x) => x !== '-c' && !x.includes('=')), ['--disable', 'apps', '--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'computer_use', '--disable', 'image_generation']);
  assert.ok(!a.includes('multi_agent') && !a.includes('hooks') && !a.includes('memories'), 'only the candidates, never hooks');
  await codexSavingsArgs('/bin/codex-a', { codexHome: home, run });
  assert.equal(probes, 1, 'cached per binary');
  // an older binary that lacks image_generation: not named (an unknown name is a hard error in codex)
  const older = await codexSavingsArgs('/bin/codex-old', { codexHome: home, run: async () => 'apps stable true\n' });
  assert.deepEqual(older.filter((x) => x === '--disable' || x === 'image_generation'), ['--disable']);
  // unreadable binary: the limits still apply, no --disable
  const broken = await codexSavingsArgs('/bin/codex-broken', { codexHome: home, run: async () => { throw new Error('ENOENT'); } });
  assert.ok(!broken.includes('--disable') && broken.includes('tool_output_token_limit=10000'));
  // the switch
  assert.deepEqual(await codexSavingsArgs('/bin/codex-a', { codexHome: home, run, env: { KORA_CODEX_SAVINGS: '0' } as any }), []);
  assert.equal(codexSavingsOn(emptyHome(), { KORA_CODEX_SAVINGS: 'off' } as any), false);
  const kh = emptyHome(); fs.writeFileSync(path.join(kh, 'savings.json'), JSON.stringify({ codexSavings: false }));
  assert.equal(codexSavingsOn(kh, {} as any), false, 'savings.json switch');
  assert.equal(codexSavingsOn(emptyHome(), {} as any), true);
  assert.equal(await codexFeatures('/bin/codex-a', run) instanceof Map, true);
});

test('a Codex turn carries the savings flags before the prompt (fake binary: limits only), and `--` still ends options', async () => {
  const argvs: string[][] = [];
  const spawnFn: any = (_c: string, args: string[]) => {
    argvs.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    setImmediate(() => { child.stdout.end(); child.emit('exit', 0, null); child.emit('close', 0, null); });
    return child;
  };
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const prev = process.env.CODEX_HOME; process.env.CODEX_HOME = emptyHome();
  try {
    const d = new CodexDriver(deps, spawnFn);
    await d.startSession({ threadId: 'S', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'full-access' } as any);
    await d.sendTurn({ threadId: 'S', text: 'hello' } as any);
  } finally { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; }
  const args = argvs[0]!;
  const i = args.indexOf('tool_output_token_limit=10000');
  assert.ok(i > 0 && args[i - 1] === '-c', args.join(' '));
  assert.ok(args.includes('model_auto_compact_token_limit=150000'));
  assert.ok(args.indexOf('--') > i, 'flags precede the -- terminator');
  assert.equal(args[args.length - 1], 'hello');
  assert.ok(args.includes('--disable') && args[args.indexOf('--disable') + 1] === 'multi_agent', 'the no-subagents rule is intact');
});

test('feature probe cache expires: a failed probe is retried within a minute, a good one after ten (a Codex update must not leave a stale --disable list)', async () => {
  resetCodexFeatureCache();
  let n = 0; let fail = true;
  const run = async () => { n++; if (fail) throw new Error('slow'); return 'apps stable true\n'; };
  const t0 = 1_000_000;
  assert.equal(await codexFeatures('/bin/codex-ttl', run, t0), null);
  assert.equal(await codexFeatures('/bin/codex-ttl', run, t0 + FEATURE_FAIL_TTL_MS - 1), null);
  assert.equal(n, 1, 'inside the failure window: no second probe');
  fail = false;
  assert.ok((await codexFeatures('/bin/codex-ttl', run, t0 + FEATURE_FAIL_TTL_MS + 1)) instanceof Map, 'retried after the failure window');
  assert.equal(n, 2);
  await codexFeatures('/bin/codex-ttl', run, t0 + FEATURE_FAIL_TTL_MS + 2 + FEATURE_CACHE_TTL_MS - 10);
  assert.equal(n, 2, 'a good probe is kept');
  await codexFeatures('/bin/codex-ttl', run, t0 + FEATURE_FAIL_TTL_MS + 2 + FEATURE_CACHE_TTL_MS + 10);
  assert.equal(n, 3, 'and re-read after the TTL');
});
