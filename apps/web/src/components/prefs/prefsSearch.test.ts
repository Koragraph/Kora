import { describe, expect, it, vi } from "vite-plus/test";

import {
  filterAvailablePrefsSearchItems,
  getPrefsSearchTargetScope,
  isPrefsOverviewVisible,
  isPrefsSearchScopeAvailable,
  PREFS_SEARCH_ITEMS,
  PREFS_SECTION_LABELS,
  searchableSetting,
  searchPrefs,
  type PrefsSearchItem,
} from "./prefsSearch";

const catalog: ReadonlyArray<PrefsSearchItem> = PREFS_SEARCH_ITEMS;
const idsOf = (items: ReadonlyArray<{ id: string }>) => items.map((item) => item.id);

/** A tiny catalog for ranking tests, independent of the real settings. */
const sampleItems: ReadonlyArray<PrefsSearchItem> = [
  { id: "auto-sync", to: "/settings/general", title: "Background sync" },
  { id: "sync-schedule", to: "/settings/general", title: "Sync schedule" },
  {
    id: "assistants",
    to: "/settings/providers",
    title: "Assistants",
    searchTerms: ["anthropic openai assistants"],
  },
  {
    id: "line-wrap",
    to: "/settings/general",
    title: "Line wrapping",
    searchTerms: ["very long lines in previews"],
  },
];

describe("the search catalog", () => {
  it("has unique ids", () => {
    expect(new Set(idsOf(catalog)).size).toBe(catalog.length);
  });

  it("no longer lists the removed browser-access or quit-confirmation rows", () => {
    expect(idsOf(catalog)).not.toContain("agent-browser-access");
    expect(idsOf(catalog)).not.toContain("quit-confirmation");
    expect(searchPrefs("agent browser access")[0]?.id).not.toBe("agent-browser-access");
  });

  describe("every entry is reachable", () => {
    // Settings pages and routes as raw text: an entry only works if a page renders the anchor it points at.
    const pageSources = Object.values(
      import.meta.glob(["./**/*.tsx", "../../routes/settings*.tsx", "!./**/*.test.tsx"], {
        eager: true,
        import: "default",
        query: "?raw",
      }) as Record<string, string>,
    ).join("\n");

    it.each(catalog.map((item) => [item.id, item] as const))(
      "%s has an anchor on a labelled page",
      (_id, item) => {
        const anchor = item.targetId ?? item.id;
        // It must be an element id: the same word appearing as, say, a scope name is no anchor.
        const rendered =
          pageSources.includes(`searchableSetting("${anchor}")`) ||
          pageSources.includes(`id="${anchor}"`);
        expect(rendered, `no settings page renders an element with id "${anchor}"`).toBe(true);
        expect(PREFS_SECTION_LABELS[item.to]).toBeDefined();
      },
    );
  });

  describe("section pages vs. the app shell", () => {
    // AppNavLayout redirects any /settings/<page> it doesn't list back to Defaults, so new pages must be added there.
    const shellSource = Object.values(
      import.meta.glob("../AppNavLayout.tsx", {
        eager: true,
        import: "default",
        query: "?raw",
      }) as Record<string, string>,
    ).join("\n");

    it.each(Object.keys(PREFS_SECTION_LABELS))("%s is listed by the shell", (path) => {
      const page = path.split("/")[2]!;
      expect(shellSource.includes(`"${page}"`), `AppNavLayout SETTINGS_PAGES lacks "${page}"`).toBe(
        true,
      );
    });
  });
});

describe("searchableSetting", () => {
  it.each([
    ["time-format", { id: "time-format", title: "Clock" }],
    ["default-model", { id: "default-model", title: "Default model" }],
  ])("returns anchor props for %s", (id, expected) => {
    expect(searchableSetting(id as never)).toEqual(expected);
  });
});

describe("sidebar overview visibility", () => {
  it.each([
    [{}, false],
    [{ machine: "box" }, false],
    [{ project: "site" }, true],
    [{ project: "site", checkout: "site@main" }, true],
  ])("scope %j -> %s", (scope, visible) => {
    expect(isPrefsOverviewVisible(scope)).toBe(visible);
  });
});

describe("which scopes can edit a searched setting", () => {
  it.each(["all", "environment", "project", "checkout"] as const)(
    "project defaults are editable at the %s scope but not at an unavailable one",
    (kind) => {
      const { scope } = getPrefsSearchTargetScope("default-permissions")!;
      expect(isPrefsSearchScopeAvailable(scope, kind)).toBe(true);
      expect(isPrefsSearchScopeAvailable(scope, "unavailable")).toBe(false);
    },
  );

  it("treats a device-local setting as reachable from any selection", () => {
    const target = getPrefsSearchTargetScope("time-format")!;
    expect(target).toEqual({ title: "Clock", scope: null });
    for (const kind of ["project", "all"] as const) {
      expect(isPrefsSearchScopeAvailable(target.scope, kind)).toBe(true);
    }
  });

  it("returns null for an unknown setting", () => {
    expect(getPrefsSearchTargetScope("no-such-setting")).toBeNull();
  });
});

describe("availability filtering", () => {
  const baseline = { hasHost: true, hasProviderSettingsHost: true };

  it("offers Swarm unless the environments explicitly lack it", () => {
    const swarmListed = (extra: { hasSwarm?: boolean }) =>
      idsOf(filterAvailablePrefsSearchItems({ ...baseline, ...extra })).includes("swarm");

    expect(swarmListed({ hasSwarm: false })).toBe(false);
    expect(swarmListed({ hasSwarm: true })).toBe(true);
    expect(swarmListed({})).toBe(true);
  });

  it("drops host-bound settings when there is no host at all", () => {
    const available = filterAvailablePrefsSearchItems({
      hasSwarm: false,
      hasProviderSettingsHost: false,
      hasHost: false,
    });
    expect(idsOf(available)).not.toContain("swarm");
  });
});

describe("searchPrefs against the real catalog", () => {
  it.each([
    ["project overview", "project-overview", "/settings/projects"],
    ["actions", "project-actions", "/settings/projects"],
    ["default model", "default-model", "/settings/general"],
    ["trim big command output", "bash-trim", "/settings/token-savings"],
    ["keep cache warm", "cache-warm", "/settings/token-savings"],
    ["token savings", "token-savings", "/settings/token-savings"],
    ["swarm", "swarm", "/settings/swarm"],
  ])("sends %j to %s under %s", (query, id, to) => {
    expect(searchPrefs(query)[0]).toMatchObject({ id, to });
  });

  it("titles the Swarm result 'Swarm'", () => {
    expect(searchPrefs("swarm")[0]).toMatchObject({ title: "Swarm" });
  });

  it.each(["swarm", "opencode free models", "openrouter key", "cerebras", "privacy consent"])(
    "finds the Swarm page with %j",
    (query) => {
      expect(idsOf(searchPrefs(query))).toContain("swarm");
    },
  );

  it("finds a setting through words only its section used to carry", () => {
    expect(searchPrefs("codex")[0]?.id).toBe("providers");
  });

  it("lists both thread confirmations, in the order the panel shows them", () => {
    expect(idsOf(searchPrefs("confirmation"))).toEqual([
      "archive-confirmation",
      "delete-confirmation",
    ]);
  });

  it("matches titles regardless of case and spacing", () => {
    expect(idsOf(searchPrefs("  TIME   FORMAT  "))).toEqual(["time-format"]);
  });

  it("ignores combining marks on the query", () => {
    expect(searchPrefs("swàrm\u{1ab0}")[0]?.id).toBe("swarm");
  });

  it("lower-cases without the locale, so a patched toLocaleLowerCase has no effect", () => {
    const patched = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("swarm");
    try {
      expect(searchPrefs("SWARM")[0]?.id).toBe("swarm");
      expect(patched).not.toHaveBeenCalled();
    } finally {
      patched.mockRestore();
    }
  });

  it("returns nothing for gibberish", () => {
    expect(searchPrefs("xyzzy")).toEqual([]);
  });

  it("hides macOS-only settings when the platform is not a Mac", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    try {
      expect(searchPrefs("font smoothing")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hides desktop-only settings from browser search", () => {
    expect(searchPrefs("hold to quit")).toEqual([]);
    expect(searchPrefs("wsl")).toEqual([]);
  });
});

describe("searchPrefs ranking and matching on a small catalog", () => {
  it("returns nothing for a blank query", () => {
    expect(searchPrefs("   ", sampleItems)).toEqual([]);
  });

  it("matches words spread over title and search terms", () => {
    expect(idsOf(searchPrefs("assistants anthropic", sampleItems))).toEqual(["assistants"]);
  });

  it.each([
    ["a word in the title", "wrapping", ["line-wrap"]],
    ["a word only in the search terms", "openai", ["assistants"]],
    ["a phrase in the search terms", "long lines", ["line-wrap"]],
    ["a differently-cased, padded title phrase", "  LINE   WRAPPING  ", ["line-wrap"]],
  ])("finds an item by %s", (_label, query, expected) => {
    expect(idsOf(searchPrefs(query, sampleItems))).toEqual(expected);
  });

  it("puts a title that starts with the query ahead of one that merely contains it", () => {
    expect(idsOf(searchPrefs("sync", sampleItems))).toEqual(["sync-schedule", "auto-sync"]);
  });
});
