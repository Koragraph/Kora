import type { PickedNodePayload } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { elementContextToWebMarkup, normalizeElementContextSelection } from "./elementContext";

const frame = (fileName: string, lineNumber: number | null, functionName = "Fn") => ({
  fileName,
  lineNumber,
  columnNumber: null,
  functionName,
});

function pick(over: Partial<PickedNodePayload> = {}): PickedNodePayload {
  return {
    pageUrl: "https://shop.test/cart",
    pageTitle: "Cart",
    tagName: "A",
    selector: "a.buy",
    htmlPreview: '<a class="buy">Go</a>',
    componentName: "BuyLink",
    source: frame("/app/Buy.tsx", 8, "BuyLink"),
    stack: [frame("/app/Buy.tsx", 8, "BuyLink")],
    styles: ".buy { color: teal; }",
    pickedAt: "2026-07-01T10:00:00.000Z",
    ...over,
  };
}

describe("normalizeElementContextSelection", () => {
  test.each([
    ["an empty page url", { pageUrl: "" }],
    ["a blank tag", { tagName: "  \t" }],
  ])("rejects %s", (_label, over) => {
    expect(normalizeElementContextSelection(pick(over))).toBeNull();
  });

  test("trims text, lowercases the tag and turns blank optional strings into null", () => {
    const out = normalizeElementContextSelection(
      pick({
        tagName: "  Section ",
        pageUrl: "  https://shop.test ",
        pageTitle: "  Home ",
        selector: "   ",
        componentName: "",
      }),
    );
    expect(out).toMatchObject({
      tagName: "section",
      pageUrl: "https://shop.test",
      pageTitle: "Home",
      selector: null,
      componentName: null,
    });
  });

  test("the explicit source wins over the stack, and its strings are trimmed", () => {
    const out = normalizeElementContextSelection(
      pick({
        source: {
          fileName: " /app/Outer.tsx ",
          functionName: " Outer ",
          lineNumber: 7,
          columnNumber: 0,
        },
        stack: [frame("/app/Inner.tsx", 99)],
      }),
    );
    expect(out?.source).toEqual({
      fileName: "/app/Outer.tsx",
      functionName: "Outer",
      lineNumber: 7,
      columnNumber: 0,
    });
  });

  test("with no source the first stack frame stands in", () => {
    const out = normalizeElementContextSelection(
      pick({ source: null, stack: [frame("/app/FromStack.tsx", 3, "FromStack"), frame("/x", 1)] }),
    );
    expect(out?.source).toEqual({
      fileName: "/app/FromStack.tsx",
      functionName: "FromStack",
      lineNumber: 3,
      columnNumber: null,
    });
  });

  test("with neither source nor stack the location is null", () => {
    expect(normalizeElementContextSelection(pick({ source: null, stack: [] }))?.source).toBeNull();
  });

  test("CRLF in the markup and styles becomes LF", () => {
    const out = normalizeElementContextSelection(
      pick({ htmlPreview: "<p>\r\nx\r\n</p>", styles: "p {\r\n a: b;\r\n}" }),
    );
    expect([out?.htmlPreview, out?.styles]).toEqual(["<p>\nx\n</p>", "p {\n a: b;\n}"]);
  });

  test("huge markup and styles are cut to 4000 characters and end with an ellipsis", () => {
    const blob = "z".repeat(20_000);
    const out = normalizeElementContextSelection(pick({ htmlPreview: blob, styles: blob }))!;
    for (const text of [out.htmlPreview, out.styles]) {
      expect(text.length).toBeLessThanOrEqual(4000);
      expect(text.endsWith("…")).toBe(true);
    }
  });
});

describe("elementContextToWebMarkup", () => {
  test("wraps a saved pick as a one-element annotation with an empty comment", () => {
    const selection = normalizeElementContextSelection(pick())!;
    const markup = elementContextToWebMarkup(selection, "el-5", "2026-07-02T00:00:00.000Z");

    expect(markup).toMatchObject({
      id: "el-5",
      comment: "",
      createdAt: "2026-07-02T00:00:00.000Z",
      pageUrl: "https://shop.test/cart",
      pageTitle: "Cart",
      screenshot: null,
      strokes: [],
      regions: [],
      styleChanges: [],
    });
    expect(markup.elements).toHaveLength(1);
    expect(markup.elements[0]).toMatchObject({
      id: "el-5",
      element: { tagName: "a", stack: [], pickedAt: "2026-07-02T00:00:00.000Z" },
    });
  });
});
