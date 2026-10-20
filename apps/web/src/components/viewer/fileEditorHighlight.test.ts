import * as NodeWorkerThreads from "node:worker_threads";
import { getSharedHighlighter } from "@pierre/diffs";
import { FileRenderer } from "@pierre/diffs";
import type {
  BaseCodeOptions,
  DiffsHighlighter,
  FileContents,
  HighlightedToken,
  RenderRange,
} from "@pierre/diffs";
import { TextDocument } from "@pierre/diffs/editor";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import type { WorkerRequest, WorkerResponse } from "@pierre/diffs/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type TextEditResult = NonNullable<ReturnType<InstanceType<typeof TextDocument>["applyEdits"]>>;

type TokenizerBridge = {
  readonly themeType: "light" | "dark";
  tokenize(change: TextEditResult, bounds: RenderRange): Map<number, HighlightedToken[]>;
  cleanUp(): void;
};

const diffsTokenizerUrl = new URL("./editor/tokenizer.js", import.meta.resolve("@pierre/diffs"))
  .href;
const dynamicTokenizer = await import(/* @vite-ignore */ diffsTokenizerUrl);
const EditorTokenizerCtor = dynamicTokenizer.EditorTokenizer as new (
  params: Record<string, unknown>,
) => TokenizerBridge;

const workerScriptHref = String(import.meta.resolve("@pierre/diffs/worker/worker.js"));

const LINE_COUNT = 7_000;
const testDocumentBody = Array.from(
  { length: LINE_COUNT },
  (_, idx) =>
    `export const blockItem_${idx} = <div>Synthetic line content ${idx} for testing tokenizer.</div>;`,
).join("\n");

function makeEditorOptions(): BaseCodeOptions {
  return {
    disableFileHeader: true,
    overflow: "wrap",
    preferredHighlighter: "shiki-wasm",
    theme: "pierre-dark",
    themeType: "dark",
    useTokenTransformer: true,
  };
}

const viewportRange: RenderRange = {
  bufferAfter: 0,
  bufferBefore: 0,
  startingLine: 6_950,
  totalLines: 150,
};

type InterceptedPacket = {
  data: WorkerResponse;
  deliver(): void;
};

interface FixtureState {
  file: FileContents;
  doc: TextDocument<unknown>;
  renderer: FileRenderer;
  tokenizer: TokenizerBridge;
  pool: WorkerPoolManager;
  timers: Set<ReturnType<typeof setImmediate>>;
}

let state: FixtureState;
let interceptedQueue: InterceptedPacket[] = [];
let pendingResolvers: ((packet: InterceptedPacket) => void)[] = [];
let threadExitTasks: Promise<number>[] = [];

function waitForNextPacket(): Promise<InterceptedPacket> {
  return new Promise((resolve) => {
    const item = interceptedQueue.shift();
    if (item !== undefined) {
      resolve(item);
    } else {
      pendingResolvers.push(resolve);
    }
  });
}

class NodeWorkerSim {
  private readonly inner = new NodeWorkerThreads.Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     globalThis.self = {
       addEventListener(ev, cb) {
         if (ev === "message") parentPort.on("message", val => cb({ data: val }));
         if (ev === "error") process.on("uncaughtException", cb);
       }
     };
     globalThis.postMessage = msg => parentPort.postMessage(msg);
     import(workerData.targetScript);`,
    { eval: true, execArgv: [], workerData: { targetScript: workerScriptHref } },
  );

  addEventListener(
    type: "message" | "error",
    callback: (param: { data: WorkerResponse } | Error) => void,
  ) {
    if (type === "error") {
      this.inner.on("error", callback);
      return;
    }
    this.inner.on("message", (msg: WorkerResponse) => {
      const packet: InterceptedPacket = {
        data: msg,
        deliver: () => callback({ data: msg }),
      };
      if (msg.type !== "success" || msg.requestType !== "file") {
        packet.deliver();
        return;
      }
      const waiting = pendingResolvers.shift();
      if (waiting) {
        waiting(packet);
      } else {
        interceptedQueue.push(packet);
      }
    });
  }

  postMessage(req: WorkerRequest) {
    this.inner.postMessage(req, []);
  }

  terminate() {
    threadExitTasks.push(this.inner.terminate());
  }
}

function handleDocChange(edit: TextEditResult) {
  const newTokens = state.tokenizer.tokenize(edit, viewportRange);
  state.renderer.updateRenderCache(newTokens, state.tokenizer.themeType);
  state.file.contents = state.doc.getText();
  if (edit.lineDelta !== 0) {
    state.renderer.applyDocumentChange(state.doc);
  }
}

function appendContent(added: string) {
  const offset = state.doc.getText().length;
  const coord = state.doc.positionAt(offset);
  const res = state.doc.applyEdits([{ newText: added, range: { end: coord, start: coord } }]);
  expect(res).toBeDefined();
  handleDocChange(res!);
}

function revertLastEdit() {
  const reversed = state.doc.undo();
  expect(reversed?.[0]).toBeDefined();
  handleDocChange(reversed![0]!);
}

function renderMarkup(): string {
  const rendered = state.renderer.renderFile(state.file, viewportRange);
  expect(rendered?.totalLines).toBe(state.doc.lineCount);
  return state.renderer.renderFullHTML(rendered!);
}

beforeEach(async () => {
  interceptedQueue = [];
  pendingResolvers = [];
  threadExitTasks = [];

  const timers = new Set<ReturnType<typeof setImmediate>>();
  vi.stubGlobal("requestAnimationFrame", (action: FrameRequestCallback) => {
    const handle = setImmediate(() => {
      timers.delete(handle);
      action(0);
    });
    timers.add(handle);
    return handle;
  });

  vi.stubGlobal("cancelAnimationFrame", (h: ReturnType<typeof setImmediate>) => {
    timers.delete(h);
    clearImmediate(h);
  });

  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });

  const opts = makeEditorOptions();
  const pool = new WorkerPoolManager(
    {
      poolSize: 1,
      workerFactory: () => new NodeWorkerSim() as unknown as globalThis.Worker,
    },
    opts,
  );
  await pool.initialize(["tsx"]);

  const highlighter = await getSharedHighlighter({
    langs: ["tsx"],
    preferredHighlighter: "shiki-wasm",
    themes: ["pierre-dark"],
  });

  const file: FileContents = {
    cacheKey: "shared-editor-key",
    contents: testDocumentBody,
    name: "editor-target.tsx",
  };
  const doc = new TextDocument(file.name, testDocumentBody, "tsx");
  const renderer = new FileRenderer(opts, () => {}, pool);

  const tokenizer = new EditorTokenizerCtor({
    codeOptions: opts,
    highlighter,
    onDeferTokenize: (tokens: Map<number, HighlightedToken[]>, theme: "light" | "dark") =>
      renderer.updateRenderCache(tokens, theme),
    setStyle: () => {},
    textDocument: doc,
  });

  state = { doc, file, pool, renderer, timers, tokenizer };
  renderMarkup();
});

async function teardownEnvironment() {
  state?.tokenizer?.cleanUp();
  state?.renderer?.cleanUp();
  state?.pool?.terminate();
  await Promise.all(threadExitTasks);

  if (state?.timers) {
    for (const t of state.timers) {
      clearImmediate(t);
    }
    state.timers.clear();
  }
  vi.unstubAllGlobals();
}

afterEach(teardownEnvironment);

describe("editable file highlighting", { timeout: 60_000 }, () => {
  it("cleans up an already terminated worker pool", async () => {
    const initPacket = await waitForNextPacket();
    initPacket.deliver();

    expect(state.pool.getStats().totalWorkers).toBe(1);
    state.pool.terminate();
    await Promise.all(threadExitTasks);
    expect(state.pool.getStats().totalWorkers).toBe(0);

    const savedRaf = globalThis.requestAnimationFrame;
    const savedCancel = globalThis.cancelAnimationFrame;
    const savedWin = globalThis.window;
    try {
      await teardownEnvironment();
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      vi.stubGlobal("requestAnimationFrame", savedRaf);
      vi.stubGlobal("cancelAnimationFrame", savedCancel);
      vi.stubGlobal("window", savedWin);
    }
  });

  it("still accepts an asynchronous highlight when the file has not changed", async () => {
    expect(renderMarkup()).not.toContain('style="color:');
    const packet = await waitForNextPacket();
    packet.deliver();
    expect(renderMarkup()).toContain('style="color:');
    expect(state.pool.getFileResultCache(state.file)).toBeDefined();
  });

  it.each([1, 60])(
    "ignores a dispatched highlight after %i Enter edits and highlights the new version",
    async (enterCount) => {
      const earlierPacket = await waitForNextPacket();
      for (let i = 0; i < enterCount; i += 1) {
        appendContent("\n");
      }
      appendContent("export const EDITED_TOKEN = 999;");
      earlierPacket.deliver();

      expect(renderMarkup()).toContain("EDITED_TOKEN");

      const latestPacket = await waitForNextPacket();
      latestPacket.deliver();

      expect(renderMarkup()).toContain("EDITED_TOKEN");
      const topSegment = state.renderer.renderFile(state.file, {
        ...viewportRange,
        startingLine: 0,
        totalLines: 20,
      });
      expect(state.renderer.renderFullHTML(topSegment!)).toContain('style="color:');
      expect(state.doc.lineCount).toBe(LINE_COUNT + enterCount);
    },
  );

  it("does not replace a same-line edit with stale tokens", async () => {
    const stalePacket = await waitForNextPacket();
    appendContent(" // INLINE_ADDITION");
    stalePacket.deliver();

    expect(renderMarkup()).toContain("INLINE_ADDITION");
    expect(state.doc.lineCount).toBe(LINE_COUNT);

    const freshPacket = await waitForNextPacket();
    freshPacket.deliver();
    expect(renderMarkup()).toContain("INLINE_ADDITION");
  });

  it("keeps undo edits after an older highlight arrives", async () => {
    const inFlight = await waitForNextPacket();
    appendContent("\nexport const SAVED_VAL = 100;");
    appendContent("\nexport const REMOVED_VAL = 200;");
    revertLastEdit();

    inFlight.deliver();
    const midHtml = renderMarkup();
    expect(midHtml).toContain("SAVED_VAL");
    expect(midHtml).not.toContain("REMOVED_VAL");

    const following = await waitForNextPacket();
    following.deliver();
    expect(renderMarkup()).toContain("SAVED_VAL");

    revertLastEdit();
    expect(state.doc.getText()).toBe(testDocumentBody);
    expect(renderMarkup()).not.toContain("SAVED_VAL");

    const redone = state.doc.redo()?.[0];
    expect(redone).toBeDefined();
    handleDocChange(redone!);
    expect(renderMarkup()).toContain("SAVED_VAL");
  });

  it("evicts the pre-edit shared cache without losing already-highlighted lines", async () => {
    const ready = await waitForNextPacket();
    ready.deliver();

    expect(state.pool.getFileResultCache(state.file)).toBeDefined();
    appendContent("\nexport const BRAND_NEW = 42;");
    expect(state.pool.getFileResultCache(state.file)).toBeUndefined();
    expect(renderMarkup()).toContain("BRAND_NEW");

    const startSlice = state.renderer.renderFile(state.file, {
      ...viewportRange,
      startingLine: 0,
      totalLines: 20,
    });
    expect(state.renderer.renderFullHTML(startSlice!)).toContain('style="color:');
  });

  it("reopens the edited file with the same cache key while an old response is pending", async () => {
    const unapplied = await waitForNextPacket();
    appendContent("\nexport const REOPENED_TOKEN = true;");

    state.renderer.cleanUp();
    state.renderer = new FileRenderer(makeEditorOptions(), () => {}, state.pool);
    state.file = { ...state.file };

    expect(renderMarkup()).toContain("REOPENED_TOKEN");
    unapplied.deliver();

    const arrived = await waitForNextPacket();
    arrived.deliver();

    expect(renderMarkup()).toContain("REOPENED_TOKEN");
    expect(renderMarkup()).toContain('style="color:');
  });
});
