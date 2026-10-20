import { describe, expect, it, beforeEach } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { HostId, ThreadId } from "@kora/contracts";
import { hostThreadRef } from "@kora/client-runtime/host";
import { usePromptDraftStore } from "../../stores/promptDraftStore";
import { useTaskBoundaryItems, type BoundaryMessage } from "./TaskBoundaryBanner";

const target = hostThreadRef(HostId.make("host-1"), ThreadId.make("thread-1"));
const messages: BoundaryMessage[] = [
  {
    id: "1",
    role: "user",
    text: "fix the stop button so interruptTurn ends the session in ClaudeDriver",
  },
  {
    id: "2",
    role: "assistant",
    text: "I changed claude-driver.ts: sendTurn now calls interruptTurn first",
  },
  { id: "3", role: "user", text: "and does clearHalt run on result in ClaudeDriver?" },
  { id: "4", role: "assistant", text: "yes, clearHalt runs when the result arrives" },
  { id: "5", role: "user", text: "ok good, run the ClaudeDriver tests" },
  { id: "6", role: "assistant", text: "all ClaudeDriver tests pass" },
];

function Probe(props: {
  readonly enabled?: boolean;
  readonly used?: number;
  readonly busy?: boolean;
}) {
  const items = useTaskBoundaryItems({
    enabled: props.enabled ?? true,
    threadId: "thread-1",
    draftTarget: target,
    messages,
    usedTokens: props.used ?? 117_000,
    busy: props.busy ?? false,
    compacting: false,
    compactUnavailable: false,
    httpBaseUrl: "http://127.0.0.1:1",
    compact: async () => {},
    openFresh: async () => null,
    notify: () => {},
  });
  return (
    <ul>
      {items.map((i) => (
        <li key={i.id}>{String(i.title)}</li>
      ))}
    </ul>
  );
}

function draft(text: string) {
  usePromptDraftStore.getState().setPrompt(target, text);
}

describe("useTaskBoundaryItems", () => {
  beforeEach(() => draft(""));

  it("shows the offer for an unrelated prompt in a long thread", () => {
    draft("let's redesign the billing page invoice table with sortable columns");
    expect(renderToStaticMarkup(<Probe />)).toContain("This looks like a new task");
  });
  it("stays quiet for a related prompt, a small context, a busy thread or when switched off", () => {
    draft("does the ClaudeDriver interruptTurn path also clear the halted state?");
    expect(renderToStaticMarkup(<Probe />)).not.toContain("new task");
    draft("let's redesign the billing page invoice table with sortable columns");
    expect(renderToStaticMarkup(<Probe used={30_000} />)).not.toContain("new task");
    expect(renderToStaticMarkup(<Probe busy />)).not.toContain("new task");
    expect(renderToStaticMarkup(<Probe enabled={false} />)).not.toContain("new task");
  });
});
