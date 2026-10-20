import type { WebPilotResizeInput, WebViewportPresetId, WebViewportSetting } from "@kora/contracts";
import { WEB_VIEWPORT_PRESET_IDS } from "@kora/contracts";

type ViewportCategory = "Desktop" | "Tablet" | "Phone";

export interface WebViewportPreset {
  readonly id: WebViewportPresetId;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly category: ViewportCategory;
  readonly detail: string;
}

type WebViewportPresetDefinition = Omit<WebViewportPreset, "id">;

function device(
  label: string,
  category: ViewportCategory,
  width: number,
  height: number,
): WebViewportPresetDefinition {
  return { label, width, height, category, detail: `${width} × ${height}` };
}

// Keep this in Chrome DevTools' default-device order. Dimensions are CSS
// viewport sizes from Chromium's EmulatedDevices.ts standard catalog.
const WEB_VIEWPORT_PRESET_DEFINITIONS: Record<WebViewportPresetId, WebViewportPresetDefinition> = {
  "iphone-se": device("iPhone SE", "Phone", 375, 667),
  "iphone-xr": device("iPhone XR", "Phone", 414, 896),
  "iphone-12-pro": device("iPhone 12 Pro", "Phone", 390, 844),
  "iphone-14-pro-max": device("iPhone 14 Pro Max", "Phone", 430, 932),
  "pixel-7": device("Pixel 7", "Phone", 412, 915),
  "samsung-galaxy-s8-plus": device("Samsung Galaxy S8+", "Phone", 360, 740),
  "samsung-galaxy-s20-ultra": device("Samsung Galaxy S20 Ultra", "Phone", 412, 915),
  "ipad-mini": device("iPad Mini", "Tablet", 768, 1024),
  "ipad-air": device("iPad Air", "Tablet", 820, 1180),
  "ipad-pro": device("iPad Pro", "Tablet", 1024, 1366),
  "surface-pro-7": device("Surface Pro 7", "Tablet", 912, 1368),
  "surface-duo": device("Surface Duo", "Phone", 540, 720),
  "galaxy-z-fold-5": device("Galaxy Z Fold 5", "Phone", 344, 882),
  "asus-zenbook-fold": device("Asus Zenbook Fold", "Tablet", 853, 1280),
  "samsung-galaxy-a51-71": device("Samsung Galaxy A51/71", "Phone", 412, 914),
  "nest-hub": device("Nest Hub", "Tablet", 1024, 600),
  "nest-hub-max": device("Nest Hub Max", "Tablet", 1280, 800),
};

export const WEB_VIEWPORT_PRESETS: ReadonlyArray<WebViewportPreset> = WEB_VIEWPORT_PRESET_IDS.map(
  (id) => Object.assign({ id }, WEB_VIEWPORT_PRESET_DEFINITIONS[id]),
);

export function resolveWebViewport(input: WebPilotResizeInput): WebViewportSetting {
  if (input.mode === "fill") return { _tag: "fill" };
  if (input.mode === "preset" && input.preset !== undefined) {
    const chosen = WEB_VIEWPORT_PRESETS.find((entry) => entry.id === input.preset);
    if (!chosen) throw new Error(`Unknown preview viewport preset: ${input.preset}`);
    const naturallyTall = chosen.height >= chosen.width;
    const flip =
      (input.orientation === "landscape" && naturallyTall) ||
      (input.orientation === "portrait" && !naturallyTall);
    const [width, height] = flip ? [chosen.height, chosen.width] : [chosen.width, chosen.height];
    return { _tag: "preset", width, height, presetId: chosen.id };
  }
  if (input.width === undefined || input.height === undefined) {
    throw new Error("Custom preview viewport requires width and height");
  }
  return { _tag: "freeform", width: input.width, height: input.height };
}
