// "Retire" is reachable from the Profile tab (live QA #3: only Kora's chat and a right-click row menu had it).
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const archive = vi.fn(async (_id: string) => ({ ok: true as const, value: {} }));
const confirm = vi.fn(async (_message: string) => true);
const toastAdd = vi.fn();

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("../../ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("../../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: React.ReactElement }) => render ?? null,
  TooltipPopup: () => null,
}));
vi.mock("../../ui/toast", () => ({ toastManager: { add: (t: unknown) => toastAdd(t) } }));
vi.mock("~/components/blobs/avatar", () => ({ BlobAvatar: () => null }));
vi.mock("../apps/DecisionLog", () => ({ DecisionLog: () => null }));
vi.mock("../editor/BlobEditorDialog", () => ({ BlobEditorDialog: () => null }));
vi.mock("../shell/useEngineLabel", () => ({ useEngineLabel: () => () => "Default" }));
vi.mock("../shell/PathText", () => ({ PathText: () => null }));
vi.mock("../shell/blobsApi", () => ({
  useBlobsApi: () => ({
    hostId: "h",
    get: vi.fn(async () => ({
      ok: true,
      value: { soul: "Hi", skills: [], core: { you: "", blob: "" } },
    })),
    archive,
  }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm } }) }));

import { ProfileTab } from "./ProfileTab";

const entry = (over: Record<string, unknown> = {}, chief = false) =>
  ({
    blob: {
      id: "blob_popo",
      name: "Popo",
      title: "Researcher",
      engine: { instanceId: "claude", model: "m", effort: null },
      permission: "auto",
      workspace: "/Users/me/Blobs/Popo",
      updatedAt: 1,
      toolGrants: null,
      ...over,
    },
    chief,
    status: { visual: "idle" },
    outfit: {},
  }) as never;

const mount = (e: never) => {
  let r!: ReturnType<typeof create>;
  act(() => {
    r = create(<ProfileTab entry={e} />);
  });
  return r;
};
const retireButton = (r: ReturnType<typeof create>): ReactTestInstance | undefined =>
  r.root.findAll((n) => n.props["data-retire-blob"] !== undefined && n.type === "button")[0];

describe("Profile tab › Retire", () => {
  beforeEach(() => {
    archive.mockClear();
    confirm.mockReset().mockResolvedValue(true);
    toastAdd.mockClear();
  });

  it("is there for a teammate, and not for Kora", () => {
    expect(retireButton(mount(entry()))).toBeDefined();
    expect(retireButton(mount(entry({ id: "blob_kora", name: "Kora" }, true)))).toBeUndefined();
  });

  it("asks first (same words as the roster menu), then retires", async () => {
    const r = mount(entry());
    await act(async () => {
      await retireButton(r)!.props.onClick();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain("Retire Popo?");
    expect(confirm.mock.calls[0]![0]).toContain("kept");
    expect(archive).toHaveBeenCalledWith("blob_popo");
  });

  it("a No leaves the blob alone", async () => {
    confirm.mockResolvedValue(false);
    const r = mount(entry());
    await act(async () => {
      await retireButton(r)!.props.onClick();
    });
    expect(archive).not.toHaveBeenCalled();
  });

  it("a refusal from the daemon shows as an error toast", async () => {
    archive.mockResolvedValueOnce({ ok: false, message: "Kora cannot be retired" } as never);
    const r = mount(entry());
    await act(async () => {
      await retireButton(r)!.props.onClick();
    });
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Kora cannot be retired" }),
    );
  });
});
