import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Queue, Scheduler, Job, Worker } from '../src/index.js';
import { createContext } from '../src/cli/context.js';
import { main } from '../src/cli/index.js';

const root = path.resolve(import.meta.dirname, '..');

function textFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(full));
    else if (/\.(js|md|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('Scheduler has submitJob and no longer has scheduleJob', () => {
  const scheduler = new Scheduler({ queue: new Queue() });
  assert.equal(typeof scheduler.submitJob, 'function');
  assert.equal(scheduler.scheduleJob, undefined);
  const job = scheduler.submitJob(new Job({ type: 'a' }), { delay: 5 });
  assert.equal(job.state, 'scheduled');
});

test('rescheduleJob is a different method and stays', () => {
  const scheduler = new Scheduler({ queue: new Queue() });
  assert.equal(typeof scheduler.rescheduleJob, 'function');
  const job = scheduler.submitJob(new Job({ type: 'a' }));
  job.transition('running').transition('failed');
  scheduler.rescheduleJob(job, 10);
  assert.equal(job.state, 'scheduled');
});

test('the error and log messages use the new name', () => {
  const lines = [];
  const scheduler = new Scheduler({ queue: new Queue(), logger: { info: (m) => lines.push(m), warn() {}, error() {}, debug() {} } });
  const job = scheduler.submitJob(new Job({ type: 'a' }));
  assert.match(lines[0], /^submitJob: accepted/);
  assert.throws(() => scheduler.submitJob(job), /^Error: submitJob: job .* is scheduled/);
});

test('the CLI still submits and runs jobs', async () => {
  const ctx = createContext();
  ctx.worker.register('a', async () => {});
  const lines = [];
  await main(['submit', 'a'], { ctx, out: (l) => lines.push(l) });
  await main(['worker'], { ctx, out: (l) => lines.push(l) });
  assert.deepEqual(lines.slice(-1), ['ran 1 job(s)']);
});

test('the old name is gone from source, docs and the README', () => {
  const offenders = [];
  for (const file of [...textFiles(path.join(root, 'src')), ...textFiles(path.join(root, 'docs')), path.join(root, 'README.md')]) {
    const text = fs.readFileSync(file, 'utf8');
    if (/\bscheduleJob\b/.test(text)) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, []);
});

test('the docs and CLI help name the new method', () => {
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /\bsubmitJob\b/);
  assert.match(fs.readFileSync(path.join(root, 'docs/architecture.md'), 'utf8'), /\bsubmitJob\b/);
  assert.match(fs.readFileSync(path.join(root, 'src/cli/commands/submit.js'), 'utf8'), /Scheduler\.submitJob/);
});

test('rescheduleJob is still mentioned where it was', () => {
  const worker = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8');
  const arch = fs.readFileSync(path.join(root, 'docs/architecture.md'), 'utf8');
  assert.match(worker, /rescheduleJob/);
  assert.match(arch, /rescheduleJob/);
});
