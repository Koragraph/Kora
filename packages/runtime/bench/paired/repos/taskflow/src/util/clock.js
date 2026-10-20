export const systemClock = { now: () => Date.now() };

// A clock tests can move by hand.
export class FakeClock {
  constructor(start = 0) {
    this.current = start;
  }

  now() {
    return this.current;
  }

  advance(ms) {
    this.current += ms;
    return this.current;
  }
}
