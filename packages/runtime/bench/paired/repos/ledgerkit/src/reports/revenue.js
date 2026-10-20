import { Money } from '../money.js';

// Net revenue per month (YYYY-MM) from issued invoices.
export function revenueByMonth(invoices, currency = 'USD') {
  const out = new Map();
  for (const invoice of invoices) {
    const month = invoice.issuedAt.slice(0, 7);
    out.set(month, (out.get(month) ?? Money.zero(currency)).add(invoice.netTotal()));
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, amount]) => ({ month, amount }));
}

export function revenueByCustomer(invoices, currency = 'USD') {
  const out = new Map();
  for (const invoice of invoices) {
    const id = invoice.customer.id;
    out.set(id, (out.get(id) ?? Money.zero(currency)).add(invoice.netTotal()));
  }
  return out;
}
