import { describe, expect, it } from "vite-plus/test";

import * as Links from "./links.ts";

describe("file paths in inline code", () => {
  it.each([
    // Paths, normalised only for relative backslashes.
    ["lib\\util.ts", "lib/util.ts"],
    ["D:\\Data\\photo.jpg", "D:\\Data\\photo.jpg"],
    ["\\\\nas\\pub\\photo.jpg", "\\\\nas\\pub\\photo.jpg"],
    ["sites.d/app.conf", "sites.d/app.conf"],
    ["build.rb:7", "build.rb:7"],
    // Code, prose, branches and hosts are not paths.
    ["node.meta", null],
    ["Saved the capture to /var/out/shot.png", null],
    ["upstream/dev", null],
    ["10.0.0.2:8080", null],
    ["example.org/page.html", null],
    ["example.pl/page.html", null],
  ])("%s → %s", (code, candidate) => {
    expect(Links.inlineCodeFilePathCandidate(code)).toBe(candidate);
  });
});

describe("file: URLs", () => {
  it.each([
    ["file:///home/ana/app/lib/index.ts#L7", "/home/ana/app/lib/index.ts", "#L7"],
    ["file:///E:/Work/kora/Panel.tsx#L12", "E:/Work/kora/Panel.tsx", "#L12"],
    ["file://nas/pub/diagram.svg", "\\\\nas\\pub\\diagram.svg", ""],
    ["file://localhost/srv/notes.txt", "/srv/notes.txt", ""],
  ])("splits %s into path and hash", (href, path, hash) => {
    expect(Links.parseFileUrlHref(href)).toEqual({ path, hash });
  });

  it("leaves percent escapes for the caller to decode exactly once", () => {
    expect(Links.parseFileUrlHref("file:///home/ana/app/my%2520file.txt")?.path).toBe(
      "/home/ana/app/my%2520file.txt",
    );
    expect(Links.parseFileUrlHref("file:///e%3A/Work/pic.png")?.path).toBe("/e%3A/Work/pic.png");
  });

  it.each(["https://example.org/x.ts", "file://%", "/home/ana/x.ts"])("refuses %s", (href) => {
    expect(Links.parseFileUrlHref(href)).toBeNull();
  });
});

describe("line and column positions", () => {
  const file = "lib/index.ts";
  it.each([
    ["", "", {}],
    [":7", "", { line: 7 }],
    [":7:3", "", { line: 7, column: 3 }],
    ["", "#L21C4", { line: 21, column: 4 }],
    // A suffix wins over the anchor, and drops the anchor's column.
    [":2", "#L21C4", { line: 2 }],
    [":0", "", {}],
    ["", "#intro", {}],
  ])("reads %s%s", (suffix, hash, position) => {
    expect(Links.splitFilePathPosition(`${file}${suffix}`, hash)).toEqual({
      path: file,
      ...position,
    });
  });
});

describe("markdown file links", () => {
  // Web and mobile both use this table, so they agree on what is a file.
  it.each([
    ["/home/ana/app/CLAUDE.md", "/home/ana/app/CLAUDE.md"],
    ["/srv/www/index.html", "/srv/www/index.html"],
    ["/opt/tools/bin/run", "/opt/tools/bin/run"],
    ["/app/Makefile", "/app/Makefile"],
    ["/var/cache/icons/", "/var/cache/icons/"],
    ["E:\\Work\\app\\lib\\index.ts", "E:\\Work\\app\\lib\\index.ts"],
    ["E:%5Capp%5Cpic.png", "E:\\app\\pic.png"],
    ["\\\\nas\\pub\\pic.png", "\\\\nas\\pub\\pic.png"],
    ["/E:/Work/kora/Panel.tsx", "E:/Work/kora/Panel.tsx"],
    ["</E:/Work/kora/Reply.tsx:3>", "E:/Work/kora/Reply.tsx"],
    ["file:///home/ana/app/my%2520file.txt", "/home/ana/app/my%20file.txt"],
    ["file://nas/pub/diagram.svg", "\\\\nas\\pub\\diagram.svg"],
    ["file://localhost/srv/notes.txt", "/srv/notes.txt"],
    ["packages/core/src/main.ts:4", "packages/core/src/main.ts"],
    ["docs/Team%20Notes/plan.xml", "docs/Team Notes/plan.xml"],
    ["Release%20checklist%20v2.md", "Release checklist v2.md"],
    ["./bin/setup", "./bin/setup"],
    ["~/drafts/idea.md", "~/drafts/idea.md"],
    ["CLAUDE.md", "CLAUDE.md"],
    ["util.ts:4", "util.ts"],
    ["/var/tmp/take%23two.mov#t=5", "/var/tmp/take#two.mov"],
  ])("treats %s as the file %s", (href, path) => {
    expect(Links.parseMarkdownFileLink(href)?.path).toBe(path);
  });

  it.each([
    "",
    "#top",
    "//media.test/take.mov",
    "https://example.org/guide",
    "mailto:dev@example.org",
    "javascript:void(0)",
    "/code/settings",
    "/code/settings#L9",
    "/blobs#L2",
    "changelog",
    "FIXME:3",
  ])("does not treat %j as a file", (href) => {
    expect(Links.parseMarkdownFileLink(href)).toBeNull();
  });

  it("accepts well-known extensionless names, with a position or not", () => {
    expect(Links.parseMarkdownFileLink("Makefile")).toEqual({ path: "Makefile" });
    expect(Links.parseMarkdownFileLink("Dockerfile:3")).toEqual({ path: "Dockerfile", line: 3 });
    expect(Links.parseMarkdownFileLink("/opt/build/Makefile")).toEqual({
      path: "/opt/build/Makefile",
    });
  });

  it("takes positions from line anchors on plain and file: links", () => {
    expect(Links.parseMarkdownFileLink("/home/ana/app/lib/index.ts#L9C2")).toEqual({
      path: "/home/ana/app/lib/index.ts",
      column: 2,
      line: 9,
    });
    expect(Links.parseMarkdownFileLink("file://nas/pub/lib/index.ts#L9C2")).toMatchObject({
      path: "\\\\nas\\pub\\lib\\index.ts",
      column: 2,
      line: 9,
    });
  });
});

describe("file base names", () => {
  it.each([
    ["/var/cache/icons/", "icons"],
    ["D:\\Profiles\\ana\\.config\\", ".config"],
    ["/var/", "var"],
    ["CLAUDE.md", "CLAUDE.md"],
    ["/", "/"],
  ])("%s → %s", (path, name) => {
    expect(Links.fileBasename(path)).toBe(name);
  });
});

describe("paths relative to the workspace", () => {
  it.each([
    // Inside the root, trailing slash or not, any Windows spelling.
    ["/srv/app/lib/main.ts", "/srv/app", "lib/main.ts"],
    ["/srv/app/lib/main.ts", "/srv/app/", "lib/main.ts"],
    ["E:\\Work\\kora\\apps\\ui\\x.ts", "E:/Work/kora", "apps/ui/x.ts"],
    ["/E:/Work/kora/apps/ui/x.ts", "E:/Work/kora", "apps/ui/x.ts"],
    // POSIX roots compare case-sensitively.
    ["/Srv/App/lib/main.ts", "/srv/app", null],
    ["/var/tmp/case/app/probe.txt", "/var/tmp/case/App", null],
    ["//var/tmp/case/app/probe.txt", "//var/tmp/case/App", null],
    ["/var/tmp/case/App/probe.txt", "/var/tmp/case/App", "probe.txt"],
    // Drive and UNC roots compare case-insensitively.
    ["E:/WORK/ana/kora/x.ts", "e:/work/ANA/kora", "x.ts"],
    ["/E:/WORK/ana/kora/x.ts", "/e:/work/ANA/kora", "x.ts"],
    ["\\\\nas\\pub\\APP\\x.ts", "\\\\Nas\\Pub\\App", "x.ts"],
    // Filesystem and drive roots.
    ["/var/repo/x.ts", "/", "var/repo/x.ts"],
    ["E:/Work/ANA/x.ts", "e:/", "Work/ANA/x.ts"],
    ["\\\\nas\\PUB\\x.ts", "\\\\Nas\\Pub\\", "x.ts"],
    // Whitespace in the path is kept.
    ["/var/repo/x.ts ", "/var/repo", "x.ts "],
    // Outside, a sibling with a common prefix, or no root.
    ["/var/other.ts", "/srv/app", null],
    ["/srv/app-old/x.ts", "/srv/app", null],
    ["/srv/app/x.ts", undefined, null],
  ])("%s under %s → %s", (path, root, relative) => {
    expect(Links.workspaceRelativeFilePath(path, root)).toBe(relative);
  });
});
