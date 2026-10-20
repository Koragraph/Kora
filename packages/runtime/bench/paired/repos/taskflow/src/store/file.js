import fs from 'node:fs';
import { MemoryStore } from './memory.js';

// A MemoryStore that mirrors itself to a JSON file on every save.
export class FileStore extends MemoryStore {
  constructor(file) {
    super();
    this.file = file;
    if (fs.existsSync(file)) for (const row of JSON.parse(fs.readFileSync(file, 'utf8'))) this.jobs.set(row.id, row);
  }

  save(job) {
    super.save(job);
    fs.writeFileSync(this.file, JSON.stringify(this.all(), null, 2));
  }

  remove(id) {
    const removed = super.remove(id);
    fs.writeFileSync(this.file, JSON.stringify(this.all(), null, 2));
    return removed;
  }
}
