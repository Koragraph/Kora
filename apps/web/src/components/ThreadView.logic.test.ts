import {
  ANTIGRAVITY_DEFAULT_MODEL,
  AgentId,
  AgentProfileId,
  HostId,
  ItemId,
  ProjectId,
  ThreadId,
  TurnId,
  type AgentStatus,
} from "@kora/contracts";
import type { CodexArtifactTemplate } from "@kora/client-runtime/codex/artifact-templates";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveAgentProfileEntries, NO_AGENT_MODEL_PICK } from "../agentProfiles";
import type { DockSurface } from "../stores/dockStore";
import type { Thread, ThreadShell } from "../types";
import type { TerminalExcerptDraft } from "../util/terminalContext";
import { terminalAppName } from "../util/utils";
import * as Logic from "./ThreadView.logic";

// ---- shared fixtures ----------------------------------------------------------------------------

const HOST = HostId.make("host-1");
const OTHER_HOST = HostId.make("host-2");
const THREAD = ThreadId.make("t-1");
const STAMP = "2026-06-01T08:00:00.000Z";
const LATER = "2026-06-01T08:00:05.000Z";
const TURN = TurnId.make("turn-1");

const NULL_FIELDS = [
  "archivedAt",
  "branch",
  "deletedAt",
  "latestTurn",
  "session",
  "settledAt",
  "settledOverride",
  "worktreePath",
] as const;
const LIST_FIELDS = [
  "activities",
  "checkpoints",
  "messages",
  "proposedPlans",
  "pullRequests",
] as const;

const thread = (changes: Partial<Thread> = {}): Thread =>
  ({
    ...Object.fromEntries(NULL_FIELDS.map((field) => [field, null])),
    ...Object.fromEntries(LIST_FIELDS.map((field) => [field, []])),
    id: THREAD,
    hostId: HOST,
    projectId: ProjectId.make("p-1"),
    title: "A thread",
    modelSelection: { model: "gpt-5.4", instanceId: AgentProfileId.make("codex") },
    agentMode: "chat",
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: STAMP,
    updatedAt: STAMP,
    ...changes,
  }) as Thread;

type Session = NonNullable<Thread["session"]>;
const session = (status: Session["status"], extra: Partial<Session> = {}): Session =>
  ({
    ...{ activeTurnId: null, lastError: null },
    providerName: "codex",
    threadId: THREAD,
    status,
    updatedAt: STAMP,
    runtimeMode: "full-access",
    ...extra,
  }) as Session;

type Turn = NonNullable<Thread["latestTurn"]>;
const turn = (extra: Partial<Turn> = {}): Turn => ({
  turnId: TURN,
  state: "completed",
  requestedAt: STAMP,
  startedAt: STAMP,
  completedAt: LATER,
  assistantMessageId: null,
  ...extra,
});

const userMessage = (id: string) =>
  ({
    streaming: false,
    text: "hi",
    id: ItemId.make(id),
    updatedAt: STAMP,
    createdAt: STAMP,
    turnId: null,
    role: "user",
  }) as Thread["messages"][number];

/** A provider snapshot turned into the composer's picker entry. */
const profile = (driver: string, instance = driver, extra: Partial<AgentStatus> = {}) =>
  deriveAgentProfileEntries([
    {
      driver: AgentId.make(driver),
      instanceId: AgentProfileId.make(instance),
      checkedAt: STAMP,
      version: null,
      auth: { status: "authenticated" },
      status: "ready",
      ...{ installed: true, enabled: true },
      models: [],
      slashCommands: [],
      skills: [],
      ...extra,
    },
  ])[0]!;

// ---- browser surfaces and templates -------------------------------------------------------------

describe("agentControlledBrowserCloseConfirmation", () => {
  const tabs = [
    { id: "browser:a", kind: "preview", resourceId: "tab-a" },
    { id: "browser:b", kind: "preview", resourceId: "tab-b" },
    { id: "fleet", kind: "fleet" },
  ] satisfies DockSurface[];

  it("says nothing unless the agent drives one of the browsers", () => {
    const humans = { "tab-a": { controller: "human" }, "tab-b": { controller: "none" } } as const;
    expect(Logic.agentControlledBrowserCloseConfirmation(tabs, humans)).toBeNull();
  });

  it("uses singular wording for one browser and a count for several", () => {
    const one = Logic.agentControlledBrowserCloseConfirmation(tabs, {
      "tab-b": { controller: "agent" },
    });
    expect(one?.split("\n")[0]).toBe("Close browser while the agent is using it?");

    const both = Logic.agentControlledBrowserCloseConfirmation(tabs, {
      "tab-a": { controller: "agent" },
      "tab-b": { controller: "agent" },
    });
    expect(both?.split("\n")[0]).toBe("Close 2 browsers while the agent is using them?");
  });
});

describe("codexArtifactTemplatePromptToAppend", () => {
  const template: CodexArtifactTemplate = {
    artifactKind: "presentation",
    displayName: "Slides",
    skillDirectory: "/skills/slides",
    skillName: "slides",
  };

  it("offers the template prompt only when the draft lacks it", () => {
    const text = Logic.codexArtifactTemplatePromptToAppend("", template);
    expect(text).not.toBeNull();
    expect(Logic.codexArtifactTemplatePromptToAppend(text!, template)).toBeNull();
  });
});

// ---- draft hero and transcript anchoring --------------------------------------------------------

describe("draft hero", () => {
  it("docks only for a foreground send from the hero of a known thread", () => {
    const dock = Logic.shouldDockDraftHeroForSubmission;
    expect(
      dock({ submissionIntent: "foreground", activeThreadKey: "k", isDraftHeroState: true }),
    ).toBe(true);
    expect(
      dock({ submissionIntent: "background", activeThreadKey: "k", isDraftHeroState: true }),
    ).toBe(false);
    expect(
      dock({ submissionIntent: "foreground", activeThreadKey: null, isDraftHeroState: true }),
    ).toBe(false);
    expect(
      dock({ submissionIntent: "foreground", activeThreadKey: "k", isDraftHeroState: false }),
    ).toBe(false);
  });

  it("shows the hero for an idle, empty local draft until a dock is requested", () => {
    const base = {
      isWorking: false,
      hasTimelineEntries: false,
      isLocalDraftThread: true,
      draftHeroDockRequested: false,
      backgroundSubmissionPending: false,
    };
    expect(Logic.resolveDraftHeroState(base)).toBe(true);
    expect(Logic.resolveDraftHeroState({ ...base, draftHeroDockRequested: true })).toBe(false);
    expect(Logic.resolveDraftHeroState({ ...base, hasTimelineEntries: true })).toBe(false);
    expect(Logic.resolveDraftHeroState({ ...base, isWorking: true })).toBe(false);
    expect(Logic.resolveDraftHeroState({ ...base, isLocalDraftThread: false })).toBe(false);
    // A background send keeps the hero up whatever else is true.
    expect(
      Logic.resolveDraftHeroState({ ...base, isWorking: true, backgroundSubmissionPending: true }),
    ).toBe(true);
  });
});

describe("shouldReleaseTranscriptAnchorForToolActivity", () => {
  const work = (entry: Record<string, unknown>) =>
    ({
      id: "w",
      kind: "work",
      createdAt: STAMP,
      entry: { id: "e", createdAt: STAMP, label: "x", ...entry },
    }) as never;
  const ask = (timelineEntries: unknown[], extra: Record<string, unknown> = {}) =>
    Logic.shouldReleaseTranscriptAnchorForToolActivity({
      anchorMessageId: ItemId.make("anchor"),
      liveFollowEnabled: true,
      runningTurnId: TURN,
      timelineEntries: timelineEntries as never,
      ...extra,
    });

  it.each([
    ["a command", { command: "ls -la" }],
    ["an approval request", { requestKind: "command" }],
    ["a typed item", { itemType: "file_change" }],
    ["a tool-toned row", { tone: "tool" }],
  ])("lets go of the anchor for %s in the running turn", (_label, fields) => {
    expect(ask([work({ turnId: TURN, ...fields })])).toBe(true);
  });

  it("holds on for blank commands, plain thinking rows and other turns", () => {
    expect(ask([work({ turnId: TURN, command: "   ", tone: "thinking" })])).toBe(false);
    expect(ask([work({ turnId: TurnId.make("old"), command: "ls" })])).toBe(false);
  });

  it("does nothing without an anchor, live follow or a running turn", () => {
    const rows = [work({ turnId: TURN, command: "ls" })];
    expect(ask(rows, { anchorMessageId: null })).toBe(false);
    expect(ask(rows, { liveFollowEnabled: false })).toBe(false);
    expect(ask(rows, { runningTurnId: null })).toBe(false);
  });
});

describe("toolGroupConsumesUpwardNavigation", () => {
  const GROUP = "[data-tool-group-scroll]";

  /** Just enough of a DOM element: a parent chain, a scroll offset and an overflow style. */
  class Node extends EventTarget {
    overflowY = "auto";
    scrollTop = 0;
    readonly parentElement: Node | null;
    readonly isGroup: boolean;

    constructor(parent: Node | null = null, isGroup = false) {
      super();
      this.isGroup = isGroup;
      this.parentElement = parent;
    }

    closest(selector: string): Node | null {
      let node: Node | null = this;
      while (selector === GROUP && node && !node.isGroup) node = node.parentElement;
      return selector === GROUP ? node : null;
    }
  }

  beforeEach(() => {
    vi.stubGlobal("Element", Node);
    vi.stubGlobal("getComputedStyle", (node: Node) => ({ overflowY: node.overflowY }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is false for non-elements and for elements outside a tool group", () => {
    expect(Logic.toolGroupConsumesUpwardNavigation(null)).toBe(false);
    expect(Logic.toolGroupConsumesUpwardNavigation(new EventTarget())).toBe(false);
    expect(Logic.toolGroupConsumesUpwardNavigation(new Node() as never)).toBe(false);
  });

  it("consumes the key while a scrollable part of the group can still scroll up", () => {
    const group = new Node(null, true);
    const inner = new Node(group);
    expect(Logic.toolGroupConsumesUpwardNavigation(inner as never)).toBe(false);
    inner.scrollTop = 40;
    expect(Logic.toolGroupConsumesUpwardNavigation(inner as never)).toBe(true);
    inner.scrollTop = 0;
    group.scrollTop = 10;
    expect(Logic.toolGroupConsumesUpwardNavigation(inner as never)).toBe(true);
  });

  it.each(["hidden", "clip", "visible"])("ignores a scrolled box with overflow %s", (overflowY) => {
    const group = new Node(null, true);
    group.scrollTop = 25;
    group.overflowY = overflowY;
    expect(Logic.toolGroupConsumesUpwardNavigation(new Node(group) as never)).toBe(false);
  });

  it("stops at the group boundary", () => {
    const page = new Node();
    page.scrollTop = 500;
    const group = new Node(page, true);
    expect(Logic.toolGroupConsumesUpwardNavigation(new Node(group) as never)).toBe(false);
  });
});

// ---- held transcripts ---------------------------------------------------------------------------

describe("thread switch transcripts", () => {
  const key = (host: string, id: string) => `${host}:${id}`;

  it("prefers the incoming entries whenever there are any", () => {
    const next: string[] = ["fresh"];
    expect(
      Logic.resolveThreadSwitchTranscript({
        activeThreadKey: key(HOST, "a"),
        loading: true,
        nextEntries: next,
        rememberedForActive: ["old"],
      }),
    ).toEqual({ entries: next, displayThreadKey: key(HOST, "a") });
  });

  it("paints the thread's own remembered entries while it loads", () => {
    expect(
      Logic.resolveThreadSwitchTranscript({
        activeThreadKey: key(HOST, "a"),
        loading: true,
        nextEntries: [] as string[],
        rememberedForActive: ["cached"],
      }),
    ).toEqual({ entries: ["cached"], displayThreadKey: key(HOST, "a") });
  });

  it("falls back to the last ready thread only within the same host", () => {
    const lastReady = { threadKey: key(HOST, "b"), entries: ["b-row"] };
    const sameHost = Logic.resolveThreadSwitchTranscript({
      activeThreadKey: key(HOST, "a"),
      loading: true,
      nextEntries: [] as string[],
      rememberedForActive: [],
      lastReady,
    });
    expect(sameHost).toEqual({ entries: ["b-row"], displayThreadKey: key(HOST, "b") });

    const crossHost = Logic.resolveThreadSwitchTranscript({
      activeThreadKey: key(OTHER_HOST, "a"),
      loading: true,
      nextEntries: [] as string[],
      rememberedForActive: [],
      lastReady,
    });
    expect(crossHost).toEqual({ entries: [], displayThreadKey: key(OTHER_HOST, "a") });
  });

  it("shows the empty list once loading is over", () => {
    const result = Logic.resolveThreadSwitchTranscript({
      activeThreadKey: key(HOST, "a"),
      loading: false,
      nextEntries: [] as string[],
      rememberedForActive: ["cached"],
    });
    expect(result.entries).toEqual([]);
  });

  it("remembers ready transcripts by key and ignores empty or keyless ones", () => {
    Logic.rememberReadyThreadTranscript({ threadKey: key(HOST, "kept"), entries: [1, 2] });
    Logic.rememberReadyThreadTranscript({ threadKey: key(HOST, "empty"), entries: [] });
    Logic.rememberReadyThreadTranscript({ threadKey: null, entries: [3] });

    expect(Logic.peekRememberedThreadTranscript(key(HOST, "kept"))).toEqual([1, 2]);
    expect(Logic.peekRememberedThreadTranscript(key(HOST, "empty"))).toBeNull();
    expect(Logic.peekRememberedThreadTranscript(null)).toBeNull();
    expect(Logic.peekHeldThreadTranscript()?.threadKey).toBe(key(HOST, "kept"));
  });

  it("forgets the oldest of more than sixteen remembered threads", () => {
    for (let n = 0; n < 17; n += 1) {
      Logic.rememberReadyThreadTranscript({ threadKey: key(HOST, `lru-${n}`), entries: [n] });
    }
    expect(Logic.peekRememberedThreadTranscript(key(HOST, "lru-0"))).toBeNull();
    expect(Logic.peekRememberedThreadTranscript(key(HOST, "lru-16"))).toEqual([16]);
  });

  it("calls a transcript paint-only when it belongs to another thread", () => {
    expect(Logic.isPaintOnlyThreadTranscript("a", "b")).toBe(true);
    expect(Logic.isPaintOnlyThreadTranscript("a", "a")).toBe(false);
    expect(Logic.isPaintOnlyThreadTranscript(null, "a")).toBe(false);
    expect(Logic.isPaintOnlyThreadTranscript("a", null)).toBe(false);
  });
});

describe("resolveDraftPromotionNavigationTarget", () => {
  const ref = { hostId: HOST, threadId: THREAD };
  const target = (serverThread: Thread | null, backgroundSubmissionPending = false) =>
    Logic.resolveDraftPromotionNavigationTarget({
      serverThreadRef: ref,
      serverThread,
      backgroundSubmissionPending,
    });

  it.each([null, "idle", "starting", "ready"] as const)(
    "waits while the session is %s and nothing was persisted",
    (status) => {
      expect(target(thread({ session: status === null ? null : session(status) }))).toBeNull();
    },
  );

  it.each(["error", "stopped", "interrupted"] as const)("follows a %s session", (status) => {
    expect(target(thread({ session: session(status) }))).toBe(ref);
  });

  it("follows once a turn started or the user message was saved", () => {
    expect(target(thread({ latestTurn: turn({ completedAt: null }) }))).toBe(ref);
    expect(target(thread({ messages: [userMessage("m1")] }))).toBe(ref);
  });

  it("never moves for a background send or a missing server thread", () => {
    expect(target(thread({ messages: [userMessage("m1")] }), true)).toBeNull();
    expect(target(null)).toBeNull();
  });
});

// ---- host reconnect warning ---------------------------------------------------------------------

describe("host reconnect warning", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires after the grace period unless cancelled", () => {
    const shown = vi.fn();
    Logic.scheduleHostReconnectWarning(shown);
    vi.advanceTimersByTime(Logic.HOST_RECONNECT_WARNING_GRACE_MS - 1);
    expect(shown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(shown).toHaveBeenCalledOnce();

    const cancelled = vi.fn();
    Logic.scheduleHostReconnectWarning(cancelled)();
    vi.advanceTimersByTime(Logic.HOST_RECONNECT_WARNING_GRACE_MS);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("only counts grace that elapsed for the same host", () => {
    expect(Logic.hasHostReconnectWarningGraceElapsed(HOST, HOST)).toBe(true);
    expect(Logic.hasHostReconnectWarningGraceElapsed(HOST, OTHER_HOST)).toBe(false);
    expect(Logic.hasHostReconnectWarningGraceElapsed(null, null)).toBe(false);
  });
});

// ---- thread construction and metadata -----------------------------------------------------------

describe("thread construction", () => {
  it("builds a loading thread that keeps shell fields and empties the detail lists", () => {
    const shell = { ...thread({ title: "From shell", branch: "dev" }), latestUserMessageAt: null };
    const loading = Logic.buildLoadingThreadFromShell(shell as unknown as ThreadShell);
    expect(loading).toMatchObject({ title: "From shell", branch: "dev", deletedAt: null });
    expect([
      loading.messages,
      loading.activities,
      loading.checkpoints,
      loading.proposedPlans,
    ]).toEqual([[], [], [], []]);
  });

  it("builds a local draft thread titled New chat from the draft's settings", () => {
    const pick = { model: "m", instanceId: AgentProfileId.make("codex") };
    const draft = {
      projectId: ProjectId.make("p-9"),
      hostId: HOST,
      createdAt: STAMP,
      branch: "feature",
      worktreePath: null,
      runtimeMode: "full-access",
      interactionMode: "plan",
    } as never;
    expect(Logic.buildLocalDraftThread(THREAD, draft, pick)).toMatchObject({
      id: THREAD,
      title: "New chat",
      branch: "feature",
      interactionMode: "plan",
      modelSelection: pick,
      updatedAt: STAMP,
      session: null,
      messages: [],
    });
  });

  it("asks for a metadata update only when the model or branch changed", () => {
    const current = { model: "a", instanceId: AgentProfileId.make("codex") };
    const update = (extra: object) =>
      Logic.resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: current,
        currentBranch: "main",
        ...extra,
      });

    expect(update({ nextModelSelection: { ...current }, nextBranch: "main" })).toBeNull();
    expect(update({ nextBranch: "feature" })).toEqual({ branch: "feature", worktreePath: null });
    const other = { ...current, model: "b" };
    expect(update({ nextModelSelection: other })).toEqual({ modelSelection: other });
    const withOptions = { ...current, options: [{ id: "effort", value: "high" }] } as never;
    expect(update({ nextModelSelection: withOptions })).toEqual({ modelSelection: withOptions });
  });

  it("writes an error only to the route's thread on the same host", () => {
    const routeThreadRef = { hostId: HOST, threadId: THREAD };
    const write = (active: { hostId: HostId; id: ThreadId } | null, target = THREAD) =>
      Logic.shouldWriteThreadErrorToCurrentDaemonThread({
        targetThreadId: target,
        routeThreadRef,
        activeServerThread: active,
      });
    expect(write({ hostId: HOST, id: THREAD })).toBe(true);
    expect(write({ hostId: OTHER_HOST, id: THREAD })).toBe(false);
    expect(write({ hostId: HOST, id: ThreadId.make("t-2") })).toBe(false);
    expect(write({ hostId: HOST, id: THREAD }, ThreadId.make("t-2"))).toBe(false);
    expect(write(null)).toBe(false);
  });
});

describe("turn interrupts", () => {
  it("names the active turn only when the session is running with one", () => {
    const running = thread({ session: session("running", { activeTurnId: TURN }) });
    expect(Logic.buildThreadTurnInterruptInput(running)).toEqual({
      threadId: THREAD,
      turnId: TURN,
    });
    expect(Logic.buildThreadTurnInterruptInput(thread({ session: session("running") }))).toEqual({
      threadId: THREAD,
    });
    expect(
      Logic.buildThreadTurnInterruptInput(
        thread({ session: session("ready", { activeTurnId: TURN }) }),
      ),
    ).toEqual({
      threadId: THREAD,
    });
  });

  it("builds an interrupt only for a running thread in the running phase", () => {
    const running = thread({ session: session("running", { activeTurnId: TURN }) });
    expect(Logic.buildRunningThreadTurnInterruptInput(running, "running")).toEqual({
      threadId: THREAD,
      turnId: TURN,
    });
    expect(Logic.buildRunningThreadTurnInterruptInput(running, "ready")).toBeNull();
    expect(Logic.buildRunningThreadTurnInterruptInput(thread(), "running")).toBeNull();
    expect(Logic.buildRunningThreadTurnInterruptInput(null, "running")).toBeNull();
  });
});

// ---- agent selection ----------------------------------------------------------------------------

describe("resolvePromptAgentSelection", () => {
  const select = (input: Partial<Parameters<typeof Logic.resolvePromptAgentSelection>[0]>) =>
    Logic.resolvePromptAgentSelection({
      entries: [],
      candidateInstanceIds: [],
      lockedProvider: null,
      lockedInstanceId: null,
      ...input,
    });

  it("picks the first usable candidate instance", () => {
    const work = profile("claude", "claude_work");
    const result = select({
      entries: [profile("codex"), work],
      candidateInstanceIds: [undefined, work.instanceId],
    });
    expect(result.selectedProviderEntry?.instanceId).toBe(work.instanceId);
    expect(result.requestedDriverKind).toBe("claude");
    expect(result.unavailableProviderInstanceId).toBeUndefined();
  });

  it("keeps a locked driver authoritative over the draft's choice", () => {
    const result = select({
      entries: [profile("codex"), profile("claude")],
      candidateInstanceIds: [AgentProfileId.make("codex")],
      lockedProvider: AgentId.make("claude"),
      lockedInstanceId: AgentProfileId.make("claude"),
    });
    expect(result.requestedDriverKind).toBe("claude");
    expect(result.selectedProviderEntry?.driverKind).toBe("claude");
  });

  it("falls back to a usable instance of the same driver when the pick is disabled", () => {
    const off = profile("codex", "codex_off", { enabled: false });
    const on = profile("codex", "codex_on");
    const result = select({ entries: [off, on], candidateInstanceIds: [off.instanceId] });
    expect(result.selectedProviderEntry?.instanceId).toBe(on.instanceId);
  });

  it("reports the missing instance of a locked thread instead of switching", () => {
    const gone = AgentProfileId.make("google_work");
    const result = select({
      entries: [profile("antigravity")],
      candidateInstanceIds: [gone],
      lockedProvider: AgentId.make("antigravity"),
      lockedInstanceId: gone,
    });
    expect(result.selectedProviderEntry).toBeUndefined();
    expect(result.unavailableProviderInstanceId).toBe(gone);
  });

  it("does not treat the empty-draft placeholder as a request", () => {
    const result = select({
      entries: [profile("antigravity", "antigravity", { enabled: false })],
      candidateInstanceIds: [NO_AGENT_MODEL_PICK.instanceId],
    });
    expect(result.selectedProviderEntry).toBeUndefined();
    expect(result.unavailableProviderInstanceId).toBeUndefined();
  });

  it("stays inside the locked continuation group", () => {
    const sessionProfile = profile("antigravity", "g_work", {
      enabled: false,
      continuation: { groupKey: "work" },
    });
    const otherProfile = profile("antigravity", "g_home", { continuation: { groupKey: "home" } });
    const result = select({
      entries: [sessionProfile, otherProfile],
      candidateInstanceIds: [otherProfile.instanceId, sessionProfile.instanceId],
      lockedProvider: AgentId.make("antigravity"),
      lockedInstanceId: sessionProfile.instanceId,
    });
    expect(result.lockedContinuationGroupKey).toBe("work");
    expect(result.selectedProviderEntry).toBeUndefined();
  });
});

describe("resolvePromptTurnMode", () => {
  const mode = (
    planModeEnabled: boolean,
    provider: { showInteractionModeToggle?: boolean } | null,
  ) =>
    Logic.resolvePromptTurnMode({
      planModeEnabled,
      provider: provider as never,
      interactionMode: "plan",
    });

  it("keeps plan mode only with the setting on and a provider that allows it", () => {
    expect(mode(true, {})).toEqual({ enabled: true, interactionMode: "plan" });
    expect(mode(true, { showInteractionModeToggle: true })).toEqual({
      enabled: true,
      interactionMode: "plan",
    });
    expect(mode(true, { showInteractionModeToggle: false })).toEqual({
      enabled: false,
      interactionMode: "default",
    });
    expect(mode(false, {})).toEqual({ enabled: false, interactionMode: "default" });
    expect(mode(true, null)).toEqual({ enabled: false, interactionMode: "default" });
  });
});

describe("getAntigravitySendBlockReason", () => {
  const models: AgentStatus["models"] = [
    { slug: "gemini-pro", name: "Gemini Pro", isCustom: false, capabilities: null },
  ];
  const agy = (extra: Partial<AgentStatus> = {}) =>
    profile("antigravity", "antigravity", { models, ...extra }).snapshot;

  it("ignores other providers and a missing provider", () => {
    expect(Logic.getAntigravitySendBlockReason(profile("codex").snapshot, "")).toBeNull();
    expect(Logic.getAntigravitySendBlockReason(null, "x")).toBeNull();
  });

  it("asks to install, then to sign in, then to pick a model", () => {
    expect(Logic.getAntigravitySendBlockReason(agy({ installed: false }), "gemini-pro")).toBe(
      "Install Antigravity (the agy command) before sending.",
    );
    expect(
      Logic.getAntigravitySendBlockReason(
        agy({ auth: { status: "unauthenticated" } }),
        "gemini-pro",
      ),
    ).toBe(`Sign in to Antigravity (run agy in ${terminalAppName()} once) before sending.`);
    expect(Logic.getAntigravitySendBlockReason(agy(), "  ")).toBe(
      "Choose an Antigravity model before sending.",
    );
  });

  it("lets an unknown login through for the session to check", () => {
    expect(
      Logic.getAntigravitySendBlockReason(
        agy({ auth: { status: "unknown" }, models: [] }),
        "anything",
      ),
    ).toBeNull();
  });

  it("waits for the model catalog and rejects a model a ready catalog dropped", () => {
    expect(Logic.getAntigravitySendBlockReason(agy({ models: [] }), "gemini-pro")).toMatch(
      /still loading/,
    );
    expect(Logic.getAntigravitySendBlockReason(agy(), "retired-model")).toBe(
      "That Antigravity model is no longer available. Choose another model.",
    );
    expect(Logic.getAntigravitySendBlockReason(agy(), "gemini-pro")).toBeNull();
    expect(Logic.getAntigravitySendBlockReason(agy(), ANTIGRAVITY_DEFAULT_MODEL)).toBeNull();
    // A provider in error keeps the saved model so the user can retry.
    expect(
      Logic.getAntigravitySendBlockReason(agy({ status: "error" }), "retired-model"),
    ).toBeNull();
  });
});

describe("resolveBackgroundDraftWorkspaceOptions", () => {
  it("never reuses a worktree and keeps start-from-origin only for new worktrees", () => {
    expect(
      Logic.resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        startFromOrigin: true,
        branch: "b",
      }),
    ).toEqual({ envMode: "worktree", startFromOrigin: true, branch: "b", worktreePath: null });
    expect(
      Logic.resolveBackgroundDraftWorkspaceOptions({
        envMode: "local",
        startFromOrigin: true,
        branch: null,
      }),
    ).toEqual({ envMode: "local", startFromOrigin: false, branch: null, worktreePath: null });
  });
});

// ---- send state ---------------------------------------------------------------------------------

describe("derivePromptSendState", () => {
  const context = (text: string) =>
    ({
      id: `c-${text.length}`,
      threadId: THREAD,
      createdAt: STAMP,
      terminalId: "term",
      terminalLabel: "Terminal 1",
      lineStart: 1,
      lineEnd: 2,
      text,
    }) as unknown as TerminalExcerptDraft;

  it("counts expired terminal contexts and does not send them", () => {
    const state = Logic.derivePromptSendState({
      prompt: "  ",
      imageCount: 0,
      terminalContexts: [context(""), context("output")],
    });
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.sendableTerminalContexts.map(({ text }) => text)).toEqual(["output"]);
    expect(state.hasSendableContent).toBe(true);
    expect(state.trimmedPrompt).toBe("");
  });

  it.each([
    [{ prompt: "hello" }, true],
    [{ imageCount: 1 }, true],
    [{ elementContextCount: 2 }, true],
    [{ elementContextCount: 0 }, false],
    [{ terminalContexts: [context("")] }, false],
  ])("decides sendability for %o", (extra, sendable) => {
    const state = Logic.derivePromptSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      ...extra,
    });
    expect(state.hasSendableContent).toBe(sendable);
  });

  it("words the expired-context toast by count and variant", () => {
    expect(Logic.buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(Logic.buildExpiredTerminalContextToastCopy(3, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
    // Nonsense counts are treated as one.
    expect(Logic.buildExpiredTerminalContextToastCopy(0, "empty").title).toMatch(
      /^Expired terminal context /,
    );
  });
});

describe("shouldShowPlanFollowUpPrompt", () => {
  const ready = {
    pendingUserInputCount: 0,
    hasComposerAttachments: false,
    latestTurnSettled: true,
    interactionMode: "plan" as const,
    hasActionableProposedPlan: true,
  };

  it("shows for a settled actionable plan with nothing else pending", () => {
    expect(Logic.shouldShowPlanFollowUpPrompt(ready)).toBe(true);
  });

  it.each([
    ["staged attachments", { hasComposerAttachments: true }],
    ["a pending question", { pendingUserInputCount: 1 }],
    ["an unsettled turn", { latestTurnSettled: false }],
    ["no actionable plan", { hasActionableProposedPlan: false }],
    ["default mode", { interactionMode: "default" as const }],
  ])("hides with %s", (_case, change) => {
    expect(Logic.shouldShowPlanFollowUpPrompt({ ...ready, ...change })).toBe(false);
  });
});

// ---- started threads and agent lock -------------------------------------------------------------

describe("thread started and agent lock", () => {
  it("treats a turn, a message or a session as a start", () => {
    expect(Logic.threadHasStarted(thread())).toBe(false);
    expect(Logic.threadHasStarted(null)).toBe(false);
    expect(Logic.threadHasStarted(thread({ latestTurn: turn() }))).toBe(true);
    expect(Logic.threadHasStarted(thread({ messages: [userMessage("m")] }))).toBe(true);
    expect(Logic.threadHasStarted(thread({ session: session("ready") }))).toBe(true);
  });

  it("does the same for a shell, using its last user message time", () => {
    const shell = { latestTurn: null, latestUserMessageAt: null, session: null };
    expect(Logic.threadShellHasStarted(shell)).toBe(false);
    expect(Logic.threadShellHasStarted({ ...shell, latestUserMessageAt: STAMP })).toBe(true);
    expect(Logic.threadShellHasStarted({ ...shell, session: session("ready") })).toBe(true);
    expect(Logic.threadShellHasStarted(undefined)).toBe(false);
  });

  it("locks to the session's driver, else the thread's or the selected instance's driver", () => {
    const providers = [{ instanceId: AgentProfileId.make("work"), driver: AgentId.make("claude") }];
    const lock = (
      t: Thread,
      threadProvider: string | null,
      selectedProvider: string | null = null,
    ) => Logic.deriveThreadAgentLock({ thread: t, threadProvider, selectedProvider, providers });

    expect(lock(thread(), "codex")).toBeNull();
    const started = thread({ messages: [userMessage("m")] });
    expect(lock(thread({ session: session("ready", { providerName: "claude" }) }), "codex")).toBe(
      "claude",
    );
    expect(lock(started, "work")).toBe("claude");
    expect(lock(started, null, "codex")).toBe("codex");
    expect(lock(started, null)).toBeNull();
  });

  it("blocks a model change on a started session only for providers that require a new thread", () => {
    const strict = AgentProfileId.make("strict");
    const loose = AgentProfileId.make("loose");
    const providers = [
      { instanceId: strict, requiresNewThreadForModelChange: true },
      { instanceId: loose, requiresNewThreadForModelChange: false },
    ];
    const block = (from: AgentProfileId, to: AgentProfileId, model: string, started = true) =>
      Logic.getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: started,
        currentModelSelection: { instanceId: from, model: "m1" },
        nextModelSelection: { instanceId: to, model },
      });

    expect(block(loose, loose, "m2")).toBeNull();
    expect(block(strict, strict, "m1")).toBeNull();
    expect(block(strict, strict, "m2", false)).toBeNull();
    expect(block(strict, strict, "m2")?.title).toBe("Start a new chat to change models");
    expect(block(loose, strict, "m1")).not.toBeNull();
  });
});

// ---- local dispatch acknowledgement -------------------------------------------------------------

describe("local dispatch acknowledgement", () => {
  const settled = thread({
    messages: [userMessage("u1")],
    latestTurn: turn(),
    session: session("ready", { updatedAt: LATER }),
  });
  const snapshot = Logic.createLocalDispatchSnapshot(settled);

  const acknowledged = (
    extra: Partial<Parameters<typeof Logic.hasDaemonAcknowledgedLocalDispatch>[0]>,
  ) =>
    Logic.hasDaemonAcknowledgedLocalDispatch({
      localDispatch: snapshot,
      phase: "ready",
      latestTurn: settled.latestTurn,
      latestUserMessageId: ItemId.make("u1"),
      session: settled.session,
      threadError: null,
      ...{ hasPendingUserInput: false, hasPendingApproval: false },
      ...extra,
    });

  it("captures the thread's latest turn, session and user message", () => {
    expect(snapshot).toMatchObject({
      submissionIntent: "foreground",
      userMessageId: "u1",
      turn: { turnId: TURN, completedAt: LATER },
      session: { status: "ready", updatedAt: LATER },
      startFailureId: null,
    });
    expect(
      Logic.createLocalDispatchSnapshot(undefined, { submissionIntent: "background" }),
    ).toMatchObject({
      submissionIntent: "background",
      userMessageId: null,
      session: { status: null },
    });
  });

  it("finds the newest turn-start failure for the latest user message", () => {
    const failing = thread({
      activities: [
        { id: "a1", kind: "provider.turn.start.failed", payload: { requestId: "u1" } },
        { id: "a2", kind: "provider.turn.start.failed", payload: { requestId: "other" } },
      ] as never,
    });
    expect(Logic.latestTurnStartFailureId(failing, ItemId.make("u1"))).toBe("a1");
    expect(Logic.latestTurnStartFailureId(failing, null)).toBeNull();
  });

  it("is false with no dispatch and while nothing changed", () => {
    expect(acknowledged({ localDispatch: null, threadError: "boom" })).toBe(false);
    expect(acknowledged({})).toBe(false);
    expect(
      acknowledged({ phase: "connecting", latestTurn: turn({ turnId: TurnId.make("t2") }) }),
    ).toBe(false);
  });

  it("counts pending input, errors and a new start failure at once", () => {
    expect(acknowledged({ hasPendingApproval: true })).toBe(true);
    expect(acknowledged({ hasPendingUserInput: true })).toBe(true);
    expect(acknowledged({ threadError: "failed" })).toBe(true);
    expect(acknowledged({ latestTurnStartFailureId: "f-new", phase: "connecting" })).toBe(true);
  });

  it("counts any turn or session change outside a running phase", () => {
    expect(acknowledged({ latestTurn: turn({ completedAt: "2026-06-01T09:00:00.000Z" }) })).toBe(
      true,
    );
    expect(
      acknowledged({ session: session("ready", { updatedAt: "2026-06-01T09:00:00.000Z" }) }),
    ).toBe(true);
  });

  it("while running, waits for the started turn that the session is on", () => {
    const next = TurnId.make("turn-2");
    const started = turn({ turnId: next, completedAt: null, startedAt: LATER });
    expect(
      acknowledged({
        phase: "running",
        latestTurn: turn({ turnId: next, startedAt: null, completedAt: null }),
      }),
    ).toBe(false);
    expect(
      acknowledged({
        phase: "running",
        latestTurn: started,
        session: session("running", { activeTurnId: TurnId.make("elsewhere") }),
      }),
    ).toBe(false);
    expect(
      acknowledged({
        phase: "running",
        latestTurn: started,
        session: session("running", { activeTurnId: next }),
      }),
    ).toBe(true);
  });

  it("while running, a new user message (steering) is enough", () => {
    expect(acknowledged({ phase: "running", latestUserMessageId: ItemId.make("u2") })).toBe(true);
  });
});

// ---- focus and plan follow-up -------------------------------------------------------------------

describe("shouldRefocusPromptOnWindowFocus", () => {
  const focused = (
    tagName: string,
    opts: { editable?: boolean; role?: string; insideOverlay?: boolean } = {},
  ) => ({
    tagName,
    isContentEditable: opts.editable ?? false,
    getAttribute: (name: string) => (name === "role" ? (opts.role ?? null) : null),
    closest: () => (opts.insideOverlay ? ({} as Element) : null),
  });

  it("refocuses from nothing, the body or a plain button", () => {
    expect(Logic.shouldRefocusPromptOnWindowFocus(null)).toBe(true);
    expect(Logic.shouldRefocusPromptOnWindowFocus(focused("BODY"))).toBe(true);
    expect(Logic.shouldRefocusPromptOnWindowFocus(focused("BUTTON"))).toBe(true);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT", "IFRAME", "WEBVIEW"])(
    "leaves a focused %s alone",
    (tag) => {
      expect(Logic.shouldRefocusPromptOnWindowFocus(focused(tag))).toBe(false);
    },
  );

  it("leaves editors, textboxes, dialogs, popups and terminals alone", () => {
    expect(Logic.shouldRefocusPromptOnWindowFocus(focused("DIV", { editable: true }))).toBe(false);
    expect(Logic.shouldRefocusPromptOnWindowFocus(focused("DIV", { role: "textbox" }))).toBe(false);
    expect(Logic.shouldRefocusPromptOnWindowFocus(focused("BUTTON", { insideOverlay: true }))).toBe(
      false,
    );
  });
});

describe("restorePlanFollowUpPrompt", () => {
  it("writes every saved field back and puts the caret at the end", () => {
    const calls: Array<[string, unknown]> = [];
    const record = (name: string) => (value: unknown) => void calls.push([name, value]);
    const snapshot = {
      prompt: "Implement the plan",
      terminalContexts: [{ id: "t" }] as never,
      reviewComments: [{ id: "r" }] as never,
      previewAnnotations: [{ id: "a" }] as never,
    };

    Logic.restorePlanFollowUpPrompt({
      snapshot,
      writePrompt: record("prompt"),
      writeTerminalContexts: record("terminal"),
      writeReviewComments: record("review"),
      writePreviewAnnotations: record("annotations"),
      resetCursor: record("cursor"),
    });

    expect(calls).toEqual([
      ["prompt", snapshot.prompt],
      ["terminal", snapshot.terminalContexts],
      ["review", snapshot.reviewComments],
      ["annotations", snapshot.previewAnnotations],
      ["cursor", { cursor: snapshot.prompt.length, prompt: snapshot.prompt, detectTrigger: true }],
    ]);
  });
});

describe("threadNeedsClaudeLogin", () => {
  it.each([
    [false, "claude", true],
    [false, undefined, true],
    [false, null, true],
    [false, "codex", false],
    [true, "claude", false],
  ] as const)("group=%s driver=%s -> %s", (isGroup, driverKind, expected) => {
    expect(
      Logic.threadNeedsClaudeLogin({
        isGroup,
        driverKind: driverKind as AgentId | null | undefined,
      }),
    ).toBe(expected);
  });
});
