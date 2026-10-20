import {
  type WebViewportSetting,
  type WebProfile,
  type WebAppearancePreference,
  type ShellWebTabDefaults,
  resolveWebProfiles,
  DEFAULT_WEB_PROFILE_ID,
} from "@kora/contracts";

import { ensureClientPrefsHydrated, getClientPrefs, useClientPrefs } from "~/hooks/usePrefs";
import { resolveResponsiveBrowserViewportSize } from "./browserViewportLayout";

export interface BrowserDefaults {
  readonly viewport: WebViewportSetting;
  readonly zoomFactor: number;
  readonly appearance: WebAppearancePreference;
  readonly profiles: ReadonlyArray<WebProfile>;
  readonly profileId: string;
}

type PrefsSnapshot = ReturnType<typeof getClientPrefs>;

function fromPrefs(prefsObj: PrefsSnapshot): BrowserDefaults {
  const profiles = resolveWebProfiles(prefsObj.browserProfiles);
  const configured = profiles.find((profile) => profile.id === prefsObj.browserDefaultProfileId);
  // Incognito as a default would open every new tab signed out.
  const profileId =
    configured && configured.kind !== "incognito" ? configured.id : DEFAULT_WEB_PROFILE_ID;
  return {
    viewport: prefsObj.browserDefaultViewport,
    zoomFactor: prefsObj.browserDefaultZoomFactor,
    appearance: prefsObj.browserDefaultAppearance,
    profiles,
    profileId,
  };
}

export const getBrowserDefaults = (): BrowserDefaults => fromPrefs(getClientPrefs());

/** Before hydration the snapshot holds schema defaults, which a tab would then keep forever. */
export async function resolveBrowserDefaults(): Promise<BrowserDefaults> {
  await ensureClientPrefsHydrated();
  return getBrowserDefaults();
}

export function usePreviewDefaults(): BrowserDefaults {
  return fromPrefs({
    browserDefaultViewport: useClientPrefs((prefs) => prefs.browserDefaultViewport),
    browserDefaultZoomFactor: useClientPrefs((prefs) => prefs.browserDefaultZoomFactor),
    browserDefaultAppearance: useClientPrefs((prefs) => prefs.browserDefaultAppearance),
    browserProfiles: useClientPrefs((prefs) => prefs.browserProfiles),
    browserDefaultProfileId: useClientPrefs((prefs) => prefs.browserDefaultProfileId),
  } as PrefsSnapshot);
}

export const browserDefaultTabState = (
  baseline: BrowserDefaults = getBrowserDefaults(),
): ShellWebTabDefaults => ({
  zoomFactor: baseline.zoomFactor,
  colorScheme: baseline.appearance,
});

export const browserDefaultOpenViewport = (
  baseline: BrowserDefaults = getBrowserDefaults(),
): WebViewportSetting => baseline.viewport;

export const browserDefaultOpenProfileId = (
  baseline: BrowserDefaults = getBrowserDefaults(),
): string => baseline.profileId;

export const FALLBACK_RESPONSIVE_VIEWPORT_SIZE = { width: 1024, height: 768 } as const;

/** The viewport to adopt when the device toolbar is switched on for a tab that fills its panel. */
export function browserResponsiveViewportForToggle(args: {
  defaults?: BrowserDefaults;
  panelRect: { width: number; height: number } | null;
  zoomFactor: number | undefined;
}): WebViewportSetting {
  const configured = (args.defaults ?? getBrowserDefaults()).viewport;
  if (configured._tag !== "fill") return configured;
  const extent = args.panelRect
    ? resolveResponsiveBrowserViewportSize(args.panelRect, args.zoomFactor)
    : FALLBACK_RESPONSIVE_VIEWPORT_SIZE;
  return { _tag: "freeform", width: extent.width, height: extent.height };
}
