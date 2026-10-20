import {
  MIN_PROMPT_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MAX_PROMPT_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  DEFAULT_PROMPT_FONT_SIZE,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_CODE_FONT_SIZE,
} from "@kora/contracts";

export const TYPOGRAPHY_ADVANCED_STORAGE_KEY = "kora:type-advanced";

// Keep in step with --font-sans / --font-mono in index.css. Concrete names come first
// because some engines alias `ui-monospace` to the proportional UI face.
const SANS_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const MONO_STACK = '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

export function resolveTerminalFontPreference(prefs: {
  readonly terminal: string;
  readonly code: string;
  readonly advanced: boolean;
}): string {
  return prefs.advanced ? prefs.terminal : prefs.code;
}

export function resolveTerminalFontSizePreference(prefs: {
  readonly terminal: number;
  readonly code: number;
  readonly advanced: boolean;
}): number {
  return prefs.advanced ? prefs.terminal : prefs.code;
}

/** Normalises a user-typed family list into valid CSS, or null when nothing usable is left. */
export function cssFontFamilies(families: string): string | null {
  const parts: string[] = [];
  for (const unparsed of families.split(",")) {
    const label = unparsed.trim();
    if (!label) continue;
    const head = label[0]!;
    if ((head === '"' || head === "'") && label.length > 1 && label.endsWith(head)) {
      parts.push(label);
    } else if (/^[A-Za-z][A-Za-z0-9-]*$/.test(label)) {
      parts.push(label);
    } else {
      parts.push(`"${label.replaceAll('"', "")}"`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export interface AppearanceFontPreferences {
  readonly smoothing: boolean;
  readonly sizeCode: number;
  readonly sizePrompt: number;
  readonly sizeInterface: number;
  readonly composer: string;
  readonly code: string;
  readonly sans: string;
}

function clampSize(val: number, min: number, max: number, backup: number): number {
  if (!Number.isFinite(val)) return backup;
  return Math.min(max, Math.max(min, Math.round(val)));
}

export const clampInterfaceFontSize = (val: number): number =>
  clampSize(val, MIN_INTERFACE_FONT_SIZE, MAX_INTERFACE_FONT_SIZE, DEFAULT_INTERFACE_FONT_SIZE);
export const clampPromptFontSize = (val: number): number =>
  clampSize(val, MIN_PROMPT_FONT_SIZE, MAX_PROMPT_FONT_SIZE, DEFAULT_PROMPT_FONT_SIZE);
export const clampCodeFontSize = (val: number): number =>
  clampSize(val, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, DEFAULT_CODE_FONT_SIZE);

function setFamilyVariable(root: HTMLElement, label: string, custom: string, backup: string) {
  const arr = cssFontFamilies(custom);
  if (arr === null) root.style.removeProperty(label);
  else root.style.setProperty(label, `${arr}, ${backup}`);
}

export function applyAppearanceFontVariables(
  element: HTMLElement,
  preferences: AppearanceFontPreferences,
): void {
  const style = element.style;
  setFamilyVariable(element, "--font-sans", preferences.sans, SANS_STACK);
  setFamilyVariable(element, "--font-mono", preferences.code, MONO_STACK);
  setFamilyVariable(element, "--font-composer", preferences.composer, "var(--font-sans)");
  style.fontSize = `${clampInterfaceFontSize(preferences.sizeInterface)}px`;
  style.setProperty("--font-size-prompt", `${clampPromptFontSize(preferences.sizePrompt)}px`);
  const codeSize = `${clampCodeFontSize(preferences.sizeCode)}px`;
  style.setProperty("--font-size-code", codeSize);
  style.setProperty("--diffs-font-size", codeSize);
  if (preferences.smoothing) style.setProperty("-webkit-font-smoothing", "antialiased");
  else style.removeProperty("-webkit-font-smoothing");
}

/** True when every measured glyph advance matches the first (or nothing could be measured). */
export function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  if (advances.length === 0) return true;
  const head = advances[0]!;
  if (!(head > 0)) return true;
  if (advances.some((advance) => !Number.isFinite(advance) || advance <= 0)) return true;
  return advances.every((advance) => Math.abs(advance - head) <= 0.01);
}

let probeContext: CanvasRenderingContext2D | null | undefined;

function getProbeContext(): CanvasRenderingContext2D | null {
  if (probeContext === undefined) {
    probeContext = document.createElement("canvas").getContext("2d");
  }
  return probeContext;
}

const PROBE_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"] as const;
const PROBE_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "] as const;

/** Cell-grid surfaces need fixed advances; fails open if canvas is unavailable. */
export function isMonospaceFamily(fam: string): boolean {
  const families = cssFontFamilies(fam);
  if (families === null) return true;
  try {
    const cx = getProbeContext();
    if (!cx) return true;
    return PROBE_VARIANTS.every((variant) => {
      cx.font = `${variant} 32px ${families}, monospace`;
      return areFontAdvancesMonospace(PROBE_GLYPHS.map((g) => cx.measureText(g).width));
    });
  } catch {
    return true;
  }
}

export interface InstalledFontFamiliesResult {
  readonly status: "granted" | "denied" | "unsupported";
  readonly families: readonly string[];
}
