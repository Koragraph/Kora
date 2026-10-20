// The Blobs surface's sidebar body: Kora (the Chief) pinned on top and drawn larger, MY TEAM below, a quiet Groups
// header, "+ New blob", then retired/hidden blobs. Mounted by ThreadNav in place of the Code folder tree when the
// surface switcher is on Blobs.
import { ProjectId } from "@kora/contracts";
import { hostProjectRef, hostThreadRef } from "@kora/client-runtime/host";
import type { HostThreadShell } from "@kora/client-runtime/store/models";
import { useParams, useRouter } from "@tanstack/react-router";
import { EyeIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { BlobAvatar } from "~/components/blobs/avatar";
import { useThreadSummaries } from "~/atoms/entities";
import { useStartThread } from "~/hooks/useStartThread";
import { readLocalApi } from "~/localApi";
import { threadPageParams } from "~/thread/threadRoutes";
import { cn } from "~/util/utils";
import { SidebarContent, SidebarGroup, SidebarMenu } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { ThreadRow } from "../../ThreadNav";
import { FromKoraMark } from "../chat/BlobChatHeader";
import { GroupsRoster } from "../groups/GroupsRoster";
import { ExportTeamDialog } from "../teamfile/ExportTeamDialog";
import { useTeamExportApi, useTeamOptions } from "../teamfile/useTeamApis";
import { BlobEditorDialog } from "../editor/BlobEditorDialog";
import { SpriteMotionProvider } from "~/components/sprite";
import { BlobRosterRow } from "./BlobRosterRow";
import { DeleteBlobDialog } from "./DeleteBlobDialog";
import { useBlobsApi } from "./blobsApi";
import { useBlobRoster, type RosterEntry } from "./useBlobRoster";

const THREAD_CAP = 6;
const SECTION_LABEL =
  "px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-sidebar-muted-foreground/70 uppercase";

type MenuAction =
  | "edit"
  | "duplicate"
  | "pin"
  | "unpin"
  | "hide"
  | "retire"
  | "copy-id"
  | "mark-read"
  | "share";

export function BlobsNavContent() {
  const router = useRouter();
  const api = useBlobsApi();
  const { ready, snapshot, roster, entries, hostId, markRead } = useBlobRoster();
  const threads = useThreadSummaries();
  const { openNewThread } = useStartThread();
  const routeBlobId = useParams({ strict: false, select: (p) => p.blobId as string | undefined });
  const activeThreadId = useParams({
    strict: false,
    select: (p) => p.threadId as string | undefined,
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAllThreads, setShowAllThreads] = useState<Record<string, boolean>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; blobId: string | null }>({
    open: false,
    blobId: null,
  });
  const [deleting, setDeleting] = useState<{ id: string; name: string; slug?: string } | null>(
    null,
  );
  const [sharingBlobId, setSharingBlobId] = useState<string | null>(null);
  const teamOptions = useTeamOptions();
  const teamExportApi = useTeamExportApi();
  const listRef = useRef<HTMLDivElement>(null);

  const activeBlobId = useMemo(() => {
    if (activeThreadId) {
      const t = threads.find((x) => x.id === activeThreadId);
      if (t && entries.has(t.projectId)) return t.projectId;
    }
    return routeBlobId ?? null;
  }, [activeThreadId, threads, entries, routeBlobId]);

  const openBlob = useCallback(
    (blobId: string) => {
      void router.navigate({ to: "/blobs/$blobId", params: { blobId } });
    },
    [router],
  );
  const openThread = useCallback(
    (t: HostThreadShell) => {
      void router.navigate({
        to: "/$hostId/$threadId",
        params: threadPageParams(hostThreadRef(t.hostId, t.id)),
      });
    },
    [router],
  );
  const newThread = useCallback(
    (blobId: string) => {
      if (hostId === null) return;
      setExpanded((prev) => ({ ...prev, [blobId]: true }));
      void openNewThread(hostProjectRef(hostId, ProjectId.make(blobId)));
    },
    [hostId, openNewThread],
  );
  const toggle = (blobId: string) => setExpanded((prev) => ({ ...prev, [blobId]: !prev[blobId] }));
  const openEditor = (blobId: string | null) => setEditor({ open: true, blobId });

  const fail = (message: string) => toastManager.add({ type: "error", title: message });

  const runMenu = useCallback(
    async (entry: RosterEntry, action: MenuAction) => {
      const { blob } = entry;
      switch (action) {
        case "edit":
          openEditor(blob.id);
          return;
        case "duplicate": {
          const r = await api.duplicate(blob.id);
          if (!r.ok) fail(r.message);
          return;
        }
        case "pin":
        case "unpin": {
          const r = await api.update(blob.id, { pinned: action === "pin" });
          if (!r.ok) fail(r.message);
          return;
        }
        case "hide": {
          const r = await api.update(blob.id, { hidden: true });
          if (!r.ok) fail(r.message);
          return;
        }
        case "retire": {
          const ok = await readLocalApi()?.dialogs.confirm(
            `Retire ${blob.name}? Its chats, memory and files are kept, and you can rehire it later.`,
            { confirmLabel: `Retire ${blob.name}` },
          );
          if (!ok) return;
          const r = await api.archive(blob.id);
          if (!r.ok) fail(r.message);
          return;
        }
        case "copy-id":
          try {
            await navigator.clipboard.writeText(blob.id);
            toastManager.add({ type: "success", title: "Blob id copied" });
          } catch {
            fail("Could not copy the id.");
          }
          return;
        case "mark-read":
          markRead(blob.id);
          return;
        case "share":
          setSharingBlobId(blob.id);
          return;
      }
    },
    [api, markRead],
  );

  const openMenu = useCallback(
    (entry: RosterEntry, event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const localApi = readLocalApi();
      if (!localApi) return;
      const { blob, chief } = entry;
      const items = [
        { id: "edit", label: "Edit", icon: "pencil" },
        ...(chief ? [] : [{ id: "duplicate", label: "Duplicate", icon: "copy" }]),
        ...(chief
          ? []
          : [
              blob.pinned
                ? { id: "unpin", label: "Unpin", icon: "pin-off" }
                : { id: "pin", label: "Pin", icon: "pin" },
            ]),
        ...(entry.status.unread
          ? [{ id: "mark-read", label: "Mark read", icon: "mail-open" }]
          : []),
        { id: "copy-id", label: "Copy id", icon: "hash", separatorBefore: true },
        ...(chief ? [] : [{ id: "share", label: "Share…", icon: "share" }]),
        ...(chief
          ? []
          : [
              { id: "hide", label: "Hide from sidebar", icon: "folder", separatorBefore: true },
              { id: "retire", label: "Retire…", icon: "archive", destructive: true },
            ]),
      ];
      void localApi.contextMenu
        .show(items, { x: event.clientX, y: event.clientY })
        .then((action) => {
          if (action) void runMenu(entry, action as MenuAction);
        });
    },
    [runMenu],
  );

  // Roving keyboard navigation across the rows: arrows move focus, → expands, ← collapses.
  const onRowKeyDown = (entry: RosterEntry) => (event: KeyboardEvent<HTMLElement>) => {
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-blob-row]") ?? [],
    );
    const index = rows.indexOf(event.currentTarget);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      rows[Math.min(rows.length - 1, index + 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      rows[Math.max(0, index - 1)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      rows[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      rows[rows.length - 1]?.focus();
    } else if (event.key === "ArrowRight" && !expanded[entry.blob.id]) {
      event.preventDefault();
      setExpanded((prev) => ({ ...prev, [entry.blob.id]: true }));
    } else if (event.key === "ArrowLeft" && expanded[entry.blob.id]) {
      event.preventDefault();
      setExpanded((prev) => ({ ...prev, [entry.blob.id]: false }));
    }
  };

  const renderBlob = (entry: RosterEntry) => {
    const id = entry.blob.id;
    const open = !!expanded[id];
    const all = entry.threads;
    const showAll = !!showAllThreads[id];
    const shown = showAll ? all : all.slice(0, THREAD_CAP);
    return (
      <div key={id} className={cn(entry.chief ? "mb-1" : "")}>
        <BlobRosterRow
          entry={entry}
          active={activeBlobId === id}
          expanded={open}
          onOpen={() => openBlob(id)}
          onToggle={() => toggle(id)}
          onContextMenu={(e) => openMenu(entry, e)}
          onKeyDown={onRowKeyDown(entry)}
        />
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
            open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
          aria-hidden={!open}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="mt-0.5 mb-1 ml-[22px] border-l border-sidebar-border/60 pl-1.5">
              <button
                type="button"
                tabIndex={open ? 0 : -1}
                onClick={() => newThread(id)}
                className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12.5px] text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              >
                <PlusIcon className="size-3.5 shrink-0" />
                New thread
              </button>
              {all.length === 0 ? (
                <div className="px-2 py-1.5 text-[12px] text-sidebar-muted-foreground/70">
                  No threads yet.
                </div>
              ) : (
                <SidebarMenu className="gap-0.5">
                  {shown.map(({ thread, dot }) => (
                    <ThreadRow
                      key={`${thread.hostId}:${thread.id}`}
                      thread={thread}
                      isActive={thread.id === activeThreadId}
                      projectCwd={entry.blob.workspace}
                      dot={dot}
                      onOpen={() => openThread(thread)}
                      icon={thread.origin?.kind === "kora" ? <FromKoraMark /> : null}
                    />
                  ))}
                </SidebarMenu>
              )}
              {all.length > THREAD_CAP ? (
                <button
                  type="button"
                  tabIndex={open ? 0 : -1}
                  onClick={() => setShowAllThreads((prev) => ({ ...prev, [id]: !showAll }))}
                  className="h-6 px-2 text-[11.5px] text-sidebar-muted-foreground/80 hover:text-sidebar-foreground"
                >
                  {showAll ? "Show fewer" : `Show all ${all.length}`}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const empty =
    ready && roster.chief === null && roster.team.length === 0 && roster.hidden.length === 0;

  return (
    <SpriteMotionProvider value="ambient">
      <SidebarContent>
        <SidebarGroup className="gap-0 py-1" data-blobs-roster>
          <div ref={listRef} role="navigation" aria-label="Blobs" className="flex flex-col gap-0.5">
            {!ready ? snapshot === null ? <RosterSkeleton /> : null : null}

            {roster.chief ? renderBlob(entries.get(roster.chief.id)!) : null}

            {roster.team.length > 0 ? (
              <>
                <div className={SECTION_LABEL}>My team</div>
                {roster.team.map((b) => renderBlob(entries.get(b.id)!))}
              </>
            ) : null}

            {ready && roster.chief !== null && roster.team.length === 0 ? (
              <>
                <div className={SECTION_LABEL}>My team</div>
                <div className="px-2 py-1 text-[12px] leading-snug text-sidebar-muted-foreground/75">
                  Nobody here yet. Hire a blob, or ask Kora to build one.
                </div>
              </>
            ) : null}

            {ready && !empty ? <GroupsRoster /> : null}

            {ready && !empty ? (
              <button
                type="button"
                data-new-blob
                onClick={() => openEditor(null)}
                className="mt-2 flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-[13px] font-medium text-sidebar-foreground/90 ring-1 ring-sidebar-border/70 transition-colors ring-inset hover:bg-sidebar-row-hover"
              >
                <span className="grid size-5 place-items-center rounded-full bg-sidebar-row-active">
                  <PlusIcon className="size-3.5" />
                </span>
                New blob
              </button>
            ) : null}

            {roster.hidden.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowHidden((v) => !v)}
                  className="mt-1 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] text-sidebar-muted-foreground/80 transition-colors hover:text-sidebar-foreground"
                >
                  <EyeIcon className="size-3 shrink-0" />
                  {showHidden ? "Hide hidden blobs" : `Show ${roster.hidden.length} hidden`}
                </button>
                {showHidden
                  ? roster.hidden.map((b) => (
                      <HiddenRow
                        key={b.id}
                        name={b.name}
                        onShow={async () => {
                          const r = await api.update(b.id, { hidden: false });
                          if (!r.ok) fail(r.message);
                        }}
                      />
                    ))
                  : null}
              </>
            ) : null}

            {roster.retired.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowRetired((v) => !v)}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] text-sidebar-muted-foreground/80 transition-colors hover:text-sidebar-foreground"
                >
                  <Undo2Icon className="size-3 shrink-0" />
                  {showRetired ? "Hide retired blobs" : `Retired (${roster.retired.length})`}
                </button>
                {showRetired
                  ? roster.retired.map((b) => (
                      <RetiredRow
                        key={b.id}
                        blob={b}
                        onRehire={async () => {
                          const r = await api.rehire(b.id);
                          if (!r.ok) fail(r.message);
                        }}
                        onDelete={() => setDeleting({ id: b.id, name: b.name, slug: b.slug })}
                      />
                    ))
                  : null}
              </>
            ) : null}
          </div>

          {empty ? <EmptyRoster onNew={() => openEditor(null)} /> : null}
        </SidebarGroup>
      </SidebarContent>
      <DeleteBlobDialog
        blob={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDelete={async (id, name) => {
          const r = await api.remove(id, name);
          if (r.ok)
            toastManager.add({ type: "success", title: "Deleted. The folder is in the Trash." });
          return r;
        }}
      />
      <BlobEditorDialog
        open={editor.open}
        blobId={editor.blobId}
        onOpenChange={(open) => setEditor((prev) => ({ ...prev, open }))}
      />
      {sharingBlobId ? (
        <ExportTeamDialog
          open
          onOpenChange={(open) => !open && setSharingBlobId(null)}
          blobs={teamOptions.blobs.map((b) => ({ ...b, outfit: entries.get(b.id)?.outfit ?? {} }))}
          groups={teamOptions.groups}
          koraId={teamOptions.koraId}
          onlyBlobId={sharingBlobId}
          api={teamExportApi}
        />
      ) : null}
    </SpriteMotionProvider>
  );
}

function RosterSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 px-1 pt-1" aria-busy aria-label="Loading blobs">
      {[60, 46, 46, 46].map((h, i) => (
        <div
          key={i}
          style={{ height: h }}
          className="animate-pulse rounded-xl bg-sidebar-row-hover/60"
        />
      ))}
    </div>
  );
}

function EmptyRoster({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 pt-8 pb-4 text-center" data-blobs-empty>
      <BlobAvatar state="idle" size={96} reaction="wave" label="A blob waving" />
      <div className="text-[14px] font-medium text-sidebar-foreground">No blobs yet</div>
      <p className="max-w-[210px] text-[12px] leading-snug text-sidebar-muted-foreground">
        Blobs are coworkers that remember you. Make your first one.
      </p>
      <button
        type="button"
        onClick={onNew}
        className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-full bg-sidebar-foreground px-3 text-[12.5px] font-medium text-sidebar transition-opacity hover:opacity-90"
      >
        <PlusIcon className="size-3.5" />
        New blob
      </button>
    </div>
  );
}

function HiddenRow(props: { name: string; onShow: () => void }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] text-sidebar-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{props.name}</span>
      <button
        type="button"
        onClick={props.onShow}
        className="rounded-md px-1.5 py-0.5 text-[11px] hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        Show
      </button>
    </div>
  );
}

function RetiredRow(props: {
  blob: { name: string; title: string };
  onRehire: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex min-h-9 items-center gap-2 rounded-md px-2 py-1 text-[12.5px] text-sidebar-muted-foreground">
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{props.blob.name}</span>
        {props.blob.title ? (
          <span className="truncate text-[11px] opacity-70">{props.blob.title}</span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={props.onRehire}
        className="rounded-md bg-sidebar-row-hover px-2 py-0.5 text-[11px] text-sidebar-foreground transition-colors hover:bg-sidebar-row-active"
      >
        Rehire
      </button>
      <button
        type="button"
        onClick={props.onDelete}
        aria-label={`Delete ${props.blob.name} permanently`}
        className="rounded-md px-1.5 py-0.5 text-[11px] text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-destructive-foreground"
      >
        Delete…
      </button>
    </div>
  );
}
