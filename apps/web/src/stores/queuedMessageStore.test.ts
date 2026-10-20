import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  type CompletedToolActivityLike,
  isQueuedMessageDue,
  type QueuedPromptMessage,
  useQueuedMessageStore,
  latestCompletedToolActivityId,
} from "./queuedMessageStore";

function buildDraftItem(text: string): Omit<QueuedPromptMessage, "id"> {
  return {
    prompt: text,
    createdAt: "2026-10-15T12:00:00.000Z",
    queuedAfterToolActivityId: null,
    submissionIntent: "foreground",
    attachments: [],
    previewAnnotations: [],
    reviewComments: [],
    terminalContexts: [],
  };
}

describe("isQueuedMessageDue logic", () => {
  it("permits dispatch once turn ends, blocking during connection phase", () => {
    const pendingMsg = { queuedAfterToolActivityId: "tool-prev" };

    expect(
      isQueuedMessageDue({
        message: pendingMsg,
        phase: "ready",
        latestToolActivityId: "tool-prev",
      }),
    ).toBe(true);

    expect(
      isQueuedMessageDue({
        message: pendingMsg,
        phase: "connecting",
        latestToolActivityId: "tool-next",
      }),
    ).toBe(false);
  });

  it("suppresses automated dispatch when item is flagged for manual user action", () => {
    const heldMsg = {
      queuedAfterToolActivityId: null,
      holdUntilUserAction: true,
    };

    expect(
      isQueuedMessageDue({
        message: heldMsg,
        phase: "ready",
        latestToolActivityId: "tool-any",
      }),
    ).toBe(false);
  });

  it("requires new tool completion event during active run", () => {
    const activeMsg = { queuedAfterToolActivityId: "act-10" };

    const stillWaiting = isQueuedMessageDue({
      message: activeMsg,
      phase: "running",
      latestToolActivityId: "act-10",
    });
    expect(stillWaiting).toBe(false);

    const newlyTriggered = isQueuedMessageDue({
      message: activeMsg,
      phase: "running",
      latestToolActivityId: "act-11",
    });
    expect(newlyTriggered).toBe(true);
  });
});

describe("latestCompletedToolActivityId resolver", () => {
  it("resolves the tool completion entry having greatest sequence or latest timestamp", () => {
    const records: CompletedToolActivityLike[] = [
      { id: "act-init", kind: "tool.started", sequence: 1, createdAt: "2026-01-01T00:00:01Z" },
      { id: "act-comp-1", kind: "tool.completed", sequence: 2, createdAt: "2026-01-01T00:00:02Z" },
      { id: "act-progress", kind: "tool.updated", sequence: 5, createdAt: "2026-01-01T00:00:05Z" },
    ];

    expect(latestCompletedToolActivityId(records)).toBe("act-comp-1");
    expect(latestCompletedToolActivityId([])).toBeNull();

    const sequenceTie: CompletedToolActivityLike[] = [
      { id: "tie-early", kind: "tool.completed", sequence: 7, createdAt: "2026-01-01T00:00:07Z" },
      { id: "tie-late", kind: "tool.completed", sequence: 7, createdAt: "2026-01-01T00:00:09Z" },
    ];
    expect(latestCompletedToolActivityId(sequenceTie)).toBe("tie-late");
  });
});

describe("useQueuedMessageStore state container", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, drainGeneration: 0 });
  });

  it("appends items maintaining per-thread sequence", () => {
    const store = useQueuedMessageStore.getState();
    store.enqueue("th-1", buildDraftItem("msg-1"));
    store.enqueue("th-1", buildDraftItem("msg-2"));
    store.enqueue("th-2", buildDraftItem("msg-other"));

    const state = useQueuedMessageStore.getState().queuesByThreadKey;
    expect(state["th-1"]?.map((m) => m.prompt)).toEqual(["msg-1", "msg-2"]);
    expect(state["th-2"]?.map((m) => m.prompt)).toEqual(["msg-other"]);
  });

  it("drains thread queue entirely and increments generation counter", () => {
    const store = useQueuedMessageStore.getState();
    store.enqueue("th-alpha", buildDraftItem("alpha-1"));
    store.enqueue("th-alpha", buildDraftItem("alpha-2"));
    store.enqueue("th-beta", buildDraftItem("beta-1"));

    const extracted = store.drain("th-alpha");
    expect(extracted.map((m) => m.prompt)).toEqual(["alpha-1", "alpha-2"]);
    expect(useQueuedMessageStore.getState().drainGeneration).toBe(1);

    const secondDrain = store.drain("th-alpha");
    expect(secondDrain).toEqual([]);
    expect(useQueuedMessageStore.getState().drainGeneration).toBe(1);

    expect(useQueuedMessageStore.getState().queuesByThreadKey["th-beta"]).toHaveLength(1);
  });

  it("re-inserts unhandled entry at queue head with user hold flag", () => {
    const store = useQueuedMessageStore.getState();
    const first = store.enqueue("th-x", buildDraftItem("lead"));
    store.enqueue("th-x", buildDraftItem("tail"));

    const claimed = store.take("th-x", first.id, "anchor-t")!;
    store.holdAtFront("th-x", claimed);

    const currentQueue = useQueuedMessageStore.getState().queuesByThreadKey["th-x"] ?? [];
    expect(currentQueue.map((m) => m.prompt)).toEqual(["lead", "tail"]);
    expect(currentQueue[0]?.holdUntilUserAction).toBe(true);
    expect(
      isQueuedMessageDue({
        message: currentQueue[0]!,
        phase: "ready",
        latestToolActivityId: null,
      }),
    ).toBe(false);
  });

  it("removes specified entry without modifying sibling anchors", () => {
    const store = useQueuedMessageStore.getState();
    const item1 = store.enqueue("th-k", {
      ...buildDraftItem("keep"),
      queuedAfterToolActivityId: "prev-anchor",
    });
    const item2 = store.enqueue("th-k", buildDraftItem("discard"));

    const removed = store.remove("th-k", item2.id);
    expect(removed?.prompt).toBe("discard");
    expect(store.remove("th-k", item2.id)).toBeNull();

    const remaining = useQueuedMessageStore.getState().queuesByThreadKey["th-k"];
    expect(remaining).toEqual([item1]);
  });

  it("re-anchors remaining queued entries when take is performed", () => {
    const store = useQueuedMessageStore.getState();
    const head = store.enqueue("th-flow", buildDraftItem("executing"));
    store.enqueue("th-flow", buildDraftItem("subsequent"));

    store.take("th-flow", head.id, "boundary-99");

    const [follower] = useQueuedMessageStore.getState().queuesByThreadKey["th-flow"] ?? [];
    expect(follower?.queuedAfterToolActivityId).toBe("boundary-99");
    expect(
      isQueuedMessageDue({
        message: follower!,
        phase: "running",
        latestToolActivityId: "boundary-99",
      }),
    ).toBe(false);
  });

  it("guarantees single-delivery semantics across repeated take invocations", () => {
    const store = useQueuedMessageStore.getState();
    const single = store.enqueue("th-once", buildDraftItem("unique-payload"));

    const firstFetch = store.take("th-once", single.id, null);
    expect(firstFetch?.prompt).toBe("unique-payload");

    const secondFetch = store.take("th-once", single.id, null);
    expect(secondFetch).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["th-once"]).toBeUndefined();
  });

  it("retains attachments across take and subsequent holdAtFront operations", () => {
    const store = useQueuedMessageStore.getState();
    const filePayload = {
      type: "image" as const,
      id: "img-001",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    };

    const entry = store.enqueue("th-files", {
      ...buildDraftItem("with attachment"),
      attachments: [filePayload],
    });

    const pulled = store.take("th-files", entry.id, null)!;
    expect(pulled.attachments).toEqual([filePayload]);

    store.holdAtFront("th-files", pulled);
    const restored = useQueuedMessageStore.getState().queuesByThreadKey["th-files"]?.[0];
    expect(restored?.attachments).toEqual([filePayload]);
  });
});
