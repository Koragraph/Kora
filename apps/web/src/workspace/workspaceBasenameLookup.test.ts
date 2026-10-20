import { describe, expect, test } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
} from "./workspaceBasenameLookup";

const file = (path: string) => ({ path, kind: "file" as const });
const folder = (path: string) => ({ path, kind: "directory" as const });

describe("claimWorkspaceBasenameLookup", () => {
  test("a lone claim stays valid", () => {
    expect(claimWorkspaceBasenameLookup()()).toBe(true);
  });

  test("only the newest claim is valid, whichever lookup answers first", () => {
    const older = claimWorkspaceBasenameLookup();
    const newer = claimWorkspaceBasenameLookup();
    expect(newer()).toBe(true);
    expect(older()).toBe(false);
  });
});

describe("pickWorkspaceBasenameMatch", () => {
  const view = [file("src/ui/View.test.tsx"), file("src/ui/View.tsx")];

  test("no candidates, or none with that name, gives null", () => {
    expect(pickWorkspaceBasenameMatch("View.tsx", [])).toBeNull();
    expect(pickWorkspaceBasenameMatch("View.tsx", [file("src/Other.tsx")])).toBeNull();
  });

  test("the first exact file-name match wins", () => {
    expect(pickWorkspaceBasenameMatch("View.tsx", view)).toBe("src/ui/View.tsx");
  });

  test("a different casing is accepted when it is unambiguous", () => {
    expect(pickWorkspaceBasenameMatch("view.tsx", view)).toBe("src/ui/View.tsx");
  });

  test("an exactly-cased file beats a twin that differs only in case", () => {
    const twins = [file("src/Foo.ts"), file("src/foo.ts")];
    expect(pickWorkspaceBasenameMatch("foo.ts", twins)).toBe("src/foo.ts");
  });

  test("two case-only candidates with no exact match are ambiguous", () => {
    expect(
      pickWorkspaceBasenameMatch("FOO.ts", [file("src/Foo.ts"), file("src/foo.ts")]),
    ).toBeNull();
  });

  test("directories never match", () => {
    expect(
      pickWorkspaceBasenameMatch("widgets", [folder("src/widgets"), file("src/widgets/widgets")]),
    ).toBe("src/widgets/widgets");
  });
});

describe("needsWorkspaceBasenameLookup", () => {
  test.each([
    ["View.tsx", true],
    ["Makefile", true],
    ["src/ui/View.tsx", false],
    ["src\\ui\\View.tsx", false],
    ["   ", false],
  ])("%j -> %s", (input, needs) => {
    expect(needsWorkspaceBasenameLookup(input)).toBe(needs);
  });
});
