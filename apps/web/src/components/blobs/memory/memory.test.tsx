import { FORGET_UNDO_MS, useBlobMemory, type BlobMemoryController } from "./useBlobMemory";
import { describeExtractor, filterFacts, sinceLabel, sortFacts } from "./memoryModel";
import type { MemoryApi } from "./memoryApi";
import { MemoryView } from "./MemoryView";

import type { ApiResult } from "../cards/blobCommand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import type { BlobFact, BlobMemoryScope } from "@kora/contracts";

vi.mock("~/components/ui/skeleton", () => ({ Skeleton: () => <i data-skeleton /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const fact = (over: Partial<BlobFact> & Pick<BlobFact, "id" | "text">): BlobFact => ({
  scope: "you",
  blobId: null,
  since: NOW - 3 * 86_400_000,
  until: null,
  confidence: 0.9,
  important: false,
  sourceThreadId: "thread-1",
  sourceMessageId: "m1",
  lastUsedAt: null,
  ...over,
});

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

function fakeApi(
  over: Partial<MemoryApi> = {},
  data?: Partial<Record<BlobMemoryScope, BlobFact[]>>,
): MemoryApi {
  const facts = {
    you: [
      fact({ id: "f1", text: "You live in Dallas" }),
      fact({ id: "f2", text: "You prefer short answers", important: true }),
    ],
    blob: [
      fact({ id: "f3", text: "Cites sources as footnotes", scope: "blob", blobId: "blob_popo" }),
    ],
    team: [] as BlobFact[],
    ...data,
  };
  return {
    list: vi.fn(async (scope: BlobMemoryScope) =>
      ok({ facts: facts[scope], core: scope === "you" ? "Name: Sam" : "", held: [] }),
    ),
    edit: vi.fn(async (factId: string, text: string) => ok({ ...fact({ id: factId, text }) })),
    forget: vi.fn(async (factId: string) => ok({ ...fact({ id: factId, text: "x", until: NOW }) })),
    setImportant: vi.fn(async (factId: string, important: boolean) => {
      const known = [...facts.you, ...facts.blob, ...facts.team].find((f) => f.id === factId)!;
      return ok({ ...known, important });
    }),
    setCore: vi.fn(async (_scope: "you" | "blob", _blobId: string | null, text: string) =>
      ok({ core: text }),
    ),
    search: vi.fn(async () => ok([])),
    confirm: vi.fn(async () =>
      ok({
        reason: null,
        undone: false,
        factId: null,
        previousText: null,
        text: "t",
        scope: "you" as const,
        kind: "added" as const,
        id: "r",
      }),
    ),
    ...over,
  };
}

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

interface Mounted {
  readonly renderer: ReturnType<typeof create>;
  readonly controller: () => BlobMemoryController;
  readonly forgetToasts: Array<{ fact: BlobFact; undo: () => void }>;
}

async function mount(
  api: MemoryApi,
  held: Parameters<typeof MemoryView>[0]["held"] = [],
): Promise<Mounted> {
  let current!: BlobMemoryController;
  const forgetToasts: Mounted["forgetToasts"] = [];
  function Harness() {
    const controller = useBlobMemory(api, "blob_popo", { includeTeam: false });
    current = controller;
    return (
      <MemoryView
        blobName="Popo"
        controller={controller}
        held={held}
        onResolveHeld={async () => null}
        extractor={{ learns: true, text: "Memory is learned with a free OpenCode model." }}
        onOpenSource={() => undefined}
        onForget={(target) => controller.forget(target, (toast) => forgetToasts.push(toast))}
        searchEpisodes={async () => []}
        now={NOW}
      />
    );
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness />);
  });
  await flush();
  return { renderer, controller: () => current, forgetToasts };
}

const byLabel = (root: ReactTestInstance, label: string) =>
  root.findAll((n) => n.type === "button" && n.props["aria-label"] === label);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Memory tab", () => {
  it("shows an error with a retry when memory cannot load", async () => {
    const api = fakeApi({
      list: vi.fn(async () => ({ ok: false as const, message: "Kora is not connected." })),
    });
    const { renderer } = await mount(api);
    expect(text(renderer.root)).toContain("Kora is not connected.");
    expect(text(renderer.root)).toContain("Try again");
  });

  it("filters while searching and says when nothing matches", async () => {
    const { renderer } = await mount(fakeApi());
    const input = renderer.root.findAll((n) => n.type === "input")[0]!;
    await act(async () => {
      input.props.onChange({ target: { value: "dallas" } });
    });
    expect(text(renderer.root)).toContain("You live in Dallas");
    expect(text(renderer.root)).not.toContain("Cites sources");
    await act(async () => {
      input.props.onChange({ target: { value: "zzzz" } });
    });
    expect(text(renderer.root)).toContain("Nothing about “zzzz”.");
  });

  it("edits core notes and surfaces the daemon's size error", async () => {
    const api = fakeApi({
      setCore: vi.fn(async () => ({
        message: "Core notes are limited to 1,500 tokens.",
        ok: false as const,
      })),
    });
    const { renderer, controller } = await mount(api);
    let problem: string | null = null;
    await act(async () => {
      problem = await controller().saveCore("you", "x".repeat(10));
    });
    expect(problem).toBe("Core notes are limited to 1,500 tokens.");
    const ok2 = fakeApi();
    const second = await mount(ok2);
    await act(async () => {
      await second.controller().saveCore("you", "Name: Sam K.");
    });
    expect(ok2.setCore).toHaveBeenCalledWith("you", null, "Name: Sam K.");
    expect(renderer).toBeDefined();
  });

  it("explains memory warmly when nothing is known yet", async () => {
    const { renderer } = await mount(fakeApi({}, { you: [], blob: [] }));
    const all = text(renderer.root);
    expect(all).toContain("Popo is still getting to know you");
    expect(all).toContain("edit or forget any of it");
  });

  it("commits a pending forget when the tab closes", async () => {
    const api = fakeApi();
    const { renderer, controller } = await mount(api);
    await act(async () => {
      controller().forget(fact({ id: "f1", text: "You live in Dallas" }), () => undefined);
    });
    await act(async () => {
      renderer.unmount();
    });
    expect(api.forget).toHaveBeenCalledWith("f1");
  });

  it("puts a fact back when forgetting fails on the daemon", async () => {
    const api = fakeApi({ forget: vi.fn(async () => ({ ok: false as const, message: "nope" })) });
    const { renderer, controller } = await mount(api);
    await act(async () => {
      controller().forget(fact({ id: "f1", text: "You live in Dallas" }), () => undefined);
    });
    await act(async () => {
      vi.advanceTimersByTime(FORGET_UNDO_MS + 100);
    });
    await flush();
    expect(text(renderer.root)).toContain("You live in Dallas");
    expect(controller().lastError).toBe("nope");
  });

  it("retires the fact once the undo window passes", async () => {
    const api = fakeApi();
    const { renderer, forgetToasts } = await mount(api);
    await act(async () => {
      byLabel(
        renderer.root.findAll((n) => n.props["data-memory-fact"] === "f1")[0]!,
        "Forget memory",
      )[0]!.props.onClick();
    });
    expect(forgetToasts).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(FORGET_UNDO_MS + 100);
    });
    expect(api.forget).toHaveBeenCalledWith("f1");
  });

  it("forgets after the undo window, and Undo within it brings the fact back without calling the API", async () => {
    const api = fakeApi();
    const { renderer, forgetToasts } = await mount(api);
    const row = () => renderer.root.findAll((n) => n.props["data-memory-fact"] === "f1");
    await act(async () => {
      byLabel(row()[0]!, "Forget memory")[0]!.props.onClick();
    });
    expect(row()).toHaveLength(0);
    expect(api.forget).not.toHaveBeenCalled();
    expect(forgetToasts).toHaveLength(1);

    await act(async () => {
      forgetToasts[0]!.undo();
    });
    expect(row()).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(FORGET_UNDO_MS + 100);
    });
    expect(api.forget).not.toHaveBeenCalled();
  });

  it("stars a fact optimistically", async () => {
    const api = fakeApi();
    const { renderer, controller } = await mount(api);
    await act(async () => {
      await controller().toggleImportant(fact({ id: "f1", text: "You live in Dallas" }));
    });
    expect(api.setImportant).toHaveBeenCalledWith("f1", true);
    const all = text(renderer.root);
    expect(all).toContain("You live in Dallas");
    const rows = renderer.root.findAll((n) => n.props["data-memory-fact"] === "f1");
    expect(
      rows[0]?.findAll((n) => n.type === "button" && n.props["aria-pressed"] === true),
    ).toHaveLength(1);
  });

  it("refuses to save an empty memory", async () => {
    const api = fakeApi();
    const { controller } = await mount(api);
    let problem: string | null = null;
    await act(async () => {
      problem = await controller().edit(fact({ id: "f1", text: "You live in Dallas" }), "   ");
    });
    expect(problem).toContain("needs some text");
    expect(api.edit).not.toHaveBeenCalled();
  });

  it("rolls an edit back and explains when the daemon refuses it", async () => {
    const api = fakeApi({
      edit: vi.fn(async () => ({ ok: false as const, message: "That memory changed. Reload." })),
    });
    const { renderer, controller } = await mount(api);
    let problem: string | null = null;
    await act(async () => {
      problem = await controller().edit(
        fact({ id: "f1", text: "You live in Dallas" }),
        "You live in Austin",
      );
    });
    expect(problem).toBe("That memory changed. Reload.");
    expect(text(renderer.root)).toContain("You live in Dallas");
  });

  it("edits a fact inline and saves it through the API", async () => {
    const api = fakeApi();
    const { renderer } = await mount(api);
    const row = renderer.root.findAll((n) => n.props["data-memory-fact"] === "f1")[0]!;
    await act(async () => {
      byLabel(row, "Edit memory")[0]!.props.onClick();
    });
    const editor = renderer.root.findAll(
      (n) => n.type === "textarea" && n.props["aria-label"] === "Edit this memory",
    )[0]!;
    await act(async () => {
      editor.props.onChange({ target: { value: "You live in Austin" } });
    });
    await act(async () => {
      editor.props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
    });
    await flush();
    expect(api.edit).toHaveBeenCalledWith("f1", "You live in Austin");
    expect(text(renderer.root)).toContain("You live in Austin");
    expect(text(renderer.root)).not.toContain("You live in Dallas");
  });

  it("shows Pending items with Approve / Not this", async () => {
    const { renderer } = await mount(fakeApi(), [
      {
        scope: "you",
        reason: "Mentions your health",
        text: "You take medication X",
        blobId: "blob_popo",
        receiptId: "r9",
      },
    ]);
    expect(text(renderer.root)).toContain("Pending");
    expect(text(renderer.root)).toContain("You take medication X");
    expect(text(renderer.root)).toContain("Approve");
  });
  it("lists the three groups with their facts, since-dates and sources", async () => {
    const { renderer } = await mount(fakeApi());
    const all = text(renderer.root);
    expect(all).toContain("About you");
    expect(all).toContain("Shared by all blobs");
    expect(all).toContain("Popo's notes");
    expect(all).toContain("You live in Dallas");
    expect(all).toContain("Cites sources as footnotes");
    expect(all).toContain("since Oct 6");
    expect(all).toContain("from a chat");
    // The extraction disclosure line is always shown.
    expect(all).toContain("Memory is learned with a free OpenCode model.");
    // Important facts sort first.
    expect(all.indexOf("You prefer short answers")).toBeLessThan(all.indexOf("You live in Dallas"));
  });
});

describe("memory model", () => {
  it("discloses the extraction model", () => {
    const engines = {
      opencode: { ready: true, freeModels: 3 },
      codex: { ready: false },
      claude: { ready: true },
      best: null,
    };
    // signed in to Claude does NOT make Haiku read the chats: a free model does, Claude only when the user allowed it
    expect(describeExtractor(engines).text).toContain("free OpenCode model");
    const noFree = { ...engines, opencode: { ready: false, freeModels: 0 } };
    expect(describeExtractor(noFree).learns).toBe(false);
    expect(describeExtractor(noFree, "Claude Haiku 5.5", true).text).toContain("Claude Haiku 5.5");
    // no Claude login: the free model is named
    const noClaude = { ...engines, claude: { ready: false } };
    expect(describeExtractor(noClaude).text).toContain("free OpenCode model");
    expect(describeExtractor(noClaude, "Qwen3 Coder").text).toContain("Qwen3 Coder");
    expect(
      describeExtractor({
        ...engines,
        claude: { ready: false },
        opencode: { ready: false, freeModels: 0 },
      }).learns,
    ).toBe(false);
  });

  it("words dates plainly", () => {
    expect(sinceLabel(NOW - 1000, NOW)).toBe("today");
    expect(sinceLabel(NOW - 86_400_000, NOW)).toBe("yesterday");
    expect(sinceLabel(Date.UTC(2026, 2, 4, 12), NOW)).toBe("Mar 4");
    expect(sinceLabel(Date.UTC(2025, 2, 4, 12), NOW)).toBe("Mar 2025");
  });

  it("filters facts by every search term", () => {
    const facts = [
      fact({ id: "a", text: "You live in Dallas" }),
      fact({ id: "b", text: "You like tea" }),
    ];
    expect(filterFacts(facts, "dallas live").map((f) => f.id)).toEqual(["a"]);
    expect(filterFacts(facts, "  ")).toHaveLength(2);
    expect(filterFacts(facts, "coffee")).toHaveLength(0);
  });
  it("orders important first, then newest", () => {
    const sorted = sortFacts([
      fact({ id: "a", text: "a", since: 1 }),
      fact({ id: "b", text: "b", since: 3 }),
      fact({ id: "c", text: "c", since: 2, important: true }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(["c", "b", "a"]);
  });
});
