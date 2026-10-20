import { describe, expect, it } from "vite-plus/test";

import {
  PICK_CONTEXT_LIMITS,
  PICK_MAIN_WORLD_GLOBAL_NAME,
  buildMainWorldContextScript,
  buildMainWorldInstallScript,
  createPickToken,
  isPickToken,
  parseMainWorldElementContext,
  pickMainWorldKey,
  projectElementContext,
} from "./PickMainWorldProtocol.ts";

const fixedRandom = (bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  bytes.forEach((_, index) => {
    bytes[index] = (index * 37 + 11) % 256;
  });
  return bytes;
};

describe("pick tokens and keys", () => {
  it("creates lowercase alphanumeric tokens the main world accepts", () => {
    const token = createPickToken(fixedRandom);
    expect(token).toMatch(/^[a-z0-9]{32}$/);
    expect(isPickToken(token)).toBe(true);
    expect(pickMainWorldKey(token)).toBe(`__koraPick_${token}`);
  });

  it("refuses anything that could break out of the generated script", () => {
    for (const bad of ['a"]);alert(1)//', "ABCDEFGHIJKLMNOPQRSTU", "short", "", 42, null]) {
      expect(isPickToken(bad)).toBe(false);
    }
    expect(() => pickMainWorldKey('x");evil("')).toThrow();
    expect(() => buildMainWorldContextScript("__koraPick_ok", "a".repeat(32))).toThrow();
    expect(() =>
      buildMainWorldContextScript(`__koraPick_${"a".repeat(32)}`, '"+alert(1)+"'),
    ).toThrow();
    expect(() => buildMainWorldInstallScript("void 0", "window.top")).toThrow();
  });
});

describe("main-world scripts", () => {
  const token = createPickToken(fixedRandom);
  const key = pickMainWorldKey(token);

  it("install script keeps the bundle's var local and passes only the key", () => {
    const script = buildMainWorldInstallScript(
      `var ${PICK_MAIN_WORLD_GLOBAL_NAME}={install:function(k){globalThis.installedWith=k}};`,
      key,
    );
    const sandbox: Record<string, unknown> = {};
    new Function("globalThis", script)(sandbox);
    expect(sandbox["installedWith"]).toBe(key);
    expect(sandbox[PICK_MAIN_WORLD_GLOBAL_NAME]).toBeUndefined();
  });

  it("context script calls the reader with the token, or yields null when absent", async () => {
    const script = buildMainWorldContextScript(key, token);
    const run = (scope: Record<string, unknown>): unknown =>
      new Function("globalThis", `return ${script}`)(scope);
    expect(run({})).toBeNull();
    const seen: unknown[] = [];
    const result = run({ [key]: (value: unknown) => (seen.push(value), "ok") });
    expect(result).toBe("ok");
    expect(seen).toEqual([token]);
  });
});

describe("parseMainWorldElementContext", () => {
  it("accepts the projected shape", () => {
    const raw = JSON.stringify(
      projectElementContext({
        selector: "#save",
        htmlPreview: "<button>Save</button>",
        componentName: "SaveButton",
        styles: "color: red;",
        stack: [{ functionName: "SaveButton", fileName: "/src/Save.tsx", lineNumber: 4 }],
      }),
    );
    expect(parseMainWorldElementContext(raw)).toEqual({
      selector: "#save",
      htmlPreview: "<button>Save</button>",
      componentName: "SaveButton",
      styles: "color: red;",
      stack: [
        {
          functionName: "SaveButton",
          fileName: "/src/Save.tsx",
          lineNumber: 4,
          columnNumber: null,
        },
      ],
    });
  });

  it("rejects non-strings, non-JSON, arrays and oversize answers", () => {
    expect(parseMainWorldElementContext(null)).toBeNull();
    expect(parseMainWorldElementContext({ selector: "#x" })).toBeNull();
    expect(parseMainWorldElementContext("not json")).toBeNull();
    expect(parseMainWorldElementContext("[]")).toBeNull();
    expect(parseMainWorldElementContext("null")).toBeNull();
    expect(
      parseMainWorldElementContext(`"${"x".repeat(PICK_CONTEXT_LIMITS.rawChars + 1)}"`),
    ).toBeNull();
  });

  it("drops unknown keys, coerces wrong types and caps every string", () => {
    const parsed = parseMainWorldElementContext(
      JSON.stringify({
        selector: 7,
        componentName: "C".repeat(PICK_CONTEXT_LIMITS.shortChars + 50),
        htmlPreview: { toString: "nope" },
        styles: "s".repeat(PICK_CONTEXT_LIMITS.stylesChars + 1),
        stack: [
          "frame",
          { functionName: 1, fileName: "/a.ts", lineNumber: "3", columnNumber: 2 },
          ...Array.from({ length: PICK_CONTEXT_LIMITS.stackFrames + 10 }, () => ({})),
        ],
        __proto__: { polluted: true },
        ipc: "send",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.selector).toBeNull();
    expect(parsed?.componentName?.length).toBe(PICK_CONTEXT_LIMITS.shortChars);
    expect(parsed?.htmlPreview).toBe("");
    expect(parsed?.styles.length).toBe(PICK_CONTEXT_LIMITS.stylesChars);
    expect(parsed?.stack[0]).toEqual({
      functionName: null,
      fileName: "/a.ts",
      lineNumber: null,
      columnNumber: 2,
    });
    expect(parsed?.stack.length).toBeLessThanOrEqual(PICK_CONTEXT_LIMITS.stackFrames);
    expect(Object.keys(parsed ?? {}).toSorted()).toEqual(
      ["componentName", "htmlPreview", "selector", "stack", "styles"].toSorted(),
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
