import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import { bundlePickMainWorld } from "../../scripts/pick-main-world-plugin.ts";
import {
  PICK_TARGET_ATTRIBUTE,
  buildMainWorldContextScript,
  buildMainWorldInstallScript,
  pickMainWorldKey,
} from "./PickMainWorldProtocol.ts";

const TOKEN = "a".repeat(32);

/** Just enough of a page for react-grab's module-load side effects and the reader's lookup. */
function createFakePage() {
  const queries: string[] = [];
  class FakeDocument {
    createElement() {
      return { style: {}, setAttribute() {}, appendChild() {} };
    }
    querySelector(selector: string) {
      queries.push(selector);
      return null;
    }
  }
  const document = new FakeDocument();
  const page: Record<string, unknown> = {
    document,
    Document: FakeDocument,
    navigator: { userAgent: "test" },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    console,
  };
  for (const name of [
    "Window",
    "Node",
    "Element",
    "HTMLElement",
    "SVGElement",
    "Text",
    "Comment",
    "DocumentFragment",
    "ShadowRoot",
    "MutationObserver",
    "Event",
    "CustomEvent",
  ]) {
    // oxlint-disable-next-line typescript/no-extraneous-class -- stand-ins for DOM constructors the bundle references.
    page[name] = class {};
  }
  page["window"] = page;
  page["self"] = page;
  return { context: NodeVM.createContext(page), queries };
}

describe("picker main-world bundle", () => {
  it("is self-contained and carries no Kora/Electron capability", async () => {
    const { code } = await bundlePickMainWorld();
    expect(code.length).toBeGreaterThan(1_000);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toContain("ipcRenderer");
    expect(code).not.toContain("shellBridge");
    expect(code).not.toContain("electron");
  }, 60_000);

  it("installs one locked, non-enumerable reader that only answers well-formed tokens", async () => {
    const { code } = await bundlePickMainWorld();
    const { context, queries } = createFakePage();
    const key = pickMainWorldKey(TOKEN);
    NodeVM.runInContext(buildMainWorldInstallScript(code, key), context);

    const descriptor = NodeVM.runInContext(
      `Object.getOwnPropertyDescriptor(globalThis, ${JSON.stringify(key)})`,
      context,
    ) as PropertyDescriptor | undefined;
    expect(typeof descriptor?.value).toBe("function");
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(descriptor?.enumerable).toBe(false);
    // react-grab's DevTools hook is in place as soon as the script ran (document
    // start), so the page's React registers with it when it boots.
    expect(NodeVM.runInContext("typeof globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__", context)).toBe(
      "object",
    );
    // The bundle's own var stays local to the install script.
    expect(NodeVM.runInContext("typeof __koraPickMainWorld", context)).toBe("undefined");

    // The page cannot swap the reader out.
    NodeVM.runInContext(
      `try { globalThis[${JSON.stringify(key)}] = () => "forged" } catch {}`,
      context,
    );
    const answer = await NodeVM.runInContext(buildMainWorldContextScript(key, TOKEN), context);
    expect(answer).toBeNull(); // no tagged element on the fake page
    expect(queries).toEqual([`[${PICK_TARGET_ATTRIBUTE}="${TOKEN}"]`]);

    const malformed = await NodeVM.runInContext(
      `globalThis[${JSON.stringify(key)}]('"] , *, [x="')`,
      context,
    );
    expect(malformed).toBeNull();
    expect(queries).toHaveLength(1);
  }, 60_000);
});
