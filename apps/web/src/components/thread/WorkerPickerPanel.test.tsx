import { describe, expect, it, vi } from "vite-plus/test";
import { act, create } from "react-test-renderer";

import { WorkerPickerPanel } from "./WorkerPickerPanel";
import type { PendingWorkerPicker } from "./workerPicker.logic";

const catalog = {
  claude: { installed: true, models: [{ id: "sonnet", name: "Sonnet 5.5", efforts: ["medium"] }] },
  antigravity: {
    installed: true,
    models: [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash", efforts: [] }],
  },
} as unknown as PendingWorkerPicker["catalog"];

// A fresh request object (and a fresh picks array) for the SAME request id: what the thread view derives on every
// new activity while the picker is open.
const request = (): PendingWorkerPicker => ({
  requestId: "wp_1",
  picks: [{ title: "Research", agent: "claude", model: "sonnet", effort: "medium" }],
  catalog,
});

describe("WorkerPickerPanel", () => {
  it("keeps the human's edit when the request is re-derived while the picker is open", () => {
    const onSubmit = vi.fn();
    const props = { busy: false, onSubmit, onDecline: () => {} };
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(<WorkerPickerPanel {...props} request={request()} />);
    });
    const agentSelect = () =>
      r.root.find((n) => n.type === "select" && n.props["data-worker-pick-agent"] === 0);
    act(() => agentSelect().props.onChange({ target: { value: "antigravity" } }));
    act(() => r.update(<WorkerPickerPanel {...props} request={request()} />));
    expect(agentSelect().props.value).toBe("antigravity");
    act(() =>
      r.root
        .find((n) => n.type === "button" && n.props["data-worker-picker-approve"] !== undefined)
        .props.onClick(),
    );
    const picks = (onSubmit.mock.calls[0]![0] as { picks: Array<{ agent: string }> }).picks;
    expect(picks[0]!.agent).toBe("antigravity");
  });

  const panel = (r: ReturnType<typeof create>) =>
    r.root.find((n) => n.type === "div" && n.props["data-worker-picker"] === "wp_1");
  const key = (keyName: string, target: unknown, currentTarget: unknown) => ({
    key: keyName,
    target,
    currentTarget,
    preventDefault: () => {},
  });

  it("Enter approves only from the panel itself, never from Decline or another control", () => {
    const onSubmit = vi.fn();
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(
        <WorkerPickerPanel
          request={request()}
          busy={false}
          onSubmit={onSubmit}
          onDecline={() => {}}
        />,
      );
    });
    const self = {};
    act(() => panel(r).props.onKeyDown(key("Enter", {}, self)));
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => panel(r).props.onKeyDown(key("Enter", self, self)));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Escape declines at once when nothing changed, and asks first after an edit", () => {
    const onDecline = vi.fn();
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(
        <WorkerPickerPanel
          request={request()}
          busy={false}
          onSubmit={() => {}}
          onDecline={onDecline}
        />,
      );
    });
    act(() => panel(r).props.onKeyDown(key("Escape", {}, {})));
    expect(onDecline).toHaveBeenCalledTimes(1);

    act(() => {
      r = create(
        <WorkerPickerPanel
          request={request()}
          busy={false}
          onSubmit={() => {}}
          onDecline={onDecline}
        />,
      );
    });
    act(() =>
      r.root
        .find((n) => n.type === "select" && n.props["data-worker-pick-agent"] === 0)
        .props.onChange({ target: { value: "antigravity" } }),
    );
    act(() => panel(r).props.onKeyDown(key("Escape", {}, {})));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(
      r.root.findAll((n) => n.props["data-worker-picker-decline-confirm"] !== undefined).length,
    ).toBeGreaterThan(0);
    act(() => panel(r).props.onKeyDown(key("Escape", {}, {})));
    expect(onDecline).toHaveBeenCalledTimes(2);
  });
});
