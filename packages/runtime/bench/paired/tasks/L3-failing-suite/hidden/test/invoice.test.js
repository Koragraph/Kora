import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { TaxRule } from '../src/tax.js';
import { Discount } from '../src/discount.js';

const customer = new Customer({ id: 'c1', name: 'Acme', terms: 'net-30' });
const vat = new TaxRule({ name: 'VAT', rate: 0.2 });

function sample(extra = {}) {
  const inv = new Invoice({ id: 'inv-1', customer, issuedAt: '2025-03-03', ...extra });
  inv.addLine(new LineItem({ description: 'Consulting', unitPrice: Money.of(10000), quantity: 2, taxRule: vat }));
  inv.addLine(new LineItem({ description: 'Hosting', unitPrice: Money.of(5000), quantity: 1 }));
  return inv;
}

test('totals without discount', () => {
  const inv = sample();
  assert.equal(inv.subtotal().cents, 25000);
  assert.equal(inv.taxTotal().cents, 4000);
  assert.equal(inv.total().cents, 29000);
});

test('percent discount applies before tax', () => {
  const inv = sample({ discount: Discount.percent(10) });
  assert.equal(inv.netTotal().cents, 22500);
  assert.equal(inv.taxTotal().cents, 3600);
  assert.equal(inv.total().cents, 26100);
});

test('payments reduce the balance and cannot exceed it', () => {
  const inv = sample();
  inv.applyPayment(Money.of(9000));
  assert.equal(inv.balance().cents, 20000);
  assert.throws(() => inv.applyPayment(Money.of(25000)));
});

test('status moves from open to paid', () => {
  const inv = sample();
  assert.equal(inv.status(), 'open');
  inv.applyPayment(inv.balance());
  assert.equal(inv.status(), 'paid');
});

test('overdue after the due date', () => {
  const inv = sample();
  assert.equal(inv.status('2025-03-20'), 'open');
  assert.equal(inv.status('2025-04-20'), 'overdue');
});

test('empty invoice is a draft', () => {
  assert.equal(new Invoice({ id: 'x', customer, issuedAt: '2025-01-01' }).status(), 'draft');
});

test('line currency must match', () => {
  const inv = new Invoice({ id: 'x', customer, issuedAt: '2025-01-01' });
  assert.throws(() => inv.addLine(new LineItem({ description: 'x', unitPrice: Money.of(1, 'EUR') })));
});
