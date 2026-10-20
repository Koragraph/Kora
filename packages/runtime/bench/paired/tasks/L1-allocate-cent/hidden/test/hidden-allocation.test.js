import test from 'node:test';
import assert from 'node:assert/strict';
import { Money, Customer, Invoice, LineItem, Ledger, Payment, allocatePayment } from '../src/index.js';

const sum = (parts) => parts.reduce((s, m) => s + m.cents, 0);

test('allocate always sums to the original amount', () => {
  for (const total of [1, 2, 3, 99, 100, 10000, 10001, 12345, 99999]) {
    for (const ratios of [[1, 1, 1], [1, 2], [1, 1, 1, 1, 1, 1, 1], [3, 3, 4], [0.5, 0.25, 0.25], [1, 1], [5]]) {
      assert.equal(sum(Money.of(total).allocate(ratios)), total, `total ${total} ratios ${ratios}`);
    }
  }
});

test('leftover cents go to the earliest parts, one cent each', () => {
  assert.deepEqual(Money.of(10000).allocate([1, 1, 1]).map((m) => m.cents), [3334, 3333, 3333]);
  assert.deepEqual(Money.of(100).allocate([1, 1, 1, 1, 1, 1]).map((m) => m.cents), [17, 17, 17, 17, 16, 16]);
  assert.deepEqual(Money.of(5).allocate([1, 1]).map((m) => m.cents), [3, 2]);
});

test('negative amounts allocate symmetrically', () => {
  assert.deepEqual(Money.of(-10000).allocate([1, 1, 1]).map((m) => m.cents), [-3334, -3333, -3333]);
});

test('an even split of a payment across three invoices reaches the ledger', () => {
  const customer = new Customer({ id: 'c1', name: 'Acme' });
  const invoices = ['a', 'b', 'c'].map(
    (id) => new Invoice({ id, customer, issuedAt: '2025-03-03', lines: [new LineItem({ description: 'x', unitPrice: Money.of(5000) })] }),
  );
  const ledger = new Ledger();
  for (const inv of invoices) ledger.postInvoice(inv);
  const payment = new Payment({ id: 'p1', amount: Money.of(10000), receivedAt: '2025-03-10' });
  const allocations = allocatePayment(payment, invoices, { strategy: 'equal' });
  assert.equal(sum(allocations.map((a) => a.amount)), 10000);
  ledger.postPayment(payment, allocations);
  assert.equal(ledger.balanceOf('cash').cents, 10000);
  assert.ok(ledger.trialBalance().balanced);
  assert.equal(invoices.reduce((s, i) => s + i.paid().cents, 0), 10000);
});

test('a proportional split also keeps every cent', () => {
  const customer = new Customer({ id: 'c1', name: 'Acme' });
  const invoices = [3333, 3334, 3335].map(
    (cents, i) => new Invoice({ id: `i${i}`, customer, issuedAt: '2025-03-03', lines: [new LineItem({ description: 'x', unitPrice: Money.of(cents) })] }),
  );
  const payment = new Payment({ amount: Money.of(5000), receivedAt: '2025-03-10' });
  assert.equal(sum(allocatePayment(payment, invoices, { strategy: 'proportional' }).map((a) => a.amount)), 5000);
});
