import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { DEFAULT_CLIENT_PREFS, NAV_WORKING_STYLES } from "@kora/contracts/clientPrefs";
import { __setClientPrefsForTests } from "../hooks/usePrefs";

// ── Environment: a bare window so the component's key listeners can be driven ──
const fakeWindow = Object.assign(new EventTarget(), {
  clearTimeout: globalThis.clearTimeout,
  setTimeout: globalThis.setTimeout,
});
vi.stubGlobal("window", fakeWindow);
// The rename input listens for the user's pointer down on the document.
const fakeDocument = Object.assign(new EventTarget(), {
  querySelector: () => null,
  hasFocus: () => true,
});
vi.stubGlobal("document", fakeDocument);
vi.stubGlobal("navigator", {
  maxTouchPoints: 0,
  vendor: "",
  userAgent: "node",
  platform: "MacIntel",
});

const navigate = vi.fn(async (_input: unknown) => {});
let activeThreadId: string | undefined = "t2";
const lastVisitedAtById: Record<string, string> = {};

const time = (minute: number) => new Date(Date.UTC(2026, 8, 24, 10, minute)).toISOString();
function shell(
  id: string,
  projectId: string,
  minute: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    hostId: "local",
    projectId,
    title: `Chat ${id}`,
    modelSelection: { instanceId: "claude", model: "sonnet" },
    archivedAt: null,
    createdAt: time(0),
    updatedAt: time(minute),
    session: { status: "ready" },
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    ...extra,
  };
}
let threads: Array<Record<string, unknown>> = [];
const projects = [
  { id: "p3", hostId: "local", title: "gamma", workspaceRoot: "/c" },
  { id: "p2", hostId: "local", title: "beta", workspaceRoot: "/b" },
  { id: "p1", hostId: "local", title: "alpha", workspaceRoot: "/a" },
];

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
  useParams: (opts: { select: (p: { threadId: string | undefined }) => unknown }) =>
    opts.select({ threadId: activeThreadId }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../atoms/entities", () => ({
  useDaemonConfigs: () => new Map(),
  useThreadSummaries: () => threads,
  useProjects: () => projects,
}));
vi.mock("../env", () => ({ isNative: false }));
// "Now" sits just after the fixtures' activity, so none of them has settled unless a test says so.
vi.mock("../hooks/useMinuteClock", () => ({ useNowMinute: () => time(30) }));
vi.mock("../hooks/useAddLocalFolderProject", () => ({ useAddLocalFolderProject: () => vi.fn() }));
const openNewThread = vi.fn();
vi.mock("../hooks/useStartThread", () => ({
  useStartThread: () => ({ openNewThread }),
}));
vi.mock("../hooks/useThreadMenu", () => ({
  useThreadMenu: () => ({ openMenu: vi.fn() }),
}));
vi.mock("../atoms/hosts", () => ({ useHosts: () => ({ environments: [] }) }));
vi.mock("../atoms/threads", () => ({ threadHost: { updateMetadata: {} } }));
vi.mock("../atoms/use-atom-command", () => ({ useAtomAction: () => vi.fn() }));
vi.mock("../localApi", () => ({ readLocalApi: () => null }));
// The Kora surface switch reads the blobs roster; these tests are about the Code tab (Kora coming soon).
vi.mock("../koraSurface", () => ({ useKoraSurfaceOn: () => false }));
// These tests are about the Code tab's thread tree (also a new user's default surface).
vi.mock("./assistant/surfaceStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assistant/surfaceStore")>()),
  useAppSurfaceStore: () => ["code", () => undefined],
}));
vi.mock("../util/terminalFocus", () => ({
  isTerminalFocused: () => false,
  terminalFocusOwner: () => null,
}));
// The working sprite's frames need a real element; the tests only look for its mount.
vi.mock("./thread/LeadBlob", () => ({
  LeadBlob: ({ mood }: { mood: string }) => <i data-sprite={mood} />,
}));
vi.mock("./nav/SidebarUsage", () => ({ SidebarUsage: () => null }));
const seedThreadVisits = () => {};
vi.mock("../stores/uiStateStore", () => ({
  useViewStateStore: (
    select: (s: {
      threadLastVisitedAtById: Record<string, string>;
      seedThreadVisits: () => void;
    }) => unknown,
  ) => select({ threadLastVisitedAtById: lastVisitedAtById, seedThreadVisits }),
}));
vi.mock("./thread/ChatHeader", () => ({ resolveRenameCommit: () => ({ action: "noop" }) }));
vi.mock("./thread/AgentProfileIcon", () => ({ AgentProfileIcon: () => null }));
vi.mock("./nav/NavChrome", () => ({ NavChromeHeader: () => null }));
vi.mock("./nav/ArchivedThreads", () => ({ ArchivedThreads: () => null }));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./ui/tooltip", () => ({
  TooltipPopup: () => null,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./ui/sidebar", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    SidebarMenuButton: ({
      children,
      onClick,
      onPointerEnter,
      tooltip,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      onPointerEnter?: () => void;
      tooltip?: { children?: ReactNode; hidden?: boolean };
    }) => (
      <button
        type="button"
        data-row
        data-tooltip={tooltip?.children}
        data-tooltip-hidden={tooltip?.hidden}
        onClick={onClick}
        onPointerEnter={onPointerEnter}
      >
        {children}
      </button>
    ),
    SidebarMenuItem: Pass,
    SidebarMenu: Pass,
    SidebarGroup: Pass,
    SidebarFooter: Pass,
    SidebarContent: Pass,
  };
});

let ThreadNav: typeof import("./ThreadNav").default;
beforeAll(async () => {
  ({ default: ThreadNav } = await import("./ThreadNav"));
}, 30_000);

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  navigate.mockClear();
  openNewThread.mockClear();
});

// Title spans report overflow when their thread title is longer than this many characters.
let truncateAfter = Infinity;
let nodeMocks: Array<{ type: string; node: { focus: ReturnType<typeof vi.fn> } }> = [];
function render() {
  act(() => {
    renderer = create(<ThreadNav />, {
      createNodeMock: (element) => {
        const text = String((element.props as { children?: unknown }).children ?? "");
        const node = {
          contains: (other: unknown) => other === node,
          focus: vi.fn(),
          select: vi.fn(),
          clientWidth: Math.min(text.length, truncateAfter),
          scrollWidth: text.length,
        };
        nodeMocks.push({ type: String(element.type), node });
        return node;
      },
    });
  });
  return renderer!;
}

function row(tree: ReactTestRenderer, title: string) {
  return tree.root.find(
    (node) =>
      node.type === "button" &&
      node.props["data-row"] !== undefined &&
      node.props["data-tooltip"] === title,
  );
}

function rowTitles(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => node.type === "button" && node.props["data-row"] !== undefined)
    .map((node) => {
      // Cards mark their title; compact rows truncate it.
      const card = node.findAll((child) => child.props["data-card-title"] !== undefined);
      const titles = card.length
        ? card
        : node.findAll(
            (child) =>
              typeof child.props.className === "string" &&
              /(^|\s)truncate(\s|$)/.test(child.props.className),
          );
      return titles.map((child) => child.children.join("")).join("");
    });
}

function press(init: { key: string; metaKey?: boolean; shiftKey?: boolean }) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    ...init,
  });
  act(() => {
    fakeWindow.dispatchEvent(event);
  });
  return event;
}

function navigatedThreadId(): string | undefined {
  const call = navigate.mock.calls.at(-1)?.[0] as { params?: { threadId?: string } } | undefined;
  return call?.params?.threadId;
}

describe("ThreadNav", () => {
  it("shows the full title on hover only when the row truncates it", () => {
    threads = [
      shell("t1", "p1", 1, {
        pinnedAt: time(1),
        title: "A very long thread title that cannot fit",
      }),
      shell("t2", "p1", 5, { title: "Short" }),
    ];
    activeThreadId = "t2";
    truncateAfter = 10;
    const tree = render();
    try {
      const long = () => row(tree, "A very long thread title that cannot fit");
      const short = () => row(tree, "Short");
      expect(long().props["data-tooltip-hidden"]).toBe(true);

      act(() => long().props.onPointerEnter());
      act(() => short().props.onPointerEnter());
      expect(long().props["data-tooltip-hidden"]).toBe(false);
      expect(short().props["data-tooltip-hidden"]).toBe(true);
    } finally {
      truncateAfter = Infinity;
    }
  });

  it("renames a non-active row on double-click, even when the first click re-renders it", () => {
    // t1 is pinned so it shows beside the open chat (only the open one would otherwise).
    threads = [shell("t1", "p1", 1, { pinnedAt: time(1) }), shell("t2", "p1", 5)];
    activeThreadId = "t2";
    const tree = render();

    act(() => row(tree, "Chat t1").props.onClick());
    expect(navigatedThreadId()).toBe("t1");

    // The navigation makes t1 active and the sidebar re-renders from scratch before click two.
    act(() => tree.unmount());
    activeThreadId = "t1";
    const next = render();
    act(() => row(next, "Chat t1").props.onClick());

    const input = next.root.findAll((node) => node.type === "input" && node.props.autoFocus);
    expect(input).toHaveLength(1);
    expect(input[0]!.props.value).toBe("Chat t1");
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("shows only the open chat per project; the more toggle under it and the Projects list reveal the rest", () => {
    threads = [
      shell("t1", "p1", 1),
      shell("t2", "p1", 5),
      shell("t9", "p2", 4),
      shell("old", "p1", 2, { updatedAt: new Date(Date.UTC(2026, 8, 17)).toISOString() }),
    ];
    activeThreadId = "t2";
    const tree = render();
    // alpha shows just the open chat; beta (nothing opened, nothing going on) has no group.
    expect(rowTitles(tree)).toEqual(["Chat t2"]);

    const toggle = tree.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Show 2 more chats in alpha",
    );
    act(() => toggle.props.onClick());
    expect(rowTitles(tree)).toEqual(["Chat t2", "Chat t1", "Chat old"]);

    // gamma has no chats, so it has no group until it is opened from the Projects list.
    const hasGammaGroup = () =>
      tree.root.findAll((node) => node.props["data-project-group"] === "local:p3").length > 0;
    expect(hasGammaGroup()).toBe(false);
    const gamma = tree.root.find(
      (node) =>
        node.type === "button" &&
        node.props["aria-pressed"] !== undefined &&
        node.findAll((child) => child.children.includes("gamma")).length > 0,
    );
    act(() => gamma.props.onClick());
    expect(hasGammaGroup()).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain("No chats yet");
  });

  it("filters chats by title and puts a status dot on a project with work going on", () => {
    threads = [
      shell("t1", "p1", 1),
      shell("t2", "p1", 5),
      shell("t9", "p2", 4, { session: { status: "running" } }),
    ];
    activeThreadId = "t2";
    const tree = render();

    // beta's row in the Projects list carries the roll-up dot: one of its chats is running.
    const rollup = tree.root.findAll(
      (node) => node.type === "span" && node.props["aria-label"] === "Working",
    );
    expect(rollup).toHaveLength(1);

    const input = tree.root.find(
      (node) => node.type === "input" && node.props["aria-label"] === "Search chats",
    );
    act(() => input.props.onChange({ target: { value: "t9" } }));
    expect(rowTitles(tree)).toEqual(["Chat t9"]);

    act(() => input.props.onChange({ target: { value: "nothing-matches" } }));
    expect(JSON.stringify(tree.toJSON())).toContain("No chats match");
  });

  it("shows a working thread with the working sprite, not a grey dot", () => {
    threads = [
      shell("t9", "p2", 4, {
        session: { status: "running" },
        latestTurn: {
          turnId: "turn1",
          state: "running",
          requestedAt: time(20),
          startedAt: time(20),
          completedAt: null,
        },
      }),
    ];
    activeThreadId = "t9";
    const tree = render();
    const working = tree.root.findAll((node) => node.props["data-thread-working"] !== undefined);
    expect(working).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain('"data-sprite":"working"');
    const described = tree.root.findAll(
      (n) =>
        typeof n.props["aria-description"] === "string" &&
        n.props["aria-description"].includes("Working"),
    );
    expect(described.length).toBeGreaterThan(0);
  });

  it("marks a working row in the style picked in Settings, and no idle row", () => {
    const running = {
      session: { status: "running" as const },
      latestTurn: {
        turnId: "turn1",
        state: "running" as const,
        requestedAt: time(20),
        startedAt: time(20),
        completedAt: null,
      },
    };
    threads = [shell("t9", "p2", 4, running), shell("t8", "p2", 3)];
    activeThreadId = "t9";
    const marks = () =>
      renderer!.root.findAll(
        (n) =>
          typeof n.props.className === "string" && n.props.className.includes("nav-working-fx"),
      );
    render();
    expect(marks()).toHaveLength(1);
    expect(marks()[0]!.props["data-style"]).toBe("outline");
    for (const style of NAV_WORKING_STYLES.filter((s) => s !== "outline")) {
      __setClientPrefsForTests({ ...DEFAULT_CLIENT_PREFS, sidebarWorkingStyle: style });
      act(() => renderer?.unmount());
      render();
      expect(marks()[0]!.props["data-style"]).toBe(style);
    }
    __setClientPrefsForTests(DEFAULT_CLIENT_PREFS);
  });

  it("lists threads that need the user in a Needs you row, hidden when there are none", () => {
    threads = [shell("t1", "p1", 1)];
    activeThreadId = "t1";
    expect(render().root.findAll((n) => n.props["data-needs-you"] !== undefined)).toHaveLength(0);
    act(() => renderer?.unmount());

    threads = [shell("t1", "p1", 1), shell("t5", "p2", 5, { hasPendingApprovals: true })];
    const tree = render();
    const needs = tree.root.find(
      (n) => n.type === "button" && n.props["data-needs-you"] !== undefined,
    );
    expect(JSON.stringify(needs.props["aria-label"])).toContain("1 chat needs you");
    act(() => needs.props.onClick());
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("binds ⌘N to a new thread and ⌘K to Search, and nothing else", () => {
    threads = [shell("t1", "p1", 1)];
    activeThreadId = "t1";
    nodeMocks = [];
    render();
    expect(press({ key: "n", metaKey: true }).defaultPrevented).toBe(true);
    expect(openNewThread).toHaveBeenCalledTimes(1);
    expect(press({ key: "k", metaKey: true }).defaultPrevented).toBe(true);
    // ⌘K lands in the Search row's input.
    expect(nodeMocks.some((m) => m.type === "input" && m.node.focus.mock.calls.length > 0)).toBe(
      true,
    );
    expect(press({ key: "n", metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(openNewThread).toHaveBeenCalledTimes(1);
  });

  it("has no keyboard shortcuts for switching threads: modifier chords never switch them", () => {
    threads = [shell("t1", "p1", 1), shell("t2", "p1", 5), shell("t9", "p1", 3)];
    activeThreadId = "t2";
    render();

    for (const init of [
      { key: "3", metaKey: true },
      { key: "[", metaKey: true, shiftKey: true },
      { key: "]", metaKey: true, shiftKey: true },
    ]) {
      expect(press(init).defaultPrevented).toBe(false);
    }
    expect(navigate).not.toHaveBeenCalled();
  });
  it("shows a project's pinned chats and the open one, pinned first; the rest wait behind the toggle", () => {
    threads = [
      shell("t1", "p1", 1),
      shell("t2", "p1", 5),
      shell("t9", "p1", 2, { pinnedAt: time(3), pinOrderKey: "a0" }),
    ];
    activeThreadId = "t2";
    expect(rowTitles(render())).toEqual(["Chat t9", "Chat t2"]);
  });

  // The real sequence (traced in Chromium): click 1 navigates, click 2 starts the rename and the
  // input takes focus, then ~120 ms later the opened thread focuses its composer. That blur is not
  // the user leaving, so the rename must survive it and take focus back.
  function startRenameOnNonActiveRow() {
    // t1 is pinned so it shows beside the open chat (only the open one would otherwise).
    threads = [shell("t1", "p1", 1, { pinnedAt: time(1) }), shell("t2", "p1", 5)];
    activeThreadId = "t2";
    nodeMocks = [];
    const first = render();
    act(() => row(first, "Chat t1").props.onClick());
    act(() => first.unmount());
    activeThreadId = "t1";
    const tree = render();
    act(() => row(tree, "Chat t1").props.onClick());
    const input = () => tree.root.findAll((node) => node.type === "input" && node.props.autoFocus);
    expect(input()).toHaveLength(1);
    return { tree, input };
  }

  it("commits the rename when the user clicks away", () => {
    const { input } = startRenameOnNonActiveRow();
    act(() => {
      const down = new Event("pointerdown");
      Object.defineProperty(down, "target", { value: { elsewhere: true } });
      fakeDocument.dispatchEvent(down);
    });
    act(() => input()[0]!.props.onBlur({ currentTarget: { value: "Chat t1" } }));
    expect(input()).toHaveLength(0);
  });

  it("keeps the rename open when the opened thread's composer steals focus", async () => {
    const { input } = startRenameOnNonActiveRow();
    const inputNode = nodeMocks.findLast((m) => m.type === "input")!.node;

    act(() => input()[0]!.props.onBlur({ currentTarget: { value: "Chat t1" } }));
    expect(input()).toHaveLength(1);
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(inputNode.focus).toHaveBeenCalledTimes(1);
  });
});
