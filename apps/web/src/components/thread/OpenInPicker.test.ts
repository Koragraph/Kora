import { FolderClosedIcon } from "lucide-react";
import { describe, expect, test } from "vite-plus/test";

import { FileExplorerIcon, FinderIcon } from "../BrandIcons";
import { resolveOpenInOptions } from "./OpenInPicker";

describe("resolveOpenInOptions", () => {
  test("without the file-manager capability (or with no editors at all) it is left out", () => {
    expect(resolveOpenInOptions("MacIntel", ["vscode"])).toEqual([
      expect.objectContaining({ value: "vscode" }),
    ]);
    expect(resolveOpenInOptions("MacIntel", [])).toEqual([]);
  });

  test.each([
    ["Linux x86_64", "Files", FolderClosedIcon],
    ["Win32", "File Explorer", FileExplorerIcon],
    ["MacIntel", "Finder", FinderIcon],
  ] as const)(
    "on %s the file manager is called %s and listed after the editors",
    (platform, label, Icon) => {
      expect(resolveOpenInOptions(platform, ["cursor", "vscode", "file-manager"])).toEqual([
        expect.objectContaining({ value: "cursor", label: "Cursor" }),
        expect.objectContaining({ value: "vscode", label: "VS Code" }),
        expect.objectContaining({ value: "file-manager", label, Icon }),
      ]);
    },
  );
});
