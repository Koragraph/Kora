const RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

function parseField(field, [min, max]) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    let from = min;
    let to = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      from = a;
      to = b ?? (stepText ? max : a);
    }
    if (Number.isNaN(from) || Number.isNaN(to) || from < min || to > max || step < 1) throw new Error(`bad cron field "${field}"`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression needs 5 fields, got ${fields.length}`);
  return fields.map((f, i) => parseField(f, RANGES[i]));
}

// Next UTC minute strictly after `fromMs` that matches the expression.
export function nextRun(expr, fromMs) {
  const [minutes, hours, days, months, weekdays] = parseCron(expr);
  const start = new Date(fromMs);
  start.setUTCSeconds(0, 0);
  let t = start.getTime() + 60_000;
  for (let i = 0; i < 366 * 24 * 60; i++, t += 60_000) {
    const d = new Date(t);
    if (minutes.has(d.getUTCMinutes()) && hours.has(d.getUTCHours()) && days.has(d.getUTCDate()) && months.has(d.getUTCMonth() + 1) && weekdays.has(d.getUTCDay())) return t;
  }
  throw new Error(`no run found within a year for "${expr}"`);
}
