import { ValidationError } from './errors.js';

const DECIMALS = { USD: 2, EUR: 2, GBP: 2, INR: 2, JPY: 0, KWD: 3 };

export function decimalsFor(currency) {
  if (!(currency in DECIMALS)) throw new ValidationError(`unknown currency ${currency}`);
  return DECIMALS[currency];
}

export function knownCurrencies() {
  return Object.keys(DECIMALS);
}

// rates: { 'USD/EUR': 0.92, ... } meaning 1 USD = 0.92 EUR
export function convert(money, to, rates) {
  if (money.currency === to) return money;
  const rate = rates[`${money.currency}/${to}`];
  if (!rate) throw new ValidationError(`no rate for ${money.currency}/${to}`);
  const scale = 10 ** (decimalsFor(to) - decimalsFor(money.currency));
  return money.constructor.of(Math.round(money.cents * rate * scale), to);
}
