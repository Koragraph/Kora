import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { EffortSlosh } from "./EffortSlosh";

const LEVELS = ["minimal", "low", "medium", "high", "xhigh"].map((id) => ({
  id,
  label: id === "xhigh" ? "Extra High" : id[0]!.toUpperCase() + id.slice(1),
  ...(id === "medium" ? { isDefault: true } : {}),
}));

describe("EffortSlosh", () => {
  it("is a slider with one section per level, filled up to the chosen one", () => {
    const html = renderToStaticMarkup(
      <EffortSlosh levels={LEVELS} onChange={() => {}} value="high" />,
    );
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuetext="High"');
    expect(html).toContain('aria-valuenow="4"');
    expect(html.match(/data-effort-section/g)).toHaveLength(5);
    expect(html.match(/data-on="true"/g)).toHaveLength(4);
    // five sections: short names in the track, the full name and its meaning above it
    expect(html).toContain(">XHigh<");
    expect(html).toContain("tricky changes, real bugs");
  });

  it("says why it is locked and shows no level when the prompt owns it", () => {
    const html = renderToStaticMarkup(
      <EffortSlosh
        disabled
        levels={LEVELS}
        note="Ultrathink is on from the prompt"
        onChange={() => {}}
        value={null}
      />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Not set");
    expect(html).toContain("Ultrathink is on from the prompt");
    expect(html).not.toContain('data-on="true"');
  });
});
