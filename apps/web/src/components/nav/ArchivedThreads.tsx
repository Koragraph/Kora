// "Archived (N)" at the bottom of the sidebar: the only way back from an archive. Expands to the
// archived threads (the daemon's getArchivedShellSnapshot), each with an Unarchive control. The
// daemon pushes the unarchived thread's shell on the live stream, so it reappears in its folder
// without a reload; the archived snapshot is refreshed by useThreadCommands.unarchiveThread.
import { Hint } from "~/components/ui/hint";
import { useMemo, useState } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, ChevronRightIcon, Trash2Icon } from "lucide-react";
import { hostThreadRef } from "@kora/client-runtime/host";
import { isAtomActionInterrupted } from "@kora/client-runtime/store/runtime";
import type { HostId, ThreadId } from "@kora/contracts";

import { cn } from "../../util/utils";
import { useArchivedThreadSnapshots } from "../../util/archivedThreadsState";
import { useThreadCommands } from "../../hooks/useThreadCommands";
import { usePrimaryHostId } from "../../atoms/hosts";
import { toastManager } from "../ui/toast";

export interface ArchivedThreadEntry {
  readonly hostId: HostId;
  readonly id: ThreadId;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly archivedAt: string;
}

/** Flattens the per-host archived snapshots into rows, most recently archived first. */
export function listArchivedThreads(
  snapshots: ReadonlyArray<{
    readonly hostId: HostId;
    readonly snapshot: {
      readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly projectId: string;
        readonly title: string;
        readonly archivedAt: string | null;
      }>;
    };
  }>,
): ArchivedThreadEntry[] {
  const rows: ArchivedThreadEntry[] = [];
  for (const { hostId, snapshot } of snapshots) {
    const projectTitles = new Map(snapshot.projects.map((p) => [p.id, p.title] as const));
    for (const t of snapshot.threads) {
      if (!t.archivedAt) continue;
      rows.push({
        hostId,
        id: t.id,
        title: t.title,
        projectTitle: projectTitles.get(t.projectId) ?? null,
        archivedAt: t.archivedAt,
      });
    }
  }
  return rows.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1));
}

export function ArchivedThreads() {
  const primaryHostId = usePrimaryHostId();
  const hostIds = useMemo(() => (primaryHostId ? [primaryHostId] : []), [primaryHostId]);
  const { snapshots, refresh } = useArchivedThreadSnapshots(hostIds);
  const { unarchiveThread, confirmAndDeleteThread } = useThreadCommands();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const rows = useMemo(() => listArchivedThreads(snapshots), [snapshots]);
  if (rows.length === 0) return null;

  const unarchive = async (row: ArchivedThreadEntry) => {
    const key = `${row.hostId}:${row.id}`;
    setPending((prev) => new Set(prev).add(key));
    const result = await unarchiveThread(hostThreadRef(row.hostId, row.id));
    setPending((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
      toastManager.add({ type: "error", title: "Failed to unarchive chat" });
    }
  };

  // An archived thread could only be deleted after unarchiving it first. The delete confirm is the same as the sidebar's.
  const remove = async (row: ArchivedThreadEntry) => {
    const key = `${row.hostId}:${row.id}`;
    setPending((prev) => new Set(prev).add(key));
    const result = await confirmAndDeleteThread(hostThreadRef(row.hostId, row.id));
    setPending((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
      toastManager.add({ type: "error", title: "Failed to delete chat" });
    }
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) refresh();
          setOpen((v) => !v);
        }}
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[11px] text-sidebar-muted-foreground/80 transition-colors hover:text-sidebar-foreground"
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <ArchiveIcon className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{`Archived (${rows.length})`}</span>
      </button>
      {open ? (
        <ul
          aria-label="Archived chats"
          className="ml-[13px] flex flex-col gap-0.5 border-l border-sidebar-border/60 pl-1.5"
        >
          {rows.map((row) => {
            const key = `${row.hostId}:${row.id}`;
            return (
              <li
                key={key}
                data-archived-thread={row.id}
                className="group/archived flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-sidebar-muted-foreground hover:bg-sidebar-row-hover"
              >
                <span className="min-w-0 flex-1 truncate">
                  {row.title}
                  {row.projectTitle ? (
                    <span className="text-sidebar-muted-foreground/60">{` · ${row.projectTitle}`}</span>
                  ) : null}
                </span>
                <Hint label="Unarchive">
                  <button
                    type="button"
                    aria-label={`Unarchive ${row.title}`}
                    disabled={pending.has(key)}
                    onClick={() => void unarchive(row)}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-active hover:text-sidebar-foreground disabled:opacity-50"
                  >
                    <ArchiveRestoreIcon className="size-3.5" />
                  </button>
                </Hint>
                <Hint label="Delete">
                  <button
                    type="button"
                    aria-label={`Delete ${row.title}`}
                    disabled={pending.has(key)}
                    onClick={() => void remove(row)}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-active hover:text-sidebar-foreground disabled:opacity-50"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </Hint>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
