import { HostId } from "@kora/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { LinkCatalogEntry } from "./catalog.ts";
import { LinkTransientError, LocalLinkTarget, type SupervisorLinkState } from "./model.ts";
import { linkCatalogDisplayUrl, linkStatusText, presentLinkState } from "./presentation.ts";

const DAEMON = "127.0.0.1:8797";

const ENTRY: LinkCatalogEntry = {
  enabled: true,
  target: new LocalLinkTarget({
    wsBaseUrl: `ws://${DAEMON}`,
    httpBaseUrl: `http://${DAEMON}`,
    label: "This Mac",
    hostId: HostId.make("environment-1"),
  }),
};

/** A connecting, first-attempt supervisor snapshot with `changes` applied. */
const snapshot = (changes: Partial<SupervisorLinkState>): SupervisorLinkState => ({
  retryAt: null,
  lastFailure: null,
  generation: 0,
  attempt: 1,
  stage: "preparing",
  phase: "connecting",
  network: "online",
  desired: true,
  ...changes,
});

const failure = (detail: string, traceId: string) =>
  new LinkTransientError({ traceId, detail, reason: "transport" });

/** The presented state, written as [phase, error, traceId]. */
const shown = (changes: Partial<SupervisorLinkState>) => {
  const { phase, error, traceId } = presentLinkState(snapshot(changes));
  return [phase, error, traceId];
};

describe("connection presentation", () => {
  it("shows the daemon URL as the display address", () => {
    expect(linkCatalogDisplayUrl(ENTRY)).toBe(`http://${DAEMON}`);
  });

  it("tells a first connect from a reconnect, carrying the last failure", () => {
    expect(shown({ attempt: 1 })).toEqual(["connecting", null, null]);
    expect(shown({ attempt: 2, lastFailure: failure("Pipe broke.", "t-a") })).toEqual([
      "reconnecting",
      "Pipe broke.",
      "t-a",
    ]);
    expect(
      shown({ retryAt: 1, attempt: 2, phase: "backoff", lastFailure: failure("Gone.", "t-b") }),
    ).toEqual(["reconnecting", "Gone.", "t-b"]);
  });

  it("keeps showing the last failure while the next attempt opens", () => {
    const lastFailure = failure("Handshake took too long.", "t-c");
    expect(shown({ lastFailure, attempt: 2, stage: "opening" })).toEqual([
      "reconnecting",
      "Handshake took too long.",
      "t-c",
    ]);
  });

  it("puts the reason after the reconnect notice", () => {
    const text = linkStatusText({ traceId: "t-d", error: "No reply.", phase: "reconnecting" });
    expect(text).toBe("Failed to connect. Reconnecting... Reason: No reply.");
  });

  it.each([
    ["offline", { stage: null, phase: "offline", network: "offline" }],
    ["connected", { generation: 1, stage: null, phase: "connected" }],
    // A host the user parked stays "available" even with the network down.
    [
      "available",
      { attempt: 0, stage: null, phase: "available", network: "offline", desired: false },
    ],
  ] as const)("reports %s straight from the supervisor", (phase, changes) => {
    expect(shown(changes)).toEqual([phase, null, null]);
  });
});
