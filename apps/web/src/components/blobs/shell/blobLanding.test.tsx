// The /blobs landing forwards to the blob's chat. When the forward goes nowhere (a draft request cancelled by a route change,
// a navigate that lost a race) it must retry and then say so, not sit on the spinner (live QA #4: 60 s until a reload).
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const openNewThread = vi.fn<(ref: unknown, o: unknown) => Promise<unknown>>();
const navigate = vi.fn();
const router = { navigate };
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("@kora/client-runtime/host", () => ({
  hostProjectRef: (h: string, p: string) => ({ h, p }),
  hostThreadRef: (h: string, t: string) => ({ h, t }),
}));
vi.mock("@kora/contracts", () => ({ ProjectId: { make: (s: string) => s } }));
vi.mock("~/atoms/entities", () => ({
  useAllHostShellsBootstrapped: () => true,
  useProjects: () => [{ hostId: "h", id: "blob_kora" }],
}));
vi.mock("~/components/blobs/avatar", () => ({ BlobAvatar: () => null }));
vi.mock("~/hooks/useStartThread", () => ({ useStartNewThread: () => openNewThread }));
vi.mock("~/thread/threadRoutes", () => ({ threadPageParams: (r: unknown) => r }));
vi.mock("../../ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("../../ui/empty", () => {
  const P = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { Empty: P, EmptyDescription: P, EmptyHeader: P, EmptyTitle: P };
});
vi.mock("../../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../ui/spinner", () => ({ Spinner: () => <i data-spinner /> }));
vi.mock("./LandingUnreachable", () => ({ default: () => null }));
vi.mock("../editor/BlobEditorDialog", () => ({ BlobEditorDialog: () => null }));
vi.mock("../welcome/KoraFirstRun", () => ({ KoraFirstRunHost: () => null }));
vi.mock("../../assistant/surfaceStore", () => ({
  useAppSurfaceStore: () => ["blobs", () => undefined],
  useLastBlobStore: () => [null, () => undefined],
}));
const rosterState = vi.hoisted(() => ({
  ready: true,
  hostId: "h",
  roster: { chief: { id: "blob_kora" }, team: [] as unknown[] },
  entries: new Map<string, unknown>([["blob_kora", { blob: { id: "blob_kora" }, threads: [] }]]),
}));
vi.mock("./useBlobRoster", () => ({ useBlobRoster: () => rosterState }));

import { BlobLanding, LANDING_MAX_ATTEMPTS, LANDING_WATCHDOG_MS } from "./BlobLanding";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BlobLanding watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openNewThread.mockReset();
    navigate.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const mount = async () => {
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<BlobLanding blobId={null} />);
    });
    return r;
  };
  const hasSpinner = (r: ReturnType<typeof create>) =>
    r.root.findAll((n) => n.props["data-spinner"] !== undefined).length > 0;
  const retryButton = (r: ReturnType<typeof create>) =>
    r.root.findAll((n) => n.props["data-landing-retry"] !== undefined && n.type === "button")[0];

  it("a request that opened nothing (null) is retried on its own", async () => {
    openNewThread.mockResolvedValueOnce(null).mockResolvedValue({ draftId: "d", threadId: "t" });
    await mount();
    expect(openNewThread).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LANDING_WATCHDOG_MS + 50);
    });
    expect(openNewThread.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a forward that never lands is retried, then gives up with a Try again button instead of an endless spinner", async () => {
    openNewThread.mockResolvedValue({ draftId: "d", threadId: "t" }); // resolves, but this component is never unmounted
    const r = await mount();
    expect(hasSpinner(r)).toBe(true);
    for (let i = 0; i < LANDING_MAX_ATTEMPTS; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LANDING_WATCHDOG_MS + 50);
      });
    }
    expect(openNewThread).toHaveBeenCalledTimes(LANDING_MAX_ATTEMPTS);
    expect(hasSpinner(r)).toBe(false);
    expect(retryButton(r)).toBeDefined();
    // Try again starts over
    await act(async () => retryButton(r)!.props.onClick());
    expect(openNewThread).toHaveBeenCalledTimes(LANDING_MAX_ATTEMPTS + 1);
    expect(hasSpinner(r)).toBe(true);
  });

  it("a landing that lands (it unmounts) is left alone", async () => {
    openNewThread.mockResolvedValue({ draftId: "d", threadId: "t" });
    const r = await mount();
    act(() => r.unmount());
    await vi.advanceTimersByTimeAsync(LANDING_WATCHDOG_MS * 4);
    expect(openNewThread).toHaveBeenCalledTimes(1);
  });
});
