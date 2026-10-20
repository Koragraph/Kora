import { nextId } from './util/id.js';

const TRANSITIONS = {
  pending: ['scheduled', 'cancelled'],
  scheduled: ['running', 'cancelled'],
  running: ['succeeded', 'failed'],
  failed: ['scheduled', 'dead'],
  succeeded: [],
  dead: [],
  cancelled: [],
};

export class Job {
  constructor({ id, type, payload = {}, priority = 0, maxAttempts = null, key = null }) {
    this.id = id ?? nextId('job');
    this.type = type;
    this.payload = payload;
    this.priority = priority;
    this.maxAttempts = maxAttempts;
    this.key = key;
    this.state = 'pending';
    this.attempts = 0;
    this.runAt = null;
    this.lastError = null;
  }

  transition(to) {
    if (!TRANSITIONS[this.state].includes(to)) throw new Error(`illegal job transition ${this.state} -> ${to} (${this.id})`);
    this.state = to;
    return this;
  }

  isTerminal() {
    return TRANSITIONS[this.state].length === 0;
  }

  toJSON() {
    const { id, type, payload, priority, maxAttempts, key, state, attempts, runAt, lastError } = this;
    return { id, type, payload, priority, maxAttempts, key, state, attempts, runAt, lastError };
  }

  static fromJSON(raw) {
    const job = new Job(raw);
    Object.assign(job, { state: raw.state, attempts: raw.attempts, runAt: raw.runAt, lastError: raw.lastError });
    return job;
  }
}
