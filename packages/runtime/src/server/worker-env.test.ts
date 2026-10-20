// worker-env: a Swarm worker (third-party model) gets an allowlisted env; orchestrator workers / shells inherit.
import test from 'node:test';
import path from 'node:path';
import assert from 'node:assert/strict';
import { baseEnv } from './worker-env';

const SHELL_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin', HOME: '/Users/u', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM: 'xterm', TMPDIR: '/tmp/x',
  HTTPS_PROXY: 'http://proxy:8080', NVM_DIR: '/Users/u/.nvm', KORA_HOME: '/Users/u/.kora', KORAGRAPH_DB: '/g.db',
  ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: 'sk-fake', GITHUB_TOKEN: 'ghp_fake', GH_TOKEN: 'gho_fake',
  AWS_ACCESS_KEY_ID: 'AKIAFAKE', AWS_SECRET_ACCESS_KEY: 'fake', AWS_SESSION_TOKEN: 'fake', NPM_TOKEN: 'npm_fake',
  OPENROUTER_API_KEY: 'sk-or-fake', CEREBRAS_API_KEY: 'csk-fake', OPENCODE_API_KEY: 'zen-fake',
  SSH_AUTH_SOCK: '/tmp/ssh', GOOGLE_APPLICATION_CREDENTIALS: '/Users/u/gcp.json', DATABASE_URL: 'postgres://u:p@h/db',
  KORA_UI_TOKEN: 'fake', KORA_SECRET_THING: 'fake', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KORA_PANE_ID: 'p9',
  UNDEF: undefined,
};

test('isolated: only the allowlist survives — no LLM, cloud, git, npm, ssh or db credential', () => {
  const env = baseEnv(SHELL_ENV, 'isolated');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'KORAGRAPH_DB', 'KORA_HOME', 'LANG', 'LC_ALL', 'NVM_DIR', 'PATH', 'TERM', 'TMPDIR']);
  for (const v of Object.values(env)) assert.doesNotMatch(v, /fake|postgres/);
});

test('isolated: the provider keys are never inherited (swarmPaneEnv adds only the worker\'s own)', () => {
  const env = baseEnv(SHELL_ENV, 'isolated');
  for (const k of ['OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'OPENCODE_API_KEY']) assert.equal(env[k], undefined, k);
});

test('inherit: the user\'s own CLIs keep the env, minus a parent session\'s markers', () => {
  const env = baseEnv(SHELL_ENV, 'inherit');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-fake');
  assert.equal(env.GITHUB_TOKEN, 'ghp_fake');
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'KORA_PANE_ID', 'UNDEF']) assert.equal(k in env, false, k);
});

test('every policy drops Kora\'s own secrets (KORA_*_TOKEN…, release signing) but keeps agent auth + plumbing', () => {
  const src: NodeJS.ProcessEnv = {
    ...SHELL_ENV, KORA_BITBUCKET_API_TOKEN: 'fake', KORA_P12_PASSWORD: 'fake', KORA_SIGN_KEYCHAIN: '/k', CSC_LINK: 'fake',
    CSC_KEY_PASSWORD: 'fake', APPLE_APP_SPECIFIC_PASSWORD: 'fake', APPLE_API_KEY: '/k.p8', KORA_SOCKET_PATH: '/s.sock',
  };
  for (const policy of ['inherit', 'isolated'] as const) {
    const env = baseEnv(src, policy);
    for (const k of ['KORA_UI_TOKEN', 'KORA_SECRET_THING', 'KORA_BITBUCKET_API_TOKEN', 'KORA_P12_PASSWORD', 'KORA_SIGN_KEYCHAIN', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY']) {
      assert.equal(k in env, false, `${policy}: ${k}`);
    }
    assert.equal(env.KORA_HOME, '/Users/u/.kora', `${policy}: non-secret KORA_* kept`);
    assert.equal(env.KORA_SOCKET_PATH, '/s.sock', `${policy}: socket path kept`);
    assert.ok(env.PATH!.startsWith('/usr/bin:/bin'), 'the original PATH comes first');
    assert.ok(env.PATH!.split(path.delimiter).includes(path.dirname(process.execPath)), 'the daemon\'s node dir is appended so workers can run node');
  }
  const inherit = baseEnv(src, 'inherit');
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_ACCESS_KEY_ID', 'SSH_AUTH_SOCK', 'HTTPS_PROXY']) assert.ok(k in inherit, `agent auth kept: ${k}`);
});

test('scrubProcessEnv removes only Kora\'s own secrets from a process env', () => {
  const { scrubProcessEnv, scrubChildEnv } = require('../util/child-env') as typeof import('../util/child-env');
  const env: NodeJS.ProcessEnv = { PATH: '/bin', KORA_HOME: '/h', KORA_UI_TOKEN: 'x', ANTHROPIC_API_KEY: 'k', CSC_LINK: 'p12' };
  assert.deepEqual(scrubChildEnv(env), { PATH: '/bin', KORA_HOME: '/h', ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(scrubProcessEnv(env).sort(), ['CSC_LINK', 'KORA_UI_TOKEN']);
  assert.deepEqual(env, { PATH: '/bin', KORA_HOME: '/h', ANTHROPIC_API_KEY: 'k' });
});
