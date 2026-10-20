import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_UPDATE_CONTROL_URL, fetchUpdateControl } from "./updateControl.ts";

describe("updateControl", () => {
  it("fetches and parses a valid paused control file", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        pause: true,
        message: "Updates temporarily paused.",
        minVersion: "0.2.0",
      }),
    })) as unknown as typeof fetch;

    const result = await fetchUpdateControl(DEFAULT_UPDATE_CONTROL_URL, fakeFetch);
    expect(result).toEqual({
      pause: true,
      message: "Updates temporarily paused.",
      minVersion: "0.2.0",
    });
  });

  it("fetches and parses an unpaused control file", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        pause: false,
        message: "All good",
      }),
    })) as unknown as typeof fetch;

    const result = await fetchUpdateControl(DEFAULT_UPDATE_CONTROL_URL, fakeFetch);
    expect(result).toEqual({
      pause: false,
      message: "All good",
      minVersion: undefined,
    });
  });

  it("fails open (returns null) on HTTP error (e.g. 404 or 500)", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const result = await fetchUpdateControl(DEFAULT_UPDATE_CONTROL_URL, fakeFetch);
    expect(result).toBeNull();
  });

  it("fails open (returns null) on network failure", async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error("Network unreachable");
    }) as unknown as typeof fetch;

    const result = await fetchUpdateControl(DEFAULT_UPDATE_CONTROL_URL, fakeFetch);
    expect(result).toBeNull();
  });

  it("fails open (returns null) on malformed json", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error("SyntaxError: Unexpected token");
      },
    })) as unknown as typeof fetch;

    const result = await fetchUpdateControl(DEFAULT_UPDATE_CONTROL_URL, fakeFetch);
    expect(result).toBeNull();
  });

  it("fails open (returns null) on non-object json", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => "string instead of object",
    })) as unknown as typeof fetch;

    const result = await fetchUpdateControl(DEFAULT_UPDATE_CONTROL_URL, fakeFetch);
    expect(result).toBeNull();
  });
});
