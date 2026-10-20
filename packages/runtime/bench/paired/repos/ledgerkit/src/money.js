import { assertInteger } from './util/assert.js';
import { roundHalfAwayFromZero } from './util/round.js';
import { CurrencyMismatchError } from './errors.js';
import { decimalsFor } from './currency.js';
import { formatMoney } from './format.js';

export class Money {
  constructor(cents, currency = 'USD') {
    assertInteger(cents, 'cents');
    this.cents = cents;
    this.currency = currency;
    Object.freeze(this);
  }

  static of(cents, currency = 'USD') {
    return new Money(cents, currency);
  }

  static zero(currency = 'USD') {
    return new Money(0, currency);
  }

  static fromDecimal(amount, currency = 'USD') {
    return new Money(roundHalfAwayFromZero(amount * 10 ** decimalsFor(currency)), currency);
  }

  #assertSame(other) {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  add(other) {
    this.#assertSame(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  sub(other) {
    this.#assertSame(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  mul(factor) {
    return new Money(roundHalfAwayFromZero(this.cents * factor), this.currency);
  }

  negate() {
    return new Money(-this.cents, this.currency);
  }

  isZero() {
    return this.cents === 0;
  }

  isNegative() {
    return this.cents < 0;
  }

  compare(other) {
    this.#assertSame(other);
    return Math.sign(this.cents - other.cents);
  }

  equals(other) {
    return this.currency === other.currency && this.cents === other.cents;
  }

  min(other) {
    return this.compare(other) <= 0 ? this : other;
  }

  max(other) {
    return this.compare(other) >= 0 ? this : other;
  }

  // Split this amount in proportion to `ratios`; the parts always sum to the original amount.
  // Leftover cents go to the earliest parts, one each.
  allocate(ratios) {
    if (!Array.isArray(ratios) || ratios.length === 0) throw new RangeError('allocate needs at least one ratio');
    const total = ratios.reduce((a, b) => a + b, 0);
    if (!(total > 0)) throw new RangeError('allocate ratios must sum to a positive number');
    const sign = this.cents < 0 ? -1 : 1;
    const abs = Math.abs(this.cents);
    let remainder = abs;
    const shares = ratios.map((r) => {
      const share = Math.floor((abs * r) / total);
      remainder -= share;
      return share;
    });
    for (let i = 0; remainder > 0; i++, remainder--) shares[i % shares.length] += 1;
    return shares.map((s) => new Money(sign * s, this.currency));
  }

  toDecimal() {
    return this.cents / 10 ** decimalsFor(this.currency);
  }

  toString() {
    return formatMoney(this);
  }
}
