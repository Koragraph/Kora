// @effect-diagnostics nodeBuiltinImport:off -- reads the route sources to check they render through the gate.
// Kora is coming soon (branding.ts KORA_SURFACE + the daemon's answer on the blobs snapshot): the app opens on Code, the
// Kora tab shows the coming-soon page, and every /blobs, /blobs/<id> and /apps address is gated. With the daemon's
// developer override ("on") the real Kora comes back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────
const navigate = vi.fn(async (_input: unknown) => {});
let snapshot: { koraSurface?: "coming-soon" | "on"; blobs: unknown[] } | null = null;

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
}));
vi.mock("./components/blobs/shell/blobsApi", () => ({
  useBlobsState: () => ({ hostId: "local", snapshot, error: null }),
}));
vi.mock("./atoms/entities", () => ({
  useProjects: () => [],
  useThreadSummaries: () => [],
}));
vi.mock("./components/ui/sidebar", () => ({
  SidebarInset: (p: { children: ReactNode }) => createElement("div", null, p.children),
}));

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  navigate.mockClear();
  snapshot = null;
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
});
afterEach(() => vi.unstubAllGlobals());

const { KORA_SURFACE } = await import("./branding");
const { isKoraSurfaceOn } = await import("./koraSurface");
const { DEFAULT_APP_SURFACE } = await import("./components/assistant/surfaceStore");
const { useSurfaceSwitch } = await import("./components/assistant/useSurfaceSwitch");
const { KoraComingSoonContent, KORA_FEATURES, KORA_COMING_SOON_HEADLINE } =
  await import("./components/kora/KoraComingSoon");
const { KoraSurfaceGate } = await import("./components/kora/KoraSurfaceOnly");

function render(node: ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(node);
  });
  return r;
}
const markers = (r: ReactTestRenderer) =>
  r.root
    .findAll((n) => typeof n.props["data-marker"] === "string")
    .map((n) => n.props["data-marker"]);
const comingSoon = (r: ReactTestRenderer) =>
  r.root.findAll((n) => n.props["data-testid"] === "kora-coming-soon").length > 0;

describe("the Kora surface switch", () => {
  it("every build ships coming soon, and the app's default surface is Code", () => {
    expect(KORA_SURFACE).toBe("coming-soon");
    expect(DEFAULT_APP_SURFACE).toBe("code");
  });

  it("is on only when the build or the daemon says so", () => {
    expect(isKoraSurfaceOn("coming-soon", undefined)).toBe(false);
    expect(isKoraSurfaceOn("coming-soon", null)).toBe(false);
    expect(isKoraSurfaceOn("coming-soon", "coming-soon")).toBe(false);
    expect(isKoraSurfaceOn("coming-soon", "on")).toBe(true);
    expect(isKoraSurfaceOn("on", undefined)).toBe(true);
  });
});

describe("clicking Kora", () => {
  function Probe(props: { onReady: (s: ReturnType<typeof useSurfaceSwitch>) => void }) {
    props.onReady(useSurfaceSwitch());
    return null;
  }
  const mount = () => {
    let api!: ReturnType<typeof useSurfaceSwitch>;
    render(createElement(Probe, { onReady: (s) => (api = s) }));
    return () => api;
  };

  it("coming soon: opens the coming-soon page (/blobs), never the last blob", () => {
    storage.set("kora.blobs.last.v1", JSON.stringify("blob_1"));
    snapshot = { koraSurface: "coming-soon", blobs: [] };
    const api = mount();
    expect(api()[0]).toBe("code");
    act(() => api()[1]("blobs"));
    expect(navigate).toHaveBeenCalledWith({ to: "/blobs" });
  });

  it("override on: returns to the blob you were last in", () => {
    storage.set("kora.blobs.last.v1", JSON.stringify("blob_1"));
    snapshot = { koraSurface: "on", blobs: [{ id: "blob_1", archivedAt: null }] };
    const api = mount();
    act(() => api()[1]("blobs"));
    expect(navigate).toHaveBeenCalledWith({ to: "/blobs/$blobId", params: { blobId: "blob_1" } });
  });

  it("the page's back-to-Code button works even when the stored surface already says Code", () => {
    snapshot = { koraSurface: "coming-soon", blobs: [] };
    const api = mount();
    act(() => api()[1]("code", { force: true }));
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });
});

describe("the coming-soon page", () => {
  it("has one h1, a features h2, one h3 per feature card and a way back to Code", () => {
    const onOpenCode = vi.fn();
    const r = render(createElement(KoraComingSoonContent, { onOpenCode }));
    const h1 = r.root.findAllByType("h1");
    expect(h1).toHaveLength(1);
    expect(h1[0]!.children.join("")).toBe(KORA_COMING_SOON_HEADLINE);
    expect(r.root.findAllByType("h2")).toHaveLength(1);
    expect(r.root.findAllByType("h3")).toHaveLength(KORA_FEATURES.length);
    expect(KORA_FEATURES.length).toBe(9);
    const button = r.root.find(
      (n) => n.props["data-testid"] === "kora-coming-soon-open-code" && n.type === "button",
    );
    act(() => button.props.onClick());
    expect(onOpenCode).toHaveBeenCalledTimes(1);
  });

  it("keeps every feature to one sentence and asks for nothing (no form, no input)", () => {
    for (const f of KORA_FEATURES)
      expect(f.body.split(/[.!?](\s|$)/).filter((s) => s.trim()).length).toBe(1);
    const r = render(createElement(KoraComingSoonContent, { onOpenCode: () => {} }));
    expect(r.root.findAllByType("form")).toHaveLength(0);
    expect(r.root.findAllByType("input")).toHaveLength(0);
  });
});

describe("/blobs, /blobs/<id> and /apps are gated", () => {
  const Page = () => createElement("div", { "data-marker": "kora-page" });
  const gate = () => render(createElement(KoraSurfaceGate, null, createElement(Page)));

  it("coming soon: the coming-soon page, and the Kora page never mounts", () => {
    snapshot = { koraSurface: "coming-soon", blobs: [] };
    const r = gate();
    expect(comingSoon(r)).toBe(true);
    expect(markers(r)).toEqual([]);
  });

  it("an older daemon that never says (no koraSurface) is coming soon too", () => {
    snapshot = { blobs: [] };
    expect(comingSoon(gate())).toBe(true);
  });

  it("override on: the real Kora page renders", () => {
    snapshot = { koraSurface: "on", blobs: [] };
    expect(markers(gate())).toEqual(["kora-page"]);
  });

  it("every Kora route renders through the gate", () => {
    for (const file of ["routes/blobs.tsx", "routes/blobs.$blobId.tsx", "routes/apps.tsx"]) {
      const source = NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");
      expect(source, file).toMatch(/<KoraSurfaceGate>/);
    }
  });

  it("root-level blob UI (hire fly-in, browser mini-window) mounts only while Kora is on", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "routes/__root.tsx"),
      "utf8",
    );
    expect(source).toMatch(/<KoraSurfaceOnly>\s*<HireFlyInLayer \/>\s*<\/KoraSurfaceOnly>/);
    expect(source).toMatch(/<KoraSurfaceOnly>\s*<BrowserMiniHost \/>\s*<\/KoraSurfaceOnly>/);
  });
});
