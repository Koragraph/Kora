// @effect-diagnostics nodeBuiltinImport:off -- loads index.css directly for static style verification
import * as NodeFS from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PrefsRow,
  PrefsSearchTargetProvider,
  PrefsSection,
  scrollToPrefsTarget,
} from "./prefsLayout";

describe("prefsLayout search target navigation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports failure when requested anchor is absent from the DOM", () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn().mockReturnValue(null),
    });

    const scrolled = scrollToPrefsTarget("missing-setting-key");
    expect(scrolled).toBe(false);
  });

  it("disables pulse animation and uses immediate scrolling under reduced motion", () => {
    const scrollFn = vi.fn();
    const focusFn = vi.fn();
    const classList = {
      add: vi.fn(),
      remove: vi.fn(),
    };

    const mockNode = {
      tagName: "DIV",
      firstElementChild: null,
      scrollIntoView: scrollFn,
      focus: focusFn,
      classList,
      offsetWidth: 120,
    } as unknown as HTMLElement;

    vi.stubGlobal("document", {
      getElementById: vi.fn().mockReturnValue(mockNode),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });

    const ok = scrollToPrefsTarget("editor-line-numbers");
    expect(ok).toBe(true);
    expect(scrollFn).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(focusFn).toHaveBeenCalledWith({ preventScroll: true });
    expect(classList.remove).toHaveBeenCalledWith("prefs-search-target-pulse");
    expect(classList.add).not.toHaveBeenCalled();
  });

  it("targets section header and triggers momentary pulse class when motion is enabled", () => {
    const parentScroll = vi.fn();
    const headerScroll = vi.fn();
    const focusFn = vi.fn();
    const addListener = vi.fn();
    const classList = {
      add: vi.fn(),
      remove: vi.fn(),
    };

    const mockSection = {
      tagName: "SECTION",
      firstElementChild: { scrollIntoView: headerScroll },
      scrollIntoView: parentScroll,
      focus: focusFn,
      addEventListener: addListener,
      classList,
      offsetWidth: 200,
    } as unknown as HTMLElement;

    vi.stubGlobal("document", {
      getElementById: vi.fn().mockReturnValue(mockSection),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    });

    const ok = scrollToPrefsTarget("model-settings-group");
    expect(ok).toBe(true);
    expect(headerScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(parentScroll).not.toHaveBeenCalled();
    expect(focusFn).toHaveBeenCalledWith({ preventScroll: true });
    expect(classList.remove).toHaveBeenCalledWith("prefs-search-target-pulse");
    expect(classList.add).toHaveBeenCalledWith("prefs-search-target-pulse");
    expect(addListener).toHaveBeenCalledWith("blur", expect.any(Function), { once: true });
  });

  it("produces clean markup without leaking runtime pulse classes", () => {
    const html = renderToStaticMarkup(
      <PrefsSearchTargetProvider targetId="git-status">
        <PrefsRow id="git-status" title="Git Status" description="Enable background sync" />
        <PrefsRow id="auto-fetch" title="Auto Fetch" description="Fetch remotes periodically" />
      </PrefsSearchTargetProvider>,
    );

    expect(html).toContain('id="git-status"');
    expect(html).toContain('tabindex="-1"');
    expect(html).not.toContain("prefs-search-target-pulse");
    expect(html).not.toContain("data-prefs-search-target");
  });

  it("ensures sections always render a data-prefs-scroll-target anchor", () => {
    for (const hideTitle of [false, true]) {
      const output = renderToStaticMarkup(
        <PrefsSection id="terminal-pane" title="Terminal" hideTitle={hideTitle}>
          <PrefsRow title="Cursor Style" />
        </PrefsSection>,
      );

      expect(output).toContain("data-prefs-scroll-target");
    }

    const cssText = NodeFS.readFileSync(new URL("../../index.css", import.meta.url), "utf8");
    expect(cssText).toContain("section.prefs-search-target-pulse > [data-prefs-scroll-target]");
  });
});
