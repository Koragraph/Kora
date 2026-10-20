import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { fetchRemoteMedia, MAX_REMOTE_MEDIA_BYTES } from "./remoteMedia.ts";

const publicLookup = async () => ["93.184.216.34"];

describe("fetchRemoteMedia", () => {
  it("returns a public image's bytes and type, without cookies", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png; x=1" } }),
    );
    const out = await fetchRemoteMedia("https://example.com/a.png", fetchFn as never, publicLookup);
    expect(out).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com/a.png",
      expect.objectContaining({ credentials: "omit", redirect: "manual" }),
    );
  });

  it("never reaches this computer or the local network, by name, by address or by redirect", async () => {
    const fetchFn = vi.fn(async () => new Response("x"));
    for (const u of [
      "http://127.0.0.1:8797/api/x",
      "http://localhost/x",
      "http://192.168.1.1/x",
      "file:///etc/hosts",
      "kora://app/x",
    ]) {
      expect((await fetchRemoteMedia(u, fetchFn as never, publicLookup)).error, u).toBeTruthy();
    }
    expect(
      (
        await fetchRemoteMedia("https://rebind.example/x", fetchFn as never, async () => [
          "10.0.0.5",
        ])
      ).error,
    ).toMatch(/local network/);
    expect(fetchFn).not.toHaveBeenCalled();
    const redirect = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8797/api/secret" },
        }),
    );
    expect(
      (await fetchRemoteMedia("https://example.com/r", redirect as never, publicLookup)).error,
    ).toMatch(/local network/);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("refuses a file over the size cap and a failed status", async () => {
    const big = vi.fn(
      async () =>
        new Response("x", { headers: { "content-length": String(MAX_REMOTE_MEDIA_BYTES + 1) } }),
    );
    expect(
      (await fetchRemoteMedia("https://example.com/big", big as never, publicLookup)).error,
    ).toMatch(/too large/);
    const gone = vi.fn(async () => new Response("no", { status: 404 }));
    expect(
      (await fetchRemoteMedia("https://example.com/404", gone as never, publicLookup)).error,
    ).toMatch(/HTTP 404/);
  });
});
