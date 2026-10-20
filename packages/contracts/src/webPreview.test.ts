import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as Preview from "./webPreview.ts";

const webEvent = Schema.decodeUnknownSync(Preview.WebEvent);
const devSite = Schema.decodeUnknownSync(Preview.DiscoveredDevSite);

const AT = "2025-09-09T09:09:09.000Z";
const TAB = "preview-th";

/** Fields every web event carries. */
const envelope = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  threadId: "th",
  tabId: TAB,
  serverEpoch: "epoch-1",
  revision: 3,
  createdAt: AT,
  ...extra,
});

const tabSnapshot = (extra: Record<string, unknown> = {}) => ({
  threadId: "th",
  tabId: TAB,
  updatedAt: AT,
  canGoForward: false,
  canGoBack: true,
  navStatus: { _tag: "Idle" },
  ...extra,
});

describe("web events", () => {
  it("decodes open and close, with and without a snapshot", () => {
    expect(webEvent(envelope("opened", { snapshot: tabSnapshot() })).type).toBe("opened");
    expect(webEvent(envelope("closed")).type).toBe("closed");
  });

  it("decodes a resize carrying the tab's viewport", () => {
    const viewport = { _tag: "freeform", width: 800, height: 600 };
    expect(webEvent(envelope("resized", { snapshot: tabSnapshot({ viewport }) })).type).toBe(
      "resized",
    );
  });

  it("decodes a failed load with the network error code", () => {
    const failed = webEvent(
      envelope("failed", {
        url: "https://nowhere.invalid/",
        title: "",
        code: -105,
        description: "ERR_NAME_NOT_RESOLVED",
      }),
    );
    expect(failed.type === "failed" ? failed.code : undefined).toBe(-105);
  });
});

describe("discovered dev sites", () => {
  const site = (port: number, process: { processName: string | null; pid: number | null }) => ({
    terminal: null,
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}`,
    ...process,
  });

  it("keeps the owning process when known", () => {
    const decoded = devSite(site(4321, { processName: "bun", pid: 777 }));
    expect([decoded.port, decoded.processName]).toEqual([4321, "bun"]);
  });

  it("allows an unknown process", () => {
    expect(devSite(site(8080, { processName: null, pid: null })).processName).toBeNull();
  });

  it.each([0, 65_536])("refuses port %d", (port) => {
    expect(() => devSite(site(port, { processName: null, pid: null }))).toThrow();
  });
});
