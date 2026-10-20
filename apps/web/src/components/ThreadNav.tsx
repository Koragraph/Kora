import { TooltipTrigger, TooltipPopup, Tooltip } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarFooter,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarContent,
} from "./ui/sidebar";
import { AGENT_ICON_BY_AGENT } from "./thread/agentIconUtils";
import { resolveRenameCommit } from "./thread/ChatHeader";
import { UpdateReadyButton } from "./nav/UpdateReady";
import { Button } from "./ui/button";
import { NeedsYouRow, NewThreadRow, SearchRow } from "./nav/SidebarMenuRows";
import { SidebarUsage } from "./nav/SidebarUsage";
import { collectNeedsYou } from "./nav/needsYou";
import { LeadBlob } from "./thread/LeadBlob";
import { PixelSprite } from "./sprite";
import { useClientPrefs } from "../hooks/usePrefs";
import { terminalFocusOwner } from "../util/terminalFocus";
import { NavChromeHeader } from "./nav/NavChrome";
import { ArchivedThreads } from "./nav/ArchivedThreads";
import { useAppSurfaceStore, useLastBlobStore } from "./assistant/surfaceStore";
import { useKoraSurfaceOn } from "../koraSurface";
import {
  filterProjectsForCodeSurface,
  createRepeatClickDetector,
  type LastOpenedByProject,
  orderFolderThreads,
  resolveRenameBlur,
  resolveSidebarShortcut,
  baselineVisitFor,
  resolveThreadDot,
  rollupThreadDots,
  isTextTruncated,
  rememberOpened,
  isShownThread,
  SURFACING_TONES,
  resolveThreadCardLook,
  threadCheckoutLabel,
  filterFolder,
  type ThreadDot,
} from "./ThreadNav.logic";
import { cn, isMacPlatform } from "../util/utils";
import { formatRelativeTime } from "../timeFormat";
import { threadPageParams } from "../thread/threadRoutes";
import { useViewStateStore } from "../stores/uiStateStore";
import { readLocalApi } from "../localApi";
import { useThreadMenu } from "../hooks/useThreadMenu";
import { useStartThread } from "../hooks/useStartThread";
import { useAddLocalFolderProject } from "../hooks/useAddLocalFolderProject";
import { isNative } from "../env";
import { isAssistantSurfaceProject, projectSurface } from "../chatSurface";
import { useAtomAction } from "../atoms/use-atom-command";
import { threadHost } from "../atoms/threads";
import { useHosts } from "../atoms/hosts";
import { useThreadSummaries, useProjects } from "../atoms/entities";
import { AgentId } from "@kora/contracts";
import { isAtomActionInterrupted } from "@kora/client-runtime/store/runtime";
import type { HostThreadShell, HostProject } from "@kora/client-runtime/store/models";
import { hostProjectRef, hostThreadKey, hostThreadRef } from "@kora/client-runtime/host";
// Directory-tree sidebar (Claude-desktop style): every project is a collapsible folder row,
// its chats nested underneath. Folders start COLLAPSED except the one holding the active chat,
// so the list stays short. The thread rows themselves are unchanged from the previous sidebar
// (provider brand mark + status dot + title) — the dev liked those. Reuses the real thread data
// + navigation, so opening a chat behaves exactly as before.
import { useCallback, useEffect, Suspense, useState, useMemo, useRef, lazy } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  EyeIcon,
  XIcon,
  SettingsIcon,
  EllipsisIcon,
  PinIcon,
  FolderPlusIcon,
  PlusIcon,
  FolderIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GitBranchIcon,
} from "lucide-react";
import { useParams, useRouter } from "@tanstack/react-router";

// Lazy: the Blobs sidebar pulls in the editor and model picker, which Code and Chat never need.
const BlobsNavContent = lazy(() =>
  import("./blobs/shell/BlobsNavContent").then((m) => ({ default: m.BlobsNavContent })),
);
const BlobsFooterLinks = lazy(() =>
  import("./blobs/shell/BlobsFooterLinks").then((m) => ({ default: m.BlobsFooterLinks })),
);

const OPEN_DIRS_KEY = "kora.sidebar.openDirs.v1";
const SHOW_ALL_KEY = "kora.sidebar.showAll.v1";
const LAST_OPENED_KEY = "kora.sidebar.lastOpened.v1";
// Folders the user hid from the sidebar. Client-only and reversible ("Show hidden" at the
// bottom) — hiding never touches the project, its threads, or the graph.
const HIDDEN_KEY = "kora.sidebar.hidden.v1";
const projectKey = (p: HostProject) => `${p.hostId}:${p.id}`;

const threadKey = (t: HostThreadShell) => `${t.hostId}:${t.id}`;

// Module-level on purpose: a row's first click navigates and can replace the row, so the pairing
// has to outlive the ThreadRow instance (see createRepeatClickDetector).
const rowClickDetector = createRepeatClickDetector();

function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

/** Short model name for the active chat's card: "claude-sonnet-5-5" → "Sonnet 5.5", "opus[1m]" → "Opus"; others pass through. */
export function shortModelLabel(model: string): string {
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d+))?)?/i.exec(model);
  if (!m) return model;
  const name = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase();
  const version = m[2] ? (m[3] && m[3].length <= 2 ? `${m[2]}.${m[3]}` : m[2]) : "";
  return version ? `${name} ${version}` : name;
}

/** The agent behind a thread: its live session's driver, else guessed from the model id. */
function threadAgentId(t: HostThreadShell): AgentId {
  const driver = t.session?.providerName;
  if (driver) return AgentId.make(driver);
  // No live session (not started, or retired): the thread's own provider pick, before guessing from the model name
  // (an Antigravity thread on a gemini-* model used to show the Claude mark).
  const instance = (t.modelSelection as { instanceId?: string | null }).instanceId;
  if (instance && instance in AGENT_ICON_BY_AGENT) return AgentId.make(instance);
  const model = t.modelSelection.model ?? "";
  if (/^(gpt|o\d|codex)/i.test(model)) return AgentId.make("codex");
  if (/^gemini-/i.test(model)) return AgentId.make("antigravity");
  return AgentId.make("claude");
}

function ThreadAgentIcon(props: { icon: NonNullable<(typeof AGENT_ICON_BY_AGENT)[AgentId]> }) {
  const Icon = props.icon;
  // 16px: the brand marks are what tells the agents apart at a glance, so they are not shrunk to a dot.
  return <Icon className="size-4 shrink-0" aria-hidden data-agent-mark="" />;
}

/** The running-turn mark over a thread row, in the style picked in Settings (outline / rail / line). */
function WorkingFx(props: { className: string }) {
  const style = useClientPrefs((prefs) => prefs.sidebarWorkingStyle);
  return <span aria-hidden className={cn("nav-working-fx", props.className)} data-style={style} />;
}

const rowActionClass =
  "grid size-6 shrink-0 place-items-center rounded-md text-sidebar-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-row-active hover:text-sidebar-foreground";

/** One chat row: click opens it; right-click or ⋯ opens the full thread menu (rename,
 *  archive, delete, pin…) — the same menu and mutations as the chat header. Exported so Kora's
 *  sidebar (BlobsNavContent) renders identical rows. */
export function ThreadRow(props: {
  thread: HostThreadShell;
  isActive: boolean;
  projectCwd: string | null;
  icon: React.ReactNode;
  dot: ThreadDot;
  onOpen: () => void;
  /** Card layout: the title on up to two lines, then status · agent model · project · age. An object renders every
   *  row as a card (the Code feed); `true` only the active one (Kora). */
  card?: true | { readonly project: string | null } | undefined;
  /** Compact rows only: the chat's age on the right (the Settled list). */
  trailingAge?: boolean | undefined;
}) {
  const { thread: t, isActive, projectCwd, icon, dot, onOpen, card, trailingAge } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const committedRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // Set when the user moves off the rename field (pointer down elsewhere, Tab); see resolveRenameBlur.
  const userLeftRenameRef = useRef(false);
  const selectedOnFocusRef = useRef(false);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  // The full title shows on hover only when the row is cutting it off.
  const [titleTruncated, setTitleTruncated] = useState(false);
  const measureTitle = () => setTitleTruncated(isTextTruncated(titleRef.current));
  const patchThreadMeta = useAtomAction(threadHost.updateMetadata, {
    reportFailure: false,
  });
  const startRename = useCallback(() => {
    committedRef.current = false;
    userLeftRenameRef.current = false;
    selectedOnFocusRef.current = false;
    setRenaming(t.title);
  }, [t.title]);
  const { openMenu } = useThreadMenu({
    threadRef: hostThreadRef(t.hostId, t.id),
    projectCwd,
    onStartRename: startRename,
  });
  const isRenaming = renaming !== null;
  // Enter / Escape in the rename field unmount it: hand focus back to the row's actions button, not <body>.
  const actionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const refocusAfterRenameRef = useRef(false);
  useEffect(() => {
    if (isRenaming || !refocusAfterRenameRef.current) return;
    refocusAfterRenameRef.current = false;
    actionsButtonRef.current?.focus({ preventScroll: true });
  }, [isRenaming]);
  useEffect(() => {
    if (!isRenaming) return;
    const onPointerDown = (event: Event) => {
      const input = renameInputRef.current;
      const target = event.target as Node | null;
      if (!input || !target || !input.contains(target)) {
        userLeftRenameRef.current = true;
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [isRenaming]);

  const commitRename = (title: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    setRenaming(null);
    const resolution = resolveRenameCommit({ title, originalTitle: t.title });
    if (resolution.action === "reject-empty") {
      toastManager.add({ title: "Chat title cannot be empty", type: "warning" });
      return;
    }
    if (resolution.action === "noop") return;
    void patchThreadMeta({
      hostId: t.hostId,
      input: { threadId: t.id, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        toastManager.add({ type: "error", title: "Failed to rename chat" });
      }
    });
  };

  if (renaming !== null) {
    return (
      <SidebarMenuItem>
        <input
          ref={renameInputRef}
          autoFocus
          value={renaming}
          onChange={(e) => setRenaming(e.target.value)}
          onFocus={(e) => {
            // Select once; a focus handed back after a steal keeps what the user typed.
            if (selectedOnFocusRef.current) return;
            selectedOnFocusRef.current = true;
            e.currentTarget.select();
          }}
          onBlur={(e) => {
            const action = resolveRenameBlur({
              userLeft: userLeftRenameRef.current,
              windowFocused: document.hasFocus(),
            });
            if (action === "commit") commitRename(e.currentTarget.value);
            if (action === "refocus") setTimeout(() => renameInputRef.current?.focus(), 0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Tab") userLeftRenameRef.current = true;
            if (e.key === "Enter" || e.key === "Escape") refocusAfterRenameRef.current = true;
            if (e.key === "Enter") commitRename(e.currentTarget.value);
            if (e.key === "Escape") {
              // Cancel: mark it resolved first so the blur that follows the unmount cannot commit the edit.
              committedRef.current = true;
              setRenaming(null);
            }
          }}
          className="h-8 w-full rounded-md border border-sidebar-border bg-sidebar px-2 text-[13px] text-sidebar-foreground outline-none"
        />
      </SidebarMenuItem>
    );
  }

  // Double-click renames any row, not just the active one: clicks are paired by thread, not by DOM
  // node, because the first click navigates and re-renders the row before the second lands.
  const handleClick = () => {
    if (rowClickDetector.register(threadKey(t), performance.now())) {
      startRename();
      return;
    }
    onOpen();
  };

  const openFromEvent = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu({ x: e.clientX, y: e.clientY });
  };

  if (card && (card !== true || isActive)) {
    const age = formatRelativeTime(t.updatedAt);
    const model = t.modelSelection.model;
    // "default" (no explicit pick) says nothing; leave it out.
    const modelLabel = model && model !== "default" ? shortModelLabel(model) : null;
    const project = card === true ? null : card.project;
    const agentIcon = AGENT_ICON_BY_AGENT[threadAgentId(t)];
    const look = resolveThreadCardLook(dot);
    const checkout = threadCheckoutLabel(t);
    return (
      <SidebarMenuItem className="group/thread relative">
        <SidebarMenuButton
          isActive={isActive}
          // Named by the title alone (the rest is detail, read as the description).
          aria-label={t.title}
          aria-description={[
            look.word ?? (dot.tone !== "idle" ? dot.label : null),
            checkout,
            modelLabel,
            project,
            age?.value,
          ]
            .filter(Boolean)
            .join(" · ")}
          tooltip={{ children: t.title, hidden: !titleTruncated }}
          onClick={handleClick}
          onPointerEnter={measureTitle}
          onFocus={measureTitle}
          onContextMenu={openFromEvent}
          data-card-look={look.kind}
          className={cn(
            "h-auto items-stretch gap-3 rounded-lg px-3 py-2.5 font-normal",
            look.kind === "needs" &&
              "bg-amber-400/[0.06] shadow-[inset_0_0_0_1px_rgb(251_191_36/0.35)] hover:bg-amber-400/[0.09]",
            look.kind === "unread" &&
              "bg-emerald-400/[0.05] shadow-[inset_0_0_0_1px_rgb(52_211_153/0.3)] hover:bg-emerald-400/[0.08]",
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            {/* 1. What's going on */}
            <span className="flex min-w-0 items-center gap-1.5">
              {look.kind === "unread" ? (
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-emerald-400" />
              ) : null}
              <span
                ref={titleRef}
                data-card-title=""
                className={cn(
                  "min-w-0 truncate text-[14px] leading-snug",
                  look.quiet && !isActive
                    ? "text-sidebar-foreground/75"
                    : "font-semibold text-sidebar-foreground",
                )}
              >
                {t.title}
              </span>
            </span>
            {/* 2. The checkout or worktree it runs in */}
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-sidebar-muted-foreground">
              <GitBranchIcon className="size-3 shrink-0 opacity-80" aria-hidden />
              <span className="min-w-0 truncate font-mono text-[11.5px]">{checkout}</span>
            </span>
            {/* 3. Agent mark + model, and a word when it needs you, finished unopened, or failed */}
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-sidebar-muted-foreground">
              {agentIcon ? <ThreadAgentIcon icon={agentIcon} /> : null}
              {/* a long model id (gpt-6-luna) keeps a few letters; the word gives way first */}
              {modelLabel ? <span className="min-w-[3rem] truncate">{modelLabel}</span> : null}
              {project ? <span className="min-w-0 truncate">· {project}</span> : null}
              {look.word ? (
                <span className={cn("min-w-0 truncate font-medium", look.wordClass)}>
                  · {look.word}
                </span>
              ) : null}
            </span>
          </span>
          {/* Right: the time in the corner, Kora under it */}
          <span className="flex shrink-0 flex-col items-end justify-between">
            <span
              className={cn(
                "text-[11.5px] tabular-nums transition-opacity group-hover/thread:opacity-0",
                look.kind === "unread"
                  ? "font-medium text-emerald-400"
                  : "text-sidebar-muted-foreground",
              )}
            >
              {age?.value}
            </span>
            <span className="-mb-0.5 grid h-6 place-items-center">
              {look.kind === "working" ? (
                <span className="inline-grid" data-thread-working="">
                  <LeadBlob mood="working" seed={t.latestTurn?.startedAt ?? t.id} />
                </span>
              ) : look.sprite ? (
                <span aria-hidden className="inline-grid">
                  <PixelSprite state={look.sprite} size={24} motion="ambient" />
                </span>
              ) : null}
            </span>
          </span>
        </SidebarMenuButton>
        {look.kind === "working" ? <WorkingFx className="rounded-lg" /> : null}
        <button
          type="button"
          ref={actionsButtonRef}
          aria-label={`Actions for ${t.title}`}
          onClick={openFromEvent}
          className={cn(
            rowActionClass,
            "absolute top-1.5 right-1.5 group-hover/thread:opacity-100",
          )}
        >
          <EllipsisIcon className="size-3.5" />
        </button>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem className="group/thread relative">
      <SidebarMenuButton
        isActive={isActive}
        tooltip={{ children: t.title, hidden: !titleTruncated }}
        onClick={handleClick}
        onPointerEnter={measureTitle}
        onFocus={measureTitle}
        onContextMenu={openFromEvent}
        className="pr-7"
      >
        {icon}
        {t.pinnedAt ? (
          <PinIcon
            className="size-3 shrink-0 text-sidebar-muted-foreground/70"
            aria-label="Pinned"
          />
        ) : null}
        <span ref={titleRef} className="min-w-0 flex-1 truncate">
          {t.title}
        </span>
        {trailingAge ? (
          <span className="shrink-0 text-[11px] text-sidebar-muted-foreground tabular-nums transition-opacity group-hover/thread:opacity-0">
            {formatRelativeTime(t.updatedAt)?.value}
          </span>
        ) : null}
        {/* No leading icon: the status dot trails the title (and only when there is something to say). */}
        {icon === null && dot.tone !== "idle" ? (
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full transition-opacity group-hover/thread:opacity-0",
              dot.dotClass,
            )}
          />
        ) : null}
        {dot.tone !== "idle" ? <span className="sr-only">{`, ${dot.label}`}</span> : null}
      </SidebarMenuButton>
      {dot.tone === "working" ? <WorkingFx className="rounded-[var(--control-radius)]" /> : null}
      <button
        type="button"
        ref={actionsButtonRef}
        aria-label={`Actions for ${t.title}`}
        onClick={openFromEvent}
        className={cn(rowActionClass, "absolute top-1 right-1 group-hover/thread:opacity-100")}
      >
        <EllipsisIcon className="size-3.5" />
      </button>
    </SidebarMenuItem>
  );
}

export default function ThreadNav() {
  const allProjects = useProjects();
  const threads = useThreadSummaries();
  const router = useRouter();
  const [surface, setSurface] = useAppSurfaceStore();
  const [, setLastBlob] = useLastBlobStore();
  // Kora is coming soon (koraSurface.ts): the Kora tab's main pane is the coming-soon page and the sidebar keeps the Code
  // list (no blob roster, no Apps/Routines links, Settings opens the Code settings).
  const koraOn = useKoraSurfaceOn();
  const showBlobsNav = surface === "blobs" && koraOn;
  // Code = exactly today's sidebar, restricted to non-chat projects.
  const projects = useMemo(() => filterProjectsForCodeSurface(allProjects), [allProjects]);

  const activeThreadId = useParams({
    strict: false,
    select: (p) => p.threadId as string | undefined,
  });
  const { openNewThread } = useStartThread();
  const addLocalFolderProject = useAddLocalFolderProject();
  const openProjectFromEmpty = async () => {
    const result = await addLocalFolderProject();
    if (result.kind === "failed")
      toastManager.add({
        type: "error",
        title: "Couldn't open the project",
        description: result.message,
      });
  };

  // Threads grouped by project: pinned first, then newest first within each folder.
  const threadsByProject = useMemo(() => {
    const map = new Map<string, HostThreadShell[]>();
    for (const t of threads) {
      if (t.archivedAt) continue;
      const key = `${t.hostId}:${t.projectId}`;
      (map.get(key) ?? map.set(key, []).get(key)!).push(t);
    }
    for (const [key, list] of map) map.set(key, orderFolderThreads(list));
    return map;
  }, [threads]);

  // Status dots (see ThreadNav.logic DOTS): green = finished + not opened, grey = seen, yellow = needs you,
  // red = failed / daemon offline.
  const lastVisitedAtById = useViewStateStore((state) => state.threadLastVisitedAtById);
  const seedThreadVisits = useViewStateStore((state) => state.seedThreadVisits);
  const { environments } = useHosts();
  const offlineHostIds = useMemo(
    () =>
      new Set(
        environments
          .filter((e) => e.connection.phase === "offline" || e.connection.phase === "error")
          .map((e) => e.hostId),
      ),
    [environments],
  );
  // A thread with no visit record could never turn green (hasUnseenCompletion needs one): give it a baseline so
  // its NEXT finished turn does. Old threads start grey.
  useEffect(() => {
    const seeds: Array<readonly [string, string]> = [];
    for (const t of threads) {
      const key = hostThreadKey(hostThreadRef(t.hostId, t.id));
      const at = baselineVisitFor(t, lastVisitedAtById[key]);
      if (at) seeds.push([key, at]);
    }
    if (seeds.length > 0) seedThreadVisits(seeds);
  }, [threads, lastVisitedAtById, seedThreadVisits]);
  const dotByThreadKey = useMemo(() => {
    const map = new Map<string, ThreadDot>();
    for (const t of threads) {
      if (t.archivedAt) continue;
      const visited = lastVisitedAtById[hostThreadKey(hostThreadRef(t.hostId, t.id))];
      map.set(threadKey(t), resolveThreadDot(t, visited, offlineHostIds.has(t.hostId)));
    }
    return map;
  }, [threads, lastVisitedAtById, offlineHostIds]);

  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const filtering = query.trim().length > 0;

  // Folders ordered by most-recently-active chat (empty projects sink to the bottom).
  const orderedProjects = useMemo(() => {
    const latest = (p: HostProject) => threadsByProject.get(projectKey(p))?.[0]?.updatedAt ?? "";
    return [...projects].sort((a, b) => (latest(a) < latest(b) ? 1 : -1));
  }, [projects, threadsByProject]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const activeProjectKey = activeThread ? `${activeThread.hostId}:${activeThread.projectId}` : null;
  const activeThreadProject = useMemo(
    () =>
      activeThread ? (allProjects.find((p) => projectKey(p) === activeProjectKey) ?? null) : null,
    [allProjects, activeProjectKey, activeThread],
  );

  // The active surface is also implied by the route: opening a thread of a blob flips the switcher to Kora
  // (and vice versa), without waiting for an explicit toggle. Only when the open
  // thread CHANGES: reacting to a surface change too flipped a Kora/Code click straight back while the
  // old thread was still on screen (the switch then took two clicks).
  const syncedThreadKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeThread || !activeThreadProject) return;
    const key = threadKey(activeThread);
    if (syncedThreadKeyRef.current === key) return;
    syncedThreadKeyRef.current = key;
    const impliedSurface = projectSurface(activeThreadProject);
    if (impliedSurface !== surface) setSurface(impliedSurface);
    if (impliedSurface === "blobs") setLastBlob(activeThreadProject.id);
  }, [activeThread, activeThreadProject, surface, setSurface, setLastBlob]);

  // Projects opened from the Projects list (kept open with nothing live in them), and projects whose toggle
  // beside the name shows every chat instead of just the live ones.
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>(() =>
    readJson(OPEN_DIRS_KEY, {}),
  );
  const [showAll, setShowAll] = useState<Record<string, boolean>>(() => readJson(SHOW_ALL_KEY, {}));
  const [hidden, setHidden] = useState<Record<string, boolean>>(() => readJson(HIDDEN_KEY, {}));
  const [showHidden, setShowHidden] = useState(false);
  // The chat you opened last in each project: it is what that project shows until you open another or close it.
  const [lastOpened, setLastOpened] = useState<LastOpenedByProject>(() =>
    readJson(LAST_OPENED_KEY, {}),
  );
  // Keyed by id, not the thread object: a shell update (new message, status) must not re-run this.
  const openedThreadId = activeThread?.id ?? null;
  const openedInChatSurface =
    !!activeThreadProject && isAssistantSurfaceProject(activeThreadProject);
  // Chats opened since launch stay listed under their project, so a finished chat you just read doesn't fold away.
  const [openedThisSession, setOpenedThisSession] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!openedThreadId || !activeProjectKey || openedInChatSurface) return;
    setOpenedThisSession((prev) =>
      prev.has(openedThreadId) ? prev : new Set(prev).add(openedThreadId),
    );
    setLastOpened((prev) =>
      rememberOpened(prev, activeProjectKey, openedThreadId, new Date().toISOString()),
    );
    // Opening a chat folds its project back to just that chat (the toggle shows the rest again).
    setShowAll((prev) => (prev[activeProjectKey] ? { ...prev, [activeProjectKey]: false } : prev));
  }, [openedThreadId, activeProjectKey, openedInChatSurface]);

  useEffect(() => writeJson(LAST_OPENED_KEY, lastOpened), [lastOpened]);
  useEffect(() => writeJson(OPEN_DIRS_KEY, openDirs), [openDirs]);
  useEffect(() => writeJson(SHOW_ALL_KEY, showAll), [showAll]);
  useEffect(() => writeJson(HIDDEN_KEY, hidden), [hidden]);

  const dotOf = (t: HostThreadShell) =>
    dotByThreadKey.get(threadKey(t)) ?? resolveThreadDot(t, undefined);

  // The active chat's project, and any project with a chat working or waiting on you, is never hidden out from under
  // the user.
  const hasLiveThread = (key: string) =>
    (threadsByProject.get(key) ?? []).some((t) => SURFACING_TONES.has(dotOf(t).tone));
  const isHidden = (key: string) =>
    !!hidden[key] && key !== activeProjectKey && !hasLiveThread(key);
  const hiddenCount = orderedProjects.filter((p) => isHidden(projectKey(p))).length;
  const listedProjects = showHidden
    ? orderedProjects
    : orderedProjects.filter((p) => !isHidden(projectKey(p)));
  const setFolderHidden = (key: string, value: boolean) =>
    setHidden((prev) => {
      const next = { ...prev };
      if (value) next[key] = true;
      else delete next[key];
      return next;
    });
  const closeDir = (key: string) => {
    setOpenDir(key, false);
    setShowAll((prev) => ({ ...prev, [key]: false }));
    setLastOpened((prev) => {
      const { [key]: _closed, ...rest } = prev;
      return rest;
    });
  };
  const setOpenDir = (key: string, value: boolean) =>
    setOpenDirs((prev) => {
      const next = { ...prev };
      if (value) next[key] = true;
      else delete next[key];
      return next;
    });

  const openFolderMenu = (p: HostProject, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const api = readLocalApi();
    if (!api) return;
    const key = projectKey(p);
    const wasHidden = !!hidden[key];
    void api.contextMenu
      .show(
        [
          { id: "new-chat", label: "New chat", icon: "message-square-plus" },
          // The only other way to a project's settings (rename, Remove) was a thread's menu: a project without
          // threads, e.g. one whose folder is gone, had none.
          { id: "project-settings", label: "Project settings", icon: "settings" },
          wasHidden
            ? { id: "unhide", label: "Show in sidebar", icon: "folder" }
            : { id: "hide", label: "Hide from sidebar", icon: "folder", separatorBefore: true },
        ],
        { x: e.clientX, y: e.clientY },
      )
      .then((action) => {
        if (action === "new-chat") newChat(p);
        if (action === "project-settings")
          void router.navigate({
            to: "/projects/$projectKey",
            params: { projectKey: `${p.hostId}:${p.id}` },
          });
        if (action === "hide") setFolderHidden(key, true);
        if (action === "unhide") setFolderHidden(key, false);
      });
  };

  const openThread = (t: HostThreadShell) => {
    void router.navigate({
      to: "/$hostId/$threadId",
      params: threadPageParams(hostThreadRef(t.hostId, t.id)),
    });
  };
  // New thread goes to the open chat's project, else the most recently active one.
  const newThreadTarget =
    (activeThreadProject && !isAssistantSurfaceProject(activeThreadProject)
      ? activeThreadProject
      : null) ??
    orderedProjects[0] ??
    null;
  const newChat = (p: HostProject) => {
    void openNewThread(hostProjectRef(p.hostId, p.id));
  };

  // ⌘N / Ctrl+N starts a thread, ⌘K / Ctrl+K jumps into Search. The desktop menu carries neither, and nothing else in
  // the client binds them. Skipped while a terminal has focus (⌘K clears it there) or a handler already took the key.
  // A ref keeps the listener's identity stable while the handlers change every render.
  const shortcutRef = useRef<{ newThread: () => void; focusSearch: () => void } | null>(null);
  useEffect(() => {
    shortcutRef.current = {
      newThread: () => {
        if (newThreadTarget) newChat(newThreadTarget);
        else void addLocalFolderProject();
      },
      focusSearch: () => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      },
    };
  });

  useEffect(() => {
    if (showBlobsNav) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolveSidebarShortcut(event, isMacPlatform(navigator.platform));
      if (!action || event.defaultPrevented || terminalFocusOwner() !== null) return;
      event.preventDefault();
      if (action === "new-thread") shortcutRef.current?.newThread();
      else shortcutRef.current?.focusSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showBlobsNav]);

  // Threads blocked on the user (approval / question): the Needs you row. Code projects only (this is the Code list).
  const needsYou = useMemo(() => {
    const codeKeys = new Set(projects.map(projectKey));
    return collectNeedsYou(threads, (t) => codeKeys.has(`${t.hostId}:${t.projectId}`));
  }, [threads, projects]);
  const projectTitleOf = (t: HostThreadShell) =>
    projects.find((p) => p.hostId === t.hostId && p.id === t.projectId)?.title ?? null;

  // The project groups in the main list: the open chat's, every project you opened a chat in (until you close it),
  // the ones opened from the Projects list, and any with a chat working or waiting on you. Each shows only those
  // chats (see isShownThread); the "more" toggle beside the name shows the rest. A search shows every project with a match
  // instead, hidden ones included.
  const groups = (filtering ? orderedProjects : listedProjects).flatMap((p) => {
    const key = projectKey(p);
    const all = threadsByProject.get(key) ?? [];
    if (filtering) {
      const matched = filterFolder({ folderTitle: p.title, threads: all, query });
      return matched.visible && matched.threads.length > 0
        ? [{ project: p, key, all, shown: matched.threads, restCount: 0 }]
        : [];
    }
    const live = all.filter(
      (t) => openedThisSession.has(t.id) || isShownThread(t, dotOf(t), activeThreadId),
    );
    if (live.length === 0 && key !== activeProjectKey && !openDirs[key] && !lastOpened[key])
      return [];
    const shown = showAll[key] ? all : live;
    return [{ project: p, key, all, shown, restCount: all.length - live.length }];
  });
  const groupKeys = new Set(groups.map((g) => g.key));

  const renderCard = (t: HostThreadShell, p: HostProject) => (
    <ThreadRow
      key={`${t.hostId}:${t.id}`}
      thread={t}
      isActive={t.id === activeThreadId}
      projectCwd={p.workspaceRoot ?? null}
      dot={dotOf(t)}
      onOpen={() => openThread(t)}
      icon={null}
      card={{ project: null }}
    />
  );

  // Clicking a project in the Projects list opens its group with every chat showing; clicking it again closes it
  // (the open chat's project stays).
  const toggleDir = (p: HostProject) => {
    const key = projectKey(p);
    if (groupKeys.has(key)) {
      if (key !== activeProjectKey) closeDir(key);
      return;
    }
    setOpenDir(key, true);
    setShowAll((prev) => ({ ...prev, [key]: true }));
    window.requestAnimationFrame?.(() =>
      document
        .querySelector(`[data-project-group="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  };

  return (
    <>
      {/* NavChromeHeader reserves the titlebar row (drag region, traffic-light inset). The sidebar toggle and the
          Chat | Code switcher float above it (AppNavLayout's NavControl), so both work with the sidebar closed. */}
      <NavChromeHeader isNative={isNative} />

      {showBlobsNav ? (
        <Suspense fallback={null}>
          <BlobsNavContent />
        </Suspense>
      ) : (
        <>
          {/* Plain flat rows (concept 1): New thread, Search (the thread filter), Needs you (amber, hidden at zero). New
              thread goes to the open chat's project, else the most recently active one; the hero's directory chip
              changes it before the first message. */}
          <nav aria-label="Threads" className="grid gap-px px-2 pt-1 pb-1.5" data-sidebar-menu="">
            <NewThreadRow
              onClick={() => {
                if (newThreadTarget) newChat(newThreadTarget);
                else void addLocalFolderProject();
              }}
            />
            <SearchRow
              query={query}
              onQueryChange={setQuery}
              onOpenFirst={() => {
                const first = groups[0]?.shown[0];
                if (first) openThread(first);
              }}
              inputRef={searchInputRef}
            />
            <NeedsYouRow entries={needsYou} onOpen={openThread} projectTitle={projectTitleOf} />
          </nav>

          <SidebarContent>
            <SidebarGroup className="gap-0 py-1">
              {orderedProjects.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sidebar-muted-foreground text-xs">
                  No projects yet.
                  <Button size="xs" variant="outline" onClick={() => void openProjectFromEmpty()}>
                    Open a project
                  </Button>
                </div>
              ) : null}
              {filtering && groups.length === 0 ? (
                <div className="px-2 py-6 text-center text-sidebar-muted-foreground text-xs">
                  No chats match “{query.trim()}”.
                </div>
              ) : null}
              {groups.map(({ project: p, key, all, shown, restCount }) => {
                const expandedAll = !!showAll[key];
                // Any project but the open chat's can be closed (until you open a chat in it again).
                const removable = key !== activeProjectKey;
                return (
                  <div key={key} data-project-group={key} className="mb-2">
                    {/* Project name, then the toggle that reveals its older chats, ＋ and (opened from the list) ×. */}
                    <div className="group/folder flex h-8 items-center gap-1 pr-1 pl-3">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              onContextMenu={(e) => openFolderMenu(p, e)}
                              className="min-w-0 truncate font-semibold text-[14px] text-sidebar-foreground"
                            >
                              {p.title}
                            </span>
                          }
                        />
                        <TooltipPopup side="right">{p.workspaceRoot ?? p.title}</TooltipPopup>
                      </Tooltip>
                      {/* Read, idle and already-opened failed chats fold behind this. */}
                      {!filtering && restCount > 0 ? (
                        <button
                          type="button"
                          aria-expanded={expandedAll}
                          aria-label={
                            expandedAll
                              ? `Show only the chats that need a look in ${p.title}`
                              : `Show ${restCount} more chats in ${p.title}`
                          }
                          onClick={() => setShowAll((prev) => ({ ...prev, [key]: !expandedAll }))}
                          className="flex h-5 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[11.5px] text-sidebar-muted-foreground tabular-nums transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                        >
                          {expandedAll ? "less" : `${restCount} more`}
                          {expandedAll ? (
                            <ChevronUpIcon className="size-3" aria-hidden />
                          ) : (
                            <ChevronDownIcon className="size-3" aria-hidden />
                          )}
                        </button>
                      ) : null}
                      <span className="flex-1" />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={`New chat in this project (${p.title})`}
                              onClick={() => newChat(p)}
                              className="grid size-6 shrink-0 place-items-center rounded-md text-sidebar-muted-foreground opacity-0 transition-[color,opacity] hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/folder:opacity-100"
                            >
                              <PlusIcon className="size-3.5" />
                            </button>
                          }
                        />
                        <TooltipPopup side="right">New chat</TooltipPopup>
                      </Tooltip>
                      {removable ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                className="grid size-6 shrink-0 place-items-center rounded-md text-sidebar-muted-foreground opacity-0 transition-[color,opacity] hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/folder:opacity-100"
                                aria-label={`Hide ${p.title} from the list`}
                                onClick={() => closeDir(key)}
                                type="button"
                              >
                                <XIcon className="size-3.5" />
                              </button>
                            }
                          />
                          <TooltipPopup side="right">
                            Hide from list (it comes back when you open a chat in it)
                          </TooltipPopup>
                        </Tooltip>
                      ) : null}
                    </div>
                    {all.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => newChat(p)}
                        className="w-full rounded-xl px-3 py-2 text-left text-[12px] text-sidebar-muted-foreground/70 transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      >
                        No chats yet — start one
                      </button>
                    ) : (
                      <SidebarMenu className="gap-1">
                        {shown.map((t) => renderCard(t, p))}
                      </SidebarMenu>
                    )}
                  </div>
                );
              })}
              <ArchivedThreads />
            </SidebarGroup>
          </SidebarContent>

          {/* Projects: its own small scrolling list at the bottom. Click one to open it above (again to close it);
              right-click for its menu. Search (above) filters every project. */}
          <div className="shrink-0 border-sidebar-border/60 border-t px-2 pt-2">
            <div className="flex items-center gap-1 pl-1">
              <span className="flex-1 font-medium text-[11px] text-sidebar-muted-foreground">
                Projects
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Open project"
                      onClick={() => void addLocalFolderProject()}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    >
                      <FolderPlusIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Open project</TooltipPopup>
              </Tooltip>
            </div>
            <div
              role="group"
              aria-label="Projects"
              className="mt-1 max-h-36 overflow-y-auto pb-1 [scrollbar-width:thin]"
            >
              {listedProjects.map((p) => {
                const key = projectKey(p);
                const open = groupKeys.has(key);
                const dot = rollupThreadDots((threadsByProject.get(key) ?? []).map(dotOf));
                const count = threadsByProject.get(key)?.length ?? 0;
                return (
                  <div key={key} className="group/project relative">
                    <button
                      type="button"
                      aria-pressed={open}
                      onClick={() => toggleDir(p)}
                      onContextMenu={(e) => openFolderMenu(p, e)}
                      className={cn(
                        "flex h-7 w-full items-center gap-2 rounded-md pr-8 pl-2 text-left text-[12px] transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                        open ? "text-sidebar-foreground" : "text-sidebar-muted-foreground",
                        hidden[key] && "opacity-50",
                      )}
                    >
                      <FolderIcon className="size-3.5 shrink-0 opacity-70" />
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      {dot ? (
                        <span
                          role="img"
                          aria-label={dot.label}
                          className={cn("size-1.5 shrink-0 rounded-full", dot.dotClass)}
                        />
                      ) : null}
                      <span className="shrink-0 text-[11px] text-sidebar-muted-foreground/70 tabular-nums transition-opacity group-hover/project:opacity-0">
                        {count}
                      </span>
                    </button>
                    {/* ＋ starts a chat in this project, open in the list above or not. */}
                    <button
                      type="button"
                      aria-label={`New chat in ${p.title}`}
                      onClick={() => newChat(p)}
                      className="absolute top-0.5 right-0.5 grid size-6 place-items-center rounded-md text-sidebar-muted-foreground opacity-0 transition-[color,opacity] hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/project:opacity-100"
                    >
                      <PlusIcon className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowHidden((v) => !v)}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] text-sidebar-muted-foreground/80 transition-colors hover:text-sidebar-foreground"
                >
                  <EyeIcon className="size-3 shrink-0" />
                  {showHidden ? "Hide hidden projects" : `Show ${hiddenCount} hidden`}
                </button>
              ) : null}
            </div>
          </div>
        </>
      )}

      <SidebarFooter className="flex-row items-center gap-1 border-t border-white/7 px-2 py-2">
        {/* The usage sign (still until hovered) with "N% left": the same details popover as the composer's. */}
        <div className="flex min-w-0 flex-1 items-center">
          {showBlobsNav ? null : (
            <SidebarUsage
              driver={activeThread ? threadAgentId(activeThread) : null}
              model={activeThread?.modelSelection.model ?? null}
              onOpenUsage={() => void router.navigate({ to: "/settings/usage" as never })}
            />
          )}
        </div>
        <UpdateReadyButton />
        {showBlobsNav ? (
          <Suspense fallback={null}>
            <BlobsFooterLinks />
          </Suspense>
        ) : null}
        <button
          type="button"
          aria-label="Settings"
          onClick={() =>
            // Straight to a page: "/settings" redirects with replace, which overwrote the page you came from and
            // left Settings' Back with nowhere to go.
            void router.navigate({ to: showBlobsNav ? "/settings/blobs" : "/settings/general" })
          }
          className="grid size-8 shrink-0 place-items-center rounded-lg text-sidebar-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <SettingsIcon className="size-4" />
        </button>
      </SidebarFooter>
    </>
  );
}
