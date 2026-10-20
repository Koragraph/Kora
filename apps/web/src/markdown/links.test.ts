import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import {
  shouldOpenMarkdownFileLinkInEditor,
  shouldOpenMarkdownFileLinkInBrowserByDefault,
  rewriteMarkdownFileUriHref,
  resolveMarkdownFileLinkTarget,
  resolveMarkdownFileLinkMeta,
  resolveInlineCodeFileLinkMeta,
  isWindowsDrivePathHref,
  extractMarkdownLinkHrefs,
} from "./links";

const WORKSPACE = "/srv/dev/project";

/** The href react-markdown passes to the `a` component for a given markdown source. */
function parsedHref(markdown: string): string | undefined {
  const hrefs: Array<string | undefined> = [];
  const anchorRenderer: Components["a"] = ({ href }) => {
    hrefs.push(href);
    return createElement("a", { href });
  };
  renderToStaticMarkup(
    createElement(ReactMarkdown, { components: { a: anchorRenderer } }, markdown),
  );
  return hrefs[0];
}

describe("isWindowsDrivePathHref", () => {
  it.each([
    ["https://example.org/p.png", false],
    ["/usr/local/bin/tool", false],
    ["E:%5Cdocs%5Cp.png", true],
    ["E:\\docs\\p.png", true],
    ["e:/docs/p.png", true],
  ])("%s -> %s", (href, expected) => {
    expect(isWindowsDrivePathHref(href)).toBe(expected);
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it.each([
    [
      "a file URI with an encoded drive colon",
      "file:///d%3A/Work/img.png",
      undefined,
      "d:/Work/img.png",
    ],
    [
      "an angle-bracketed drive path",
      "</F:/code/site/src/b.tsx:2>",
      undefined,
      "F:/code/site/src/b.tsx:2",
    ],
    [
      "a slash-led drive path with #L",
      "/F:/code/site/src/b.tsx#L70",
      undefined,
      "F:/code/site/src/b.tsx:70",
    ],
    ["an encoded trailing space", "/var/proj/item.ts%20", "/var/proj", "/var/proj/item.ts "],
    ["a localhost file URI", "file://localhost/home/kim/todo.md", undefined, "/home/kim/todo.md"],
    [
      "a file URI whose authority is a UNC host",
      "file://nas/share/art.svg",
      undefined,
      "\\\\nas\\share\\art.svg",
    ],
    [
      "a double-encoded percent (decoded once)",
      "file:///u/kim/my%2520file.md",
      undefined,
      "/u/kim/my%20file.md",
    ],
    [
      "an #L hash with a column",
      `${WORKSPACE}/src/app.ts#L9C3`,
      undefined,
      `${WORKSPACE}/src/app.ts:9:3`,
    ],
    ["a bare name under the workspace", "README.md", WORKSPACE, `${WORKSPACE}/README.md`],
    ["a name with a line suffix", "tool.ts:4", WORKSPACE, `${WORKSPACE}/tool.ts:4`],
    [
      "a relative path with a line suffix",
      "src/exec.ts:88",
      WORKSPACE,
      `${WORKSPACE}/src/exec.ts:88`,
    ],
    [
      "an absolute path with no workspace",
      `${WORKSPACE}/README.md`,
      undefined,
      `${WORKSPACE}/README.md`,
    ],
  ])("resolves %s", (_label, href, workspace, expected) => {
    expect(resolveMarkdownFileLinkTarget(href, workspace)).toBe(expected);
  });

  it.each([
    ["a web-app route", "/app/preferences", undefined],
    ["a web-app route with a line hash", "/app/preferences#L3", "/repo"],
    ["an https URL", "https://example.org/guide", undefined],
    ["a protocol-relative URL", "//static.example.org/movie.mp4", "/workspace"],
    ["an empty string", "", WORKSPACE],
    ["undefined", undefined, WORKSPACE],
    ["a relative name with no base directory", "notes.md", undefined],
  ])("does not treat %s as a file link", (_label, href, workspace) => {
    expect(resolveMarkdownFileLinkTarget(href, workspace)).toBeNull();
  });
});

describe("relative links resolve against the containing file's directory", () => {
  it("lands outside the workspace when the document lives elsewhere", () => {
    expect(resolveMarkdownFileLinkMeta("extra.md", "/repo", "/scratch/doc")).toMatchObject({
      workspaceRelativePath: null,
      filePath: "/scratch/doc/extra.md",
    });
    expect(resolveInlineCodeFileLinkMeta("Makefile:9", "/repo", "/scratch/doc")).toMatchObject({
      filePath: "/scratch/doc/Makefile",
      line: 9,
    });
  });

  it("keeps the sub-folder in the workspace-relative path inside the workspace", () => {
    expect(resolveMarkdownFileLinkMeta("src/entry.ts", "/repo", "/repo/notes")).toMatchObject({
      workspaceRelativePath: "notes/src/entry.ts",
      filePath: "/repo/notes/src/entry.ts",
    });
  });
});

describe("link labels", () => {
  it.each([
    ["/opt/", "opt"],
    ["/opt/lib/", "lib"],
    ["/opt/lib", "lib"],
    ["E:\\Users\\kim\\.config\\", ".config"],
  ])("%s is labelled %s", (input, label) => {
    expect(resolveMarkdownFileLinkMeta(input, WORKSPACE)?.basename).toBe(label);
  });

  it("never labels the filesystem root with an empty string", () => {
    expect(resolveMarkdownFileLinkMeta("/", WORKSPACE)?.basename).not.toBe("");
  });
});

describe("workspace-relative and display paths", () => {
  it.each([
    ["/var/proj/item.ts%20", "/var/proj", "item.ts "],
    ["\\\\Nas\\DATA\\item.ts", "\\\\nas\\data\\", "item.ts"],
    ["D:/People/KIM/item.ts", "d:/", "People/KIM/item.ts"],
    ["/var/proj/item.ts", "/", "var/proj/item.ts"],
  ])("%s inside %s is %s", (href, workspace, relative) => {
    expect(resolveMarkdownFileLinkMeta(href, workspace)?.workspaceRelativePath).toBe(relative);
  });

  it("ignores case for UNC paths", () => {
    expect(
      resolveMarkdownFileLinkMeta("\\\\nas\\data\\TEAM\\lib\\z.ts", "\\\\Nas\\Data\\Team"),
    ).toMatchObject({ workspaceRelativePath: "lib/z.ts", displayPath: "Team/lib/z.ts" });
  });

  it("ignores case for drive paths", () => {
    expect(
      resolveMarkdownFileLinkMeta("D:/People/KIM/Team/lib/z.ts", "d:/people/kim/team"),
    ).toMatchObject({ workspaceRelativePath: "lib/z.ts", displayPath: "team/lib/z.ts" });
  });

  it("respects case for POSIX paths", () => {
    expect(
      resolveMarkdownFileLinkMeta("/tmp/mixed/team/probe.txt", "/tmp/mixed/Team"),
    ).toMatchObject({ workspaceRelativePath: null, displayPath: "/tmp/mixed/team/probe.txt" });
  });

  it("has no relative path for a file outside the workspace", () => {
    expect(
      resolveMarkdownFileLinkMeta("/tmp/other.ts", "/repo/project")?.workspaceRelativePath,
    ).toBeNull();
  });

  it("starts the display path at the workspace folder's name and carries line numbers", () => {
    expect(
      resolveMarkdownFileLinkMeta("/F:/dev/kora/apps/web/x/y.tsx", "F:/dev/kora"),
    ).toMatchObject({
      workspaceRelativePath: "apps/web/x/y.tsx",
      displayPath: "kora/apps/web/x/y.tsx",
    });
    expect(
      resolveMarkdownFileLinkMeta("file:///F:/dev/kora/apps/web/util.ts#L77", "F:/dev/kora"),
    ).toMatchObject({
      workspaceRelativePath: "apps/web/util.ts",
      displayPath: "kora/apps/web/util.ts:77",
    });
  });
});

describe("inline code treated as a file reference", () => {
  const lookup = (code: string, workspace: string | null = WORKSPACE) =>
    resolveInlineCodeFileLinkMeta(code, workspace ?? undefined);

  it.each([
    ["a relative path with no workspace", "guide/intro.md", null],
    ["an external URL", "https://example.org/page.html", null],
    ["a git ref", "origin/release", WORKSPACE],
    ["a directory", "packages/core", WORKSPACE],
    ["a shell command", "git status --short --branch", null],
    ["a property access", "obj.field", WORKSPACE],
    ["two words", "npm ci", WORKSPACE],
    ["a glob", "lib/**/*.js", WORKSPACE],
    ["a bare name with no line number", "CHANGELOG.md", WORKSPACE],
    ["an absolute route-like path with no workspace", "/app/preferences", null],
    ["an IP with a port", "10.1.2.3:8080", WORKSPACE],
    ["localhost with a port", "localhost:8080", WORKSPACE],
    ["a domain with a port", "example.org:9090", WORKSPACE],
    ["a domain with a path", "example.org/home.html", WORKSPACE],
    ["a country-code domain with a path", "example.de/home.html", WORKSPACE],
    ["another country-like domain", "example.pl/home.html", WORKSPACE],
    ["localhost with a path", "localhost/home.html", WORKSPACE],
    ["two ports", "10.1.2.3:80:5", WORKSPACE],
    ["word:number", "fail:7", WORKSPACE],
    ["UPPER:number", "FIXME:30", WORKSPACE],
    ["exit:code", "exit:2", WORKSPACE],
    ["port:number", "port:8080", WORKSPACE],
    ["scheme:port", "https:443", WORKSPACE],
    ["an extensionless name with a line but no workspace", "Makefile:9", null],
  ])("rejects %s", (_label, code, workspace) => {
    expect(lookup(code, workspace)).toBeNull();
  });

  it.each([
    "run.ts:12",
    "src/boot.sh:5",
    "Makefile.in:9",
    "conf.d/site.conf",
    "net.pt:5",
    "run.pl:12",
  ])("accepts %s, since a TLD-like extension does not make it a host", (code) => {
    expect(lookup(code)).not.toBeNull();
  });

  it("puts a line suffix in the target path", () => {
    expect(lookup("run.pl:12")).toMatchObject({ line: 12, targetPath: `${WORKSPACE}/run.pl:12` });
    expect(lookup("src/worker.ts:33")).toMatchObject({
      line: 33,
      targetPath: `${WORKSPACE}/src/worker.ts:33`,
    });
  });

  it("reads line and column from an extensionless filename", () => {
    expect(lookup("Makefile:9")).toMatchObject({ line: 9, basename: "Makefile" });
    expect(lookup("Dockerfile:6:4")).toMatchObject({ line: 6, column: 4 });
  });

  it("normalises backslashes in relative paths", () => {
    expect(lookup("src\\entry.ts")).toMatchObject({
      basename: "entry.ts",
      targetPath: `${WORKSPACE}/src/entry.ts`,
    });
    expect(lookup(".\\bin\\release")).toMatchObject({ basename: "release" });
    expect(lookup("./bin/release")).toMatchObject({ basename: "release" });
  });

  it("needs no workspace for absolute paths", () => {
    expect(lookup("D:\\proj\\src\\entry.ts", null)).toMatchObject({ basename: "entry.ts" });
    expect(lookup("/opt/bin/start", null)).toMatchObject({ targetPath: "/opt/bin/start" });
    expect(lookup("/work/Makefile", null)).toMatchObject({ basename: "Makefile" });
  });

  it("resolves a relative path with an extension under the workspace", () => {
    expect(lookup("docs/design/overview.md")).toMatchObject({
      basename: "overview.md",
      targetPath: `${WORKSPACE}/docs/design/overview.md`,
    });
  });
});

describe("spaces that react-markdown percent-encodes", () => {
  it.each(["md", "html", "xml"])("handles an angle-bracketed name with spaces (.%s)", (ext) => {
    const href = parsedHref(`[x](<Launch checklist.${ext}>)`);
    expect(href).toBe(`Launch%20checklist.${ext}`);
    expect(resolveMarkdownFileLinkMeta(href, "/repo/project")).toMatchObject({
      basename: `Launch checklist.${ext}`,
      workspaceRelativePath: `Launch checklist.${ext}`,
      targetPath: `/repo/project/Launch checklist.${ext}`,
    });
  });

  it("handles a spaced folder under the workspace", () => {
    const href = parsedHref("[x](<notes/Old Drafts>)");
    expect(href).toBe("notes/Old%20Drafts");
    expect(resolveMarkdownFileLinkMeta(href, "/repo/project")).toMatchObject({
      basename: "Old Drafts",
      workspaceRelativePath: "notes/Old Drafts",
      targetPath: "/repo/project/notes/Old Drafts",
    });
  });

  it("matches an absolute path against a workspace containing the same spaces", () => {
    expect(
      resolveMarkdownFileLinkMeta("/Users/kim/Scratch%20Pad/Old%20Scans", "/Users/kim/Scratch Pad"),
    ).toMatchObject({
      basename: "Old Scans",
      workspaceRelativePath: "Old Scans",
      targetPath: "/Users/kim/Scratch Pad/Old Scans",
    });
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it.each([
    [
      "strips angle brackets and padding",
      " <file:///F:/code/site/src/ln.ts> ",
      "F:/code/site/src/ln.ts",
    ],
    ["drops a localhost authority", "file://localhost/home/kim/todo.md", "/home/kim/todo.md"],
    [
      "turns another authority into a UNC path",
      "file://nas/share/art.svg",
      "\\\\nas\\share\\art.svg",
    ],
    ["keeps the hash on a drive path", "file:///F:/code/Menu.tsx#L70", "F:/code/Menu.tsx#L70"],
    ["leaves encoded octets as they are", "file:///u/kim/my%2520file.md", "/u/kim/my%2520file.md"],
    ["handles a plain POSIX path", "file:///u/kim/src/app.ts#L9", "/u/kim/src/app.ts#L9"],
  ])("%s", (_label, input, expected) => {
    expect(rewriteMarkdownFileUriHref(input)).toBe(expected);
  });

  it.each([undefined, "", "https://example.org", "/plain/path"])("returns null for %j", (input) => {
    expect(rewriteMarkdownFileUriHref(input)).toBeNull();
  });
});

describe("how a link opens", () => {
  it.each([
    ["slides.pdf", true],
    ["slides.PDF?download=1", true],
    ["slides.pdf#page=4", true],
    ["slides.html", false],
    ["slides.pdf.txt", false],
  ])("opens %s in the browser by default: %s", (target, expected) => {
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault(target)).toBe(expected);
  });

  it.each([
    ["MacIntel", { metaKey: true, ctrlKey: false }, true],
    ["MacIntel", { metaKey: false, ctrlKey: true }, false],
    ["Linux x86_64", { metaKey: false, ctrlKey: true }, true],
    ["Linux x86_64", { metaKey: true, ctrlKey: false }, false],
  ])("on %s the modifiers %j open the editor: %s", (platform, keys, expected) => {
    expect(shouldOpenMarkdownFileLinkInEditor(keys, platform)).toBe(expected);
  });
});

describe("extractMarkdownLinkHrefs", () => {
  it("lists destinations in order without their titles", () => {
    expect(
      extractMarkdownLinkHrefs(
        "[a](lib/a.ts \"title\") then [b](https://example.org) and [c](y.md 'tip')",
      ),
    ).toEqual(["lib/a.ts", "https://example.org", "y.md"]);
  });

  it("allows spaces inside angle brackets", () => {
    expect(extractMarkdownLinkHrefs("[go](</Users/kim/Scratch Pad/Old Scans>)")).toEqual([
      "/Users/kim/Scratch Pad/Old Scans",
    ]);
  });

  it("returns nothing for empty destinations or plain text", () => {
    expect(extractMarkdownLinkHrefs("nothing here, [blank]() neither")).toEqual([]);
  });
});
