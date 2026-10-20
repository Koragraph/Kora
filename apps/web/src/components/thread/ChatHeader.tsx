import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumbItem, SurfaceBreadcrumb } from "../SurfaceBreadcrumb";
import { isTrailingDoubleClick } from "../NavRows.logic";
import { readLocalApi } from "../../localApi";
import { useThreadMenu } from "../../hooks/useThreadMenu";
import { useAtomAction } from "../../atoms/use-atom-command";
import { threadHost } from "../../atoms/threads";
import type { ThreadId, HostId } from "@kora/contracts";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import type { HostProject } from "@kora/client-runtime/store/models";
import { hostThreadRef } from "@kora/client-runtime/host";
import { useCallback, type MouseEvent as ReactMouseEvent, useState, useRef, memo } from "react";
import { ChevronDownIcon } from "lucide-react";

export function resolveRenameCommit(input: {
  readonly originalTitle: string;
  readonly title: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const title = input.title.trim();
  if (title.length === 0) {
    return { action: "reject-empty" };
  }
  if (title === input.originalTitle) {
    return { action: "noop" };
  }
  return { action: "commit", title };
}

type Props = {
  onOpenProjectSettings?: (() => void) | undefined;
  activeProject: HostProject | null;
  activeThreadHostId: HostId;
  activeThreadTitle: string;
  activeThreadId: ThreadId;
  isServerThread: boolean;
};

export const ChatHeader = memo(function ChatHeader({
  onOpenProjectSettings,
  activeThreadHostId,
  activeThreadTitle,
  isServerThread,
  activeThreadId,
  activeProject,
}: Props) {
  // Keyed by thread so moving to another thread drops an unfinished edit.
  const [renaming, setRenaming] = useState<{ threadId: ThreadId; draft: string } | null>(null);
  const draft = renaming?.threadId === activeThreadId ? renaming.draft : null;
  const isRenaming = draft !== null;

  const resolvedRef = useRef(false);
  const patchThread = useAtomAction(threadHost.updateMetadata, { reportFailure: false });

  const startRename = useCallback(() => {
    resolvedRef.current = false;
    setRenaming({ threadId: activeThreadId, draft: activeThreadTitle });
  }, [activeThreadId, activeThreadTitle]);

  const { openMenu, closeMenu } = useThreadMenu({
    threadRef: isServerThread ? hostThreadRef(activeThreadHostId, activeThreadId) : null,
    projectCwd: activeProject?.workspaceRoot ?? null,
    onStartRename: startRename,
  });

  const commit = (value: string) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    setRenaming(null);
    const resolution = resolveRenameCommit({ title: value, originalTitle: activeThreadTitle });
    if (resolution.action === "reject-empty") {
      toastManager.add({ title: "Chat title cannot be empty", type: "warning" });
      return;
    }
    if (resolution.action === "noop") return;
    void patchThread({
      hostId: activeThreadHostId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomActionInterrupted(result)) return;
      const failure = squashAtomActionFailure(result);
      toastManager.add({
        description: failure instanceof Error ? failure.message : "An error occurred.",
        title: "Failed to rename chat",
        type: "error",
      });
    });
  };

  // The chevron (always shown) and the keyboard open the menu at once; a click on the title text itself does
  // nothing, so a double-click can rename without a menu opening half a second later.
  const onTitleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = { x: rect.left, y: rect.bottom + 4 };
    const fromChevron =
      event.target instanceof Element &&
      event.target.closest("[data-thread-title-chevron]") !== null;
    if (event.detail === 0 || fromChevron) openMenu(position);
  };

  const onTitleDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target instanceof Element && event.target.closest("[data-thread-title-chevron]")) {
      return;
    }
    closeMenu();
    startRename();
  };

  const onHeaderContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (isRenaming) return;
    if (!isServerThread && !onOpenProjectSettings) return;
    event.preventDefault();
    const position = { x: event.clientX, y: event.clientY };
    if (isServerThread) {
      openMenu(position);
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }
    void api.contextMenu
      .show([{ id: "project-settings", label: "Project settings" }], position)
      .then((choice) => {
        if (choice === "project-settings") onOpenProjectSettings?.();
      })
      .catch(() => undefined);
  };

  const titleTooltip = <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>;
  let title;
  if (isRenaming) {
    title = (
      <input
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            resolvedRef.current = true;
            setRenaming(null);
          }
        }}
        className="w-full min-w-0 rounded-sm bg-transparent font-medium text-foreground text-sm outline-none ring-1 ring-ring/50 focus:ring-ring"
        onBlur={(event) => commit(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        aria-label="Chat title"
        defaultValue={draft}
        autoFocus
      />
    );
  } else if (isServerThread) {
    title = (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-haspopup="menu"
              aria-label={`Chat actions for ${activeThreadTitle}`}
              className="group/title inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onTitleClick}
              onDoubleClick={onTitleDoubleClick}
              type="button"
            />
          }
        >
          <h2 className="truncate">{activeThreadTitle}</h2>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100"
            data-thread-title-chevron=""
          />
        </TooltipTrigger>
        {titleTooltip}
      </Tooltip>
    );
  } else {
    title = (
      <Tooltip>
        <TooltipTrigger
          render={
            // A draft has no server thread to rename yet: no double-click rename here.
            <h2 aria-label={activeThreadTitle} className="truncate" />
          }
        >
          {activeThreadTitle}
        </TooltipTrigger>
        {titleTooltip}
      </Tooltip>
    );
  }

  return (
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3"
      onContextMenu={onHeaderContextMenu}
    >
      <SurfaceBreadcrumb
        ariaLabel="Chat breadcrumb"
        className="flex-1 overflow-clip [overflow-clip-margin:2px]"
      >
        <WorkspaceBreadcrumbItem className="min-w-10 flex-1" current>
          {title}
        </WorkspaceBreadcrumbItem>
      </SurfaceBreadcrumb>
    </div>
  );
});
