// An edited file (same path, new content) must preview as the new content: the byte cache may only answer while the daemon
// still reports the version it was filled from. (Live QA 2026-10-09: "add a savings column" left the old card stale.)
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fetchMock = vi.fn();
vi.mock("~/hosts/primary/shellAuth", () => ({
  fetchPrimaryHost: (...a: unknown[]) => fetchMock(...a),
}));
vi.mock("~/hosts/primary/target", () => ({
  resolvePrimaryHostHttpUrl: (p: string) => `http://x${p}`,
}));

import { clearBlobFileCacheForTests, fetchBlobFileBytes } from "./blobFileBytes";

const reply = (body: string, headers: Record<string, string>) =>
  new Response(body, {
    status: 200,
    headers: { "content-length": String(body.length), ...headers },
  });
const opts = { blobId: "b1", relativePath: "outputs/budget.xlsx", maxBytes: 1_000_000 };
const text = async () => new TextDecoder().decode(await fetchBlobFileBytes(opts));

describe("blob file bytes cache", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearBlobFileCacheForTests();
  });

  it("serves the new bytes after the file changes at the same path (last-modified moved)", async () => {
    fetchMock.mockResolvedValueOnce(
      reply("version-one", { "last-modified": "Thu, 09 Oct 2026 10:00:00 GMT" }),
    );
    expect(await text()).toBe("version-one");
    fetchMock.mockResolvedValueOnce(
      reply("version-TWO", { "last-modified": "Thu, 09 Oct 2026 10:05:00 GMT" }),
    );
    expect(await text()).toBe("version-TWO");
  });

  it("reuses the cached copy only while the version is unchanged", async () => {
    const h = { etag: '"abc"', "last-modified": "Thu, 09 Oct 2026 10:00:00 GMT" };
    fetchMock.mockResolvedValueOnce(reply("same", h));
    expect(await text()).toBe("same");
    const second = reply("same", h);
    const cancel = vi.spyOn(second.body!, "cancel");
    fetchMock.mockResolvedValueOnce(second);
    expect(await text()).toBe("same");
    expect(cancel).toHaveBeenCalled(); // the body was not downloaded again
  });

  it("never trusts the cache when the daemon reports no version (a same-size edit would look unchanged)", async () => {
    fetchMock.mockResolvedValueOnce(reply("12345", {}));
    expect(await text()).toBe("12345");
    fetchMock.mockResolvedValueOnce(reply("67890", {}));
    expect(await text()).toBe("67890");
  });
});
