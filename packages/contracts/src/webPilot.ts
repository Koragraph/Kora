import * as Schema from "effect/Schema";

import { HostId, NonblankString } from "./primitives.ts";
import {
  WEB_VIEWPORT_MAX_AREA,
  WebTabId,
  WebViewportPresetId,
  WebViewportSize,
} from "./webPreview.ts";

// Agent-driven preview automation is gone. What remains: the navigation target a
// browser pane resolves, the resolution it reports back, and the resize request
// shape the viewport helpers still take.

const BoundedUrl = NonblankString.check(Schema.isMaxLength(2048));

export const BrowserNavigationTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("url"), url: BoundedUrl }),
  Schema.Struct({
    kind: Schema.Literal("environment-port"),
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    protocol: Schema.optionalKey(Schema.Literals(["http", "https"])),
    path: Schema.optionalKey(Schema.String),
  }),
]);
export type BrowserNavigationTarget = typeof BrowserNavigationTarget.Type;

export const WebUrlResolution = Schema.Struct({
  resolutionKind: Schema.Literals(["direct", "direct-private-network"]),
  resolvedUrl: Schema.String,
  requestedUrl: Schema.String,
  hostId: HostId,
});
export type WebUrlResolution = typeof WebUrlResolution.Type;

const fillInputError = "Fill mode does not accept a preset, dimensions, or orientation.";

export const WebPilotResizeInput = Schema.Struct({
  tabId: Schema.optionalKey(WebTabId),
  mode: Schema.Literals(["fill", "freeform", "preset"]),
  preset: Schema.optionalKey(WebViewportPresetId),
  width: Schema.optionalKey(WebViewportSize.fields.width),
  height: Schema.optionalKey(WebViewportSize.fields.height),
  orientation: Schema.optionalKey(Schema.Literals(["portrait", "landscape"])),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
  ),
}).check(
  Schema.makeFilter((input) => {
    const [hasWidth, hasHeight] = [input.width, input.height].map((side) => side !== undefined);
    if (hasWidth !== hasHeight) return "Custom dimensions require both width and height.";
    const hasDimensions = hasWidth;
    if (input.mode === "fill") {
      return input.preset !== undefined || hasDimensions || input.orientation !== undefined
        ? fillInputError
        : undefined;
    }
    if (input.mode === "freeform") {
      return !hasDimensions || input.preset !== undefined || input.orientation !== undefined
        ? "Freeform mode requires width and height and does not accept a preset or orientation."
        : undefined;
    }
    if (input.preset === undefined || hasDimensions) {
      return "Preset mode requires a preset and does not accept custom dimensions.";
    }
    return undefined;
  }),
  Schema.makeFilter((input) =>
    input.width !== undefined &&
    input.height !== undefined &&
    input.width * input.height > WEB_VIEWPORT_MAX_AREA
      ? `Custom viewport area must not exceed ${WEB_VIEWPORT_MAX_AREA} pixels.`
      : undefined,
  ),
);
export type WebPilotResizeInput = typeof WebPilotResizeInput.Type;
