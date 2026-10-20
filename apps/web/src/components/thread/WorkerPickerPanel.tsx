import { memo, useMemo, useState } from "react";
import { XIcon } from "lucide-react";

import { cn } from "~/util/utils";
import { Button } from "../ui/button";
import {
  agentLabel,
  effortsFor,
  modelsFor,
  pickerAgentOptions,
  pickerAnswer,
  rowsEdited,
  unavailableRows,
  updateRow,
  type PendingWorkerPicker,
  type WorkerPickRow,
} from "./workerPicker.logic";

const selectClass =
  "h-7 min-w-0 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The worker picker: the lead proposed who should do each task (agent · model · effort); the user approves it as-is
 * (Enter / Approve), changes any row, applies one row's choice to all, removes rows, or declines. Answers go back
 * through thread.user-input.respond as `{ picks, autoApprove? }`; a decline sends `{}`.
 */
export const WorkerPickerPanel = memo(function WorkerPickerPanel(props: {
  request: PendingWorkerPicker;
  busy: boolean;
  onSubmit: (answers: Record<string, unknown>) => void;
  onDecline: () => void;
}) {
  const { request } = props;
  const [rows, setRows] = useState<WorkerPickRow[]>(request.picks);
  const [autoApprove, setAutoApprove] = useState(false);
  // Rows are the human's edits: seeded once per request (the parent keys this panel by requestId). Never re-seed from
  // `request.picks` — it is rebuilt on every thread activity while the picker is open, and re-seeding wiped the edits.
  const agents = useMemo(() => pickerAgentOptions(request.catalog, request.picks), [request]);
  const unavailable = unavailableRows(request.catalog, rows);
  // Escape with edits asks first ("Decline all?") instead of throwing the edits away.
  const [declineArmed, setDeclineArmed] = useState(false);

  const setRow = (i: number, patch: Partial<Pick<WorkerPickRow, "agent" | "model" | "effort">>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? updateRow(request.catalog, r, patch) : r)));
  const useForAll = (i: number) =>
    setRows((rs) => {
      const src = rs[i]!;
      return rs.map((r) => ({
        title: r.title,
        ...(r.why ? { why: r.why } : {}),
        agent: src.agent,
        ...(src.model ? { model: src.model } : {}),
        ...(src.effort ? { effort: src.effort } : {}),
      }));
    });
  const canApprove = !props.busy && rows.length > 0 && unavailable.length === 0;
  const approve = () => {
    if (!canApprove) return;
    props.onSubmit(pickerAnswer(rows, autoApprove));
  };

  return (
    <div
      data-worker-picker={request.requestId}
      role="dialog"
      aria-label="Pick the workers"
      className="mx-auto mb-2 w-full max-w-3xl rounded-[var(--radius)] border border-border/60 bg-card p-3 text-sm shadow-sm"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Enter approves only from the panel itself; buttons, radios and the checkbox act on their own Enter
        // (Enter on Decline must never start paid workers). The Approve button handles its own click.
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          approve();
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (declineArmed || !rowsEdited(request.picks, rows)) props.onDecline();
          else setDeclineArmed(true);
        }
      }}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="font-medium">
          The agent wants {rows.length === 1 ? "a worker" : `${rows.length} workers`}
        </span>
        <span className="text-muted-foreground text-xs">Pick who does each task</span>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const models = modelsFor(request.catalog, row.agent);
          const efforts = effortsFor(request.catalog, row.agent, row.model);
          return (
            <li
              key={`${row.title}-${i}`}
              data-worker-pick-row={i}
              className="flex flex-col gap-1.5 rounded-md bg-foreground/[0.03] px-2 py-1.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="line-clamp-2 break-words font-medium text-foreground">
                    {row.title}
                  </div>
                  {row.why ? <div className="text-muted-foreground text-xs">{row.why}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {rows.length > 1 ? (
                    <button
                      type="button"
                      data-worker-pick-use-for-all={i}
                      className="rounded px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
                      onClick={() => useForAll(i)}
                    >
                      Use for all
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Remove ${row.title}`}
                    data-worker-pick-remove={i}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  aria-label={`${row.title}: agent`}
                  data-worker-pick-agent={i}
                  className={selectClass}
                  value={row.agent}
                  onChange={(e) => setRow(i, { agent: e.target.value })}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id} disabled={a.disabled && a.id !== row.agent}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`${row.title}: model`}
                  data-worker-pick-model={i}
                  className={cn(selectClass, "max-w-56")}
                  value={row.model ?? ""}
                  onChange={(e) => setRow(i, { model: e.target.value })}
                >
                  <option value="">CLI default</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name ?? m.id}
                    </option>
                  ))}
                  {row.model && !models.some((m) => m.id === row.model) ? (
                    <option value={row.model}>{row.model}</option>
                  ) : null}
                </select>
                {efforts.length ? (
                  <div
                    role="radiogroup"
                    aria-label={`${row.title}: effort`}
                    className="flex flex-wrap gap-0.5"
                  >
                    {efforts.map((level) => (
                      <button
                        key={level}
                        type="button"
                        role="radio"
                        aria-checked={row.effort === level}
                        data-worker-pick-effort={level}
                        className={cn(
                          "rounded px-1.5 py-0.5 text-xs",
                          row.effort === level
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() => setRow(i, { effort: row.effort === level ? "" : level })}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {unavailable.includes(i) ? (
                <div className="text-destructive text-xs" role="alert">
                  {agentLabel(row.agent)} isn't installed on this Mac. Pick another agent.
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length === 0 ? (
        <div className="py-2 text-muted-foreground text-xs">
          Every task removed — decline, or the agent does it itself.
        </div>
      ) : null}
      {declineArmed ? (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs" role="alert">
          <span className="text-muted-foreground">Decline all? Your changes will be lost.</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setDeclineArmed(false)}
            data-worker-picker-keep
          >
            Keep editing
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={props.onDecline}
            data-worker-picker-decline-confirm
          >
            Decline all
          </Button>
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <input
            type="checkbox"
            data-worker-picker-auto
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
          />
          Don't ask again in this thread
        </label>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={props.busy}
            onClick={props.onDecline}
            data-worker-picker-decline
          >
            Decline
          </Button>
          <Button
            type="button"
            size="sm"
            autoFocus
            disabled={!canApprove}
            onClick={approve}
            data-worker-picker-approve
          >
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
});
