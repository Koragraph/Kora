import { Invoice } from './invoice.js';
import { addDays, parseDate, toISODate } from './dates.js';
import { ValidationError } from './errors.js';

const INTERVALS = { weekly: 7, biweekly: 14 };

function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export class RecurringSchedule {
  constructor({ customer, lines, interval = 'monthly', startsOn, endsOn = null }) {
    if (interval !== 'monthly' && !(interval in INTERVALS)) throw new ValidationError(`unknown interval ${interval}`);
    this.customer = customer;
    this.lines = lines;
    this.interval = interval;
    this.startsOn = startsOn;
    this.endsOn = endsOn;
  }

  issueDates(throughDate) {
    const out = [];
    const limit = parseDate(this.endsOn && this.endsOn < throughDate ? this.endsOn : throughDate);
    let current = parseDate(this.startsOn);
    let n = 0;
    while (current <= limit) {
      out.push(toISODate(current));
      n += 1;
      current = this.interval === 'monthly' ? addMonths(parseDate(this.startsOn), n) : addDays(parseDate(this.startsOn), n * INTERVALS[this.interval]);
    }
    return out;
  }

  generate(throughDate, idPrefix = 'rec') {
    return this.issueDates(throughDate).map((date, i) => {
      const invoice = new Invoice({ id: `${idPrefix}-${i + 1}`, customer: this.customer, issuedAt: date });
      for (const line of this.lines) invoice.addLine(line);
      return invoice;
    });
  }
}
