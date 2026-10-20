// Create or edit a routine: name, instructions, cadence picker, where reports go, remember-last-run, the optional run
// limit, catch-up on wake, and (for a saved routine) webhook triggers.

import { toastManager } from "~/components/ui/toast";
import { useRoutinesApi, type ThreadChoice } from "./routinesApi";
import {
  RUN_LIMIT_CHOICES,
  cadenceFromDraft,
  draftFromCadence,
  type CadenceDraft,
  type RoutineWire,
} from "./routineModel";
import { WebhookTriggers } from "./WebhookTriggers";
import { CadencePicker } from "./CadencePicker";
import { Textarea } from "../../ui/textarea";
import { Switch } from "../../ui/switch";
import { Label } from "../../ui/label";
import { Input } from "../../ui/input";
import {
  DialogPopup,
  DialogTitle,
  Dialog,
  DialogHeader,
  DialogDescription,
  DialogFooter,
  DialogPanel,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { useEffect, useState, useId } from "react";

const DEDICATED = "__dedicated__";

export interface RoutineEditorProps {
  readonly open: boolean;
  readonly blobId: string;
  readonly blobName: string;
  readonly routine: RoutineWire | null;
  readonly webhook: { baseUrl: string; receiverUp: boolean };
  readonly now: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}

export function RoutineEditorDialog(props: RoutineEditorProps) {
  const { routine } = props;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        {/* remount the form per routine so every field starts from that routine */}
        <EditorForm key={routine?.id ?? "new"} {...props} />
      </DialogPopup>
    </Dialog>
  );
}

function EditorForm(props: RoutineEditorProps) {
  const { routine, blobId } = props;
  const api = useRoutinesApi();
  const uid = useId();
  const [title, setTitle] = useState(routine?.title ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [draft, setDraft] = useState<CadenceDraft>(() =>
    draftFromCadence(routine?.cadence ?? null, props.now),
  );
  const [target, setTarget] = useState<string>(
    routine?.results.mode === "thread" ? routine.results.threadId : DEDICATED,
  );
  const [remember, setRemember] = useState(routine?.rememberLastRun ?? false);
  const [limit, setLimit] = useState(
    routine ? (routine.maxRunMinutes ? String(routine.maxRunMinutes) : "") : "15",
  );
  const [catchUp, setCatchUp] = useState((routine?.catchUp ?? "one") === "one");
  const [threads, setThreads] = useState<ReadonlyArray<ThreadChoice>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void api.threads(blobId).then((r) => {
      if (live && r.ok) setThreads(r.value);
    });
    return () => {
      live = false;
    };
  }, [api, blobId]);

  const built = cadenceFromDraft(draft);
  const canSave = title.trim().length > 0 && prompt.trim().length > 0 && built.ok && !saving;

  const save = async () => {
    if (!built.ok) return;
    setSaving(true);
    const r = await api.save({
      id: routine?.id ?? null,
      blobId,
      title: title.trim(),
      prompt: prompt.trim(),
      cadence: built.cadence,
      results:
        target === DEDICATED
          ? { mode: "dedicated", threadId: routine?.results.threadId ?? null }
          : { mode: "thread", threadId: target },
      rememberLastRun: remember,
      maxRunMinutes: limit ? Number(limit) : null,
      catchUp: catchUp ? "one" : "none",
      paused: routine?.paused ?? false,
    });
    setSaving(false);
    if (!r.ok) {
      toastManager.add({
        type: "error",
        title: "Could not save the routine",
        description: r.message,
      });
      return;
    }
    props.onSaved();
    props.onOpenChange(false);
  };

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{routine ? "Edit routine" : `New routine for ${props.blobName}`}</DialogTitle>
        <DialogDescription>
          {props.blobName} does this on its own and posts a report. Each run starts a fresh chat
          that stays out of your list; you can open it from the report.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-title`}>Name</Label>
          <Input
            id={`${uid}-title`}
            nativeInput
            autoFocus
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Morning brief"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-prompt`}>What should it do?</Label>
          <Textarea
            id={`${uid}-prompt`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Check my inbox and calendar, then write me five lines on what matters today."
            rows={4}
          />
        </div>

        <div className="space-y-2">
          <Label>When</Label>
          <CadencePicker draft={draft} onChange={setDraft} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-results`}>Post the report in</Label>
          <select
            id={`${uid}-results`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-8.5 w-full rounded-lg border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7.5"
          >
            <option value={DEDICATED}>Create a dedicated results thread</option>
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title || "Untitled thread"}
              </option>
            ))}
            {target !== DEDICATED && !threads.some((t) => t.id === target) ? (
              <option value={target}>Current results thread</option>
            ) : null}
          </select>
        </div>

        <div className="space-y-3 rounded-xl p-3 ring-1 ring-border/70">
          <ToggleRow
            id={`${uid}-remember`}
            label="Remember the last run"
            hint="Each run starts with the previous report (up to 2,000 characters), so it can build on it."
            checked={remember}
            onChange={setRemember}
          />
          <ToggleRow
            id={`${uid}-catchup`}
            label="Catch up when Kora wakes"
            hint="If a run was missed while this Mac slept or Kora was off, run it once on wake. Never a burst."
            checked={catchUp}
            onChange={setCatchUp}
          />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor={`${uid}-limit`}>Stop a run after</Label>
              <p className="text-[11.5px] text-muted-foreground">
                Ends work that gets stuck. New routines stop after 15 minutes.
              </p>
            </div>
            <select
              id={`${uid}-limit`}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="h-8 rounded-lg border border-input bg-background px-2 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {RUN_LIMIT_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {routine ? (
          <WebhookTriggers
            routine={routine}
            webhook={props.webhook}
            now={props.now}
            onChanged={props.onSaved}
          />
        ) : (
          <p className="text-[12px] text-muted-foreground">
            Save the routine first to add a webhook trigger.
          </p>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave} data-save-routine>
          {routine ? "Save" : "Create routine"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ToggleRow(props: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={props.id}>{props.label}</Label>
        <p className="text-[11.5px] leading-snug text-muted-foreground">{props.hint}</p>
      </div>
      <Switch id={props.id} checked={props.checked} onCheckedChange={props.onChange} />
    </div>
  );
}
