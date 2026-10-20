// @effect-diagnostics nodeBuiltinImport:off - reads the stylesheet source to check the token contract.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { AgentId } from "@kora/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GRAPH_CHIP_GLYPH_COLOR } from "./components/thread/GraphStatusChip";
import { AGENT_ICON_BY_AGENT } from "./components/thread/agentIconUtils";
import { DIFF_SURFACE_THEME_UNSAFE_CSS } from "./util/diffRendering";
import { PIERRE_TREE_UNSAFE_CSS } from "./appearance/pierre-tree-theme";

const css = NodeFS.readFileSync(
  NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "index.css"),
  "utf8",
);

/** The body of the first rule whose selector text is exactly `selector` (braces balanced). */
function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`rule not found: ${selector}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error(`unbalanced rule: ${selector}`);
}

/** Top-level declarations only (nested `@variant dark { ... }` blocks stripped). */
function topLevelDecls(body: string): Map<string, string> {
  let flat = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0) flat += ch;
  }
  const decls = new Map<string, string>();
  for (const match of flat.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    decls.set(match[1]!, match[2]!.trim());
  }
  return decls;
}

function darkDecls(body: string): Map<string, string> {
  const start = body.indexOf("@variant dark {");
  return topLevelDecls(body.slice(body.indexOf("{", start) + 1, body.lastIndexOf("}")));
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** sRGB hex → OKLCH (lightness, chroma, hue in degrees). */
function hexToOklch(hex: string): { l: number; c: number; h: number } {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lms = [
    0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!,
    0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!,
    0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!,
  ].map(Math.cbrt);
  const [l, m, s] = lms as [number, number, number];
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/** The QA palette checker's definition of "cold": hue 180–330° with visible chroma. */
function isCold(hex: string): boolean {
  const { c, h } = hexToOklch(hex);
  return c > 0.03 && h >= 180 && h <= 330;
}

const COLD_TAILWIND = /--color-(blue|sky|cyan|indigo|violet|purple|teal|fuchsia)-/;

// The :root block that holds the colour palette (the others hold geometry and contrast).
const paletteRoot = (() => {
  const marker = "\n:root {\n  color-scheme: light;";
  const at = css.indexOf(marker);
  if (at < 0) throw new Error("palette :root not found");
  return css.slice(at + marker.length, css.indexOf("\n}\n", at));
})();

describe("design tokens", () => {
  it("paints focus rings and checked controls with Ink's strong colour in both appearances", () => {
    const light = topLevelDecls(paletteRoot);
    const dark = darkDecls(paletteRoot);
    // Ink's strong colour is ink itself: near-black on the light ladder, Pitch's off-white on the dark one.
    expect(light.get("--primary")).toBe("#09090b");
    expect(dark.get("--primary")).toBe("#f2f2f4");
    for (const decls of [light, dark]) {
      expect(decls.get("--ring")).toBe("var(--primary)");
      expect(decls.get("--control-checked")).toBe("var(--primary)");
    }
    // ≥ 3:1 against every surface (WCAG 1.4.11 non-text contrast).
    for (const [decls, surfaces] of [
      [light, ["--app-frame", "--background", "--surface-raised", "--card", "--popover"]],
      [dark, ["--app-frame", "--background", "--surface-raised", "--card", "--popover"]],
    ] as const) {
      for (const surface of surfaces) {
        expect(
          contrast(decls.get("--primary")!, decls.get(surface)!),
          surface,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps body and muted text AA (4.5:1) on every Ink surface in both appearances", () => {
    const light = topLevelDecls(paletteRoot);
    const dark = darkDecls(paletteRoot);
    const surfaces = ["--app-frame", "--background", "--surface-raised", "--card", "--popover"];
    for (const decls of [light, dark]) {
      for (const surface of surfaces) {
        const bg = decls.get(surface)!;
        expect(bg, surface).toMatch(/^#[0-9a-f]{6}$/i);
        for (const text of ["--foreground", "--muted-foreground"]) {
          expect(contrast(decls.get(text)!, bg), `${text} on ${surface}`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
      for (const text of ["--error-foreground", "--warning-foreground", "--success-foreground"]) {
        for (const surface of surfaces) {
          expect(
            contrast(decls.get(text)!, decls.get(surface)!),
            `${text} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    // The sidebar re-declares its own step; its muted text stays AA on it too.
    const sidebar = ruleBody("[data-app-sidebar]");
    for (const decls of [topLevelDecls(sidebar), darkDecls(sidebar)]) {
      expect(
        contrast(decls.get("--muted-foreground")!, decls.get("--background")!),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("Pitch: the dark ground is true black and every lifted surface keeps text AA", () => {
    const dark = darkDecls(paletteRoot);
    for (const token of ["--app-frame", "--background", "--sidebar", "--terminal-background"]) {
      expect(dark.get(token), token).toBe("#000000");
    }
    expect(dark.get("--foreground")).toBe("#f2f2f4");
    expect(dark.get("--muted-foreground")).toBe("#8b8d95");
    // Flat since 2026-10-13: the lift is one solid fill and casts no highlight or shadow.
    expect(dark.get("--lift-bg")).toBe("linear-gradient(#111113, #111113)");
    expect(dark.get("--lift-shadow")).toBe("0 0 #0000");
    // Muted text must stay AA on every stop of every lifted surface (top of the lift is the lightest).
    for (const surface of [
      "#000000",
      "#0a0a0b",
      "#0b0b0c",
      "#101012",
      "#111113",
      "#151517",
      "#1b1b1e", // user bubble
      "#1d1d20", // active pill
    ]) {
      expect(contrast("#8b8d95", surface), `muted on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#f2f2f4", surface), `foreground on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(dark.get("--message-surface")).toBe("#1b1b1e");
  });

  it("Pitch is flat: no ambient glow or grain layer, and a solid borderless composer", () => {
    expect(css).not.toMatch(/pitch-ambient|pitch-grain/);
    expect(css).toMatch(/--composer-surface: #111113;/);
  });

  it("keeps every Ink surface token free of hue", () => {
    for (const decls of [topLevelDecls(paletteRoot), darkDecls(paletteRoot)]) {
      for (const [name, value] of decls) {
        if (!/^#[0-9a-f]{6}$/i.test(value)) continue;
        if (/^--(error|warning|success|tool-error|destructive)/.test(name)) continue;
        expect(hexToOklch(value).c, `${name} = ${value}`).toBeLessThan(0.02);
      }
    }
  });

  it("exposes the checked-control colour as a utility", () => {
    expect(css).toContain("--color-control-checked: var(--control-checked);");
    expect(css).toContain("--color-control-checked-foreground: var(--control-checked-foreground);");
  });

  it("keeps the always-dark surface readable (WCAG AA) and recomputes contrast inside it", () => {
    const surface = topLevelDecls(ruleBody("[data-dark-surface]"));
    const text = surface.get("--foreground")!;
    const muted = surface.get("--muted-foreground")!;
    for (const bg of [surface.get("--background")!, surface.get("--popover")!]) {
      expect(contrast(text, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(muted, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toMatch(/:root,\n\[data-app-sidebar\],\n\[data-dark-surface\] \{/);
  });

  it("honours prefers-reduced-motion for transitions without stopping progress indicators", () => {
    const at = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  *,");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("\n}\n", at));
    expect(block).toContain("transition-duration: 0.01ms !important");
    expect(block).not.toContain("animation-iteration-count");
  });

  it("keeps info, update, ring and focus tokens Ink (no cold hue) in the dark palette", () => {
    const dark = darkDecls(paletteRoot);
    const resolve = (value: string, seen = 0): string => {
      const ref = /^var\((--[\w-]+)\)$/.exec(value);
      if (!ref || seen > 5) return value;
      const next = dark.get(ref[1]!);
      if (next === undefined) throw new Error(`${ref[1]} is not defined in the dark block`);
      return resolve(next, seen + 1);
    };
    for (const token of [
      "--info",
      "--info-foreground",
      "--update",
      "--update-foreground",
      "--ring",
      "--control-checked",
    ]) {
      const raw = dark.get(token);
      expect(raw, `${token} must be overridden in the dark block`).toBeDefined();
      expect(raw).not.toMatch(COLD_TAILWIND);
      const value = resolve(raw!);
      expect(value, `${token} resolves to a literal`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(isCold(value), `${token} = ${value} is cold`).toBe(false);
    }
    const surfaceRing = topLevelDecls(ruleBody("[data-dark-surface]")).get("--ring")!;
    expect(isCold(surfaceRing)).toBe(false);
    // Readable as text on the dark canvas (WCAG AA).
    expect(
      contrast(resolve(dark.get("--info-foreground")!), dark.get("--background")!),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(resolve(dark.get("--update-foreground")!), dark.get("--background")!),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("routes third-party focus and accent colours through the Ink ring token", () => {
    for (const override of [
      "--trees-accent-override: var(--ring);",
      "--trees-focus-ring-color-override: var(--ring);",
      "--trees-selected-focused-border-color-override: var(--ring);",
    ]) {
      expect(PIERRE_TREE_UNSAFE_CSS).toContain(override);
    }
    expect(PIERRE_TREE_UNSAFE_CSS).toContain(
      "--trees-git-modified-color-override: var(--warning-foreground);",
    );
    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain(
      "--diffs-modified-color-override: var(--ring);",
    );
    expect(css).toMatch(
      /\.dark ::selection \{\n\s*background-color: color-mix\(in srgb, var\(--ring\)/,
    );
  });

  it("draws every agent in its real brand logo (the supplied rasters), everywhere", () => {
    // The composer, thread rows, model picker and settings all show the same full-colour agent marks.
    const icons = [
      ["claude", AGENT_ICON_BY_AGENT[AgentId.make("claude")]],
      ["codex", AGENT_ICON_BY_AGENT[AgentId.make("codex")]],
    ] as const;
    for (const [name, Icon] of icons) {
      expect(Icon, name).toBeDefined();
      const markup = renderToStaticMarkup(createElement(Icon!, { className: "size-4" }));
      expect(markup, `${name} renders its logo raster`).toMatch(/<image[^>]+agent-(claude|codex)/);
    }
  });

  it("keeps the graph chip's not-indexed state neutral (it is a choice, not a fault)", () => {
    expect(GRAPH_CHIP_GLYPH_COLOR.none).toBe("text-muted-foreground");
    expect(GRAPH_CHIP_GLYPH_COLOR.none).not.toMatch(/red|orange|amber|rose/);
  });
});
