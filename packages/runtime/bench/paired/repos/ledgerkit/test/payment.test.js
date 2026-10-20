import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { Payment, allocatePayment } from '../src/payment.js';

const customer = new Customer({ id: 'c1', name: 'Acme' });

function invoice(id, cents, issuedAt) {
  return new Invoice({ id, customer, issuedAt, lines: [new LineItem({ description: 'x', unitPrice: Money.of(cents) })] });
}

test('oldest-first fills the earliest due date first', () => {
  const a = invoice('a', 5000, '2025-01-01');
  const b = invoice('b', 5000, '2025-02-01');
  const parts = allocatePayment(new Payment({ amount: Money.of(7000), receivedAt: '2025-03-01' }), [b, a]);
  assert.deepEqual(parts.map((p) => [p.invoice.id, p.amount.cents]), [['a', 5000], ['b', 2000]]);
});

test('equal split with a clean division', () => {
  const invs = [invoice('a', 5000, '2025-01-01'), invoice('b', 5000, '2025-01-01')];
  const parts = allocatePayment(new Payment({ amount: Money.of(6000), receivedAt: '2025-03-01' }), invs, { strategy: 'equal' });
  assert.deepEqual(parts.map((p) => p.amount.cents), [3000, 3000]);
});

test('proportional split follows balances', () => {
  const invs = [invoice('a', 1000, '2025-01-01'), invoice('b', 3000, '2025-01-01')];
  const parts = allocatePayment(new Payment({ amount: Money.of(2000), receivedAt: '2025-03-01' }), invs, { strategy: 'proportional' });
  assert.deepEqual(parts.map((p) => p.amount.cents), [500, 1500]);
});

test('over-paying the total balance is rejected', () => {
  const a = invoice('a', 1000, '2025-01-01');
  assert.throws(() => allocatePayment(new Payment({ amount: Money.of(2000), receivedAt: '2025-03-01' }), [a]));
});

test('payment must be positive', () => {
  assert.throws(() => new Payment({ amount: Money.of(0), receivedAt: '2025-03-01' }));
});
