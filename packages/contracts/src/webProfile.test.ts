import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import * as Profiles from "./webProfile.ts";

const mine = (
  id: string,
  name = id,
  kind: "persistent" | "incognito" = "persistent",
): Profiles.WebProfile => ({
  id,
  name,
  kind,
});

const ids = (list: ReadonlyArray<Profiles.WebProfile>) => list.map(({ id }) => id);

describe("web profile list", () => {
  it("puts the built-ins first, then the user's profiles", () => {
    const personal = mine("p-personal", "Personal");
    expect(ids(Profiles.resolveWebProfiles([personal]))).toEqual([
      Profiles.DEFAULT_WEB_PROFILE_ID,
      Profiles.PRIVATE_WEB_PROFILE_ID,
      personal.id,
    ]);
  });

  // Built-ins are synthesized, never stored: a hand-edited file must not swap the Default
  // partition (and with it every open Default tab) for a profile of its own.
  it("ignores stored profiles that reuse a built-in id", () => {
    const personal = mine("p-personal");
    const resolved = Profiles.resolveWebProfiles([
      personal,
      mine(Profiles.PRIVATE_WEB_PROFILE_ID, "Not private at all"),
      mine(Profiles.DEFAULT_WEB_PROFILE_ID, "Impostor"),
    ]);
    expect(resolved).toEqual([...Profiles.BUILT_IN_BROWSER_PROFILES, personal]);
  });

  // Two entries with one id share one partition, so showing both would fake isolation.
  it("keeps the first of two profiles with one id", () => {
    const resolved = Profiles.resolveWebProfiles([mine("p-x", "First"), mine("p-x", "Second")]);
    expect(resolved.filter(({ id }) => id === "p-x")).toEqual([mine("p-x", "First")]);
  });

  // Only the built-in private id gets a throwaway partition; anything else keeps cookies.
  it("reports a user profile that claims to be incognito as persistent", () => {
    const resolved = Profiles.resolveWebProfiles([mine("p-temp", "Temp", "incognito")]);
    expect(resolved.find(({ id }) => id === "p-temp")).toEqual(mine("p-temp", "Temp"));
  });

  it("keeps the built-in private profile incognito", () => {
    const builtIn = Profiles.resolveWebProfiles([]).find(
      ({ id }) => id === Profiles.PRIVATE_WEB_PROFILE_ID,
    );
    expect(builtIn?.kind).toBe("incognito");
  });
});

describe("web profile ids", () => {
  // Ids end up in delimiter-joined cache keys, so a control character could alias another profile.
  it("refuse control characters", () => {
    const isId = Schema.is(Profiles.WebProfileId);
    expect([isId("p-ok"), isId("p-\u0001bad")]).toEqual([true, false]);
  });
});
