import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { TaxRule, computeTax, splitInclusive } from '../src/tax.js';
import { ValidationError } from '../src/errors.js';

test('exclusive tax is net times rate', () => {
  assert.equal(computeTax(Money.of(10000), new TaxRule({ name: 'VAT', rate: 0.2 })).cents, 2000);
});

test('inclusive rules refuse computeTax', () => {
  assert.throws(() => computeTax(Money.of(100), new TaxRule({ name: 'GST', rate: 0.1, inclusive: true })), ValidationError);
});

test('rate must be below 100%', () => {
  assert.throws(() => new TaxRule({ name: 'bad', rate: 1 }), ValidationError);
});

test('splitInclusive: net + tax equals gross', () => {
  const { net, tax } = splitInclusive(Money.of(11900), new TaxRule({ name: 'VAT', rate: 0.19, inclusive: true }));
  assert.equal(net.cents, 10000);
  assert.equal(tax.cents, 1900);
});

test('splitInclusive rounds to the nearest cent', () => {
  const { net, tax } = splitInclusive(Money.of(11200), new TaxRule({ name: 'VAT', rate: 0.12, inclusive: true }));
  assert.equal(net.cents, 10000);
  assert.equal(tax.cents, 1200);
});
