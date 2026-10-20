import {
  SWARM_STATUS_NEEDS_CONSENT,
  SWARM_STATUS_OPENCODE_MISSING,
} from "../../util/swarm.fixtures";
import { hookStub as hooks } from "../../test/hookStub";

import { findElement } from "../../test/findElement";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react/compiler-runtime", async () => {
  const { hookStub } = await import("../../test/hookStub");
  return { c: hookStub.useMemoCache };
});

import { SwarmReadinessChecklist } from "./SwarmReadinessChecklist";

function clickLink(view: unknown, label: string) {
  const link = findElement(view, (element) => element.props["aria-label"] === label);
  if (!link) throw new Error(`Missing link: ${label}`);
  (link.props.onClick as () => void)();
}

describe("SwarmReadinessChecklist fix links", () => {
  beforeEach(() => hooks.clear());

  it("sends a missing consent back to the privacy step", () => {
    const onFix = vi.fn();
    hooks.startRender();
    const view = SwarmReadinessChecklist({ status: SWARM_STATUS_NEEDS_CONSENT, onFix });
    clickLink(view, "Fix: Privacy consent");
    expect(onFix).toHaveBeenCalledWith("intro");
  });

  it("jumps to the step that fixes each row", () => {
    const onFix = vi.fn();
    hooks.startRender();
    const view = SwarmReadinessChecklist({ status: SWARM_STATUS_OPENCODE_MISSING, onFix });
    clickLink(view, "Fix: OpenCode");
    clickLink(view, "Change: OpenRouter");
    clickLink(view, "Fix: Privacy consent");
    expect(onFix.mock.calls).toEqual([["opencode"], ["providers"], ["intro"]]);
  });
});
