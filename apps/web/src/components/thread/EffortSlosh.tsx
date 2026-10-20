import { cn } from "~/util/utils";
import { memo, useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

/**
 * The effort chooser: a sectioned slider whose fill has mass (the user's "Slosh"). One section per level the model
 * has, named inside the track; everything up to the chosen level is filled. The handle is rigid and stays under the
 * pointer; the fill is a softer spring behind it, so a fast drag throws it past the handle, off the end stop and back,
 * its leading edge leaning the way it travels. A throw coasts on the speed it had and lands on the nearest level; a
 * click jumps to the section clicked. Nothing goes through React per frame: the loop writes styles straight onto the
 * elements and parks itself once everything is at rest. Reduced motion is an ordinary slider.
 */

export type EffortLevel = { id: string; label: string; description?: string; isDefault?: boolean };

const VISCOSITY = 23;
const MOMENTUM = 55;
const TILT = 45;

/** Short names inside the track once there are many sections; the line above the track names the level in full. */
const SHORT: Record<string, string> = {
  minimal: "Min",
  medium: "Med",
  xhigh: "XHigh",
};

/** What a level means when the model's own catalog does not say. */
const MEANING: Record<string, string> = {
  none: "answers straight away",
  minimal: "barely thinks, fastest",
  low: "quick edits, small questions",
  medium: "everyday work",
  high: "tricky changes, real bugs",
  xhigh: "hard bugs, big refactors",
  max: "thinks as long as it takes",
  ultra: "everything it has",
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const reducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export const EffortSlosh = memo(function EffortSlosh({
  levels,
  value,
  onChange,
  disabled = false,
  label = "Effort",
  note,
}: {
  levels: ReadonlyArray<EffortLevel>;
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
  /** Replaces the level's meaning (e.g. why it is locked). */
  note?: string | undefined;
}) {
  const n = levels.length;
  const index = levels.findIndex((level) => level.id === value);
  const endOf = (j: number) => ((j + 1) / n) * 100;
  const start = index < 0 ? 0 : endOf(index);

  const track = useRef<HTMLDivElement | null>(null);
  const fillEl = useRef<HTMLDivElement | null>(null);
  const knobEl = useRef<HTMLDivElement | null>(null);
  const s = useRef({
    val: start,
    hv: 0,
    fill: start,
    fv: 0,
    held: false,
    target: null as number | null,
    raf: 0,
    prev: 0,
    downAt: 0,
    last: { v: start, t: 0 },
    n,
  });
  s.current.n = n;
  const pick = useRef(onChange);
  pick.current = onChange;
  const run = useRef<() => void>(() => {});

  useEffect(() => {
    const st = s.current;
    const paint = () => {
      const f = fillEl.current;
      const k = knobEl.current;
      const t = track.current;
      if (!f || !k || !t) return;
      f.style.width = `${st.fill.toFixed(2)}%`;
      k.style.left = `${st.val.toFixed(2)}%`;
      const lean = reducedMotion() ? 0 : clamp((TILT / 100) * st.fv * 3, -20, 20);
      f.style.setProperty("--lean", `${lean.toFixed(2)}px`);
      t.querySelectorAll<HTMLElement>("[data-effort-section]").forEach((el, j) => {
        el.dataset.on = String(st.fill >= ((j + 0.5) / st.n) * 100);
      });
    };
    const nearest = (v: number) => clamp(Math.round((v / 100) * st.n) - 1, 0, st.n - 1);
    const land = () => {
      const j = nearest(st.val);
      st.target = ((j + 1) / st.n) * 100;
      const id = levelsRef.current[j]?.id;
      if (id) pick.current(id);
    };
    const tick = (time: number) => {
      const dt = st.prev ? clamp((time - st.prev) / 16.67, 0, 2.5) : 1;
      st.prev = time;
      // the coast after a throw: friction per frame, raised to dt so a dropped frame cannot double it
      if (!st.held && st.hv) {
        st.val += st.hv * dt;
        st.hv *= Math.pow(0.86 + (MOMENTUM / 100) * 0.115, dt);
        if (st.val <= 0 || st.val >= 100) {
          st.val = clamp(st.val, 0, 100);
          st.hv = 0;
        }
        if (Math.abs(st.hv) < 0.15) {
          st.hv = 0;
          land();
        }
      }
      // then the handle settles into its section
      if (!st.held && !st.hv && st.target !== null) {
        st.val += (st.target - st.val) * (1 - Math.pow(0.72, dt));
        if (Math.abs(st.target - st.val) < 0.02) {
          st.val = st.target;
          st.target = null;
        }
      }
      const soft = reducedMotion() ? 0 : VISCOSITY / 100;
      if (soft === 0) {
        st.fill = st.val;
        st.fv = 0;
      } else {
        // stiffness falls and damping rises together: thin liquid is slow to answer and slow to forget
        st.fv += (st.val - st.fill) * (0.34 - soft * 0.29) * dt;
        st.fv *= Math.pow(0.74 + soft * 0.22, dt);
        st.fill += st.fv * dt;
        // the end stop is a wall, and a wall gives some back
        if (st.fill > 100) {
          st.fill = 100;
          st.fv = -st.fv * 0.42;
        } else if (st.fill < 0) {
          st.fill = 0;
          st.fv = -st.fv * 0.42;
        }
        if (Math.abs(st.val - st.fill) < 0.02 && Math.abs(st.fv) < 0.02) {
          st.fill = st.val;
          st.fv = 0;
        }
      }
      paint();
      if (!st.held && !st.hv && st.target === null && !st.fv && st.fill === st.val) {
        st.raf = 0;
        st.prev = 0;
        return;
      }
      st.raf = requestAnimationFrame(tick);
    };
    run.current = () => {
      if (!st.raf) st.raf = requestAnimationFrame(tick);
    };
    paint();
    return () => {
      cancelAnimationFrame(st.raf);
      st.raf = 0;
    };
  }, []);

  const levelsRef = useRef(levels);
  levelsRef.current = levels;

  // A level chosen elsewhere (the keyboard, another surface, a new model) slides the handle there.
  useEffect(() => {
    const st = s.current;
    if (st.held || st.hv) return;
    const to = index < 0 ? 0 : ((index + 1) / n) * 100;
    if (st.target === to || (st.target === null && st.val === to)) return;
    st.target = to;
    run.current();
  }, [index, n]);

  const readAt = (clientX: number) => {
    const t = track.current;
    if (!t) return 0;
    const box = t.getBoundingClientRect();
    return box.width ? clamp(((clientX - box.left) / box.width) * 100, 0, 100) : 0;
  };

  const grab = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const st = s.current;
    st.held = true;
    st.hv = 0;
    st.target = null;
    st.val = readAt(e.clientX);
    st.downAt = st.val;
    st.last = { v: st.val, t: e.timeStamp };
    run.current();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const st = s.current;
    if (!st.held) return;
    const v = readAt(e.clientX);
    // per frame, not per ms: the loop is in frames
    st.hv = ((v - st.last.v) / Math.max(1, e.timeStamp - st.last.t)) * 16.67;
    st.last = { v, t: e.timeStamp };
    st.val = v;
    run.current();
  };
  const drop = () => {
    const st = s.current;
    if (!st.held) return;
    st.held = false;
    if (Math.abs(st.val - st.downAt) < 1) {
      // a click: the section clicked
      st.hv = 0;
      const j = clamp(Math.floor((st.val / 100) * n), 0, n - 1);
      st.target = endOf(j);
      const id = levels[j]?.id;
      if (id) onChange(id);
    } else {
      // a throw leaves along the speed it had, capped so a flick does not simply pin it
      st.hv = reducedMotion() ? 0 : clamp(st.hv, -6, 6);
      if (!st.hv) {
        const j = clamp(Math.round((st.val / 100) * n) - 1, 0, n - 1);
        st.target = endOf(j);
        const id = levels[j]?.id;
        if (id) onChange(id);
      }
    }
    run.current();
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = index < 0 ? -1 : index;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowUp"
        ? at + 1
        : e.key === "ArrowLeft" || e.key === "ArrowDown"
          ? at - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    const id = levels[clamp(to, 0, n - 1)]?.id;
    if (!disabled && id && id !== value) onChange(id);
  };

  const current = index < 0 ? undefined : levels[index];
  const short = n >= 5;
  const meaning = note ?? (current ? (current.description ?? MEANING[current.id]) : undefined);

  return (
    <div className="flex flex-col gap-1.5 px-2 pt-1 pb-1" data-testid="effort-slosh">
      <div className="flex min-w-0 items-baseline gap-2 px-0.5 whitespace-nowrap">
        <span className="text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
          {label}
        </span>
        <span className="text-[13px] font-semibold text-foreground">
          {current?.label ?? "Not set"}
        </span>
        {meaning ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{meaning}</span>
        ) : null}
      </div>
      <div
        aria-disabled={disabled || undefined}
        aria-label={label}
        aria-valuemax={n}
        aria-valuemin={1}
        aria-valuenow={index + 1}
        aria-valuetext={current?.label ?? "Not set"}
        className={cn(
          "relative h-7 touch-none overflow-hidden rounded-full bg-[var(--lift-inset-bg,#0b0b0c)] outline-none select-none",
          "before:pointer-events-none before:absolute before:inset-0 before:z-[3] before:rounded-[inherit] before:border before:border-border",
          "focus-visible:before:border-foreground/40",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        )}
        onKeyDown={key}
        onPointerCancel={drop}
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={drop}
        ref={track}
        role="slider"
        tabIndex={disabled ? -1 : 0}
      >
        <div
          className="absolute inset-y-0 left-0 bg-foreground/24 [clip-path:polygon(0_0,calc(100%+var(--lean,0px))_0,calc(100%-var(--lean,0px))_100%,0_100%)]"
          ref={fillEl}
          style={{ width: `${start}%` }}
        />
        <div className="pointer-events-none absolute inset-0 z-[1] flex">
          {levels.map((level, j) => (
            <span
              className={cn(
                "relative grid flex-1 place-items-center text-[11px] text-muted-foreground/60 transition-colors duration-150",
                "data-[on=true]:text-foreground",
                j > 0 &&
                  "before:absolute before:inset-y-2 before:left-0 before:w-px before:bg-foreground/8",
              )}
              data-effort-section=""
              data-on={String(j <= index)}
              key={level.id}
            >
              <span className="flex items-center gap-1">
                {short ? (SHORT[level.id] ?? level.label) : level.label}
                {level.isDefault ? (
                  <span
                    aria-hidden="true"
                    className="size-[3px] rounded-full bg-current opacity-60"
                  />
                ) : null}
              </span>
            </span>
          ))}
        </div>
        <div
          className="pointer-events-none absolute top-1.5 z-[2] -ml-2.5 h-4 w-1 rounded-sm bg-foreground"
          ref={knobEl}
          style={{ left: `${start}%`, display: index < 0 ? "none" : undefined }}
        />
      </div>
    </div>
  );
});
