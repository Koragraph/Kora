import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { assertDiskRoom, freeBytes, LowDiskError, minFreeBytes, resetDiskMemo, withDiskGuard } from './disk';

function withEnv(v: string | undefined, fn: () => void | Promise<void>) {
  const prev = process.env.KORA_MIN_FREE_GB;
  if (v === undefined) delete process.env.KORA_MIN_FREE_GB; else process.env.KORA_MIN_FREE_GB = v;
  resetDiskMemo();
  return Promise.resolve(fn()).finally(() => { if (prev === undefined) delete process.env.KORA_MIN_FREE_GB; else process.env.KORA_MIN_FREE_GB = prev; });
}

test('disk: free space is read for a path that does not exist yet (nearest existing ancestor)', () => {
  const f = freeBytes(`${os.tmpdir()}/no/such/dir/yet`);
  assert.ok(f != null && f > 0, `free=${f}`);
});

test('disk: threshold from KORA_MIN_FREE_GB; 0 turns the guard off', async () => {
  await withEnv(undefined, () => assert.equal(minFreeBytes(), 2 * 1024 ** 3));
  await withEnv('0.5', () => assert.equal(minFreeBytes(), 512 * 1024 ** 2));
  await withEnv('0', () => assertDiskRoom('anything', os.tmpdir()));
});

test('disk: below the threshold → LowDiskError that names the work, the free space and the fix', async () => {
  await withEnv('1000000', () => {
    assert.throws(() => assertDiskRoom('a swarm worker', os.tmpdir()), (e: any) => {
      assert.ok(e instanceof LowDiskError); assert.equal(e.code, 'low-disk');
      assert.match(e.message, /did not start a swarm worker/); assert.match(e.message, /free on the disk/); assert.match(e.message, /KORA_MIN_FREE_GB/);
      return true;
    });
  });
});

test('disk: withDiskGuard refuses ingests (throw / {ok:false}) and passes queries through', async () => {
  let ingests = 0;
  const g = { ingest: async (_p: string) => { ingests++; return { ok: true as const }; }, ingestWithProgress: async (_p: string, _cb: unknown) => { ingests++; return { ok: true, ms: 1 }; }, status: async () => 'status' };
  const guarded = withDiskGuard(g);
  await withEnv('1000000', async () => {
    await assert.rejects(guarded.ingest('/x'), /did not start indexing/);
    const r = await guarded.ingestWithProgress!('/x', () => {});
    assert.equal(r.ok, false); assert.match(String((r as any).error), /did not start indexing/);
    assert.equal(await guarded.status(), 'status');
    assert.equal(ingests, 0);
  });
  await withEnv('0', async () => { await guarded.ingest('/x'); assert.equal(ingests, 1); });
});
