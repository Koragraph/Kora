# ledgerkit

Small invoicing and double-entry ledger library. Zero dependencies, integer-cent money.

```js
import { Money, Invoice, LineItem, TaxRule, Ledger, Customer } from 'ledgerkit';

const customer = new Customer({ id: 'c1', name: 'Acme', terms: 'net-30' });
const invoice = new Invoice({ id: 'inv-1', customer, issuedAt: '2025-03-03' });
invoice.addLine(new LineItem({ description: 'Consulting', unitPrice: Money.of(10000), quantity: 2, taxRule: new TaxRule({ name: 'VAT', rate: 0.2 }) }));

const ledger = new Ledger();
ledger.postInvoice(invoice);
console.log(invoice.total().toString()); // 24000 USD cents
```

## Modules

| module | what it does |
|---|---|
| `src/money.js` | `Money` (integer cents + currency): add, sub, mul, allocate, compare |
| `src/currency.js` | currency decimals and conversion |
| `src/tax.js` | `TaxRule`, `computeTax`, `splitInclusive` |
| `src/discount.js` | percent and fixed discounts |
| `src/invoice.js` | `LineItem` and `Invoice` (totals, balance, payments, status) |
| `src/payment.js` | `Payment` and `allocatePayment` (oldest-first, proportional, equal) |
| `src/ledger.js` | double-entry `Ledger`: `post`, `postInvoice`, `postPayment`, `trialBalance` |
| `src/aging.js` | accounts-receivable aging report |
| `src/dates.js` | UTC date helpers, business days, due dates |
| `src/export/` | CSV and JSON export |

Accounts used by the ledger: `receivable`, `revenue`, `tax-payable`, `cash`.

## Conventions

- All amounts are integer cents inside `Money`; rounding happens only in `src/util/round.js`.
- Errors extend `LedgerkitError` (`src/errors.js`): `ValidationError`, `CurrencyMismatchError`, `LedgerImbalanceError`.
- Dates are `YYYY-MM-DD` strings at the edges and UTC `Date` objects inside.

## Tests

`npm test` (node's built-in runner).
