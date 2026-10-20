// `kora trim-run` end to end: the real CLI entry (bin/kora.js) wrapping real child processes.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toolOutDir } from './bash-trim';

const KORA = path.resolve(__dirname, '..', '..', 'bin', 'kora.js');
const home = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-tr-'));

function tr(h: string, argv: string[], opts: { input?: string; cwd?: string; env?: Record<string, string>; min?: number } = {}) {
  const r = spawnSync(process.execPath, [KORA, 'trim-run', '--home', h, '--thread', 'T9', ...(opts.min !== undefined ? ['--min', String(opts.min)] : []), '--', ...argv], {
    input: opts.input, cwd: opts.cwd, env: { ...process.env, KORA_COST_LOG: '1', ...(opts.env ?? {}) }, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, signal: r.signal, out: r.stdout.toString('utf8'), err: r.stderr.toString('utf8'), outBuf: r.stdout };
}
const spills = (h: string): string[] => { try { return fs.readdirSync(toolOutDir('T9', h)).map((f) => path.join(toolOutDir('T9', h), f)); } catch { return []; } };

test('small output is replayed untouched, to the stream it came from, and the exit code is the program\'s own', () => {
  const h = home();
  const r = tr(h, ['sh', '-c', 'echo to-out; echo to-err 1>&2; exit 7']);
  assert.equal(r.code, 7);
  assert.equal(r.out, 'to-out\n');
  assert.equal(r.err, 'to-err\n');
  assert.deepEqual(spills(h), [], 'nothing spilled');
});

test('cwd, environment and stdin reach the program; a signal death reads as 128+n', () => {
  const h = home(); const cwd = fs.realpathSync(home());
  const r = tr(h, ['sh', '-c', 'pwd; echo "$KORA_TR_X"; cat'], { cwd, input: 'from-stdin\n', env: { KORA_TR_X: 'env-value' } });
  assert.equal(r.code, 0);
  assert.equal(r.out, `${cwd}\nenv-value\nfrom-stdin\n`);
  const s = tr(h, ['sh', '-c', 'kill -TERM $$']);
  assert.equal(s.code, 143);
  assert.equal(tr(h, ['definitely-not-a-program-xyz']).code, 127);
  assert.equal(tr(h, []).code, 2);
});

test('a big FAILING run is trimmed: the failure and the summary survive, the exit code stays, and the spill file is byte-identical', () => {
  const h = home();
  const script = `for (let i = 0; i < 1500; i++) console.log('✔ passing test number ' + i + ' (0.' + (i % 9) + 'ms)');
console.log('✖ the lock holder is wrong (1.2ms)');
console.log('  AssertionError [ERR_ASSERTION]: expected 3 got 4');
console.log('    at Object.<anonymous> (/work/src/lock.test.ts:41:10)');
console.log('ℹ tests 1501');
console.log('ℹ pass 1500');
console.log('ℹ fail 1');
process.exit(1);`;
  const expected = spawnSync(process.execPath, ['-e', script]).stdout.toString('utf8');
  const r = tr(h, [process.execPath, '-e', script]);
  assert.equal(r.code, 1, 'the failing exit code is preserved');
  assert.ok(r.out.length < expected.length / 5, `${r.out.length} of ${expected.length}`);
  for (const must of ['✖ the lock holder is wrong (1.2ms)', 'AssertionError [ERR_ASSERTION]: expected 3 got 4', 'lock.test.ts:41:10', 'ℹ fail 1', 'ℹ pass 1500']) assert.ok(r.out.includes(must), `kept: ${must}`);
  const file = /saved at (\S+)/.exec(r.out)?.[1];
  assert.ok(file && fs.existsSync(file), 'the footer names the spill file');
  assert.ok(file!.startsWith(toolOutDir('T9', h)));
  assert.equal(fs.readFileSync(file!, 'utf8'), expected, 'the spill file is the program\'s output, byte for byte');
  assert.equal((fs.statSync(file!).mode & 0o777).toString(8), '600');
  const rows = fs.readFileSync(path.join(h, 'cost.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].k, 'bash-trim');
  assert.match(rows[0].c, /@run$/);
  assert.ok(rows[0].saved > 1000);
});

test('stdout and stderr both land in the spill file, in arrival order', () => {
  const h = home();
  const script = `const w = (fd, s) => require('fs').writeSync(fd, s);
for (let i = 0; i < 800; i++) { w(1, 'out line ' + i + ' of the long running build log\\n'); if (i % 100 === 0) { w(2, 'warning: stderr note ' + i + '\\n'); } }
w(2, 'error TS2322: the one real failure\\n'); process.exitCode = 2;`;
  const r = tr(h, [process.execPath, '-e', script]);
  assert.equal(r.code, 2);
  assert.ok(r.out.includes('error TS2322: the one real failure'));
  const full = fs.readFileSync(/saved at (\S+)/.exec(r.out)![1]!, 'utf8');
  assert.equal(full.split('\n').filter((l) => l.startsWith('out line')).length, 800);
  assert.equal(full.split('\n').filter((l) => /^warning: stderr note/.test(l)).length, 8);
  assert.ok(full.endsWith('error TS2322: the one real failure\n'));
});

test('output the compressors cannot shrink is passed through whole; --min sets the floor', () => {
  const h = home();
  const rows = Array.from({ length: 150 }, (_, i) => `row ${i}: ${(i * 7919) % 1000} ${'abcdefghijklmnopqrstuvwxyz'.slice(i % 26)}`).join('\n') + '\n';
  const r = tr(h, [process.execPath, '-e', `process.stdout.write(${JSON.stringify(rows)})`], { min: 100 });
  assert.equal(r.out, rows, 'unrecognised and under 8k: untouched');
  assert.deepEqual(spills(h), []);
});

test('huge output (past the memory limit) is spilled as it arrives and shown as head / errors / tail', () => {
  const h = home();
  const script = `let s = ''; for (let i = 0; i < 60000; i++) { s += 'build step ' + i + ' compiling module ' + 'x'.repeat(40) + '\\n'; if (s.length > 100000) { process.stdout.write(s); s = ''; } }
process.stdout.write(s); process.stdout.write('FAILED: module 31337 does not compile\\n'); process.stdout.write('done\\n'); process.exitCode = 3;`;
  const r = tr(h, [process.execPath, '-e', script]);
  assert.equal(r.code, 3);
  assert.ok(r.out.length < 20000, `trimmed (${r.out.length})`);
  assert.ok(r.out.startsWith('build step 0 compiling module'));
  assert.ok(r.out.includes('FAILED: module 31337 does not compile'));
  assert.ok(r.out.includes('done'));
  const file = /saved at (\S+)/.exec(r.out)![1]!;
  const st = fs.statSync(file);
  assert.ok(st.size > 2_000_000, 'the file holds all of it');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('build step 0 ') && text.endsWith('FAILED: module 31337 does not compile\ndone\n'));
  assert.equal(text.split('\n').length - 1, 60002);
});
