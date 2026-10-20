import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { prorate, firstPeriodCharge, refundForUnusedDays } from '../src/proration.js';
import { RecurringSchedule } from '../src/recurring.js';
import { reminderStage, remindersDue } from '../src/reminders.js';
import { buildStatement } from '../src/statement.js';
import { revenueByMonth } from '../src/reports/revenue.js';
import { taxSummary } from '../src/reports/tax.js';
import { importInvoices } from '../src/import/csv-import.js';
import { TaxRule } from '../src/tax.js';

const customer = new Customer({ id: 'c1', name: 'Acme' });
const line = (cents, taxRule = null) => new LineItem({ description: 'x', unitPrice: Money.of(cents), taxRule });

test('prorate rounds to the cent and clamps', () => {
  assert.equal(prorate(Money.of(3000), 10, 30).cents, 1000);
  assert.equal(prorate(Money.of(3000), 99, 30).cents, 3000);
});

test('first period charge counts inclusive days', () => {
  assert.equal(firstPeriodCharge(Money.of(3100), '2025-03-22', '2025-03-01', '2025-03-31').cents, 1000);
});

test('refund for unused days', () => {
  assert.equal(refundForUnusedDays(Money.of(3000), 10, 30).cents, 2000);
});

test('monthly schedule clamps to the end of short months', () => {
  const s = new RecurringSchedule({ customer, lines: [line(100)], startsOn: '2025-01-31' });
  assert.deepEqual(s.issueDates('2025-04-30'), ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30']);
});

test('weekly schedule generates invoices', () => {
  const s = new RecurringSchedule({ customer, lines: [line(100)], interval: 'weekly', startsOn: '2025-03-03', endsOn: '2025-03-17' });
  assert.equal(s.generate('2025-12-31').length, 3);
});

test('reminder stages', () => {
  assert.equal(reminderStage(0), null);
  assert.equal(reminderStage(7), 'friendly');
  assert.equal(reminderStage(30), 'firm');
  assert.equal(reminderStage(80), 'final');
});

test('remindersDue skips settled invoices', () => {
  const open = new Invoice({ id: 'a', customer, issuedAt: '2025-01-02', lines: [line(100)] });
  const paid = new Invoice({ id: 'b', customer, issuedAt: '2025-01-02', lines: [line(100)] });
  paid.applyPayment(Money.of(100));
  assert.deepEqual(remindersDue([open, paid], '2025-02-10').map((r) => r.invoice.id), ['a']);
});

test('statement keeps a running balance in date order', () => {
  const a = new Invoice({ id: 'a', customer, issuedAt: '2025-02-01', lines: [line(500)] });
  const b = new Invoice({ id: 'b', customer, issuedAt: '2025-01-01', lines: [line(300)] });
  assert.deepEqual(buildStatement(customer, [a, b]).map((r) => r.balance.cents), [300, 800]);
});

test('revenue by month sums net totals', () => {
  const a = new Invoice({ id: 'a', customer, issuedAt: '2025-01-05', lines: [line(500)] });
  const b = new Invoice({ id: 'b', customer, issuedAt: '2025-01-20', lines: [line(300)] });
  assert.deepEqual(revenueByMonth([a, b]).map((r) => [r.month, r.amount.cents]), [['2025-01', 800]]);
});

test('tax summary groups by rule name and honours the period', () => {
  const vat = new TaxRule({ name: 'VAT', rate: 0.2 });
  const a = new Invoice({ id: 'a', customer, issuedAt: '2025-01-05', lines: [line(1000, vat)] });
  const b = new Invoice({ id: 'b', customer, issuedAt: '2025-03-05', lines: [line(1000, vat)] });
  assert.equal(taxSummary([a, b], '2025-01-01', '2025-01-31').get('VAT').cents, 200);
});

test('csv import groups rows into invoices', () => {
  const csv = 'invoice_id,customer_id,issued_at,description,unit_cents,quantity\ni1,c1,2025-01-01,"Widget, large",500,2\ni1,c1,2025-01-01,Gadget,100,1\ni2,c2,2025-01-02,Thing,900,1\n';
  const invoices = importInvoices(csv);
  assert.equal(invoices.length, 2);
  assert.equal(invoices[0].total().cents, 1100);
});
