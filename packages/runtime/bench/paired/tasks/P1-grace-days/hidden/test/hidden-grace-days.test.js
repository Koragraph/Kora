import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Money } from '../src/money.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { agingReport } from '../src/aging.js';
import { remindersDue } from '../src/reminders.js';
import { ValidationError } from '../src/errors.js';

const customer = new Customer({ id: 'c1', name: 'Acme', terms: 'net-30' });
// issued 2025-01-02, net-30 → due Sat 2025-02-01 rolls to Mon 2025-02-03
const make = (id = 'a', cents = 1000) => new Invoice({ id, customer, issuedAt: '2025-01-02', lines: [new LineItem({ description: 'x', unitPrice: Money.of(cents) })] });

test('daysOverdue(asOf, graceDays) subtracts the grace and never goes below zero', () => {
  const inv = make();
  assert.equal(inv.daysOverdue('2025-03-10', 0), 35);
  assert.equal(inv.daysOverdue('2025-03-10', 5), 30);
  assert.equal(inv.daysOverdue('2025-02-04', 5), 0);
  assert.equal(inv.daysOverdue('2025-01-10', 0), 0);
});

test('graceDays is required and must be a non-negative integer (ValidationError)', () => {
  const inv = make();
  assert.throws(() => inv.daysOverdue('2025-03-10'), ValidationError);
  assert.throws(() => inv.daysOverdue('2025-03-10', undefined), ValidationError);
  assert.throws(() => inv.daysOverdue('2025-03-10', -1), ValidationError);
  assert.throws(() => inv.daysOverdue('2025-03-10', 2.5), ValidationError);
  assert.throws(() => inv.daysOverdue('2025-03-10', '5'), ValidationError);
});

test('status takes graceDays and defaults to 0', () => {
  const inv = make();
  assert.equal(inv.status('2025-02-06'), 'overdue');
  assert.equal(inv.status('2025-02-06', 0), 'overdue');
  assert.equal(inv.status('2025-02-06', 5), 'open');
  assert.equal(inv.status('2025-02-09', 5), 'overdue');
  assert.equal(inv.status(), 'open');
});

test('agingReport buckets by the reduced days; grace defaults to 0', () => {
  const inv = make();
  assert.equal(agingReport([inv], '2025-03-10')['31-60'].cents, 1000);
  const graced = agingReport([inv], '2025-03-10', 'USD', { graceDays: 5 });
  assert.equal(graced['1-30'].cents, 1000);
  assert.equal(graced['31-60'].cents, 0);
  assert.equal(agingReport([inv], '2025-02-06', 'USD', { graceDays: 5 })['current'].cents, 1000);
  assert.equal(agingReport([inv], '2025-03-10', 'USD', {})['31-60'].cents, 1000);
});

test('remindersDue uses the reduced days; grace defaults to 0', () => {
  const inv = make();
  assert.equal(remindersDue([inv], '2025-02-10')[0].stage, 'friendly');
  assert.deepEqual(remindersDue([inv], '2025-02-10', { graceDays: 7 }), []);
  assert.equal(remindersDue([inv], '2025-03-10', { graceDays: 5 })[0].stage, 'firm');
  assert.equal(remindersDue([inv], '2025-03-10')[0].stage, 'firm');
  assert.equal(remindersDue([inv], '2025-03-26', { graceDays: 5 })[0].stage, 'final');
  assert.equal(remindersDue([inv], '2025-03-26', { graceDays: 6 })[0].stage, 'firm');
});

const cli = new URL('../src/cli.js', import.meta.url).pathname;
function runCli(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-grace-'));
  const file = path.join(dir, 'invoices.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'a', customer: 'c1', terms: 'net-30', issuedAt: '2025-01-02', lines: [{ description: 'x', cents: 1000 }] }]));
  const r = spawnSync(process.execPath, [cli, ...args.map((a) => (a === '$FILE' ? file : a))], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('cli aging: no grace argument keeps the old buckets', () => {
  const r = runCli(['aging', '$FILE', '2025-03-10']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^31-60\s+\$10\.00$/m);
});

test('cli aging: optional fourth argument is the grace days', () => {
  const r = runCli(['aging', '$FILE', '2025-03-10', '5']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^1-30\s+\$10\.00$/m);
  assert.match(r.stdout, /^31-60\s+\$0\.00$/m);
});

test('cli aging: an invalid grace exits with code 2 and writes to stderr', () => {
  for (const bad of ['abc', '-3', '1.5']) {
    const r = runCli(['aging', '$FILE', '2025-03-10', bad]);
    assert.equal(r.status, 2, `grace ${bad}`);
    assert.ok(r.stderr.length > 0, `stderr for ${bad}`);
    assert.equal(r.stdout, '');
  }
});
