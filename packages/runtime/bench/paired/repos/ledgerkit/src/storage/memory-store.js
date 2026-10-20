export class MemoryStore {
  constructor() {
    this.invoices = new Map();
  }

  save(invoice) {
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  get(id) {
    return this.invoices.get(id) ?? null;
  }

  list(filter = () => true) {
    return [...this.invoices.values()].filter(filter);
  }

  openInvoicesFor(customerId) {
    return this.list((inv) => inv.customer.id === customerId && !inv.balance().isZero());
  }
}
