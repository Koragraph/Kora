import { it as effectIt } from "@effect/vitest";
import { DEFAULT_WEB_PROFILE_ID, PRIVATE_WEB_PROFILE_ID } from "@kora/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import * as WebManager from "../../web/Manager.ts";
import { registerWebview, resolvePartitionScope } from "./webTabs.ts";

// Electron refuses sessions before `ready`; touching one at import time would crash the app's start.
const sessionsAsked = vi.hoisted(() => ({ count: 0 }));
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { fromId: () => null },
  session: {
    fromPartition: () => {
      sessionsAsked.count++;
      throw new Error("not ready");
    },
  },
}));

describe("which browser session a preview tab uses", () => {
  it("loading the module asks Electron for no session", () => {
    expect(sessionsAsked.count).toBe(0);
  });

  it.each([
    ["the default profile, by default", undefined, { scope: "proj::7", persistent: true }],
    ["the default profile, by id", DEFAULT_WEB_PROFILE_ID, { scope: "proj::7", persistent: true }],
    [
      "a private profile, kept in memory only",
      PRIVATE_WEB_PROFILE_ID,
      { scope: '["proj::7","incognito"]', persistent: false, namespace: "profile" },
    ],
    [
      "a named profile",
      "work",
      { scope: '["proj::7","work"]', persistent: true, namespace: "profile" },
    ],
  ])("%s", (_, profile, expected) => {
    expect(resolvePartitionScope("proj::7", profile)).toEqual(expected);
  });

  it("is never shared by two different (owner, profile) pairs", () => {
    const pairs: Array<[string, string]> = [
      ["a", "b::c"],
      ["a::b", "c"],
      // Unpaired surrogates stay distinct instead of all collapsing into U+FFFD.
      ["owner", "p\ud800"],
      ["owner", "p\udc00"],
      ["owner", "p�"],
    ];
    const scopes = pairs.map(([owner, profile]) => resolvePartitionScope(owner, profile).scope);
    expect(new Set(scopes).size).toBe(pairs.length);
    expect(scopes[2]).toBe('["owner","p\\ud800"]');
  });
});

effectIt.effect("a webview id that cannot exist is refused before any preview work starts", () =>
  Effect.gen(function* () {
    const exit = yield* registerWebview
      .handler({ tabId: "t", webContentsId: 0 })
      .pipe(Effect.provideService(WebManager.WebManager, {} as never), Effect.exit);
    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(Schema.isSchemaError(failure)).toBe(true);
    expect(sessionsAsked.count).toBe(0);
  }),
);
