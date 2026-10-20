import { act, create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BlobCardRef } from "../../../thread/timeline";
import { resetHeldMemoriesForTests, useHeldMemories } from "../memory/heldStore";

const toastAdd = vi.fn();
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => toastAdd(...args), close: vi.fn() },
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => null }));

import { MemoryReceiptCard } from "./MemoryReceiptCard";
import { parseBlobCard } from "./parseCard";
import { RateLimitCard } from "./RateLimitCard";
import { SelfChangeCard } from "./SelfChangeCard";
import type { BlobCardActions } from "./cardActions";

const ref = (payload: Record<string, unknown>): BlobCardRef => ({
  cardId: "c",
  version: 1,
  payload,
});

const receipt = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  kind: "added",
  scope: "you",
  text: "you live in Dallas",
  previousText: null,
  factId: "f1",
  undone: false,
  reason: null,
  ...over,
});

const memoryReceipt = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  kind: "added" as const,
  scope: "you" as const,
  factId: "f1",
  text: "you live in Dallas",
  previousText: null,
  undone: false,
  reason: null,
  ...over,
});

function actions(over: Partial<BlobCardActions> = {}): BlobCardActions {
  return {
    undoMemory: vi.fn(async () => ({ ok: true as const, value: memoryReceipt({ undone: true }) })),
    confirmMemory: vi.fn(async () => ({ ok: true as const, value: memoryReceipt() })),
    undoSelfChange: vi.fn(async () => ({ ok: true as const, value: { undone: true } })),
    continueOnFree: vi.fn(async () => ({ ok: true as const, value: { threadId: "t2" } })),
    ...over,
  };
}

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const buttons = (root: ReactTestInstance) => root.findAll((n) => n.type === "button");
const buttonByLabel = (root: ReactTestInstance, label: string) =>
  buttons(root).find((b) => text(b).trim() === label);

beforeEach(() => {
  toastAdd.mockClear();
  resetHeldMemoriesForTests();
});

describe("parseBlobCard: routine and app cards", () => {
  it("a routine report keeps its run, status and the way to Open run; a malformed one degrades", () => {
    const parsed = parseBlobCard(
      ref({
        cardKind: "routine-report",
        cardId: "rr",
        runId: "run_1",
        routineId: "rt",
        blobId: "b",
        title: "Morning brief",
        status: "completed",
        ranAt: 5,
        text: "Three things.",
        outputs: ["/x.md", 3],
        executionThreadId: "t9",
        resultsThreadId: "t1",
      }),
    );
    expect(parsed).toMatchObject({
      kind: "routine-report",
      card: { runId: "run_1", executionThreadId: "t9", outputs: ["/x.md"], status: "completed" },
    });
    expect(
      parseBlobCard(ref({ cardKind: "routine-report", runId: "r", status: "weird" })).kind,
    ).toBe("unknown");
    expect(parseBlobCard(ref({ cardKind: "routine-report", status: "completed" })).kind).toBe(
      "unknown",
    );
  });
  it("a routine confirm card carries its token and answered state", () => {
    expect(
      parseBlobCard(
        ref({
          cardKind: "routine-confirm",
          cardId: "c",
          token: "rc_1",
          blobId: "b",
          summary: "Schedule it",
          details: ["a", 2],
          state: "confirmed",
          result: "Done",
        }),
      ),
    ).toMatchObject({
      kind: "routine-confirm",
      card: { token: "rc_1", state: "confirmed", details: ["a"], result: "Done" },
    });
    expect(parseBlobCard(ref({ cardKind: "routine-confirm", summary: "x" })).kind).toBe("unknown"); // no token: nothing to answer
  });
  it("an app-connect card names the app and why", () => {
    expect(
      parseBlobCard(
        ref({ cardKind: "app-connect", toolkit: "slack", reason: "not_granted", blobId: "b" }),
      ),
    ).toEqual({ kind: "app-connect", toolkit: "slack", reason: "not_granted", blobId: "b" });
    expect(parseBlobCard(ref({ cardKind: "app-connect", toolkit: "" })).kind).toBe("unknown");
  });
});

describe("parseBlobCard", () => {
  it("reads each card kind and degrades to unknown", () => {
    expect(parseBlobCard(ref({ cardKind: "memory", receipts: [receipt()] })).kind).toBe("memory");
    expect(parseBlobCard(ref({ cardKind: "memory", receipts: [] })).kind).toBe("unknown");
    expect(
      parseBlobCard(
        ref({ cardKind: "self-change", what: "Updated my soul", undoToken: "u1", undone: false }),
      ).kind,
    ).toBe("self-change");
    expect(
      parseBlobCard(
        ref({ cardKind: "rate-limit", engine: "claude", resetsAt: null, threadId: "t" }),
      ).kind,
    ).toBe("rate-limit");
    expect(
      parseBlobCard(
        ref({
          cardKind: "job",
          title: "Trip",
          status: "running",
          steps: [{ id: "s", blobName: "Popo", title: "Research", status: "running" }],
        }),
      ).kind,
    ).toBe("job");
    expect(
      parseBlobCard(
        ref({ cardKind: "proposal", draft: { name: "Tiki", job: "Shopify" }, state: "open" }),
      ).kind,
    ).toBe("proposal");
    expect(parseBlobCard(ref({ cardKind: "from-the-future" }))).toEqual({
      kind: "unknown",
      cardKind: "from-the-future",
    });
    expect(parseBlobCard(ref({}))).toEqual({ kind: "unknown", cardKind: null });
  });
});

describe("MemoryReceiptCard", () => {
  it("shows the remembered fact with Undo, and Undo calls the receipt undo then shows Undone", async () => {
    const a = actions();
    const parsed = parseBlobCard(ref({ cardKind: "memory", receipts: [receipt()] }));
    if (parsed.kind !== "memory") throw new Error("expected memory");
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <MemoryReceiptCard receipts={parsed.receipts} actions={a} blobId="blob_popo" />,
      );
    });
    expect(text(renderer.root)).toContain("Remembered: you live in Dallas");
    const undo = buttonByLabel(renderer.root, "Undo");
    expect(undo).toBeDefined();
    await act(async () => {
      undo!.props.onClick();
    });
    expect(a.undoMemory).toHaveBeenCalledWith("r1");
    expect(text(renderer.root)).toContain("Undone: you live in Dallas");
    expect(buttonByLabel(renderer.root, "Undo")).toBeUndefined();
  });

  it("renders an already-undone receipt as Undone with no button", async () => {
    const parsed = parseBlobCard(
      ref({ cardKind: "memory", receipts: [receipt({ undone: true })] }),
    );
    if (parsed.kind !== "memory") throw new Error("expected memory");
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<MemoryReceiptCard receipts={parsed.receipts} actions={actions()} />);
    });
    expect(text(renderer.root)).toContain("Undone");
    expect(buttons(renderer.root)).toHaveLength(0);
  });

  it("asks before saving a held memory: Approve and Not this", async () => {
    const a = actions();
    const parsed = parseBlobCard(
      ref({
        cardKind: "memory",
        receipts: [receipt({ kind: "held", reason: "Mentions your health" })],
      }),
    );
    if (parsed.kind !== "memory") throw new Error("expected memory");
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <MemoryReceiptCard receipts={parsed.receipts} actions={a} blobId="blob_popo" />,
      );
    });
    expect(text(renderer.root)).toContain("Save to memory");
    expect(text(renderer.root)).toContain("Mentions your health");
    await act(async () => {
      buttonByLabel(renderer.root, "Approve")!.props.onClick();
    });
    expect(a.confirmMemory).toHaveBeenCalledWith("r1", true);
    expect(text(renderer.root)).toContain("Remembered: you live in Dallas");
  });

  it("declining a held memory says it was not saved", async () => {
    const a = actions();
    const parsed = parseBlobCard(
      ref({ cardKind: "memory", receipts: [receipt({ kind: "held" })] }),
    );
    if (parsed.kind !== "memory") throw new Error("expected memory");
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<MemoryReceiptCard receipts={parsed.receipts} actions={a} />);
    });
    await act(async () => {
      buttonByLabel(renderer.root, "Not this")!.props.onClick();
    });
    expect(a.confirmMemory).toHaveBeenCalledWith("r1", false);
    expect(text(renderer.root)).toContain("Not saved");
  });

  it("toasts and keeps the Undo when the undo fails", async () => {
    const a = actions({
      undoMemory: vi.fn(async () => ({
        ok: false as const,
        message: "That change can't be undone any more.",
      })),
    });
    const parsed = parseBlobCard(ref({ cardKind: "memory", receipts: [receipt()] }));
    if (parsed.kind !== "memory") throw new Error("expected memory");
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<MemoryReceiptCard receipts={parsed.receipts} actions={a} />);
    });
    await act(async () => {
      buttonByLabel(renderer.root, "Undo")!.props.onClick();
    });
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "That change can't be undone any more." }),
    );
    expect(buttonByLabel(renderer.root, "Undo")).toBeDefined();
  });

  it("registers a held memory for the Memory tab's Pending group, and clears it once decided", async () => {
    const parsed = parseBlobCard(
      ref({ cardKind: "memory", receipts: [receipt({ kind: "held" })] }),
    );
    if (parsed.kind !== "memory") throw new Error("expected memory");
    function Probe() {
      return (
        <i>
          {useHeldMemories("blob_popo")
            .map((item) => item.text)
            .join("|")}
        </i>
      );
    }
    let probe!: ReturnType<typeof create>;
    let card!: ReturnType<typeof create>;
    await act(async () => {
      probe = create(<Probe />);
      card = create(
        <MemoryReceiptCard receipts={parsed.receipts} actions={actions()} blobId="blob_popo" />,
      );
    });
    expect(text(probe.root)).toBe("you live in Dallas");
    await act(async () => {
      buttonByLabel(card.root, "Approve")!.props.onClick();
    });
    expect(text(probe.root)).toBe("");
  });

  it("folds a long run of receipts behind 'and N more'", async () => {
    const many = Array.from({ length: 5 }, (_, i) => receipt({ id: `r${i}`, text: `fact ${i}` }));
    const parsed = parseBlobCard(ref({ cardKind: "memory", receipts: many }));
    if (parsed.kind !== "memory") throw new Error("expected memory");
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<MemoryReceiptCard receipts={parsed.receipts} actions={actions()} />);
    });
    expect(text(renderer.root)).toContain("fact 2");
    expect(text(renderer.root)).not.toContain("fact 3");
    await act(async () => {
      buttonByLabel(renderer.root, "and 2 more")!.props.onClick();
    });
    expect(text(renderer.root)).toContain("fact 4");
  });
});

describe("SelfChangeCard", () => {
  it("is one line with Details and Undo; Undo shows the Undone state", async () => {
    const a = actions();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <SelfChangeCard
          what="Updated my personality: more concise"
          undoToken="tok"
          undone={false}
          actions={a}
        />,
      );
    });
    expect(text(renderer.root)).toContain("Updated my personality: more concise");
    expect(buttonByLabel(renderer.root, "Details")).toBeDefined();
    await act(async () => {
      buttonByLabel(renderer.root, "Undo")!.props.onClick();
    });
    expect(a.undoSelfChange).toHaveBeenCalledWith("tok");
    expect(text(renderer.root)).toContain("Undone");
  });

  it("renders the Undone state from the wire", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <SelfChangeCard what="Switched model" undoToken="tok" undone actions={actions()} />,
      );
    });
    expect(text(renderer.root)).toContain("Undone");
    expect(buttons(renderer.root)).toHaveLength(0);
  });

  it("expands Details", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <SelfChangeCard what="Switched model" undoToken="tok" undone={false} actions={actions()} />,
      );
    });
    expect(text(renderer.root)).not.toContain("Applies from the next conversation");
    await act(async () => {
      buttonByLabel(renderer.root, "Details")!.props.onClick();
    });
    expect(text(renderer.root)).toContain("Applies from the next conversation");
  });
});

describe("RateLimitCard", () => {
  it("offers to continue on a free model", async () => {
    const onContinue = vi.fn(async () => ({ ok: true }));
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<RateLimitCard engine="claude" resetsAt={null} onContinue={onContinue} />);
    });
    expect(text(renderer.root)).toContain("Claude is at its limit");
    await act(async () => {
      buttonByLabel(renderer.root, "Continue on a free model")!.props.onClick();
    });
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("explains a failure instead of failing silently", async () => {
    const onContinue = vi.fn(async () => ({ ok: false, message: "No free model is set up." }));
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<RateLimitCard engine="codex" resetsAt={null} onContinue={onContinue} />);
    });
    await act(async () => {
      buttonByLabel(renderer.root, "Continue on a free model")!.props.onClick();
    });
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "No free model is set up." }),
    );
  });
});
