export class Emitter {
  constructor() {
    this.handlers = new Map();
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.handlers.get(event)?.delete(handler);
  }

  once(event, handler) {
    const off = this.on(event, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }

  emit(event, ...args) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
  }
}
