// The cadence picker: how often, in four shapes (every N minutes, chosen weekdays at a time, a custom cron rule with an
// explicit zone, once), and underneath it the plain-words sentence plus the next fire times asked from the daemon's own
// schedule engine, so a calendar rule is shown exactly as it will run.
import { useEffect, useState } from "react";

import { cn } from "~/util/utils";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import {
  WEEKDAY_SHORT,
  cadenceFromDraft,
  cadenceZone,
  draftSentence,
  formatNextTime,
  type CadenceDraft,
  type CadenceKind,
} from "./routineModel";
import { useRoutinesApi, type RoutinesApi } from "./routinesApi";

const KINDS: ReadonlyArray<{ value: CadenceKind; label: string }> = [
  { value: "weekly", label: "Days & time" },
  { value: "interval", label: "Every N minutes" },
  { value: "cron", label: "Custom rule" },
  { value: "once", label: "Once" },
];

const CRON_EXAMPLES: ReadonlyArray<{ label: string; expr: string }> = [
  { label: "First Monday", expr: "0 9 * * 1#1" },
  { label: "Last day of month", expr: "0 9 L * *" },
  { label: "Last Friday", expr: "0 17 * * 5L" },
  { label: "Weekdays every 15 min", expr: "*/15 9-17 * * 1-5" },
];

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** One-click day sets. The one that matches the chosen days is lit, so the buttons double as the label. */
const DAY_PRESETS: ReadonlyArray<{ label: string; days: ReadonlyArray<number> }> = [
  { label: "Weekdays", days: [1, 2, 3, 4, 5] },
  { label: "Weekends", days: [0, 6] },
  { label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
];
const sameDays = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

function Pill(props: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
  readonly label?: string;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.active}
      aria-label={props.label}
      onClick={props.onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-[12px] leading-none font-medium whitespace-nowrap ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.active
          ? "bg-foreground text-background ring-foreground"
          : "bg-transparent text-muted-foreground ring-border/80 hover:bg-accent/60 hover:text-foreground",
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

/** Next fire times from the daemon for the current draft; debounced, ignores stale answers. */
function useCadencePreview(
  draft: CadenceDraft,
  api: RoutinesApi,
): { next: ReadonlyArray<number>; error: string | null } {
  const [state, setState] = useState<{ next: ReadonlyArray<number>; error: string | null }>({
    next: [],
    error: null,
  });
  const built = cadenceFromDraft(draft);
  const key = built.ok ? JSON.stringify(built.cadence) : null;
  useEffect(() => {
    if (key === null) {
      setState({ next: [], error: null });
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api.preview(JSON.parse(key)).then((r) => {
        if (!live) return;
        setState(r.ok ? { next: r.value.next, error: null } : { next: [], error: r.message });
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, api]);
  return state;
}

export function CadencePicker(props: {
  readonly draft: CadenceDraft;
  readonly onChange: (next: CadenceDraft) => void;
}) {
  const { draft, onChange } = props;
  const api = useRoutinesApi();
  const set = (patch: Partial<CadenceDraft>) => onChange({ ...draft, ...patch });
  const sentence = draftSentence(draft);
  const preview = useCadencePreview(draft, api);
  const built = cadenceFromDraft(draft);

  return (
    <div className="space-y-3" data-cadence-picker>
      <div role="radiogroup" aria-label="How often" className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => (
          <Pill
            key={k.value}
            active={draft.kind === k.value}
            onClick={() => set({ kind: k.value })}
          >
            {k.label}
          </Pill>
        ))}
      </div>

      {draft.kind === "interval" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="rt-every" className="sr-only">
              Minutes between runs
            </Label>
            <Input
              id="rt-every"
              nativeInput
              type="number"
              inputMode="numeric"
              min={5}
              max={1440}
              value={draft.everyMinutes}
              onChange={(e) => set({ everyMinutes: e.target.value })}
              className="w-24"
            />
            <span className="text-[12.5px] text-muted-foreground">minutes (5 to 1,440)</span>
          </div>
          <div role="radiogroup" aria-label="Common intervals" className="flex flex-wrap gap-1.5">
            {[15, 30, 60, 120, 360].map((n) => (
              <Pill
                key={n}
                active={draft.everyMinutes === String(n)}
                onClick={() => set({ everyMinutes: String(n) })}
              >
                {n < 60 ? `${n} min` : `${n / 60} hr`}
              </Pill>
            ))}
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            Counted from the moment you save, so runs stay on the same rhythm.
          </p>
        </div>
      ) : null}

      {draft.kind === "weekly" ? (
        <div className="space-y-2.5">
          <div
            role="group"
            aria-label="Days"
            className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
          >
            {DAY_ORDER.map((d) => {
              const on = draft.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    set({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d] })
                  }
                  className={cn(
                    "grid h-7 w-10 place-items-center rounded-lg text-[12px] font-medium ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on
                      ? "bg-foreground text-background ring-foreground"
                      : "text-muted-foreground ring-border/80 hover:bg-accent/60",
                  )}
                >
                  {WEEKDAY_SHORT[d]}
                </button>
              );
            })}
          </div>
          <div
            role="radiogroup"
            aria-label="Day sets"
            className="flex flex-wrap items-center gap-1.5"
            data-day-presets
          >
            {DAY_PRESETS.map((p) => (
              <Pill
                key={p.label}
                active={sameDays(draft.days, p.days)}
                onClick={() => set({ days: [...p.days] })}
              >
                {p.label}
              </Pill>
            ))}
          </div>
          <div className="grid grid-cols-[9.5rem_1fr] gap-2.5">
            <div className="space-y-1.5">
              <Label htmlFor="rt-time">Time</Label>
              <Input
                id="rt-time"
                nativeInput
                type="time"
                value={draft.time}
                onChange={(e) => set({ time: e.target.value })}
              />
            </div>
            <ZoneField draft={draft} set={set} />
          </div>
        </div>
      ) : null}

      {draft.kind === "cron" ? (
        <div className="space-y-2.5">
          <div className="space-y-1.5">
            <Label htmlFor="rt-cron">Rule</Label>
            <Input
              id="rt-cron"
              nativeInput
              spellCheck={false}
              autoCapitalize="off"
              value={draft.cron}
              onChange={(e) => set({ cron: e.target.value })}
              className="font-mono text-[12.5px]"
              placeholder="minute hour day-of-month month day-of-week"
            />
          </div>
          <div className="flex flex-wrap gap-1.5" aria-label="Examples">
            {CRON_EXAMPLES.map((ex) => (
              <Pill
                key={ex.expr}
                active={draft.cron.trim() === ex.expr}
                onClick={() => set({ cron: ex.expr })}
              >
                {ex.label}
              </Pill>
            ))}
          </div>
          <ZoneField draft={draft} set={set} />
          <p className="text-[11.5px] text-muted-foreground">
            Five fields. <code>L</code> is the last day, <code>1#1</code> the first Monday,{" "}
            <code>5L</code> the last Friday. Never an approximation like &ldquo;every 30
            days&rdquo;.
          </p>
        </div>
      ) : null}

      {draft.kind === "once" ? (
        <div className="space-y-1.5">
          <Label htmlFor="rt-once">Date and time</Label>
          <Input
            id="rt-once"
            nativeInput
            type="datetime-local"
            value={draft.onceLocal}
            onChange={(e) => set({ onceLocal: e.target.value })}
          />
        </div>
      ) : null}

      <div
        data-cadence-preview
        aria-live="polite"
        className={cn(
          "rounded-lg px-3 py-2 text-[12.5px] leading-snug ring-1",
          sentence.ok
            ? "bg-card ring-border/70"
            : "bg-destructive/6 text-destructive-foreground ring-destructive/30",
        )}
      >
        <div className={cn("font-medium", sentence.ok && "text-foreground")}>{sentence.text}</div>
        {sentence.ok && preview.error ? (
          <div className="mt-1 text-destructive-foreground">{preview.error}</div>
        ) : null}
        {sentence.ok && !preview.error && preview.next.length > 0 ? (
          <NextTimes next={preview.next} zone={built.ok ? cadenceZone(built.cadence) : null} />
        ) : null}
      </div>
    </div>
  );
}

/** The next fire times in the routine's own zone, plus the first one in this Mac's zone when the two differ. */
function NextTimes(props: { readonly next: ReadonlyArray<number>; readonly zone: string | null }) {
  const times = props.next.map((ms) => formatNextTime(ms, props.zone));
  const here = times[0]?.here ?? null;
  return (
    <div className="mt-1 space-y-0.5 text-muted-foreground" data-next-times>
      <div>Next: {times.map((t) => t.label).join("  ·  ")}</div>
      {here ? <div className="text-[11.5px]">On your clock that is {here}.</div> : null}
    </div>
  );
}

function ZoneField(props: {
  readonly draft: CadenceDraft;
  readonly set: (p: Partial<CadenceDraft>) => void;
}) {
  const zones =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return (
    <div className="space-y-1.5">
      <Label htmlFor="rt-tz">Time zone</Label>
      <Input
        id="rt-tz"
        nativeInput
        list="rt-zones"
        spellCheck={false}
        value={props.draft.tz}
        onChange={(e) => props.set({ tz: e.target.value })}
        placeholder="America/New_York"
      />
      <datalist id="rt-zones">
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </div>
  );
}
