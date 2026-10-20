import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { validateInvoice, assertValidInvoice } from '../src/validators.js';
import { createStore } from '../src/storage/index.js';

const customer = new Customer({ id: 'c1', name: 'Acme' });

test('an empty invoice has problems', () => {
  assert.deepEqual(validateInvoice(new Invoice({ id: 'x', customer, issuedAt: '2025-01-01' })), ['no lines']);
});

test('assertValidInvoice throws with the problems listed', () => {
  assert.throws(() => assertValidInvoice(new Invoice({ id: 'x', customer, issuedAt: '2025-01-01' })), /no lines/);
});

test('the store finds open invoices per customer', () => {
  const store = createStore();
  const open = new Invoice({ id: 'a', customer, issuedAt: '2025-01-01', lines: [new LineItem({ description: 'x', unitPrice: Money.of(100) })] });
  const paid = new Invoice({ id: 'b', customer, issuedAt: '2025-01-01', lines: [new LineItem({ description: 'x', unitPrice: Money.of(100) })] });
  paid.applyPayment(Money.of(100));
  store.save(open);
  store.save(paid);
  assert.deepEqual(store.openInvoicesFor('c1').map((i) => i.id), ['a']);
});
