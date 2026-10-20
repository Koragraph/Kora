import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { agingReport } from '../src/aging.js';
import { remindersDue } from '../src/reminders.js';
import { ValidationError } from '../src/errors.js';

const customer = new Customer({ id: 'c1', name: 'Acme', terms: 'net-30' });
const inv = new Invoice({ id: 'a', customer, issuedAt: '2025-01-02', lines: [new LineItem({ description: 'x', unitPrice: Money.of(1000) })] });

test('daysOverdue subtracts the grace days', () => {
  assert.equal(inv.daysOverdue('2025-03-10', 0), 35);
  assert.equal(inv.daysOverdue('2025-03-10', 5), 30);
  assert.equal(inv.daysOverdue('2025-02-04', 5), 0);
});

test('graceDays is required and must be a non-negative integer', () => {
  assert.throws(() => inv.daysOverdue('2025-03-10'), ValidationError);
  assert.throws(() => inv.daysOverdue('2025-03-10', -1), ValidationError);
  assert.throws(() => inv.daysOverdue('2025-03-10', 1.5), ValidationError);
});

test('aging and reminders honour grace', () => {
  assert.equal(agingReport([inv], '2025-03-10')['31-60'].cents, 1000);
  assert.equal(agingReport([inv], '2025-03-10', 'USD', { graceDays: 5 })['1-30'].cents, 1000);
  assert.equal(remindersDue([inv], '2025-03-10', { graceDays: 5 })[0].stage, 'firm');
});
