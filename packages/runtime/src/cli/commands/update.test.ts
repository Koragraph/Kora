import test from 'node:test';
import assert from 'node:assert/strict';
import { run, RELEASES_URL } from './update';

test('kora update on Windows points to the installer / self-update and never runs bash or install.sh', async () => {
  let out = ''; let err = '';
  const io = { out: (s: string) => { out += s; }, err: (s: string) => { err += s; } } as any;
  assert.equal(await run(['--source', 'C:/nowhere'], io, 'win32'), 0);
  assert.match(out, /Kora-Setup-\*\.exe/);
  assert.ok(out.includes(RELEASES_URL));
  assert.match(out, /update themselves/);
  assert.doesNotMatch(out, /install\.sh|bash/);
  assert.equal(err, '');
});
