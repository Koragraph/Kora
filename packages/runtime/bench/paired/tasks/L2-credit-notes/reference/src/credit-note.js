import { ValidationError } from './errors.js';
import { Money } from './money.js';
import { nextId } from './util/id.js';

// Record a credit note against an invoice. The amount may not exceed what is still owed.
export function createCreditNote(invoice, { amount, reason = '', issuedAt }) {
  if (!(amount instanceof Money)) throw new ValidationError('credit note amount must be Money');
  if (amount.currency !== invoice.currency) throw new ValidationError('credit note currency differs from invoice currency');
  if (amount.isZero() || amount.isNegative()) throw new ValidationError('credit note amount must be positive');
  if (amount.compare(invoice.balance()) > 0) throw new ValidationError('credit note exceeds the invoice balance');
  const note = { id: nextId('cn'), invoiceId: invoice.id, amount, reason, issuedAt };
  invoice.creditNotes.push(note);
  return note;
}
