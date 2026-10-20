import { editorLabelForPlatform, openInEditorMenuLabel } from "./editorLabels";
import { describe, expect, it } from "vite-plus/test";

describe("openInEditorMenuLabel", () => {
  it("keeps the generic label for the default file handler and missing preferences", () => {
    expect(openInEditorMenuLabel("file-manager")).toBe("Open in editor");
    expect(openInEditorMenuLabel(null)).toBe("Open in editor");
  });
  it("names the preferred editor", () => {
    expect(openInEditorMenuLabel("zed")).toBe("Open in Zed");
  });
});

describe("editorLabelForPlatform", () => {
  it.each([
    ["Linux x86_64", "Files"],
    ["Win32", "File Explorer"],
    ["MacIntel", "Finder"],
  ])("uses the platform file-manager name on %s", (platform, label) => {
    expect(editorLabelForPlatform("file-manager", platform)).toBe(label);
  });
  it("uses the editor name from the shared editor definitions", () => {
    expect(editorLabelForPlatform("cursor", "MacIntel")).toBe("Cursor");
    expect(editorLabelForPlatform("vscode-insiders", "Win32")).toBe("VS Code Insiders");
  });
});
