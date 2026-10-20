import { HostId, ItemId, TurnId } from "@kora/contracts";
import type { LegendListRef, MaintainScrollAtEndOptions } from "@legendapp/list/react";
import { act, createRef, useLayoutEffect, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { shouldUseRestingPromptLayout } from "../promptFooterLayout";
import { usePromptFocusState } from "./usePromptFocusState";

// ---- module doubles -----------------------------------------------------------------------------

type ListRow = { id: string };
type ListProps = {
  ListFooterComponent?: ReactNode;
  ListHeaderComponent?: ReactNode;
  data: ListRow[];
  renderItem: (args: { item: ListRow }) => ReactNode;
  keyExtractor: (row: ListRow) => string;
  className?: string;
  contentInsetEndAdjustment?: number;
  maintainScrollAtEnd?: boolean | MaintainScrollAtEndOptions;
  maintainVisibleContentPosition?:
    | boolean
    | { data?: boolean; size?: boolean; shouldRestorePosition?: unknown };
  anchoredEndSpace?: {
    anchorIndex: number;
    anchorOffset?: number;
    anchorMaxSize?: number;
    onReady?: (info: { anchorIndex: number }) => void;
  };
};

// The list double prints the props the transcript chose as data attributes, so the tests can read
// the scroll policy straight off the markup.
vi.mock("@legendapp/list/react", () => {
  const FakeLegendList = (props: ListProps) => {
    const anchor = props.anchoredEndSpace;
    anchor?.onReady?.({ anchorIndex: anchor.anchorIndex });
    const follow = props.maintainScrollAtEnd;
    const followOn = typeof follow === "object" ? follow.on : undefined;
    const keep = props.maintainVisibleContentPosition;
    const attrs: Record<string, unknown> = {
      "data-testid": "transcript-list",
      "data-list-class": props.className,
      "data-inset-end": props.contentInsetEndAdjustment,
      "data-anchor-at": anchor?.anchorIndex,
      "data-anchor-offset": anchor?.anchorOffset,
      "data-anchor-max": anchor?.anchorMaxSize,
      "data-follow": follow ? "on" : undefined,
      "data-follow-animated": typeof follow === "object" ? follow.animated : undefined,
      "data-follow-on": followOn
        ? Object.entries(followOn)
            .map(([event, enabled]) => `${event}=${enabled}`)
            .toSorted()
            .join(",")
        : undefined,
      "data-keep-position":
        typeof keep === "object"
          ? `data=${keep.data},size=${keep.size},restore=${Boolean(keep.shouldRestorePosition)}`
          : keep,
    };
    const { ListHeaderComponent: header, ListFooterComponent: footer } = props;
    const rows = props.data.map((row) => (
      <div key={props.keyExtractor(row)}>{props.renderItem({ item: row })}</div>
    ));
    return (
      <div {...attrs}>
        {header}
        {rows}
        {footer}
      </div>
    );
  };
  return { LegendList: FakeLegendList };
});

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: { fileDiff: { name?: string | null } }) => (
    <div data-testid="file-diff">{props.fileDiff.name ?? "diff"}</div>
  ),
}));
vi.mock("../DiffWorkers", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

let ThreadTranscript: typeof import("./ThreadTranscript").ThreadTranscript;

beforeAll(async () => {
  const ignore = () => undefined;
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: ignore,
    removeItem: ignore,
    clear: ignore,
  });
  const classList = { contains: () => false, toggle: ignore, remove: ignore, add: ignore };
  vi.stubGlobal("document", { documentElement: { classList, offsetHeight: 0 } });
  vi.stubGlobal("window", {
    shellBridge: undefined,
    addEventListener: ignore,
    removeEventListener: ignore,
    matchMedia: () => ({ matches: false, addEventListener: ignore, removeEventListener: ignore }),
    requestAnimationFrame: (run: FrameRequestCallback) => (run(0), 0),
    cancelAnimationFrame: ignore,
  });
  ({ ThreadTranscript } = await import("./ThreadTranscript"));
}, 30_000);

// ---- transcript builders ------------------------------------------------------------------------

type Props = ComponentProps<typeof ThreadTranscript>;
type Entry = Props["timelineEntries"][number];

const AT = "2026-04-11T09:30:00.000Z";
const second = (n: number) => `2026-04-11T09:30:${String(n).padStart(2, "0")}.000Z`;

const baseProps = (): Omit<Props, "timelineEntries"> => ({
  activeThreadHostId: HostId.make("environment-local"),
  routeThreadKey: "environment-local:thread-1",
  listRef: createRef<LegendListRef | null>(),
  anchorMessageId: null,
  liveFollowEnabled: true,
  isWorking: false,
  runningTurnId: null,
  latestTurn: null,
  activeTurnStartedAt: null,
  contentInsetEndAdjustment: 0,
  markdownCwd: undefined,
  workspaceRoot: undefined,
  ...{ timestampFormat: "locale", resolvedTheme: "light" },
  onAnchorReady: () => {},
  onIsAtEndChange: () => {},
  onImageExpand: () => {},
  onManualNavigation: () => {},
});

type Role = "user" | "assistant";
const message = (
  role: Role,
  text: string,
  options: { id?: string; turnId?: TurnId; context?: unknown } = {},
): Entry =>
  ({
    id: `row-${options.id ?? "m1"}`,
    kind: "message",
    createdAt: AT,
    message: {
      id: ItemId.make(options.id ?? "m1"),
      role,
      text,
      turnId: options.turnId ?? null,
      streaming: false,
      createdAt: AT,
      updatedAt: AT,
      ...(options.context === undefined ? {} : { context: options.context }),
    },
  }) as Entry;

const user = (text: string, id?: string) => message("user", text, id === undefined ? {} : { id });
const assistant = (text: string, options?: { id?: string; turnId?: TurnId }) =>
  message("assistant", text, options);

/** A work-log row; `fields` are the work entry's own fields. */
const work = (id: string, fields: Record<string, unknown>, createdAt = AT): Entry =>
  ({ id: `row-${id}`, kind: "work", createdAt, entry: { id, createdAt, ...fields } }) as Entry;

/** The fields every shell-command work row shares. */
const SHELL = { itemType: "command_execution", tone: "tool" } as const;

const command = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  work(id, {
    ...SHELL,
    toolLifecycleStatus: status,
    label: "Run command",
    ...extra,
  });

/** Props for a turn that is running right now. */
const running = (turnId: TurnId) => ({
  isWorking: true,
  runningTurnId: turnId,
  activeTurnStartedAt: AT,
  latestTurn: { turnId, state: "running" as const, startedAt: AT, completedAt: null },
});

const render = (timelineEntries: Entry[], extra: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <ThreadTranscript {...baseProps()} {...extra} timelineEntries={timelineEntries} />,
  );

const longPrompt = (lastLine = "the detail only shown once expanded") =>
  [
    ...Array.from(
      { length: 8 },
      (_, n) => `Point ${n + 1}: ${"a long winded sentence ".repeat(8)}`,
    ),
    lastLine,
  ].join("\n");

const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- work log -----------------------------------------------------------------------------------

describe("work log rows", () => {
  it("colours only severe chat failures red", () => {
    const severe = render([
      work("info", { tone: "info", label: "Status updated" }, second(1)),
      work(
        "start",
        {
          tone: "error",
          label: "Provider turn start failed",
          sourceActivityKind: "provider.turn.start.failed",
        },
        second(2),
      ),
    ]);
    expect(severe).toContain("text-destructive");

    const ordinary = render([
      work("info", { tone: "info", label: "Status updated" }, second(1)),
      work(
        "glob",
        { tone: "tool", label: "Glob", toolLifecycleStatus: "failed", detail: "No files found" },
        second(2),
      ),
    ]);
    expect(ordinary).not.toContain("text-destructive");
    expect(ordinary).toContain('aria-label="Received 1 update and used 1 tool, tool call failed"');
  });

  it("summarises a group neutrally, keeping a failure audible to screen readers", () => {
    const failingLast = render([
      command("a", "completed", { label: "Run tests" }),
      command("b", "failed", { label: "Run lint" }),
    ]);
    expect(failingLast).toContain("Ran 2 commands");
    expect(failingLast).toContain("text-icon-muted");
    expect(failingLast).not.toContain("text-destructive");
    expect(failingLast).toContain("tool call failed");

    const failingFirst = render([command("a", "failed"), command("b", "completed")]);
    expect(failingFirst).toContain("Ran 2 commands");
    expect(failingFirst).not.toContain('aria-label="Tool call failed"');

    const mixed = render([
      work(
        "c1",
        {
          ...SHELL,
          toolLifecycleStatus: "completed",
          label: "Run tests",
        },
        second(3),
      ),
      work("i1", { tone: "info", label: "Status updated" }, second(2)),
      work(
        "c2",
        {
          ...SHELL,
          toolLifecycleStatus: "failed",
          label: "Run search",
        },
        second(1),
      ),
    ]);
    expect(mixed).toContain("Ran 2 commands and received 1 update");
    expect(mixed).not.toContain('aria-label="Hidden work includes a failure"');
  });

  it("names changed files by base name, not by full path", () => {
    const root = "D:/work/kora";
    const markup = render(
      [
        work("files", {
          tone: "tool",
          label: "Updated files",
          changedFiles: [`${root}/apps/web/src/session-logic.ts`],
        }),
      ],
      { workspaceRoot: root },
    );
    expect(markup).toContain("Changed session-logic.ts");
    expect(markup).not.toContain(`${root}/apps/web`);
  });

  it("shows compaction notes like any other entry", () => {
    expect(
      render([work("compact", { tone: "info", label: "Compacted context 512K → 12K tokens" })]),
    ).toContain("Compacted context 512K → 12K tokens");
  });

  it("folds tool calls after the last reply away once the turn ended", () => {
    const turnId = TurnId.make("turn-tail");
    const markup = render(
      [
        assistant("Searching now.", { id: "reply", turnId }),
        work(
          "tail",
          {
            ...SHELL,
            toolLifecycleStatus: "failed",
            label: "Ran command",
            turnId,
          },
          second(5),
        ),
      ],
      { latestTurn: { turnId, state: "error", startedAt: second(1), completedAt: second(5) } },
    );
    expect(markup).toContain('data-transcript-row-id="row-reply"');
    expect(markup).not.toContain('data-transcript-row-id="row-tail"');
    expect(count(markup, /Searching now\./g)).toBe(1);
  });

  it("puts a finished turn behind the lead blob rather than a Worked-for row", () => {
    const turnId = TurnId.make("turn-done");
    const markup = render(
      [
        work(
          "w",
          { tone: "tool", label: "Ran command", toolLifecycleStatus: "completed", turnId },
          second(2),
        ),
        assistant("Done.", { turnId }),
      ],
      { latestTurn: { turnId, state: "completed", startedAt: second(0), completedAt: second(8) } },
    );
    expect(markup).not.toContain("Worked for");
    expect(markup).toContain('aria-label="Show what the agent did"');
  });
});

describe("live turn", () => {
  const turnId = TurnId.make("turn-now");

  it("shows only the working blob before anything happened", () => {
    const markup = render([], running(turnId));
    expect(markup).toContain('data-transcript-row-id="working-indicator-row"');
    expect(markup).toContain('data-mood="working"');
    expect(markup).not.toContain("Thinking");
  });

  it("labels the live tool in the present tense with one blob", () => {
    const markup = render(
      [command("lint", "completed", { command: "pnpm lint", toolCallId: "c1", turnId })],
      running(turnId),
    );
    expect(markup).toContain("Running pnpm");
    expect(markup).not.toContain("Ran pnpm");
    expect(count(markup, /data-mood="working"/g)).toBe(1);
    expect(markup).not.toContain('data-transcript-row-kind="thinking"');
  });

  it("does not pin an earlier tool's failure on the running row", () => {
    const markup = render(
      [
        command("lint", "failed", { command: "pnpm lint", toolCallId: "c1", turnId }),
        command("test", "inProgress", { command: "pnpm test", toolCallId: "c2", turnId }),
      ],
      running(turnId),
    );
    expect(markup).toContain("Running pnpm");
    expect(markup).not.toContain("tool call failed");
  });
});

// ---- messages -----------------------------------------------------------------------------------

describe("user messages", () => {
  it("renders structured context records as chips and leaves unknown links inert", () => {
    const record = {
      version: 1,
      kind: "terminal",
      contextId: "ctx-1",
      label: "Terminal 2 line 9",
      terminalId: "default",
      terminalLabel: "Terminal 2",
      lineStart: 9,
      lineEnd: 9,
      text: "oops",
    };
    const markup = render([
      message(
        "user",
        "See [Terminal 2 line 9](kora-context://v1/terminal/ctx-1) and [old](kora-context://v1/later/ctx-2).",
        {
          context: { version: 1, records: [record] },
        },
      ),
    ]);
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("Terminal 2 line 9");
    expect(markup).toContain('data-context-unresolved="true"');
    expect(markup).toContain(">old<");
    expect(markup).not.toContain('href="kora-context://');
  });

  it("turns review comments into cards: source code for files, diffs for turns", () => {
    const fileComment = render([
      user(
        [
          '<review_comment sectionId="file:notes/todo.md" sectionTitle="File comment" filePath="notes/todo.md" startIndex="0" endIndex="1" rangeLabel="L3 to L4">',
          "Reword this.",
          "```md",
          "- buy milk",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(fileComment).toContain("todo.md L3 to L4");
    expect(fileComment).not.toContain("review_comment");
    expect(fileComment).not.toContain('data-testid="file-diff"');

    const turnComment = render([
      user(
        [
          '<review_comment sectionId="turn:4" sectionTitle="Turn 4" filePath="src/math/add.test.ts" startIndex="1" endIndex="6" rangeLabel="+10 to +12">',
          "Why?",
          "```diff",
          "@@ -0,0 +10,1 @@",
          "+  expect(add(1, 1)).toBe(2);",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(turnComment).toContain("add.test.ts +10 to +12");
    expect(turnComment).toContain("lucide-message-circle");
    expect(turnComment).not.toContain(">Review comment<");
    expect(turnComment).not.toContain("&lt;review_comment");
  });

  it("renders picked elements and terminal excerpts as chips", () => {
    const element = render([
      user(
        [
          "<element_context>",
          "- <CheckoutForm> (Form.tsx:40):",
          "  url: https://shop.test/cart",
          "  selector: form.checkout",
          "  source: /app/src/Form.tsx:40:3",
          "  html:",
          '  <form class="checkout"></form>',
          "</element_context>",
        ].join("\n"),
      ),
    ]);
    expect(element).toContain("CheckoutForm");
    expect(element).not.toContain("element_context");

    const terminal = render([
      user(
        [
          longPrompt("what does @terminal-1:1-2 say"),
          "",
          "<terminal_context>",
          "- Terminal 1 lines 1-2:",
          "  1 | dev@box ~ % npm ci",
          "  2 | added 12 packages",
          "</terminal_context>",
        ].join("\n"),
      ),
    ]);
    expect(terminal).toContain("Terminal 1 lines 1-2");
    expect(terminal).toContain("lucide-terminal");
    expect(terminal).toContain("what does");
    expect(terminal).not.toContain("terminal_context");
  }, 20_000);

  it("shows user HTML and XML-like text as inert source", () => {
    const html = render([
      user('<script>window.hit = 1</script><img src="x" onerror="window.hit = 2">'),
    ]);
    expect(html).toContain("&lt;script&gt;window.hit = 1&lt;/script&gt;");
    expect(html).not.toMatch(/<script(?:\s|>)/i);
    expect(html).not.toMatch(/<img(?:\s|>)/i);

    const xml = render([
      user(
        [
          'Do you see <workspace-rules level="strict">',
          'a <b-tag x="1&2">mid</b-tag> b',
          "</workspace-rules>?",
          "1 < 2 > 0",
        ].join("\n"),
      ),
    ]);
    expect(xml).toContain("&lt;workspace-rules level=&quot;strict&quot;&gt;");
    expect(xml).toContain("a &lt;b-tag x=&quot;1&amp;2&quot;&gt;mid&lt;/b-tag&gt; b");
    expect(xml).toContain("1 &lt; 2 &gt; 0");

    const code = render([
      user(['Inline `<v a="1">`', "", "```xml", "<doc><x /></doc>", "```"].join("\n")),
    ]);
    expect(code).toContain('<code data-inline-code="">&lt;v a=&quot;1&quot;&gt;</code>');
    expect(code).toContain("&lt;doc&gt;&lt;x /&gt;&lt;/doc&gt;");
  });

  it("drops markdown titles and gates remote images behind a click", () => {
    const markup = render([
      user('[site](https://docs.test "tip one") ![pic](https://img.test/a.png "tip two")'),
    ]);
    expect(markup).toContain('href="https://docs.test"');
    expect(markup).not.toContain('title="tip one"');
    expect(markup).not.toContain('title="tip two"');
    expect(markup).not.toContain('src="https://img.test/a.png"');
    expect(markup).toContain("data-remote-media-gate");
    expect(markup).toContain("Load image from img.test");
  });

  it("collapses only long messages and keeps the copy button either way", () => {
    const short = render([user("Quick one.")]);
    expect(short).not.toContain("Show full message");
    expect(short).toContain('data-user-message-collapsible="false"');
    expect(short).toContain("rounded-br-md bg-message px-4 py-2.5");

    const long = render([user(longPrompt())]);
    for (const marker of [
      "Show full message",
      'aria-label="Copy message"',
      'data-user-message-collapsed="true"',
      'data-user-message-fade="true"',
      'data-user-message-footer="true"',
    ]) {
      expect(long).toContain(marker);
    }
  });
});

describe("assistant messages", () => {
  it("keeps supported HTML and strips anything executable", () => {
    const markup = render([
      assistant(
        '<details open onclick="window.hit = 1"><summary>Shown</summary><script>window.hit = 2</script>' +
          '<img src="x" onerror="window.hit = 3"><a href="javascript:window.hit = 4">bad</a></details>',
      ),
    ]);
    expect(markup).toContain('data-markdown-details=""');
    expect(markup).toContain("Shown");
    for (const banned of ["onclick=", "onerror=", "javascript:", "window.hit"]) {
      expect(markup).not.toContain(banned);
    }
    expect(markup).not.toMatch(/<script(?:\s|>)/i);
  });

  it("renders plain raw HTML blocks", () => {
    const markup = render([assistant("<details><summary>More</summary>Body</details>")]);
    expect(markup).toContain('data-markdown-details=""');
    expect(markup).not.toContain("&lt;details&gt;");
  });
});

// ---- scroll policy ------------------------------------------------------------------------------

describe("scrolling", () => {
  const first = user("First prompt.", "m1");
  const second_ = user("Newest prompt.", "m2");

  it("follows the end on data and layout changes, snapping when idle", () => {
    const idle = render([user(longPrompt())]);
    expect(idle).toContain('data-follow="on"');
    expect(idle).toContain('data-follow-animated="false"');
    expect(idle).toContain(
      'data-follow-on="dataChange=true,footerLayout=false,itemLayout=true,layout=true"',
    );

    expect(render([user("Hi")], { isWorking: true })).toContain('data-follow-animated="true"');
  });

  it("lets the send anchor own the end until it is released, and reading history beats both", () => {
    const entries = [first, second_];
    expect(render(entries, { anchorMessageId: ItemId.make("m1") })).not.toContain(
      'data-follow="on"',
    );
    expect(render(entries)).toContain('data-follow="on"');
    expect(render(entries, { liveFollowEnabled: false })).not.toContain('data-follow="on"');
  });

  it("reserves end space for the first prompt only, offset by its measured height", () => {
    const onAnchorReady = vi.fn();
    const markup = render([first], {
      anchorMessageId: ItemId.make("m1"),
      contentInsetEndAdjustment: 144,
      onAnchorReady,
    });
    expect(markup).toContain('data-anchor-at="0"');
    expect(markup).toContain('data-anchor-offset="24"');
    expect(markup).not.toContain("data-anchor-max=");
    expect(markup).toContain('data-inset-end="144"');
    expect(markup).toContain("[overflow-anchor:none]");
    expect(markup).toContain('data-keep-position="data=true,size=true,restore=true"');
    expect(markup).not.toContain('data-follow="on"');
    expect(onAnchorReady).toHaveBeenCalledExactlyOnceWith(ItemId.make("m1"), 0);

    const followUp = vi.fn();
    const later = render([first, second_], {
      anchorMessageId: ItemId.make("m2"),
      onAnchorReady: followUp,
    });
    expect(later).not.toContain("data-anchor-at=");
    expect(later).toContain('data-follow="on"');
    expect(followUp).not.toHaveBeenCalled();
  });

  it("keeps the reserved space when tools start while the user reads history", () => {
    const turnId = TurnId.make("turn-read");
    const markup = render(
      [first, command("git", "inProgress", { command: "git status", toolCallId: "c1", turnId })],
      { ...running(turnId), anchorMessageId: ItemId.make("m1"), liveFollowEnabled: false },
    );
    expect(markup).toContain('data-anchor-at="0"');
    expect(markup).not.toContain('data-follow="on"');
  });

  it("counts only the true list end as the live edge", async () => {
    const { resolveTranscriptIsAtEnd: atEnd } = await import("./ThreadTranscript.logic");
    const geometry = { contentLength: 2_000, scrollLength: 800 };
    expect(atEnd(undefined)).toBeUndefined();
    expect(atEnd({ isAtEnd: true })).toBe(true);
    expect(atEnd({ isAtEnd: false })).toBe(false);
    // Inside the few-pixel band above the bottom.
    expect(atEnd({ ...geometry, scroll: 1_170, isAtEnd: false })).toBe(true);
    // Half a viewport up, or hidden under the composer, is not the end whatever the list says.
    expect(atEnd({ ...geometry, scroll: 900, isAtEnd: false })).toBe(false);
    expect(atEnd({ ...geometry, scroll: 1_100, isAtEnd: true })).toBe(false);
  });
});

// ---- interaction (react-test-renderer) ----------------------------------------------------------

/** Queues animation frames so a test can step through them. */
const manualFrames = () => {
  const queue = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => (queue.set(++id, run), id));
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => queue.delete(frame));
  return () =>
    act(() => {
      const due = [...queue.values()];
      queue.clear();
      for (const run of due) run(0);
    });
};

describe("interaction", () => {
  it("withholds a tool label click only when it ends a text selection", async () => {
    manualFrames();
    let tree: ReactTestRenderer | undefined;
    try {
      await act(() => {
        tree = create(
          <ThreadTranscript
            {...baseProps()}
            timelineEntries={[
              command("solo", "completed", {
                command: "pnpm lint",
                toolCallId: "c1",
                label: "Run lint",
              }),
            ]}
          />,
        );
      });
      await act(() => tree!.root.findByProps({ "aria-expanded": false }).props.onClick());
      const [label] = tree!.root.findAll(
        (node) => node.type === "span" && String(node.props.className).includes("select-text"),
      );
      const stopPropagation = vi.fn();
      const clickWith = (isCollapsed: boolean) =>
        label!.props.onClick({
          stopPropagation,
          currentTarget: { ownerDocument: { getSelection: () => ({ isCollapsed }) } },
        });
      clickWith(true);
      expect(stopPropagation).not.toHaveBeenCalled();
      clickWith(false);
      expect(stopPropagation).toHaveBeenCalledOnce();
    } finally {
      await act(() => tree?.unmount());
    }
  });

  it("snaps to the end while a thread switch settles, then glides again", () => {
    const step = manualFrames();
    const rows = [command("w", "completed", { command: "pnpm lint", toolCallId: "c1" })];
    const view = (routeThreadKey: string) => (
      <ThreadTranscript
        {...baseProps()}
        isWorking
        routeThreadKey={routeThreadKey}
        timelineEntries={rows}
      />
    );
    let tree!: ReactTestRenderer;
    const animated = () =>
      tree.root.findByProps({ "data-testid": "transcript-list" }).props["data-follow-animated"];
    try {
      act(() => {
        tree = create(view("env-1:thread-a"));
      });
      expect(animated()).toBe(true);
      act(() => tree.update(view("env-1:thread-b")));
      expect(animated()).toBe(false);
      step();
      step();
      expect(animated()).toBe(true);
    } finally {
      act(() => tree?.unmount());
    }
  });

  it.each([
    ["completed", false],
    ["completed", true],
    ["inProgress", false],
    ["inProgress", true],
  ] as const)(
    "after closing %s tool output, restores the composer only at the end (at end: %s)",
    async (status, atEnd) => {
      const step = manualFrames();
      const props = baseProps();
      let listAtEnd = atEnd;
      props.listRef.current = {
        getScrollableNode: () => null,
        getState: () => ({ isAtEnd: listAtEnd }),
      } as unknown as LegendListRef;
      let composer: ReturnType<typeof usePromptFocusState> | undefined;
      let resting = false;

      /** Mirrors ThreadView: the composer state and the transcript side by side. */
      function Probe() {
        const focus = usePromptFocusState();
        useLayoutEffect(() => {
          composer = focus;
          resting = shouldUseRestingPromptLayout({
            isExistingThread: true,
            timelineOverflows: true,
            isScrollCollapsed: focus.isComposerScrollCollapsed,
            hasExpandedChrome: false,
            hasMultilinePrompt: false,
          });
        });
        return (
          <ThreadTranscript
            {...props}
            isWorking={status === "inProgress"}
            onToolOutputCollapsedAtEnd={focus.restoreAtTimelineEnd}
            timelineEntries={[
              work("tool", {
                tone: "tool",
                label: "Run command",
                detail: "output",
                toolLifecycleStatus: status,
              }),
            ]}
          />
        );
      }

      let tree: ReactTestRenderer | undefined;
      // The same button collapses again, so it is found once while still closed.
      let toggle: ReturnType<ReactTestRenderer["root"]["findByProps"]> | undefined;
      const toggleOutput = () => {
        toggle ??= tree!.root.findByProps({ "aria-expanded": false });
        return act(() => toggle!.props.onClick());
      };
      try {
        await act(() => void (tree = create(<Probe />)));
        // The reader scrolled up, which rests the composer.
        await act(() => composer!.setIsComposerScrollCollapsed(true));

        await toggleOutput();
        for (const _ of [1, 2]) await step();
        expect(resting).toBe(true);

        listAtEnd = false;
        await toggleOutput();
        await step();
        listAtEnd = atEnd;
        await step();
        expect(resting).toBe(!atEnd);
      } finally {
        await act(() => tree?.unmount());
      }
    },
  );
});
