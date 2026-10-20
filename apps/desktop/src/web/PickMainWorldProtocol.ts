/**
 * The narrow seam between the element picker (isolated world) and the inspected
 * page (main world). Electron-free and DOM-free so it is unit-testable.
 *
 * Preview guests run with `contextIsolation: true`: the picker preload
 * (`PickPreload.ts`) lives in an isolated world and the page cannot reach its
 * `ipcRenderer`, its overlay or anything else it holds. React component names,
 * however, live on the page's own JS wrappers (`__reactFiber$…` expandos and the
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` React registers with at boot), which the
 * isolated world cannot see. So the preload injects ONE self-contained script
 * into the main world at document start (`PickMainWorld.ts`, bundled with
 * react-grab) that:
 *
 * - installs react-grab's DevTools hook before the page's React boots, and
 * - defines one function under a per-document random name that takes a token
 *   string, finds the element the picker tagged with that token, and returns a
 *   JSON string of plain data (selector, component name, source stack, …).
 *
 * Nothing crosses the other way: the main world never receives a function, an
 * object or an API from Kora — only the token string. Whatever comes back is
 * page-controlled text (the page can tamper with its own globals), so the
 * isolated side parses it with `parseMainWorldElementContext`, which accepts
 * only the expected shape and caps every string.
 */
import type { PickedElementStackFrame } from "@kora/contracts";

/** Attribute the picker sets (briefly) on an element so the main world can find it. */
export const PICK_TARGET_ATTRIBUTE = "data-kora-pick-target";
/** `var` the IIFE bundle of `PickMainWorld.ts` assigns its exports to. */
export const PICK_MAIN_WORLD_GLOBAL_NAME = "__koraPickMainWorld";

const TOKEN_PATTERN = /^[a-z0-9]{16,64}$/;
const KEY_PATTERN = /^__koraPick_[a-z0-9]{16,64}$/;

/** Caps on what the page can hand back. Generous for real pages, tight enough to bound IPC. */
export const PICK_CONTEXT_LIMITS = {
  rawChars: 512 * 1024,
  shortChars: 2_048,
  htmlPreviewChars: 20_000,
  stylesChars: 50_000,
  stackFrames: 64,
} as const;

export interface MainWorldElementContext {
  readonly selector: string | null;
  readonly htmlPreview: string;
  readonly componentName: string | null;
  readonly styles: string;
  readonly stack: ReadonlyArray<PickedElementStackFrame>;
}

export function isPickToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function isPickMainWorldKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

/** Lowercase alphanumeric token from 16 random bytes (callers pass `crypto.getRandomValues`). */
export function createPickToken(
  fillRandom: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>,
): string {
  const bytes = fillRandom(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
}

export function pickMainWorldKey(token: string): string {
  if (!isPickToken(token)) throw new Error("Invalid picker main-world token");
  return `__koraPick_${token}`;
}

/**
 * Script that evaluates the main-world bundle inside a function (so its `var`
 * stays local) and installs the context reader under `key`. Only the key string
 * is interpolated, JSON-encoded.
 */
export function buildMainWorldInstallScript(bundleSource: string, key: string): string {
  if (!isPickMainWorldKey(key)) throw new Error("Invalid picker main-world key");
  return `;(function(){${bundleSource}\n;return ${PICK_MAIN_WORLD_GLOBAL_NAME};})().install(${JSON.stringify(key)});`;
}

/** Script that asks the installed reader about one tagged element. Resolves to a JSON string or null. */
export function buildMainWorldContextScript(key: string, token: string): string {
  if (!isPickMainWorldKey(key)) throw new Error("Invalid picker main-world key");
  if (!isPickToken(token)) throw new Error("Invalid picker token");
  return `(function(){var read=globalThis[${JSON.stringify(key)}];return typeof read==="function"?read(${JSON.stringify(token)}):null;})()`;
}

const cap = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

function readString(record: Record<string, unknown>, key: string, max: number): string | null {
  const value = record[key];
  return typeof value === "string" ? cap(value, max) : null;
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStackFrame(value: unknown): PickedElementStackFrame | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  return {
    functionName: readString(frame, "functionName", PICK_CONTEXT_LIMITS.shortChars),
    fileName: readString(frame, "fileName", PICK_CONTEXT_LIMITS.shortChars),
    lineNumber: readFiniteNumber(frame, "lineNumber"),
    columnNumber: readFiniteNumber(frame, "columnNumber"),
  };
}

/**
 * Parses the main world's answer. Anything that is not a JSON string of the
 * expected object yields `null` (the picker then sends its DOM-only payload).
 * Unknown keys are dropped; wrong-typed fields become their empty value.
 */
export function parseMainWorldElementContext(raw: unknown): MainWorldElementContext | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > PICK_CONTEXT_LIMITS.rawChars) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const rawStack = Array.isArray(record["stack"]) ? record["stack"] : [];
  const stack: PickedElementStackFrame[] = [];
  for (const entry of rawStack.slice(0, PICK_CONTEXT_LIMITS.stackFrames)) {
    const frame = readStackFrame(entry);
    if (frame) stack.push(frame);
  }
  return {
    selector: readString(record, "selector", PICK_CONTEXT_LIMITS.shortChars),
    htmlPreview: readString(record, "htmlPreview", PICK_CONTEXT_LIMITS.htmlPreviewChars) ?? "",
    componentName: readString(record, "componentName", PICK_CONTEXT_LIMITS.shortChars),
    styles: readString(record, "styles", PICK_CONTEXT_LIMITS.stylesChars) ?? "",
    stack,
  };
}

/** The plain-data projection of a react-grab element context the main world serializes. */
export function projectElementContext(context: {
  readonly selector?: unknown;
  readonly htmlPreview?: unknown;
  readonly componentName?: unknown;
  readonly styles?: unknown;
  readonly stack?: unknown;
}): Record<string, unknown> {
  const stack = Array.isArray(context.stack) ? context.stack : [];
  return {
    selector: typeof context.selector === "string" ? context.selector : null,
    htmlPreview: typeof context.htmlPreview === "string" ? context.htmlPreview : "",
    componentName: typeof context.componentName === "string" ? context.componentName : null,
    styles: typeof context.styles === "string" ? context.styles : "",
    stack: stack.slice(0, PICK_CONTEXT_LIMITS.stackFrames).map((frame: unknown) => {
      const record =
        typeof frame === "object" && frame !== null ? (frame as Record<string, unknown>) : {};
      return {
        functionName: typeof record["functionName"] === "string" ? record["functionName"] : null,
        fileName: typeof record["fileName"] === "string" ? record["fileName"] : null,
        lineNumber: typeof record["lineNumber"] === "number" ? record["lineNumber"] : null,
        columnNumber: typeof record["columnNumber"] === "number" ? record["columnNumber"] : null,
      };
    }),
  };
}
