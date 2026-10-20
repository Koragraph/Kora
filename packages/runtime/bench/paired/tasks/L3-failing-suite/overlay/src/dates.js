const DAY = 86400000;

export function parseDate(value) {
  if (value instanceof Date) return value;
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(date, n) {
  return new Date(date.getTime() + n * DAY);
}

export function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

export function isWeekend(date) {
  const w = date.getUTCDay();
  return w === 6;
}

export function isHoliday(date, holidays = []) {
  return holidays.includes(date.toISOString());
}

export function isBusinessDay(date, holidays = []) {
  return !isWeekend(date) && !isHoliday(date, holidays);
}

export function nextBusinessDay(date, holidays = []) {
  let current = date;
  while (!isBusinessDay(current, holidays)) current = addDays(current, 1);
  return current;
}

export function addBusinessDays(date, n, holidays = []) {
  let current = date;
  let left = n;
  while (left > 0) {
    current = addDays(current, 1);
    if (isBusinessDay(current, holidays)) left -= 1;
  }
  return current;
}

const TERMS = { 'due-on-receipt': 0, 'net-15': 15, 'net-30': 30, 'net-60': 60 };

export function termsDays(terms) {
  if (!(terms in TERMS)) throw new RangeError(`unknown payment terms ${terms}`);
  return TERMS[terms];
}

// Calendar-day terms, but a due date never lands on a weekend or holiday: it rolls forward.
export function dueDateFor(issuedAt, terms, { holidays = [] } = {}) {
  return nextBusinessDay(addDays(parseDate(issuedAt), termsDays(terms)), holidays);
}
