import { Money } from './money.js';
import { daysBetween, parseDate } from './dates.js';

// Charge for part of a billing period: `days` of `periodDays`, rounded to the cent.
export function prorate(amount, days, periodDays) {
  if (periodDays <= 0) throw new RangeError('periodDays must be positive');
  const bounded = Math.min(Math.max(days, 0), periodDays);
  return amount.mul(bounded / periodDays);
}

// A subscription started mid-period: the first invoice covers start..periodEnd inclusive.
export function firstPeriodCharge(monthlyPrice, startDate, periodStart, periodEnd) {
  const total = daysBetween(parseDate(periodStart), parseDate(periodEnd)) + 1;
  const used = daysBetween(parseDate(startDate), parseDate(periodEnd)) + 1;
  return prorate(monthlyPrice, used, total);
}

export function refundForUnusedDays(paid, usedDays, periodDays) {
  return paid.sub(prorate(paid, usedDays, periodDays)).max(Money.zero(paid.currency));
}
