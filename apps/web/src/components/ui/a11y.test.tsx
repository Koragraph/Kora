import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Switch } from "./switch";

describe("icon button hit targets", () => {
  // Compact icon buttons keep their visible size but grow an invisible hit area to 28px.
  it.each([
    ["icon-tiny", "after:-inset-1.5"],
    ["icon-micro", "after:-inset-1"],
    ["icon-xs", "sm:after:-inset-0.5"],
  ] as const)("%s reaches 28px", (size, inset) => {
    const markup = renderToStaticMarkup(
      <Button size={size} aria-label="Close">
        x
      </Button>,
    );
    expect(markup).toContain(inset);
    expect(markup).toContain('aria-label="Close"');
    expect(markup).toContain('type="button"');
  });

  it("keeps a visible keyboard focus ring on every variant", () => {
    const markup = renderToStaticMarkup(<Button variant="ghost">Go</Button>);
    expect(markup).toContain("focus-visible:ring-ring");
  });
});

describe("checked controls", () => {
  // Checked state uses its own token so a palette can set it apart from primary (a white primary would vanish).
  it("switches and checkboxes fill with the checked-control token, not primary", () => {
    const markup = renderToStaticMarkup(
      <>
        <Switch defaultChecked aria-label="Enable" />
        <Checkbox defaultChecked aria-label="Enable" />
      </>,
    );
    expect(markup).toContain("data-checked:bg-control-checked");
    expect(markup).not.toMatch(/data-checked:bg-primary\b/);
  });
});
