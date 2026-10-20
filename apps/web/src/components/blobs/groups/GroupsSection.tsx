// The GROUPS block of the roster: replaces the "coming soon" placeholder in BlobsNavContent. The section label keeps the
// sidebar's own SECTION_LABEL look; a quiet "+ New group" sits at the end of the list.
import { PlusIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { cn } from "~/util/utils";
import { GroupRosterRow } from "./GroupRosterRow";
import { groupMembers, orderGroups, type GroupMember, type GroupWire } from "./groupModel";

const GROUPS_SECTION_LABEL =
  "px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-sidebar-muted-foreground/70 uppercase";

export function GroupsSection(props: {
  readonly groups: ReadonlyArray<GroupWire>;
  readonly membersById: ReadonlyMap<string, GroupMember>;
  readonly activeGroupId: string | null;
  readonly unreadByGroup: ReadonlyMap<string, number>;
  readonly busyGroupIds?: ReadonlySet<string>;
  /** Fewer than two blobs exist: a group is impossible yet. */
  readonly canCreate: boolean;
  readonly onOpen: (groupId: string) => void;
  readonly onNew: () => void;
  readonly onContextMenu?: (groupId: string, event: MouseEvent) => void;
  readonly onRowKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const rows = orderGroups(props.groups);
  return (
    <div data-groups-section>
      <div className={GROUPS_SECTION_LABEL}>Groups</div>
      {rows.length === 0 ? (
        <div
          className="px-2 py-1 text-[12px] leading-snug text-sidebar-muted-foreground/75"
          data-groups-empty
        >
          {props.canCreate
            ? "Put several blobs in one conversation."
            : "Hire a second blob to start a group."}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {rows.map((g) => (
            <GroupRosterRow
              key={g.id}
              group={g}
              members={groupMembers(g, props.membersById)}
              active={props.activeGroupId === g.id}
              unread={props.unreadByGroup.get(g.id) ?? 0}
              busy={props.busyGroupIds?.has(g.id) ?? false}
              onOpen={() => props.onOpen(g.id)}
              onContextMenu={props.onContextMenu ? (e) => props.onContextMenu!(g.id, e) : undefined}
              onKeyDown={props.onRowKeyDown}
            />
          ))}
        </div>
      )}
      {props.canCreate ? (
        <button
          type="button"
          data-new-group
          onClick={props.onNew}
          className={cn(
            "mt-1 flex h-8 w-full items-center gap-2 rounded-xl px-2 text-left text-[12.5px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          )}
        >
          <PlusIcon className="size-3.5" aria-hidden />
          New group
        </button>
      ) : null}
    </div>
  );
}
