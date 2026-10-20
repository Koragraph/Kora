import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as terms from '../src/terms.js';
import * as dates from '../src/dates.js';
import * as index from '../src/index.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { Money } from '../src/money.js';
import { toISODate } from '../src/dates.js';

test('terms module exports termsDays and dueDateFor with the old behaviour', () => {
  assert.equal(terms.termsDays('net-30'), 30);
  assert.equal(terms.termsDays('due-on-receipt'), 0);
  assert.throws(() => terms.termsDays('net-99'), RangeError);
  assert.equal(toISODate(terms.dueDateFor('2025-03-28', 'net-30')), '2025-04-28');
  assert.equal(toISODate(terms.dueDateFor('2025-12-10', 'net-15', { holidays: ['2025-12-25'] })), '2025-12-26');
});

test('the dates module no longer defines the payment-terms functions', () => {
  assert.equal('termsDays' in dates, false);
  assert.equal('dueDateFor' in dates, false);
  for (const name of ['parseDate', 'toISODate', 'addDays', 'daysBetween', 'isWeekend', 'isHoliday', 'isBusinessDay', 'nextBusinessDay', 'addBusinessDays']) {
    assert.equal(typeof dates[name], 'function', name);
  }
});

test('no module imports the terms functions from the dates module', () => {
  const src = new URL('../src/', import.meta.url).pathname;
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(src);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']*dates\.js)'/g)) {
      assert.doesNotMatch(m[1], /\b(termsDays|dueDateFor)\b/, `${file} imports a terms function from dates.js`);
    }
    for (const m of text.matchAll(/export\s*\{([^}]*)\}\s*from\s*'([^']*dates\.js)'/g)) {
      assert.doesNotMatch(m[1], /\b(termsDays|dueDateFor)\b/, `${file} re-exports a terms function from dates.js`);
    }
  }
});

test('terms.js does not re-implement date helpers', () => {
  assert.equal(typeof terms.addDays, 'undefined');
  assert.equal(typeof terms.parseDate, 'undefined');
});

test('the public exports of the index are unchanged', () => {
  assert.deepEqual(Object.keys(index).sort(), [
    'CurrencyMismatchError', 'Customer', 'Discount', 'Invoice', 'LedgerImbalanceError', 'Ledger', 'LedgerkitError', 'LineItem', 'Money', 'MemoryStore', 'Payment', 'TaxRule', 'ValidationError',
    'addBusinessDays', 'agingReport', 'agingTotal', 'allocatePayment', 'applyDiscount', 'assertValidInvoice', 'computeTax', 'convert', 'createStore', 'decimalsFor', 'dueDateFor', 'invoicesToCsv', 'invoicesToJson',
    'isBusinessDay', 'knownCurrencies', 'nextBusinessDay', 'parseDate', 'splitInclusive', 'toISODate', 'validateInvoice',
  ].sort());
  assert.equal(index.dueDateFor, terms.dueDateFor);
});

test('customers and invoices still use the terms', () => {
  assert.throws(() => new Customer({ id: 'c', name: 'x', terms: 'net-99' }), RangeError);
  const customer = new Customer({ id: 'c', name: 'x', terms: 'net-15' });
  const inv = new Invoice({ id: 'i', customer, issuedAt: '2025-03-03', lines: [new LineItem({ description: 'x', unitPrice: Money.of(100) })] });
  assert.equal(toISODate(inv.dueDate()), '2025-03-18');
});
