import { memo, useCallback, useEffect, useState } from "react";
import type { FleetWorker, HostThreadRef } from "@kora/contracts";

import { cn } from "~/util/utils";
import { fetchPrimaryHost } from "../../hosts/primary/shellAuth";
import { useHostHttpBaseUrl } from "../../atoms/hosts";
import { Button } from "../ui/button";

interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  at?: string;
}
interface WorkerHistory {
  record: {
    recordId: string;
    status: "awake" | "asleep";
    title: string;
    agent: string;
    prompt: string | null;
    finalReport: string | null;
    sleptAt: number | null;
    changes: { ahead: number; files: string[]; autoCommitted: boolean } | null;
    worktree: { branch: string } | null;
    branchKept: boolean;
    session: { id: string | null };
  };
  entries: TranscriptEntry[];
}

/** Wakes a sleeping worker (`POST /api/workers/wake`, same session resumed). Resolves to an error message, or null. */
export async function wakeWorkerRecord(
  httpBaseUrl: string,
  recordId: string,
): Promise<string | null> {
  try {
    const url = new URL("/api/workers/wake", httpBaseUrl);
    url.searchParams.set("recordId", recordId);
    const res = await fetchPrimaryHost(url.toString(), { method: "POST" });
    const body = (await res.json()) as { ok?: boolean; reason?: string };
    return body.ok ? null : `Couldn't wake it: ${body.reason ?? res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * A worker's history — what it was asked, what it answered, what it changed and its whole CLI transcript — for a
 * worker that went to sleep after work (no process, no folder; its work kept on its branch) or any recorded worker.
 * `GET /api/workers/transcript?recordId=`; Wake = `POST /api/workers/wake` (same session resumed).
 */
export const WorkerHistoryView = memo(function WorkerHistoryView(props: {
  threadRef: HostThreadRef;
  worker: FleetWorker;
  className?: string;
}) {
  const { worker } = props;
  const httpBaseUrl = useHostHttpBaseUrl(props.threadRef.hostId);
  const recordId = worker.recordId ?? null;
  const [history, setHistory] = useState<WorkerHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);

  const load = useCallback(async () => {
    if (!httpBaseUrl || !recordId) return;
    try {
      const url = new URL("/api/workers/transcript", httpBaseUrl);
      url.searchParams.set("recordId", recordId);
      const res = await fetchPrimaryHost(url.toString());
      const body = (await res.json()) as { ok?: boolean; reason?: string } & Partial<WorkerHistory>;
      if (!body.ok || !body.record) setError(body.reason ?? "No history for this worker.");
      else setHistory({ record: body.record, entries: body.entries ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [httpBaseUrl, recordId]);

  useEffect(() => {
    void load();
  }, [load, worker.state]);

  const wake = async () => {
    if (!httpBaseUrl || !recordId) return;
    setWaking(true);
    setError(null);
    try {
      setError(await wakeWorkerRecord(httpBaseUrl, recordId));
    } finally {
      setWaking(false);
    }
  };

  if (!recordId)
    return (
      <div className={cn("p-3 text-muted-foreground text-xs", props.className)}>
        This worker has no record (it started before history was kept).
      </div>
    );

  const r = history?.record;
  const asleep = worker.state === "asleep";
  return (
    <div
      data-worker-history={recordId}
      className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto p-3 text-sm", props.className)}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-muted-foreground text-xs">
          {asleep ? (
            <>
              Asleep{r?.sleptAt ? ` since ${new Date(r.sleptAt).toLocaleTimeString()}` : ""} — no
              process{r?.worktree ? ", no folder" : ""}.
              {r?.changes?.ahead
                ? ` ${r.changes.ahead} commit(s) on ${r.branchKept && r.worktree ? r.worktree.branch : "(branch deleted)"}${r.changes.autoCommitted ? " (edits auto-saved)" : ""}.`
                : r?.worktree
                  ? " It changed nothing."
                  : // A shared-checkout worker edits the project folder directly: Kora cannot tell its edits
                    // from anyone else's, so never claim it changed nothing (live: it had just added centsToWords).
                    " It worked in the shared checkout; its edits are in the project folder."}
            </>
          ) : (
            "Transcript so far"
          )}
        </div>
        {asleep ? (
          <Button
            type="button"
            size="sm"
            disabled={waking}
            onClick={wake}
            data-worker-wake={recordId}
          >
            {waking ? "Waking…" : r?.session.id ? "Wake (resume session)" : "Wake"}
          </Button>
        ) : null}
      </div>
      {error ? <div className="mb-2 text-destructive text-xs">{error}</div> : null}
      {r?.finalReport ? (
        <section className="mb-3">
          <div className="mb-1 font-medium text-xs">Final answer</div>
          <div className="whitespace-pre-wrap rounded-md bg-foreground/[0.04] p-2 text-xs leading-5">
            {r.finalReport}
          </div>
        </section>
      ) : null}
      {r?.changes?.files.length ? (
        <section className="mb-3">
          <div className="mb-1 font-medium text-xs">Changed files</div>
          <ul className="text-muted-foreground text-xs leading-5">
            {r.changes.files.slice(0, 30).map((f) => (
              <li key={f} className="truncate font-mono">
                {f}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <div className="mb-1 font-medium text-xs">Transcript</div>
        {!history ? (
          <div className="text-muted-foreground text-xs">Loading…</div>
        ) : history.entries.length === 0 ? (
          <div className="text-muted-foreground text-xs">
            No transcript found for this worker's CLI session.
          </div>
        ) : (
          <ol className="flex flex-col gap-1.5" data-worker-transcript>
            {history.entries.map((e, i) => (
              <li key={i} className="text-xs leading-5">
                <span
                  className={cn(
                    "mr-1.5 rounded px-1 py-0.5 font-medium text-[10px] uppercase",
                    e.role === "assistant"
                      ? "bg-foreground/10"
                      : e.role === "tool"
                        ? "text-muted-foreground"
                        : "bg-foreground/5",
                  )}
                >
                  {e.role}
                </span>
                <span
                  className={cn(
                    "whitespace-pre-wrap",
                    e.role === "tool" && "font-mono text-muted-foreground",
                  )}
                >
                  {e.text.length > 2000 ? `${e.text.slice(0, 2000)}…` : e.text}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
});
