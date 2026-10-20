import { collectAssistantFootnotes, serializeReplyFootnote } from "@kora/shared/assistantFootnotes";
import { createModelPick } from "@kora/shared/modelOptions";
import {
  type AgentOptionSelection,
  type WebMarkupPayload,
  type ModelPick,
  ThreadId,
  AgentProfileId,
  AgentId,
  ProjectId,
  ItemId,
  HostId,
  defaultProfileIdForDriver,
} from "@kora/contracts";
import {
  hostThreadRef,
  hostProjectRef,
  hostThreadKey,
  hostProjectKey,
} from "@kora/client-runtime/host";

const CURSOR_DRIVER = AgentId.make("cursor");
const CLAUDE_AGENT_DRIVER = AgentId.make("claude");
const CODEX_DRIVER = AgentId.make("codex");
const CURSOR_INSTANCE = AgentProfileId.make("cursor");
const CLAUDE_AGENT_INSTANCE = AgentProfileId.make("claude");
const CODEX_SECONDARY_INSTANCE = AgentProfileId.make("codex_secondary");

// The composer draft's `modelSelectionByProvider` and
// `stickyModelSelectionByProvider` maps are keyed by `AgentProfileId`
// in production; these aliases keep the legacy-key migration tests concise.
const CODEX_INSTANCE = AgentProfileId.make("codex");

type AgentOptionSelectionBag = ReadonlyArray<AgentOptionSelection>;
type AgentOptionSelectionsByAgent = Partial<Record<string, AgentOptionSelectionBag>>;

function toSelections(
  options: Record<string, string | boolean | undefined> | undefined,
): ReadonlyArray<AgentOptionSelection> {
  const result: Array<AgentOptionSelection> = [];
  for (const [id, value] of Object.entries(options ?? {})) {
    const usable = typeof value === "string" || typeof value === "boolean";
    if (usable) result.push({ id, value });
  }
  return result;
}

function selectionsByAgent(
  options: Partial<Record<AgentId, Record<string, string | boolean | undefined>>>,
): AgentOptionSelectionsByAgent {
  const result: AgentOptionSelectionsByAgent = {};
  for (const [provider, bag] of Object.entries(options) as Array<
    [AgentId, Record<string, string | boolean | undefined>]
  >) {
    result[provider] = toSelections(bag);
  }
  return result;
}
import { createDeferredStorage } from "../util/storage";
import {
  type TerminalExcerptDraft,
  formatTerminalExcerptReference,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
} from "../util/terminalContext";
import { terminalExcerptReference } from "../util/contextChipRecords";
import { insertInlineContextLink } from "../util/contextChipReferences";

import {
  DraftId,
  usePromptDraftStore,
  partializePromptDraftStoreState,
  restoreFailedBackgroundDraftThread,
  markDraftPromoted,
  finalizePromotedDraftByRef,
  promptDraftHasUserContent,
  clearPromptDraftsHost,
  beginBackgroundDraftSubmissionByRef,
  PROMPT_DRAFT_STORAGE_KEY,
} from "./promptDraftStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type DraftStoreState = ReturnType<typeof usePromptDraftStore.getState>;
// Late-bound views of store actions: each call resolves the live state first.
const viaStore = <K extends keyof DraftStoreState>(name: K): DraftStoreState[K] =>
  ((...args: unknown[]) =>
    (usePromptDraftStore.getState()[name] as (...rest: unknown[]) => unknown)(
      ...args,
    )) as DraftStoreState[K];
const bindProject = viaStore("setProjectDraftThreadId");
const typePrompt = viaStore("setPrompt");
const draftThreadOf = viaStore("getDraftThread");
const mappedThread = viaStore("getDraftThreadByProjectRef");
const composerOf = viaStore("getComposerDraft");
const pickModel = viaStore("setModelSelection");
const tuneOptions = viaStore("setProviderModelOptions");
const pinSticky = viaStore("setStickyModelSelection");
const patchContext = viaStore("setDraftThreadContext");
const attachComment = viaStore("addReviewComment");
const sessionOf = viaStore("getDraftSession");
const onInsert = viaStore("setContextInsertionHandler");
const threadByRef = viaStore("getDraftThreadByRef");
const attachTerminal = viaStore("addTerminalContext");
const detachTerminal = viaStore("removeTerminalContext");
const replaceTerminals = viaStore("setTerminalContexts");
const dropTerminals = viaStore("clearTerminalContexts");
const chooseRuntime = viaStore("setRuntimeMode");
const chooseInteraction = viaStore("setInteractionMode");
const attachAnnotation = viaStore("addPreviewAnnotation");
const replaceAnnotations = viaStore("setPreviewAnnotations");

function terminalDraft(input: {
  id: string;
  lineEnd?: number;
  lineStart?: number;
  terminalLabel?: string;
  terminalId?: string;
  text?: string;
}): TerminalExcerptDraft {
  return {
    createdAt: "2026-03-13T12:00:00.000Z",
    text: input.text ?? "git status\nOn branch main",
    lineEnd: input.lineEnd ?? 5,
    lineStart: input.lineStart ?? 4,
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    terminalId: input.terminalId ?? "default",
    threadId: ThreadId.make("thread-dedupe"),
    id: input.id,
  };
}

function resetPromptDraftStore() {
  usePromptDraftStore.setState({
    stickyActiveProvider: null,
    stickyModelSelectionByProvider: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    draftThreadsByThreadKey: {},
    draftsByThreadKey: {},
    rewindingThreadKeys: new Set(),
  });
}

function modelSelection(
  provider: AgentId,
  model: string,
  options?: Record<string, string | boolean | undefined>,
): ModelPick {
  return createModelPick(defaultProfileIdForDriver(provider), model, toSelections(options));
}

function agentModelOptions(
  options: Partial<Record<string, Record<string, string | boolean | undefined>>>,
): AgentOptionSelectionsByAgent {
  return selectionsByAgent(options);
}

const LEGACY_TEST_HOST_ID = HostId.make("__legacy__");
const OTHER_TEST_HOST_ID = HostId.make("environment-remote");

const TEST_HOST_ID = HostId.make("environment-local");

function threadKeyFor(threadId: ThreadId, hostId: HostId = LEGACY_TEST_HOST_ID): string {
  if (hostId === LEGACY_TEST_HOST_ID) {
    return threadId;
  }
  return hostThreadKey(hostThreadRef(hostId, threadId));
}

function draftFor(threadId: ThreadId, hostId: HostId = LEGACY_TEST_HOST_ID) {
  const store = usePromptDraftStore.getState().draftsByThreadKey;
  return store[threadKeyFor(threadId, hostId)] ?? store[threadId] ?? undefined;
}

function draftByKey(key: string) {
  const { draftsByThreadKey } = usePromptDraftStore.getState();
  return draftsByThreadKey[key] ?? undefined;
}

describe("promptDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.make("thread-prefs");
  const threadRef = hostThreadRef(TEST_HOST_ID, threadId);

  beforeEach(() => {
    resetPromptDraftStore();
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    chooseRuntime(threadRef, "approval-required");
    chooseInteraction(threadRef, "plan");
    chooseRuntime(threadRef, null);
    chooseInteraction(threadRef, null);

    expect(draftFor(threadId, TEST_HOST_ID)).toBeUndefined();
  });

  it("stores interaction mode overrides in the composer draft", () => {
    chooseInteraction(threadRef, "plan");

    expect(draftFor(threadId, TEST_HOST_ID)?.interactionMode).toBe("plan");
  });

  it("stores runtime mode overrides in the composer draft", () => {
    chooseRuntime(threadRef, "approval-required");

    expect(draftFor(threadId, TEST_HOST_ID)?.runtimeMode).toBe("approval-required");
  });
});

describe("promptDraftStore provider-scoped option updates", () => {
  const threadId = ThreadId.make("thread-provider");
  const threadRef = hostThreadRef(TEST_HOST_ID, threadId);

  beforeEach(() => {
    resetPromptDraftStore();
  });

  it("retains off-provider option memory without changing the active selection", () => {
    pickModel(
      threadRef,
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
      }),
    );
    tuneOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ effort: "max" }));
    const draft = draftFor(threadId, TEST_HOST_ID);
    const picks = draft?.modelSelectionByProvider;
    expect(picks?.[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", { reasoningEffort: "medium" }),
    );
    expect(picks?.[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelPick(CLAUDE_AGENT_INSTANCE, "claude-opus-4-9", toSelections({ effort: "max" }))
        .options,
    );
    expect(draft?.activeProvider).toBe("codex");
  });
});

describe("promptDraftStore model seed migration", () => {
  const serverThreadId = ThreadId.make("thread-server-model");
  const typedThreadId = ThreadId.make("thread-legacy-typed-model");
  const explicitThreadId = ThreadId.make("thread-legacy-explicit-model");
  const staleThreadId = ThreadId.make("thread-legacy-stale-model");
  const typedDraftId = DraftId.make("draft-legacy-typed-model");
  const explicitDraftId = DraftId.make("draft-legacy-explicit-model");
  const staleDraftId = DraftId.make("draft-legacy-stale-model");
  const serverThreadKey = hostThreadKey(hostThreadRef(TEST_HOST_ID, serverThreadId));
  const projectId = ProjectId.make("project-model-migration");
  const logicalProjectKey = `${TEST_HOST_ID}:/tmp/project-model-migration`;

  const draftThread = (threadId: ThreadId) => ({
    promotedTo: null,
    startFromOrigin: false,
    envMode: "local",
    worktreePath: null,
    branch: null,
    interactionMode: "default",
    runtimeMode: "full-access",
    createdAt: "2026-08-01T00:00:00.000Z",
    logicalProjectKey,
    projectId,
    hostId: TEST_HOST_ID,
    threadId,
  });

  beforeEach(async () => {
    resetPromptDraftStore();
    await usePromptDraftStore.persist.clearStorage();
  });

  afterEach(async () => {
    await usePromptDraftStore.persist.clearStorage();
  });

  it("upgrading storage removes seeded models from empty draft sessions only", async () => {
    vi.useFakeTimers();
    try {
      const stickySelection = modelSelection(CODEX_DRIVER, "gpt-6.2-aqua", {
        reasoningEffort: "xhigh",
      });
      const staleSelection = modelSelection(CODEX_DRIVER, "gpt-5.4");
      const storage = usePromptDraftStore.persist.getOptions().storage;
      expect(storage).toBeDefined();
      storage?.setItem(PROMPT_DRAFT_STORAGE_KEY, {
        state: {
          stickyActiveProvider: CODEX_INSTANCE,
          stickyModelSelectionByProvider: { [CODEX_INSTANCE]: stickySelection },
          logicalProjectDraftThreadKeyByLogicalProjectKey: {
            [logicalProjectKey]: staleDraftId,
          },
          draftThreadsByThreadKey: {
            [typedDraftId]: draftThread(typedThreadId),
            [explicitDraftId]: draftThread(explicitThreadId),
            [staleDraftId]: draftThread(staleThreadId),
          },
          draftsByThreadKey: {
            [serverThreadKey]: {
              activeProvider: CODEX_INSTANCE,
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              attachments: [],
              prompt: "",
            },
            [explicitDraftId]: {
              modelSelectionExplicit: true,
              activeProvider: CODEX_INSTANCE,
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              attachments: [],
              prompt: "",
            },
            [typedDraftId]: {
              activeProvider: CODEX_INSTANCE,
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              attachments: [],
              prompt: "keep this prompt",
            },
            [staleDraftId]: {
              runtimeMode: "approval-required",
              activeProvider: CODEX_INSTANCE,
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              attachments: [],
              prompt: "",
            },
          },
        },
        version: 8,
      } as never);
      await vi.advanceTimersByTimeAsync(300);

      await usePromptDraftStore.persist.rehydrate();

      expect(draftByKey(staleDraftId)).toMatchObject({
        runtimeMode: "approval-required",
        activeProvider: null,
        modelSelectionByProvider: {},
      });
      expect(draftByKey(typedDraftId)).toMatchObject({
        activeProvider: CODEX_INSTANCE,
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        prompt: "keep this prompt",
      });
      expect(draftByKey(explicitDraftId)).toMatchObject({
        modelSelectionExplicit: true,
        activeProvider: CODEX_INSTANCE,
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
      });
      expect(draftByKey(serverThreadKey)).toMatchObject({
        activeProvider: CODEX_INSTANCE,
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
      });
      expect(usePromptDraftStore.getState().draftThreadsByThreadKey[staleDraftId]).toMatchObject({
        logicalProjectKey,
        projectId,
        hostId: TEST_HOST_ID,
      });
      expect(usePromptDraftStore.getState()).toMatchObject({
        stickyActiveProvider: CODEX_INSTANCE,
        stickyModelSelectionByProvider: { [CODEX_INSTANCE]: stickySelection },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1, 2])(
    "a v%s store that lacks a provider still yields the legacy sticky Codex pick",
    async (version) => {
      vi.useFakeTimers();
      try {
        const stickySelection = modelSelection(CODEX_DRIVER, "gpt-6.2-aqua", {
          reasoningEffort: "xhigh",
        });
        const storage = usePromptDraftStore.persist.getOptions().storage;
        expect(storage).toBeDefined();
        storage?.setItem(PROMPT_DRAFT_STORAGE_KEY, {
          state: {
            stickyModelOptions: agentModelOptions({
              [CODEX_DRIVER]: { reasoningEffort: "xhigh" },
            }),
            stickyModel: stickySelection.model,
            projectDraftThreadIdByProjectId: {},
            draftThreadsByThreadId: {},
            draftsByThreadId: {},
          },
          version,
        } as never);
        await vi.advanceTimersByTimeAsync(300);

        await usePromptDraftStore.persist.rehydrate();

        expect(usePromptDraftStore.getState()).toMatchObject({
          stickyActiveProvider: null,
          stickyModelSelectionByProvider: { [CODEX_INSTANCE]: stickySelection },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("promptDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetPromptDraftStore();
  });

  it("clears a non-explicit stale model when there is no sticky state", () => {
    const store = usePromptDraftStore.getState();
    const draftId = DraftId.make("draft-stale-without-sticky");

    pickModel(draftId, modelSelection(CODEX_DRIVER, "stale-model"));
    store.applyStickyState(draftId);

    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("replaces a non-explicit stale model and its options with sticky state", () => {
    const store = usePromptDraftStore.getState();
    const draftId = DraftId.make("draft-stale-sticky-seed");

    pickModel(draftId, modelSelection(CODEX_DRIVER, "stale-model", { reasoningEffort: "low" }));
    pinSticky(modelSelection(CODEX_DRIVER, "pinned-model", { reasoningEffort: "xhigh" }));
    store.applyStickyState(draftId);

    expect(draftByKey(draftId)).toMatchObject({
      modelSelectionByProvider: {
        [CODEX_INSTANCE]: modelSelection(CODEX_DRIVER, "pinned-model", {
          reasoningEffort: "xhigh",
        }),
      },
      activeProvider: CODEX_INSTANCE,
    });
  });

  it("applies sticky activeProvider to new drafts", () => {
    const store = usePromptDraftStore.getState();
    const threadId = ThreadId.make("thread-sticky-active-provider");
    const threadRef = hostThreadRef(TEST_HOST_ID, threadId);

    pinSticky(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9"));
    store.applyStickyState(threadRef);

    expect(draftFor(threadId, TEST_HOST_ID)).toMatchObject({
      activeProvider: "claude",
      modelSelectionByProvider: {
        claude: modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9"),
      },
    });
  });

  it("preserves sticky options when the same model is picked again without options", () => {
    pinSticky(
      modelSelection(CURSOR_DRIVER, "composer-2", {
        fastMode: false,
      }),
    );
    pinSticky(modelSelection(CURSOR_DRIVER, "composer-2"));

    expect(usePromptDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE]).toEqual(
      modelSelection(CURSOR_DRIVER, "composer-2", {
        fastMode: false,
      }),
    );
  });

  it("remembers model and effort as a pair: another model drops the old effort (pl2 S2-2)", () => {
    pinSticky(modelSelection(CLAUDE_AGENT_DRIVER, "claude-sonnet-5-5", { effort: "max" }));
    pinSticky(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-7"));

    expect(
      usePromptDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-7"));
  });

  it("drops empty cursor model options when normalizing sticky state", () => {
    pinSticky(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        contextWindow: undefined,
        thinking: undefined,
        fastMode: undefined,
        reasoning: undefined,
      }),
    );

    expect(usePromptDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE]).toEqual(
      modelSelection(CURSOR_DRIVER, "gpt-5.4"),
    );
    expect(usePromptDraftStore.getState().stickyActiveProvider).toBe("cursor");
  });

  it("normalizes empty sticky model options by dropping selection options", () => {
    pinSticky(modelSelection(CODEX_DRIVER, "gpt-5.4"));

    expect(usePromptDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4"),
    );
    expect(usePromptDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("stores a sticky model selection", () => {
    pinSticky(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        fastMode: true,
        reasoningEffort: "medium",
      }),
    );

    expect(usePromptDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        fastMode: true,
        reasoningEffort: "medium",
      }),
    );
    expect(usePromptDraftStore.getState().stickyActiveProvider).toBe("codex");
  });
});

describe("promptDraftStore setModelSelection", () => {
  const threadId = ThreadId.make("thread-model");
  const threadRef = hostThreadRef(TEST_HOST_ID, threadId);

  beforeEach(() => {
    resetPromptDraftStore();
  });

  it("keeps explicit model overrides instead of coercing to null", () => {
    pickModel(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.3-codex"));

    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex"),
    );
  });
});

describe("promptDraftStore modelSelection", () => {
  const threadId = ThreadId.make("thread-model-options");
  const threadRef = hostThreadRef(TEST_HOST_ID, threadId);

  beforeEach(() => {
    resetPromptDraftStore();
  });

  it("updates only the draft when sticky persistence is disabled", () => {
    pinSticky(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", { effort: "max" }));
    pickModel(threadRef, modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", { effort: "max" }));

    tuneOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ thinking: false }), {
      persistSticky: false,
    });

    expect(
      draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", {
        thinking: false,
      }),
    );
    expect(
      usePromptDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", { effort: "max" }));
  });

  it("stores provider option changes on a selected custom instance", () => {
    tuneOptions(threadRef, CODEX_DRIVER, toSelections({ reasoningEffort: "low" }), {
      persistSticky: true,
      model: "gpt-5-codex",
      instanceId: CODEX_SECONDARY_INSTANCE,
    });

    expect(
      draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        options: [{ id: "reasoningEffort", value: "low" }],
        instanceId: CODEX_SECONDARY_INSTANCE,
      }),
    );
    expect(draftFor(threadId, TEST_HOST_ID)?.activeProvider).toBe(CODEX_SECONDARY_INSTANCE);
    expect(usePromptDraftStore.getState().stickyActiveProvider).toBe(CODEX_SECONDARY_INSTANCE);
    expect(usePromptDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toBe(
      undefined,
    );
    expect(
      usePromptDraftStore.getState().stickyModelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        options: [{ id: "reasoningEffort", value: "low" }],
        instanceId: CODEX_SECONDARY_INSTANCE,
      }),
    );
  });

  it("creates the first sticky snapshot from provider option changes", () => {
    pickModel(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));

    tuneOptions(threadRef, CODEX_DRIVER, toSelections({ fastMode: true }), {
      persistSticky: true,
    });

    expect(usePromptDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4", {
        fastMode: true,
      }),
    );
  });

  it("preserves other provider options when switching the active model selection", () => {
    const store = usePromptDraftStore.getState();

    store.setModelOptions(
      threadRef,
      agentModelOptions({
        claude: { effort: "max" },
        codex: { fastMode: true },
      }),
    );

    pickModel(threadRef, modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9"));

    const draft = draftFor(threadId, TEST_HOST_ID);
    const picks = draft?.modelSelectionByProvider;
    expect(picks?.[CLAUDE_AGENT_INSTANCE]).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", { effort: "max" }),
    );
    expect(picks?.[CODEX_INSTANCE]?.options).toEqual(
      createModelPick(CODEX_INSTANCE, "gpt-5.4", toSelections({ fastMode: true })).options,
    );
    expect(draft?.activeProvider).toBe("claude");
  });

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = usePromptDraftStore.getState();

    // Set options for both providers
    store.setModelOptions(
      threadRef,
      agentModelOptions({
        claude: { effort: "max" },
        codex: { fastMode: true },
      }),
    );

    // Now set options for only codex — claude should be untouched
    store.setModelOptions(threadRef, agentModelOptions({ codex: { reasoningEffort: "xhigh" } }));

    const draft = draftFor(threadId, TEST_HOST_ID);
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]?.options).toEqual(
      createModelPick(CODEX_INSTANCE, "gpt-5.4", toSelections({ reasoningEffort: "xhigh" }))
        .options,
    );
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelPick(CLAUDE_AGENT_INSTANCE, "claude-opus-4-9", toSelections({ effort: "max" }))
        .options,
    );
  });

  it("updates only the draft when sticky persistence is omitted", () => {
    pinSticky(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", { effort: "max" }));
    pickModel(threadRef, modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", { effort: "max" }));

    tuneOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ thinking: false }));

    expect(
      draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", {
        thinking: false,
      }),
    );
    expect(
      usePromptDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", { effort: "max" }));
  });

  it("preserves the selected Cursor model when only traits change", () => {
    tuneOptions(threadRef, CURSOR_DRIVER, toSelections({ reasoning: "high" }), {
      persistSticky: true,
      model: "gpt-5.4",
    });

    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CURSOR_INSTANCE]).toEqual(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: "high",
      }),
    );
    expect(usePromptDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE]).toEqual(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: "high",
      }),
    );
  });

  it("keeps explicit Cursor reset overrides on the selection", () => {
    pickModel(
      threadRef,
      modelSelection(CURSOR_DRIVER, "claude-opus-4-9", {
        reasoning: "high",
        fastMode: true,
        thinking: false,
      }),
    );

    tuneOptions(
      threadRef,
      CURSOR_DRIVER,
      toSelections({ reasoning: "low", fastMode: false, thinking: true }),
    );

    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CURSOR_INSTANCE]).toEqual(
      modelSelection(CURSOR_DRIVER, "claude-opus-4-9", {
        reasoning: "low",
        fastMode: false,
        thinking: true,
      }),
    );
  });

  it("keeps explicit off/default codex overrides on the selection", () => {
    pickModel(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4", { fastMode: true }));

    tuneOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "high", fastMode: false }),
    );

    const expectedPick = modelSelection(CODEX_DRIVER, "gpt-5.4", {
      reasoningEffort: "high",
      fastMode: false,
    });
    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      expectedPick,
    );
  });

  it("keeps explicit default-state overrides on the selection", () => {
    pickModel(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", {
        effort: "max",
      }),
    );

    tuneOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ thinking: true }));

    expect(
      draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", {
        thinking: true,
      }),
    );
    expect(usePromptDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
  });

  it("marks trait edits as explicit model intent", () => {
    pickModel(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));
    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionExplicit).toBeUndefined();

    tuneOptions(threadRef, CODEX_DRIVER, toSelections({ reasoningEffort: "xhigh" }));

    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionExplicit).toBe(true);
    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4", { reasoningEffort: "xhigh" }),
    );
  });

  it("replaces only the targeted provider options on the current model selection", () => {
    pickModel(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", {
        fastMode: true,
        effort: "max",
      }),
    );
    pinSticky(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", {
        fastMode: true,
        effort: "max",
      }),
    );

    tuneOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ thinking: false }), {
      persistSticky: true,
    });

    expect(
      draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", {
        thinking: false,
      }),
    );
    expect(
      usePromptDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-9", {
        thinking: false,
      }),
    );
  });

  it("persists the explicit marker through storage round-trips", async () => {
    vi.useFakeTimers();
    try {
      pickModel(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"), {
        explicit: true,
      });
      // Land the debounced persist write.
      await vi.advanceTimersByTimeAsync(300);

      // Hydrate from the same storage the store persists into and verify the
      // marker survives the partialize → decode → merge path.
      resetPromptDraftStore();
      await usePromptDraftStore.persist.rehydrate();
      expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionExplicit).toBe(true);
      expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
        modelSelection(CODEX_DRIVER, "gpt-5.4"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks picker writes explicit and seeding writes non-explicit", () => {
    pickModel(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));
    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionExplicit).toBeUndefined();

    pickModel(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"), {
      explicit: true,
    });
    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionExplicit).toBe(true);

    // Last writer defines intent: a later seed clears the marker.
    pickModel(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"), {
      replaceOptions: true,
    });
    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionExplicit).toBeUndefined();
  });

  it("keeps default-only model selections on the draft", () => {
    pickModel(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));

    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4"),
    );
  });

  it("stores a model selection in the draft", () => {
    pickModel(
      threadRef,
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        fastMode: true,
        reasoningEffort: "xhigh",
      }),
    );

    expect(draftFor(threadId, TEST_HOST_ID)?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        fastMode: true,
        reasoningEffort: "xhigh",
      }),
    );
  });
});

describe("promptDraftStore project draft thread mapping", () => {
  const otherProjectId = ProjectId.make("project-b");
  const projectId = ProjectId.make("project-a");
  const projectRef = hostProjectRef(TEST_HOST_ID, projectId);
  const otherProjectRef = hostProjectRef(TEST_HOST_ID, otherProjectId);
  const remoteProjectRef = hostProjectRef(OTHER_TEST_HOST_ID, projectId);
  const remoteDraftId = DraftId.make("draft-remote");
  const localDraftId = DraftId.make("draft-local");
  const sharedDraftId = DraftId.make("draft-shared");
  const otherDraftId = DraftId.make("draft-b");
  const draftId = DraftId.make("draft-a");
  const otherThreadId = ThreadId.make("thread-b");
  const threadId = ThreadId.make("thread-a");

  beforeEach(() => {
    resetPromptDraftStore();
  });

  it("clears branch and worktree but keeps env mode when changing a draft thread project ref", () => {
    bindProject(projectRef, draftId, {
      startFromOrigin: true,
      envMode: "worktree",
      worktreePath: "/tmp/local-worktree",
      branch: "feature/local-only",
      threadId,
    });

    patchContext(draftId, {
      projectRef: remoteProjectRef,
    });

    expect(draftThreadOf(draftId)).toMatchObject({
      startFromOrigin: true,
      envMode: "worktree",
      worktreePath: null,
      branch: null,
      projectId,
      hostId: OTHER_TEST_HOST_ID,
    });
  });

  it("pins manual workspace choices and can return to automatic routing without losing the prompt", () => {
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "keep this prompt");
    patchContext(draftId, {
      loadBalancedHostId: OTHER_TEST_HOST_ID,
      hostSelection: "auto",
      projectRef: remoteProjectRef,
    });
    expect(draftThreadOf(draftId)).toMatchObject({
      loadBalancedHostId: OTHER_TEST_HOST_ID,
      hostSelection: "auto",
      hostId: OTHER_TEST_HOST_ID,
    });
    patchContext(draftId, { branch: "feature/pinned" });
    expect(draftThreadOf(draftId)?.hostSelection).toBe("manual");
    patchContext(draftId, {
      loadBalancedHostId: null,
      hostSelection: "auto",
      branch: null,
    });
    expect(draftThreadOf(draftId)).toMatchObject({
      loadBalancedHostId: null,
      hostSelection: "auto",
      branch: null,
    });
    expect(composerOf(draftId)?.prompt).toBe("keep this prompt");
  });

  it("does not opt a legacy branch choice into balancing when runtime mode changes", () => {
    bindProject(projectRef, draftId, { threadId, branch: "feature/pinned" });
    patchContext(draftId, { runtimeMode: "full-access" });
    expect(draftThreadOf(draftId)?.hostSelection).toBeUndefined();
    expect(draftThreadOf(draftId)?.branch).toBe("feature/pinned");
  });

  it("rechecks balancing when an empty draft is remapped to another project member", () => {
    bindProject(projectRef, draftId, {
      loadBalancedHostId: TEST_HOST_ID,
      hostSelection: "auto",
      threadId,
    });
    bindProject(remoteProjectRef, draftId, { threadId });
    expect(draftThreadOf(draftId)).toMatchObject({
      loadBalancedHostId: null,
      hostSelection: "auto",
    });
    patchContext(draftId, { loadBalancedHostId: OTHER_TEST_HOST_ID });
    patchContext(draftId, { projectRef });
    expect(draftThreadOf(draftId)).toMatchObject({
      loadBalancedHostId: null,
      hostSelection: "auto",
    });
  });

  it("clears branch and worktree but keeps env mode when remapping a draft to another environment", () => {
    const store = usePromptDraftStore.getState();
    bindProject(projectRef, draftId, {
      startFromOrigin: true,
      envMode: "worktree",
      worktreePath: "/tmp/local-worktree",
      branch: "feature/local-only",
      threadId,
    });

    store.setLogicalProjectDraftThreadId(hostProjectKey(projectRef), remoteProjectRef, draftId, {
      threadId,
    });

    expect(draftThreadOf(draftId)).toMatchObject({
      startFromOrigin: true,
      envMode: "worktree",
      worktreePath: null,
      branch: null,
      projectId,
      hostId: OTHER_TEST_HOST_ID,
    });
  });

  it("preserves worktree env mode without a worktree path", () => {
    bindProject(projectRef, draftId, {
      envMode: "worktree",
      worktreePath: null,
      branch: "feature/base",
      threadId,
    });
    const runtimeUndefinedOptions = {
      envMode: undefined,
      worktreePath: undefined,
      branch: undefined,
    } as unknown as Parameters<typeof bindProject>[2];
    bindProject(projectRef, draftId, runtimeUndefinedOptions);

    expect(draftThreadOf(draftId)).toMatchObject({
      envMode: "worktree",
      worktreePath: null,
      branch: "feature/base",
      projectId,
      hostId: TEST_HOST_ID,
    });
  });

  it("preserves existing branch and worktree when setProjectDraftThreadId receives undefined", () => {
    bindProject(projectRef, draftId, {
      worktreePath: "/tmp/main-worktree",
      branch: "trunk",
      threadId,
    });
    const runtimeUndefinedOptions = {
      worktreePath: undefined,
      branch: undefined,
    } as unknown as Parameters<typeof bindProject>[2];
    bindProject(projectRef, draftId, runtimeUndefinedOptions);

    expect(draftThreadOf(draftId)).toMatchObject({
      envMode: "worktree",
      worktreePath: "/tmp/main-worktree",
      branch: "trunk",
      projectId,
      hostId: TEST_HOST_ID,
    });
  });

  it("stores the start-from-origin choice with the draft thread", () => {
    bindProject(projectRef, draftId, {
      startFromOrigin: true,
      envMode: "worktree",
      threadId,
    });

    expect(draftThreadOf(draftId)?.startFromOrigin).toBe(true);

    patchContext(draftId, { startFromOrigin: false });

    expect(draftThreadOf(draftId)?.startFromOrigin).toBe(false);
  });

  it("updates branch context on an existing draft thread", () => {
    bindProject(projectRef, draftId, {
      worktreePath: null,
      branch: "trunk",
      threadId,
    });
    patchContext(draftId, {
      worktreePath: "/tmp/feature-next",
      branch: "feature/next",
    });
    expect(mappedThread(projectRef)?.threadId).toBe(threadId);
    expect(draftThreadOf(draftId)).toMatchObject({
      envMode: "worktree",
      worktreePath: "/tmp/feature-next",
      branch: "feature/next",
      projectId,
      hostId: TEST_HOST_ID,
    });
  });

  it("finalizes a matching materialized draft even when promotion was not pre-marked", () => {
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "promote me");

    finalizePromotedDraftByRef(hostThreadRef(TEST_HOST_ID, threadId));

    expect(mappedThread(projectRef)).toBeNull();
    expect(draftThreadOf(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe("promote me");
  });

  it("cleans up a completed background draft without replacing the active draft", () => {
    const threadRef = hostThreadRef(TEST_HOST_ID, threadId);
    const nextDraftId = DraftId.make("next-draft");
    bindProject(projectRef, draftId, { threadId });
    beginBackgroundDraftSubmissionByRef(threadRef);
    markDraftPromoted(threadRef);
    bindProject(projectRef, nextDraftId, {
      threadId: ThreadId.make("next-thread"),
    });
    typePrompt(nextDraftId, "Keep my next task");

    finalizePromotedDraftByRef(threadRef);

    expect(sessionOf(draftId)).toBeNull();
    expect(mappedThread(projectRef)?.draftId).toBe(nextDraftId);
    expect(composerOf(nextDraftId)?.prompt).toBe("Keep my next task");
    expect(
      usePromptDraftStore.getState().backgroundSubmissionThreadKeys[hostThreadKey(threadRef)],
    ).toBeUndefined();
  });

  it("moves composer edits made during promotion to the canonical thread", () => {
    bindProject(projectRef, draftId, { threadId });
    markDraftPromoted(hostThreadRef(TEST_HOST_ID, threadId));
    typePrompt(draftId, "typed during setup");

    finalizePromotedDraftByRef(hostThreadRef(TEST_HOST_ID, threadId));

    expect(mappedThread(projectRef)).toBeNull();
    expect(draftThreadOf(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe("typed during setup");
  });

  it("only marks promoted drafts for the matching environment ref", () => {
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "promote me");

    markDraftPromoted(hostThreadRef(OTHER_TEST_HOST_ID, threadId));

    expect(mappedThread(projectRef)?.threadId).toBe(threadId);
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
  });

  it("promotes matching thread ids separately for each environment", () => {
    const localThreadRef = hostThreadRef(TEST_HOST_ID, threadId);
    const remoteThreadRef = hostThreadRef(OTHER_TEST_HOST_ID, threadId);

    bindProject(projectRef, localDraftId, { threadId });
    typePrompt(localDraftId, "local draft");
    bindProject(remoteProjectRef, remoteDraftId, { threadId });
    typePrompt(remoteDraftId, "remote draft");

    markDraftPromoted(localThreadRef);

    expect(mappedThread(projectRef)).toBeNull();
    expect(mappedThread(remoteProjectRef)?.threadId).toBe(threadId);
    expect(threadByRef(localThreadRef)?.promotedTo).toEqual(localThreadRef);
    expect(threadByRef(remoteThreadRef)?.promotedTo).toBeNull();
    expect([localDraftId, remoteDraftId].map((id) => draftByKey(id)?.prompt)).toEqual([
      "local draft",
      "remote draft",
    ]);

    markDraftPromoted(remoteThreadRef);

    expect(mappedThread(projectRef)).toBeNull();
    expect(mappedThread(remoteProjectRef)).toBeNull();
    expect(threadByRef(localThreadRef)?.promotedTo).toEqual(localThreadRef);
    expect(threadByRef(remoteThreadRef)?.promotedTo).toEqual(remoteThreadRef);
    expect(draftByKey(localDraftId)?.prompt).toBe("local draft");
    expect(draftByKey(remoteDraftId)?.prompt).toBe("remote draft");
  });

  it("promotes a draft without changing another thread's draft", () => {
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "promote me");
    bindProject(otherProjectRef, otherDraftId, { threadId: otherThreadId });
    typePrompt(otherDraftId, "keep me");

    markDraftPromoted(hostThreadRef(TEST_HOST_ID, threadId));

    expect(draftThreadOf(draftId)?.promotedTo).toEqual(hostThreadRef(TEST_HOST_ID, threadId));
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
    expect(mappedThread(otherProjectRef)?.threadId).toBe(otherThreadId);
    expect(draftByKey(otherDraftId)?.prompt).toBe("keep me");
  });

  it("does not clear composer drafts for existing server threads during promotion cleanup", () => {
    const threadRef = hostThreadRef(TEST_HOST_ID, threadId);
    typePrompt(threadRef, "keep me");

    markDraftPromoted(hostThreadRef(TEST_HOST_ID, threadId));

    expect(draftThreadOf(threadRef)).toBeNull();
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe("keep me");
  });

  it("reads local draft composer state through a scoped thread ref", () => {
    const threadRef = hostThreadRef(TEST_HOST_ID, threadId);

    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "scoped access");

    expect(composerOf(draftId)?.prompt).toBe("scoped access");
    expect(composerOf(threadRef)?.prompt).toBe("scoped access");
  });

  it("marks a promoted draft by scoped ref without deleting composer state", () => {
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "promote me");

    markDraftPromoted(hostThreadRef(TEST_HOST_ID, threadId));

    expect(mappedThread(projectRef)).toBeNull();
    expect(draftThreadOf(draftId)?.promotedTo).toEqual(hostThreadRef(TEST_HOST_ID, threadId));
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
  });

  it("clears draft registration independently", () => {
    const store = usePromptDraftStore.getState();
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "remove me");
    store.clearDraftThread(draftId);
    expect(mappedThread(projectRef)).toBeNull();
    expect(draftThreadOf(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("keeps composer drafts when the thread is still mapped by another project", () => {
    const store = usePromptDraftStore.getState();
    bindProject(projectRef, draftId, { threadId });
    bindProject(otherProjectRef, sharedDraftId, { threadId });
    typePrompt(sharedDraftId, "keep me");

    store.clearProjectDraftThreadId(projectRef);

    expect(mappedThread(projectRef)).toBeNull();
    expect(mappedThread(otherProjectRef)?.threadId).toBe(threadId);
    expect(draftByKey(sharedDraftId)?.prompt).toBe("keep me");
  });

  it("clears every session for a project, including unmapped invested drafts", () => {
    const store = usePromptDraftStore.getState();
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "invested");
    // The remap leaves the invested draft alive unmapped; project removal
    // must still sweep it, or its sidebar row outlives the project.
    bindProject(projectRef, otherDraftId, { threadId: otherThreadId });

    store.clearProjectDraftThreadId(projectRef);

    expect(mappedThread(projectRef)).toBeNull();
    expect(draftThreadOf(draftId)).toBeNull();
    expect(draftThreadOf(otherDraftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("keeps invested composer drafts alive unmapped when remapping a project to a new draft thread", () => {
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "keep me around");

    bindProject(projectRef, otherDraftId, { threadId: otherThreadId });

    // The mapping moved to the fresh draft...
    expect(mappedThread(projectRef)?.threadId).toBe(otherThreadId);
    // ...but the invested draft survives with its content for the sidebar
    // draft rows to surface.
    expect(draftThreadOf(draftId)?.threadId).toBe(threadId);
    expect(draftByKey(draftId)?.prompt).toBe("keep me around");
  });

  it("clears empty composer drafts when remapping a project to a new draft thread", () => {
    bindProject(projectRef, draftId, { threadId });

    bindProject(projectRef, otherDraftId, { threadId: otherThreadId });

    expect(mappedThread(projectRef)?.threadId).toBe(otherThreadId);
    expect(draftThreadOf(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("clears project draft mapping by project id", () => {
    const store = usePromptDraftStore.getState();
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "hello");
    store.clearProjectDraftThreadId(projectRef);
    expect(mappedThread(projectRef)).toBeNull();
    expect(draftThreadOf(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("clears only matching project draft mapping entries", () => {
    const store = usePromptDraftStore.getState();
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "hello");

    store.clearProjectDraftThreadById(projectRef, otherDraftId);
    expect(mappedThread(projectRef)?.threadId).toBe(threadId);

    store.clearProjectDraftThreadById(projectRef, draftId);
    expect(mappedThread(projectRef)).toBeNull();
    expect(draftThreadOf(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it.each([false, true])(
    "a failed background draft is restored beside the next draft, never over it (finalized: %s)",
    (finalized) => {
      const retryThreadId = ThreadId.make("retry-thread");
      const nextDraftId = DraftId.make("next-draft");
      const threadRef = hostThreadRef(TEST_HOST_ID, threadId);
      bindProject(projectRef, draftId, {
        startFromOrigin: true,
        envMode: "worktree",
        branch: "trunk",
        threadId,
      });
      const sentDraft = sessionOf(draftId)!;
      markDraftPromoted(threadRef);
      bindProject(projectRef, nextDraftId, {
        threadId: ThreadId.make("next-thread"),
      });
      typePrompt(nextDraftId, "My next task");
      const nextDraft = sessionOf(nextDraftId);
      if (finalized) finalizePromotedDraftByRef(threadRef);

      restoreFailedBackgroundDraftThread(draftId, sentDraft, retryThreadId);
      typePrompt(draftId, "Retry the first task");

      expect(mappedThread(projectRef)?.draftId).toBe(nextDraftId);
      expect(sessionOf(nextDraftId)).toBe(nextDraft);
      expect(composerOf(nextDraftId)?.prompt).toBe("My next task");
      expect(sessionOf(draftId)).toMatchObject({
        startFromOrigin: true,
        envMode: "worktree",
        branch: "trunk",
        promotedTo: null,
        threadId: retryThreadId,
      });
      expect(composerOf(draftId)?.prompt).toBe("Retry the first task");
    },
  );

  it("rotates a failed bootstrap thread id without losing its draft", () => {
    const store = usePromptDraftStore.getState();
    const retryThreadId = ThreadId.make("thread-retry");
    bindProject(projectRef, draftId, {
      interactionMode: "plan",
      runtimeMode: "approval-required",
      startFromOrigin: true,
      envMode: "worktree",
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreePath: null,
      branch: "feature/test",
      threadId,
    });
    typePrompt(draftId, "keep this prompt");
    markDraftPromoted(hostThreadRef(TEST_HOST_ID, threadId));

    store.setLogicalProjectDraftThreadId(hostProjectKey(projectRef), projectRef, draftId, {
      createdAt: "2026-01-01T00:01:00.000Z",
      threadId: retryThreadId,
    });

    expect(draftThreadOf(draftId)).toMatchObject({
      promotedTo: null,
      interactionMode: "plan",
      runtimeMode: "approval-required",
      startFromOrigin: true,
      envMode: "worktree",
      createdAt: "2026-01-01T00:01:00.000Z",
      worktreePath: null,
      branch: "feature/test",
      threadId: retryThreadId,
    });
    expect(composerOf(draftId)?.prompt).toBe("keep this prompt");
  });

  it("removes a draft's previous project mapping when retargeted in place", () => {
    bindProject(projectRef, draftId, { threadId });
    typePrompt(draftId, "keep this prompt");

    bindProject(otherProjectRef, draftId, { threadId });

    expect(mappedThread(projectRef)).toBeNull();
    expect(mappedThread(otherProjectRef)?.draftId).toBe(draftId);
    expect(composerOf(draftId)?.prompt).toBe("keep this prompt");
  });

  it("stores and reads project draft thread ids via actions", () => {
    expect(mappedThread(projectRef)).toBeNull();
    expect(draftThreadOf(draftId)).toBeNull();

    bindProject(projectRef, draftId, {
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreePath: "/tmp/worktree-test",
      branch: "feature/test",
      threadId,
    });
    expect(mappedThread(projectRef)).toMatchObject({
      createdAt: "2026-01-01T00:00:00.000Z",
      interactionMode: "default",
      runtimeMode: "full-access",
      envMode: "worktree",
      worktreePath: "/tmp/worktree-test",
      branch: "feature/test",
      logicalProjectKey: hostProjectKey(projectRef),
      projectId,
      hostId: TEST_HOST_ID,
      threadId,
    });
    expect(draftThreadOf(draftId)).toMatchObject({
      createdAt: "2026-01-01T00:00:00.000Z",
      interactionMode: "default",
      runtimeMode: "full-access",
      envMode: "worktree",
      worktreePath: "/tmp/worktree-test",
      branch: "feature/test",
      logicalProjectKey: hostProjectKey(projectRef),
      projectId,
      hostId: TEST_HOST_ID,
    });
  });

  it("clears composer data for one environment without touching another", () => {
    const localThreadRef = hostThreadRef(TEST_HOST_ID, threadId);
    const remoteThreadRef = hostThreadRef(OTHER_TEST_HOST_ID, otherThreadId);
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    URL.revokeObjectURL = vi.fn<(url: string) => void>();

    try {
      bindProject(projectRef, localDraftId, { threadId });
      bindProject(remoteProjectRef, remoteDraftId, {
        threadId: otherThreadId,
      });
      typePrompt(localDraftId, "local draft");
      typePrompt(remoteDraftId, "remote draft");
      typePrompt(localThreadRef, "local thread draft");
      typePrompt(remoteThreadRef, "remote thread draft");
      usePromptDraftStore.setState({
        rewindingThreadKeys: new Set([
          threadKeyFor(threadId, TEST_HOST_ID),
          threadKeyFor(otherThreadId, OTHER_TEST_HOST_ID),
        ]),
      });

      clearPromptDraftsHost(TEST_HOST_ID);

      const next = usePromptDraftStore.getState();
      expect([...next.rewindingThreadKeys]).toEqual([
        threadKeyFor(otherThreadId, OTHER_TEST_HOST_ID),
      ]);
      const promptOf = (ref: Parameters<typeof next.getComposerDraft>[0]) =>
        next.getComposerDraft(ref)?.prompt;
      expect(next.getComposerDraft(localDraftId)).toBeNull();
      expect(next.getDraftThreadByProjectRef(remoteProjectRef)).not.toBeNull();
      expect(next.getDraftThreadByProjectRef(projectRef)).toBeNull();
      expect(promptOf(remoteDraftId)).toBe("remote thread draft");
      expect(next.getComposerDraft(localThreadRef)).toBeNull();
      expect(promptOf(remoteThreadRef)).toBe("remote thread draft");
    } finally {
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });
});

describe("promptDraftStore review comments", () => {
  const threadId = ThreadId.make("thread-review-comment");
  const threadRef = hostThreadRef(TEST_HOST_ID, threadId);
  const comment = {
    diff: "@@ -2,2 +2,2 @@\n two\n three",
    text: "Keep this configurable.",
    rangeLabel: "L2 to L3",
    endIndex: 2,
    startIndex: 1,
    filePath: "src/app.ts",
    sectionTitle: "File comment",
    sectionId: "file:src/app.ts",
    id: "comment-1",
  } as const;

  beforeEach(() => {
    resetPromptDraftStore();
  });

  it("stores review comments against a new-thread draft id", () => {
    const draftId = DraftId.make("draft-review-comment");
    attachComment(draftId, comment);

    expect(composerOf(draftId)?.reviewComments).toEqual([comment]);
  });

  it("persists review comments and clears them with composer content", () => {
    const store = usePromptDraftStore.getState();
    attachComment(threadRef, comment);
    const persisted = partializePromptDraftStoreState(
      usePromptDraftStore.getState(),
    ) as unknown as {
      draftsByThreadKey?: Record<string, { reviewComments?: Array<Record<string, unknown>> }>;
    };

    expect(
      persisted.draftsByThreadKey?.[threadKeyFor(threadId, TEST_HOST_ID)]?.reviewComments?.[0],
    ).toMatchObject(comment);

    store.clearComposerContent(threadRef);
    expect(draftFor(threadId, TEST_HOST_ID)).toBeUndefined();
  });

  it("upserts and removes review comments by id", () => {
    const store = usePromptDraftStore.getState();
    attachComment(threadRef, comment);
    attachComment(threadRef, { ...comment, text: "Updated comment." });

    expect(draftFor(threadId, TEST_HOST_ID)?.reviewComments).toEqual([
      { ...comment, text: "Updated comment." },
    ]);

    store.removeReviewComment(threadRef, comment.id);
    expect(draftFor(threadId, TEST_HOST_ID)).toBeUndefined();
  });
});

describe("promptDraftStore context persistence", () => {
  const threadRef = hostThreadRef(TEST_HOST_ID, ThreadId.make("context-persistence"));
  const annotation: WebMarkupPayload = {
    createdAt: "2026-09-06T10:00:00.000Z",
    screenshot: null,
    styleChanges: [],
    strokes: [],
    regions: [{ id: "error-region", rect: { x: 10, y: 20, width: 100, height: 50 } }],
    elements: [],
    comment: "Keep the cart after a failed payment",
    pageTitle: "Checkout",
    pageUrl: "http://localhost:3000/checkout",
    id: "retry-note",
  };

  beforeEach(resetPromptDraftStore);

  it("retains annotation-only drafts and filters malformed annotations", () => {
    const merge = usePromptDraftStore.persist.getOptions().merge!;
    const state = merge(
      {
        draftsByThreadKey: {
          [hostThreadKey(threadRef)]: {
            previewAnnotations: [annotation, { id: "invalid" }, null],
            attachments: [],
            prompt: "",
          },
        },
      },
      usePromptDraftStore.getInitialState(),
    );
    const draft = state.draftsByThreadKey[hostThreadKey(threadRef)];
    expect(draft?.previewAnnotations).toEqual([annotation]);
    expect(draft?.prompt).toContain(
      "kora-context://v1/preview-annotation/preview-annotation_retry-note",
    );
  });

  it("preserves snapshots and inline positions through repeated persistence and hydration", () => {
    const terminal = {
      ...terminalDraft({ id: "checkout-console" }),
      threadId: threadRef.threadId,
    };
    attachTerminal(threadRef, terminal);
    attachAnnotation(threadRef, annotation);
    const terminalLink = formatTerminalExcerptReference(terminal);
    const prompt = `Inspect ${terminalLink}. Apply [Retry note](kora-context://v1/preview-annotation/preview-annotation_retry-note). Compare ${terminalLink} again.`;
    typePrompt(threadRef, prompt);
    let state = usePromptDraftStore.getState();
    const merge = usePromptDraftStore.persist.getOptions().merge!;

    for (let reload = 0; reload < 3; reload++) {
      state = merge(
        JSON.parse(JSON.stringify(partializePromptDraftStoreState(state))),
        usePromptDraftStore.getInitialState(),
      );
      const draft = state.draftsByThreadKey[hostThreadKey(threadRef)];
      expect(draft?.previewAnnotations).toEqual([annotation]);
      expect(draft?.terminalContexts).toEqual([terminal]);
      expect(draft?.prompt).toBe(prompt);
    }
  });
});

describe("promptDraftStore terminal contexts", () => {
  const threadId = ThreadId.make("thread-dedupe");
  const threadRef = hostThreadRef(TEST_HOST_ID, threadId);

  beforeEach(() => {
    usePromptDraftStore.setState({
      stickyActiveProvider: null,
      stickyModelSelectionByProvider: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      draftThreadsByThreadKey: {},
      draftsByThreadKey: {},
    });
  });

  it("sanitizes malformed persisted drafts during merge", () => {
    const persistApi = usePromptDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof usePromptDraftStore.getState>,
        ) => ReturnType<typeof usePromptDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        projectDraftThreadIdByProjectKey: "not-an-object",
        draftThreadsByThreadId: "not-an-object",
        draftsByThreadId: {
          [threadId]: {
            modelOptions: "not-an-object",
            provider: "bogus-provider",
            terminalContexts: "not-an-array",
            attachments: "not-an-array",
            prompt: "",
          },
        },
      },
      usePromptDraftStore.getInitialState(),
    );

    expect(mergedState).toMatchObject({
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]).toBeUndefined();
  });

  it("keeps legacy terminal contexts without saved snapshot text unavailable", () => {
    const persistApi = usePromptDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof usePromptDraftStore.getState>,
        ) => ReturnType<typeof usePromptDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        projectDraftThreadIdByProjectKey: {},
        draftThreadsByThreadId: {},
        draftsByThreadId: {
          [threadId]: {
            terminalContexts: [
              {
                lineEnd: 5,
                lineStart: 4,
                terminalLabel: "Terminal 1",
                terminalId: "default",
                createdAt: "2026-03-13T12:00:00.000Z",
                threadId,
                id: "ctx-rehydrated",
              },
            ],
            attachments: [],
            prompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
          },
        },
      },
      usePromptDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]?.prompt).toBe(
      "[Terminal 1 lines 4-5](kora-context://v1/terminal/terminal_ctx-rehydrated)",
    );
    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]?.terminalContexts).toMatchObject([
      {
        text: "",
        lineEnd: 5,
        lineStart: 4,
        terminalLabel: "Terminal 1",
        terminalId: "default",
        id: "ctx-rehydrated",
      },
    ]);
  });

  it("persists terminal context snapshot text", () => {
    usePromptDraftStore
      .getState()
      .addTerminalContext(threadRef, terminalDraft({ id: "ctx-persist" }));

    const persistedState = partializePromptDraftStoreState(
      usePromptDraftStore.getState(),
    ) as unknown as {
      draftsByThreadKey?: Record<string, { terminalContexts?: Array<Record<string, unknown>> }>;
    };

    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_HOST_ID)]
        ?.terminalContexts?.[0],
      "terminal context metadata should be persisted",
    ).toMatchObject({
      lineEnd: 5,
      lineStart: 4,
      terminalLabel: "Terminal 1",
      terminalId: "default",
      id: "ctx-persist",
    });
    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_HOST_ID)]
        ?.terminalContexts?.[0]?.text,
    ).toBe(terminalDraft({ id: "ctx-persist" }).text);
  });

  it("inserts terminal contexts at the requested inline prompt position", () => {
    const first = terminalDraft({ id: "ctx-1" });
    const second = terminalDraft({
      lineEnd: 10,
      lineStart: 9,
      terminalLabel: "Terminal 2",
      id: "ctx-2",
    });
    const firstInsertion = insertInlineContextLink(
      "alpha beta",
      6,
      terminalExcerptReference(first),
    );
    const secondInsertion = insertInlineContextLink(
      firstInsertion.prompt,
      0,
      terminalExcerptReference(second),
    );

    expect(
      usePromptDraftStore
        .getState()
        .insertTerminalContext(threadRef, firstInsertion.prompt, first, 0),
    ).toBe(true);
    expect(
      usePromptDraftStore
        .getState()
        .insertTerminalContext(threadRef, secondInsertion.prompt, second, 0),
    ).toBe(true);

    const draft = draftFor(threadId, TEST_HOST_ID);
    const [linkOne, linkTwo] = [first, second].map(formatTerminalExcerptReference);
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-2", "ctx-1"]);
    expect(draft?.prompt).toBe(`${linkTwo} alpha ${linkOne} beta`);
  });

  it("clears terminal contexts when clearing composer content", () => {
    usePromptDraftStore.getState().addTerminalContext(threadRef, terminalDraft({ id: "ctx-1" }));

    usePromptDraftStore.getState().clearComposerContent(threadRef);

    expect(draftFor(threadId, TEST_HOST_ID)).toBeUndefined();
  });

  it.each(["replace", "remove", "clear"])("removes terminal links on %s", (operation) => {
    typePrompt(threadRef, "Explain");
    attachTerminal(threadRef, terminalDraft({ id: "ctx-1" }));
    if (operation === "replace") replaceTerminals(threadRef, []);
    else if (operation === "remove") detachTerminal(threadRef, "ctx-1");
    else dropTerminals(threadRef);
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe("Explain");
    expect(draftFor(threadId, TEST_HOST_ID)?.terminalContexts).toEqual([]);
  });

  it("normalizes legacy terminal ids before storing and removing their references", () => {
    replaceTerminals(threadRef, [terminalDraft({ id: "old terminal:one" })]);
    const draft = draftFor(threadId, TEST_HOST_ID)!;
    const storedId = draft.terminalContexts[0]!.id;
    expect(draft.prompt).toContain(`/terminal/terminal_${storedId})`);
    expect(storedId).toMatch(/^[a-z0-9_-]+$/i);
    detachTerminal(threadRef, storedId);
    expect(draftFor(threadId, TEST_HOST_ID)).toBeUndefined();
  });

  it.each([false, true])(
    "a terminal selection that the editor declines to place is appended (insertAtCaret=%s)",
    (insertAtCaret) => {
      const store = usePromptDraftStore.getState();
      const context = terminalDraft({ id: "append-context" });
      const handler = vi.fn(() => false);
      const unregister = onInsert(threadRef, handler);
      typePrompt(threadRef, "before");
      store.addTerminalContexts(threadRef, [context], { insertAtCaret });
      expect(handler).toHaveBeenCalledTimes(insertAtCaret ? 1 : 0);
      expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(
        `before ${formatTerminalExcerptReference(context)} `,
      );
      unregister?.();
    },
  );

  it("inserts terminal selections at the caret without overwriting the updated prompt", () => {
    const store = usePromptDraftStore.getState();
    const context = terminalDraft({ id: "caret-context" });
    const reference = formatTerminalExcerptReference(context);
    typePrompt(threadRef, "before after");
    const unregister = onInsert(threadRef, () => {
      typePrompt(threadRef, `before ${reference} after`);
      return true;
    });
    store.addTerminalContexts(threadRef, [context]);
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(`before ${reference} after`);
    expect(draftFor(threadId, TEST_HOST_ID)?.terminalContexts).toHaveLength(1);
    unregister?.();
  });

  it("deduplicates identical terminal contexts by selection signature", () => {
    const first = terminalDraft({ id: "ctx-1" });
    const duplicate = terminalDraft({ id: "ctx-2" });

    usePromptDraftStore.getState().addTerminalContexts(threadRef, [first, duplicate]);

    const draft = draftFor(threadId, TEST_HOST_ID);
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-1"]);
  });
});
describe("promptDraftStore unsent draft marker", () => {
  const threadId = ThreadId.make("thread-unsent-marker");
  const threadRef = hostThreadRef(TEST_HOST_ID, threadId);

  beforeEach(() => {
    resetPromptDraftStore();
  });

  it("rewind locks are in-memory only and never persisted", () => {
    const threadKey = threadKeyFor(threadId, TEST_HOST_ID);
    usePromptDraftStore.setState({ rewindingThreadKeys: new Set([threadKey]) });

    expect(usePromptDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
    expect(partializePromptDraftStoreState(usePromptDraftStore.getState())).not.toHaveProperty(
      "rewindingThreadKeys",
    );
  });

  it("reports content for typed text and clears when the composer is emptied", () => {
    const hasDraft = () => promptDraftHasUserContent(composerOf(threadRef));

    expect(hasDraft()).toBe(false);

    typePrompt(threadRef, "   ");
    expect(hasDraft()).toBe(false);

    typePrompt(threadRef, "follow up on the relay case");
    expect(hasDraft()).toBe(true);

    usePromptDraftStore.getState().clearComposerContent(threadRef);
    expect(hasDraft()).toBe(false);
  });
});

describe("promptDraftStore assistant citations", () => {
  beforeEach(resetPromptDraftStore);
  afterEach(resetPromptDraftStore);

  it("keeps quotes, comments, and remote source IDs through persistence and removes them on clear", async () => {
    await usePromptDraftStore.persist.clearStorage();
    vi.useFakeTimers();
    try {
      const threadId = ThreadId.make("citation-draft");
      const threadRef = hostThreadRef(TEST_HOST_ID, threadId);
      const citation = {
        suffix: " After.",
        prefix: "Before. ",
        end: 52,
        start: 12,
        comment: "Why is this important?\nPlease show an example.",
        text: "Preserve the selected text after reload.",
        messageId: ItemId.make("source-message"),
        threadId: ThreadId.make("source-thread"),
        hostId: HostId.make("remote-source"),
        version: 1 as const,
      };
      const prompt = `Explain ${serializeReplyFootnote(citation)} further.`;
      typePrompt(threadRef, prompt);
      await vi.advanceTimersByTimeAsync(300);
      resetPromptDraftStore();
      await usePromptDraftStore.persist.rehydrate();
      const restored = draftFor(threadId, TEST_HOST_ID)?.prompt ?? "";
      expect(restored).toBe(prompt);
      expect(collectAssistantFootnotes(restored).map((entry) => entry.citation)).toEqual([
        citation,
      ]);
      usePromptDraftStore.getState().clearComposerContent(threadRef);
      expect(collectAssistantFootnotes(draftFor(threadId, TEST_HOST_ID)?.prompt ?? "")).toEqual([]);
    } finally {
      await usePromptDraftStore.persist.clearStorage();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// createDeferredStorage
// ---------------------------------------------------------------------------

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    getItem: vi.fn((name: string) => store.get(name) ?? null),
  };
}
describe("promptDraftStore inline context references", () => {
  const threadId = ThreadId.make("thread-inline-context");
  const threadRef = hostThreadRef(TEST_HOST_ID, threadId);
  const reviewComment = {
    diff: "const x = 1;",
    text: "Why?",
    rangeLabel: "L4",
    endIndex: 3,
    startIndex: 3,
    filePath: "a/b.ts",
    sectionTitle: "File comment",
    sectionId: "file:a/b.ts",
    id: "rc-1",
  };
  const reviewLink = "[b.ts L4](kora-context://v1/review-comment/review-comment_rc-1)";
  const annotation = {
    createdAt: "2026-01-01T00:00:00.000Z",
    screenshot: null,
    styleChanges: [],
    strokes: [],
    regions: [],
    elements: [],
    comment: "Bigger",
    pageTitle: "Home",
    pageUrl: "http://localhost:3000/",
    id: "ann-1",
  };
  const annotationLink = "[Bigger](kora-context://v1/preview-annotation/preview-annotation_ann-1)";

  beforeEach(() => {
    resetPromptDraftStore();
  });

  it("adds links for persisted review comments that predate references", () => {
    const persistApi = usePromptDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof usePromptDraftStore.getState>,
        ) => ReturnType<typeof usePromptDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        projectDraftThreadIdByProjectKey: {},
        draftThreadsByThreadId: {},
        draftsByThreadId: {
          [threadId]: {
            reviewComments: [reviewComment],
            attachments: [],
            prompt: "old draft",
          },
        },
      },
      usePromptDraftStore.getInitialState(),
    );
    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]?.prompt).toBe(
      `old draft ${reviewLink} `,
    );
  });

  it("rehydrates annotation-only drafts with their references", () => {
    const merged = usePromptDraftStore.persist.getOptions().merge!(
      {
        draftsByThreadKey: {
          [threadKeyFor(threadId)]: {
            previewAnnotations: [annotation],
            attachments: [],
            prompt: "",
          },
        },
      },
      usePromptDraftStore.getInitialState(),
    );
    expect(merged.draftsByThreadKey[threadKeyFor(threadId)]?.previewAnnotations).toEqual([
      annotation,
    ]);
    expect(merged.draftsByThreadKey[threadKeyFor(threadId)]?.prompt).toContain(annotationLink);
  });

  it("keeps links for retained context when clearing the prompt", () => {
    const store = usePromptDraftStore.getState();
    attachComment(threadRef, reviewComment);
    attachAnnotation(threadRef, annotation);
    store.clearComposerPrompt(threadRef);
    const draft = draftFor(threadId, TEST_HOST_ID);
    for (const link of [reviewLink, annotationLink]) expect(draft?.prompt).toContain(link);
    expect(draft).toMatchObject({
      reviewComments: [reviewComment],
      previewAnnotations: [annotation],
    });
  });

  it("removes an annotation-only draft when bulk-cleared", () => {
    replaceAnnotations(threadRef, [annotation]);
    replaceAnnotations(threadRef, []);
    expect(draftFor(threadId, TEST_HOST_ID)).toBeUndefined();
  });

  it("keeps bulk-set preview annotations and their inline references in sync", () => {
    typePrompt(threadRef, "Explain this preview.");
    replaceAnnotations(threadRef, [annotation]);
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(
      `Explain this preview. ${annotationLink} `,
    );
    expect(draftFor(threadId, TEST_HOST_ID)?.previewAnnotations).toEqual([annotation]);

    const edited = { ...annotation, comment: "Updated comment" };
    replaceAnnotations(threadRef, [edited]);
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(
      `Explain this preview. ${annotationLink} `,
    );
    expect(draftFor(threadId, TEST_HOST_ID)?.previewAnnotations).toEqual([edited]);

    replaceAnnotations(threadRef, []);
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe("Explain this preview.");
    expect(draftFor(threadId, TEST_HOST_ID)?.previewAnnotations).toEqual([]);
  });

  it("appends a link when a preview annotation is added and strips it on removal", () => {
    const store = usePromptDraftStore.getState();
    attachAnnotation(threadRef, annotation);
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(`${annotationLink} `);
    store.removePreviewAnnotation(threadRef, "ann-1");
    expect(draftFor(threadId, TEST_HOST_ID)).toBeUndefined();
  });

  it("does not overwrite a prompt update made by the caret handler", () => {
    typePrompt(threadRef, "before after");
    onInsert(threadRef, (references) => {
      const reference = references[0];
      if (!reference) return false;
      typePrompt(
        threadRef,
        `before [${reference.label}](kora-context://v1/${reference.kind}/${reference.contextId}) after`,
      );
      return true;
    });

    attachComment(threadRef, reviewComment);

    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(`before ${reviewLink} after`);
    expect(draftFor(threadId, TEST_HOST_ID)?.reviewComments).toEqual([reviewComment]);
    onInsert(threadRef, null);
  });

  it("hands new review comments to a registered caret handler instead of appending", () => {
    typePrompt(threadRef, "look");
    const seen: string[] = [];
    onInsert(threadRef, (references) => {
      seen.push(...references.map((reference) => reference.contextId));
      return true;
    });
    attachComment(threadRef, reviewComment);
    expect(seen).toEqual(["review-comment_rc-1"]);
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe("look");
    onInsert(threadRef, null);
    attachComment(threadRef, { ...reviewComment, id: "rc-2" });
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(
      "look [b.ts L4](kora-context://v1/review-comment/review-comment_rc-2) ",
    );
  });

  it("keeps bulk-set review records and their inline references in sync", () => {
    const store = usePromptDraftStore.getState();
    typePrompt(threadRef, "Explain this pull request.");
    store.setReviewComments(threadRef, [reviewComment]);

    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(
      `Explain this pull request. ${reviewLink} `,
    );
    expect(draftFor(threadId, TEST_HOST_ID)?.reviewComments).toEqual([reviewComment]);

    store.setReviewComments(threadRef, []);
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe("Explain this pull request.");
    expect(draftFor(threadId, TEST_HOST_ID)?.reviewComments).toEqual([]);
  });

  it("can add another reference while upserting one backing review record", () => {
    attachComment(threadRef, reviewComment);
    const insertionHandler = vi.fn(() => true);
    const detach = onInsert(threadRef, insertionHandler);
    attachComment(
      threadRef,
      { ...reviewComment, text: "edited" },
      {
        insertAtCaret: false,
        allowDuplicateReference: true,
      },
    );

    detach?.();
    expect(insertionHandler).not.toHaveBeenCalled();
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(`${reviewLink} ${reviewLink} `);
    expect(draftFor(threadId, TEST_HOST_ID)?.reviewComments).toEqual([
      { ...reviewComment, text: "edited" },
    ]);
  });

  it("appends a link when a review comment is added and strips it on removal", () => {
    const store = usePromptDraftStore.getState();
    typePrompt(threadRef, "look");
    attachComment(threadRef, reviewComment);
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(`look ${reviewLink} `);
    // Re-adding the same comment replaces the record without a second link.
    attachComment(threadRef, { ...reviewComment, text: "edited" });
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe(`look ${reviewLink} `);
    store.removeReviewComment(threadRef, "rc-1");
    expect(draftFor(threadId, TEST_HOST_ID)?.prompt).toBe("look");
  });
});
describe("createDeferredStorage", () => {
  const encode = vi.fn((value: string) => `s:${value}`);
  const DEBOUNCE_MS = 300;

  // Fresh backing store and deferred wrapper for every case.
  const rig = () => {
    const backing = createMockStorage();
    return { backing, deferred: createDeferredStorage(backing, encode) };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    encode.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a new write after removeItem has cancelled a pending one", () => {
    const { backing, deferred } = rig();

    deferred.setItem("key", "v1");
    deferred.removeItem("key");
    deferred.setItem("key", "v2");

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(backing.setItem).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenCalledWith("key", "s:v2");
  });

  it("does nothing on flush once the pending write was removed", () => {
    const { backing, deferred } = rig();

    deferred.setItem("key", "v1");
    deferred.removeItem("key");
    deferred.flush();

    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it("does nothing on flush when there is no pending write", () => {
    const { backing, deferred } = rig();

    deferred.flush();

    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it("writes the pending value straight away on flush and drops the timer", () => {
    const { backing, deferred } = rig();

    deferred.setItem("key", "v1");
    expect(backing.setItem).not.toHaveBeenCalled();
    deferred.flush();
    expect(backing.setItem).toHaveBeenCalledWith("key", "s:v1");

    // The debounce timer must be gone, so nothing is written twice.
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending setItem when removeItem arrives", () => {
    const { backing, deferred } = rig();

    deferred.setItem("key", "v1");
    deferred.removeItem("key");

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(encode).not.toHaveBeenCalled();
    expect(backing.setItem).not.toHaveBeenCalled();
    expect(backing.removeItem).toHaveBeenCalledWith("key");
  });

  it("collapses a burst of setItem calls into one write of the last value", () => {
    const { backing, deferred } = rig();

    for (const value of ["v1", "v2", "v3"]) deferred.setItem("key", value);

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenCalledWith("key", "s:v3");
  });

  it("holds both serialization and the write until the debounce window closes", () => {
    const { backing, deferred } = rig();

    deferred.setItem("key", "v1");
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(encode).not.toHaveBeenCalled();
    expect(backing.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(backing.setItem).toHaveBeenCalledWith("key", "s:v1");
  });

  it("reads through to the backing store without delay", () => {
    const { backing, deferred } = rig();
    backing.getItem.mockReturnValueOnce("value");

    expect(deferred.getItem("key")).toBe("value");
    expect(backing.getItem).toHaveBeenCalledWith("key");
  });
});
