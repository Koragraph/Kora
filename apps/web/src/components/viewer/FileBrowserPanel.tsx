import { usePromptHandleContext } from "~/promptHandleContext";
import { readLocalApi } from "~/localApi";
import { useWorkspaceMutationRefresh } from "~/hooks/useRefreshOnWorkspaceChange";
import { useTheme } from "~/hooks/useTheme";
import { writeTextToClipboard } from "~/hooks/useCopyText";
import { useProjectPathSearch } from "~/atoms/queries";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/appearance/pierre-tree-theme";
import { KORA_PIERRE_ICONS } from "~/appearance/pierre-icons";
import { useDirectoryEntries } from "./useDirectoryEntries";
import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { InputGroupAddon, InputGroupInput, InputGroup } from "../ui/input-group";
import { Button } from "../ui/button";
import { serializePromptFileLink } from "@kora/shared/promptTrigger";
import type { WorkspaceEntry, HostId } from "@kora/contracts";
import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useFileTree, FileTree } from "@pierre/trees/react";
import type { FileTreeDirectoryHandle, FileTreeItemHandle } from "@pierre/trees";

const SEARCH_QUERY_MAX = 256;
const SEARCH_RESULT_LIMIT = 200;
const POINTER_FRESH_MS = 1_000;

const isGitInternal = (path: string): boolean =>
  path === ".git" || path.startsWith(".git/") || path.endsWith("/.git") || path.includes("/.git/");

const toTreePath = (entry: Pick<WorkspaceEntry, "path" | "kind">): string =>
  entry.kind === "directory" ? `${entry.path}/` : entry.path;

const asDirectory = (item: FileTreeItemHandle | null): FileTreeDirectoryHandle | null =>
  item?.isDirectory() ? (item as FileTreeDirectoryHandle) : null;

const stripSlash = (path: string): string => (path.endsWith("/") ? path.slice(0, -1) : path);

function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

const SUBHEADER_CLASS =
  "flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 [[data-web-panel-mode=inline]_&]:mb-1 [[data-web-panel-mode=inline]_&]:h-9 [[data-web-panel-mode=inline]_&]:min-h-9 [[data-web-panel-mode=inline]_&]:border-transparent";

const STATUS_CLASS = "px-3 py-1 text-muted-foreground text-xs";

export default function FileBrowserPanel({
  onRefreshSelectedFile,
  selectedPathRevealId,
  workspaceMutationId,
  selectedPath,
  projectName,
  onOpenFile,
  hostId,
  cwd,
}: {
  onOpenFile: (relativePath: string) => void;
  workspaceMutationId: string | null;
  onRefreshSelectedFile?: () => void;
  selectedPathRevealId: number;
  selectedPath: string | null;
  projectName: string;
  hostId: HostId;
  cwd: string;
}) {
  const { resolvedTheme } = useTheme();
  const promptRef = usePromptHandleContext();
  const directories = useDirectoryEntries(hostId, cwd);
  const { load } = directories;

  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().slice(0, SEARCH_QUERY_MAX);
  const search = useProjectPathSearch(
    { hostId, cwd, query: trimmedQuery.length > 0 ? trimmedQuery : null },
    SEARCH_RESULT_LIMIT,
  );
  const searchReady =
    trimmedQuery.length > 0 && !search.isPending && search.searchedQuery === trimmedQuery;

  // ---- what the tree shows ----
  const entries = useMemo(() => {
    const byPath = new Map<string, WorkspaceEntry>();
    for (const entry of directories.entries) byPath.set(entry.path, entry);
    if (searchReady) {
      for (const match of search.entries) {
        for (const ancestor of ancestorsOf(match.path)) {
          if (!byPath.has(ancestor)) byPath.set(ancestor, { path: ancestor, kind: "directory" });
        }
        byPath.set(match.path, match);
      }
    }
    return [...byPath.values()].filter((entry) => !isGitInternal(entry.path));
  }, [directories.entries, search.entries, searchReady]);

  const treePaths = useMemo(() => entries.map(toTreePath), [entries]);
  const directoryTreePaths = useMemo(
    () => entries.filter((entry) => entry.kind === "directory").map(toTreePath),
    [entries],
  );
  const entryKindSignature = useMemo(
    () => entries.map((entry) => `${entry.kind}:${entry.path}`).join("\n"),
    [entries],
  );

  // ---- tree model, created once ----
  const [expandAll, setExpandAll] = useState(false);
  const live = useRef({
    onOpenFile,
    expandAll,
    directoryTreePaths,
    load,
    promptRef,
    pointer: null as { x: number; y: number; at: number } | null,
  });
  live.current = { ...live.current, onOpenFile, expandAll, directoryTreePaths, load, promptRef };

  const syncingRef = useRef(false);
  const treeOriginatedRef = useRef<string | null>(null);
  const modelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragController = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => modelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );

  const { model } = useFileTree({
    paths: [],
    search: false,
    density: "compact",
    icons: KORA_PIERRE_ICONS,
    initialExpansion: "closed",
    flattenEmptyDirectories: true,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
    dragAndDrop: { canDrop: () => false },
    fileTreeSearchMode: "hide-non-matches",
    onSearchChange: (value) => setQuery(value ?? ""),
    onSelectionChange: (selected) => {
      dragController.handleSelectionChange(selected);
      if (syncingRef.current || dragController.isDragInProgress()) return;
      const last = selected.at(-1);
      if (last === undefined || last.endsWith("/")) return;
      treeOriginatedRef.current = last;
      live.current.onOpenFile(last);
    },
    composition: {
      contextMenu: {
        onOpen: (item, context) => {
          const freshPointer =
            live.current.pointer && Date.now() - live.current.pointer.at < POINTER_FRESH_MS
              ? live.current.pointer
              : null;
          const position = freshPointer
            ? { x: freshPointer.x, y: freshPointer.y }
            : { x: context.anchorRect.left, y: context.anchorRect.bottom };
          const api = readLocalApi();
          if (!api) {
            context.close();
            return;
          }
          const mention = serializePromptFileLink(stripSlash(item.path));
          void api.contextMenu
            .show(
              [
                { id: "copy-mention", label: "Copy mention" },
                { id: "add-to-chat", label: "Add to chat" },
              ],
              position,
            )
            .then(async (choice) => {
              if (choice === "copy-mention") {
                try {
                  await writeTextToClipboard(mention, "mention");
                  toastManager.add({
                    type: "success",
                    title: "Mention copied",
                    description: stripSlash(item.path),
                  });
                } catch (cause) {
                  toastManager.add({
                    description: cause instanceof Error ? cause.message : "An error occurred.",
                    title: "Failed to copy mention",
                    type: "error",
                  });
                }
              } else if (choice === "add-to-chat") {
                const composer = live.current.promptRef?.current;
                if (!composer) {
                  toastManager.add({
                    description: "Open a chat for this project and try again.",
                    title: "Unable to add to chat",
                    type: "error",
                  });
                } else if (
                  !composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true })
                ) {
                  toastManager.add({
                    description: "The chat isn't ready to accept input right now.",
                    title: "Unable to add to chat",
                    type: "error",
                  });
                }
              }
            })
            .catch(() => undefined)
            .finally(() => context.close());
        },
        triggerMode: "right-click",
        enabled: true,
      },
    },
  });
  modelRef.current = model;

  // ---- paths in, incrementally ----
  const previousPathsRef = useRef<readonly string[] | null>(null);
  const ready = directories.ready;
  useEffect(() => {
    if (!ready) return;
    const previous = previousPathsRef.current;
    if (previous === null) {
      model.resetPaths(treePaths);
    } else {
      const updates = buildFileTreePathUpdates(previous, treePaths);
      if (updates.length > 0) model.batch(updates);
    }
    previousPathsRef.current = treePaths;

    model.setGitStatus(
      entries
        .filter((entry) => entry.ignored)
        .map((entry) => ({ path: toTreePath(entry), status: "ignored" as const })),
    );
    if (live.current.expandAll && trimmedQuery.length === 0) {
      setAllDirectoriesExpanded(model, directoryTreePaths, true);
    }
  }, [ready, model, treePaths, entries, directoryTreePaths, trimmedQuery]);

  // ---- lazy loading of expanded folders ----
  const expandedRef = useRef(new Set<string>());
  useEffect(() => {
    return model.subscribe(() => {
      const known = new Set(live.current.directoryTreePaths);
      const expandedNow = new Set<string>();
      for (const path of known) {
        if (asDirectory(model.getItem(path))?.isExpanded()) expandedNow.add(path);
      }

      let collapsedOne = false;
      for (const path of expandedRef.current) {
        if (!known.has(path)) continue; // gone, not collapsed
        if (!expandedNow.has(path)) collapsedOne = true;
      }
      if (collapsedOne) setExpandAll(false);

      if (!model.isSearchOpen()) {
        for (const path of expandedNow) {
          if (!expandedRef.current.has(path)) void live.current.load(stripSlash(path));
        }
      }
      expandedRef.current = expandedNow;
    });
  }, [model]);

  // ---- reveal the open file ----
  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    void (async () => {
      for (const ancestor of ancestorsOf(selectedPath)) {
        if (cancelled) return;
        await load(ancestor);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPath, load]);

  const handledRevealRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPath) return;
    const known = entries.find((entry) => entry.path === selectedPath);
    if (!known || known.kind !== "file") return;
    const key = `${selectedPath}\u0000${selectedPathRevealId}`;
    // Refreshes rebuild paths while the same preview is open; replaying would close an active search.
    if (handledRevealRef.current === key) return;
    if (treeOriginatedRef.current === selectedPath) {
      handledRevealRef.current = key;
      return;
    }

    syncingRef.current = true;
    setQuery("");
    model.closeSearch();
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
    for (const ancestor of ancestorsOf(selectedPath)) {
      asDirectory(model.getItem(`${ancestor}/`))?.expand();
    }
    model.getItem(selectedPath)?.select();
    model.scrollToPath(selectedPath, { focus: true, offset: "center" });
    handledRevealRef.current = key;
    queueMicrotask(() => {
      syncingRef.current = false;
    });
  }, [entryKindSignature, selectedPath, selectedPathRevealId, entries, model]);

  // ---- expand / collapse all ----
  const allExpanded = areAllDirectoriesExpanded(model, directoryTreePaths);
  const collapseMode = expandAll || allExpanded;
  const toggleExpandAll = () => {
    const next = !collapseMode;
    setExpandAll(next);
    setAllDirectoriesExpanded(model, directoryTreePaths, next);
  };

  // ---- refresh ----
  const refreshAll = useCallback(() => {
    directories.refresh();
    if (trimmedQuery.length > 0) search.refresh();
    onRefreshSelectedFile?.();
  }, [directories.refresh, search.refresh, trimmedQuery, onRefreshSelectedFile]);
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: directories.refresh,
    resourceKey: `files:${hostId}:${cwd}`,
  });

  // ---- drag to chat + native pointer capture ----
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onDragStart = (event: DragEvent) =>
      dragController.handleDragStart({
        dataTransfer: event.dataTransfer,
        composedPath: () => event.composedPath(),
      });
    const onDragEnd = () => dragController.handleDragEnd();
    root.addEventListener("dragstart", onDragStart, true);
    root.addEventListener("dragend", onDragEnd);
    const onContextMenu = (event: MouseEvent) => {
      live.current.pointer = { x: event.clientX, y: event.clientY, at: Date.now() };
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      root.removeEventListener("dragstart", onDragStart, true);
      root.removeEventListener("dragend", onDragEnd);
      document.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, [dragController]);

  const error = directories.error ?? search.error;
  const pending = directories.isPending || (trimmedQuery.length > 0 && search.isPending);
  const hasDirectories = directoryTreePaths.length > 0;
  const expandLabel = collapseMode ? "Collapse all folders" : "Expand all folders";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${hostId}:${cwd}`}
      ref={rootRef}
    >
      <div className={SUBHEADER_CLASS} data-surface-subheader="">
        <InputGroup
          className="h-7 min-w-0 flex-1 rounded-full bg-sidebar-control-surface px-1"
          variant="ghost"
        >
          <InputGroupAddon className="ms-2 text-muted-foreground">
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              if (value.trim().length === 0) model.closeSearch();
              else model.setSearch(value);
            }}
            aria-label={`Search ${projectName} files`}
            name="project-files-search"
            placeholder="Find a file"
            spellCheck={false}
            value={query}
            type="search"
            size="sm"
          />
        </InputGroup>
        {hasDirectories ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={expandLabel}
                  onClick={toggleExpandAll}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              {collapseMode ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>{expandLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Refresh workspace files"
                onClick={refreshAll}
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <RefreshCwIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>{pending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
        </Tooltip>
      </div>

      {error ? (
        <button
          className="w-full cursor-pointer p-4 text-left text-destructive text-xs leading-relaxed"
          onClick={refreshAll}
          type="button"
        >
          {`${error} Click to retry.`}
        </button>
      ) : null}
      {trimmedQuery.length > 0 && !search.isPending && search.truncated ? (
        <p className={STATUS_CLASS}>More matches available. Refine your search.</p>
      ) : null}
      {pending ? (
        <p className={STATUS_CLASS} role="status">
          Loading files…
        </p>
      ) : null}

      <FileTree
        aria-label={`${projectName} files`}
        className="min-h-0 flex-1 overflow-hidden"
        model={model}
        style={pierreTreeStyle(resolvedTheme)}
      />
    </div>
  );
}
