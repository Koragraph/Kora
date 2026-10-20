import type { FC, PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: PropsWithChildren) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("../ui/dialog", () => {
  const Section: FC<PropsWithChildren> = ({ children }) => <section>{children}</section>;
  return {
    Dialog: Section,
    DialogPopup: Section,
    DialogHeader: Section,
    DialogTitle: ({ children }: PropsWithChildren) => <h2>{children}</h2>,
    DialogDescription: ({ children }: PropsWithChildren) => <p>{children}</p>,
    DialogPanel: Section,
    DialogFooter: Section,
  };
});

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: PropsWithChildren) => <div className="scroll-wrapper">{children}</div>,
}));

vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: ({
    children,
    value,
    "aria-label": label,
  }: PropsWithChildren<{ value?: readonly string[]; "aria-label"?: string }>) => (
    <div role="radiogroup" aria-label={label} data-selected-mode={value?.[0]}>
      {children}
    </div>
  ),
  Toggle: ({ children, value }: PropsWithChildren<{ value: string }>) => (
    <button type="button" data-mode-option={value}>
      {children}
    </button>
  ),
}));

import { ProjectIconPicker } from "./ProjectIconPicker";

describe("ProjectIconPicker", () => {
  it("defaults to lucide icon mode when no override is configured", () => {
    const html = renderToStaticMarkup(
      <ProjectIconPicker
        open
        projectName="my-service"
        current={null}
        onOpenChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('data-selected-mode="lucide"');
    expect(html).toContain('aria-label="Icon color"');
    expect(html).toContain('placeholder="Find a symbol (folder, rocket, bug…)"');
  });

  it("selects emoji mode when project is configured with an emoji override", () => {
    const html = renderToStaticMarkup(
      <ProjectIconPicker
        open
        projectName="my-service"
        current={{ kind: "emoji", emoji: "🚀" }}
        onOpenChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('data-selected-mode="emoji"');
    expect(html).not.toContain('aria-label="Icon color"');
    expect(html).toContain("🚀");
  });

  it("selects monogram mode when project is configured with monogram text", () => {
    const html = renderToStaticMarkup(
      <ProjectIconPicker
        open
        projectName="my-service"
        current={{ kind: "lucide", name: "folder-code" as never, monogram: "MS", color: "sky" }}
        onOpenChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('data-selected-mode="monogram"');
    expect(html).toContain('aria-label="Icon color"');
    expect(html).toContain("MS");
  });
});
