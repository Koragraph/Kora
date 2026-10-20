import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { TaxRule, splitInclusive } from '../src/tax.js';
import { Discount } from '../src/discount.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { addBusinessDays, dueDateFor, isBusinessDay, parseDate, toISODate } from '../src/dates.js';

test('a Sunday is not a business day, a Friday is', () => {
  assert.equal(isBusinessDay(parseDate('2025-06-01')), false);
  assert.equal(isBusinessDay(parseDate('2025-06-06')), true);
});

test('a holiday on a Friday is skipped', () => {
  assert.equal(toISODate(addBusinessDays(parseDate('2025-07-03'), 1, ['2025-07-04'])), '2025-07-07');
});

test('addBusinessDays spans several weekends', () => {
  assert.equal(toISODate(addBusinessDays(parseDate('2025-03-03'), 10)), '2025-03-17');
});

test('due date skips a weekend followed by a Monday holiday', () => {
  // 2025-05-02 + 30 days = 2025-06-01 (Sunday); Monday 2025-06-02 is a holiday here
  assert.equal(toISODate(dueDateFor('2025-05-02', 'net-30', { holidays: ['2025-06-02'] })), '2025-06-03');
});

test('splitInclusive keeps net + tax equal to the gross and rounds net to nearest', () => {
  for (const rate of [0.07, 0.12, 0.19, 0.2]) {
    for (let gross = 1; gross <= 1500; gross++) {
      const { net, tax } = splitInclusive(Money.of(gross), new TaxRule({ name: 'x', rate, inclusive: true }));
      assert.equal(net.cents + tax.cents, gross);
      assert.equal(net.cents, Math.round(gross / (1 + rate)));
    }
  }
});

test('a fixed discount above the subtotal makes the invoice free, never negative', () => {
  const customer = new Customer({ id: 'c1', name: 'Acme' });
  const inv = new Invoice({ id: 'i', customer, issuedAt: '2025-03-03', discount: Discount.fixed(Money.of(50000)) });
  inv.addLine(new LineItem({ description: 'x', unitPrice: Money.of(25000) }));
  assert.equal(inv.netTotal().cents, 0);
  assert.equal(inv.total().cents, 0);
});

test('a 100% discount is zero and a 0% discount changes nothing', () => {
  assert.equal(Discount.percent(100).apply(Money.of(1234)).cents, 0);
  assert.equal(Discount.percent(0).apply(Money.of(1234)).cents, 1234);
});
