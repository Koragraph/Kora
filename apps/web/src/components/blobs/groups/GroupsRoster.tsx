// The GROUPS block of the Blobs sidebar, wired: the live groups, each row's unread / busy state from its threads, the
// create / edit dialog, the row menu (Edit, New thread, Share, Pin, Mark read, Archive, Delete) and the team-file dialogs.
// BlobsNavContent mounts this in place of the old placeholder; everything else here is self-contained.
import { ProjectId } from "@kora/contracts";
import { hostProjectRef, hostThreadRef, hostThreadKey } from "@kora/client-runtime/host";
import type { HostThreadShell } from "@kora/client-runtime/store/models";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { useThreadSummaries } from "~/atoms/entities";
import { usePrimaryHostId } from "~/atoms/hosts";
import { useStartThread } from "~/hooks/useStartThread";
import { readLocalApi } from "~/localApi";
import { useViewStateStore } from "~/stores/uiStateStore";
import { threadPageParams } from "~/thread/threadRoutes";
import { resolveThreadDot } from "../../ThreadNav.logic";
import { toastManager } from "../../ui/toast";
import { ExportTeamDialog } from "../teamfile/ExportTeamDialog";
import { ImportTeamDialog } from "../teamfile/ImportTeamDialog";
import { useTeamExportApi, useTeamImportApi, useTeamOptions } from "../teamfile/useTeamApis";
import { announceBlobCreated } from "../shell/blobReaction";
import { CreateGroupDialog, type GroupSubmitResult } from "./CreateGroupDialog";
import { DeleteGroupDialog } from "./DeleteGroupDialog";
import { GroupsSection } from "./GroupsSection";
import { groupMembers, orderGroups, type GroupDraft, type GroupWire } from "./groupModel";
import { useGroupMembers, useGroupsApi, useGroupsState } from "./useGroups";

type MenuAction =
  | "edit"
  | "new-thread"
  | "share"
  | "pin"
  | "unpin"
  | "mark-read"
  | "archive"
  | "delete";

/** Folder label for the dialog's footnote: "~/Blobs/_groups/launch-week" (the daemon picks the real slug). */
const folderLabel = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `Blobs/_groups/${slug || "group"}`;
};

export function GroupsRoster() {
  const router = useRouter();
  const { groups, ready } = useGroupsState();
  const { members, byId } = useGroupMembers();
  const api = useGroupsApi();
  const threads = useThreadSummaries();
  const { openNewThread } = useStartThread();
  const hostId = usePrimaryHostId();
  const lastVisitedAtById = useViewStateStore((state) => state.threadLastVisitedAtById);
  const markThreadVisited = useViewStateStore((state) => state.markThreadVisited);
  const routeBlobId = useParams({ strict: false, select: (p) => p.blobId as string | undefined });
  const activeThreadId = useParams({
    strict: false,
    select: (p) => p.threadId as string | undefined,
  });
  const team = useTeamOptions();
  const exportApi = useTeamExportApi();
  const importApi = useTeamImportApi();
  const [editor, setEditor] = useState<{ open: boolean; group: GroupWire | null }>({
    open: false,
    group: null,
  });
  const [deleting, setDeleting] = useState<GroupWire | null>(null);
  const [sharing, setSharing] = useState(false);
  const [importing, setImporting] = useState(false);

  const visible = useMemo(() => orderGroups(groups), [groups]);
  const groupThreads = useMemo(() => {
    const map = new Map<string, HostThreadShell[]>();
    for (const t of threads) {
      if (t.archivedAt || !t.projectId.startsWith("group_")) continue;
      (map.get(t.projectId) ?? map.set(t.projectId, []).get(t.projectId)!).push(t);
    }
    for (const list of map.values())
      list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return map;
  }, [threads]);

  const { unreadByGroup, busyGroupIds } = useMemo(() => {
    const unread = new Map<string, number>();
    const busy = new Set<string>();
    for (const [gid, list] of groupThreads) {
      let n = 0;
      for (const t of list) {
        const dot = resolveThreadDot(
          t,
          lastVisitedAtById[hostThreadKey(hostThreadRef(t.hostId, t.id))],
          false,
        );
        if (
          dot.tone === "unread" ||
          dot.tone === "approval" ||
          dot.tone === "input" ||
          dot.tone === "failed"
        )
          n += 1;
        if (dot.tone === "working") busy.add(gid);
      }
      if (n > 0) unread.set(gid, n);
    }
    return { unreadByGroup: unread, busyGroupIds: busy };
  }, [groupThreads, lastVisitedAtById]);

  const activeGroupId = useMemo(() => {
    if (activeThreadId) {
      const t = threads.find((x) => x.id === activeThreadId);
      if (t && t.projectId.startsWith("group_")) return t.projectId;
    }
    return routeBlobId?.startsWith("group_") ? routeBlobId : null;
  }, [activeThreadId, threads, routeBlobId]);

  const open = useCallback(
    (groupId: string) => {
      void router.navigate({ to: "/blobs/$blobId", params: { blobId: groupId } });
    },
    [router],
  );
  const newThread = useCallback(
    (groupId: string) => {
      if (hostId === null) return;
      void openNewThread(hostProjectRef(hostId, ProjectId.make(groupId)));
    },
    [hostId, openNewThread],
  );
  const fail = (message: string) => toastManager.add({ type: "error", title: message });

  const submit = useCallback(
    async (draft: GroupDraft, groupId: string | null): Promise<GroupSubmitResult> => {
      const r = groupId ? await api.update(groupId, draft) : await api.create(draft);
      if (!r.ok) return { ok: false, message: r.message };
      if (!groupId) open(r.value.id);
      return { ok: true };
    },
    [api, open],
  );

  const runMenu = useCallback(
    async (group: GroupWire, action: MenuAction) => {
      switch (action) {
        case "edit":
          setEditor({ open: true, group });
          return;
        case "new-thread":
          newThread(group.id);
          return;
        case "share":
          setSharing(true);
          return;
        case "pin":
        case "unpin": {
          const r = await api.update(group.id, { pinned: action === "pin" });
          if (!r.ok) fail(r.message);
          return;
        }
        case "mark-read": {
          const now = new Date().toISOString();
          for (const t of groupThreads.get(group.id) ?? [])
            markThreadVisited(hostThreadKey(hostThreadRef(t.hostId, t.id)), now);
          return;
        }
        case "archive": {
          const ok = await readLocalApi()?.dialogs.confirm(
            `Archive ${group.name}? Its chats and folder are kept, and Popo, Junip and the rest are not affected.`,
            { confirmLabel: "Archive" },
          );
          if (!ok) return;
          const r = await api.archive(group.id);
          if (!r.ok) fail(r.message);
          return;
        }
        case "delete":
          setDeleting(group);
          return;
      }
    },
    [api, groupThreads, markThreadVisited, newThread],
  );

  const openMenu = useCallback(
    (groupId: string, event: React.MouseEvent) => {
      const group = groups.find((g) => g.id === groupId);
      const localApi = readLocalApi();
      if (!group || !localApi) return;
      event.preventDefault();
      event.stopPropagation();
      const items = [
        { id: "edit", label: "Edit", icon: "pencil" },
        { id: "new-thread", label: "New thread", icon: "plus" },
        group.pinned
          ? { id: "unpin", label: "Unpin", icon: "pin-off" }
          : { id: "pin", label: "Pin", icon: "pin" },
        ...((unreadByGroup.get(group.id) ?? 0) > 0
          ? [{ id: "mark-read", label: "Mark read", icon: "mail-open" }]
          : []),
        { id: "share", label: "Share team…", icon: "share", separatorBefore: true },
        { id: "archive", label: "Archive…", icon: "archive", separatorBefore: true },
        { id: "delete", label: "Delete…", icon: "trash", destructive: true },
      ];
      void localApi.contextMenu
        .show(items, { x: event.clientX, y: event.clientY })
        .then((action) => {
          if (action) void runMenu(group, action as MenuAction);
        });
    },
    [groups, runMenu, unreadByGroup],
  );

  if (!ready && groups.length === 0 && members.length === 0) return null;
  return (
    <>
      <GroupsSection
        groups={visible}
        membersById={byId}
        activeGroupId={activeGroupId}
        unreadByGroup={unreadByGroup}
        busyGroupIds={busyGroupIds}
        canCreate={members.length >= 2}
        onOpen={open}
        onNew={() => setEditor({ open: true, group: null })}
        onContextMenu={openMenu}
      />
      <div className="mt-1 flex items-center gap-1 px-1" data-team-actions>
        <button
          type="button"
          data-share-team
          onClick={() => setSharing(true)}
          className="h-7 rounded-md px-2 text-[11.5px] text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          Share team
        </button>
        <span aria-hidden className="text-[11px] text-sidebar-muted-foreground/50">
          ·
        </span>
        <button
          type="button"
          data-import-team
          onClick={() => setImporting(true)}
          className="h-7 rounded-md px-2 text-[11.5px] text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          Import team
        </button>
      </div>
      <CreateGroupDialog
        open={editor.open}
        onOpenChange={(o) => setEditor((p) => ({ ...p, open: o }))}
        members={members}
        existingNames={visible.map((g) => g.name)}
        group={editor.group}
        folderLabel={folderLabel}
        onSubmit={submit}
      />
      <DeleteGroupDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDelete={async (id, name) => {
          const r = await api.remove(id, name);
          if (r.ok) {
            toastManager.add({
              type: "success",
              title: "Deleted. The shared folder is in the Trash.",
            });
            if (activeGroupId === id) void router.navigate({ to: "/blobs" });
          }
          return r;
        }}
      />
      <ExportTeamDialog
        open={sharing}
        onOpenChange={setSharing}
        blobs={team.blobs.map((b) => ({ ...b, outfit: byId.get(b.id)?.outfit ?? {} }))}
        groups={team.groups}
        koraId={team.koraId}
        api={exportApi}
      />
      <ImportTeamDialog
        open={importing}
        onOpenChange={setImporting}
        api={importApi}
        onImported={(result) => {
          for (const b of result.blobs) announceBlobCreated(b.id);
          const g = result.groups[0];
          if (g) open(g.id);
        }}
      />
    </>
  );
}
