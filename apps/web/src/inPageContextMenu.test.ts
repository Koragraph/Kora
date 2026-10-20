import type { ContextMenuItem } from "@kora/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { dismissContextMenu, showContextMenuFallback } from "./inPageContextMenu";

class SimEvent {
  public defaultPrevented = false;
  public propagationStopped = false;
  public target: SimNode | null = null;

  constructor(
    public readonly type: string,
    params: Record<string, unknown> = {},
  ) {
    Object.assign(this, params);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

class SimNode {
  public parentNode: SimNode | null = null;
  public childList: SimNode[] = [];
  public attributes = new Map<string, string>();
  public dataset: Record<string, string> = {};
  public style: Record<string, string> = {};
  public disabled = false;
  public className = "";
  public type = "button";
  private rawText = "";
  private listeners = new Map<string, Array<{ fn: (e: any) => void; capture: boolean }>>();

  constructor(public readonly tagName: string) {}

  get isConnected(): boolean {
    let p: SimNode | null = this;
    while (p?.parentNode) p = p.parentNode;
    return p?.tagName.toLowerCase() === "body";
  }

  get childNodes(): SimNode[] {
    return this.childList;
  }

  get parentElement(): SimNode | null {
    return this.parentNode;
  }

  appendChild<T extends SimNode>(child: T): T {
    child.parentNode = this;
    this.childList.push(child);
    return child;
  }

  remove(): void {
    if (this.parentNode) {
      const idx = this.parentNode.childList.indexOf(this);
      if (idx !== -1) {
        this.parentNode.childList.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }

  contains(other: SimNode | null): boolean {
    let p: SimNode | null = other;
    while (p) {
      if (p === this) return true;
      p = p.parentNode;
    }
    return false;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  set textContent(txt: string) {
    this.rawText = txt;
  }

  get textContent(): string {
    const kidsText = this.childList.map((c) => c.textContent).join("");
    return this.rawText + kidsText;
  }

  set innerHTML(_content: string) {
    // simplified stub
  }

  addEventListener(type: string, fn: (e: any) => void, capture = false): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push({ fn, capture });
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, fn: (e: any) => void, capture = false): void {
    const bucket = this.listeners.get(type);
    if (!bucket) return;
    const idx = bucket.findIndex((entry) => entry.fn === fn && entry.capture === capture);
    if (idx !== -1) bucket.splice(idx, 1);
  }

  dispatchEvent(evt: SimEvent): boolean {
    if (!evt.target) evt.target = this;
    const bucket = this.listeners.get(evt.type) ?? [];
    for (const entry of [...bucket]) {
      entry.fn(evt);
    }
    return !evt.defaultPrevented;
  }

  focus(_opts?: { preventScroll?: boolean }): void {
    const doc = (globalThis as any).document as SimDoc;
    if (doc.activeElement === this) return;
    doc.activeElement = this;
    this.dispatchEvent(new SimEvent("focus"));
  }

  blur(): void {
    const doc = (globalThis as any).document as SimDoc;
    if (doc.activeElement === this) {
      doc.activeElement = null;
      this.dispatchEvent(new SimEvent("blur"));
    }
  }

  click(): void {
    this.dispatchEvent(new SimEvent("click"));
  }

  querySelectorAll(tag: string): SimNode[] {
    const res: SimNode[] = [];
    for (const child of this.childList) {
      if (child.tagName.toLowerCase() === tag.toLowerCase()) {
        res.push(child);
      }
      res.push(...child.querySelectorAll(tag));
    }
    return res;
  }

  getBoundingClientRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } {
    const left = parseFloat(this.style.left || "0") || 0;
    const top = parseFloat(this.style.top || "0") || 0;
    const isContainer = this.tagName.toLowerCase() === "div";
    const width = isContainer ? 200 : 160;
    const height = isContainer ? 140 : 32;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

class SimDoc {
  public body = new SimNode("body");
  public activeElement: SimNode | null = null;
  private docListeners = new Map<string, Array<{ fn: (e: any) => void; capture: boolean }>>();

  createElement(name: string): SimNode {
    return new SimNode(name);
  }

  addEventListener(type: string, fn: (e: any) => void, capture = false): void {
    const arr = this.docListeners.get(type) ?? [];
    arr.push({ fn, capture });
    this.docListeners.set(type, arr);
  }

  removeEventListener(type: string, fn: (e: any) => void, capture = false): void {
    const arr = this.docListeners.get(type);
    if (!arr) return;
    const i = arr.findIndex((x) => x.fn === fn && x.capture === capture);
    if (i !== -1) arr.splice(i, 1);
  }

  dispatchEvent(evt: SimEvent): boolean {
    const arr = this.docListeners.get(evt.type) ?? [];
    for (const item of [...arr]) {
      item.fn(evt);
    }
    return !evt.defaultPrevented;
  }

  querySelectorAll(tag: string): SimNode[] {
    return this.body.querySelectorAll(tag);
  }
}

let testDoc: SimDoc;
let queuedRaf: ((ts: number) => void) | null = null;

beforeEach(() => {
  testDoc = new SimDoc();
  queuedRaf = null;

  vi.stubGlobal("document", testDoc);
  vi.stubGlobal("HTMLElement", SimNode);
  vi.stubGlobal("window", {
    innerWidth: 1024,
    innerHeight: 768,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: (ts: number) => void) => {
    queuedRaf = cb;
    return 1;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function flushNextFrame() {
  if (queuedRaf) {
    const cb = queuedRaf;
    queuedRaf = null;
    cb(performance.now());
  }
}

function queryButtonByText(match: string): SimNode | undefined {
  return testDoc.querySelectorAll("button").find((btn) => btn.textContent.includes(match));
}

function emitDocKey(key: string): SimEvent {
  const evt = new SimEvent("keydown", { key });
  testDoc.dispatchEvent(evt);
  return evt;
}

describe("dismissContextMenu", () => {
  it("safely ignores invocations when no context menu exists", () => {
    expect(() => dismissContextMenu()).not.toThrow();
    expect(testDoc.querySelectorAll("button")).toHaveLength(0);
  });

  it("closes an active menu session returning null", async () => {
    const pending = showContextMenuFallback([
      { id: "cut", label: "Cut" },
      { id: "paste", label: "Paste" },
    ]);
    flushNextFrame();

    expect(queryButtonByText("Cut")).toBeDefined();
    dismissContextMenu();

    const result = await pending;
    expect(result).toBeNull();
    expect(queryButtonByText("Cut")).toBeUndefined();
  });

  it("terminates an existing session when a subsequent menu is displayed", async () => {
    const sessionA = showContextMenuFallback([{ id: "opt-a", label: "Option A" }]);
    flushNextFrame();
    expect(queryButtonByText("Option A")).toBeDefined();

    const sessionB = showContextMenuFallback([{ id: "opt-b", label: "Option B" }]);
    flushNextFrame();

    await expect(sessionA).resolves.toBeNull();
    expect(queryButtonByText("Option A")).toBeUndefined();
    expect(queryButtonByText("Option B")).toBeDefined();

    dismissContextMenu();
    await expect(sessionB).resolves.toBeNull();
  });
});

describe("showContextMenuFallback", () => {
  it("resolves chosen action id on button click once armed", async () => {
    const task = showContextMenuFallback([
      { id: "duplicate", label: "Duplicate" },
      { id: "remove", label: "Remove", destructive: true },
    ]);

    const target = queryButtonByText("Duplicate")!;
    expect(target).toBeDefined();

    // Click before RAF arming does not trigger finish
    target.click();

    flushNextFrame();
    target.click();

    const chosen = await task;
    expect(chosen).toBe("duplicate");
  });

  it("renders headers and separators correctly between sections", async () => {
    const menuPromise = showContextMenuFallback([
      { id: "h1", label: "Section One", header: true },
      { id: "item1", label: "Action 1" },
      { id: "item2", label: "Action 2", separatorBefore: true },
    ]);
    flushNextFrame();

    const separators = testDoc.body
      .querySelectorAll("div")
      .filter((el) => el.dataset.contextMenuSeparator === "true");
    expect(separators).toHaveLength(1);
    expect(separators[0]?.getAttribute("role")).toBe("separator");

    dismissContextMenu();
    await menuPromise;
  });

  it("opens submenus on hover and allows selecting nested options", async () => {
    const task = showContextMenuFallback([
      {
        id: "export-menu",
        label: "Export As",
        children: [
          { id: "fmt-pdf", label: "PDF Document" },
          { id: "fmt-png", label: "PNG Image" },
        ],
      },
    ]);
    flushNextFrame();

    const parentBtn = queryButtonByText("Export As")!;
    expect(parentBtn.getAttribute("aria-haspopup")).toBe("menu");
    expect(parentBtn.getAttribute("aria-expanded")).toBe("false");

    // Mouseenter opens child submenu
    parentBtn.dispatchEvent(new SimEvent("mouseenter"));
    expect(parentBtn.getAttribute("aria-expanded")).toBe("true");

    const pdfBtn = queryButtonByText("PDF Document");
    expect(pdfBtn).toBeDefined();

    pdfBtn?.click();
    const result = await task;
    expect(result).toBe("fmt-pdf");
  });

  it("supports keyboard arrow navigation across items", async () => {
    const task = showContextMenuFallback([
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
      { id: "gamma", label: "Gamma" },
    ]);
    flushNextFrame();

    emitDocKey("ArrowDown");
    expect(testDoc.activeElement).toBe(queryButtonByText("Alpha"));

    emitDocKey("ArrowDown");
    expect(testDoc.activeElement).toBe(queryButtonByText("Beta"));

    emitDocKey("ArrowDown");
    expect(testDoc.activeElement).toBe(queryButtonByText("Gamma"));

    // Cycle back to beginning
    emitDocKey("ArrowDown");
    expect(testDoc.activeElement).toBe(queryButtonByText("Alpha"));

    // Arrow up moves backward
    emitDocKey("ArrowUp");
    expect(testDoc.activeElement).toBe(queryButtonByText("Gamma"));

    emitDocKey("Escape");
    await expect(task).resolves.toBeNull();
  });

  it("closes submenus hierarchically upon pressing Escape", async () => {
    const task = showContextMenuFallback([
      {
        id: "share-opts",
        label: "Share",
        children: [{ id: "copy-url", label: "Copy Link" }],
      },
    ]);
    flushNextFrame();

    const trigger = queryButtonByText("Share")!;
    trigger.click(); // opens submenu with focusFirst

    expect(queryButtonByText("Copy Link")).toBeDefined();
    expect(testDoc.activeElement).toBe(queryButtonByText("Copy Link"));

    // First escape closes submenu, refocuses trigger
    emitDocKey("Escape");
    expect(queryButtonByText("Copy Link")).toBeUndefined();
    expect(testDoc.activeElement).toBe(trigger);

    // Second escape dismisses root menu
    emitDocKey("Escape");
    const res = await task;
    expect(res).toBeNull();
  });

  it("returns focus to the previously active element when dismissed", async () => {
    const previousElement = testDoc.createElement("button");
    testDoc.body.appendChild(previousElement);
    previousElement.focus();
    expect(testDoc.activeElement).toBe(previousElement);

    const menuTask = showContextMenuFallback([{ id: "sample", label: "Sample" }]);
    flushNextFrame();

    emitDocKey("ArrowDown");
    expect(testDoc.activeElement).toBe(queryButtonByText("Sample"));

    emitDocKey("Escape");
    await menuTask;

    expect(testDoc.activeElement).toBe(previousElement);
  });
});
