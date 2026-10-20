import { ValidationError } from './errors.js';
import { Money } from './money.js';

export class TaxRule {
  constructor({ name, rate, inclusive = false }) {
    if (!(rate >= 0 && rate < 1)) throw new ValidationError(`tax rate must be in [0, 1), got ${rate}`);
    this.name = name;
    this.rate = rate;
    this.inclusive = inclusive;
  }
}

export function computeTax(net, rule) {
  if (rule.inclusive) throw new ValidationError('computeTax takes a net amount; use splitInclusive for inclusive rules');
  return net.mul(rule.rate);
}

// A gross amount that already contains tax → { net, tax } with net + tax === gross.
export function splitInclusive(gross, rule) {
  const net = Money.of(Math.round(gross.cents / (1 + rule.rate)), gross.currency);
  return { net, tax: gross.sub(net) };
}

export function taxForLines(lines, ratio = 1) {
  let total = null;
  for (const line of lines) {
    if (!line.taxRule) continue;
    const tax = computeTax(line.net.mul(ratio), line.taxRule);
    total = total ? total.add(tax) : tax;
  }
  return total;
}
