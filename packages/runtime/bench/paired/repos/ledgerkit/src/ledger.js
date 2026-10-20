import { LedgerImbalanceError, ValidationError } from './errors.js';
import { Money } from './money.js';
import { nextId } from './util/id.js';

// Double-entry ledger. Every posted entry must balance: sum(debits) === sum(credits).
export class Ledger {
  constructor({ currency = 'USD' } = {}) {
    this.currency = currency;
    this.entries = [];
  }

  post({ date, memo = '', lines }) {
    if (!Array.isArray(lines) || lines.length < 2) throw new ValidationError('an entry needs at least two lines');
    let debits = 0;
    let credits = 0;
    for (const line of lines) {
      if (line.debit) debits += line.debit.cents;
      if (line.credit) credits += line.credit.cents;
    }
    if (debits !== credits) throw new LedgerImbalanceError(debits, credits);
    const entry = { id: nextId('je'), date, memo, lines };
    this.entries.push(entry);
    return entry;
  }

  balanceOf(account) {
    let cents = 0;
    for (const entry of this.entries) {
      for (const line of entry.lines) {
        if (line.account !== account) continue;
        if (line.debit) cents += line.debit.cents;
        if (line.credit) cents -= line.credit.cents;
      }
    }
    return Money.of(cents, this.currency);
  }

  trialBalance() {
    let debits = 0;
    let credits = 0;
    for (const entry of this.entries) {
      for (const line of entry.lines) {
        if (line.debit) debits += line.debit.cents;
        if (line.credit) credits += line.credit.cents;
      }
    }
    return { debits: Money.of(debits, this.currency), credits: Money.of(credits, this.currency), balanced: debits === credits };
  }

  postInvoice(invoice) {
    const lines = [{ account: 'receivable', debit: invoice.total() }, { account: 'revenue', credit: invoice.netTotal() }];
    if (!invoice.taxTotal().isZero()) lines.push({ account: 'tax-payable', credit: invoice.taxTotal() });
    return this.post({ date: invoice.issuedAt, memo: `invoice ${invoice.id}`, lines });
  }

  // allocations: [{ invoice, amount }] as returned by allocatePayment
  postPayment(payment, allocations) {
    const applied = allocations.reduce((sum, a) => sum.add(a.amount), Money.zero(this.currency));
    const entry = this.post({
      date: payment.receivedAt,
      memo: `payment ${payment.id}`,
      lines: [{ account: 'cash', debit: payment.amount }, { account: 'receivable', credit: applied }],
    });
    for (const { invoice, amount } of allocations) invoice.applyPayment(amount);
    return entry;
  }
}
