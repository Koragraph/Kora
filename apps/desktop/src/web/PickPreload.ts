// @effect-diagnostics globalTimers:off globalDate:off -- runs in a guest page, with no Effect runtime.
// Preload of every preview <webview> guest. It runs in an isolated world (the page cannot reach ipcRenderer or the
// overlay) and does two jobs:
//   1. report trusted human input and mouse thumb-button navigation to the main process, and
//   2. run the "markup" overlay: pick elements, mark regions, draw, tweak styles live, comment, and hand the
//      annotation to the main process (WebManager.pickElement).
import mainWorldSource from "virtual:kora-pick-main-world";
import { ipcRenderer, webFrame } from "electron";
import type {
  WebMarkupSubmission,
  WebMarkupStyleChange,
  WebMarkupStrokeTarget,
  WebMarkupRegionTarget,
  WebMarkupRect,
  WebMarkupPoint,
  WebMarkupPayload,
  ShellWebMarkupTheme,
  PickedNodePayload,
} from "@kora/contracts";

import {
  pickMainWorldKey,
  parseMainWorldElementContext,
  createPickToken,
  buildMainWorldInstallScript,
  buildMainWorldContextScript,
  PICK_TARGET_ATTRIBUTE,
} from "./PickMainWorldProtocol.ts";
import { webMarkupStyles } from "./MarkupStyles.generated.ts";
import { resolveMarkupSubmission } from "./MarkupKeyboard.ts";
import {
  IPC_START_PICK,
  IPC_MOUSE_NAVIGATE,
  IPC_MARKUP_THEME,
  IPC_MARKUP_CAPTURED,
  IPC_HUMAN_INPUT,
  IPC_ELEMENT_PICKED,
  IPC_CANCEL_PICK,
} from "./GuestProtocol.ts";

// ---------------------------------------------------------------------------------------------------------------
// Constants

const OVERLAY_ATTRIBUTE = "data-kora-markup-ui";
const TOOL_ATTRIBUTE = "data-kora-markup-tool";
const OVERLAY_Z_INDEX = 2147483646;
const CONTEXT_TIMEOUT_MS = 5_000;
const MAX_MARQUEE_PICKS = 20;
const MIN_MARQUEE_SIZE = 3;
const STROKE_WIDTH = 4;
const FALLBACK_STROKE_COLOR = "#2563eb";
const VIEWPORT_MARGIN = 8;
const EDITOR_GAP = 8;
const SHOT_PADDING = 20;
const FONT_CHOICES = ["inherit", "system-ui", "sans-serif", "serif", "monospace"] as const;
const WEIGHT_CHOICES = ["300", "400", "500", "600", "700", "800", "900"] as const;

type Tool = "select" | "region" | "draw" | "erase";

const TOOLS: ReadonlyArray<{ tool: Tool; label: string; title: string }> = [
  { tool: "select", label: "Select", title: "Select elements" },
  { tool: "region", label: "Region", title: "Draw a region or marquee-select elements" },
  { tool: "draw", label: "Draw", title: "Draw freehand" },
  { tool: "erase", label: "Erase", title: "Remove an annotation target" },
];

// ---------------------------------------------------------------------------------------------------------------
// Always on: human input and thumb buttons

window.addEventListener(
  "pointerdown",
  (evt) => {
    if (!evt.isTrusted) return;
    ipcRenderer.send(IPC_HUMAN_INPUT, {
      kind: "pointer",
      x: evt.clientX,
      y: evt.clientY,
      button: evt.button,
    });
  },
  true,
);
window.addEventListener(
  "keydown",
  (evt) => {
    if (!evt.isTrusted) return;
    ipcRenderer.send(IPC_HUMAN_INPUT, { kind: "key", key: evt.key, code: evt.code });
  },
  true,
);

// Chromium sends thumb-button history navigation to the FOCUSED WebContents, so just hovering a guest would
// navigate the host app's router. The guest under the pointer navigates itself instead.
const THUMB_DIRECTION: Readonly<Record<number, "back" | "forward">> = { 3: "back", 4: "forward" };
for (const type of ["mousedown", "auxclick"] as const) {
  window.addEventListener(
    type,
    (evt) => {
      if (THUMB_DIRECTION[evt.button] === undefined) return;
      evt.preventDefault();
      evt.stopPropagation();
    },
    true,
  );
}
window.addEventListener(
  "mouseup",
  (evt) => {
    const dir = THUMB_DIRECTION[evt.button];
    if (dir === undefined) return;
    evt.preventDefault();
    evt.stopPropagation();
    ipcRenderer.send(IPC_MOUSE_NAVIGATE, { direction: dir });
  },
  true,
);

// ---------------------------------------------------------------------------------------------------------------
// Main-world helper (React component names). Popups opened by a page (OAuth) are never picked, so skip them.

let mainWorldKey: string | null = null;
if (window.opener === null) {
  const key = pickMainWorldKey(createPickToken((buf) => crypto.getRandomValues(buf)));
  mainWorldKey = key;
  webFrame.executeJavaScript(buildMainWorldInstallScript(mainWorldSource, key)).catch(() => {
    mainWorldKey = null; // pages then yield DOM-only payloads
  });
}

interface ElementContext {
  readonly selector: string | null;
  readonly htmlPreview: string;
  readonly componentName: string | null;
  readonly styles: string;
  readonly stack: PickedNodePayload["stack"];
}

async function readElementContext(elem: Element): Promise<ElementContext | null> {
  if (mainWorldKey === null) return null;
  const tok = createPickToken((buf) => crypto.getRandomValues(buf));
  elem.setAttribute(PICK_TARGET_ATTRIBUTE, tok);
  try {
    const unparsed = await webFrame.executeJavaScript(
      buildMainWorldContextScript(mainWorldKey, tok),
    );
    return parseMainWorldElementContext(unparsed);
  } catch {
    return null;
  } finally {
    elem.removeAttribute(PICK_TARGET_ATTRIBUTE);
  }
}

const withTimeout = <T>(work: Promise<T>, ms: number, backup: T): Promise<T> =>
  new Promise((resolve) => {
    const tmr = setTimeout(() => resolve(backup), ms);
    work.then(
      (val) => {
        clearTimeout(tmr);
        resolve(val);
      },
      () => {
        clearTimeout(tmr);
        resolve(backup);
      },
    );
  });

async function describeElement(elem: Element): Promise<PickedNodePayload> {
  const pageContext = await withTimeout(readElementContext(elem), CONTEXT_TIMEOUT_MS, null);
  const fallbackBase = {
    pageUrl: location.href,
    pageTitle: document.title.trim() || null,
    tagName: elem.tagName.toLowerCase(),
    pickedAt: new Date().toISOString(),
  };
  if (pageContext === null) {
    return {
      ...fallbackBase,
      selector: null,
      htmlPreview: elem.outerHTML.slice(0, 500),
      componentName: null,
      source: null,
      stack: [],
      styles: "",
    };
  }
  return {
    ...fallbackBase,
    selector: pageContext.selector,
    htmlPreview: pageContext.htmlPreview,
    componentName: pageContext.componentName,
    source: pageContext.stack[0] ?? null,
    stack: [...pageContext.stack],
    styles: pageContext.styles,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// DOM helpers

type Props = Record<string, string | number | boolean | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(
  marker: K,
  className = "",
  props: Props = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const element = document.createElement(marker);
  if (className) element.className = className;
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (name === "text") element.textContent = String(value);
    else if (name === "style") element.setAttribute("style", String(value));
    else element.setAttribute(name, String(value));
  }
  element.append(...children);
  return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(viewBox: string, extent: number, markup: string): SVGElement {
  const svgElement = document.createElementNS(SVG_NS, "svg");
  svgElement.setAttribute("viewBox", viewBox);
  svgElement.setAttribute("width", String(extent));
  svgElement.setAttribute("height", String(extent));
  svgElement.setAttribute("aria-hidden", "true");
  svgElement.setAttribute("fill", "none");
  svgElement.setAttribute("stroke", "currentColor");
  svgElement.setAttribute("stroke-width", "1.6");
  svgElement.setAttribute("stroke-linecap", "round");
  svgElement.setAttribute("stroke-linejoin", "round");
  svgElement.innerHTML = markup;
  return svgElement;
}

const nextId = (() => {
  let counter = 0;
  return (lead: "element" | "region" | "stroke" | "annotation") => {
    counter += 1;
    return `${lead}_${counter.toString(36)}`;
  };
})();

const rectOf = (elem: Element): WebMarkupRect => {
  const rectangle = elem.getBoundingClientRect();
  return { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height };
};

const clamp = (val: number, low: number, high: number) => Math.min(Math.max(val, low), high);

function unionOf(rects: ReadonlyArray<WebMarkupRect>): WebMarkupRect | null {
  if (rects.length === 0) return null;
  const leftSide = Math.min(...rects.map((res) => res.x));
  const upper = Math.min(...rects.map((res) => res.y));
  const rightSide = Math.max(...rects.map((res) => res.x + res.width));
  const bottom = Math.max(...rects.map((res) => res.y + res.height));
  return { x: leftSide, y: upper, width: rightSide - leftSide, height: bottom - upper };
}

/** The usual "tag#id.class.class" label (at most two classes). */
function describeTag(elem: Element): string {
  const classes = [...elem.classList].slice(0, 2);
  return `${elem.tagName.toLowerCase()}${elem.id ? `#${elem.id}` : ""}${classes
    .map((name) => `.${name}`)
    .join("")}`;
}

function toHex(hue: string): string {
  const matched = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(hue);
  if (!matched) return "#000000";
  return `#${[matched[1], matched[2], matched[3]]
    .map((fragment) => Number(fragment).toString(16).padStart(2, "0"))
    .join("")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Session

let activeSession: { readonly finish: (notify: boolean) => void } | null = null;
let currentTheme: ShellWebMarkupTheme | null = null;
let applyThemeToOverlay: ((palette: ShellWebMarkupTheme) => void) | null = null;

interface SelectedElement {
  readonly id: string;
  readonly element: Element;
  readonly box: HTMLElement;
  readonly label: HTMLElement;
  /** Inline value (and priority) each touched property had before the overlay changed it. */
  readonly baselines: Map<string, { value: string; priority: string }>;
}

interface RegionTarget extends WebMarkupRegionTarget {
  readonly box: HTMLElement;
}

interface StrokeTarget extends WebMarkupStrokeTarget {
  readonly path: SVGPathElement;
}

function startMarkup(palette: ShellWebMarkupTheme | undefined): void {
  activeSession?.finish(false);
  if (palette) currentTheme = palette;

  let finished = false;
  let tool: Tool = "select";
  let capturing = false;
  let openFlag = false;
  let sizeRatio = 1;
  let ratioLocked = true;
  let editorDragOffset: { x: number; y: number } | null = null;
  let editorPosition: { x: number; y: number } | null = null;
  let focusedOnce = false;
  let layoutFrame = 0;

  const selected: SelectedElement[] = [];
  const regions: RegionTarget[] = [];
  const strokes: StrokeTarget[] = [];
  const changes = new Map<string, WebMarkupStyleChange>();

  // --- overlay shell ---------------------------------------------------------------------------------------------

  const hostInfo = h("div", "", { [OVERLAY_ATTRIBUTE]: "" });
  hostInfo.style.cssText = `position:fixed;inset:0;z-index:${OVERLAY_Z_INDEX};pointer-events:none;`;
  const shadow = hostInfo.attachShadow({ mode: "closed" });
  shadow.append(h("style", "", { text: webMarkupStyles }));
  const overlayRoot = h("div", "fixed inset-0 pointer-events-none font-sans text-foreground");
  shadow.append(overlayRoot);

  const applyTheme = (upcoming: ShellWebMarkupTheme) => {
    const variables: Record<string, string> = {
      "--kora-radius": upcoming.radius,
      "--kora-background": upcoming.background,
      "--kora-foreground": upcoming.foreground,
      "--kora-popover": upcoming.popover,
      "--kora-popover-foreground": upcoming.popoverForeground,
      "--kora-primary": upcoming.primary,
      "--kora-primary-foreground": upcoming.primaryForeground,
      "--kora-muted": upcoming.muted,
      "--kora-muted-foreground": upcoming.mutedForeground,
      "--kora-accent": upcoming.accent,
      "--kora-accent-foreground": upcoming.accentForeground,
      "--kora-border": upcoming.border,
      "--kora-input": upcoming.input,
      "--kora-ring": upcoming.ring,
      "--kora-font-sans": upcoming.fontSans,
      "--kora-font-mono": upcoming.fontMono,
    };
    for (const [name, value] of Object.entries(variables)) hostInfo.style.setProperty(name, value);
    hostInfo.style.colorScheme = upcoming.colorScheme;
  };
  if (currentTheme) applyTheme(currentTheme);
  applyThemeToOverlay = applyTheme;

  const cursorStyle = h("style", "", {
    text: `html[${TOOL_ATTRIBUTE}] body, html[${TOOL_ATTRIBUTE}] body * { cursor: crosshair !important; }
[${OVERLAY_ATTRIBUTE}], [${OVERLAY_ATTRIBUTE}] * { cursor: default !important; }`,
  });
  const spinnerStyle = h("style", "", {
    text: `input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}`,
  });
  shadow.append(spinnerStyle);

  // Visual layers.
  const hoverBox = h("div", "fixed hidden z-1", {
    style:
      "border:2px solid var(--kora-primary);border-radius:3px;background:color-mix(in srgb,var(--kora-primary) 10%,transparent);box-sizing:border-box;left:0;top:0;",
  });
  const marqueeBox = h("div", "fixed hidden z-1", {
    style:
      "border:2px solid var(--kora-primary);border-radius:3px;background:color-mix(in srgb,var(--kora-primary) 6%,transparent);box-sizing:border-box;left:0;top:0;",
  });
  const strokeLayer = document.createElementNS(SVG_NS, "svg");
  strokeLayer.setAttribute("style", "position:fixed;inset:0;overflow:visible;pointer-events:none;");
  overlayRoot.append(hoverBox, marqueeBox, strokeLayer);

  const placeBox = (rectangle: HTMLElement, bounds: WebMarkupRect) => {
    rectangle.style.transform = `translate(${bounds.x}px, ${bounds.y}px)`;
    rectangle.style.width = `${bounds.width}px`;
    rectangle.style.height = `${bounds.height}px`;
  };

  // --- toolbar ---------------------------------------------------------------------------------------------------

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const toolbar = h(
    "div",
    "pointer-events-auto fixed left-1/2 -translate-x-1/2 flex gap-0.5 p-1 rounded-lg border border-border bg-popover/95 text-popover-foreground shadow-lg backdrop-blur-xl",
    { style: "top:10px;z-index:10;" },
  );
  for (const definition of TOOLS) {
    const btn = h(
      "button",
      "inline-flex h-8 items-center px-2.5 rounded-md border border-transparent font-sans text-sm font-medium text-foreground hover:bg-accent cursor-pointer",
      { type: "button", title: definition.title, text: definition.label },
    );
    btn.addEventListener("click", () => setTool(definition.tool));
    toolButtons.set(definition.tool, btn);
    toolbar.append(btn);
  }
  overlayRoot.append(toolbar);

  function setTool(upcoming: Tool) {
    tool = upcoming;
    document.documentElement.setAttribute(TOOL_ATTRIBUTE, tool);
    for (const [name, button] of toolButtons) {
      const engaged = name === tool;
      button.classList.toggle("text-primary", engaged);
      button.classList.toggle("bg-primary/10", engaged);
      button.classList.toggle("text-foreground", !engaged);
    }
    if (tool !== "select") hoverBox.classList.add("hidden");
    if (tool !== "region") marqueeBox.classList.add("hidden");
  }

  // --- editor ----------------------------------------------------------------------------------------------------

  const ed = h(
    "div",
    "pointer-events-auto fixed hidden flex flex-col overflow-hidden rounded-xl border border-border bg-popover/96 text-popover-foreground shadow-2xl backdrop-blur-xl",
    {
      style: "z-index:10;left:0;top:0;",
    },
  );
  ed.classList.add("w-[min(360px,calc(100vw-16px))]", "max-h-[calc(100vh-16px)]");

  const adjustButton = h(
    "button",
    "inline-flex w-8 h-8 shrink-0 items-center justify-center rounded-md bg-muted p-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer",
    {
      type: "button",
      "aria-label": "Expand annotation editor",
      "aria-expanded": "false",
      title: "Expand annotation editor",
    },
    svg(
      "0 0 16 16",
      15,
      '<path d="M2 4h12M2 8h12M2 12h12"/><path d="M5 2.5v3M10.5 6.5v3M7 10.5v3"/>',
    ),
  );
  const dragHandle = h(
    "button",
    "hidden w-6 h-8 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-lg font-bold text-muted-foreground cursor-grab",
    { type: "button", title: "Drag annotation editor", text: "⠿" },
  );
  const remark = h(
    "textarea",
    "flex-1 min-w-0 min-h-8 max-h-24 resize-none border-0 border-b border-b-transparent bg-transparent py-1.5 px-0 font-sans text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:border-b-primary focus:outline-none focus:ring-0 ring-0",
    { rows: 1, placeholder: "Describe the change…" },
  );
  const submit = h(
    "button",
    "inline-flex h-8 shrink-0 items-center px-3 rounded-md border border-primary bg-primary font-sans text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 cursor-pointer disabled:pointer-events-none",
    { type: "button", title: "Attach annotation and screenshot", text: "Attach" },
  );
  const promptRow = h(
    "div",
    "flex items-start gap-2 p-2",
    {},
    adjustButton,
    dragHandle,
    remark,
    submit,
  );
  const stylePanel = h(
    "div",
    "hidden overflow-auto border-t border-border bg-muted/40 px-3 max-h-[min(176px,calc(100vh-180px))]",
  );
  ed.append(promptRow, stylePanel);
  overlayRoot.append(ed);

  // Comment field: keep keystrokes away from the page.
  overlayRoot.addEventListener("keydown", (evt) => evt.stopPropagation());
  remark.addEventListener("input", () => {
    remark.style.height = "auto";
    remark.style.height = `${Math.min(remark.scrollHeight, 96)}px`;
    scheduleLayout();
  });
  remark.addEventListener("keydown", (evt) => {
    const submission = resolveMarkupSubmission(evt);
    if (submission === null) return;
    evt.preventDefault();
    void send(submission);
  });
  submit.addEventListener("click", () => void send("attach"));

  adjustButton.addEventListener("click", () => {
    openFlag = !openFlag;
    const caption = openFlag ? "Collapse annotation editor" : "Expand annotation editor";
    adjustButton.setAttribute("aria-expanded", String(openFlag));
    adjustButton.setAttribute("aria-label", caption);
    adjustButton.title = caption;
    dragHandle.classList.toggle("hidden", !openFlag);
    dragHandle.classList.toggle("inline-flex", openFlag);
    if (!openFlag) editorPosition = null;
    syncPanels();
    scheduleLayout();
  });

  dragHandle.addEventListener("pointerdown", (evt) => {
    const rectangle = ed.getBoundingClientRect();
    editorDragOffset = { x: evt.clientX - rectangle.left, y: evt.clientY - rectangle.top };
    dragHandle.setPointerCapture(evt.pointerId);
    dragHandle.classList.replace("cursor-grab", "cursor-grabbing");
    evt.preventDefault();
  });
  dragHandle.addEventListener("pointermove", (evt) => {
    if (!editorDragOffset) return;
    const rectangle = ed.getBoundingClientRect();
    editorPosition = {
      x: clamp(
        evt.clientX - editorDragOffset.x,
        VIEWPORT_MARGIN,
        innerWidth - rectangle.width - VIEWPORT_MARGIN,
      ),
      y: clamp(
        evt.clientY - editorDragOffset.y,
        VIEWPORT_MARGIN,
        innerHeight - rectangle.height - VIEWPORT_MARGIN,
      ),
    };
    scheduleLayout();
  });
  const endDrag = () => {
    editorDragOffset = null;
    dragHandle.classList.replace("cursor-grabbing", "cursor-grab");
  };
  dragHandle.addEventListener("pointerup", endDrag);
  dragHandle.addEventListener("pointercancel", endDrag);

  // --- style controls --------------------------------------------------------------------------------------------

  const refreshers: Array<() => void> = [];

  const applyStyle = (property: string, val: string) => {
    for (const rec of selected) {
      const elem = rec.element as HTMLElement;
      if (!rec.baselines.has(property)) {
        rec.baselines.set(property, {
          value: elem.style.getPropertyValue(property),
          priority: elem.style.getPropertyPriority(property),
        });
      }
      const keyName = `${rec.id}\u0000${property}`;
      const prior =
        changes.get(keyName)?.previousValue ?? getComputedStyle(elem).getPropertyValue(property);
      if (val === "") {
        const fallbackBase = rec.baselines.get(property)!;
        elem.style.setProperty(property, fallbackBase.value, fallbackBase.priority);
        changes.delete(keyName);
      } else {
        elem.style.setProperty(property, val, "important");
        changes.set(keyName, {
          targetId: rec.id,
          selector: null,
          property,
          previousValue: prior,
          value: val,
        });
      }
    }
    scheduleLayout();
  };

  const labelled = (str: string, control: HTMLElement): HTMLElement =>
    h(
      "label",
      "grid grid-cols-[82px_minmax(0,1fr)] items-center gap-2 min-h-7 font-sans text-xs font-medium text-muted-foreground",
      {},
      h("span", "", { text: str }),
      control,
    );

  const inputClass =
    "h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground shadow-xs appearance-none";

  const withUnit = (control: HTMLInputElement): HTMLElement => {
    const wrap = h("div", "relative", { style: "display:block;" }, control);
    wrap.append(
      h("span", "absolute top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground", {
        text: "px",
        style: "right:8px;pointer-events:none;",
      }),
    );
    control.style.paddingRight = "30px";
    return wrap;
  };

  const readComputed = (property: string): string => {
    const first = selected[0];
    return first ? getComputedStyle(first.element).getPropertyValue(property) : "";
  };

  const numberField = (
    caption: string,
    property: string,
    opts: { min: number; max: number; placeholder?: string; extra?: () => void },
  ) => {
    const field = h("input", inputClass, {
      type: "number",
      min: opts.min,
      max: opts.max,
      placeholder: opts.placeholder,
    });
    field.addEventListener("input", () => {
      applyStyle(property, field.value === "" ? "" : `${field.value}px`);
      opts.extra?.();
    });
    refreshers.push(() => {
      const val = Number.parseFloat(readComputed(property));
      field.value = Number.isFinite(val) ? String(Math.round(val * 100) / 100) : "";
    });
    return labelled(caption, withUnit(field));
  };

  const textField = (caption: string, property: string, placeholder: string, onChange = false) => {
    const field = h("input", inputClass, { type: "text", placeholder });
    field.addEventListener(onChange ? "change" : "input", () =>
      applyStyle(property, field.value.trim()),
    );
    refreshers.push(() => {
      const val = readComputed(property);
      field.value = property === "gap" && val === "normal" ? "0px" : val;
    });
    return labelled(caption, field);
  };

  const selectField = (
    caption: string,
    property: string,
    choices: ReadonlyArray<string>,
    read: (computed: string) => string,
  ) => {
    const select = h("select", inputClass);
    for (const choice of choices) select.append(h("option", "", { value: choice, text: choice }));
    select.addEventListener("change", () =>
      applyStyle(property, select.value === "inherit" ? "inherit" : select.value),
    );
    refreshers.push(() => {
      select.value = read(readComputed(property));
    });
    return labelled(caption, select);
  };

  const colorField = (caption: string, property: string) => {
    const swatch = h("input", "p-0 border-0 bg-transparent cursor-pointer", {
      type: "color",
      "aria-label": caption,
      style: "width:20px;height:20px;border-radius:5px;",
    });
    const hex = h("input", "min-w-0 border-0 bg-transparent font-mono text-xs text-foreground", {
      type: "text",
      "aria-label": `${caption} value`,
    });
    swatch.addEventListener("input", () => {
      hex.value = swatch.value;
      applyStyle(property, swatch.value);
    });
    hex.addEventListener("change", () => {
      applyStyle(property, hex.value.trim());
      if (/^#[0-9a-f]{6}$/i.test(hex.value.trim())) swatch.value = hex.value.trim();
    });
    refreshers.push(() => {
      const val = toHex(readComputed(property));
      swatch.value = val;
      hex.value = val;
    });
    const control = h(
      "div",
      "grid grid-cols-[22px_minmax(0,1fr)] items-center gap-1 h-7 rounded-md border border-input bg-background px-1 shadow-xs",
      {},
      swatch,
      hex,
    );
    return labelled(caption, control);
  };

  const opacityField = () => {
    const span = h("input", "w-full", {
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      style: "accent-color:var(--kora-primary);",
    });
    span.addEventListener("input", () => applyStyle("opacity", span.value));
    refreshers.push(() => {
      span.value = readComputed("opacity") || "1";
    });
    return labelled("Opacity", span);
  };

  // Width/height with a lock that keeps the ratio captured when the controls last synced.
  const sizeField = () => {
    const wd = h("input", inputClass, { type: "number", min: 0, placeholder: "auto" });
    const ht = h("input", inputClass, { type: "number", min: 0, placeholder: "auto" });
    const lock = h(
      "button",
      "absolute top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded-md p-0 cursor-pointer bg-primary/10 text-primary",
      {
        type: "button",
        title: "Lock aspect ratio",
        "aria-pressed": "true",
        style: "left:0;width:18px;height:38px;",
      },
      svg(
        "0 0 16 16",
        14,
        '<path d="M6.5 9.5l3-3"/><path d="M7 4.5l1-1a2.1 2.1 0 013 3l-1 1"/><path d="M9 11.5l-1 1a2.1 2.1 0 01-3-3l1-1"/>',
      ),
    );
    const paint = () => {
      lock.setAttribute("aria-pressed", String(ratioLocked));
      lock.classList.toggle("bg-primary/10", ratioLocked);
      lock.classList.toggle("text-primary", ratioLocked);
      lock.classList.toggle("bg-muted", !ratioLocked);
      lock.classList.toggle("text-muted-foreground", !ratioLocked);
    };
    lock.addEventListener("click", () => {
      ratioLocked = !ratioLocked;
      paint();
    });
    wd.addEventListener("input", () => {
      applyStyle("width", wd.value === "" ? "" : `${wd.value}px`);
      if (ratioLocked && wd.value !== "") {
        ht.value = String(Math.round(Number(wd.value) / sizeRatio));
        applyStyle("height", `${ht.value}px`);
      }
    });
    ht.addEventListener("input", () => {
      applyStyle("height", ht.value === "" ? "" : `${ht.value}px`);
      if (ratioLocked && ht.value !== "") {
        wd.value = String(Math.round(Number(ht.value) * sizeRatio));
        applyStyle("width", `${wd.value}px`);
      }
    });
    refreshers.push(() => {
      const first = selected[0];
      if (!first) return;
      const rectangle = first.element.getBoundingClientRect();
      wd.value = String(Math.round(rectangle.width));
      ht.value = String(Math.round(rectangle.height));
      sizeRatio = rectangle.height > 0 ? rectangle.width / rectangle.height : 1;
      paint();
    });
    const inputs = h(
      "div",
      "grid",
      { style: "gap:3px;padding-left:22px;" },
      withUnit(wd),
      withUnit(ht),
    );
    return h(
      "div",
      "relative grid grid-cols-[82px_minmax(0,1fr)] gap-2 font-sans text-xs font-medium text-muted-foreground",
      {},
      h("div", "flex items-center", { text: "Width / Height" }),
      h("div", "relative", {}, lock, inputs),
    );
  };

  const section = (...lineList: HTMLElement[]) =>
    h("div", "grid gap-1 border-t border-border py-2", {}, ...lineList);

  stylePanel.append(
    section(
      selectField("Font", "font-family", FONT_CHOICES, (computed) => {
        const first = computed.split(",")[0]?.trim().replaceAll('"', "") ?? "";
        return (FONT_CHOICES as ReadonlyArray<string>).includes(first) ? first : "inherit";
      }),
      numberField("Font size", "font-size", { min: 1, max: 300, placeholder: "16" }),
      selectField("Font weight", "font-weight", WEIGHT_CHOICES, (computed) =>
        (WEIGHT_CHOICES as ReadonlyArray<string>).includes(computed) ? computed : "400",
      ),
      textField("Line height", "line-height", "normal / 1.4", true),
    ),
    section(
      colorField("Text color", "color"),
      colorField("Background", "background-color"),
      opacityField(),
    ),
    section(
      numberField("Radius", "border-radius", { min: 0, max: 300 }),
      colorField("Border color", "border-color"),
      numberField("Border width", "border-width", {
        min: 0,
        max: 100,
        extra: () => applyStyle("border-style", "solid"),
      }),
    ),
    section(
      sizeField(),
      textField("Padding", "padding", "0 0 0 0"),
      textField("Margin", "margin", "0 0 0 0"),
      textField("Gap", "gap", "0px"),
    ),
  );

  // --- selection / targets ---------------------------------------------------------------------------------------

  const hasTargets = () => selected.length + regions.length + strokes.length > 0;

  const targetRects = (): WebMarkupRect[] => [
    ...selected.map((rec) => rectOf(rec.element)),
    ...regions.map((region) => region.rect),
    ...strokes.map((stroke) => stroke.bounds),
  ];

  function syncPanels() {
    const any = hasTargets();
    ed.classList.toggle("hidden", !any);
    ed.classList.toggle("flex", any);
    const showStyles = openFlag && selected.length > 0;
    stylePanel.classList.toggle("hidden", !showStyles);
    stylePanel.classList.toggle("block", showStyles);
    submit.disabled = !any || capturing;
    submit.style.opacity = any ? "" : "0.45";
    if (showStyles) for (const refresh of refreshers) refresh();
    if (any && !focusedOnce) {
      focusedOnce = true;
      remark.focus();
    }
  }

  function paintSelections() {
    for (const rec of selected) {
      const attached = rec.element.isConnected;
      rec.box.classList.toggle("hidden", !attached);
      rec.label.classList.toggle("hidden", !attached);
      if (!attached) continue;
      const bounds = rectOf(rec.element);
      placeBox(rec.box, bounds);
      rec.label.style.left = `${Math.max(4, bounds.x)}px`;
      rec.label.style.top = `${Math.max(4, bounds.y - 22)}px`;
    }
  }

  function layoutEditor() {
    layoutFrame = 0;
    paintSelections();
    if (!hasTargets()) return;
    const rectangle = ed.getBoundingClientRect();
    let px: number;
    let py: number;
    if (editorPosition && openFlag) {
      ({ x: px, y: py } = editorPosition);
    } else {
      const edges = unionOf(targetRects()) ?? { x: 0, y: 0, width: 0, height: 0 };
      const candidates = [
        { x: edges.x + edges.width + EDITOR_GAP, y: edges.y },
        { x: edges.x - rectangle.width - EDITOR_GAP, y: edges.y },
        { x: edges.x + edges.width - rectangle.width, y: edges.y + edges.height + EDITOR_GAP },
        { x: edges.x + edges.width - rectangle.width, y: edges.y - rectangle.height - EDITOR_GAP },
      ];
      const overflow = (ch: { x: number; y: number }) =>
        Math.max(0, VIEWPORT_MARGIN - ch.x) +
        Math.max(0, ch.x + rectangle.width - (innerWidth - VIEWPORT_MARGIN)) +
        Math.max(0, VIEWPORT_MARGIN - ch.y) +
        Math.max(0, ch.y + rectangle.height - (innerHeight - VIEWPORT_MARGIN));
      const best = candidates.reduce((current, next) =>
        overflow(next) < overflow(current) ? next : current,
      );
      px = best.x;
      py = best.y;
    }
    ed.style.left = `${clamp(px, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, innerWidth - rectangle.width - VIEWPORT_MARGIN))}px`;
    ed.style.top = `${clamp(py, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, innerHeight - rectangle.height - VIEWPORT_MARGIN))}px`;
  }

  function scheduleLayout() {
    if (finished || layoutFrame !== 0) return;
    layoutFrame = requestAnimationFrame(layoutEditor);
  }

  const isOverlayNode = (target: EventTarget | null) =>
    target === hostInfo || (target instanceof Node && hostInfo.contains(target));
  const insideOverlay = (evt: Event) => evt.composedPath().some((entry) => entry === hostInfo);

  const topElementAt = (px: number, py: number): Element | null => {
    const hit = document.elementFromPoint(px, py);
    if (!hit || isOverlayNode(hit)) return null;
    return hit === document.documentElement || hit === document.body ? null : hit;
  };

  function restoreElement(rec: SelectedElement) {
    const elem = rec.element as HTMLElement;
    for (const [property, base] of rec.baselines) {
      elem.style.setProperty(property, base.value, base.priority);
      changes.delete(`${rec.id}\u0000${property}`);
    }
    rec.baselines.clear();
  }

  function removeSelected(rec: SelectedElement) {
    restoreElement(rec);
    rec.box.remove();
    rec.label.remove();
    selected.splice(selected.indexOf(rec), 1);
  }

  function selectElement(elem: Element, additive: boolean) {
    const existing = selected.find((rec) => rec.element === elem);
    if (existing) {
      removeSelected(existing);
    } else {
      if (!additive) for (const rec of [...selected]) removeSelected(rec);
      const rectangle = h("div", "fixed z-1", {
        style:
          "left:0;top:0;border:2px solid var(--kora-primary);border-radius:3px;background:color-mix(in srgb,var(--kora-primary) 10%,transparent);box-sizing:border-box;",
      });
      const caption = h(
        "div",
        "fixed z-1 max-w-70 overflow-hidden rounded-md bg-primary px-2 py-1 font-sans text-xs font-semibold text-primary-foreground shadow-md",
        { text: describeTag(elem), style: "text-overflow:ellipsis;white-space:nowrap;" },
      );
      overlayRoot.append(rectangle, caption);
      selected.push({
        id: nextId("element"),
        element: elem,
        box: rectangle,
        label: caption,
        baselines: new Map(),
      });
    }
    syncPanels();
    scheduleLayout();
  }

  function strokePath(points: ReadonlyArray<WebMarkupPoint>): string {
    const first = points[0];
    if (!first) return "";
    if (points.length === 1) return `M ${first.x} ${first.y} l 0.01 0.01`;
    let pathData = `M ${first.x} ${first.y}`;
    for (let idx = 1; idx < points.length - 1; idx += 1) {
      const point = points[idx]!;
      const upcoming = points[idx + 1]!;
      pathData += ` Q ${point.x} ${point.y} ${(point.x + upcoming.x) / 2} ${(point.y + upcoming.y) / 2}`;
    }
    const last = points[points.length - 1]!;
    return `${pathData} L ${last.x} ${last.y}`;
  }

  const boundsOfPoints = (points: ReadonlyArray<WebMarkupPoint>): WebMarkupRect => {
    const pad = STROKE_WIDTH + 3;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const leftSide = Math.min(...xs) - pad;
    const upper = Math.min(...ys) - pad;
    return {
      x: leftSide,
      y: upper,
      width: Math.max(...xs) + pad - leftSide,
      height: Math.max(...ys) + pad - upper,
    };
  };

  // --- pointer interaction ---------------------------------------------------------------------------------------

  let marqueeStart: WebMarkupPoint | null = null;
  let drawing: { id: string; points: WebMarkupPoint[]; path: SVGPathElement } | null = null;

  const onPointerDown = (evt: PointerEvent) => {
    if (insideOverlay(evt) || evt.button !== 0) return;
    evt.preventDefault();
    evt.stopPropagation();
    if (tool === "region") {
      marqueeStart = { x: evt.clientX, y: evt.clientY };
    } else if (tool === "draw") {
      const loc = document.createElementNS(SVG_NS, "path");
      const hue = currentTheme?.primary ?? FALLBACK_STROKE_COLOR;
      loc.setAttribute("fill", "none");
      loc.setAttribute("stroke", hue);
      loc.setAttribute("stroke-width", String(STROKE_WIDTH));
      loc.setAttribute("stroke-linecap", "round");
      loc.setAttribute("stroke-linejoin", "round");
      strokeLayer.append(loc);
      drawing = { id: nextId("stroke"), points: [{ x: evt.clientX, y: evt.clientY }], path: loc };
      loc.setAttribute("d", strokePath(drawing.points));
    }
  };

  const onPointerMove = (evt: PointerEvent) => {
    if (insideOverlay(evt)) {
      hoverBox.classList.add("hidden");
      return;
    }
    if (marqueeStart) {
      const leftSide = Math.min(marqueeStart.x, evt.clientX);
      const upper = Math.min(marqueeStart.y, evt.clientY);
      marqueeBox.classList.remove("hidden");
      placeBox(marqueeBox, {
        x: leftSide,
        y: upper,
        width: Math.abs(evt.clientX - marqueeStart.x),
        height: Math.abs(evt.clientY - marqueeStart.y),
      });
    } else if (drawing) {
      drawing.points.push({ x: evt.clientX, y: evt.clientY });
      drawing.path.setAttribute("d", strokePath(drawing.points));
    } else if (tool === "select") {
      const elem = topElementAt(evt.clientX, evt.clientY);
      if (elem) {
        placeBox(hoverBox, rectOf(elem));
        hoverBox.classList.remove("hidden");
      } else {
        hoverBox.classList.add("hidden");
      }
    }
  };

  const leafLike = (elem: Element) =>
    elem.children.length === 0 || elem.matches("button, a, [role=button]");

  function finishMarquee(evt: PointerEvent) {
    const begin = marqueeStart;
    marqueeStart = null;
    marqueeBox.classList.add("hidden");
    if (!begin) return;
    const box = {
      x: Math.min(begin.x, evt.clientX),
      y: Math.min(begin.y, evt.clientY),
      width: Math.abs(evt.clientX - begin.x),
      height: Math.abs(evt.clientY - begin.y),
    };
    if (box.width < MIN_MARQUEE_SIZE || box.height < MIN_MARQUEE_SIZE) return;

    const hits = [...document.body.querySelectorAll("*")]
      .filter((elem) => {
        if (isOverlayNode(elem) || !leafLike(elem)) return false;
        const rectangle = elem.getBoundingClientRect();
        if (rectangle.width < 2 || rectangle.height < 2) return false;
        const cx = rectangle.x + rectangle.width / 2;
        const cy = rectangle.y + rectangle.height / 2;
        const centred =
          cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
        const intersects =
          rectangle.x < box.x + box.width &&
          rectangle.x + rectangle.width > box.x &&
          rectangle.y < box.y + box.height &&
          rectangle.y + rectangle.height > box.y;
        return centred && intersects;
      })
      .sort((left, right) => {
        const area = (ev: Element) =>
          ev.getBoundingClientRect().width * ev.getBoundingClientRect().height;
        return area(left) - area(right);
      })
      .slice(0, MAX_MARQUEE_PICKS);

    if (hits.length === 0) {
      const rectangle = h("div", "fixed z-1", {
        style:
          "left:0;top:0;border:2px solid var(--kora-primary);border-radius:3px;background:color-mix(in srgb,var(--kora-primary) 6%,transparent);box-sizing:border-box;",
      });
      placeBox(rectangle, box);
      overlayRoot.append(rectangle);
      regions.push({ id: nextId("region"), rect: box, box: rectangle });
    } else {
      for (const elem of hits) {
        if (!selected.some((rec) => rec.element === elem)) selectElement(elem, true);
      }
    }
    syncPanels();
    scheduleLayout();
  }

  function finishStroke() {
    const live = drawing;
    drawing = null;
    if (!live) return;
    if (live.points.length < 2) {
      live.path.remove();
      return;
    }
    strokes.push({
      id: live.id,
      color: currentTheme?.primary ?? FALLBACK_STROKE_COLOR,
      width: STROKE_WIDTH,
      points: live.points,
      bounds: boundsOfPoints(live.points),
      path: live.path,
    });
    syncPanels();
    scheduleLayout();
  }

  const onPointerUp = (evt: PointerEvent) => {
    if (insideOverlay(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    if (tool === "region") finishMarquee(evt);
    else if (tool === "draw") finishStroke();
  };

  const inside = (point: WebMarkupPoint, rect: WebMarkupRect) =>
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height;

  const onClick = (evt: MouseEvent) => {
    if (insideOverlay(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    const point = { x: evt.clientX, y: evt.clientY };
    if (tool === "select") {
      const elem = topElementAt(point.x, point.y);
      if (elem) selectElement(elem, evt.shiftKey);
    } else if (tool === "erase") {
      const rec = [...selected].reverse().find((cand) => inside(point, rectOf(cand.element)));
      if (rec) {
        removeSelected(rec);
      } else {
        const region = regions.find((cand) => inside(point, cand.rect));
        if (region) {
          region.box.remove();
          regions.splice(regions.indexOf(region), 1);
        } else {
          const stroke = strokes.find((cand) => inside(point, cand.bounds));
          if (stroke) {
            stroke.path.remove();
            strokes.splice(strokes.indexOf(stroke), 1);
          }
        }
      }
      syncPanels();
      scheduleLayout();
    }
  };

  const onKeyDown = (evt: KeyboardEvent) => {
    if (evt.key === "Escape" && !insideOverlay(evt)) {
      evt.preventDefault();
      finish(true);
    }
  };

  const onViewportChange = () => scheduleLayout();

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);

  // --- submit ----------------------------------------------------------------------------------------------------

  async function send(submission: WebMarkupSubmission) {
    if (finished || capturing || !hasTargets()) return;
    capturing = true;
    submit.disabled = true;
    submit.textContent = "Capturing…";
    try {
      // Everything the annotation carries is copied first: the page keeps running while elements are described.
      const str = remark.value.trim();
      const regionSnapshot = regions.map(({ id, rect }) => ({ id, rect }));
      const strokeSnapshot = strokes.map(({ id, color, width, points, bounds }) => ({
        id,
        color,
        width,
        points: [...points],
        bounds,
      }));
      const styleSnapshot = [...changes.values()];
      const described = await Promise.all(
        selected.map(async (rec) => ({
          id: rec.id,
          element: await describeElement(rec.element),
          rect: rectOf(rec.element),
        })),
      );
      if (finished) return;

      const selectors = new Map(described.map((item) => [item.id, item.element.selector]));
      const annotation: WebMarkupPayload = {
        id: nextId("annotation"),
        pageUrl: location.href,
        pageTitle: document.title.trim() || null,
        comment: str,
        elements: described,
        regions: regionSnapshot,
        strokes: strokeSnapshot,
        styleChanges: styleSnapshot.map((change) => ({
          ...change,
          selector: selectors.get(change.targetId) ?? null,
        })),
        screenshot: null,
        createdAt: new Date().toISOString(),
      };
      const shot = unionOf([
        ...described.map((item) => item.rect),
        ...regionSnapshot.map((item) => item.rect),
        ...strokeSnapshot.map((item) => item.bounds),
      ]);
      const screenshotRect = shot
        ? (() => {
            const leftSide = Math.max(0, shot.x - SHOT_PADDING);
            const upper = Math.max(0, shot.y - SHOT_PADDING);
            const rightSide = Math.min(innerWidth, shot.x + shot.width + SHOT_PADDING);
            const bottom = Math.min(innerHeight, shot.y + shot.height + SHOT_PADDING);
            return { x: leftSide, y: upper, width: rightSide - leftSide, height: bottom - upper };
          })()
        : null;

      // The overlay must not appear in the capture.
      overlayRoot.classList.add("hidden");
      hoverBox.classList.add("hidden");
      ipcRenderer.send(IPC_ELEMENT_PICKED, annotation, screenshotRect, submission);
    } catch {
      finish(true);
    }
  }

  // --- teardown --------------------------------------------------------------------------------------------------

  function finish(notify: boolean) {
    if (finished) return;
    finished = true;
    if (layoutFrame !== 0) cancelAnimationFrame(layoutFrame);
    for (const rec of selected) restoreElement(rec);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
    hostInfo.remove();
    cursorStyle.remove();
    document.documentElement.removeAttribute(TOOL_ATTRIBUTE);
    if (activeSession === sess) {
      activeSession = null;
      applyThemeToOverlay = null;
    }
    if (notify) ipcRenderer.send(IPC_ELEMENT_PICKED, null);
  }

  const sess = { finish };
  activeSession = sess;
  document.documentElement.append(hostInfo);
  document.head.append(cursorStyle);
  setTool("select");
  syncPanels();
}

ipcRenderer.on(IPC_START_PICK, (_evt, palette?: ShellWebMarkupTheme) => startMarkup(palette));
ipcRenderer.on(IPC_MARKUP_THEME, (_evt, palette: ShellWebMarkupTheme) => {
  currentTheme = palette;
  applyThemeToOverlay?.(palette);
});
ipcRenderer.on(IPC_CANCEL_PICK, () => activeSession?.finish(false));
ipcRenderer.on(IPC_MARKUP_CAPTURED, () => activeSession?.finish(false));
