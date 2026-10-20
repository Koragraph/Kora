// One row under GROUPS: "# name", the member avatar stack, an unread dot. Same row grammar as BlobRosterRow (a single
// button, hover/active backgrounds), so the two lists feel like one.
import type { KeyboardEvent, MouseEvent } from "react";

import { cn } from "~/util/utils";
import { groupAriaLabel, type GroupMember, type GroupWire } from "./groupModel";
import { MemberStack } from "./MemberStack";

export function GroupRosterRow(props: {
  readonly group: GroupWire;
  readonly members: ReadonlyArray<GroupMember>;
  readonly active: boolean;
  readonly unread: number;
  /** Somebody in the group is answering right now. */
  readonly busy?: boolean | undefined;
  readonly onOpen: () => void;
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined;
  readonly onKeyDown?: ((event: KeyboardEvent<HTMLElement>) => void) | undefined;
}) {
  const { group, active, unread } = props;
  return (
    <div
      className={cn(
        "group/grp relative flex min-h-[40px] items-center rounded-xl transition-colors",
        active
          ? "bg-sidebar-row-active text-sidebar-foreground lift-select"
          : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
      )}
      onContextMenu={props.onContextMenu}
      data-group-id={group.id}
    >
      <button
        type="button"
        data-group-row
        aria-current={active ? "true" : undefined}
        aria-label={groupAriaLabel(group, props.members, unread)}
        onClick={props.onOpen}
        onKeyDown={props.onKeyDown}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl py-1.5 pr-2.5 pl-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className="w-3 shrink-0 text-center text-[15px] leading-none font-medium text-sidebar-muted-foreground"
        >
          #
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13.5px]",
            unread > 0 ? "font-semibold text-sidebar-foreground" : "font-medium",
          )}
        >
          {group.name}
        </span>
        {props.busy ? (
          <span
            aria-hidden
            data-group-busy
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-sidebar-foreground/70"
          />
        ) : null}
        <MemberStack members={props.members} size={20} limit={3} />
        {unread > 0 ? (
          <span
            data-group-unread={unread}
            className="grid h-[17px] min-w-[17px] shrink-0 place-items-center rounded-full bg-sidebar-foreground px-1 text-[10px] font-semibold text-sidebar tabular-nums"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
    </div>
  );
}
