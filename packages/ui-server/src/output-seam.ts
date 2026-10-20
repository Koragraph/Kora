// Splices live pane output onto screen snapshots without losing or repeating a byte.
//
// Every live chunk carries `end`, its stream offset after the chunk. A snapshot taken at offset `at` already contains
// everything up to `at`, so the chunks held for it are trimmed to what lies beyond. Each snapshot request is a ticket
// with its own held chunks, so overlapping requests (a resize resync landing while the first snapshot is in flight)
// cannot release each other's output: the newest finished snapshot wins and older tickets are retired.

interface Held {
  readonly data: string;
  readonly end: number | undefined;
}

interface Ticket {
  readonly seq: number;
  readonly held: Held[];
}

export class OutputSeam {
  private tickets: Ticket[] = [];
  private seq = 0;
  private emittedSeq = 0;

  private readonly emit: (data: string) => void;

  constructor(emit: (data: string) => void) {
    this.emit = emit;
  }

  /** A snapshot is about to be taken: live output is held from now until `complete`. */
  begin(): number {
    const seq = ++this.seq;
    this.tickets.push({ seq, held: [] });
    return seq;
  }

  /** True while the ticket can still deliver (not completed, not retired by a newer snapshot). */
  isOpen(seq: number): boolean {
    return seq > this.emittedSeq && this.tickets.some((t) => t.seq === seq);
  }

  push(data: string, end: number | undefined): void {
    if (this.tickets.length === 0) {
      this.emit(data);
      return;
    }
    const chunk = { data, end };
    for (const t of this.tickets) t.held.push(chunk);
  }

  /**
   * Delivers the snapshot at offset `at`: `emitSnapshot` runs first, then the part of every held chunk it does not
   * cover. Returns false (and emits nothing) when a newer snapshot already went out, so a stale one never overwrites it.
   */
  complete(seq: number, at: number, emitSnapshot: () => void): boolean {
    const ticket = this.tickets.find((t) => t.seq === seq);
    if (!ticket || seq <= this.emittedSeq) return false;
    this.emittedSeq = seq;
    // Older tickets are superseded; newer ones keep holding for their own snapshots.
    this.tickets = this.tickets.filter((t) => t.seq > seq);
    emitSnapshot();
    for (const { data, end } of ticket.held) {
      if (end === undefined) {
        this.emit(data);
        continue;
      }
      const start = end - data.length;
      if (end <= at) continue;
      this.emit(start < at ? data.slice(at - start) : data);
    }
    return true;
  }
}
