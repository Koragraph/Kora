const COLUMNS = ['id', 'customer', 'issued', 'due', 'total', 'paid', 'balance', 'status'];

function cell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function invoicesToCsv(invoices, asOf = null) {
  const rows = invoices.map((inv) => [
    inv.id,
    inv.customer.name,
    inv.issuedAt,
    inv.dueDate().toISOString().slice(0, 10),
    inv.total().toDecimal().toFixed(2),
    inv.paid().toDecimal().toFixed(2),
    inv.balance().toDecimal().toFixed(2),
    inv.status(asOf),
  ]);
  return [COLUMNS, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
