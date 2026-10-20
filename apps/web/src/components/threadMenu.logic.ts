import type { ContextMenuItem } from "@kora/contracts";
import type { SnoozePreset } from "@kora/client-runtime/store/thread-settled";

type ThreadCopyMenuId = "copy" | "copy-path" | "copy-branch" | "copy-thread-id";
type ThreadSnoozeMenuId = "snooze" | `snooze:${string}` | "unsnooze";

export type ThreadActionMenuId =
  | ThreadSnoozeMenuId
  | ThreadCopyMenuId
  | "archive"
  | "delete"
  | "mark-unread"
  | "new-thread-on-branch"
  | "pin"
  | "unpin"
  | "project-settings"
  | "regenerate-title"
  | "rename"
  | "settle"
  | "unsettle";

export interface ThreadActionMenuState {
  readonly supports: {
    readonly titleRegeneration: boolean;
    readonly settlement: boolean;
    readonly pinning: boolean;
    readonly snooze: boolean;
  };
  /** Archiving is refused while a turn is active. */
  readonly isRunning: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  readonly isRegeneratingTitle: boolean;
  readonly surface?: "blobs" | "code";
  readonly canSnoozeNow: boolean;
  readonly branch: string | null;
  readonly isSnoozed: boolean;
  readonly isSettled: boolean;
  readonly isPinned: boolean;
}

type Item = ContextMenuItem<ThreadActionMenuId>;

/** The one list both the sidebar row menu and the chat header menu show. */
export function buildThreadActionMenuItems(state: ThreadActionMenuState): ReadonlyArray<Item> {
  const items: Item[] = [];
  const blobs = state.surface === "blobs";

  if (state.branch) {
    items.push({
      id: "new-thread-on-branch",
      label: `New chat on ${state.branch}`,
      icon: "message-square-plus",
    });
  }

  if (state.supports.pinning) {
    items.push(
      state.isPinned
        ? { id: "unpin", label: "Unpin chat", icon: "pin-off" }
        : { id: "pin", label: "Pin chat", icon: "pin" },
    );
  }

  if (state.supports.settlement) {
    items.push(
      state.isSettled
        ? { id: "unsettle", label: "Reopen chat", icon: "circle-check" }
        : { id: "settle", label: "Mark done", icon: "circle-check" },
    );
  }

  if (state.supports.snooze) {
    if (state.isSnoozed) {
      items.push({ id: "unsnooze", label: "Bring back now", icon: "clock" });
    } else {
      items.push({
        disabled: !state.canSnoozeNow,
        icon: "clock",
        label: "Snooze",
        id: "snooze",
        children: [
          ...state.snoozePresets.map((preset): Item => ({
            id: `snooze:${preset.id}`,
            label: `${preset.label} (${preset.whenLabel})`,
          })),
          { id: "snooze:custom", label: "Custom…", separatorBefore: true },
        ],
      });
    }
  }

  items.push({ id: "rename", label: "Rename chat", icon: "pencil", separatorBefore: true });

  if (state.supports.titleRegeneration) {
    items.push({
      label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
      disabled: state.isRegeneratingTitle,
      id: "regenerate-title",
      icon: "refresh-cw",
    });
  }

  items.push({ id: "mark-unread", label: "Mark unread", icon: "mail-open" });

  items.push({
    children: [
      { id: "copy-path", label: "Path", icon: "folder" },
      ...(state.branch
        ? [{ id: "copy-branch", label: "Branch", icon: "git-branch" } satisfies Item]
        : []),
      { id: "copy-thread-id", label: "Chat ID", icon: "hash" },
    ],
    separatorBefore: true,
    label: "Copy",
    icon: "copy",
    id: "copy",
  });

  items.push({
    id: "project-settings",
    label: blobs ? "Blob settings" : "Project settings",
    icon: "settings",
  });

  items.push({
    id: "archive",
    // While a turn runs the label says why Archive is off; Delete stops the turn itself.
    label: state.isRunning ? "Archive (stop the turn first)" : blobs ? "Archive" : "Archive chat",
    icon: "archive",
    separatorBefore: true,
    disabled: state.isRunning,
  });

  items.push({ id: "delete", label: "Delete", icon: "trash", destructive: true });
  return items;
}
