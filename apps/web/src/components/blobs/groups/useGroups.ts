// Group chats on the web: the live group list (`blobs.groups.subscribe`), the members a group can draw avatars for, and the
// promise-returning actions behind the create / edit dialog and the roster menu. Components never touch atoms; they await
// these and show the message on failure.
import { blobsHost as shared } from "~/atoms/blobs";
import { usePrimaryHostId } from "~/atoms/hosts";
import { useHostQuery } from "~/atoms/query";
import { useAtomAction } from "~/atoms/use-atom-command";
import { createHostRpcCommand } from "@kora/client-runtime/store/runtime";
import { RPC_METHODS } from "@kora/contracts";
import { useMemo } from "react";

import { daemonAtomRuntime } from "~/link/runtime";
import { COMMAND_OPTIONS, useBlobRun, type ApiResult } from "../cards/blobCommand";
import { useBlobRoster } from "../shell/useBlobRoster";
import type { GroupDraft, GroupMember, GroupWire } from "./groupModel";

const cmd = <T extends Parameters<typeof createHostRpcCommand>[1]["tag"]>(name: string, tag: T) =>
  createHostRpcCommand(daemonAtomRuntime, { label: `blobs:groups:${name}`, tag });
const createCmd = cmd("create", RPC_METHODS.blobsGroupsCreate);
const updateCmd = cmd("update", RPC_METHODS.blobsGroupsUpdate);
const archiveCmd = cmd("archive", RPC_METHODS.blobsGroupsArchive);
const deleteCmd = cmd("delete", RPC_METHODS.blobsGroupsDelete);

const EMPTY: ReadonlyArray<GroupWire> = [];

export interface GroupsState {
  /** False until the first frame (render nothing, not "no groups"). */
  readonly ready: boolean;
  /** Archived groups included; the roster filters them (`orderGroups`). */
  readonly groups: ReadonlyArray<GroupWire>;
}

/** The live list. Every consumer shares one subscription (atom family, 60 s idle TTL). */
export function useGroupsState(): GroupsState {
  const hostId = usePrimaryHostId();
  const query = useHostQuery(hostId === null ? null : shared.groups({ hostId, input: {} }));
  const data = query.data as { groups: ReadonlyArray<GroupWire> } | null | undefined;
  return { ready: data != null, groups: data?.groups ?? EMPTY };
}

/** Active blobs as group members (Kora first), keyed by id. Retired blobs are not offered; a retired member's old messages still render. */
export function useGroupMembers(): {
  readonly members: ReadonlyArray<GroupMember>;
  readonly byId: ReadonlyMap<string, GroupMember>;
} {
  const { roster, entries } = useBlobRoster();
  return useMemo(() => {
    const ordered = [...(roster.chief ? [roster.chief] : []), ...roster.team, ...roster.hidden];
    const members: GroupMember[] = [];
    for (const b of ordered) {
      const e = entries.get(b.id);
      if (!e) continue;
      members.push({ id: b.id, name: b.name, title: b.title, outfit: e.outfit, chief: e.chief });
    }
    const byId = new Map<string, GroupMember>(members.map((m) => [m.id, m]));
    // retired blobs still need a face for their old messages
    for (const [id, e] of entries)
      if (!byId.has(id))
        byId.set(id, {
          id,
          name: e.blob.name,
          title: e.blob.title,
          outfit: e.outfit,
          chief: e.chief,
        });
    return { members, byId };
  }, [roster, entries]);
}

export interface GroupsApi {
  create: (draft: GroupDraft) => Promise<ApiResult<GroupWire>>;
  update: (
    id: string,
    draft: Partial<GroupDraft> & { pinned?: boolean },
  ) => Promise<ApiResult<GroupWire>>;
  archive: (id: string) => Promise<ApiResult<GroupWire>>;
  remove: (id: string, confirmName: string) => Promise<ApiResult<object>>;
}

export function useGroupsApi(): GroupsApi {
  const { run } = useBlobRun();
  const create = useAtomAction(createCmd, COMMAND_OPTIONS);
  const update = useAtomAction(updateCmd, COMMAND_OPTIONS);
  const archive = useAtomAction(archiveCmd, COMMAND_OPTIONS);
  const remove = useAtomAction(deleteCmd, COMMAND_OPTIONS);
  return useMemo<GroupsApi>(
    () => ({
      create: (d) =>
        run("Could not create the group.", (h) =>
          create({
            hostId: h,
            input: {
              name: d.name.trim(),
              memberIds: [...d.memberIds],
              leadId: d.leadId,
              rule: d.rule,
              instructions: d.instructions.trim(),
            },
          }),
        ) as never,
      update: (id, d) =>
        run("Could not save the group.", (h) =>
          update({
            hostId: h,
            input: {
              id,
              patch: {
                ...(d.name !== undefined ? { name: d.name.trim() } : {}),
                ...(d.memberIds !== undefined ? { memberIds: [...d.memberIds] } : {}),
                ...(d.leadId !== undefined ? { leadId: d.leadId } : {}),
                ...(d.rule !== undefined ? { rule: d.rule } : {}),
                ...(d.instructions !== undefined ? { instructions: d.instructions.trim() } : {}),
                ...(d.pinned !== undefined ? { pinned: d.pinned } : {}),
              },
            },
          }),
        ) as never,
      archive: (id) =>
        run("Could not archive the group.", (h) => archive({ hostId: h, input: { id } })) as never,
      remove: (id, confirmName) =>
        run("Could not delete the group.", (h) =>
          remove({ hostId: h, input: { id, confirmName } }),
        ) as never,
    }),
    [run, create, update, archive, remove],
  );
}
