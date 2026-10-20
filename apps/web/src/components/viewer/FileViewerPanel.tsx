import { cn } from "~/util/utils";
import { PREFERRED_HIGHLIGHTER } from "~/util/syntaxHighlighting";
import { resolveDiffThemeName } from "~/util/diffRendering";
import { isAbsolutePath } from "~/thread/terminal-links";
import { buildFileReviewComment } from "~/thread/reviewCommentContext";
import { usePromptDraftStore, type DraftId } from "~/stores/promptDraftStore";
import { useWorkspaceMutationRefresh } from "~/hooks/useRefreshOnWorkspaceChange";
import { useTheme } from "~/hooks/useTheme";
import { useUpdateClientPrefs, useClientPrefs } from "~/hooks/usePrefs";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { usePrimaryHostId } from "~/atoms/hosts";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import {
  setProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  useProjectFile,
} from "./projectFilesQueryState";
import {
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
  isMarkdownPreviewFile,
} from "./fileViewerMode";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FILE_LINK_REVEAL_UNSAFE_CSS,
  FILE_LINK_REVEAL_ATTRIBUTE,
  FileSurfaceAction,
  FileSurfaceNotice,
} from "./fileSurfaceChrome";
import { resolveCenteredFileLineScrollTop } from "./fileLineReveal";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import { projectFileEditorCacheKey, projectFileCacheKey } from "./fileContentRevision";
import {
  remapFileCommentAnnotations,
  type FileCommentAnnotationEntry,
  type FileCommentLineAnnotation,
  normalizeFileCommentRange,
  formatFileCommentRange,
  nextFileCommentId,
} from "./fileCommentAnnotations";
import ReadOnlySourceViewer from "./ReadOnlySourceViewer";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import FileBrowserPanel from "./FileBrowserPanel";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import { Spinner } from "../ui/spinner";
import { ScrollArea } from "../ui/scroll-area";
import { OpenInPicker } from "../thread/OpenInPicker";
import { DiffCommentAnnotation } from "../diffs/DiffComment";
import { classifyOutputKind } from "../assistant/outputs";
import {
  OutputBinaryFallback,
  HtmlOutputPreview,
  JsonOutputPreview,
} from "../assistant/OutputPreview";
import { DiffWorkerPoolProvider } from "../DiffWorkers";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceVideoPreviewPath,
  isWorkspaceImageViewPath,
} from "@kora/shared/fileViewer";
import { fileViewerDelimiter } from "@kora/shared/previewDelimiters";
import type { ExternalEditorId, HostThreadRef, HostId } from "@kora/contracts";
import { useCallback, useEffect, useState, useMemo, useRef, memo } from "react";
import {
  MessageSquarePlusIcon,
  FolderTreeIcon,
  WrapTextIcon,
  Table2Icon,
  Code2Icon,
  EyeIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { EditProvider, type FileOptions, Virtualizer, File } from "@pierre/diffs/react";
import { Editor } from "@pierre/diffs/editor";
import type { SelectedLineRange } from "@pierre/diffs";

const EXPLORER_KEY = "kora.fileExplorerOpen";
const RENDER_MARKDOWN_KEY = "kora.renderMarkdown";
const RENDER_TABLE_KEY = "kora.renderTable";

const REVEAL_RETRY_FRAMES = 30;
const REVEAL_GUARD_FRAMES = 60;
const REVEAL_DRIFT_TOLERANCE_PX = 2;

type Props = {
  onPendingChange: (relativePath: string, pending: boolean) => void;
  availableEditors: ReadonlyArray<ExternalEditorId>;
  composerDraftTarget: HostThreadRef | DraftId;
  onOpenFile: (relativePath: string) => void;
  isAssistantOutputsProject?: boolean;
  workspaceMutationId: string | null;
  selectedFilePending: boolean;
  relativePath: string | null;
  threadRef: HostThreadRef;
  revealLine: number | null;
  revealRequestId: number;
  projectName: string;
  hostId: HostId;
  cwd: string;
};

// ---------------------------------------------------------------------------
// Line reveal: mark the target line, scroll it to the middle, and hold it there against late scroll resets.

function lineCountOf(contents: string): number {
  return contents.length === 0 ? 1 : contents.split(/\r\n|\r|\n/).length;
}

type RevealState = {
  frame: number | null;
  /** The pane the pending frame belongs to: a re-mounted viewer must not wait behind a dead one's retries. */
  owner: HTMLElement | null;
  latestRequestId: number | null;
  handledRequestId: number | null;
  cancelGuard: (() => void) | null;
};

function createLineReveal(args: {
  contents: string;
  line: number | null;
  requestId: number;
  state: RevealState;
}) {
  const { state } = args;
  const target =
    args.line === null ? null : Math.min(Math.max(1, args.line), lineCountOf(args.contents));

  return (node: HTMLElement, instance: unknown) => {
    const root: ParentNode = node.shadowRoot ?? node;

    // The highlight attribute lives on the line and its gutter number.
    for (const marked of root.querySelectorAll(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
      marked.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
    }
    if (target !== null) {
      for (const selector of [`[data-line="${target}"]`, `[data-column-number="${target}"]`]) {
        root.querySelector(selector)?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
      }
    }

    const container = node.closest<HTMLElement>(".file-viewer-virtualizer");
    if (!container) return;

    if (state.latestRequestId !== args.requestId) {
      state.latestRequestId = args.requestId;
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = null;
      state.cancelGuard?.();
      state.cancelGuard = null;
    }
    if (target === null) {
      container.style.minHeight = "";
      return;
    }
    // Room to scroll to the very end of a virtualised file before it is fully measured.
    // Never taller than the pane that holds the scroller: a minHeight of the whole file (a virtualised file's full
    // height) grows the scroller to the file's size, so nothing scrolls and the line is never reached.
    container.style.minHeight = `${Math.ceil(
      Math.min(
        Math.max(node.getBoundingClientRect().height, container.clientHeight),
        container.parentElement?.clientHeight ?? container.clientHeight,
      ),
    )}px`;
    if (state.handledRequestId === args.requestId) return;
    if (state.frame !== null) {
      if (state.owner === container) return;
      cancelAnimationFrame(state.frame);
      state.frame = null;
    }
    state.cancelGuard?.();
    state.cancelGuard = null;
    state.owner = container;

    let attempts = 0;
    const attempt = () => {
      state.frame = null;
      const lineElement = root.querySelector<HTMLElement>(`[data-line="${target}"]`);
      const lineHeight = 20;
      const lineRect = lineElement?.getBoundingClientRect();
      // A pane that never gets a height (a render into a hidden or detached node) must not hold this file's reveal
      // state forever: give up the chain and let the next render of the real, laid-out pane start its own.
      if (!container.isConnected) return;
      if (container.clientHeight === 0 && attempts >= REVEAL_RETRY_FRAMES) return;
      const ready =
        container.clientHeight > 0 && (lineRect !== undefined || attempts >= REVEAL_RETRY_FRAMES);
      if (!ready) {
        attempts += 1;
        state.frame = requestAnimationFrame(attempt);
        return;
      }
      // Read fresh each call: a virtualised file is only partly laid out when the first attempt runs, so the target
      // is re-resolved on every guard frame until the line itself is rendered and the pane is tall enough to reach it.
      const scrollTarget = () => {
        // Wrapped lines make the file taller than lineCount * 20px: aim by the measured average until the line renders.
        const averageLine = Math.max(
          lineHeight,
          container.scrollHeight / lineCountOf(args.contents),
        );
        const liveLine = root
          .querySelector<HTMLElement>(`[data-line="${target}"]`)
          ?.getBoundingClientRect();
        return resolveCenteredFileLineScrollTop({
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          viewportTop: container.getBoundingClientRect().top,
          viewportHeight: container.clientHeight,
          fileTop: (instance as { top?: number } | null)?.top ?? 0,
          estimatedLine: { top: (target - 1) * averageLine, height: lineHeight },
          ...(liveLine ? { renderedLine: { top: liveLine.top, height: liveLine.height } } : {}),
        });
      };
      let wanted = scrollTarget();
      container.scrollTop = wanted;
      state.handledRequestId = args.requestId;

      // Editors and state restoration can reset the scroll late; hold the target until the user acts.
      let frames = 0;
      let guardFrame: number | null = null;
      const stopGuard = () => {
        if (guardFrame !== null) cancelAnimationFrame(guardFrame);
        guardFrame = null;
        for (const [event, handler, capture] of listeners) {
          container.removeEventListener(event, handler, capture);
        }
        if (state.cancelGuard === stopGuard) state.cancelGuard = null;
      };
      const listeners: Array<[string, () => void, boolean]> = [
        ["wheel", stopGuard, false],
        ["touchstart", stopGuard, false],
        ["pointerdown", stopGuard, true],
        ["keydown", stopGuard, false],
      ];
      for (const [event, handler, capture] of listeners) {
        container.addEventListener(event, handler, capture);
      }
      state.cancelGuard = stopGuard;
      const tick = () => {
        guardFrame = null;
        frames += 1;
        wanted = scrollTarget();
        if (Math.abs(container.scrollTop - wanted) > REVEAL_DRIFT_TOLERANCE_PX) {
          container.scrollTop = wanted;
        }
        if (frames >= REVEAL_GUARD_FRAMES) return stopGuard();
        guardFrame = requestAnimationFrame(tick);
      };
      guardFrame = requestAnimationFrame(tick);
    };
    state.frame = requestAnimationFrame(attempt);
  };
}

function useLineReveal(path: string, contents: string, line: number | null, requestId: number) {
  const statesRef = useRef(new Map<string, RevealState>());
  useEffect(() => {
    const states = statesRef.current;
    return () => {
      for (const state of states.values()) {
        if (state.frame !== null) cancelAnimationFrame(state.frame);
        // The memoised reveal keeps this state object across a StrictMode cleanup/re-run: a cancelled frame left
        // in `frame` would block every later reveal of the file.
        state.frame = null;
        state.cancelGuard?.();
      }
      states.clear();
    };
  }, []);
  return useMemo(() => {
    let state = statesRef.current.get(path);
    if (!state) {
      state = {
        frame: null,
        owner: null,
        cancelGuard: null,
        handledRequestId: null,
        latestRequestId: null,
      };
      statesRef.current.set(path, state);
    }
    return createLineReveal({ contents, line, requestId, state });
  }, [path, contents, line, requestId]);
}

// ---------------------------------------------------------------------------
// Read-only source

function SourceFilePreview(props: {
  name: string;
  text: string;
  cacheKey: string;
  revealLine: number | null;
  revealRequestId: number;
}) {
  const onPostRender = useLineReveal(
    props.name,
    props.text,
    props.revealLine,
    props.revealRequestId,
  );
  return (
    <ReadOnlySourceViewer
      cacheKey={props.cacheKey}
      name={props.name}
      onPostRender={onPostRender}
      text={props.text}
    />
  );
}

// ---------------------------------------------------------------------------
// Rendered markdown

function RenderedMarkdownSurface(props: {
  hostId: HostId;
  cwd: string;
  relativePath: string;
  text: string;
  threadRef: HostThreadRef;
  readOnly: boolean;
  onWrite: (contents: string) => void;
}) {
  const { hostId, cwd, relativePath, text, readOnly, onWrite } = props;
  const toggleTask = useCallback(
    (input: { markerOffset: number; checked: boolean }) => {
      const fresh = getOptimisticProjectFileQueryData(hostId, cwd, relativePath)?.contents ?? text;
      const next = setMarkdownTaskChecked(fresh, input.markerOffset, input.checked);
      if (next !== fresh) onWrite(next);
    },
    [hostId, cwd, relativePath, text, onWrite],
  );
  return (
    <ScrollArea className="flex-1">
      <FileMarkdownPreview
        cwd={cwd}
        onTaskListChange={readOnly ? undefined : toggleTask}
        relativePath={relativePath}
        text={text}
        threadRef={props.threadRef}
      />
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// Editable source with line comments

type CommentEntry = FileCommentAnnotationEntry;

function EditableFileSurface(props: {
  hostId: HostId;
  cwd: string;
  relativePath: string;
  contents: string;
  composerDraftTarget: HostThreadRef | DraftId;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onWrite: (contents: string) => void;
  revealLine: number | null;
  revealRequestId: number;
}) {
  const { hostId, cwd, relativePath, contents, composerDraftTarget } = props;
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientPrefs((settings) => settings.wordWrap);
  const addReviewComment = usePromptDraftStore((store) => store.addReviewComment);
  const removeReviewComment = usePromptDraftStore((store) => store.removeReviewComment);
  const saveCoordinator = useFileSaveCoordinator({
    hostId,
    cwd,
    relativePath,
    onPendingChange: props.onPendingChange,
  });

  const [annotations, setAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [draftText, setDraftText] = useState("");
  const hasDraft = annotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );
  const [selected, setSelected] = useState<SelectedLineRange | null>(null);

  const live = useRef({
    contents,
    annotations,
    composerDraftTarget,
    relativePath,
    hasDraft,
  });
  live.current = { contents, annotations, composerDraftTarget, relativePath, hasDraft };

  const mirrorComments = useCallback(
    (next: FileCommentLineAnnotation[], text: string) => {
      for (const annotation of next) {
        for (const entry of annotation.metadata.entries) {
          if (entry.kind !== "comment") {
            continue;
          }
          addReviewComment(
            live.current.composerDraftTarget,
            buildFileReviewComment({
              id: entry.id,
              contents: text,
              text: entry.text,
              endLine: entry.endLine,
              startLine: entry.startLine,
              filePath: live.current.relativePath,
            }),
          );
        }
      }
    },
    [addReviewComment],
  );

  const editor = useMemo(
    () =>
      new Editor<{ entries: CommentEntry[] }>({
        persistState: true,
        onChange: (file, lineAnnotations) => {
          const text = file.contents;
          setProjectFileQueryData(hostId, cwd, relativePath, text);
          saveCoordinator.change(text);
          if (lineAnnotations) {
            const remapped = remapFileCommentAnnotations(
              lineAnnotations as unknown as FileCommentLineAnnotation[],
            );
            setAnnotations(remapped);
            mirrorComments(remapped, text);
          }
        },
      }),
    // A new editor per file and theme: the surface is keyed on both.
    [hostId, cwd, relativePath],
  );
  useEffect(() => () => editor.cleanUp(), [editor]);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) {
      return;
    }
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => live.current.hasDraft,
      onDismiss: () => setSelected(null),
    });
  }, [editor]);

  const openDraft = useCallback(
    (range: SelectedLineRange) => {
      const { startLine, endLine } = normalizeFileCommentRange(range);
      editor.setSelections([]);
      editor.blur();
      setDraftText("");
      setAnnotations((previous) => {
        const withoutDrafts = previous
          .map((annotation) => ({
            ...annotation,
            metadata: {
              entries: annotation.metadata.entries.filter((entry) => entry.kind !== "draft"),
            },
          }))
          .filter((annotation) => annotation.metadata.entries.length > 0);
        const draft: CommentEntry = {
          id: nextFileCommentId(),
          kind: "draft",
          startLine,
          endLine,
          text: "",
        };
        const existing = withoutDrafts.find((annotation) => annotation.lineNumber === endLine);
        if (existing) {
          return withoutDrafts.map((annotation) =>
            annotation === existing
              ? { ...annotation, metadata: { entries: [...annotation.metadata.entries, draft] } }
              : annotation,
          );
        }
        return [...withoutDrafts, { lineNumber: endLine, metadata: { entries: [draft] } }];
      });
    },
    [editor],
  );

  const removeEntry = useCallback(
    (entryId: string, kind: CommentEntry["kind"]) => {
      setAnnotations((previous) =>
        previous
          .map((annotation) => ({
            ...annotation,
            metadata: {
              entries: annotation.metadata.entries.filter((entry) => entry.id !== entryId),
            },
          }))
          .filter((annotation) => annotation.metadata.entries.length > 0),
      );
      if (kind === "comment") removeReviewComment(live.current.composerDraftTarget, entryId);
    },
    [removeReviewComment],
  );

  const submitEntry = useCallback(
    (entry: CommentEntry, text: string) => {
      const comment: CommentEntry = { ...entry, kind: "comment", text: text.trim() };
      setAnnotations((previous) =>
        previous.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((candidate) =>
              candidate.id === entry.id ? comment : candidate,
            ),
          },
        })),
      );
      addReviewComment(
        live.current.composerDraftTarget,
        buildFileReviewComment({
          id: comment.id,
          filePath: live.current.relativePath,
          startLine: comment.startLine,
          endLine: comment.endLine,
          text: comment.text,
          contents: live.current.contents,
        }),
      );
    },
    [addReviewComment],
  );

  const onPostRender = useLineReveal(
    relativePath,
    contents,
    props.revealLine,
    props.revealRequestId,
  );

  // Keep the range highlighted after each render without notifying.
  const options: FileOptions<{ entries: CommentEntry[] }> = {
    themeType: resolvedTheme,
    theme: resolveDiffThemeName(resolvedTheme),
    unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    overflow: wordWrap ? "wrap" : "scroll",
    disableFileHeader: true,
    enableGutterUtility: !hasDraft,
    enableLineSelection: !hasDraft,
    onLineSelectionEnd: (range) => {
      if (live.current.hasDraft || !range) return;
      setSelected(range);
      openDraft(range);
    },
    onPostRender,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={surfaceRef}>
      <DiffWorkerPoolProvider>
        <EditProvider editor={editor}>
          <Virtualizer
            className="file-viewer-virtualizer min-h-0 flex-1 overflow-auto"
            config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
          >
            <File
              className="min-h-full"
              contentEditable
              file={{
                name: relativePath,
                contents,
                cacheKey: projectFileEditorCacheKey(
                  hostId,
                  cwd,
                  relativePath,
                  contents,
                  editor.getFile(),
                ),
              }}
              lineAnnotations={annotations}
              options={options}
              renderAnnotation={(annotation) =>
                annotation.metadata.entries.map((entry) => {
                  const rangeLabel = formatFileCommentRange(entry.startLine, entry.endLine);
                  return (
                    <div className="py-1" key={entry.id}>
                      <DiffCommentAnnotation
                        kind={entry.kind}
                        onCancel={() => removeEntry(entry.id, entry.kind)}
                        onComment={(text) => submitEntry(entry, text)}
                        {...(entry.kind === "comment"
                          ? { onDelete: () => removeEntry(entry.id, entry.kind) }
                          : { onTextChange: setDraftText })}
                        rangeLabel={rangeLabel}
                        text={entry.kind === "draft" ? draftText : entry.text}
                      />
                    </div>
                  );
                })
              }
              renderGutterUtility={(getHoveredLine) => (
                <button
                  aria-label="Comment on this line"
                  className="flex size-full cursor-pointer items-center justify-center rounded-sm bg-primary text-primary-foreground"
                  onClick={() => {
                    const hovered = getHoveredLine();
                    if (hovered) openDraft({ start: hovered.lineNumber, end: hovered.lineNumber });
                  }}
                  type="button"
                >
                  <MessageSquarePlusIcon className="size-3" />
                </button>
              )}
              selectedLines={selected}
            />
          </Virtualizer>
        </EditProvider>
      </DiffWorkerPoolProvider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel

function isMediaPath(path: string): boolean {
  return (
    isWorkspaceImageViewPath(path) ||
    isWorkspaceVideoPreviewPath(path) ||
    isWorkspaceAudioPreviewPath(path) ||
    /\.pdf$/i.test(path)
  );
}

function joinPath(cwd: string, relativePath: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/${relativePath}`;
}

export default memo(function FileViewerPanel(props: Props) {
  const {
    cwd,
    hostId,
    threadRef,
    onOpenFile,
    revealLine,
    projectName,
    relativePath,
    onPendingChange,
    revealRequestId,
    availableEditors,
    composerDraftTarget,
    selectedFilePending,
    workspaceMutationId,
    isAssistantOutputsProject = false,
  } = props;

  const primaryHostId = usePrimaryHostId();
  const updateClientPrefs = useUpdateClientPrefs();
  const wordWrap = useClientPrefs((settings) => settings.wordWrap);

  const outputKind = relativePath ? classifyOutputKind(relativePath) : null;
  const hostFile = relativePath !== null && isAbsolutePath(relativePath);
  const binaryOutput =
    isAssistantOutputsProject &&
    (outputKind === "image" || outputKind === "pdf" || outputKind === "other");
  const media = relativePath !== null && isMediaPath(relativePath);
  const reads = relativePath !== null && !media && !binaryOutput;

  const file = useProjectFile(hostId, cwd, relativePath, reads);
  const data = file.data;

  useWorkspaceMutationRefresh({
    enabled: reads && !selectedFilePending,
    mutationId: workspaceMutationId,
    refresh: file.refresh,
    resourceKey: `file:${hostId}:${cwd}:${relativePath ?? ""}`,
  });

  // ---- explorer ----
  const [persistedExplorerOpen, setPersistedExplorerOpen] = useLocalStorage(
    EXPLORER_KEY,
    true,
    Schema.Boolean,
  );
  const [outputsExplorerOpen, setOutputsExplorerOpen] = useState(false);
  const explorerOpen = isAssistantOutputsProject ? outputsExplorerOpen : persistedExplorerOpen;
  const toggleExplorer = () => {
    if (isAssistantOutputsProject) setOutputsExplorerOpen((open) => !open);
    else setPersistedExplorerOpen((open) => !open);
  };
  const showExplorer = shouldShowFileExplorer({
    relativePath,
    explorerOpen,
    attachmentOpen: false,
  });

  // ---- rendered / source preference ----
  const [renderMarkdownPref, setRenderMarkdownPref] = useLocalStorage(
    RENDER_MARKDOWN_KEY,
    false,
    Schema.Boolean,
  );
  const [renderTablePref, setRenderTablePref] = useLocalStorage(
    RENDER_TABLE_KEY,
    true,
    Schema.Boolean,
  );
  const [outputsRenderOverride, setOutputsRenderOverride] = useState<Record<string, boolean>>({});
  const [handledRevealKey, setHandledRevealKey] = useState<string | null>(null);

  const isMarkdown = relativePath !== null && isMarkdownPreviewFile(relativePath);
  const delimiter = relativePath ? fileViewerDelimiter({ name: relativePath }) : null;
  const isHtml = isAssistantOutputsProject && outputKind === "html";
  const isJson = isAssistantOutputsProject && outputKind === "json";

  const revealKey = relativePath !== null ? `${relativePath}\u0000${revealRequestId}` : null;
  // A line only exists in source, so a reveal request shows source until the user chooses otherwise.
  const revealForcesSource = revealLine !== null && revealKey !== handledRevealKey;

  const renderedMarkdown =
    isMarkdown &&
    !revealForcesSource &&
    (isAssistantOutputsProject && relativePath !== null
      ? (outputsRenderOverride[relativePath] ?? true)
      : renderMarkdownPref);
  const renderedTable = delimiter !== null && !revealForcesSource && renderTablePref;

  const toggleRendered = () => {
    if (revealKey !== null) setHandledRevealKey(revealKey);
    if (isMarkdown) {
      if (isAssistantOutputsProject && relativePath !== null) {
        setOutputsRenderOverride((current) => ({
          ...current,
          [relativePath]: !(current[relativePath] ?? true),
        }));
      } else {
        setRenderMarkdownPref(!renderMarkdownPref);
      }
    } else if (delimiter !== null) {
      setRenderTablePref(!renderTablePref);
    }
  };

  // ---- writing (markdown checkboxes) ----
  const saveCoordinator = useFileSaveCoordinator({
    hostId,
    cwd,
    relativePath: relativePath ?? "",
    onPendingChange,
  });
  const writeContents = useCallback(
    (contents: string) => {
      if (relativePath === null) return;
      setProjectFileQueryData(hostId, cwd, relativePath, contents);
      saveCoordinator.change(contents);
    },
    [hostId, cwd, relativePath, saveCoordinator],
  );

  // ---- breadcrumbs ----
  const crumbsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    crumbsRef.current
      ?.querySelector<HTMLElement>("[data-current-file-crumb]")
      ?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const absolutePath =
    relativePath === null ? null : hostFile ? relativePath : joinPath(cwd, relativePath);
  const showRenderToggle = (isMarkdown || delimiter !== null) && data !== null;
  const rendered = isMarkdown ? renderedMarkdown : renderedTable;
  const showingRawText = data !== null && !rendered && !media && !binaryOutput;

  // ---- body ----
  let body: React.ReactNode = null;
  if (relativePath !== null) {
    if (binaryOutput && outputKind !== null) {
      body = (
        <OutputBinaryFallback
          absolutePath={absolutePath}
          kind={outputKind}
          name={relativePath.split("/").at(-1) ?? relativePath}
          relativePath={relativePath}
        />
      );
    } else if (media) {
      body = (
        <p className="m-auto text-center text-muted-foreground text-xs">
          Kora previews text files. Open this one in your editor.
        </p>
      );
    } else if (file.error && !data) {
      body = <p className="m-auto text-center text-destructive text-xs">{file.error}</p>;
    } else if (!data) {
      body = (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      );
    } else if (isHtml) {
      body = <HtmlOutputPreview html={data.contents} name={relativePath} />;
    } else if (isJson) {
      body = <JsonOutputPreview json={data.contents} name={relativePath} />;
    } else if (renderedMarkdown) {
      body = (
        <RenderedMarkdownSurface
          cwd={cwd}
          hostId={hostId}
          key={relativePath}
          onWrite={writeContents}
          readOnly={hostFile}
          relativePath={relativePath}
          text={data.contents}
          threadRef={threadRef}
        />
      );
    } else if (renderedTable && delimiter !== null) {
      body = (
        <DelimitedTablePreview delimiter={delimiter} name={relativePath} text={data.contents} />
      );
    } else if (data.truncated || hostFile) {
      body = (
        <SourceFilePreview
          cacheKey={projectFileCacheKey(cwd, relativePath, data.contents)}
          name={relativePath}
          revealLine={revealLine}
          revealRequestId={revealRequestId}
          text={data.contents}
        />
      );
    } else {
      body = (
        <EditableFileSurfaceKeyed
          composerDraftTarget={composerDraftTarget}
          contents={data.contents}
          cwd={cwd}
          hostId={hostId}
          onPendingChange={onPendingChange}
          onWrite={writeContents}
          relativePath={relativePath}
          revealLine={revealLine}
          revealRequestId={revealRequestId}
        />
      );
    }
  }

  const renderLabel = isMarkdown
    ? renderedMarkdown
      ? "Show markdown source"
      : "Show rendered markdown"
    : isHtml
      ? renderedTable
        ? "Show HTML source"
        : "Show rendered page"
      : renderedTable
        ? "Show source"
        : "Show table";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath !== null ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader="">
          <ScrollArea className="min-w-0 flex-1" hideScrollbars scrollFade>
            <div
              className="flex w-max min-w-full items-center text-xs"
              data-file-breadcrumbs=""
              ref={crumbsRef}
            >
              <FileBreadcrumbs
                workspaceMutationId={workspaceMutationId}
                relativePath={relativePath}
                projectName={projectName}
                onOpenFile={onOpenFile}
                hostId={hostId}
                cwd={cwd}
              />
            </div>
          </ScrollArea>
          {absolutePath && primaryHostId === hostId ? (
            <OpenInPicker
              availableEditors={availableEditors}
              compact
              hostId={hostId}
              openInCwd={absolutePath}
            />
          ) : null}
          {showRenderToggle ? (
            <FileSurfaceAction label={renderLabel} onPress={toggleRendered} pressed={rendered}>
              {rendered ? (
                <Code2Icon className="size-3.5" />
              ) : delimiter !== null ? (
                <Table2Icon className="size-3.5" />
              ) : (
                <EyeIcon className="size-3.5" />
              )}
            </FileSurfaceAction>
          ) : null}
          {showingRawText ? (
            <FileSurfaceAction
              label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              onPress={() => updateClientPrefs({ wordWrap: !wordWrap })}
              pressed={wordWrap}
            >
              <WrapTextIcon className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {!hostFile ? (
            <FileSurfaceAction
              label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
              onPress={toggleExplorer}
              pressed={explorerOpen}
            >
              <FolderTreeIcon className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
        </div>
      ) : null}

      {data?.truncated && !media ? (
        <FileSurfaceNotice>
          {`Preview limited to the first 1 MB of a ${data.byteLength.toLocaleString()} byte file.`}
        </FileSurfaceNotice>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {relativePath !== null ? <div className="flex min-w-0 flex-1 flex-col">{body}</div> : null}
        {showExplorer ? (
          <aside
            className={cn(
              "flex shrink-0 bg-background",
              relativePath !== null
                ? "w-[min(22rem,46%)] min-w-64 border-border/60 border-l"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              cwd={cwd}
              hostId={hostId}
              key={`${hostId}:${cwd}`}
              onOpenFile={onOpenFile}
              {...(reads ? { onRefreshSelectedFile: file.refresh } : {})}
              workspaceMutationId={workspaceMutationId}
              selectedPathRevealId={revealRequestId}
              selectedPath={relativePath}
              projectName={projectName}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
});

/** Keyed by path and theme so the editor and its comments start fresh with either. */
function EditableFileSurfaceKeyed(props: Parameters<typeof EditableFileSurface>[0]) {
  const { resolvedTheme } = useTheme();
  return <EditableFileSurface key={`${props.relativePath}:${resolvedTheme}`} {...props} />;
}
