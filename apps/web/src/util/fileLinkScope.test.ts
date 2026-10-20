import { describe, expect, it } from "vite-plus/test";

import { fileLinkOutsideFolder } from "./fileLinkScope";

describe("fileLinkOutsideFolder (pl4 S3-8)", () => {
  it("lets links inside the thread folder open directly", () => {
    expect(fileLinkOutsideFolder("src/a.ts", "/r/app")).toBe(false);
    expect(fileLinkOutsideFolder("/r/app/src/a.ts", "/r/app/")).toBe(false);
  });
  it("asks for anything outside it", () => {
    expect(fileLinkOutsideFolder("/etc/hosts", "/r/app")).toBe(true);
    expect(fileLinkOutsideFolder("~/.ssh/id_ed25519", "/r/app")).toBe(true);
    expect(fileLinkOutsideFolder("../other/x", "/r/app")).toBe(true);
    expect(fileLinkOutsideFolder("/r/app-other/x", "/r/app")).toBe(true);
    expect(fileLinkOutsideFolder("/etc/hosts", undefined)).toBe(true);
  });
  it("Windows: either separator, case-folded; a drive path is never relative", () => {
    expect(fileLinkOutsideFolder("src\\a.ts", "C:\\r\\app")).toBe(false);
    expect(fileLinkOutsideFolder("C:\\R\\App\\src\\a.ts", "c:/r/app/")).toBe(false);
    expect(fileLinkOutsideFolder("/C:/r/app/src/a.ts", "C:\\r\\app")).toBe(false);
    expect(fileLinkOutsideFolder("C:\\Users\\me\\notes.txt", "C:\\r\\app")).toBe(true);
    expect(fileLinkOutsideFolder("D:\\r\\app\\x", "C:\\r\\app")).toBe(true);
    expect(fileLinkOutsideFolder("C:\\r\\app-other\\x", "C:\\r\\app")).toBe(true);
    expect(fileLinkOutsideFolder("..\\other\\x", "C:\\r\\app")).toBe(true);
    expect(fileLinkOutsideFolder("\\\\srv\\share\\x", "C:\\r\\app")).toBe(true);
    expect(fileLinkOutsideFolder("~/x", "C:\\r\\app")).toBe(true);
    expect(fileLinkOutsideFolder("C:\\x", undefined)).toBe(true);
    expect(fileLinkOutsideFolder("C:\\Users\\me\\x", "/r/app")).toBe(true);
  });
});
