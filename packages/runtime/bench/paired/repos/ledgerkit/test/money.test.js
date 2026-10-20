import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { CurrencyMismatchError } from '../src/errors.js';

test('add and sub keep the currency', () => {
  const a = Money.of(1050);
  assert.equal(a.add(Money.of(250)).cents, 1300);
  assert.equal(a.sub(Money.of(1100)).cents, -50);
});

test('currency mismatch throws', () => {
  assert.throws(() => Money.of(100, 'USD').add(Money.of(100, 'EUR')), CurrencyMismatchError);
});

test('mul rounds half away from zero', () => {
  assert.equal(Money.of(105).mul(0.5).cents, 53);
  assert.equal(Money.of(-105).mul(0.5).cents, -53);
});

test('fromDecimal respects currency decimals', () => {
  assert.equal(Money.fromDecimal(12.34).cents, 1234);
  assert.equal(Money.fromDecimal(500, 'JPY').cents, 500);
  assert.equal(Money.fromDecimal(1.234, 'KWD').cents, 1234);
});

test('allocate splits evenly when divisible', () => {
  assert.deepEqual(Money.of(1000).allocate([1, 1]).map((m) => m.cents), [500, 500]);
});

test('allocate follows the ratios', () => {
  assert.deepEqual(Money.of(1000).allocate([1, 1, 2]).map((m) => m.cents), [250, 250, 500]);
});

test('compare and equals', () => {
  assert.equal(Money.of(5).compare(Money.of(7)), -1);
  assert.ok(Money.of(5).equals(Money.of(5)));
  assert.ok(!Money.of(5).equals(Money.of(5, 'EUR')));
});

test('toString formats with symbol and grouping', () => {
  assert.equal(Money.of(123456789).toString(), '$1,234,567.89');
  assert.equal(Money.of(-5).toString(), '-$0.05');
  assert.equal(Money.of(1500, 'JPY').toString(), '¥1,500');
});
