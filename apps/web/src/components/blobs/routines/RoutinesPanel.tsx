// The Runs tab of a blob's side panel: its routines (next run, on/off, run now, edit) above the run log. The editor,
// the webhook triggers and the report cards live next to it; this file only connects data to those parts.
import {
  CalendarClockIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { PanelEmpty } from "../panel/PanelEmpty";
import { StatusChip, RunLog } from "./RunLog";
import { RoutineEditorDialog } from "./RoutineEditorDialog";
import { cadenceLine, routineState, type RoutineWire } from "./routineModel";
import { useRoutinesApi, type RoutineNav, type RoutinesSnapshot } from "./routinesApi";

const REFRESH_MS = 10_000;

/** Loads the snapshot, refreshes on a timer and on the daemon's change pushes. */
export function useRoutinesData(blobId: string): {
  snapshot: RoutinesSnapshot | null;
  error: string | null;
  refresh: () => void;
} {
  const api = useRoutinesApi();
  const [snapshot, setSnapshot] = useState<RoutinesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    void api.snapshot(blobId).then((r) => {
      if (!alive.current) return;
      if (r.ok) {
        setSnapshot(r.value);
        setError(null);
      } else setError(r.message);
    });
  }, [api, blobId]);
  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    const off = api.subscribe?.(blobId, refresh);
    return () => {
      alive.current = false;
      clearInterval(timer);
      off?.();
    };
  }, [api, blobId, refresh]);
  return { snapshot, error, refresh };
}

const TONE_TEXT = {
  live: "text-info-foreground",
  wait: "text-warning-foreground",
  good: "text-muted-foreground",
  muted: "text-muted-foreground/80",
  bad: "text-destructive-foreground",
} as const;

export function RoutineRow(props: {
  readonly routine: RoutineWire;
  readonly now: number;
  readonly onEdit: () => void;
  readonly onToggle: (on: boolean) => void;
  readonly onRun: () => void;
  readonly onDelete: () => void;
  readonly onOpenRun: (threadId: string) => void;
}) {
  const { routine: r } = props;
  const state = routineState(r, props.now);
  const suggested = r.createdBy === "template" && r.paused;
  return (
    <li data-routine={r.id} className="space-y-1.5 py-3 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={props.onEdit}
            className="block max-w-full truncate text-left text-[13px] font-medium text-foreground outline-none hover:underline focus-visible:underline"
          >
            {r.title}
          </button>
          <div className="text-[12px] text-muted-foreground">
            {suggested && r.suggestedCadence
              ? `Suggested: ${r.suggestedCadence}`
              : cadenceLine(r.cadence)}
          </div>
        </div>
        <Switch
          size="sm"
          checked={!r.paused}
          onCheckedChange={props.onToggle}
          aria-label={r.paused ? `Turn on ${r.title}` : `Pause ${r.title}`}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div
          className={`flex min-w-0 items-center gap-1.5 text-[11.5px] ${TONE_TEXT[state.tone]}`}
          data-routine-state
        >
          {r.live ? (
            <StatusChip status={r.live.status} />
          ) : (
            <span className="truncate">{state.label}</span>
          )}
          {r.triggers.length > 0 ? (
            <span
              className="inline-flex items-center gap-0.5 text-muted-foreground"
              aria-label={`${r.triggers.length} webhook${r.triggers.length === 1 ? "" : "s"}`}
            >
              <WebhookIcon className="size-3" aria-hidden />
              {r.triggers.length}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {r.live?.threadId ? (
            <Button size="xs" variant="outline" onClick={() => props.onOpenRun(r.live!.threadId!)}>
              Open run
            </Button>
          ) : suggested ? (
            // A suggested (paused) routine can be tried before it is switched on: Run now comes first, Turn on after.
            <>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Run ${r.title} now`}
                onClick={props.onRun}
                disabled={!!r.live}
              >
                <PlayIcon />
                Run now
              </Button>
              <Button size="xs" variant="outline" onClick={() => props.onToggle(true)}>
                Turn on
              </Button>
            </>
          ) : (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Run ${r.title} now`}
              onClick={props.onRun}
              disabled={!!r.live}
            >
              <PlayIcon />
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Edit ${r.title}`}
            onClick={props.onEdit}
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Delete ${r.title}`}
            onClick={props.onDelete}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
    </li>
  );
}

export function RoutinesPanel(props: {
  readonly blobId: string;
  readonly blobName: string;
  readonly nav: RoutineNav;
  /** Test/scratch hook: a fixed clock. */
  readonly now?: number;
}) {
  const api = useRoutinesApi();
  const { snapshot, error, refresh } = useRoutinesData(props.blobId);
  const [editing, setEditing] = useState<{ routine: RoutineWire | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const now = props.now ?? Date.now();

  const fail = (title: string, message: string) =>
    toastManager.add({ type: "error", title, description: message });

  const toggle = async (r: RoutineWire, on: boolean) => {
    const res = await api.setPaused(r.id, !on);
    if (!res.ok) fail("Routine", res.message);
    refresh();
  };
  const run = async (r: RoutineWire) => {
    const res = await api.runNow(r.id);
    if (!res.ok) fail("Could not start the run", res.message);
    else toastManager.add({ type: "success", title: `${r.title} is running` });
    refresh();
  };
  const del = async (r: RoutineWire) => {
    const res = await api.remove(r.id);
    setConfirmDelete(null);
    if (!res.ok) fail("Could not delete", res.message);
    refresh();
  };
  const cancel = async (runId: string) => {
    const res = await api.cancelRun(runId);
    if (!res.ok) fail("Could not stop the run", res.message);
    refresh();
  };

  if (snapshot === null) {
    return (
      <div
        className="p-4 text-[12.5px] text-muted-foreground"
        data-routines-loading={error ? "error" : "loading"}
      >
        {error ?? "Loading routines…"}
      </div>
    );
  }

  const routines = snapshot.routines;
  const editor = (
    <RoutineEditorDialog
      open={editing !== null}
      blobId={props.blobId}
      blobName={props.blobName}
      routine={editing?.routine ?? null}
      webhook={snapshot.webhook}
      now={now}
      onOpenChange={(o) => {
        if (!o) setEditing(null);
      }}
      onSaved={refresh}
    />
  );

  if (routines.length === 0 && snapshot.runs.length === 0) {
    return (
      <>
        <PanelEmpty
          icon={CalendarClockIcon}
          title="No routines yet"
          action={
            <Button size="sm" onClick={() => setEditing({ routine: null })} data-new-routine>
              <PlusIcon /> New routine
            </Button>
          }
        >
          Recurring work {props.blobName} does on its own: a morning brief, a weekly summary. Or
          just ask in chat, and {props.blobName} can set it up.
        </PanelEmpty>
        {editor}
      </>
    );
  }

  return (
    <div className="space-y-6 p-4" data-routines-panel>
      <section>
        <div className="mb-2.5 flex items-center justify-between">
          <h4 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Routines
          </h4>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setEditing({ routine: null })}
            data-new-routine
          >
            <PlusIcon /> New routine
          </Button>
        </div>
        <ul className="divide-y divide-border/60">
          {routines.map((r) => (
            <div key={r.id}>
              <RoutineRow
                routine={r}
                now={now}
                onEdit={() => setEditing({ routine: r })}
                onToggle={(on) => void toggle(r, on)}
                onRun={() => void run(r)}
                onDelete={() => setConfirmDelete(r.id)}
                onOpenRun={props.nav.openThread}
              />
              {confirmDelete === r.id ? (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-destructive/6 px-3 py-2 text-[12px]">
                  <span>Delete &ldquo;{r.title}&rdquo; and its run history?</span>
                  <span className="flex gap-1">
                    <Button size="xs" variant="destructive-outline" onClick={() => void del(r)}>
                      Delete
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(null)}>
                      Keep
                    </Button>
                  </span>
                </div>
              ) : null}
            </div>
          ))}
        </ul>
        {routines.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">No routines. Past runs are below.</p>
        ) : null}
      </section>

      <section>
        <h4 className="mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Run log
        </h4>
        <RunLog
          runs={snapshot.runs}
          now={now}
          onOpenRun={props.nav.openThread}
          onOpenResults={props.nav.openThread}
          onCancel={(id) => void cancel(id)}
        />
      </section>
      {editor}
    </div>
  );
}
