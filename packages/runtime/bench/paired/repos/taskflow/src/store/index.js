import { MemoryStore } from './memory.js';
import { FileStore } from './file.js';

export function createStore(kind = 'memory', options = {}) {
  if (kind === 'memory') return new MemoryStore();
  if (kind === 'file') return new FileStore(options.file);
  throw new Error(`unknown store kind "${kind}"`);
}

export { MemoryStore, FileStore };
