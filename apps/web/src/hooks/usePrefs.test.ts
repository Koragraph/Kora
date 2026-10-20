import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_PREFS, type ClientPrefs } from "@kora/contracts/clientPrefs";
import { AgentId, AgentProfileId, DEFAULT_DAEMON_PREFS } from "@kora/contracts";

const storage = vi.hoisted(() => ({
  setClientPrefs: vi.fn<(prefs: ClientPrefs) => Promise<void>>(),
  getClientPrefs: vi.fn<() => Promise<ClientPrefs | null>>(),
}));

vi.mock("~/localApi", () => ({
  localApiOrThrow: () => ({ persistence: storage }),
}));

import {
  __resetClientPrefsPersistenceForTests,
  __setClientPrefsForTests,
  ensureClientPrefsHydrated,
  getClientPrefs,
  mergeHostPrefs,
  persistClientPrefsPatch,
  resolveHostIdentificationMode,
} from "./usePrefs";

/** A promise plus the handles to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  storage.getClientPrefs.mockReset().mockResolvedValue(null);
  storage.setClientPrefs.mockReset().mockResolvedValue(undefined);
  __resetClientPrefsPersistenceForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mergeHostPrefs", () => {
  it("lets server-owned values override stale keys in old client data", () => {
    const server = {
      ...DEFAULT_DAEMON_PREFS,
      sidebarAutoSettleAfterDays: 30,
      sidebarAutoSettleOnMerge: false,
    };
    const staleClient = {
      ...DEFAULT_CLIENT_PREFS,
      sidebarAutoSettleAfterDays: 2,
      sidebarAutoSettleOnMerge: true,
    };

    expect(mergeHostPrefs(server, staleClient)).toMatchObject({
      sidebarAutoSettleAfterDays: 30,
      sidebarAutoSettleOnMerge: false,
    });
  });

  it("exposes server and client fields side by side, by reference", () => {
    const server = {
      ...DEFAULT_DAEMON_PREFS,
      providerInstances: {
        [AgentProfileId.make("codex_lab")]: { enabled: true, driver: AgentId.make("codex") },
      },
    };
    const client = {
      ...DEFAULT_CLIENT_PREFS,
      favorites: [{ model: "gpt-5.5", provider: AgentProfileId.make("codex_lab") }],
    };

    const merged = mergeHostPrefs(server, client);

    expect(merged.providerInstances).toBe(server.providerInstances);
    expect(merged.favorites).toBe(client.favorites);
  });
});

describe("resolveHostIdentificationMode", () => {
  type Args = Parameters<typeof resolveHostIdentificationMode>[0];

  it.each<[string, Args, string]>([
    [
      "hides everything before hydration (artwork)",
      { mode: "artwork", settingsHydrated: false },
      "none",
    ],
    ["hides everything before hydration (pill)", { mode: "pill", settingsHydrated: false }, "none"],
    ["passes pill through once hydrated", { mode: "pill", settingsHydrated: true }, "pill"],
    [
      "passes artwork through with no palette theme",
      { mode: "artwork", settingsHydrated: true },
      "artwork",
    ],
    [
      "keeps artwork for a theme that allows it",
      {
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      },
      "artwork",
    ],
    [
      "swaps artwork for a pill under a custom theme",
      { mode: "artwork", settingsHydrated: true, paletteThemeActive: true },
      "pill",
    ],
    [
      "leaves an explicit none alone under a custom theme",
      { mode: "none", settingsHydrated: true, paletteThemeActive: true },
      "none",
    ],
    [
      "leaves a pill alone under a custom theme",
      { mode: "pill", settingsHydrated: true, paletteThemeActive: true },
      "pill",
    ],
  ])("%s", (_label, args, expected) => {
    expect(resolveHostIdentificationMode(args)).toBe(expected);
  });
});

describe("persistClientPrefsPatch", () => {
  it("saves each whole document one write at a time, in call order", async () => {
    __setClientPrefsForTests(DEFAULT_CLIENT_PREFS);
    const firstWrite = deferred<void>();
    const firstWriteBegan = deferred<void>();
    storage.setClientPrefs.mockImplementationOnce(() => {
      firstWriteBegan.resolve();
      return firstWrite.promise;
    });

    const afterOne = { ...DEFAULT_CLIENT_PREFS, captureFlash: false };
    const afterTwo = { ...afterOne, capturePlaySound: false };
    const one = persistClientPrefsPatch({ captureFlash: false });
    await firstWriteBegan.promise;
    const two = persistClientPrefsPatch({ capturePlaySound: false });

    // The in-memory value is already updated; the second save waits its turn.
    expect(storage.setClientPrefs).toHaveBeenCalledTimes(1);
    expect(getClientPrefs()).toEqual(afterTwo);

    firstWrite.resolve();
    await Promise.all([one, two]);

    expect(storage.setClientPrefs.mock.calls).toEqual([[afterOne], [afterTwo]]);
  });

  it("logs a failed save instead of rejecting, and later saves still go out", async () => {
    __setClientPrefsForTests(DEFAULT_CLIENT_PREFS);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    storage.setClientPrefs.mockRejectedValueOnce(new Error("disk full"));

    await expect(persistClientPrefsPatch({ wordWrap: false })).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(
      "[client prefs] persist failed",
      expect.objectContaining({ operation: "persist" }),
    );

    await persistClientPrefsPatch({ captureFlash: false });
    expect(storage.setClientPrefs).toHaveBeenCalledTimes(2);
    expect(storage.setClientPrefs).toHaveBeenLastCalledWith({
      ...DEFAULT_CLIENT_PREFS,
      wordWrap: false,
      captureFlash: false,
    });
  });
});

describe("hydration of saved client preferences", () => {
  const saved: ClientPrefs = {
    ...DEFAULT_CLIENT_PREFS,
    timestampFormat: "12-hour",
    favorites: [{ provider: AgentProfileId.make("codex_saved"), model: "gpt-5.5" }],
  };

  it("resolves immediately with no I/O when storage has nothing saved, keeping defaults", async () => {
    await ensureClientPrefsHydrated();
    expect(getClientPrefs()).toBe(DEFAULT_CLIENT_PREFS);
    await ensureClientPrefsHydrated();
    expect(storage.getClientPrefs).toHaveBeenCalledTimes(1);
  });

  it("layers saved values over the defaults", async () => {
    storage.getClientPrefs.mockResolvedValue({ timestampFormat: "12-hour" } as ClientPrefs);
    await ensureClientPrefsHydrated();
    expect(getClientPrefs()).toEqual({ ...DEFAULT_CLIENT_PREFS, timestampFormat: "12-hour" });
  });

  it("defers a write until the in-flight read finishes, then applies it on top of the saved data", async () => {
    const read = deferred<ClientPrefs>();
    storage.getClientPrefs.mockImplementationOnce(() => read.promise);
    const written = deferred<ClientPrefs>();
    storage.setClientPrefs.mockImplementationOnce(async (prefs) => written.resolve(prefs));

    const hydration = ensureClientPrefsHydrated();
    void persistClientPrefsPatch({ wordWrap: false });
    expect(getClientPrefs()).toBe(DEFAULT_CLIENT_PREFS);
    expect(storage.setClientPrefs).not.toHaveBeenCalled();

    read.resolve(saved);
    await hydration;

    await expect(written.promise).resolves.toEqual({ ...saved, wordWrap: false });
    expect(storage.getClientPrefs).toHaveBeenCalledOnce();
  });

  it("never writes defaults over saved data when the read fails, and recovers on retry", async () => {
    const boom = new Error("storage offline");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    storage.getClientPrefs.mockRejectedValue(boom);

    const failing = ensureClientPrefsHydrated();
    void persistClientPrefsPatch({ wordWrap: false });
    await expect(failing).rejects.toBe(boom);
    expect(storage.setClientPrefs).not.toHaveBeenCalled();

    storage.getClientPrefs.mockResolvedValue(saved);
    const written = deferred<ClientPrefs>();
    storage.setClientPrefs.mockImplementationOnce(async (prefs) => written.resolve(prefs));
    void persistClientPrefsPatch({ wordWrap: false });

    await expect(written.promise).resolves.toEqual({ ...saved, wordWrap: false });
  });
});
