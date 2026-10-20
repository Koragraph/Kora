import { describe, expect, it } from "vite-plus/test";
import { requestIndex } from "./projectSetup";

const reply = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });

describe("requestIndex", () => {
  it("is ok on a 2xx", async () => {
    expect(await requestIndex("http://x", "/r", {}, reply(200, { ok: true }))).toEqual({
      ok: true,
    });
  });

  it("explains a refused home folder", async () => {
    const res = await requestIndex("http://x", "/r", {}, reply(409, { reason: "unsafe-root" }));
    expect(res).toEqual({ ok: false, reason: "Kora never indexes a home or system folder." });
  });

  it("says when the service does not answer", async () => {
    const res = await requestIndex("http://x", "/r", {}, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(res.ok).toBe(false);
  });
});
