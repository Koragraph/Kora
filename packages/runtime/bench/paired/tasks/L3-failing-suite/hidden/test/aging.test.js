import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { agingReport, agingTotal } from '../src/aging.js';

const customer = new Customer({ id: 'c1', name: 'Acme', terms: 'net-30' });

function invoice(id, cents, issuedAt) {
  return new Invoice({ id, customer, issuedAt, lines: [new LineItem({ description: 'x', unitPrice: Money.of(cents) })] });
}

test('buckets by days overdue', () => {
  const invs = [invoice('a', 1000, '2025-01-27'), invoice('b', 2000, '2025-01-02'), invoice('c', 4000, '2025-03-03')];
  const report = agingReport(invs, '2025-03-10');
  assert.equal(report['current'].cents, 4000);
  assert.equal(report['1-30'].cents, 1000);
  assert.equal(report['31-60'].cents, 2000);
});

test('paid invoices do not appear', () => {
  const inv = invoice('a', 1000, '2025-01-06');
  inv.applyPayment(Money.of(1000));
  assert.equal(agingTotal(agingReport([inv], '2025-06-01')).cents, 0);
});

test('partial payments leave the remaining balance in the report', () => {
  const inv = invoice('a', 1000, '2025-01-06');
  inv.applyPayment(Money.of(400));
  assert.equal(agingTotal(agingReport([inv], '2025-06-01')).cents, 600);
});
