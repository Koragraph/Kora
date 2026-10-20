import { hookStub as hooks } from "../../test/hookStub";
import { findElement } from "../../test/findElement";

import {
  SWARM_STATUS_READY,
  SWARM_STATUS_OPENCODE_MISSING,
  SWARM_STATUS_NEEDS_CONSENT,
} from "../../util/swarm.fixtures";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isValidElement, type FunctionComponent } from "react";
import { HostId, SWARM_PRIVACY_NOTICE_VERSION, type SwarmStatus } from "@kora/contracts";

const env = vi.hoisted(() => ({
  setConsent: vi.fn(),
  close: vi.fn(),
  store: {
    pendingSwitch: null as { target: unknown } | null,
    step: "intro" as string,
    open: true,
  },
  status: null as SwarmStatus | null,
  supported: true,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { hookStub } = await import("../../test/hookStub");
  return {
    ...actual,
    useEffect: () => undefined,
    useId: () => "consent",
    useRef: hookStub.useRef,
    useState: hookStub.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { hookStub } = await import("../../test/hookStub");
  return { c: hookStub.useMemoCache };
});

vi.mock("../../hooks/useSwarmStatus", () => ({
  useSwarmStatus: () => ({ supported: env.supported, status: env.status }),
}));

vi.mock("../../stores/swarmSetupStore", () => ({
  closeSwarmSetup: env.close,
  useSwarmSetupStore: Object.assign(
    (select: (state: typeof env.store) => unknown) => select(env.store),
    {
      setState: (patch: Partial<typeof env.store>) => Object.assign(env.store, patch),
    },
  ),
}));

vi.mock("../../atoms/swarm", () => ({ swarmHost: { setConsent: "setConsent" } }));
vi.mock("../../atoms/use-atom-command", () => ({
  useAtomAction: () => env.setConsent,
}));

import { SwarmSetupDialog } from "./SwarmSetupDialog";
import { SwarmPrivacyNotice } from "./SwarmPrivacyNotice";

import { SwarmIntroStep } from "./SwarmIntroStep";

const hostId = HostId.make("local");
const target = { hostId, threadId: "thread-1" };

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement<Record<string, unknown>>(node)) return "";
  return Object.entries(node.props)
    .filter(([key]) => key !== "className")
    .map(([, value]) => textOf(value))
    .join(" ");
}

function renderDialog(onStartSwarm = vi.fn()) {
  hooks.startRender();
  return SwarmSetupDialog({ hostId, onStartSwarm });
}

function footerButton(view: unknown, label: string) {
  return findElement(
    view,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
}

describe("Swarm privacy consent", () => {
  beforeEach(() => {
    hooks.clear();
    vi.clearAllMocks();
    env.setConsent.mockResolvedValue({ _tag: "Success", value: null });
  });

  it("toggling the checkbox reports the new choice", () => {
    const onAcceptedChange = vi.fn();
    hooks.startRender();
    const Notice = SwarmPrivacyNotice as FunctionComponent<
      Parameters<typeof SwarmPrivacyNotice>[0]
    >;
    const view = Notice({ consent: SWARM_STATUS_READY.consent, onAcceptedChange });
    const checkbox = findElement(view, (element) => element.props.id === "consent")!;
    expect(checkbox.props.checked).toBe(true);
    (checkbox.props.onCheckedChange as (checked: boolean) => void)(false);
    expect(onAcceptedChange).toHaveBeenCalledWith(false);
  });

  it("stores consent with the current notice version", async () => {
    hooks.startRender();
    const intro = SwarmIntroStep({ hostId, status: SWARM_STATUS_NEEDS_CONSENT });
    const notice = findElement(intro, (element) => element.type === SwarmPrivacyNotice)!;
    (notice.props.onAcceptedChange as (accepted: boolean) => void)(true);
    await Promise.resolve();
    expect(env.setConsent).toHaveBeenCalledWith({
      input: { noticeVersion: SWARM_PRIVACY_NOTICE_VERSION, accepted: true },
      hostId,
    });
  });

  it("asks again when the notice version moved past the accepted one", () => {
    hooks.startRender();
    const view = SwarmPrivacyNotice({
      onAcceptedChange: vi.fn(),
      consent: { requiredVersion: 2, acceptedVersion: 1, acceptedAt: 1 },
    });
    expect(textOf(view)).toContain("This notice changed");
  });

  it("shows the notice and reflects the stored consent", () => {
    hooks.startRender();
    const view = SwarmPrivacyNotice({
      onAcceptedChange: vi.fn(),
      consent: SWARM_STATUS_NEEDS_CONSENT.consent,
    });
    expect(textOf(view)).toContain("providers may log your prompts and code");
    const checkbox = findElement(view, (element) => element.props.id === "consent")!;
    expect(checkbox.props.checked).toBe(false);
  });
});

describe("SwarmSetupDialog", () => {
  beforeEach(() => {
    hooks.clear();
    vi.clearAllMocks();
    env.supported = true;
    env.status = SWARM_STATUS_NEEDS_CONSENT;
    env.store.open = true;
    env.store.step = "intro";
    env.store.pendingSwitch = null;
    env.setConsent.mockResolvedValue({ _tag: "Success", value: null });
  });

  it("offers Done when opened without a pending switch", () => {
    env.status = SWARM_STATUS_READY;
    env.store.step = "ready";
    expect(footerButton(renderDialog(), "Done")).not.toBeNull();
    expect(footerButton(renderDialog(), "Start Swarm")).toBeNull();
  });

  it("closes without committing anything from Cancel", () => {
    const onStartSwarm = vi.fn();
    (footerButton(renderDialog(onStartSwarm), "Cancel")!.props.onClick as () => void)();
    expect(env.close).toHaveBeenCalledOnce();
    expect(onStartSwarm).not.toHaveBeenCalled();
  });

  it("does not start Swarm while it is not ready", () => {
    env.store.step = "ready";
    env.store.pendingSwitch = { target };
    expect(footerButton(renderDialog(), "Start Swarm")?.props.disabled).toBe(true);
  });

  it("commits the pending switch only on Start Swarm", () => {
    env.status = SWARM_STATUS_READY;
    env.store.step = "ready";
    env.store.pendingSwitch = { target };
    const onStartSwarm = vi.fn();
    const view = renderDialog(onStartSwarm);
    expect(footerButton(view, "Done")).toBeNull();
    (footerButton(view, "Start Swarm")!.props.onClick as () => void)();
    expect(env.close).toHaveBeenCalledOnce();
    expect(onStartSwarm).toHaveBeenCalledWith(target);
  });

  it("requires OpenCode before the providers step", () => {
    env.status = {
      ...SWARM_STATUS_OPENCODE_MISSING,
      consent: SWARM_STATUS_READY.consent,
    };
    env.store.step = "opencode";
    expect(footerButton(renderDialog(), "Continue")?.props.disabled).toBe(true);
  });

  it("requires the privacy consent to continue", () => {
    expect(footerButton(renderDialog(), "Continue")?.props.disabled).toBe(true);
    env.status = SWARM_STATUS_READY;
    expect(footerButton(renderDialog(), "Continue")?.props.disabled).toBe(false);
  });

  it("renders nothing on a host without the swarm capability", () => {
    env.supported = false;
    expect(renderDialog()).toBeNull();
  });
});
