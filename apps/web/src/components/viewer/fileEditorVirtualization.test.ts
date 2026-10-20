// Regression tests for Kora's patch to @pierre/diffs (patches/@pierre__diffs@*.patch): wrapped rows
// keep their measured heights across edits above them, a code-width change drops every measurement,
// a column resize asks the virtualizer to re-measure, and a gutter that gains or loses a digit
// counts as a width change.
import {
  type FileContents,
  Virtualizer,
  VirtualizedFile,
  getSharedHighlighter,
} from "@pierre/diffs";
import { Editor, TextDocument } from "@pierre/diffs/editor";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const queueModule = new URL(
  "./managers/UniversalRenderingManager.js",
  import.meta.resolve("@pierre/diffs"),
);
const renderQueue = (await import(/* @vite-ignore */ queueModule.href)) as {
  clearRenderQueue(): void;
};

/** Default row height for a line nobody measured. */
const ROW = 20;
const GUTTER = 56.75;

// ---- fake layout ------------------------------------------------------------------------------

const ignore = (..._args: unknown[]) => undefined;
/** Every character is 8px wide. */
const monospaceCanvas = { measureText: (text: string) => ({ width: 8 * text.length }) };

/** An element whose size the test sets; nothing here wraps text on its own. */
class Box {
  children: Box[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  parentElement: Box | null = null;
  nextElementSibling: Box | null = null;
  width = 300;
  constructor(public height = 0) {}

  getBoundingClientRect() {
    return { top: 0, width: this.width, height: this.height };
  }
  get firstElementChild(): Box | null {
    return this.children[0] ?? null;
  }
  appendChild(child: Box) {
    this.children = [...this.children, child];
    child.parentElement = this;
    return child;
  }
  prepend(child: Box) {
    child.parentElement = this;
    this.children.unshift(child);
  }
  replaceChildren(...next: Array<Box | string>) {
    this.children = [];
    for (const child of next) if (typeof child !== "string") this.appendChild(child);
  }
  remove() {
    const parent = this.parentElement;
    if (parent) parent.children = parent.children.filter((child) => child !== this);
  }
  set innerHTML(_markup: string) {
    this.replaceChildren(new Box());
  }
  querySelectorAll(_selector: string) {
    return this.children.filter((child) => "code" in child.dataset);
  }
  // Calls the editor makes that need no effect here.
  readonly after = ignore;
  readonly removeEventListener = ignore;
  readonly addEventListener = ignore;
  readonly removeAttribute = ignore;
  readonly setAttribute = ignore;
  readonly querySelector = (_selector: string) => null;
  readonly getContext = () => monospaceCanvas;
}

class CodeBox extends Box {
  readonly tagName = "CODE";
}

const asElement = (box: Box) => box as unknown as HTMLElement;

const resizeObservers: Array<{ callback: ResizeObserverCallback; targets: Set<unknown> }> = [];
class FakeResizeObserver {
  targets = new Set<unknown>();
  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }
  observe(target: unknown) {
    this.targets.add(target);
  }
  readonly disconnect = () => this.targets.clear();
  readonly unobserve = (target: unknown) => void this.targets.delete(target);
}

const observerOf = (target: Box) => {
  const observer = resizeObservers.find((candidate) => candidate.targets.has(target));
  if (!observer) throw new Error("nothing observes this box");
  return observer;
};

/** Sends the box's current size to the observer that watches (or watched) it. */
const deliverResize = (target: Box, observer = observerOf(target)) => {
  const { width, height } = target.getBoundingClientRect();
  const size = [{ inlineSize: width, blockSize: height }];
  observer.callback(
    [
      {
        target: asElement(target),
        contentRect: target.getBoundingClientRect() as DOMRectReadOnly,
        borderBoxSize: size,
        contentBoxSize: size,
        devicePixelContentBoxSize: size,
      },
    ],
    observer as unknown as ResizeObserver,
  );
};

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const runFrames = () => {
  for (let round = 0; frames.size > 0; round += 1) {
    if (round > 10) throw new Error("render queue never settled");
    const due = [...frames.values()];
    frames.clear();
    for (const run of due) run(round);
  }
};

const renderWindow = (startingLine: number, totalLines: number) => ({
  ...{ bufferAfter: 0, bufferBefore: 0 },
  totalLines,
  startingLine,
});

const HIGHLIGHTER = {
  preferredHighlighter: "shiki-wasm",
  themes: ["pierre-dark"],
  langs: ["text"],
} as const;

// ---- a virtualized file the test can measure -----------------------------------------------------

class FlatVirtualizer extends Virtualizer {
  override getOffsetInScrollContainer() {
    return 0;
  }
}

class TestFile extends VirtualizedFile {
  override attachEditor(attached: Parameters<VirtualizedFile["attachEditor"]>[0]) {
    const detach = () => {
      if (this.editor === attached) this.editor = undefined;
    };
    this.editor = attached;
    return detach;
  }

  override top = 0;

  /** Lays out the given rows (line index -> height) inside a code column of `width`. */
  layOut(rows: ReadonlyArray<readonly [number, number]>, width: number) {
    const lines = new Box();
    lines.width = width;
    for (const [line, height] of rows) {
      const row = lines.appendChild(new Box(height));
      row.dataset.lineIndex = `${line}`;
    }
    const code = new CodeBox();
    code.width = width + GUTTER;
    code.children = [new Box(), lines];
    this.code = asElement(code);
    this.reconcileHeights();
  }

  /** Changes the code column's width without re-measuring rows. */
  setWidth(width: number, codeWidth = width + GUTTER) {
    const code = this.code as unknown as Box;
    code.width = codeWidth;
    code.children[1]!.width = width;
  }

  /** Renders the tail of `contents` once so the file has a layout to measure. */
  async load(contents: FileContents, lineCount: number) {
    this.prepareCodeViewItem(contents, 0);
    await this.fileRenderer.initializeHighlighter();
    this.fileRenderer.renderFile(contents, renderWindow(Math.max(0, lineCount - 51), 51));
    this.fileContainer = asElement(new Box());
  }

  /** Starts the real resize manager on the current code column. */
  watchResizes() {
    const pre = new Box();
    pre.children = [this.code as unknown as Box];
    this.resizeManager.setup(asElement(pre) as HTMLPreElement, {
      disableAnnotations: true,
      columnVariables: "measure",
    });
    const code = this.code as unknown as Box;
    const observer = observerOf(code);
    return () => deliverResize(code, observer);
  }

  teardown() {
    this.cleanUp();
    this.fileContainer = undefined;
    this.code = undefined;
  }
}

/** Everything a test opened, closed again after it. */
const open = { editors: [] as Editor<undefined>[], files: [] as TestFile[] };
const editors = open.editors;
const files = open.files;

beforeAll(() =>
  getSharedHighlighter({
    ...HIGHLIGHTER,
    langs: [...HIGHLIGHTER.langs],
    themes: [...HIGHLIGHTER.themes],
  }),
);

beforeEach(() => {
  resizeObservers.length = 0;
  frames.clear();
  vi.stubGlobal("HTMLElement", Box);
  vi.stubGlobal("Document", Box);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, run);
    return id;
  });
});

afterEach(() => {
  open.editors.splice(0).forEach((editor) => editor.cleanUp());
  open.files.splice(0).forEach((file) => file.teardown());
  renderQueue.clearRenderQueue();
  frames.clear();
  vi.unstubAllGlobals();
});

/** A wrapped text file of `lineCount` lines with a few tall rows measured at `width`. */
const openFile = async (lineCount = 3_001, width = 200) => {
  const text = Array.from({ length: lineCount }, (_, n) => `row ${n}`).join("\n");
  const contents: FileContents = {
    name: "notes.txt",
    lang: "text",
    cacheKey: `notes:${lineCount}`,
    contents: text,
  };
  const file = new TestFile(
    {
      overflow: "wrap",
      theme: "pierre-dark",
      preferredHighlighter: "shiki-wasm",
      disableFileHeader: true,
      useTokenTransformer: true,
      controlledSelection: true,
    },
    new FlatVirtualizer(),
  );
  files.push(file);
  await file.load(contents, lineCount);
  file.layOut(
    [
      [0, 70],
      [10, 50],
      [2_000, 90],
      [lineCount - 1, 40],
    ],
    width,
  );

  const doc = new TextDocument(contents.name, text, "text");
  /** Applies an edit to the document and hands it to the file, as the editor would. */
  const edit = (change: { startLine: number } | undefined, withStartLine = true) => {
    if (!change) throw new Error("no change");
    contents.contents = doc.getText();
    file.applyDocumentChange(doc, undefined, false, withStartLine ? change.startLine : undefined);
  };
  const newlineAt = (line: number, character = 0) =>
    edit(
      doc.applyEdits([
        { newText: "\n", range: { start: { line, character }, end: { line, character } } },
      ]),
    );
  const newlineAtEnd = () => {
    const end = doc.positionAt(doc.getText().length);
    return doc.applyEdits([{ newText: "\n", range: { start: end, end } }]);
  };
  return { file, doc, contents, edit, newlineAt, newlineAtEnd };
};

// ---- width ------------------------------------------------------------------------------------

describe("code column width", () => {
  it("keeps measurements while the width is unchanged", async () => {
    const { file } = await openFile();
    const height = file.getVirtualizedHeight();
    const resize = file.watchResizes();
    resize();
    resize();
    runFrames();
    expect([file.getLineHeight(0), file.getLineHeight(2_000)]).toEqual([70, 90]);
    expect(file.getVirtualizedHeight()).toBe(height);
  });

  it("drops every measured row when a re-measure sees a new width", async () => {
    const { file } = await openFile(3_001, 200);
    file.layOut([[3_000, 40]], 420);
    // Only the rows measured at the new width survive.
    expect([file.getLineHeight(0), file.getLineHeight(2_000), file.getLineHeight(3_000)]).toEqual([
      ROW,
      ROW,
      40,
    ]);
  });

  it("re-measures after a resize, but not while the column is hidden", async () => {
    const { file } = await openFile();
    file.layOut([[3_000, 15]], 200);
    const resize = file.watchResizes();

    file.setWidth(0, 0);
    resize();
    runFrames();
    expect(file.getLineHeight(0)).toBe(70);

    file.setWidth(420);
    resize();
    runFrames();
    expect(file.getLineHeight(0)).toBe(ROW);
  });

  it("does nothing for a resize delivered after the file was torn down", async () => {
    const { file } = await openFile();
    const resize = file.watchResizes();
    file.teardown();
    files.splice(files.indexOf(file), 1);
    renderQueue.clearRenderQueue();
    frames.clear();
    resize();
    expect(frames.size).toBe(0);
  });
});

// ---- edits ------------------------------------------------------------------------------------

describe("document edits in a wrapped file", () => {
  it("keeps rows above the edit and forgets the rest", async () => {
    const { file, newlineAt } = await openFile();
    newlineAt(1_000, 2);
    expect([file.getLineHeight(0), file.getLineHeight(10)]).toEqual([70, 50]);
    expect(file.getLineHeight(2_001)).toBe(ROW);
  });

  it("forgets everything when the edit's first line is unknown", async () => {
    const { file, edit, newlineAtEnd } = await openFile();
    edit(newlineAtEnd(), false);
    expect(file.getLineHeight(0)).toBe(ROW);
  });

  it("keeps the prefix across repeated edits, undo and redo", async () => {
    const { file, doc, edit, newlineAtEnd } = await openFile();
    const anchor = file.getLinePosition(2_001)!.top;
    for (let n = 0; n < 25; n += 1) edit(newlineAtEnd());
    edit(doc.undo()?.[0]);
    edit(doc.redo()?.[0]);
    expect(file.getLinePosition(2_001)?.top).toBe(anchor);
    expect(file.getLineHeight(0)).toBe(70);
  });

  it("uses the earliest line when several places change at once", async () => {
    const { file, doc, edit } = await openFile();
    const above = file.getLinePosition(11)!;
    edit(
      doc.applyEdits(
        [10, 2_500].map((line) => ({
          newText: "\n",
          range: { start: { line, character: 1 }, end: { line, character: 1 } },
        })),
      ),
    );
    // The changed line itself is re-measured; everything above stays put.
    expect(file.getLinePosition(11)).toEqual({ top: above.top, height: ROW });
    expect(file.getLineHeight(2_000)).toBe(ROW);
  });

  it("still forgets everything for annotation and metric changes", async () => {
    const { file, contents, edit, newlineAtEnd } = await openFile();
    edit(newlineAtEnd());
    file.setLineAnnotations([{ lineNumber: 4, metadata: undefined }]);
    file.prepareCodeViewItem(contents, 0);
    expect(file.getLineHeight(0)).toBe(ROW);

    const other = await openFile(3_001);
    other.file.setMetrics({ lineHeight: 30, hunkLineCount: 50, diffHeaderHeight: 44, spacing: 8 });
    other.file.prepareCodeViewItem(other.contents, 0);
    expect(other.file.getLineHeight(0)).toBe(30);
  });
});

// ---- editor: gutter digits ---------------------------------------------------------------------

/** Opens the file in a real Editor with just enough DOM for it to tokenize and lay out. */
const openInEditor = async (lineCount: number) => {
  const opened = await openFile(lineCount);
  const { file, contents } = opened;
  vi.stubGlobal("SVGSVGElement", Box);
  vi.stubGlobal("document", Object.assign(new Box(), { createElement: () => new Box() }));
  const editorGlobals = {
    ResizeObserver: FakeResizeObserver,
    cancelAnimationFrame: ignore,
    requestAnimationFrame: () => 1,
    window: { matchMedia: () => ({ matches: true }) },
  };
  for (const [name, value] of Object.entries(editorGlobals)) vi.stubGlobal(name, value);
  vi.stubGlobal("getComputedStyle", () => ({
    fontSize: "13px",
    fontFamily: "monospace",
    lineHeight: `${ROW}px`,
    paddingTop: "0px",
    tabSize: "2",
  }));
  file.setOptions({
    ...file.options,
    themeType: "dark",
    controlledSelection: true,
    useTokenTransformer: true,
  });

  const code = new Box();
  code.dataset.code = "";
  const gutter = code.appendChild(new Box());
  gutter.dataset.gutter = "";
  const lines = code.appendChild(new Box());
  lines.dataset.content = "";
  const shadowRoot = new Box();
  shadowRoot.appendChild(code);

  const editor = new Editor<undefined>();
  editors.push(editor);
  editor.edit(file);
  const highlighter = await getSharedHighlighter({
    ...HIGHLIGHTER,
    langs: [...HIGHLIGHTER.langs],
    themes: [...HIGHLIGHTER.themes],
  });
  editor.__syncRenderView(
    highlighter,
    asElement(Object.assign(new Box(), { shadowRoot })),
    contents,
    undefined,
    renderWindow(0, 1),
  );

  const lastPosition = () => {
    const all = editor.getText().split("\n");
    return { line: all.length - 1, character: all.at(-1)!.length };
  };
  return {
    file,
    editor,
    lineCount: () => editor.getText().split("\n").length,
    addLines: (count: number) => {
      const end = lastPosition();
      editor.applyEdits([{ newText: "\n".repeat(count), range: { start: end, end } }]);
    },
    dropLines: (count: number) => {
      const all = editor.getText().split("\n");
      const from = all.length - 1 - count;
      editor.applyEdits([
        {
          newText: "",
          range: { start: { line: from, character: all[from]!.length }, end: lastPosition() },
        },
      ]);
    },
  };
};

describe("editor edits and the gutter width", () => {
  it.each([
    [9_998, 1],
    [10_000, 3],
  ])("keeps the prefix when %i lines gain %i without a new digit", async (lines, extra) => {
    const { file, editor, addLines, lineCount } = await openInEditor(lines);
    addLines(extra);
    expect(lineCount()).toBe(lines + extra);
    expect(file.getLineHeight(0)).toBe(70);
    editor.undo();
    editor.redo();
    expect(file.getLineHeight(0)).toBe(70);
  });

  it.each([
    [9_999, 1],
    [9_998, 4],
  ])("forgets everything when %i lines gain %i and the gutter widens", async (lines, extra) => {
    const { file, addLines } = await openInEditor(lines);
    addLines(extra);
    expect([file.getLineHeight(0), file.getLineHeight(2_000)]).toEqual([ROW, ROW]);
  });

  it.each([
    [10_000, 1],
    [10_003, 5],
  ])("forgets everything when %i lines lose %i and the gutter narrows", async (lines, fewer) => {
    const { file, dropLines, lineCount } = await openInEditor(lines);
    dropLines(fewer);
    expect(lineCount()).toBe(lines - fewer);
    expect(file.getLineHeight(0)).toBe(ROW);
  });

  it("forgets rows measured between an undo and a redo across the digit boundary", async () => {
    const { file, editor, addLines } = await openInEditor(9_999);
    addLines(1);
    file.layOut([[0, 110]], 200);
    editor.undo();
    expect(file.getLineHeight(0)).toBe(ROW);
    file.layOut([[0, 75]], 200);
    editor.redo();
    expect(file.getLineHeight(0)).toBe(ROW);
  });
});
