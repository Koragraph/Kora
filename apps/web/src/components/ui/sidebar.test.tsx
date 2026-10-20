import type { ReactElement } from "react";
import { renderToStaticMarkup as toHtml } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";

import { resolveSidebarState } from "./navState";
import {
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar";

const inProvider = (node: ReactElement, props: { defaultOpen?: boolean } = {}) =>
  toHtml(<SidebarProvider {...props}>{node}</SidebarProvider>);

describe("sidebar state", () => {
  test.each([
    [true, "expanded"],
    [false, "collapsed"],
  ])("open=%s resolves to %s", (open, state) => {
    expect(resolveSidebarState({ open })).toBe(state);
  });

  test("a collapsed provider announces it for titlebar inset styling", () => {
    expect(inProvider(<div />, { defaultOpen: false })).toContain('data-sidebar-state="collapsed"');
  });

  test("an open provider announces expanded", () => {
    expect(inProvider(<div />)).toContain('data-sidebar-state="expanded"');
  });
});

describe("sidebar controls", () => {
  test("the trigger stays clickable inside Electron drag regions", () => {
    const out = inProvider(<SidebarTrigger />);
    expect(out).toContain("[-webkit-app-region:no-drag]");
    expect(out).toContain("size-[var(--workspace-titlebar-control-size)]!");
  });

  test("a menu button gets the shared geometry, icon rules and pointer cursor", () => {
    const out = inProvider(<SidebarMenuButton>Projects</SidebarMenuButton>);
    for (const token of [
      'data-slot="sidebar-menu-button"',
      "h-8",
      "rounded-[var(--control-radius)]",
      "px-[var(--sidebar-row-content-inset)]",
      "py-1.5",
      "]:size-4",
      "]:shrink-0",
      "cursor-pointer",
      "gap-[var(--sidebar-control-gap)]",
      "text-[var(--sidebar-icon-color)]",
    ]) {
      expect(out).toContain(token);
    }
    expect(out).not.toContain("[&amp;&gt;svg]:opacity-60");
  });

  test("an icon-only menu button is a centred square", () => {
    const out = inProvider(
      <SidebarMenuButton size="icon">
        <span>+</span>
      </SidebarMenuButton>,
    );
    for (const token of ["size-8", "justify-center", "p-0", "text-sidebar-foreground/75"]) {
      expect(out).toContain(token);
    }
  });

  test("a caller's cursor class replaces the default pointer", () => {
    const out = inProvider(<SidebarMenuButton className="cursor-grab">Projects</SidebarMenuButton>);
    expect(out).toContain("cursor-grab");
    expect(out).not.toContain("cursor-pointer");
  });

  test("sub-menu buttons also use a pointer cursor", () => {
    const out = toHtml(
      <SidebarMenuSubButton render={<button type="button" />}>More</SidebarMenuSubButton>,
    );
    expect(out).toContain('data-slot="sidebar-menu-sub-button"');
    expect(out).toContain("cursor-pointer");
  });
});
