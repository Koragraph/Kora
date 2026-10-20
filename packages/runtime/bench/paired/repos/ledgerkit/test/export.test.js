import test from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.js';
import { Customer } from '../src/customer.js';
import { Invoice, LineItem } from '../src/invoice.js';
import { invoicesToCsv } from '../src/export/csv.js';
import { invoicesToJson } from '../src/export/json.js';

const customer = new Customer({ id: 'c1', name: 'Acme, Inc.' });
const inv = new Invoice({ id: 'inv-1', customer, issuedAt: '2025-03-03', lines: [new LineItem({ description: 'x', unitPrice: Money.of(1234) })] });

test('csv quotes cells with commas', () => {
  const csv = invoicesToCsv([inv], '2025-03-04');
  assert.match(csv, /"Acme, Inc."/);
  assert.match(csv.split('\n')[0], /^id,customer,issued,due,total,paid,balance,status$/);
});

test('json carries cents and status', () => {
  const [row] = JSON.parse(invoicesToJson([inv]));
  assert.equal(row.totalCents, 1234);
  assert.equal(row.status, 'open');
});
