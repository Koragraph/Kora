import { describe, expect, it } from "vite-plus/test";

import { isPickedNodePayload, isWebMarkupPayload } from "./PickedNodePayload.ts";

// These guards are the main process's only check on what a preview page's preload sends back, so every field
// a page could get wrong is tried once.

const where = {
  functionName: "Checkout",
  fileName: "/app/src/Checkout.tsx",
  lineNumber: 41,
  columnNumber: 9,
};
const unknownWhere = { functionName: null, fileName: null, lineNumber: null, columnNumber: null };

const picked = {
  pickedAt: "2026-10-19T08:30:00.000Z",
  pageUrl: "http://localhost:3000/cart",
  pageTitle: "Cart",
  tagName: "a",
  selector: "nav > a.cart",
  componentName: "Checkout",
  htmlPreview: '<a class="cart">Cart</a>',
  styles: "a.cart { font-weight: 600 }",
  source: where,
  stack: [where, unknownWhere],
};

/** `base` with `key` replaced (`undefined` removes it). */
const changed = (base: object, key: string, value: unknown) => {
  const copy: Record<string, unknown> = { ...base };
  if (value === undefined) delete copy[key];
  else copy[key] = value;
  return copy;
};

describe("a picked element", () => {
  it.each([
    ["as sent", picked],
    [
      "with every optional text unknown",
      { ...picked, pageTitle: null, selector: null, componentName: null },
    ],
    ["with no source location", { ...picked, source: null }],
    ["with an empty or all-unknown stack", { ...picked, stack: [] }],
  ])("is accepted %s", (_, payload) => expect(isPickedNodePayload(payload)).toBe(true));

  it.each<[string, string, unknown]>([
    ...["pageUrl", "tagName", "htmlPreview", "styles", "pickedAt"].map(
      (k): [string, string, unknown] => [`without ${k}`, k, undefined],
    ),
    ...["pageUrl", "pageTitle", "selector", "componentName"].map((k): [string, string, unknown] => [
      `with a number for ${k}`,
      k,
      7,
    ]),
    ["with a stack that is not a list", "stack", "frames"],
    ["with a stack frame of the wrong shape", "stack", [{ file: "x" }]],
    [
      "with a source whose function name is a number",
      "source",
      { ...unknownWhere, functionName: 1 },
    ],
    ["with an infinite line number", "source", { ...unknownWhere, lineNumber: Infinity }],
    ["with a NaN line number", "source", { ...unknownWhere, lineNumber: NaN }],
  ])("is refused %s", (_, key, value) => {
    expect(isPickedNodePayload(changed(picked, key, value))).toBe(false);
  });

  it.each([null, undefined, "a", 0, [], true])("is refused when it is %j", (value) => {
    expect(isPickedNodePayload(value)).toBe(false);
  });
});

describe("a markup draft (comment, boxes and pen strokes drawn on a preview)", () => {
  const box = { x: 0, y: 0, width: 50, height: 20 };
  const draft = {
    id: "m1",
    createdAt: "2026-10-19T08:31:00.000Z",
    pageUrl: picked.pageUrl,
    pageTitle: picked.pageTitle,
    comment: "Cart link should be bolder",
    elements: [{ id: "e1", element: picked, rect: box }],
    regions: [{ id: "r1", rect: { ...box, x: 60 } }],
    strokes: [
      {
        id: "s1",
        color: "#f2f2f4",
        width: 3,
        points: [
          { x: 1, y: 1 },
          { x: 9, y: 4 },
        ],
        bounds: { x: 1, y: 1, width: 8, height: 3 },
      },
    ],
    styleChanges: [
      {
        targetId: "e1",
        selector: "nav > a.cart",
        property: "font-weight",
        previousValue: "400",
        value: "600",
      },
    ],
    screenshot: null,
  };

  it("is accepted before the shell has taken its screenshot", () => {
    expect(isWebMarkupPayload(draft)).toBe(true);
  });

  it.each([
    [
      "it brings its own screenshot (only the shell takes those)",
      "screenshot",
      { dataUrl: "data:," },
    ],
    ["a region's size is not a number", "regions", [{ id: "r1", rect: { ...box, width: "big" } }]],
    [
      "an element is not a valid picked element",
      "elements",
      [{ id: "e1", element: {}, rect: box }],
    ],
  ])("is refused when %s", (_, key, value) => {
    expect(isWebMarkupPayload(changed(draft, key, value))).toBe(false);
  });
});
