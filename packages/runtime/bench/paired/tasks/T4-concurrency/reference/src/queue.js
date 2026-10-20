export class Queue {
  constructor({ name = 'default', concurrency = 1 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
    this.name = name;
    this.concurrency = concurrency;
    this.items = [];
    this.seq = 0;
  }

  push(job, runAt = 0) {
    this.items.push({ job, runAt, seq: this.seq++ });
    this.items.sort((a, b) => b.job.priority - a.job.priority || a.runAt - b.runAt || a.seq - b.seq);
    return this;
  }

  // The first job that is due at `now` (highest priority first), removed from the queue.
  pop(now) {
    const index = this.items.findIndex((item) => item.runAt <= now);
    if (index < 0) return null;
    return this.items.splice(index, 1)[0].job;
  }

  peek(now) {
    return this.items.find((item) => item.runAt <= now)?.job ?? null;
  }

  size() {
    return this.items.length;
  }

  readyCount(now) {
    return this.items.filter((item) => item.runAt <= now).length;
  }

  remove(id) {
    const index = this.items.findIndex((item) => item.job.id === id);
    if (index < 0) return null;
    return this.items.splice(index, 1)[0].job;
  }

  clear() {
    this.items = [];
  }

  snapshot() {
    return this.items.map((item) => ({ id: item.job.id, type: item.job.type, runAt: item.runAt, priority: item.job.priority }));
  }
}
