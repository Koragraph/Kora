import { Customer } from '../customer.js';
import { Invoice, LineItem } from '../invoice.js';
import { Money } from '../money.js';
import { ValidationError } from '../errors.js';

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// Columns: invoice_id,customer_id,issued_at,description,unit_cents,quantity
export function importInvoices(csv) {
  const [header, ...rows] = csv.trim().split('\n');
  if (header.trim() !== 'invoice_id,customer_id,issued_at,description,unit_cents,quantity') throw new ValidationError('unexpected CSV header');
  const invoices = new Map();
  for (const row of rows) {
    const [invoiceId, customerId, issuedAt, description, unitCents, quantity] = splitCsvLine(row);
    if (!invoices.has(invoiceId)) {
      invoices.set(invoiceId, new Invoice({ id: invoiceId, customer: new Customer({ id: customerId, name: customerId }), issuedAt }));
    }
    invoices.get(invoiceId).addLine(new LineItem({ description, unitPrice: Money.of(Number(unitCents)), quantity: Number(quantity) }));
  }
  return [...invoices.values()];
}
