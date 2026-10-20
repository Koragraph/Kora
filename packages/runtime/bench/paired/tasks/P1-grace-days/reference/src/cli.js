#!/usr/bin/env node
import fs from 'node:fs';
import { Customer } from './customer.js';
import { Invoice, LineItem } from './invoice.js';
import { Money } from './money.js';
import { TaxRule } from './tax.js';
import { agingReport } from './aging.js';
import { invoicesToCsv } from './export/csv.js';

function loadInvoices(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw.map((r) => {
    const customer = new Customer({ id: r.customer, name: r.customer, terms: r.terms ?? 'net-30' });
    const invoice = new Invoice({ id: r.id, customer, issuedAt: r.issuedAt });
    for (const l of r.lines) {
      const taxRule = l.taxRate ? new TaxRule({ name: 'tax', rate: l.taxRate }) : null;
      invoice.addLine(new LineItem({ description: l.description, unitPrice: Money.of(l.cents), quantity: l.quantity ?? 1, taxRule }));
    }
    return invoice;
  });
}

const [command, file, asOf, graceArg] = process.argv.slice(2);
if (command === 'aging' && file && asOf) {
  const graceDays = graceArg === undefined ? 0 : Number(graceArg);
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    console.error(`graceDays must be a non-negative integer, got ${graceArg}`);
    process.exit(2);
  }
  const report = agingReport(loadInvoices(file), asOf, 'USD', { graceDays });
  for (const [bucket, amount] of Object.entries(report)) console.log(`${bucket.padEnd(8)} ${amount}`);
} else if (command === 'csv' && file) {
  process.stdout.write(invoicesToCsv(loadInvoices(file), asOf ?? null));
} else {
  console.error('usage: ledgerkit aging <invoices.json> <YYYY-MM-DD> [graceDays] | ledgerkit csv <invoices.json> [asOf]');
  process.exit(2);
}
