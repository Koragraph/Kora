import { afterEach, expect, test, vi } from "vite-plus/test";

const realWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  if (realWindow === undefined) Reflect.deleteProperty(globalThis, "window");
  else globalThis.window = realWindow;
});

test("branding comes from the desktop shell when it provides one", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      shellBridge: {
        getAppBranding: () => ({ baseName: "Kora", stageLabel: "Dev", displayName: "Kora (Dev)" }),
      },
    },
  });

  const { APP_BASE_NAME, APP_STAGE_LABEL, APP_DISPLAY_NAME } = await import("./branding");

  expect([APP_BASE_NAME, APP_STAGE_LABEL, APP_DISPLAY_NAME]).toEqual(["Kora", "Dev", "Kora (Dev)"]);
});
