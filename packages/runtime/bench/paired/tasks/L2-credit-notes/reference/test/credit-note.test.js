import test from 'node:test';
import assert from 'node:assert/strict';
import { Money, Customer, Invoice, LineItem, TaxRule, Ledger, createCreditNote, ValidationError } from '../src/index.js';

const customer = new Customer({ id: 'c1', name: 'Acme' });
function invoice() {
  const inv = new Invoice({ id: 'inv-1', customer, issuedAt: '2025-01-02' });
  inv.addLine(new LineItem({ description: 'Work', unitPrice: Money.of(10000), taxRule: new TaxRule({ name: 'VAT', rate: 0.2 }) }));
  return inv;
}

test('a credit note reduces the balance', () => {
  const inv = invoice();
  createCreditNote(inv, { amount: Money.of(3000), reason: 'damaged', issuedAt: '2025-02-01' });
  assert.equal(inv.balance().cents, 9000);
});

test('a credit note cannot exceed the balance', () => {
  assert.throws(() => createCreditNote(invoice(), { amount: Money.of(12001), issuedAt: '2025-02-01' }), ValidationError);
});

test('the ledger entry balances and reverses revenue and tax proportionally', () => {
  const inv = invoice();
  const ledger = new Ledger();
  ledger.postInvoice(inv);
  ledger.postCreditNote(createCreditNote(inv, { amount: Money.of(6000), issuedAt: '2025-02-01' }), inv);
  assert.equal(ledger.balanceOf('receivable').cents, 6000);
  assert.equal(ledger.balanceOf('revenue').cents, -5000);
  assert.equal(ledger.balanceOf('tax-payable').cents, -1000);
  assert.ok(ledger.trialBalance().balanced);
});
