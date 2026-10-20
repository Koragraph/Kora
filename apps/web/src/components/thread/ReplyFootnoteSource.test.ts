import { ItemId } from "@kora/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  observeReplyFootnoteCommentSource,
  observeReplyFootnoteSource,
  type ReplyFootnoteTarget,
} from "./ReplyFootnoteSource";

const hoisted = vi.hoisted(() => ({ resolve: vi.fn(), toast: vi.fn() }));
vi.mock("~/util/assistantTextSelection", () => ({ resolveReplyFootnoteRange: hoisted.resolve }));
vi.mock("../ui/toast", () => ({ toastManager: { add: hoisted.toast } }));

// ---- a tiny fake DOM ----------------------------------------------------------------------------

const box = (top: number, height: number) =>
  ({ top, height, bottom: top + height, width: 200 }) as DOMRect;

class FakeNode {
  parent: FakeNode | null = null;
  isConnected = true;
  constructor(parent: FakeNode | null = null) {
    this.parent = parent;
  }
  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  }
}

class FakeSelection {
  ranges: FakeRange[] = [];
  get rangeCount() {
    return this.ranges.length;
  }
  getRangeAt(n: number) {
    return this.ranges[n]!;
  }
  addRange(range: FakeRange) {
    this.ranges.push(range);
  }
  removeRange(range: FakeRange) {
    this.ranges = this.ranges.filter((r) => r !== range);
  }
  removeAllRanges() {
    this.ranges = [];
  }
}

class FakeAnimation {
  id = "";
  currentTime: number | null = null;
  cancel = vi.fn();
  done!: () => void;
  finished = new Promise<void>((resolve) => (this.done = resolve));
}

/** Plays the part of HTMLElement, so `instanceof HTMLElement` holds for the fakes. */
class FakeElement extends FakeNode {
  dataset: Record<string, string> = {};
  scrollTop = 0;
  scrollHeight = 5_000;
  clientHeight = 600;
  rect = box(0, 600);
  selection: FakeSelection | null = null;
  animations: FakeAnimation[] = [];
  ownerDocument = { getSelection: () => this.selection };
  getBoundingClientRect() {
    return this.rect;
  }
  animate() {
    const made = new FakeAnimation();
    this.animations.push(made);
    return made;
  }
}

class FakeRange {
  startOffset = 0;
  endOffset = 4;
  collapsed = false;
  endContainer: FakeNode;
  constructor(
    public startContainer: FakeNode,
    public rect = box(100, 20),
  ) {
    this.endContainer = startContainer;
  }
  getBoundingClientRect() {
    return this.collapsed ? box(0, 0) : this.rect;
  }
  setStart(node: FakeNode, offset: number) {
    this.startContainer = node;
    this.startOffset = offset;
    this.collapsed = false;
  }
  setEnd(node: FakeNode, offset: number) {
    this.endContainer = node;
    this.endOffset = offset;
    this.collapsed = false;
  }
}

const observers: Array<{
  callback: (records: unknown[]) => void;
  disconnect: () => void;
  live: boolean;
}> = [];
let frames: Array<() => void> = [];
let clock = 0;

/** Runs queued animation frames until none are left. */
const flushFrames = () => {
  for (let guard = 0; guard < 20 && frames.length > 0; guard += 1) {
    const due = frames;
    frames = [];
    for (const run of due) run();
  }
};
const settle = async () => {
  for (let n = 0; n < 5; n += 1) await Promise.resolve();
  flushFrames();
};

/** Delivers a mutation batch to every live observer. */
const mutate = (records: unknown[]) => {
  for (const observer of observers) if (observer.live) observer.callback(records);
};

const installHighlights = () => {
  class Highlight extends Set<unknown> {
    constructor(...ranges: unknown[]) {
      super(ranges);
    }
  }
  const registry = new Map<string, Set<unknown>>();
  vi.stubGlobal("Highlight", Highlight);
  vi.stubGlobal("CSS", { highlights: registry });
  return registry;
};

/** Size changes are driven by hand in these tests. */
class SilentResizeObserver {
  disconnect = () => undefined;
  observe = () => undefined;
}

beforeEach(() => {
  observers.length = 0;
  frames = [];
  clock = 0;
  hoisted.resolve.mockReset();
  hoisted.toast.mockReset();
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("performance", { now: () => clock });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => frames.push(run));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "MutationObserver",
    class {
      entry;
      constructor(callback: (records: unknown[]) => void) {
        this.entry = { callback, live: false, disconnect: () => (this.entry.live = false) };
        observers.push(this.entry);
      }
      observe() {
        this.entry.live = true;
      }
      disconnect() {
        this.entry.disconnect();
      }
    },
  );
  vi.stubGlobal("ResizeObserver", SilentResizeObserver);
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
});

afterEach(() => vi.unstubAllGlobals());

const citation = {
  messageId: ItemId.make("msg-1"),
  quote: "quote",
} as unknown as ReplyFootnoteTarget["citation"];

// ---- comment editor highlight -------------------------------------------------------------------

describe("observeReplyFootnoteCommentSource", () => {
  const anchorIn = () => {
    const viewport = new FakeElement();
    const source = new FakeElement(viewport);
    const text = new FakeNode(source);
    const range = new FakeRange(text);
    return { viewport, source, text, range };
  };
  const observe = (anchor: ReturnType<typeof anchorIn>, onUnavailable = vi.fn()) =>
    observeReplyFootnoteCommentSource({
      anchor: anchor as never,
      citation,
      onUnavailable,
    });

  it("reports a detached source straight away and registers nothing", () => {
    const registry = installHighlights();
    const anchor = anchorIn();
    anchor.source.isConnected = false;
    const onUnavailable = vi.fn();

    observe(anchor, onUnavailable)();

    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
    expect(observers).toHaveLength(0);
  });

  it("shares one highlight between editors and removes it with the last one", () => {
    const registry = installHighlights();
    const first = anchorIn();
    const second = anchorIn();
    const closeFirst = observe(first);
    const closeSecond = observe(second);

    const shared = registry.get("kora-assistant-citation-comment")!;
    expect([...shared]).toEqual([first.range, second.range]);

    closeFirst();
    closeFirst();
    expect([...shared]).toEqual([second.range]);
    closeSecond();
    expect(registry.has("kora-assistant-citation-comment")).toBe(false);
  });

  it("leaves a newer highlight alone when an older editor closes", () => {
    const registry = installHighlights();
    const close = observe(anchorIn());
    const replacement = new Set<unknown>(["someone else"]);
    registry.set("kora-assistant-citation-comment", replacement);

    close();

    expect(registry.get("kora-assistant-citation-comment")).toBe(replacement);
  });

  it("works without the highlight API", () => {
    const anchor = anchorIn();
    const onUnavailable = vi.fn();
    const close = observe(anchor, onUnavailable);
    mutate([{ target: new FakeNode() }]);
    close();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("closes once when the source leaves the viewport", () => {
    const registry = installHighlights();
    const anchor = anchorIn();
    const onUnavailable = vi.fn();
    observe(anchor, onUnavailable);

    anchor.source.parent = null;
    mutate([{ target: anchor.viewport }]);
    mutate([{ target: anchor.viewport }]);

    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
    expect(observers.every((observer) => !observer.live)).toBe(true);
  });

  it("repairs the same Range in place after its text changed", () => {
    installHighlights();
    const anchor = anchorIn();
    observe(anchor);
    const moved = new FakeNode(anchor.source);
    hoisted.resolve.mockReturnValue({
      startContainer: moved,
      startOffset: 2,
      endContainer: moved,
      endOffset: 9,
    });

    mutate([{ target: anchor.text }]);

    expect(anchor.range).toMatchObject({ startContainer: moved, startOffset: 2, endOffset: 9 });
  });

  it("repairs a collapsed range even when the mutation was elsewhere", () => {
    const anchor = anchorIn();
    observe(anchor);
    anchor.range.collapsed = true;
    hoisted.resolve.mockReturnValue({
      startContainer: anchor.text,
      startOffset: 0,
      endContainer: anchor.text,
      endOffset: 5,
    });

    mutate([{ target: new FakeNode() }]);

    expect(hoisted.resolve).toHaveBeenCalledOnce();
    expect(anchor.range.collapsed).toBe(false);
  });

  it("gives up when the quote can no longer be found", () => {
    const registry = installHighlights();
    const anchor = anchorIn();
    const onUnavailable = vi.fn();
    observe(anchor, onUnavailable);
    hoisted.resolve.mockReturnValue(null);

    mutate([{ target: anchor.text }]);

    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it("ignores unrelated mutations while the range is intact", () => {
    const anchor = anchorIn();
    observe(anchor);
    mutate([{ target: new FakeNode() }]);
    expect(hoisted.resolve).not.toHaveBeenCalled();
  });
});

// ---- navigation ---------------------------------------------------------------------------------

/** A list whose cited row sits `rowTop` px below the viewport top, with the quote 10px into it. */
const navigationWorld = (options: { rowTop?: number; scroll?: number } = {}) => {
  const scrollNode = new FakeElement();
  const root = new FakeElement(scrollNode);
  const text = new FakeNode(root);
  const quote = new FakeRange(text, box((options.rowTop ?? 100) + 10, 20));
  const state = {
    scroll: options.scroll ?? 1_000,
    indexByKey: (key: string) => (key === "row-1" ? 3 : undefined),
    sizeAtIndex: () => 80,
    listenToPosition: () => () => {},
    listen: () => () => {},
  };
  const scrolls: Array<{ offset: number; animated: boolean }> = [];
  let answerScroll: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  const list = {
    getScrollableNode: () => scrollNode,
    getState: () => state,
    scrollToOffset: (request: { offset: number; animated: boolean }) => {
      scrolls.push(request);
      return new Promise<void>((resolve, reject) => (answerScroll = { resolve, reject }));
    },
  };
  const activationRef = {
    current: {
      dismissed: false,
      scrolled: false,
    } as ReplyFootnoteTarget["activationRef"]["current"],
  };
  const onComplete = vi.fn();
  const request = { citation, key: "c-1", activationRef, onComplete } as ReplyFootnoteTarget;
  const start = () =>
    observeReplyFootnoteSource({
      root: root as unknown as HTMLElement,
      itemKey: "row-1",
      request,
      list: list as unknown as LegendListRef,
    });
  hoisted.resolve.mockReturnValue(quote);
  return {
    scrollNode,
    root,
    quote,
    state,
    scrolls,
    activation: activationRef.current,
    onComplete,
    start,
    finishScroll: () => answerScroll?.resolve(),
    failScroll: () => answerScroll?.reject(new Error("list unmounted")),
  };
};

describe("observeReplyFootnoteSource", () => {
  it("does nothing for a dismissed activation or a list without a scroll element", () => {
    const world = navigationWorld();
    world.activation.dismissed = true;
    expect(world.start()).toBeUndefined();

    const other = navigationWorld();
    const list = { getScrollableNode: () => ({}) } as unknown as LegendListRef;
    expect(
      observeReplyFootnoteSource({
        root: other.root as unknown as HTMLElement,
        itemKey: "row-1",
        request: {
          citation,
          key: "k",
          activationRef: { current: { dismissed: false, scrolled: false } },
          onComplete: vi.fn(),
        } as never,
        list,
      }),
    ).toBeUndefined();
  });

  it("highlights and pulses a quote that is already in view", () => {
    const registry = installHighlights();
    // 110px down the viewport with a 120px margin: the wanted offset is clamped to the
    // current scroll, so no scrolling is needed.
    const world = navigationWorld({ rowTop: 100, scroll: 0 });
    world.start();
    flushFrames();

    expect(world.scrolls).toEqual([]);
    expect(world.onComplete).toHaveBeenCalledOnce();
    expect(world.activation.scrolled).toBe(true);
    expect([...registry.get("kora-assistant-citation")!]).toEqual([world.quote]);
    expect(world.root.dataset.citationHighlighted).toBe("true");
    expect(world.root.animations.map((animation) => animation.id)).toEqual([
      "kora-assistant-citation-pulse",
    ]);
  });

  it("scrolls the quote to a margin below the top, then completes", async () => {
    installHighlights();
    const world = navigationWorld({ rowTop: 500, scroll: 1_000 });
    world.start();
    flushFrames();

    // 1000 + (510 - 0) - 120 margin
    expect(world.scrolls).toEqual([{ offset: 1_390, animated: true }]);
    expect(world.onComplete).not.toHaveBeenCalled();

    world.state.scroll = 1_390;
    world.quote.rect = box(120, 20);
    world.finishScroll();
    await settle();

    expect(world.onComplete).toHaveBeenCalledOnce();
    expect(world.scrolls).toHaveLength(1);
  });

  it("jumps without animation under reduced motion", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const world = navigationWorld({ rowTop: 500 });
    world.start();
    flushFrames();
    expect(world.scrolls[0]?.animated).toBe(false);
  });

  it("warns and stops when the scroll fails", async () => {
    installHighlights();
    const world = navigationWorld({ rowTop: 500 });
    world.start();
    flushFrames();
    world.failScroll();
    await settle();

    expect(world.onComplete).toHaveBeenCalledOnce();
    expect(world.activation.dismissed).toBe(true);
    expect(hoisted.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "warning", title: "Could not open the cited response" }),
    );
  });

  it("shows the row and says so when the quote changed", () => {
    const registry = installHighlights();
    const world = navigationWorld({ scroll: 0 });
    hoisted.resolve.mockReturnValue(null);
    world.root.rect = box(50, 80);
    world.start();
    flushFrames();

    expect(world.onComplete).toHaveBeenCalledOnce();
    expect(hoisted.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "The quoted text has changed" }),
    );
    expect(world.activation.dismissed).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("waits until the list has measured the row", () => {
    const world = navigationWorld({ scroll: 0 });
    world.state.sizeAtIndex = () => 0;
    world.start();
    flushFrames();
    expect(world.onComplete).not.toHaveBeenCalled();

    world.state.sizeAtIndex = () => 80;
    mutate([{ target: world.root, addedNodes: [], removedNodes: [] }]);
    flushFrames();
    expect(world.onComplete).toHaveBeenCalledOnce();
  });

  it("ends when the pulse finishes and removes only its own highlight", async () => {
    const registry = installHighlights();
    const world = navigationWorld({ scroll: 0 });
    world.start();
    flushFrames();

    world.root.animations[0]!.done();
    await settle();

    expect(world.activation.dismissed).toBe(true);
    expect(registry.has("kora-assistant-citation")).toBe(false);
    expect(world.root.dataset.citationHighlighted).toBeUndefined();

    const again = navigationWorld({ scroll: 0 });
    const stop = again.start()!;
    flushFrames();
    const someoneElse = new Set<unknown>();
    registry.set("kora-assistant-citation", someoneElse);
    stop();
    expect(registry.get("kora-assistant-citation")).toBe(someoneElse);
  });

  it("does not revive a pulse whose time is already up", () => {
    installHighlights();
    const world = navigationWorld({ scroll: 0 });
    world.activation.pulse = { startedAt: 0, reducedMotion: false };
    world.activation.scrolled = true;
    clock = 10_000;
    world.start();
    flushFrames();

    expect(world.activation.dismissed).toBe(true);
    expect(world.root.animations).toEqual([]);
  });

  it("resumes a pulse at its original start time on remount", () => {
    installHighlights();
    const world = navigationWorld({ scroll: 0 });
    world.activation.pulse = { startedAt: 100, reducedMotion: false };
    world.activation.scrolled = true;
    clock = 400;
    world.start();
    flushFrames();

    expect(world.root.animations[0]?.currentTime).toBe(300);
  });

  describe("without the highlight API", () => {
    it("selects the quote and clears its own selection afterwards", async () => {
      const world = navigationWorld({ scroll: 0 });
      world.root.selection = new FakeSelection();
      world.start();
      flushFrames();
      expect(world.root.selection.ranges).toEqual([world.quote]);

      world.root.animations[0]!.done();
      await settle();
      expect(world.root.selection.ranges).toEqual([]);
    });

    it("keeps a selection the user made in the meantime", async () => {
      const world = navigationWorld({ scroll: 0 });
      const selection = new FakeSelection();
      world.root.selection = selection;
      const stop = world.start()!;
      flushFrames();

      const mine = new FakeRange(new FakeNode());
      selection.removeAllRanges();
      selection.addRange(mine);
      mutate([{ target: world.root, addedNodes: [], removedNodes: [] }]);
      flushFrames();
      stop();

      expect(selection.ranges).toEqual([mine]);
      expect(world.activation.dismissed).toBe(true);
    });
  });

  it("lets a user gesture cancel the pending scroll, reading the offset when it runs", () => {
    const world = navigationWorld({ rowTop: 500 });
    world.start();
    flushFrames();
    expect(world.activation.cancelScroll).toBeTypeOf("function");

    world.activation.cancelScroll!();
    world.scrollNode.scrollTop = 777;

    const last = world.scrolls.at(-1)!;
    expect(last.animated).toBe(false);
    expect(last.offset).toBe(777);
  });

  it("stops looking once the row leaves the list", () => {
    installHighlights();
    const world = navigationWorld({ rowTop: 500 });
    const stop = world.start()!;
    world.root.isConnected = false;
    flushFrames();

    expect(world.scrolls).toEqual([]);
    expect(world.activation.cancelScroll).toBeUndefined();
    stop();
  });
});
