// Dunning: which overdue invoices get which reminder as of a date.
const STAGES = [
  { name: 'friendly', minDays: 1, maxDays: 14 },
  { name: 'firm', minDays: 15, maxDays: 45 },
  { name: 'final', minDays: 46, maxDays: Infinity },
];

export function reminderStage(daysOverdue) {
  return STAGES.find((s) => daysOverdue >= s.minDays && daysOverdue <= s.maxDays)?.name ?? null;
}

export function remindersDue(invoices, asOf, { graceDays = 0 } = {}) {
  const due = [];
  for (const invoice of invoices) {
    if (invoice.balance().isZero()) continue;
    const stage = reminderStage(invoice.daysOverdue(asOf, graceDays));
    if (stage) due.push({ invoice, stage });
  }
  return due;
}
