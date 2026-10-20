import type { AtomActionResult } from "@kora/client-runtime/store/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly persist: (contents: string) => Promise<AtomActionResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
}

/**
 * Debounced, one-at-a-time autosave: rapid edits collapse into a single write, writes never overlap, the
 * newest content is always the last thing persisted, and closing the editor flushes what is left.
 */
export class FileSaveCoordinator<A = unknown, E = unknown> {
  private confirmedRevision = 0;
  private latestRevision = 0;
  private contents = "";
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastChangeAt = 0;
  private saving = false;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    if (this.disposed) {
      return;
    }
    this.lastChangeAt = Date.now();
    this.latestRevision += 1;
    this.contents = contents;
    this.schedule(this.options.debounceMs);
    this.options.onPendingChange(true);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) {
      void this.persistLatest();
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    const fire = () => {
      this.timer = null;
      void this.persistLatest();
    };
    this.timer = setTimeout(fire, delayMs);
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === this.confirmedRevision) return;
    this.saving = true;
    const revision = this.latestRevision;
    const contents = this.contents;

    const outcome = await this.options.persist(contents);
    const succeeded = outcome._tag === "Success";
    if (succeeded) {
      this.confirmedRevision = revision;
      this.options.onConfirmed(contents);
    }
    this.saving = false;

    if (revision === this.latestRevision) {
      // A failed write stays pending and is not retried; the next edit starts a new attempt.
      if (succeeded) this.options.onPendingChange(false);
      return;
    }
    // Newer edits arrived while writing.
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(Math.max(0, this.options.debounceMs - (Date.now() - this.lastChangeAt)));
    }
  }
}
