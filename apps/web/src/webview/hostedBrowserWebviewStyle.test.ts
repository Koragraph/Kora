import { describe, expect, test } from "vite-plus/test";

import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

type Input = Parameters<typeof resolveHostedBrowserWebviewWrapperStyle>[0];

const HIDDEN = { width: 1280, height: 800 };
const SHOWN = { x: 12, y: 34, width: 800, height: 600 };
const style = (input: Partial<Input>) =>
  resolveHostedBrowserWebviewWrapperStyle({
    hiddenSize: HIDDEN,
    rect: null,
    renderingActive: false,
    active: false,
    ...input,
  });

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  test("a paintable-but-inactive webview is visible yet parked off-screen at its hidden size", () => {
    expect(style({ keepPaintableWhenInactive: true })).toEqual({
      visibility: "visible",
      pointerEvents: "none",
      zIndex: -1,
      width: 1280,
      height: 800,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    });
  });

  test("a background task that is rendering stays at the origin behind the app", () => {
    expect(style({ renderingActive: true })).toEqual({
      visibility: "visible",
      pointerEvents: "none",
      zIndex: -1,
      width: 1280,
      height: 800,
      top: 0,
      left: 0,
    });
  });

  test("an inactive webview with a stale rect is hidden and parked, using its hidden size", () => {
    expect(style({ hiddenSize: { width: 393, height: 852 }, rect: SHOWN })).toEqual({
      visibility: "hidden",
      pointerEvents: "none",
      zIndex: -1,
      width: 393,
      height: 852,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    });
  });

  test("an active webview sits exactly on its surface and takes pointer input", () => {
    expect(style({ rect: SHOWN, renderingActive: true, active: true })).toEqual({
      pointerEvents: "auto",
      zIndex: 30,
      width: 800,
      height: 600,
      top: 34,
      left: 12,
    });
  });

  test("a floating webview adopts the requested layer and rounded corners", () => {
    expect(
      style({
        rect: { x: 12, y: 34, width: 360, height: 203 },
        zIndex: 48,
        cornerRadius: 12,
        renderingActive: true,
        active: true,
      }),
    ).toMatchObject({ zIndex: 48, borderRadius: 12, width: 360, height: 203, top: 34, left: 12 });
  });
});
