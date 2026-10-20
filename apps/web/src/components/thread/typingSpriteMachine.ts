/**
 * The composer's typing sprite ("Code screen"), as a tiny timer-driven state machine (no React):
 *
 *   hidden --input with text--> rising (CODE_RISE) --> typing --TYPING_TO_THINK_MS quiet--> thinking
 *     --THINK_TO_LOOK_MS more--> lookaround (CODE_LOOK, once) --> idle (stays)
 *
 * Any input from thinking / lookaround / idle goes straight back to typing (no rise). It never sinks while the draft
 * has text: it sinks (settling, CODE_SINK) only when the draft becomes empty (everything deleted, or the message sent),
 * from any visible phase, and input with text while settling climbs back up from the height it sank to.
 *
 * `input()` is activity in the editor; `setHasText()` is whether the draft has text. They may arrive in either order
 * for one keystroke, so input on an empty draft arms the machine and the text arriving next completes the rise; text
 * that appears without input (a restored draft) does not raise it.
 *
 * `setEnabled(false)` (the composer stops taking input with text still in it) settles a visible sprite on idle and
 * ignores input until re-enabled; idle is calm and keeps the "never down while there is text" promise without a pop.
 */
import { CODE_LOOK, CODE_RISE, CODE_SINK, RISE_DY, SINK_DY } from "~/components/sprite";

/** No input for this long and the sprite stops typing and thinks (bubble, eyes up). */
export const TYPING_TO_THINK_MS = 500;

/** The user's rule: no typing for 5 s (counted from the last key) -> look around. */
export const LOOK_AFTER_MS = 5000;
export const THINK_TO_LOOK_MS = LOOK_AFTER_MS - TYPING_TO_THINK_MS;

export type TypingPhase =
  | "hidden"
  | "rising"
  | "typing"
  | "thinking"
  | "lookaround"
  | "idle"
  | "settling";

export interface TypingView {
  readonly phase: TypingPhase;
  /** Frame index into CODE_RISE (rising), CODE_LOOK (lookaround) or CODE_SINK (settling); 0 otherwise. */
  readonly frame: number;
}

export interface TypingTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TypingTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class TypingSpriteMachine {
  private view: TypingView = { phase: "hidden", frame: 0 };
  private timer: unknown = null;
  private enabled = true;
  private hasText = false;
  /** Input arrived on an empty draft: the text it typed is probably about to land. */
  private armed = false;

  constructor(
    private readonly onChange: (view: TypingView) => void,
    private readonly timers: TypingTimers = defaultTimers,
  ) {}

  get current(): TypingView {
    return this.view;
  }

  /** The user typed / deleted / pasted in the editor. */
  input(): void {
    if (!this.enabled) return;
    if (!this.hasText) {
      this.armed = true;
      return;
    }
    this.wake();
  }

  /** Whether the draft has text (after typing, deleting, sending, switching threads). */
  setHasText(hasText: boolean): void {
    if (hasText === this.hasText) return;
    this.hasText = hasText;
    if (!hasText) {
      this.armed = false;
      const { phase } = this.view;
      if (phase !== "hidden" && phase !== "settling") this.settle(0);
      return;
    }
    if (this.armed && this.enabled) {
      this.armed = false;
      this.wake();
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) return;
    this.armed = false;
    const { phase } = this.view;
    // Rising finishes on its own and lands on idle (see rise()); settling carries on down.
    if (phase === "typing" || phase === "thinking" || phase === "lookaround") this.idle();
  }

  dispose(): void {
    this.clear();
  }

  private wake(): void {
    const { phase, frame } = this.view;
    switch (phase) {
      case "hidden":
        this.rise(0);
        return;
      case "rising":
        return; // on its way up; typing starts when it arrives
      case "typing":
      case "thinking":
      case "lookaround":
      case "idle":
        this.type();
        return;
      case "settling": {
        // Climb back from the height it has sunk to.
        const dy = SINK_DY[frame] ?? SINK_DY[SINK_DY.length - 1]!;
        const from = RISE_DY.findIndex((d) => d < dy);
        this.rise(from < 0 ? RISE_DY.length - 1 : from);
        return;
      }
    }
  }

  private set(view: TypingView): void {
    this.view = view;
    this.onChange(view);
  }

  private clear(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private after(ms: number, fn: () => void): void {
    this.clear();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private rise(frame: number): void {
    this.set({ phase: "rising", frame });
    this.after(CODE_RISE[frame]!.ms, () => {
      if (frame + 1 < CODE_RISE.length) this.rise(frame + 1);
      else if (this.enabled) this.type();
      else this.idle();
    });
  }

  private type(): void {
    if (this.view.phase !== "typing") this.set({ phase: "typing", frame: 0 });
    this.after(TYPING_TO_THINK_MS, () => this.think());
  }

  private think(): void {
    this.set({ phase: "thinking", frame: 0 });
    this.after(THINK_TO_LOOK_MS, () => this.look(0));
  }

  private look(frame: number): void {
    this.set({ phase: "lookaround", frame });
    this.after(CODE_LOOK[frame]!.ms, () => {
      if (frame + 1 < CODE_LOOK.length) this.look(frame + 1);
      else this.idle();
    });
  }

  private idle(): void {
    this.clear();
    if (this.view.phase !== "idle") this.set({ phase: "idle", frame: 0 });
  }

  private settle(frame: number): void {
    this.set({ phase: "settling", frame });
    this.after(CODE_SINK[frame]!.ms, () => {
      if (frame + 1 < CODE_SINK.length) this.settle(frame + 1);
      else this.set({ phase: "hidden", frame: 0 });
    });
  }
}
