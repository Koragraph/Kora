import { ValidationError } from './errors.js';
import { Money } from './money.js';
import { termsDays } from './terms.js';

export class Customer {
  constructor({ id, name, terms = 'net-30', currency = 'USD', creditLimit = null }) {
    if (!id) throw new ValidationError('customer id is required');
    termsDays(terms);
    this.id = id;
    this.name = name;
    this.terms = terms;
    this.currency = currency;
    this.creditLimit = creditLimit ?? Money.zero(currency);
  }

  hasCreditLimit() {
    return !this.creditLimit.isZero();
  }
}
