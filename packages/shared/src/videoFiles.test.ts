import { describe, expect, it } from "vite-plus/test";

import { videoMimeType } from "./videoFiles.ts";

const typed = (name: string, mimeType = "application/octet-stream") =>
  videoMimeType({ name, mimeType });

describe("video detection", () => {
  it("falls back to the extension, case-insensitively, when the picker gave a generic type", () => {
    expect(typed("Clip.MKV")).toBe("video/x-matroska");
    expect(typed("screen.mov")).toBe("video/quicktime");
  });

  it("trusts a declared video type, normalised and stripped of parameters", () => {
    expect(typed("clip.mov", "  Video/MP4 ;codecs=avc1 ")).toBe("video/mp4");
  });

  it("does not let the extension override a definite non-video type", () => {
    for (const declared of ["text/plain", "image/jpeg"]) {
      expect(typed("clip.webm", declared)).toBeNull();
    }
  });

  it.each(["Makefile", "notes.txt", "x.hasOwnProperty", "x.toString", "x.__proto__"])(
    "returns null for %s",
    (name) => {
      expect(typed(name)).toBeNull();
    },
  );
});
