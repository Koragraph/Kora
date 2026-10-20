import { toggleVariants } from "./ui/toggle";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "./ui/select";
import { PopoverTrigger, PopoverPopup, Popover } from "./ui/popover";
import {
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldGroup,
  NumberFieldInput,
  NumberField,
} from "./ui/number-field";
import { Label } from "./ui/label";
import {
  DialogPopup,
  DialogHeader,
  DialogFooter,
  Dialog,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Calendar } from "./ui/calendar";
import { Button } from "./ui/button";
import {
  resolveCustomSnooze,
  type CustomSnoozeInput,
  localSnoozeDate,
  localSnoozeTime,
} from "@kora/client-runtime/store/thread-settled";
import { create } from "zustand";
import { type FormEvent, useEffect, useState, useId } from "react";
import { CalendarIcon } from "lucide-react";
import { Tabs } from "@base-ui/react/tabs";

type SnoozeChoice = { readonly snoozedUntil: string } | null;
type DurationUnit = "minutes" | "hours" | "days";
type SnoozeMode = "date" | "duration";

interface PendingRequest {
  readonly resolve: (choice: SnoozeChoice) => void;
}

const usePendingSnooze = create<{ pending: PendingRequest | null }>(() => ({ pending: null }));

const UNIT_LABELS: Record<DurationUnit, string> = {
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
};

/** Ask the user for a snooze time. Only one dialog is ever open; a newer request cancels the older. */
export function requestCustomSnooze(): Promise<SnoozeChoice> {
  usePendingSnooze.getState().pending?.resolve(null);
  return new Promise<SnoozeChoice>((resolve) => {
    usePendingSnooze.setState({ pending: { resolve } });
  });
}

function settle(choice: SnoozeChoice) {
  const { pending } = usePendingSnooze.getState();
  usePendingSnooze.setState({ pending: null });
  pending?.resolve(choice);
}

export function CustomSnoozeDialogHost() {
  const pending = usePendingSnooze((state) => state.pending);

  // A host going away must not leave a caller awaiting forever.
  useEffect(
    () => () => {
      const { pending: open } = usePendingSnooze.getState();
      if (open) settle(null);
    },
    [],
  );

  if (!pending) return null;
  return <SnoozeDialogBody onSettle={settle} />;
}

function isSnoozeMode(value: unknown): value is SnoozeMode {
  return value === "date" || value === "duration";
}

function SnoozeDialogBody({ onSettle }: { readonly onSettle: (choice: SnoozeChoice) => void }) {
  const [startsAt] = useState(() => new Date(Date.now() + 60 * 60 * 1000));
  const [mode, setMode] = useState<SnoozeMode>("date");
  const [date, setDate] = useState(startsAt);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(() => localSnoozeTime(startsAt));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<DurationUnit>("hours");
  const [error, setError] = useState<string | null>(null);
  const timeId = useId();
  const unitId = useId();
  const amountId = useId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input: CustomSnoozeInput =
      mode === "date" ? { mode, date: localSnoozeDate(date), time } : { mode, amount, unit };
    const snoozedUntil = resolveCustomSnooze(input, new Date());
    if (snoozedUntil) {
      onSettle({ snoozedUntil });
      return;
    }
    const complaint =
      mode === "date"
        ? "Choose a valid date and time in the future."
        : "Enter a positive duration.";
    setError(complaint);
  };

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const tabClass = toggleVariants({ variant: "segmented", size: "segmented", className: "flex-1" });

  const quantityControls = (
    <NumberFieldGroup>
      <NumberFieldDecrement aria-label="Decrease duration" />
      <NumberFieldInput id={amountId} required />
      <NumberFieldIncrement aria-label="Increase duration" />
    </NumberFieldGroup>
  );

  const divBlock =
    mode === "date" ? (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label>Date</Label>
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger
              render={<Button variant="outline" className="w-full justify-between font-normal" />}
            >
              {date.toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
              <CalendarIcon className="size-4 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverPopup aria-label="Choose snooze date" align="start">
              <Calendar
                onSelect={(picked) => {
                  if (!picked) return;
                  setDate(picked);
                  setCalendarOpen(false);
                  setError(null);
                }}
                disabled={{ before: todayStart }}
                defaultMonth={date}
                selected={date}
                mode="single"
                required
              />
            </PopoverPopup>
          </Popover>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={timeId}>Time</Label>
          <input
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-foreground sm:h-8"
            required
            type="time"
            onChange={(event) => {
              setError(null);
              setTime(event.target.value);
            }}
            value={time}
            id={timeId}
          />
        </div>
      </div>
    ) : (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={amountId}>Snooze for</Label>
          <NumberField
            onValueChange={(value) => {
              setError(null);
              setAmount(value === null ? "" : String(value));
            }}
            step="any"
            value={amount === "" ? null : Number(amount)}
            min={0}
          >
            {quantityControls}
          </NumberField>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={unitId}>Unit</Label>
          <Select
            value={unit}
            onValueChange={(next) => {
              if (next === "minutes" || next === "hours" || next === "days") {
                setUnit(next);
                setError(null);
              }
            }}
          >
            <SelectTrigger id={unitId}>
              <SelectValue>{UNIT_LABELS[unit]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(UNIT_LABELS) as DurationUnit[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {UNIT_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
    );

  const dialogFooterPart = (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={() => onSettle(null)}>
        Cancel
      </Button>
      <Button type="submit">Snooze</Button>
    </DialogFooter>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onSettle(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form className="flex min-h-0 flex-col" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Snooze until…</DialogTitle>
            <DialogDescription>
              The thread drops out of the list and comes back at the time you pick.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            <Tabs.Root
              value={mode}
              onValueChange={(next) => {
                if (!isSnoozeMode(next)) return;
                setMode(next);
                setError(null);
              }}
            >
              <Tabs.List
                aria-label="Schedule type"
                className="flex gap-0.5 rounded-lg bg-input/40 p-0.5"
              >
                <Tabs.Tab
                  value="date"
                  className={tabClass}
                  data-pressed={mode === "date" ? "" : undefined}
                >
                  Date and time
                </Tabs.Tab>
                <Tabs.Tab
                  value="duration"
                  className={tabClass}
                  data-pressed={mode === "duration" ? "" : undefined}
                >
                  Duration
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.Root>

            {divBlock}

            {error ? (
              <p role="alert" className="text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          {dialogFooterPart}
        </form>
      </DialogPopup>
    </Dialog>
  );
}
