import { describe, expect, it } from "vite-plus/test";

import { IS_PRO_EDITION } from "../../branding";
import { filterAvailablePrefsSearchItems } from "./prefsSearch";
import { Route } from "../../routes/settings.usage";

describe("plan usage in the free edition", () => {
  it("Settings › Usage is reachable and searchable in Free", () => {
    expect(IS_PRO_EDITION).toBe(false);
    expect((Route.options as { beforeLoad?: unknown }).beforeLoad).toBeUndefined();
    const items = filterAvailablePrefsSearchItems({ hasHost: true, hasProviderSettingsHost: true });
    expect(items.some((i) => i.to === "/settings/usage")).toBe(true);
  });
});
