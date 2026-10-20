// snapshotAt() must describe the screen at an exact stream offset, so live output can be spliced on without a gap
// or a repeat (the mirror parses asynchronously, a plain read() does not).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pane } from './pane';

function makePane(): Pane {
  return new Pane({ id: 'p1', workspaceId: 'w', name: 'n', command: 'sh', args: [], cwd: '/tmp', agent: 'shell' as never, env: {}, cols: 40, rows: 5 });
}
const feed = (p: Pane, d: string) => (p as unknown as { onOutput(d: string): void }).onOutput(d);

test('snapshotAt covers exactly the chars written before the call, not those buffered or written after', async () => {
  const p = makePane();
  const events: Array<{ data: string; end: number }> = [];
  p.on('output', (data: string, end: number) => events.push({ data, end }));
  feed(p, 'AAAA\r\n');
  const snapPromise = p.snapshotAt(50);
  feed(p, 'BBBB\r\n');
  const snap = await snapPromise;
  assert.equal(snap.at, 6);
  assert.match(snap.history, /AAAA/);
  assert.doesNotMatch(snap.history, /BBBB/);
  p.flushOutput();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.data, 'AAAA\r\nBBBB\r\n');
  assert.equal(events[0]!.end, 12);
  assert.equal(events[0]!.end - events[0]!.data.length, 0);
  p.dispose();
});

test('output offsets keep counting across flushes and writeLocal', async () => {
  const p = makePane();
  const ends: number[] = [];
  p.on('output', (_d: string, end: number) => ends.push(end));
  feed(p, 'one');
  p.flushOutput();
  p.writeLocal('two');
  p.flushOutput();
  assert.deepEqual(ends, [3, 6]);
  const snap = await p.snapshotAt(50);
  assert.equal(snap.at, 6);
  p.dispose();
});

test('resize emits a resize event only when the size changes', () => {
  const p = makePane();
  let n = 0;
  p.on('resize', () => n++);
  p.resize(40, 5);
  p.resize(50, 6);
  p.resize(50, 6);
  assert.equal(n, 1);
  p.dispose();
});
