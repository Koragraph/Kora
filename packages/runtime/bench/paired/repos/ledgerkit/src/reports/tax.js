import { Money } from '../money.js';

// Tax collected per rule name, for a filing period [from, to] (inclusive ISO dates).
export function taxSummary(invoices, from, to, currency = 'USD') {
  const out = new Map();
  for (const invoice of invoices) {
    if (invoice.issuedAt < from || invoice.issuedAt > to) continue;
    const ratio = invoice.subtotal().isZero() ? 0 : invoice.netTotal().cents / invoice.subtotal().cents;
    for (const line of invoice.lines) {
      if (!line.taxRule) continue;
      const tax = line.net.mul(ratio).mul(line.taxRule.rate);
      out.set(line.taxRule.name, (out.get(line.taxRule.name) ?? Money.zero(currency)).add(tax));
    }
  }
  return out;
}
