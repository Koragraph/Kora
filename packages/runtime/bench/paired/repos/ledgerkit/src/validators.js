import { ValidationError } from './errors.js';

export function validateInvoice(invoice) {
  const problems = [];
  if (!invoice.customer) problems.push('missing customer');
  if (!invoice.issuedAt) problems.push('missing issue date');
  if (invoice.lines.length === 0) problems.push('no lines');
  for (const line of invoice.lines) {
    if (line.unitPrice.cents <= 0) problems.push(`line "${line.description}" has a non-positive price`);
  }
  return problems;
}

export function assertValidInvoice(invoice) {
  const problems = validateInvoice(invoice);
  if (problems.length) throw new ValidationError(`invalid invoice ${invoice.id}: ${problems.join('; ')}`);
  return invoice;
}
