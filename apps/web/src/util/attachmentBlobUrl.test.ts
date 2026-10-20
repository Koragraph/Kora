import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ThreadId } from "@kora/contracts";

const { fetchPrimaryHostMock } = vi.hoisted(() => ({ fetchPrimaryHostMock: vi.fn() }));
vi.mock("../hosts/primary/shellAuth", () => ({ fetchPrimaryHost: fetchPrimaryHostMock }));

import { downloadAttachment } from "./attachmentBlobUrl";

const THREAD = "thread-1" as ThreadId;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchPrimaryHostMock.mockReset();
});

function stubDom() {
  const anchors: Array<{ href: string; download: string; rel: string; click: () => void }> = [];
  const blobs: Blob[] = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const anchor = { href: "", download: "", rel: "", click: vi.fn() };
      anchors.push(anchor);
      return anchor;
    },
  });
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return "blob:kora://app/1";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  return { anchors, blobs };
}

describe("downloadAttachment", () => {
  it("reports a failed fetch instead of opening anything", async () => {
    const { anchors } = stubDom();
    fetchPrimaryHostMock.mockResolvedValue(new Response(null, { status: 401 }));
    expect(await downloadAttachment("http://127.0.0.1:8797/", THREAD, "att-1", "x.txt")).toBe(
      false,
    );
    expect(anchors).toHaveLength(0);
  });
  it("fetches through the authed path and saves an inert download, never a page", async () => {
    const { anchors, blobs } = stubDom();
    fetchPrimaryHostMock.mockResolvedValue(
      new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } }),
    );
    const saved = await downloadAttachment("http://127.0.0.1:8797/", THREAD, "att-1", "page.html");
    expect(saved).toBe(true);
    expect(fetchPrimaryHostMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8797/api/attachments/thread-1/att-1",
    );
    expect(blobs[0]?.type).toBe("application/octet-stream");
    expect(anchors[0]?.download).toBe("page.html");
    expect(anchors[0]?.click).toHaveBeenCalledTimes(1);
  });
});
