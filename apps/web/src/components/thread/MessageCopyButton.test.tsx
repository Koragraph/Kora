import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MessageCopyButton } from "./MessageCopyButton";

describe("MessageCopyButton", () => {
  it("names the button after what it copies", () => {
    const html = renderToStaticMarkup(<MessageCopyButton text="hello" label="Copy message" />);
    expect(html).toContain('aria-label="Copy message"');
    expect(html).not.toContain("Copy link");
  });

  it("falls back to a generic label, never 'Copy link'", () => {
    const html = renderToStaticMarkup(<MessageCopyButton text="hello" />);
    expect(html).toContain('aria-label="Copy to clipboard"');
  });
});
