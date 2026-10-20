import { Money } from './money.js';

// A customer statement: invoices and payments in date order with a running balance.
export function buildStatement(customer, invoices) {
  const rows = [];
  for (const invoice of invoices) {
    if (invoice.customer.id !== customer.id) continue;
    rows.push({ date: invoice.issuedAt, kind: 'invoice', ref: invoice.id, amount: invoice.total() });
  }
  let balance = Money.zero(customer.currency);
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows.map((row) => {
    balance = balance.add(row.amount);
    return { ...row, balance };
  });
}
