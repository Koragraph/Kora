// Kora's welcome is a message over her EMPTY transcript: it never covers the composer (live QA #2: it used to cover the
// whole thread view, composer included, so the first thing you could not do was answer her).
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock("../shell/blobsApi", () => ({
  useBlobsApi: () => ({ setFlag: vi.fn() }),
  useBlobsState: () => ({ snapshot: { flags: { galleryDismissed: false } } }),
}));
vi.mock("./KoraFirstRun", () => ({ KoraFirstRunHost: () => <div data-welcome-body /> }));

import { KoraFirstRunGate } from "./KoraFirstRunGate";

describe("KoraFirstRunGate", () => {
  it("renders nothing when it is not visible", () => {
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(<KoraFirstRunGate visible={false} dismiss={vi.fn()} onBuild={vi.fn()} />);
    });
    expect(r.toJSON()).toBeNull();
  });
  it("fills the transcript area only: below the composer layer (z-10, not z-30), with room kept for the docked composer", () => {
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(
        <KoraFirstRunGate visible dismiss={vi.fn()} bottomInset={132} onBuild={vi.fn()} />,
      );
    });
    const gate = r.root.findAll((n) => n.props["data-kora-first-run-gate"] !== undefined)[0]!;
    expect(gate.props.className).toContain("absolute inset-0");
    expect(gate.props.className).toContain("z-10");
    expect(gate.props.className).not.toContain("z-30");
    expect(gate.props.style).toEqual({ paddingBottom: 132 });
    expect(r.root.findAll((n) => n.props["data-welcome-body"] !== undefined)).toHaveLength(1);
  });
});
