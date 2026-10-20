import { ValidationError } from './errors.js';
import { Money } from './money.js';

export class Discount {
  constructor(kind, value) {
    this.kind = kind;
    this.value = value;
  }

  static percent(p) {
    if (!(p >= 0 && p <= 100)) throw new ValidationError(`percent discount must be 0..100, got ${p}`);
    return new Discount('percent', p);
  }

  static fixed(amount) {
    if (!(amount instanceof Money)) throw new ValidationError('fixed discount needs a Money');
    return new Discount('fixed', amount);
  }

  // The discounted amount (never below zero).
  apply(amount) {
    if (this.kind === 'percent') return amount.mul(1 - this.value / 100);
    return amount.sub(this.value);
  }

  // How much comes off.
  amountOff(amount) {
    return amount.sub(this.apply(amount));
  }
}

export function applyDiscount(amount, discount) {
  return discount ? discount.apply(amount) : amount;
}
