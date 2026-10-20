// C5 (docs/qa/security-2026-10-04/2B-daemon-robustness.md item 6): a thread id that is not one safe path segment is
// refused at the socket RPC boundary as a clean invalid-params error, before any chat handler or the store sees it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertThreadIdParams } from './daemon';
import { RpcError, ERR_INVALID_PARAMS } from './rpc';

test('chat RPC params: malformed thread ids are invalid params, good ones pass', () => {
  for (const p of [{ threadId: '../../x' }, { threadId: 'a/b' }, { threadId: '..' }, { threadId: 42 }, { threadIds: ['ok', '../x'] }, { orchestratorId: 'chat:../x' }]) {
    assert.throws(() => assertThreadIdParams(p), (e: unknown) => e instanceof RpcError && e.code === ERR_INVALID_PARAMS && /invalid threadId/.test(e.message), JSON.stringify(p));
  }
  for (const p of [{}, null, { threadId: '0b6f7f8e-2c1d-4a8e-9a4b-3f2e1d0c9b8a' }, { threadIds: ['t_1', 'k2'] }, { orchestratorId: 'chat:t_1' }, { orchestratorId: 'p3' }, { threadId: '' }]) {
    assert.doesNotThrow(() => assertThreadIdParams(p), JSON.stringify(p));
  }
});
