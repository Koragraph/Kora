import { Money } from './money.js';

const BUCKETS = [
  ['current', (d) => d <= 0],
  ['1-30', (d) => d >= 1 && d <= 30],
  ['31-60', (d) => d >= 31 && d <= 60],
  ['61-90', (d) => d >= 61 && d <= 90],
  ['90+', (d) => d > 90],
];

// Accounts-receivable aging: open balances grouped by how many days past due they are as of `asOf`.
export function agingReport(invoices, asOf, currency = 'USD', { graceDays = 0 } = {}) {
  const report = Object.fromEntries(BUCKETS.map(([name]) => [name, Money.zero(currency)]));
  for (const invoice of invoices) {
    const balance = invoice.balance();
    if (balance.isZero()) continue;
    const days = invoice.daysOverdue(asOf, graceDays);
    const [name] = BUCKETS.find(([, test]) => test(days));
    report[name] = report[name].add(balance);
  }
  return report;
}

export function agingTotal(report, currency = 'USD') {
  return Object.values(report).reduce((sum, m) => sum.add(m), Money.zero(currency));
}
