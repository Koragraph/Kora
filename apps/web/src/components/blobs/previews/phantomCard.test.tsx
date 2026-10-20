// A card for a file the turn never made (live QA #3: a denied `touch test.txt` left a "test.txt · File · Open" card).
import type { HostThreadRef } from "@kora/contracts";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const fileState: { data: unknown; error: string | null; isPending: boolean } = {
  data: null,
  error: null,
  isPending: false,
};
vi.mock("../../viewer/projectFilesQueryState", () => ({
  useProjectFile: () => ({ ...fileState, refresh: () => undefined }),
}));
vi.mock("./useInView", () => ({ useInView: () => ({ ref: { current: null }, seen: true }) }));
vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => null }));
vi.mock("~/hooks/useCopyText", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: () => undefined }),
}));
vi.mock("../../assistant/outputs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../assistant/outputs")>()),
  useOpenChatOutput: () => () => undefined,
}));
vi.mock("../../ReplyMarkdown", () => ({ default: () => null }));

import { BlobOutputCard } from "./BlobOutputCards";

const mount = (relativePath: string) => {
  let r!: ReturnType<typeof create>;
  act(() => {
    r = create(
      <BlobOutputCard
        hostId={"h" as never}
        cwd="/Users/me/Blobs/Junip"
        threadRef={{ environmentId: "e", threadId: "t" } as unknown as HostThreadRef}
        blobId="b"
        relativePath={relativePath}
      />,
    );
  });
  return r;
};
const cards = (r: ReturnType<typeof create>) =>
  r.root.findAll((n) => typeof n.type === "string" && "data-blob-output-card" in n.props);

describe("output cards only appear for files that exist", () => {
  it("a text file that was never written (a denied command) gets no card", () => {
    Object.assign(fileState, { data: null, error: "ENOENT", isPending: false });
    expect(cards(mount("outputs/test.txt"))).toHaveLength(0);
    expect(cards(mount("test.txt"))).toHaveLength(0);
    expect(cards(mount("outputs/page.html"))).toHaveLength(0);
    expect(cards(mount("outputs/data.json"))).toHaveLength(0);
    expect(cards(mount("outputs/brief.md"))).toHaveLength(0);
  });

  it("the card is there while the check is still running, and for a file that exists", () => {
    Object.assign(fileState, { data: null, error: null, isPending: true });
    expect(cards(mount("outputs/test.txt"))).toHaveLength(1);
    Object.assign(fileState, {
      data: { relativePath: "outputs/test.txt", contents: "hi", byteLength: 2, truncated: false },
      error: null,
      isPending: false,
    });
    expect(cards(mount("outputs/test.txt"))).toHaveLength(1);
  });
});
