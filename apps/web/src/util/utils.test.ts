import {
  exampleProjectPath,
  folderAccessHint,
  getLocalFileManagerName,
  isWindowsPlatform,
  pastePathHint,
  terminalAppName,
  thisComputer,
  yourComputer,
} from "./utils";
import { describe, assert, it } from "vite-plus/test";

describe("isWindowsPlatform", () => {
  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });
});

describe("getLocalFileManagerName", () => {
  it.each([
    ["Linux", "Files"],
    ["Win32", "File Explorer"],
    ["MacIntel", "Finder"],
  ])("uses the %s file manager name", (platform, expected) => {
    assert.strictEqual(getLocalFileManagerName(platform), expected);
  });
});

describe("platform copy", () => {
  it("keeps the Mac wording on a Mac", () => {
    assert.equal(thisComputer("MacIntel"), "this Mac");
    assert.equal(yourComputer("MacIntel"), "your Mac");
    assert.equal(terminalAppName("MacIntel"), "Terminal");
    assert.equal(exampleProjectPath("MacIntel"), "/Users/you/Projects/app");
    assert.equal(pastePathHint("MacIntel"), "Paste it in Finder with Cmd+Shift+G.");
    assert.match(folderAccessHint("MacIntel"), /^Give your user access in Finder → Get Info/);
  });
  it("speaks Windows on Windows", () => {
    assert.equal(thisComputer("Win32"), "this PC");
    assert.equal(yourComputer("Win32"), "your PC");
    assert.equal(terminalAppName("Win32"), "PowerShell");
    assert.equal(exampleProjectPath("Win32"), "C:\\Users\\you\\Projects\\app");
    assert.match(pastePathHint("Win32"), /File Explorer/);
    assert.match(folderAccessHint("Win32"), /Properties → Security/);
    assert.notMatch(folderAccessHint("Win32"), /Finder|System Settings/);
  });
  it("stays neutral elsewhere", () => {
    assert.equal(thisComputer("Linux x86_64"), "this computer");
    assert.equal(terminalAppName("Linux x86_64"), "a terminal");
  });
});
