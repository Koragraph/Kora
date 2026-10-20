export class LedgerkitError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends LedgerkitError {}

export class CurrencyMismatchError extends LedgerkitError {
  constructor(a, b) {
    super(`currency mismatch: ${a} vs ${b}`);
    this.currencies = [a, b];
  }
}

export class LedgerImbalanceError extends LedgerkitError {
  constructor(debits, credits) {
    super(`entry out of balance: debits ${debits} vs credits ${credits}`);
    this.debits = debits;
    this.credits = credits;
  }
}
