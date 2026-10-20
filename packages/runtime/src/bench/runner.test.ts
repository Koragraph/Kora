import test from 'node:test';
import assert from 'node:assert/strict';
import { stripEnv } from './runner';

test('stripEnv: a bench started from a Kora thread drops the thread\'s session variables but keeps the agent marker', () => {
  const thread = { KORA_INJECT_OWNER: 'driver', KORA_CALLER_KEY: 'k', KORA_PANE_ID: 'chat:t1', KORA_AGENT: 'claude', KORA_ENV: '1', KORA_BIN: '/k.js', KORA_SOCKET_PATH: '/s.sock', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', KORA_HOME: '/my/home' };
  const kept = ['KORA_HOME', 'KORA_AGENT'];
  const saved = { ...process.env };
  Object.assign(process.env, thread);
  try {
    const env = stripEnv();
    for (const k of Object.keys(thread).filter((k) => !kept.includes(k))) assert.equal(env[k], undefined, k);
    assert.equal(env.KORA_HOME, '/my/home', 'the user\'s own settings stay');
    assert.equal(env.KORA_AGENT, 'claude', 'a bench run by an agent starts no unmarked sessions');
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const k of Object.keys(thread)) if (!(k in saved)) delete process.env[k]; else process.env[k] = saved[k];
  }
});
