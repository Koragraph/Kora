import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { Discount, applyDiscount } from '../src/discount.js';

test('percent discount', () => {
  assert.equal(Discount.percent(10).apply(Money.of(20000)).cents, 18000);
});

test('percent discount must be 0..100', () => {
  assert.throws(() => Discount.percent(120));
});

test('fixed discount subtracts', () => {
  assert.equal(Discount.fixed(Money.of(500)).apply(Money.of(2000)).cents, 1500);
});

test('fixed discount larger than the amount clamps to zero', () => {
  assert.equal(Discount.fixed(Money.of(5000)).apply(Money.of(2000)).cents, 0);
});

test('amountOff', () => {
  assert.equal(Discount.percent(25).amountOff(Money.of(1000)).cents, 250);
});

test('applyDiscount tolerates no discount', () => {
  assert.equal(applyDiscount(Money.of(100), null).cents, 100);
});
