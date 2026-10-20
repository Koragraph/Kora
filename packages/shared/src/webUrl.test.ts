import { describe, expect, it } from "vite-plus/test";

import { isLoopbackHost, normalizeWebUrl, WebUrlNormalizationError } from "./webUrl.ts";

/** The error `normalizeWebUrl` throws for `input`. */
function failureFor(input: string): WebUrlNormalizationError {
  let caught: unknown = null;
  try {
    normalizeWebUrl(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WebUrlNormalizationError);
  return caught as WebUrlNormalizationError;
}

describe("loopback hosts", () => {
  it("recognises the loopback and unspecified names", () => {
    expect(["[::1]", "::1", "0.0.0.0", "127.0.0.1", "localhost"].every(isLoopbackHost)).toBe(true);
  });

  it("rejects public, private-network and empty hosts", () => {
    expect(["", "10.1.1.1", "192.168.0.2", "example.org"].some(isLoopbackHost)).toBe(false);
  });
});

describe("web URL normalization", () => {
  it.each([
    ["localhost:8080", "http://localhost:8080/"],
    ["127.0.0.1:4000", "http://127.0.0.1:4000/"],
    ["example.org", "https://example.org/"],
    ["https://localhost:8080", "https://localhost:8080/"],
    ["http://example.org/a?b=c", "http://example.org/a?b=c"],
  ])("%s becomes %s", (input, expected) => {
    expect(normalizeWebUrl(input)).toBe(expected);
  });

  it("reports blank input by length only", () => {
    const error = failureFor("    ");
    expect(error).toMatchObject({ reason: "empty", inputLength: 4 });
    expect(error).not.toHaveProperty("rawUrl");
    expect(Object.hasOwn(error, "cause") || "cause" in error).toBe(false);
  });

  it("names the protocol it does not support", () => {
    const input = "gopher://example.org";
    expect(failureFor(input)).toMatchObject({
      reason: "unsupported-protocol",
      protocol: "gopher:",
      inputLength: input.length,
    });
  });

  it("keeps secrets from an unparseable URL out of the error", () => {
    const input = "https://alice:hunter2@example.org:port/x?api_key=topsecret#anchor";
    const error = failureFor(input);
    expect(error).toMatchObject({ reason: "parse", protocol: "https:", inputLength: input.length });
    expect(error).not.toHaveProperty("rawUrl");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message.includes((error.cause as Error).message)).toBe(false);
    expect(error.message).not.toMatch(/alice|hunter2|api_key|topsecret|anchor/);
  });
});
