import { describe, expect, it } from "vite-plus/test";

import { mediaFileReference, mediaReferenceFileName } from "./reference.ts";

describe("media file references", () => {
  const cases: Array<[string, string, string | undefined]> = [
    // POSIX: normalised, case-sensitive, a backslash is an ordinary character.
    ["/srv/app/./assets/../demo.webm", "/srv/app/", "demo.webm"],
    ["/srv/app/../escape.webm", "/srv/app", undefined],
    ["/srv/app-two/demo.webm", "/srv/app", undefined],
    ["/srv/App/demo.webm", "/srv/app", undefined],
    ["/srv/app/x\\y.webm", "/srv/app", "x\\y.webm"],
    ["/srv/demo.webm", "/srv/elsewhere/..", "demo.webm"],
    ["/demo.webm", "/", "demo.webm"],
    // Windows drives and UNC shares compare case-insensitively.
    ["E:\\SRV\\app\\assets\\..\\Demo.webm", "e:/srv/app/", "Demo.webm"],
    ["F:\\srv\\demo.webm", "E:\\srv", undefined],
    ["\\\\Nas\\Media\\App\\Demo.webm", "//nas/media/app", "Demo.webm"],
    ["\\\\nas\\other\\demo.webm", "\\\\nas\\media", undefined],
    // A relative path is never inside anything.
    ["../demo.webm", "/srv/app", undefined],
  ];

  it.each(cases)(
    "keeps %s verbatim and relates it to %s only when inside",
    (path, root, relativePath) => {
      const reference = mediaFileReference(path, root);
      expect(reference).toEqual(
        relativePath === undefined ? { kind: "file", path } : { kind: "file", path, relativePath },
      );
    },
  );
});

describe("media file names", () => {
  it.each([
    // POSIX paths split on "/" only and are not decoded.
    [{ kind: "file", path: "/var/clips/cut\\a%20.webm" }, "cut\\a%20.webm"],
    // Windows-looking paths split on either separator.
    [{ kind: "file", path: "E:\\clips/cut\\a.webm" }, "a.webm"],
    [{ kind: "file", path: "\\\\nas\\media\\a.webm" }, "a.webm"],
    // URLs: decoded once, without query or fragment; a bad escape leaves the name raw.
    [{ kind: "url", url: "//media.test/take%20two%2Ewebm?token=x+y#t=9" }, "take two.webm"],
    [{ kind: "url", url: "https://media.test/take%2520.webm" }, "take%20.webm"],
    [{ kind: "url", url: "https://media.test/take%20%zz.webm" }, "take%20%zz.webm"],
  ] as const)("names %j as %s", (reference, name) => {
    expect(mediaReferenceFileName(reference)).toBe(name);
  });
});
