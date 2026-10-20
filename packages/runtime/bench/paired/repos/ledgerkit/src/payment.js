import { ValidationError } from './errors.js';
import { Money } from './money.js';
import { nextId } from './util/id.js';

export class Payment {
  constructor({ id, amount, receivedAt, method = 'bank-transfer' }) {
    if (!(amount instanceof Money) || amount.cents <= 0) throw new ValidationError('payment amount must be positive Money');
    this.id = id ?? nextId('pay');
    this.amount = amount;
    this.receivedAt = receivedAt;
    this.method = method;
  }
}

// Decide how much of `payment` goes to each invoice. Returns [{ invoice, amount }] summing to the payment.
export function allocatePayment(payment, invoices, { strategy = 'oldest-first' } = {}) {
  if (invoices.length === 0) throw new ValidationError('no invoices to allocate to');
  if (strategy === 'equal') {
    const parts = payment.amount.allocate(invoices.map(() => 1));
    return invoices.map((invoice, i) => ({ invoice, amount: parts[i] }));
  }
  if (strategy === 'proportional') {
    const parts = payment.amount.allocate(invoices.map((inv) => inv.balance().cents));
    return invoices.map((invoice, i) => ({ invoice, amount: parts[i] }));
  }
  let left = payment.amount;
  const result = [];
  const ordered = [...invoices].sort((a, b) => a.dueDate() - b.dueDate());
  for (const invoice of ordered) {
    if (left.isZero()) break;
    const take = left.min(invoice.balance());
    if (take.isZero()) continue;
    result.push({ invoice, amount: take });
    left = left.sub(take);
  }
  if (!left.isZero()) throw new ValidationError('payment exceeds the total balance of the invoices');
  return result;
}
