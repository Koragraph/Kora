import type { ShellWebFavicon, WebSessionSnapshot } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";

import { RightDockPanel, tabMuteMenuItem } from "./RightDockPanel";

const surface = (n: number) => ({
  id: `browser:tab-${n}` as const,
  kind: "preview" as const,
  resourceId: `tab-${n}`,
});
const session = (n: number, url: string, title: string): WebSessionSnapshot =>
  ({
    tabId: `tab-${n}`,
    threadId: "thread-1",
    updatedAt: "2026-08-09T00:00:00.000Z",
    canGoBack: false,
    canGoForward: false,
    navStatus: { _tag: "Success", url, title },
  }) as WebSessionSnapshot;

const SESSIONS = {
  "tab-1": session(1, "http://site.local/", "Local site"),
  "tab-2": session(2, "http://site.local/admin", "Admin"),
};

const icon = (dataUrl: string, pageUrl: string): ShellWebFavicon => ({
  dataUrl,
  pageUrl,
  capturedAt: 1,
});
const PNG_A = "data:image/png;base64,AAAA";
const PNG_B = "data:image/png;base64,BBBB";

type Audio = { audible?: boolean; audioMuted?: boolean };
const desktopTab = (favicon: ShellWebFavicon | null, audio: Audio = {}) => ({
  favicon,
  controller: "none" as const,
  audible: audio.audible ?? false,
  audioMuted: audio.audioMuted ?? false,
  colorScheme: "system" as const,
  pictureInPicture: false,
  zoomFactor: 1,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  hasWebContents: true,
});

function dock(opts: {
  first: ShellWebFavicon | null;
  second?: ShellWebFavicon;
  audio?: Audio;
  runtimeId?: ((tabId: string) => string) | null;
}) {
  const runtimeId = opts.runtimeId === undefined ? (id: string) => `runtime:${id}` : opts.runtimeId;
  const none = () => undefined;
  return renderToStaticMarkup(
    <RightDockPanel
      mode="inline"
      surfaces={opts.second ? [surface(1), surface(2)] : [surface(1)]}
      activeSurfaceId={surface(1).id}
      pendingSurfaceIds={new Set()}
      previewSessions={SESSIONS}
      desktopByTabId={{
        "tab-1": desktopTab(opts.first, opts.audio),
        ...(opts.second ? { "tab-2": desktopTab(opts.second) } : {}),
      }}
      {...(runtimeId ? { webRuntimeTabId: runtimeId } : {})}
      terminalLabelsById={new Map()}
      groups={["terminal", "browser", "files"].map((group) => ({
        group: group as "terminal",
        available: true,
        unavailableReason: "",
      }))}
      onActivate={none}
      onCloseSurface={none}
      onCopyFilePath={none}
      onAddBrowser={none}
      onAddBrowserInProfile={none}
      onAddTerminal={none}
      onSelectGroup={none}
      onHide={none}
    >
      <div>content</div>
    </RightDockPanel>,
  );
}

describe("header", () => {
  test("it always has its own hide button", () => {
    expect(dock({ first: null })).toContain('aria-label="Tuck the dock away"');
  });

  test("group tabs switch groups and the browser group lists its pages", () => {
    const out = dock({ first: null, second: icon(PNG_B, "http://site.local/admin") });
    expect(out).toContain('data-dock-group="browser" data-active="true"');
    expect(out).toContain('aria-label="Files"');
    expect(out).toContain('aria-label="New page"');
    expect(out).toContain("Local site");
    expect(out).toContain("Admin");
    expect(out).not.toContain("Open a surface");
  });
});

describe("tabMuteMenuItem", () => {
  const tab = (audioMuted: boolean) =>
    ({ audioMuted, audible: false }) as Parameters<typeof tabMuteMenuItem>[0]["overlay"];

  test.each([
    [false, true, { disabled: false, label: "Mute page" }],
    [true, true, { disabled: false, label: "Unmute page" }],
    [false, false, { disabled: true, label: "Mute page" }],
  ])("muted=%s, addressable=%s", (muted, addressable, expected) => {
    expect(tabMuteMenuItem({ overlay: tab(muted), canResolveRuntimeTabId: addressable })).toEqual(
      expected,
    );
  });

  test("before the desktop page exists the item is disabled (muting then would fail silently)", () => {
    expect(tabMuteMenuItem({ overlay: null, canResolveRuntimeTabId: true })).toEqual({
      disabled: true,
      label: "Mute page",
    });
  });
});

describe("audio indicator", () => {
  test.each([
    [true, true, "Unmute Local site"],
    [true, false, "Mute Local site"],
    [false, true, null],
    [false, false, null],
  ])("audible=%s muted=%s", (audible, audioMuted, label) => {
    const out = dock({ first: null, audio: { audible, audioMuted } });
    if (label) expect(out).toContain(`aria-label="${label}"`);
    else {
      expect(out).not.toContain("Mute Local site");
      expect(out).not.toContain("Unmute Local site");
    }
  });

  test("no toggle when the runtime tab id cannot be resolved", () => {
    expect(dock({ first: null, audio: { audible: true }, runtimeId: null })).not.toContain(
      "Mute Local site",
    );
  });

  test("the runtime id resolver is asked about the server tab id", () => {
    const asked: string[] = [];
    dock({
      first: null,
      audio: { audible: true },
      runtimeId: (id) => {
        asked.push(id);
        return `runtime:${id}`;
      },
    });
    expect(asked).toContain("tab-1");
  });
});

describe("favicons", () => {
  test("a capture from another origin than the session's is hidden", () => {
    expect(dock({ first: icon(PNG_A, "https://example.com/") })).not.toContain(PNG_A);
  });

  test("two tabs on one origin each keep their own route-specific capture", () => {
    const out = dock({
      first: icon(PNG_A, "http://site.local/"),
      second: icon(PNG_B, "http://site.local/admin"),
    });
    expect(out).toContain(PNG_A);
    expect(out).toContain(PNG_B);
  });

  test("a live capture is used and private hostnames never go to a favicon service", () => {
    expect(dock({ first: icon(PNG_A, "http://site.local/") })).toContain(PNG_A);
    expect(dock({ first: icon(PNG_A, "http://site.local/") })).not.toContain("s2/favicons");
    expect(dock({ first: null })).not.toContain("s2/favicons");
  });
});
