export class MemoryStore {
  constructor() {
    this.jobs = new Map();
  }

  save(job) {
    this.jobs.set(job.id, job.toJSON());
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  all() {
    return [...this.jobs.values()];
  }

  remove(id) {
    return this.jobs.delete(id);
  }
}
