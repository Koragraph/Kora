import { addDays, nextBusinessDay, parseDate } from './dates.js';

const TERMS = { 'due-on-receipt': 0, 'net-15': 15, 'net-30': 30, 'net-60': 60 };

export function termsDays(terms) {
  if (!(terms in TERMS)) throw new RangeError(`unknown payment terms ${terms}`);
  return TERMS[terms];
}

// Calendar-day terms, but a due date never lands on a weekend or holiday: it rolls forward.
export function dueDateFor(issuedAt, terms, { holidays = [] } = {}) {
  return nextBusinessDay(addDays(parseDate(issuedAt), termsDays(terms)), holidays);
}
