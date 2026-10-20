import { MemoryStore } from './memory-store.js';

export function createStore(kind = 'memory') {
  if (kind === 'memory') return new MemoryStore();
  throw new Error(`unknown store kind ${kind}`);
}

export { MemoryStore };
