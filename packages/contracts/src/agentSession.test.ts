import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "./primitives.ts";
import * as Provider from "./agentSession.ts";

const startInput = Schema.decodeUnknownSync(Provider.AgentSessionStartInput);
const sendTurn = Schema.decodeUnknownSync(Provider.AgentSendTurnInput);
const session = Schema.decodeUnknownSync(Provider.AgentSession);
const event = Schema.decodeUnknownSync(Provider.AgentEvent);

const T = "th-42";
const WHEN = "2025-02-03T04:05:06Z";

/** The decoded options as a plain `{ id: value }` record. */
const optionsOf = (pick: { options?: ReadonlyArray<{ id: string; value: unknown }> } | undefined) =>
  Object.fromEntries((pick?.options ?? []).map(({ id, value }) => [id, value]));

const pickOf = (provider: string, model: string, options: Record<string, unknown> = {}) => ({
  provider,
  model,
  options: Object.entries(options).map(([id, value]) => ({ id, value })),
});

describe("session start input", () => {
  const start = (extra: Record<string, unknown>) =>
    startInput({ threadId: T, cwd: "/work/repo", runtimeMode: "full-access", ...extra });

  it.each([
    ["codex", "gpt-5.5-codex", { reasoningEffort: "xhigh", fastMode: true }],
    ["claude", "claude-opus-5-5", { thinking: true, effort: "high", fastMode: false }],
    ["cursor", "composer-3", { fastMode: true }],
  ] as const)("decodes a %s start with its model knobs", (provider, model, options) => {
    const parsed = start({ provider, modelSelection: pickOf(provider, model, options) });
    expect(parsed.provider).toBe(provider);
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelSelection?.instanceId).toBe(provider);
    expect(parsed.modelSelection?.model).toBe(model);
    expect(optionsOf(parsed.modelSelection)).toEqual(options);
  });

  it("treats an unknown driver kind as a slug and routes by its instance", () => {
    const parsed = start({
      provider: "lmstudio",
      providerInstanceId: "lmstudio_desk",
      modelSelection: { instanceId: "lmstudio_desk", model: "qwen3-coder" },
    });
    expect([parsed.provider, parsed.providerInstanceId, parsed.modelSelection?.instanceId]).toEqual(
      ["lmstudio", "lmstudio_desk", "lmstudio_desk"],
    );
  });

  it("requires a runtime mode", () => {
    expect(() => startInput({ threadId: T, provider: "codex" })).toThrow();
  });

  it("makes providerInstanceId optional but checks its slug shape", () => {
    expect(start({ provider: "codex" }).providerInstanceId).toBeUndefined();
    expect(start({ provider: "codex", providerInstanceId: "codex_home" }).providerInstanceId).toBe(
      "codex_home",
    );
    expect(() => start({ provider: "codex", providerInstanceId: "0codex" })).toThrow();
  });
});

describe("send turn input", () => {
  it.each([
    ["codex", "gpt-5.5-codex", { fastMode: true, reasoningEffort: "medium" }],
    ["claude", "claude-sonnet-5-5", { fastMode: false, effort: "ultrathink" }],
  ] as const)("keeps a %s model pick", (provider, model, options) => {
    const parsed = sendTurn({ threadId: T, modelSelection: pickOf(provider, model, options) });
    expect(parsed.modelSelection?.instanceId).toBe(provider);
    expect(parsed.modelSelection?.model).toBe(model);
    expect(optionsOf(parsed.modelSelection)).toEqual(options);
  });
});

describe("instance routing on sessions and events", () => {
  const sessionWire = (provider: string, providerInstanceId: string) => ({
    threadId: T,
    provider,
    providerInstanceId,
    runtimeMode: "full-access",
    status: "ready",
    createdAt: WHEN,
    updatedAt: WHEN,
  });

  it("a session keeps its instance id, for known and unknown drivers", () => {
    expect(session(sessionWire("codex", "codex_job")).providerInstanceId).toBe("codex_job");
    const fork = session(sessionWire("lmstudio", "lmstudio_desk"));
    expect([fork.provider, fork.providerInstanceId]).toEqual(["lmstudio", "lmstudio_desk"]);
  });

  it("an event carries both the legacy provider and the instance", () => {
    const decoded = event({
      kind: "notification",
      id: "ev-9",
      method: "session.created",
      threadId: T,
      createdAt: WHEN,
      provider: "codex",
      providerInstanceId: "codex_home",
    });
    expect([decoded.provider, decoded.providerInstanceId]).toEqual(["codex", "codex_home"]);
  });
});

describe("feedback upload", () => {
  const input = Schema.decodeUnknownSync(Provider.AgentUploadFeedbackInput);

  it("takes a thread and, optionally, a reason", () => {
    expect(input({ threadId: T })).toEqual({ threadId: T });
    expect(input({ reason: "It looped forever.", threadId: T })).toEqual({
      threadId: T,
      reason: "It looped forever.",
    });
  });

  it("returns the provider's feedback id", () => {
    const result = Schema.decodeUnknownSync(Provider.AgentUploadFeedbackResult)({
      feedbackId: "fb-77",
    });
    expect(result).toEqual({ feedbackId: "fb-77" });
  });

  it("fails with the thread and cause but a message free of provider text", () => {
    const cause = new Error("token=abc123 leaked");
    const failure = new Provider.AgentUploadFeedbackError({ threadId: ThreadId.make(T), cause });
    expect(failure.threadId).toBe(T);
    expect(failure.cause).toBe(cause);
    expect(failure.message).toBe(`Failed to upload feedback for thread ${T}.`);
    expect(failure.message.includes("abc123")).toBe(false);
  });
});
