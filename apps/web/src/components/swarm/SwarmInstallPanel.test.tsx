import { hookStub as hooks } from "../../test/hookStub";
import { findElement } from "../../test/findElement";

import { SWARM_STATUS_OPENCODE_MISSING, SWARM_STATUS_READY } from "../../util/swarm.fixtures";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isValidElement, type FunctionComponent } from "react";
import type { SwarmInstallState, SwarmOpencodeStatus } from "@kora/contracts";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { hookStub } = await import("../../test/hookStub");
  return { ...actual, useRef: hookStub.useRef, useState: hookStub.useState };
});

vi.mock("react/compiler-runtime", async () => {
  const { hookStub } = await import("../../test/hookStub");
  return { c: hookStub.useMemoCache };
});

vi.mock("../../localApi", () => ({
  localApiOrThrow: () => ({ shell: { openExternal: vi.fn(() => Promise.resolve()) } }),
}));

import { SwarmInstallPanel } from "./SwarmInstallPanel";

const IDLE: SwarmInstallState = {
  message: null,
  installedVersion: null,
  version: "1.18.32",
  totalBytes: null,
  downloadedBytes: 0,
  phase: "idle",
  operationId: null,
};

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement<Record<string, unknown>>(node)) return "";
  return Object.entries(node.props)
    .filter(([key]) => key !== "className")
    .map(([, value]) => textOf(value))
    .join(" ");
}

const handlers = { onInstall: vi.fn(), onCancel: vi.fn(), onCheckAgain: vi.fn() };

function render(opencode: SwarmOpencodeStatus, install: SwarmInstallState) {
  hooks.startRender();
  return SwarmInstallPanel({ opencode, install, ...handlers });
}

function button(view: unknown, label: string) {
  const found = findElement(
    view,
    (element) =>
      typeof element.props.onClick === "function" && textOf(element.props.children).includes(label),
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("SwarmInstallPanel", () => {
  beforeEach(() => {
    hooks.clear();
    vi.clearAllMocks();
  });

  it("asks to update an OpenCode that is too old", () => {
    const text = textOf(
      render({ ...SWARM_STATUS_READY.opencode, version: "1.10.0", versionOk: false }, IDLE),
    );
    expect(text).toContain("OpenCode 1.10.0 is too old");
    expect(text).toContain("1.18.0 or newer");
  });

  it("shows where OpenCode was found; the PATH note only for a copy Kora did not install", () => {
    const view = render(SWARM_STATUS_READY.opencode, IDLE);
    const text = textOf(view);
    expect(text).toContain("OpenCode 1.18.32 found");
    expect(text).toContain("/Users/example/.kora/tools/opencode/current/opencode");
    expect(text).not.toContain("Kora will use the full path");
    expect(
      textOf(
        render({ ...SWARM_STATUS_READY.opencode, source: "config", onDaemonPath: false }, IDLE),
      ),
    ).toContain("Kora will use the full path");
    (button(view, "Check again").props.onClick as () => void)();
    expect(handlers.onCheckAgain).toHaveBeenCalledOnce();
  });

  it("shows a failure with Retry and I'll install it myself", () => {
    const failed = { ...IDLE, phase: "failed" as const, message: "network: connection reset" };
    let view = render(SWARM_STATUS_OPENCODE_MISSING.opencode, failed);
    expect(textOf(view)).toContain("Install failed");
    expect(textOf(view)).toContain("network: connection reset");
    (button(view, "Retry").props.onClick as () => void)();
    expect(handlers.onInstall).toHaveBeenCalledOnce();
    (button(view, "I'll install it myself").props.onClick as () => void)();
    view = render(SWARM_STATUS_OPENCODE_MISSING.opencode, failed);
    expect(
      findElement(
        view,
        (element) => typeof element.type === "function" && "onCheckAgain" in element.props,
      ),
    ).not.toBeNull();
  });

  it("shows verifying as its own phase", () => {
    const text = textOf(
      render(SWARM_STATUS_OPENCODE_MISSING.opencode, {
        ...IDLE,
        operationId: "op-1",
        phase: "verifying",
      }),
    );
    expect(text).toContain("Checking that OpenCode runs");
  });

  it("shows download progress with Cancel", () => {
    const view = render(SWARM_STATUS_OPENCODE_MISSING.opencode, {
      ...IDLE,
      operationId: "op-1",
      phase: "downloading",
      downloadedBytes: 12_000_000,
      totalBytes: 40_000_000,
    });
    const text = textOf(view);
    expect(text).toContain("Downloading OpenCode");
    expect(text).toContain("12.0 MB");
    expect(text).toContain("40.0 MB");
    expect(findElement(view, (element) => element.type === "progress")?.props.value).toBe(
      12_000_000,
    );
    (button(view, "Cancel").props.onClick as () => void)();
    expect(handlers.onCancel).toHaveBeenCalledWith("op-1");
  });

  it("offers the manual commands as copy-only, with Check again", () => {
    let view = render(SWARM_STATUS_OPENCODE_MISSING.opencode, IDLE);
    (button(view, "Install it myself").props.onClick as () => void)();
    view = render(SWARM_STATUS_OPENCODE_MISSING.opencode, IDLE);
    const manual = findElement(
      view,
      (element) => typeof element.type === "function" && "onCheckAgain" in element.props,
    );
    expect(manual).not.toBeNull();
    const Manual = manual!.type as FunctionComponent<Record<string, unknown>>;
    const manualView = Manual(manual!.props);
    const text = textOf(manualView);
    expect(text).toContain("brew install anomalyco/tap/opencode");
    expect(text).toContain("curl -fsSL https://opencode.ai/install | bash");
    expect(text).toContain("npm i -g opencode-ai");
    expect(text).toContain("~/.opencode/bin");
    (button(manualView, "Check again").props.onClick as () => void)();
    expect(handlers.onCheckAgain).toHaveBeenCalledOnce();
  });

  it("explains the install method before anything runs", () => {
    const view = render(SWARM_STATUS_OPENCODE_MISSING.opencode, IDLE);
    const text = textOf(view);
    expect(text).toContain("OpenCode isn't installed");
    expect(text).toContain("github.com/anomalyco/opencode");
    expect(text).toContain("~/.kora/tools/opencode");
    expect(text).toContain("no shell files are edited");
    expect(handlers.onInstall).not.toHaveBeenCalled();
    (button(view, "Download & install OpenCode 1.18.32").props.onClick as () => void)();
    expect(handlers.onInstall).toHaveBeenCalledOnce();
  });
});
