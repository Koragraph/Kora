import { resolveMarkdownMediaPreview } from "./ExpandedImageView";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

describe("resolveMarkdownMediaPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["https:", "https:"],
    ["http:", "http:"],
    ["kora-dev:", "https:"],
    ["kora:", "https:"],
  ])(
    "resolves protocol-relative media on %s without changing its source",
    (pageProtocol, mediaProtocol) => {
      vi.stubGlobal("window", { location: { protocol: pageProtocol } });
      const source = "//cdn.example.com/recording.mp4?token=a%2FB&v=1#t=2";
      const preview = resolveMarkdownMediaPreview({ source });

      expect(preview?.images[0]).toMatchObject({
        actionsSource: {
          reference: { kind: "url", url: source },
          src: `${mediaProtocol}${source}`,
        },
        originalUrl: source,
        src: `${mediaProtocol}${source}`,
      });
    },
  );
});
