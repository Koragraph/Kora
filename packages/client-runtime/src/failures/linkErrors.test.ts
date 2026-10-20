import { describe, expect, it } from "vite-plus/test";

import { isTransportLinkErrorMessage, sanitizeThreadErrorMessage } from "./linkErrors.ts";

const LINK_FAILURES = [
  "SocketCloseError: connection reset",
  "SocketOpenError: ECONNREFUSED",
  // React Native's wording for a socket that is gone.
  "The operation couldn't be completed. Socket is not connected",
  // What the Effect RPC session says about a host.
  "Test environment disconnected.",
  "Test environment could not establish a WebSocket connection.",
  "Test environment is not connected.",
  "ClientProtocolError: socket closed",
  "Unable to connect to the Kora server WebSocket.",
  "ping timeout",
];

const ORDINARY_FAILURES = ["Thread not found", "Invalid model selection"];

describe("isTransportLinkErrorMessage", () => {
  it.each(LINK_FAILURES)("treats %j as a link failure", (message) => {
    expect(isTransportLinkErrorMessage(message)).toBe(true);
  });

  it.each([...ORDINARY_FAILURES, "", "   ", null, undefined])("leaves %j alone", (message) => {
    expect(isTransportLinkErrorMessage(message)).toBe(false);
  });
});

describe("sanitizeThreadErrorMessage", () => {
  it("hides a link failure from the thread", () => {
    expect(sanitizeThreadErrorMessage(LINK_FAILURES[0])).toBeNull();
  });

  it.each([...ORDINARY_FAILURES, "Select a base branch before sending."])(
    "shows %j unchanged",
    (message) => {
      expect(sanitizeThreadErrorMessage(message)).toBe(message);
    },
  );

  it.each([null, undefined])("has nothing to show for %j", (message) => {
    expect(sanitizeThreadErrorMessage(message)).toBeNull();
  });
});
