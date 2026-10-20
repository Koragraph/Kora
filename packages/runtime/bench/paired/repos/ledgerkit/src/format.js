import { decimalsFor } from './currency.js';

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', KWD: 'KD ' };

export function formatMoney(money, { symbol = true } = {}) {
  const decimals = decimalsFor(money.currency);
  const abs = Math.abs(money.cents);
  const whole = Math.floor(abs / 10 ** decimals);
  const frac = decimals ? String(abs % 10 ** decimals).padStart(decimals, '0') : '';
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = money.cents < 0 ? '-' : '';
  const prefix = symbol ? SYMBOLS[money.currency] ?? '' : '';
  return `${sign}${prefix}${grouped}${decimals ? '.' + frac : ''}`;
}
