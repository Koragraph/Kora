import { ValidationError } from './errors.js';
import { Money } from './money.js';
import { applyDiscount } from './discount.js';
import { taxForLines } from './tax.js';
import { dueDateFor, parseDate, daysBetween } from './dates.js';
import { nextId } from './util/id.js';

export class LineItem {
  constructor({ description, unitPrice, quantity = 1, taxRule = null }) {
    if (!(unitPrice instanceof Money)) throw new ValidationError('unitPrice must be Money');
    if (!(quantity > 0)) throw new ValidationError('quantity must be positive');
    this.description = description;
    this.unitPrice = unitPrice;
    this.quantity = quantity;
    this.taxRule = taxRule;
  }

  get net() {
    return this.unitPrice.mul(this.quantity);
  }
}

export class Invoice {
  constructor({ id, customer, issuedAt, lines = [], discount = null, holidays = [] }) {
    this.id = id ?? nextId('inv');
    this.customer = customer;
    this.currency = customer.currency;
    this.issuedAt = issuedAt;
    this.lines = [...lines];
    this.discount = discount;
    this.holidays = holidays;
    this.payments = [];
  }

  addLine(line) {
    if (line.unitPrice.currency !== this.currency) throw new ValidationError('line currency differs from invoice currency');
    this.lines.push(line);
    return this;
  }

  subtotal() {
    return this.lines.reduce((sum, l) => sum.add(l.net), Money.zero(this.currency));
  }

  netTotal() {
    return applyDiscount(this.subtotal(), this.discount);
  }

  // Tax is computed on each line after the invoice-level discount has been spread proportionally.
  taxTotal() {
    const subtotal = this.subtotal();
    if (subtotal.isZero()) return Money.zero(this.currency);
    const ratio = this.netTotal().cents / subtotal.cents;
    return taxForLines(this.lines, ratio) ?? Money.zero(this.currency);
  }

  total() {
    return this.netTotal().add(this.taxTotal());
  }

  paid() {
    return this.payments.reduce((sum, p) => sum.add(p), Money.zero(this.currency));
  }

  balance() {
    return this.total().sub(this.paid());
  }

  applyPayment(amount) {
    if (amount.isNegative() || amount.isZero()) throw new ValidationError('payment must be positive');
    if (amount.compare(this.balance()) > 0) throw new ValidationError('payment exceeds invoice balance');
    this.payments.push(amount);
    return this;
  }

  dueDate() {
    return dueDateFor(this.issuedAt, this.customer.terms, { holidays: this.holidays });
  }

  daysOverdue(asOf) {
    return Math.max(0, daysBetween(this.dueDate(), parseDate(asOf)));
  }

  status(asOf = null) {
    if (this.lines.length === 0) return 'draft';
    if (this.balance().isZero()) return 'paid';
    if (asOf && this.daysOverdue(asOf) > 0) return 'overdue';
    return 'open';
  }
}
