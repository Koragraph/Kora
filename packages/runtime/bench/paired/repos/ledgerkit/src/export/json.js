export function invoiceToJson(invoice, asOf = null) {
  return {
    id: invoice.id,
    customer: invoice.customer.id,
    issuedAt: invoice.issuedAt,
    dueDate: invoice.dueDate().toISOString().slice(0, 10),
    currency: invoice.currency,
    totalCents: invoice.total().cents,
    paidCents: invoice.paid().cents,
    balanceCents: invoice.balance().cents,
    status: invoice.status(asOf),
  };
}

export function invoicesToJson(invoices, asOf = null) {
  return JSON.stringify(invoices.map((i) => invoiceToJson(i, asOf)), null, 2);
}
