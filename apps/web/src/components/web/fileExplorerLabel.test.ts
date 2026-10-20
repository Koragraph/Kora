import {
  revealInFileExplorerLabelForOs,
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabel,
} from "./fileExplorerLabel";
import { describe, expect, it } from "vite-plus/test";

describe("revealInFileExplorerLabelForKind", () => {
  it.each([
    ["files", "Reveal in Files"],
    ["file-explorer", "Reveal in File Explorer"],
    ["finder", "Reveal in Finder"],
  ] as const)("maps %s to %s", (kind, expected) => {
    expect(revealInFileExplorerLabelForKind(kind)).toBe(expected);
  });
});

describe("revealInFileExplorerLabelForOs", () => {
  it.each([
    ["unknown", "Reveal in Files"],
    ["linux", "Reveal in Files"],
    ["windows", "Reveal in File Explorer"],
    ["darwin", "Reveal in Finder"],
  ] as const)("maps %s to %s", (os, expected) => {
    expect(revealInFileExplorerLabelForOs(os)).toBe(expected);
  });
});

describe("revealInFileExplorerLabel", () => {
  it.each([
    ["Linux x86_64", "Reveal in Files"],
    ["Win32", "Reveal in File Explorer"],
    ["MacIntel", "Reveal in Finder"],
  ])("maps %s to %s", (platform, expected) => {
    expect(revealInFileExplorerLabel(platform)).toBe(expected);
  });
});
