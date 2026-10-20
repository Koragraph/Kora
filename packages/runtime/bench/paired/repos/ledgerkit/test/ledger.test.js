import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { TaxRule } from '../src/tax.js';
import { Ledger } from '../src/ledger.js';
import { Payment, allocatePayment } from '../src/payment.js';
import { LedgerImbalanceError } from '../src/errors.js';

const customer = new Customer({ id: 'c1', name: 'Acme' });
const vat = new TaxRule({ name: 'VAT', rate: 0.2 });

function invoice() {
  const inv = new Invoice({ id: 'inv-1', customer, issuedAt: '2025-03-03' });
  inv.addLine(new LineItem({ description: 'Work', unitPrice: Money.of(10000), taxRule: vat }));
  return inv;
}

test('posting an invoice debits receivable and credits revenue and tax', () => {
  const ledger = new Ledger();
  ledger.postInvoice(invoice());
  assert.equal(ledger.balanceOf('receivable').cents, 12000);
  assert.equal(ledger.balanceOf('revenue').cents, -10000);
  assert.equal(ledger.balanceOf('tax-payable').cents, -2000);
  assert.ok(ledger.trialBalance().balanced);
});

test('an unbalanced entry is rejected', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.post({ date: '2025-01-01', lines: [{ account: 'cash', debit: Money.of(100) }, { account: 'revenue', credit: Money.of(99) }] }),
    LedgerImbalanceError,
  );
});

test('posting a payment moves cash and clears receivable', () => {
  const ledger = new Ledger();
  const inv = invoice();
  ledger.postInvoice(inv);
  const payment = new Payment({ amount: Money.of(12000), receivedAt: '2025-03-10' });
  ledger.postPayment(payment, allocatePayment(payment, [inv]));
  assert.equal(ledger.balanceOf('cash').cents, 12000);
  assert.equal(ledger.balanceOf('receivable').cents, 0);
  assert.ok(inv.balance().isZero());
});

test('an entry needs two lines', () => {
  assert.throws(() => new Ledger().post({ date: '2025-01-01', lines: [{ account: 'cash', debit: Money.of(1) }] }));
});
