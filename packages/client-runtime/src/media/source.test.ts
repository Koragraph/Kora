import { ThreadId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMediaSource } from "./source.ts";

const THREAD = ThreadId.make("th-media");
const ROOT = "/srv/site";
const resolve = (href: string, extra: Partial<Parameters<typeof resolveMediaSource>[1]> = {}) =>
  resolveMediaSource(href, { threadId: THREAD, ...extra });

/** What a file the host serves resolves to. */
const hostFile = (path: string, kind: "image" | "video", mimeType: string, extra: object = {}) => ({
  kind,
  mimeType,
  access: "environment",
  srcFragment: "",
  name: path.split(/[\\/]/).at(-1),
  reference: { kind: "file", path },
  resource: { _tag: "media-file", threadId: THREAD, path },
  ...extra,
});

describe("media sources", () => {
  describe("URLs the client loads itself", () => {
    it("keeps the URL as written and decodes the name exactly once", () => {
      const href = "https://media.test/take%20two%2520%2Ewebm?sig=x%2fy#t=4";
      expect(resolve(href)).toEqual({
        access: "direct",
        uri: href,
        reference: { kind: "url", url: href },
        kind: "video",
        mimeType: "video/webm",
        name: "take two%20.webm",
        srcFragment: "#t=4",
      });
    });

    it("leaves a protocol-relative URL for the client to complete", () => {
      const href = "//media.test/take.webm?sig=2#t=1";
      expect(resolve(href)).toMatchObject({
        access: "direct",
        uri: href,
        reference: { kind: "url", url: href },
      });
    });

    it("accepts a URL without an extension only as an image embed", () => {
      const href = "https://media.test/thumbnail?id=7";
      expect(resolve(href)).toBeNull();
      expect(resolve(href, { imageEmbed: true })).toMatchObject({
        kind: "image",
        mimeType: "image/*",
        name: "thumbnail",
      });
    });

    it.each(["data:image/gif;base64,R0lG", "blob:https://app.kora.dev/blob-1"])(
      "loads %s as is",
      (href) => {
        expect(resolve(href, { imageEmbed: true })).toMatchObject({ access: "direct", uri: href });
      },
    );
  });

  describe("files on the host", () => {
    // Every path spelling must reach the same media-file resource.
    it.each([
      ["/var/shots/pic%23a.png:3", "/var/shots/pic#a.png"],
      ["/var/shots/pic%3Fa.png:3:9", "/var/shots/pic?a.png"],
      ["/var/shots/pic%2523a.png:3", "/var/shots/pic%23a.png"],
      ["D:\\Shots\\pic.png", "D:\\Shots\\pic.png"],
      ["/D:/Shots/pic.png", "D:/Shots/pic.png"],
      ["file:///D:/Shots/pic.png", "D:/Shots/pic.png"],
      ["file://nas/pub/pic.png", "\\\\nas\\pub\\pic.png"],
      ["\\\\nas\\pub\\pic.png", "\\\\nas\\pub\\pic.png"],
    ])("serves %s as %s", (href, path) => {
      expect(resolve(href, { workspaceRoot: ROOT })).toEqual(hostFile(path, "image", "image/png"));
    });

    it("joins a relative path to the workspace and remembers it was relative", () => {
      const path = `${ROOT}/art/badge.svg`;
      expect(resolve("art/badge.svg?v=3#icon", { workspaceRoot: ROOT })).toEqual(
        hostFile(path, "image", "image/svg+xml", {
          srcFragment: "#icon",
          reference: { kind: "file", path, relativePath: "art/badge.svg" },
        }),
      );
    });

    it("trusts a path the caller already resolved", () => {
      const resolved = resolve("badge.svg", {
        workspaceRoot: ROOT,
        resolvedFilePath: `${ROOT}/docs/badge.svg`,
      });
      expect(resolved).toMatchObject({
        access: "environment",
        reference: { relativePath: "docs/badge.svg" },
        resource: { _tag: "media-file", path: `${ROOT}/docs/badge.svg` },
      });
    });

    it("tells a playback fragment apart from # in the file name", () => {
      expect(resolve("/var/clips/a%23b.webm#t=6")).toMatchObject({
        kind: "video",
        srcFragment: "#t=6",
        resource: { path: "/var/clips/a#b.webm" },
      });
    });

    it("is unavailable without a thread to serve it through", () => {
      expect(resolveMediaSource("/var/clips/a.webm", { threadId: undefined })).toMatchObject({
        kind: "video",
        access: "unavailable",
      });
    });

    it.each(["readme.txt", `${ROOT}/LICENSE`, `${ROOT}/bundle.tar`])(
      "ignores the non-media file %s",
      (href) => {
        expect(resolve(href, { workspaceRoot: ROOT })).toBeNull();
      },
    );

    it("serves a Kora attachment from where it is stored", () => {
      const stored =
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-webm";
      const path = `/home/ana/.kora/userdata/attachments/${stored}.webm`;
      expect(resolve(path, { workspaceRoot: ROOT })).toMatchObject({
        kind: "video",
        access: "environment",
        resource: { _tag: "media-file", threadId: THREAD, path },
      });
    });
  });
});
