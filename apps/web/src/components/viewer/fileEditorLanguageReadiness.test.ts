import * as NodeWorkerThreads from "node:worker_threads";

import {
  type FileContents,
  type DiffsHighlighter,
  type BaseCodeOptions,
  type HighlightedToken,
  getSharedHighlighter,
  FileRenderer,
  disposeHighlighter,
} from "@pierre/diffs";
import { TextDocument } from "@pierre/diffs/editor";
import { WorkerPoolManager, type WorkerRequest, type WorkerResponse } from "@pierre/diffs/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type DocumentEdit = NonNullable<ReturnType<TextDocument<unknown>["applyEdits"]>>;
interface EditorTokenizerShape {
  tokenize(change: DocumentEdit): Map<number, HighlightedToken[]>;
  cleanUp(): void;
}

// The editor's tokenizer is not a public export of the package, so import it by file location.
const tokenizerUrl = new URL("./editor/tokenizer.js", import.meta.resolve("@pierre/diffs")).href;
const { EditorTokenizer } = (await import(/* @vite-ignore */ tokenizerUrl)) as {
  EditorTokenizer: new (options: {
    textDocument: TextDocument<unknown>;
    highlighter: DiffsHighlighter;
    codeOptions: BaseCodeOptions;
    onDeferTokenize: () => void;
    setStyle: (style: string) => void;
  }) => EditorTokenizerShape;
};

const renderOptions = {
  useTokenTransformer: true,
  preferredHighlighter: "shiki-wasm",
  themeType: "dark",
  theme: "pierre-dark",
} as const;
const tsxSnippet = "export const Widget = () => <section>Loaded</section>;";

const terminations: Promise<number>[] = [];
let workerPool: WorkerPoolManager;
let fileRenderer: FileRenderer;

/** Hosts the installed Pierre worker bundle in a node worker_thread, exposing a browser-Worker-like surface. */
function createNodeWorker() {
  const preamble = `
    const { parentPort, workerData } = require("node:worker_threads");
    globalThis.self = {
      addEventListener(type, handler) {
        if (type === "message") parentPort.on("message", data => handler({ data }));
        if (type === "error") process.on("uncaughtException", handler);
      },
    };
    globalThis.postMessage = data => parentPort.postMessage(data);
    import(workerData.moduleUrl);`;
  const thread = new NodeWorkerThreads.Worker(preamble, {
    eval: true,
    execArgv: [],
    workerData: { moduleUrl: import.meta.resolve("@pierre/diffs/worker/worker.js") },
  });
  return {
    addEventListener(
      kind: "message" | "error",
      handler: (e: { data: WorkerResponse } | Error) => void,
    ) {
      if (kind === "error") thread.on("error", handler);
      else thread.on("message", (data: WorkerResponse) => handler({ data }));
    },
    postMessage: (message: WorkerRequest) => thread.postMessage(message, []),
    terminate: () => void terminations.push(thread.terminate()),
  } as unknown as globalThis.Worker;
}

/**
 * Appends a newline at the end of the file through a brand-new tokenizer. That first edit tokenizes
 * synchronously (ahead of any debounced prebuild), so it only succeeds when the grammar is already loaded.
 */
function appendNewlineAndTokenize(
  highlighter: DiffsHighlighter,
  file: FileContents,
  language: string,
) {
  const document = new TextDocument(file.name, file.contents, language);
  const tokenizer = new EditorTokenizer({
    textDocument: document,
    onDeferTokenize: () => {},
    setStyle: () => {},
    codeOptions: renderOptions,
    highlighter,
  });
  try {
    const eof = document.positionAt(file.contents.length);
    const edit = document.applyEdits([{ newText: "\n", range: { start: eof, end: eof } }]);
    expect(edit).not.toBeUndefined();
    expect([...tokenizer.tokenize(edit!).keys()]).toEqual([0, 1]);
    expect(document.getText()).toBe(`${file.contents}\n`);
  } finally {
    tokenizer.cleanUp();
  }
}

const tsxFileNamed = (name: string, overrides: Partial<FileContents> = {}): FileContents => ({
  name,
  contents: tsxSnippet,
  cacheKey: name,
  ...overrides,
});

beforeEach(async () => {
  terminations.length = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setImmediate(() => callback(0)),
  );
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  vi.stubGlobal("cancelAnimationFrame", clearImmediate);
  await disposeHighlighter();
  workerPool = new WorkerPoolManager(
    { poolSize: 1, workerFactory: createNodeWorker },
    renderOptions,
  );
  await workerPool.initialize();
  fileRenderer = new FileRenderer(renderOptions, undefined, workerPool);
});

/** Lets queued immediates (the pool's last state broadcast) run before the frame stubs go away. */
const drainImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(async () => {
  workerPool?.terminate();
  fileRenderer?.cleanUp();
  await Promise.all(terminations);
  await Promise.resolve(disposeHighlighter());
  await drainImmediates();
  vi.unstubAllGlobals();
});

describe("first edit after a file is opened", () => {
  it("does not load an unrelated grammar for a plain-text file", async () => {
    const readme: FileContents = { name: "readme.txt", contents: "Just prose", cacheKey: "readme" };
    fileRenderer.renderFile(readme);
    const highlighter = await fileRenderer.initializeHighlighter();

    appendNewlineAndTokenize(highlighter, readme, "text");

    expect(highlighter.getLoadedLanguages()).not.toContain("tsx");
  });

  it("loads the grammar for a hydrated file when the renderer has no worker pool", async () => {
    fileRenderer.cleanUp();
    fileRenderer = new FileRenderer(renderOptions);
    const file = tsxFileNamed("offline.tsx");

    fileRenderer.hydrate(file);

    appendNewlineAndTokenize(await fileRenderer.initializeHighlighter(), file, "tsx");
  });

  it("copes with a second file in another language on a renderer that was reused", async () => {
    const script: FileContents = { name: "a.ts", contents: "export const n = 2;", cacheKey: "a" };
    await getSharedHighlighter({ themes: ["pierre-dark"], langs: ["typescript"] });
    fileRenderer.renderFile(script);
    appendNewlineAndTokenize(await fileRenderer.initializeHighlighter(), script, "typescript");

    const component = tsxFileNamed("b.tsx");
    fileRenderer.renderFile(component);
    appendNewlineAndTokenize(await fileRenderer.initializeHighlighter(), component, "tsx");
  });

  describe.each(["hydrate", "renderFile"] as const)("via %s", (open) => {
    it("trusts an explicit language over a misleading .txt name", async () => {
      const file = tsxFileNamed("component.txt", { lang: "tsx", cacheKey: "forced-lang" });
      await workerPool.primeFileHighlightCache(file);

      fileRenderer[open](file);

      appendNewlineAndTokenize(await fileRenderer.initializeHighlighter(), file, "tsx");
    });

    it("defers loading the inferred grammar for a worker-highlighted file until editing begins", async () => {
      const file = tsxFileNamed("lazy.tsx");
      await workerPool.primeFileHighlightCache(file);
      expect(workerPool.getFileResultCache(file)).toBeDefined();
      const shared = await getSharedHighlighter({ langs: ["text"], themes: ["pierre-dark"] });
      expect(shared.getLoadedLanguages()).not.toContain("tsx");

      fileRenderer[open](file);
      expect(shared.getLoadedLanguages()).not.toContain("tsx");

      appendNewlineAndTokenize(await fileRenderer.initializeHighlighter(), file, "tsx");
    });
  });
});
