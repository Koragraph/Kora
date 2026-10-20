import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";

const YEAR = String.raw`(?:\d{4}|[+-]\d{6})`;
const MONTH_DAY = String.raw`(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])`;
const CLOCK = String.raw`(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?|24:00(?::00(?:\.0+)?)?)`;
const OFFSET = String.raw`(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)`;
const ZONED_ISO_INSTANT = new RegExp(`^${YEAR}-${MONTH_DAY}T${CLOCK}${OFFSET}$`);

const isZonedIsoInstant = Schema.is(
  Schema.String.check(Schema.isTrimmed(), Schema.isPattern(ZONED_ISO_INSTANT)),
);

function parseTimestamp(value: string): number {
  if (!isZonedIsoInstant(value)) return NaN;

  // Engines can normalize invalid calendar dates instead of rejecting them.
  const day = value.split("T", 1)[0]!;
  const midnight = DateTime.make(day + "T00:00:00.000Z");
  if (Option.isNone(midnight)) return NaN;
  const { month, day: dayOfMonth } = DateTime.toPartsUtc(midnight.value);
  const stillSameDate = month === Number(day.slice(-5, -3)) && dayOfMonth === Number(day.slice(-2));
  return stillSameDate ? Date.parse(value) : NaN;
}

/** Compare date-time strings by absolute time, with stable handling for malformed stored values. */
export function compareDateTimeStrings(left: string, right: string): number {
  const a = parseTimestamp(left);
  const b = parseTimestamp(right);
  const aOk = a === a;
  const bOk = b === b;

  if (aOk && bOk) return a - b;
  if (aOk || bOk) return aOk ? 1 : -1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
