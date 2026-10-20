import { describe, expect, it } from "vite-plus/test";

import { classifyMarkdownImageSource, markdownImageSourceFragment } from "./images.ts";

const ROOT = "/srv/site";
const WIN_ROOT = "D:\\Users\\ana\\site";

describe("markdown image sources", () => {
  it.each([
    "https://img.test/a.png",
    "HTTPS://img.test/a.png",
    "data:image/gif;base64,R0lGOD",
    "blob:https://app.kora.dev/0f3c",
    "//cdn.img.test/a.png",
  ])("loads %s directly", (uri) => {
    expect(classifyMarkdownImageSource(uri, ROOT)).toEqual({ _tag: "Direct", uri });
  });

  const file = (path: string) => ({ _tag: "WorkspaceFile", path });

  it.each([
    // Relative to the workspace root, joined with the root's own separator.
    ["shots/a.png", ROOT, `${ROOT}/shots/a.png`],
    ["./shots/a.png", ROOT, `${ROOT}/./shots/a.png`],
    ["shots/a.png", WIN_ROOT, `${WIN_ROOT}\\shots\\a.png`],
    ["shots\\a.png", WIN_ROOT, `${WIN_ROOT}\\shots\\a.png`],
    // Absolute paths need no root.
    [`${ROOT}/a.png`, null, `${ROOT}/a.png`],
    ["/D:/Users/ana/site/a.png", null, "D:/Users/ana/site/a.png"],
    ["D:/Users/ana/site/a.png", null, "D:/Users/ana/site/a.png"],
    ["\\\\nas\\pub\\a.png", null, "\\\\nas\\pub\\a.png"],
    // file: URLs, decoded.
    ["file:///srv/site/my%20pic.png", null, "/srv/site/my pic.png"],
    ["file:///D:/Users/ana/site/a.png", null, "D:/Users/ana/site/a.png"],
    ["file://localhost/D:/Users/ana/site/a.png", null, "D:/Users/ana/site/a.png"],
    ["file://nas/pub/a.png", null, "\\\\nas\\pub\\a.png"],
  ])("reads %s (root %s) from the workspace at %s", (source, root, path) => {
    expect(classifyMarkdownImageSource(source, root)).toEqual(file(path));
  });

  it.each([
    null,
    "",
    "#frag",
    "?q=1",
    "a.png",
    "~/a.png",
    "javascript:void(0)",
    "ftp://img.test/a.png",
    "content://media/external/9",
    "app:a.png",
    "file://%",
  ])("blocks %j without a workspace root", (source) => {
    expect(classifyMarkdownImageSource(source)).toEqual({ _tag: "Blocked" });
  });

  it("keeps an SVG fragment, but not the query", () => {
    expect(markdownImageSourceFragment("<sprite.svg?v=3#star>")).toBe("#star");
    expect(markdownImageSourceFragment("sprite.svg?v=3")).toBe("");
  });
});
