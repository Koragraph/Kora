import test from 'node:test';
import assert from 'node:assert/strict';
import { Money, Customer, Invoice, LineItem, TaxRule, Ledger, Discount, Payment, allocatePayment, agingReport, ValidationError, createCreditNote as fromIndex } from '../src/index.js';
import { createCreditNote } from '../src/credit-note.js';

const customer = new Customer({ id: 'c1', name: 'Acme', terms: 'net-30' });
const vat = new TaxRule({ name: 'VAT', rate: 0.2 });

function invoice({ tax = true, discount = null } = {}) {
  const inv = new Invoice({ id: 'inv-1', customer, issuedAt: '2025-01-02', discount });
  inv.addLine(new LineItem({ description: 'Work', unitPrice: Money.of(10000), taxRule: tax ? vat : null }));
  return inv;
}

test('the function is exported from the package index', () => {
  assert.equal(fromIndex, createCreditNote);
});

test('createCreditNote returns the note and records it on the invoice', () => {
  const inv = invoice();
  assert.deepEqual(inv.creditNotes, []);
  const note = createCreditNote(inv, { amount: Money.of(3000), reason: 'damaged goods', issuedAt: '2025-02-01' });
  assert.equal(typeof note.id, 'string');
  assert.equal(note.invoiceId, 'inv-1');
  assert.ok(note.amount.equals(Money.of(3000)));
  assert.equal(note.reason, 'damaged goods');
  assert.equal(note.issuedAt, '2025-02-01');
  assert.equal(inv.creditNotes.length, 1);
  assert.equal(inv.creditNotes[0], note);
});

test('credit notes reduce the balance, together with payments', () => {
  const inv = invoice();
  assert.equal(inv.balance().cents, 12000);
  inv.applyPayment(Money.of(2000));
  createCreditNote(inv, { amount: Money.of(3000), issuedAt: '2025-02-01' });
  assert.equal(inv.balance().cents, 7000);
  createCreditNote(inv, { amount: Money.of(7000), issuedAt: '2025-02-02' });
  assert.ok(inv.balance().isZero());
  assert.equal(inv.status(), 'paid');
});

test('invalid credit notes are rejected with ValidationError and leave the invoice alone', () => {
  const inv = invoice();
  for (const amount of [Money.of(0), Money.of(-100), Money.of(500, 'EUR'), Money.of(12001)]) {
    assert.throws(() => createCreditNote(inv, { amount, issuedAt: '2025-02-01' }), ValidationError);
  }
  assert.deepEqual(inv.creditNotes, []);
  assert.equal(inv.balance().cents, 12000);
});

test('the sum of several notes cannot exceed the balance either', () => {
  const inv = invoice();
  createCreditNote(inv, { amount: Money.of(7000), issuedAt: '2025-02-01' });
  assert.throws(() => createCreditNote(inv, { amount: Money.of(6000), issuedAt: '2025-02-02' }), ValidationError);
  assert.equal(inv.creditNotes.length, 1);
});

test('payments cannot exceed the balance that remains after credit notes', () => {
  const inv = invoice();
  createCreditNote(inv, { amount: Money.of(10000), issuedAt: '2025-02-01' });
  assert.throws(() => inv.applyPayment(Money.of(3000)));
  inv.applyPayment(Money.of(2000));
  assert.ok(inv.balance().isZero());
});

test('the ledger entry reverses revenue and tax in proportion and balances', () => {
  const inv = invoice();
  const ledger = new Ledger();
  ledger.postInvoice(inv);
  const note = createCreditNote(inv, { amount: Money.of(6000), issuedAt: '2025-02-01' });
  const entry = ledger.postCreditNote(note, inv);
  assert.equal(entry.date, '2025-02-01');
  assert.equal(ledger.balanceOf('receivable').cents, 6000);
  assert.equal(ledger.balanceOf('revenue').cents, -5000);
  assert.equal(ledger.balanceOf('tax-payable').cents, -1000);
  assert.ok(ledger.trialBalance().balanced);
});

test('an amount that does not divide evenly is split with Money.allocate([tax, net])', () => {
  const inv = invoice();
  const ledger = new Ledger();
  ledger.postInvoice(inv);
  ledger.postCreditNote(createCreditNote(inv, { amount: Money.of(3333), issuedAt: '2025-02-01' }), inv);
  assert.equal(ledger.balanceOf('tax-payable').cents, -2000 + 556);
  assert.equal(ledger.balanceOf('revenue').cents, -10000 + 2777);
  assert.equal(ledger.balanceOf('receivable').cents, 12000 - 3333);
  assert.ok(ledger.trialBalance().balanced);
});

test('an invoice without tax posts no tax-payable line', () => {
  const inv = invoice({ tax: false });
  const ledger = new Ledger();
  ledger.postInvoice(inv);
  const entry = ledger.postCreditNote(createCreditNote(inv, { amount: Money.of(2500), issuedAt: '2025-02-01' }), inv);
  assert.ok(!entry.lines.some((l) => l.account === 'tax-payable'));
  assert.equal(ledger.balanceOf('revenue').cents, -7500);
  assert.ok(ledger.trialBalance().balanced);
});

test('a discounted invoice uses its own net and tax totals', () => {
  const inv = invoice({ discount: Discount.percent(50) }); // net 5000, tax 1000, total 6000
  const ledger = new Ledger();
  ledger.postInvoice(inv);
  ledger.postCreditNote(createCreditNote(inv, { amount: Money.of(3000), issuedAt: '2025-02-01' }), inv);
  assert.equal(ledger.balanceOf('revenue').cents, -5000 + 2500);
  assert.equal(ledger.balanceOf('tax-payable').cents, -1000 + 500);
});

test('the aging report uses the reduced balance', () => {
  const inv = invoice();
  createCreditNote(inv, { amount: Money.of(5000), issuedAt: '2025-02-01' });
  const report = agingReport([inv], '2025-06-01');
  assert.equal(report['90+'].cents, 7000);
});

test('payments allocated after a credit note respect the new balance', () => {
  const inv = invoice();
  createCreditNote(inv, { amount: Money.of(2000), issuedAt: '2025-02-01' });
  const payment = new Payment({ amount: Money.of(10000), receivedAt: '2025-03-01' });
  const ledger = new Ledger();
  ledger.postPayment(payment, allocatePayment(payment, [inv]));
  assert.ok(inv.balance().isZero());
});
