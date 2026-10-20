import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ReplyMarkdown", () => ({
  default: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
}));

import { formatReportBytes, SwarmReportPanel } from "./SwarmReportView";

const noop = () => undefined;

describe("SwarmReportPanel", () => {
  it("renders the report markdown with Back to terminal and Copy", () => {
    const html = renderToStaticMarkup(
      <SwarmReportPanel
        paneId="p7"
        report={{ text: "## Status\ndone", truncated: false, updatedAt: 1 }}
        pending={false}
        error={null}
        onClose={noop}
      />,
    );
    expect(html).toContain("Back to terminal");
    expect(html).toContain("Copy");
    expect(html).toContain('data-testid="md"');
    expect(html).toContain("## Status");
    expect(html).toContain("Report · p7");
    expect(html).not.toContain("truncated");
  });

  it("says when the report was truncated", () => {
    const html = renderToStaticMarkup(
      <SwarmReportPanel
        paneId="p7"
        report={{ text: "x", truncated: true, updatedAt: 1 }}
        pending={false}
        error={null}
        onClose={noop}
      />,
    );
    expect(html).toContain("truncated");
  });

  it("pending, error and empty states", () => {
    const base = { paneId: "p7", report: null, onClose: noop } as const;
    expect(renderToStaticMarkup(<SwarmReportPanel {...base} pending error={null} />)).toContain(
      "Reading the report",
    );
    expect(
      renderToStaticMarkup(<SwarmReportPanel {...base} pending={false} error="worker not found" />),
    ).toContain("worker not found");
    expect(
      renderToStaticMarkup(<SwarmReportPanel {...base} pending={false} error={null} />),
    ).toContain("No report yet");
  });

  it("formats sizes for the tile button", () => {
    expect(formatReportBytes(512)).toBe("512 B");
    expect(formatReportBytes(2150)).toBe("2.1 KB");
    expect(formatReportBytes(2048)).toBe("2 KB");
  });
});
