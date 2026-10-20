import { describe, expect, it } from "@effect/vitest";

import { extractToolActivityPresentation as presentationOf } from "./toolPresentation.ts";

describe("tool activity presentation", () => {
  it("passes a website icon and a themed-logo source through unchanged", () => {
    const fields = {
      toolSurface: "browser",
      toolIcon: {
        _tag: "website",
        pageUrl: "https://docs.test/guide",
        faviconUrl: "https://docs.test/icon.png",
        faviconUrlDark: "https://docs.test/icon-night.png",
      },
      toolSource: {
        key: "integration:docs",
        kind: "integration",
        name: "Docs",
        icon: {
          _tag: "themed-logo",
          logoUrl: "https://docs.test/logo-day.png",
          logoUrlDark: "https://docs.test/logo-night.png",
        },
      },
    };
    expect(presentationOf(fields)).toEqual(fields);
  });

  it("passes a native app icon through unchanged", () => {
    const fields = {
      toolSurface: "computer",
      toolIcon: { _tag: "native-app", app: { _tag: "app-id", appId: "org.test.Notes" } },
      toolSource: { key: "native-app:org.test.notes", kind: "computer", name: "Notes" },
    };
    expect(presentationOf(fields)).toEqual(fields);
  });

  it("never guesses from a provider's own payload shape", () => {
    const providerOnly = {
      data: {
        item: {
          arguments: { code: 'await sky.type({ app: "Notes", text: "hi" })' },
          result: {
            _meta: {
              "codex/toolSurface": {
                kind: "computerUse",
                app: { kind: "displayName", displayName: "Notes" },
              },
            },
          },
        },
      },
    };
    expect(presentationOf(providerOnly)).toEqual({});
  });
});
