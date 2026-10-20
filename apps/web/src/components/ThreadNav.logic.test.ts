import { describe, expect, it } from "vite-plus/test";

import {
  resolveSidebarShortcut,
  baselineVisitFor,
  createRepeatClickDetector,
  filterFolder,
  filterProjectsForCodeSurface,
  isTextTruncated,
  orderFolderThreads,
  resolveRenameBlur,
  resolveThreadDot,
  rollupThreadDots,
  type ThreadDotInput,
} from "./ThreadNav.logic";

const COMPLETED_AT = "2026-09-24T10:00:00.000Z";

function thread(overrides: Partial<Record<keyof ThreadDotInput, unknown>> = {}): ThreadDotInput {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    session: { status: "ready" },
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-09-24T09:59:00.000Z",
      startedAt: "2026-09-24T09:59:01.000Z",
      completedAt: COMPLETED_AT,
      assistantMessageId: null,
    },
    backgroundLiveness: null,
    ...overrides,
  } as unknown as ThreadDotInput;
}

describe("resolveThreadDot", () => {
  it("marks a completed reply the user has not opened as unread, and goes quiet once read", () => {
    expect(resolveThreadDot(thread(), "2026-09-24T09:00:00.000Z").tone).toBe("unread");
    expect(resolveThreadDot(thread(), "2026-09-24T10:05:00.000Z").tone).toBe("idle");
  });

  it("puts attention states ahead of work, and work ahead of unread", () => {
    expect(resolveThreadDot(thread({ hasPendingApprovals: true }), undefined).tone).toBe(
      "approval",
    );
    expect(resolveThreadDot(thread({ hasPendingUserInput: true }), undefined).tone).toBe("input");
    const running = resolveThreadDot(thread({ session: { status: "running" } }), undefined);
    expect(running.tone).toBe("working");
    expect(running.pulse).toBe(true);
  });

  it("shows failures in red until the next turn, seen or not", () => {
    expect(resolveThreadDot(thread({ session: { status: "error" } }), undefined).tone).toBe(
      "failed",
    );
    const erroredTurn = thread({
      latestTurn: { ...thread().latestTurn!, state: "error" },
    });
    expect(resolveThreadDot(erroredTurn, "2026-09-24T09:00:00.000Z").tone).toBe("failed");
    expect(resolveThreadDot(erroredTurn, "2026-09-24T11:00:00.000Z").tone).toBe("failed");
  });

  it("is red for a turn a daemon restart killed, but not for the user's own Stop", () => {
    const killed = thread({
      session: { status: "interrupted", lastError: "the daemon restarted" },
    });
    expect(resolveThreadDot(killed, "2026-09-24T11:00:00.000Z").tone).toBe("failed");
    const stopped = thread({ session: { status: "interrupted", lastError: null } });
    expect(resolveThreadDot(stopped, "2026-09-24T11:00:00.000Z").tone).toBe("idle");
  });

  it("is red on every thread while the daemon is offline", () => {
    const dot = resolveThreadDot(thread({ hasPendingApprovals: true }), undefined, true);
    expect(dot.tone).toBe("offline");
    expect(dot.dotClass).toContain("bg-destructive");
  });

  it("uses one colour per meaning: yellow needs you, green unread, grey seen, red wrong", () => {
    const seen = "2026-09-24T11:00:00.000Z";
    const yellow = [
      resolveThreadDot(thread({ hasPendingApprovals: true }), seen),
      resolveThreadDot(thread({ hasPendingUserInput: true }), seen),
      resolveThreadDot(thread({ interactionMode: "plan", hasActionableProposedPlan: true }), seen),
    ];
    for (const d of yellow) expect(d.dotClass).toContain("amber");
    expect(resolveThreadDot(thread(), "2026-09-24T09:00:00.000Z").dotClass).toContain("emerald");
    expect(resolveThreadDot(thread(), seen).dotClass).toContain("muted-foreground");
    expect(resolveThreadDot(thread({ session: { status: "error" } }), seen).dotClass).toContain(
      "bg-destructive",
    );
  });

  it("flags a settled plan-mode turn with an actionable plan", () => {
    const dot = resolveThreadDot(
      thread({ interactionMode: "plan", hasActionableProposedPlan: true }),
      "2026-09-24T11:00:00.000Z",
    );
    expect(dot.tone).toBe("plan");
    expect(dot.label).toBe("Plan ready for your review");
  });

  it("is idle for a brand-new thread with no turns", () => {
    expect(resolveThreadDot(thread({ latestTurn: null, session: null }), undefined).tone).toBe(
      "idle",
    );
  });
});

describe("baselineVisitFor", () => {
  it("seeds a thread with no record as seen at its last finish (or creation), and leaves recorded ones alone", () => {
    const t = { ...thread(), createdAt: "2026-09-24T08:00:00.000Z" };
    expect(baselineVisitFor(t, undefined)).toBe(COMPLETED_AT);
    expect(baselineVisitFor({ ...t, latestTurn: null }, undefined)).toBe(
      "2026-09-24T08:00:00.000Z",
    );
    expect(baselineVisitFor(t, "2026-09-24T09:00:00.000Z")).toBeNull();
    // After seeding, the next finished turn is green.
    expect(
      resolveThreadDot(thread(), baselineVisitFor({ ...t, latestTurn: null }, undefined)!).tone,
    ).toBe("unread");
  });
});

describe("rollupThreadDots", () => {
  it("returns the most urgent dot and ignores idle threads", () => {
    const idle = resolveThreadDot(thread(), "2026-09-24T11:00:00.000Z");
    const unread = resolveThreadDot(thread(), "2026-09-24T09:00:00.000Z");
    const working = resolveThreadDot(thread({ session: { status: "running" } }), undefined);
    expect(rollupThreadDots([idle, idle])).toBeNull();
    expect(rollupThreadDots([idle, unread, working])?.tone).toBe("working");
    expect(rollupThreadDots([unread, idle])?.tone).toBe("unread");
  });
});

describe("orderFolderThreads", () => {
  it("puts pinned threads first, then the most recently active", () => {
    const base = { createdAt: "2026-09-01T00:00:00.000Z" };
    const ordered = orderFolderThreads([
      { ...base, id: "old", updatedAt: "2026-09-02T00:00:00.000Z" },
      { ...base, id: "new", updatedAt: "2026-09-20T00:00:00.000Z" },
      {
        ...base,
        id: "pinned",
        updatedAt: "2026-09-01T00:00:00.000Z",
        pinnedAt: "2026-09-10T00:00:00.000Z",
        pinOrderKey: "a0",
      },
    ]);
    expect(ordered.map((t) => t.id)).toEqual(["pinned", "new", "old"]);
  });
});

describe("filterFolder", () => {
  const threads = [{ title: "Fix login redirect" }, { title: "Refactor sidebar" }];

  it("is a no-op for an empty query", () => {
    expect(filterFolder({ folderTitle: "kora", threads, query: "  " })).toEqual({
      threads,
      visible: true,
    });
  });

  it("keeps only matching chats, case-insensitively", () => {
    const result = filterFolder({ folderTitle: "kora", threads, query: "LOGIN" });
    expect(result.threads.map((t) => t.title)).toEqual(["Fix login redirect"]);
    expect(result.visible).toBe(true);
  });

  it("keeps every chat when the folder name matches", () => {
    expect(filterFolder({ folderTitle: "kora-web", threads, query: "web" }).threads).toHaveLength(
      2,
    );
  });

  it("hides a folder with no matches", () => {
    expect(filterFolder({ folderTitle: "kora", threads, query: "zzz" }).visible).toBe(false);
  });
});

describe("createRepeatClickDetector", () => {
  it("pairs two clicks on the same row inside the window, then starts over", () => {
    const detector = createRepeatClickDetector(500);
    expect(detector.register("a", 1000)).toBe(false);
    expect(detector.register("a", 1300)).toBe(true);
    // A third click is a new first click, not another double.
    expect(detector.register("a", 1400)).toBe(false);
  });

  it("does not pair clicks on different rows or too far apart", () => {
    const detector = createRepeatClickDetector(500);
    expect(detector.register("a", 0)).toBe(false);
    expect(detector.register("b", 100)).toBe(false);
    expect(detector.register("b", 700)).toBe(false);
    expect(detector.register("b", 900)).toBe(true);
  });

  it("forgets the pending click on reset", () => {
    const detector = createRepeatClickDetector(500);
    detector.register("a", 0);
    detector.reset();
    expect(detector.register("a", 100)).toBe(false);
  });
});

describe("isTextTruncated", () => {
  it("is true only when the text overflows its box", () => {
    expect(isTextTruncated({ scrollWidth: 300, clientWidth: 120 })).toBe(true);
    expect(isTextTruncated({ scrollWidth: 120, clientWidth: 120 })).toBe(false);
    expect(isTextTruncated(null)).toBe(false);
  });
});

describe("resolveRenameBlur", () => {
  it("commits only when the user left the field", () => {
    expect(resolveRenameBlur({ userLeft: true, windowFocused: true })).toBe("commit");
    expect(resolveRenameBlur({ userLeft: false, windowFocused: true })).toBe("refocus");
    expect(resolveRenameBlur({ userLeft: false, windowFocused: false })).toBe("keep");
  });
});

describe("filterProjectsForCodeSurface", () => {
  it("keeps projects with surface absent or 'code', drops 'blobs'", () => {
    const projects = [
      { id: "a", surface: undefined },
      { id: "b", surface: "code" as const },
      { id: "d", surface: "blobs" as const },
    ];
    expect(filterProjectsForCodeSurface(projects).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("resolveSidebarShortcut", () => {
  const ev = (key: string, over: Record<string, boolean> = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });
  it("maps ⌘N and ⌘K on a Mac, Ctrl elsewhere", () => {
    expect(resolveSidebarShortcut(ev("n", { metaKey: true }), true)).toBe("new-thread");
    expect(resolveSidebarShortcut(ev("K", { metaKey: true }), true)).toBe("search");
    expect(resolveSidebarShortcut(ev("n", { ctrlKey: true }), false)).toBe("new-thread");
    expect(resolveSidebarShortcut(ev("k", { ctrlKey: true }), false)).toBe("search");
  });
  it("ignores the wrong modifier, extra modifiers, other keys and composition", () => {
    expect(resolveSidebarShortcut(ev("k", { ctrlKey: true }), true)).toBeNull();
    expect(resolveSidebarShortcut(ev("n", { metaKey: true }), false)).toBeNull();
    expect(resolveSidebarShortcut(ev("n", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(resolveSidebarShortcut(ev("n", { metaKey: true, altKey: true }), true)).toBeNull();
    expect(resolveSidebarShortcut(ev("3", { metaKey: true }), true)).toBeNull();
    expect(
      resolveSidebarShortcut({ ...ev("n", { metaKey: true }), isComposing: true }, true),
    ).toBeNull();
  });
});
