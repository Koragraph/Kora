import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { showBootError } from "./util/bootError";

/** The smallest DOM the boot-error screen needs: nodes that hold children and text and receive events. */
class FakeNode extends EventTarget {
  textContent = "";
  children: FakeNode[] = [];
  setAttribute(): void {}
  constructor(readonly tagName: string) {
    super();
  }
  append(child: FakeNode) {
    this.children.push(child);
  }
  replaceChildren(...next: FakeNode[]) {
    this.children = next;
  }
  /** All text in this subtree, depth first. */
  get allText(): string {
    return [this.textContent, ...this.children.map((child) => child.allText)].join(" ");
  }
}

let splashRoot: FakeNode | null;

beforeEach(() => {
  vi.resetModules();
  splashRoot = new FakeNode("div");
  vi.stubGlobal("document", {
    getElementById: () => splashRoot,
    createElement: (tag: string) => new FakeNode(tag),
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("./main");
  vi.restoreAllMocks();
});

describe("boot failure handling in ./startup", () => {
  it("puts the error from a rejected startup promise on the splash", async () => {
    vi.doMock("./main", () => ({ startup: Promise.reject(new Error("bundle fetch failed")) }));

    await import("./startup");
    await vi.dynamicImportSettled();

    expect(splashRoot?.allText).toContain("bundle fetch failed");
  });

  it("replaces the splash even when ./main throws on import, and Reload reloads the page", async () => {
    vi.doMock("./main", () => {
      throw new Error("react refresh preamble missing");
    });
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });

    await import("./startup");
    await vi.dynamicImportSettled();

    expect(splashRoot?.allText).toContain("Kora could not load.");
    const reloadButton = splashRoot?.children[0]?.children.find((c) => c.tagName === "button");
    expect(reloadButton?.allText).toBe("Reload");
    reloadButton?.dispatchEvent(new Event("click"));
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("showBootError", () => {
  it.each([
    [true, "shows"],
    [false, "hides"],
  ])("with DEV=%s %s the underlying message", (dev) => {
    vi.stubEnv("DEV", dev);

    showBootError(new Error("private module path"));

    expect(splashRoot?.allText).toContain("Kora could not load.");
    expect(splashRoot?.allText.includes("private module path")).toBe(dev);
  });

  it("does nothing once React has already removed the splash", () => {
    splashRoot = null;
    const createSpy = vi.spyOn(document, "createElement");

    showBootError(new Error("too late"));

    expect(createSpy).not.toHaveBeenCalled();
  });
});
