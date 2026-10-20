import test from 'node:test';
import assert from 'node:assert/strict';
import { addBusinessDays, isBusinessDay, parseDate, toISODate, daysBetween } from '../src/dates.js';
import { dueDateFor } from '../src/terms.js';

test('weekends are not business days', () => {
  assert.equal(isBusinessDay(parseDate('2025-03-29')), false); // Saturday
  assert.equal(isBusinessDay(parseDate('2025-03-30')), false); // Sunday
  assert.equal(isBusinessDay(parseDate('2025-03-31')), true);
});

test('addBusinessDays skips the weekend', () => {
  assert.equal(toISODate(addBusinessDays(parseDate('2025-03-28'), 1)), '2025-03-31');
});

test('addBusinessDays skips holidays', () => {
  assert.equal(toISODate(addBusinessDays(parseDate('2025-12-24'), 1, ['2025-12-25'])), '2025-12-26');
});

test('due date rolls forward off a Sunday', () => {
  // 2025-03-28 + 30 days = 2025-04-27, a Sunday
  assert.equal(toISODate(dueDateFor('2025-03-28', 'net-30')), '2025-04-28');
});

test('due date rolls past a holiday', () => {
  assert.equal(toISODate(dueDateFor('2025-12-10', 'net-15', { holidays: ['2025-12-25'] })), '2025-12-26');
});

test('due-on-receipt is the issue date when it is a business day', () => {
  assert.equal(toISODate(dueDateFor('2025-03-03', 'due-on-receipt')), '2025-03-03');
});

test('daysBetween', () => {
  assert.equal(daysBetween(parseDate('2025-01-01'), parseDate('2025-01-31')), 30);
});
