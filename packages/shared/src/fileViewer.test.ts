import { describe, expect, it } from "vite-plus/test";

import { isWorkspaceVideoPreviewPath, mediaKindFromPath } from "./fileViewer.ts";

describe("media kind from a path or URL", () => {
  const cases: Array<[string, "image" | "video" | null]> = [
    // URLs: only the decoded pathname counts, never the query, hash or host.
    ["https://media.test/v/intro.mp4?dl=0#t=5", "video"],
    ["https://media.test/get?file=intro.webm", null],
    ["https://photo.jpg", null],
    // Percent-escapes are decoded once.
    ["shots%2Fhome%2Ejpg", "image"],
    ["shots/home%23draft.jpg", "image"],
    ["shots/home.jpg%23notes.md", null],
    ["shots/home.jpg%3Fnotes.md", null],
    // A stray % that is not an escape is kept.
    ["/var/tmp/50%.gif", "image"],
  ];

  it.each(cases)("%s → %s", (source, kind) => {
    expect(mediaKindFromPath(source)).toBe(kind);
  });
});

describe("authored URL vs literal workspace filename", () => {
  it("reads ?/# as URL syntax for media kind but as filename characters for previews", () => {
    const table = [
      { source: "demo.mov#t=1", kind: "video", literal: false },
      { source: "demo%2Emov", kind: "video", literal: false },
      { source: "demo#cut1.mov", kind: null, literal: true },
      { source: "demo?cut1.mov", kind: null, literal: true },
    ];
    for (const { source, kind, literal } of table) {
      expect([mediaKindFromPath(source), isWorkspaceVideoPreviewPath(source)], source).toEqual([
        kind,
        literal,
      ]);
    }
  });
});
