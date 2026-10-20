import { findElement } from "../../test/findElement";

import { SWARM_STATUS_OPENCODE_MISSING, SWARM_STATUS_READY } from "../../util/swarm.fixtures";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isValidElement } from "react";
import { HostId, ThreadId, type FleetSnapshot, type SwarmStatus } from "@kora/contracts";

const env = vi.hoisted(() => ({
  snapshotAtom: vi.fn(() => "snapshot-atom"),
  setPreferences: vi.fn(),
  openSwarmQuickSetup: vi.fn(),
  openSwarmSetup: vi.fn(),
  snapshot: null as FleetSnapshot | null,
  status: null as SwarmStatus | null,
  supported: true,
}));

vi.mock("../../hooks/useSwarmStatus", () => ({
  useSwarmStatus: () => ({ supported: env.supported, status: env.status }),
}));
vi.mock("../../atoms/query", () => ({
  useHostQuery: (atom: unknown) => ({
    refresh: vi.fn(),
    isPending: false,
    error: null,
    data: atom === null ? null : { snapshot: env.snapshot },
  }),
}));
vi.mock("../../atoms/fleet", () => ({ fleetHost: { snapshot: env.snapshotAtom } }));
vi.mock("../../atoms/swarm", () => ({ swarmHost: { setPreferences: "setPreferences" } }));
vi.mock("../../atoms/use-atom-command", () => ({ useAtomAction: () => env.setPreferences }));
vi.mock("../../stores/swarmSetupStore", () => ({
  openSwarmQuickSetup: env.openSwarmQuickSetup,
  openSwarmSetup: env.openSwarmSetup,
}));

import {
  type SwarmPromptBannerInput,
  useSwarmPromptBannerItems,
  SWARM_BANNER_IDS,
} from "./useSwarmPromptBannerItems";

const hostId = HostId.make("local");
const threadRef = { hostId, threadId: ThreadId.make("thread-1") };

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement<Record<string, unknown>>(node)) return "";
  return Object.values(node.props).map(textOf).join(" ");
}

function items(patch: Partial<SwarmPromptBannerInput> = {}) {
  return useSwarmPromptBannerItems({
    hostId,
    threadRef,
    agentMode: "swarm",
    selectedProvider: "claude",
    leaderRateLimitedUntil: null,
    onSwitchAgentMode: vi.fn(),
    ...patch,
  });
}

function clickAction(actions: unknown, label: string) {
  const button = findElement(
    actions,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
  if (!button) throw new Error(`Missing action: ${label}`);
  (button.props.onClick as () => void)();
}

const exhaustedSnapshot = {
  swarm: {
    exhausted: true,
    byModel: [],
    bounced: 0,
    passedFirstTry: 1,
    respawns: 2,
    reportsReturned: 1,
    delegated: 3,
  },
} as unknown as FleetSnapshot;

describe("useSwarmPromptBannerItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.supported = true;
    env.status = SWARM_STATUS_READY;
    env.snapshot = null;
  });

  it("does not subscribe to the fleet for a draft", () => {
    items({ threadRef: null });
    expect(env.snapshotAtom).not.toHaveBeenCalled();
  });

  it("a fresh install (no consent yet) on the assistant lane asks for consent, not about OpenCode", () => {
    env.status = {
      ...SWARM_STATUS_OPENCODE_MISSING,
      blockers: [
        ...SWARM_STATUS_OPENCODE_MISSING.blockers,
        { code: "consent-missing", message: "Accept the privacy notice" },
      ],
    } as typeof env.status;
    const ids = items({ isAssistantLane: true }).map((i) => i.id);
    expect(ids).toContain(SWARM_BANNER_IDS.consentMissing);
    expect(ids).not.toContain(SWARM_BANNER_IDS.opencodeMissing);
  });

  it("swarm-consent-missing waits while Claude still needs signing in (one ask at a time)", () => {
    env.status = {
      ...SWARM_STATUS_READY,
      blockers: [{ code: "consent-missing", message: "Accept the privacy notice" }],
    } as typeof env.status;
    const ids = items({ isAssistantLane: true, claudeSignedOut: true }).map((i) => i.id);
    expect(ids).not.toContain(SWARM_BANNER_IDS.consentMissing);
  });

  it("swarm-consent-missing: on the assistant lane only, opens the one-sheet setup", () => {
    env.status = {
      ...SWARM_STATUS_READY,
      blockers: [{ code: "consent-missing", message: "Accept the privacy notice" }],
    } as typeof env.status;
    expect(items({}).map((i) => i.id)).not.toContain(SWARM_BANNER_IDS.consentMissing);
    const chat = items({ isAssistantLane: true }).find(
      (i) => i.id === SWARM_BANNER_IDS.consentMissing,
    );
    expect(chat).toMatchObject({ variant: "info" });
    clickAction(chat!.actions, "Review & enable");
    expect(env.openSwarmQuickSetup).toHaveBeenCalledTimes(1);
  });

  it("stacks every banner at once", () => {
    env.status = {
      ...SWARM_STATUS_OPENCODE_MISSING,
      providers: SWARM_STATUS_OPENCODE_MISSING.providers.map((provider) =>
        provider.provider === "openrouter"
          ? {
              ...provider,
              lastTest: { ...provider.lastTest!, ok: false, outcome: "invalid-key" as const },
            }
          : provider,
      ),
    };
    env.snapshot = exhaustedSnapshot;
    const ids = items({
      selectedProvider: "antigravity",
      leaderRateLimitedUntil: Date.now() + 60_000,
    })
      .map((item) => item.id)
      .toSorted();
    // The consent banner is assistant-lane only (Code asks through the Swarm toggle's setup dialog).
    expect(ids).toEqual(
      Object.values(SWARM_BANNER_IDS)
        .filter((id) => id !== SWARM_BANNER_IDS.consentMissing)
        .toSorted(),
    );
  });

  it("swarm-leader-limited: the X4 copy with the reset time", () => {
    const until = new Date(2026, 8, 24, 15, 30).getTime();
    const [item] = items({ leaderRateLimitedUntil: until });
    expect(item).toMatchObject({ id: "swarm-leader-limited", priority: "activity" });
    const time = new Date(until).toLocaleTimeString(undefined, {
      minute: "2-digit",
      hour: "numeric",
    });
    expect(`${item!.title} ${item!.description}`).toBe(
      `Your lead agent is rate-limited until ${time}. Your swarm keeps working; your lead agent gets a digest when it's back.`,
    );
  });

  it("swarm-leader-unsupported: a leader with no fleet bridge is told to switch", () => {
    const onSwitchAgentMode = vi.fn();
    const [item] = items({ selectedProvider: "antigravity", onSwitchAgentMode });
    expect(item).toMatchObject({ id: "swarm-leader-unsupported", variant: "info" });
    clickAction(item!.actions, "Switch to Chat");
    expect(onSwitchAgentMode).toHaveBeenCalledWith("chat");
  });

  it("a Codex or OpenCode leader leads the swarm", () => {
    expect(items({ selectedProvider: "codex" })).toEqual([]);
    expect(items({ selectedProvider: "opencode" })).toEqual([]);
  });

  it("ignores a rejected key on a disabled provider", () => {
    env.status = {
      ...SWARM_STATUS_READY,
      providers: SWARM_STATUS_READY.providers.map((provider) =>
        provider.provider === "openrouter"
          ? {
              ...provider,
              enabled: false,
              lastTest: { ...provider.lastTest!, ok: false, outcome: "invalid-key" as const },
            }
          : provider,
      ),
    };
    expect(items()).toEqual([]);
  });

  it("swarm-key-invalid: names the provider and can disable it", () => {
    env.status = {
      ...SWARM_STATUS_READY,
      providers: SWARM_STATUS_READY.providers.map((provider) =>
        provider.provider === "openrouter"
          ? {
              ...provider,
              lastTest: { ...provider.lastTest!, ok: false, outcome: "invalid-key" as const },
            }
          : provider,
      ),
    };
    const [item] = items();
    expect(item).toMatchObject({ id: "swarm-key-invalid", variant: "warning" });
    expect(item!.title).toBe("Your OpenRouter key was rejected.");
    clickAction(item!.actions, "Update key");
    clickAction(item!.actions, "Disable provider");
    expect(env.openSwarmSetup).toHaveBeenCalledWith({ step: "providers" });
    expect(env.setPreferences).toHaveBeenCalledWith({
      input: { enabled: [{ provider: "openrouter", enabled: false }] },
      hostId,
    });
  });

  it("swarm-opencode-missing: errors and opens the one-sheet setup (it installs OpenCode)", () => {
    env.status = SWARM_STATUS_OPENCODE_MISSING;
    const [item] = items();
    expect(item).toMatchObject({ id: "swarm-opencode-missing", variant: "error" });
    expect(item!.title).toBe("OpenCode isn't installed or can't be found.");
    clickAction(item!.actions, "Fix setup");
    expect(env.openSwarmQuickSetup).toHaveBeenCalledTimes(1);
    expect(env.openSwarmSetup).not.toHaveBeenCalled();
  });

  it("swarm-exhausted: warns and offers a key or Orchestrator", () => {
    env.snapshot = exhaustedSnapshot;
    const onSwitchAgentMode = vi.fn();
    const [item] = items({ onSwitchAgentMode });
    expect(item).toMatchObject({ id: SWARM_BANNER_IDS.exhausted, variant: "warning" });
    expect(item!.id).toBe("swarm-exhausted");
    expect(textOf(item!.title)).toContain("All free providers are rate-limited or out of quota.");
    clickAction(item!.actions, "Add a provider key");
    clickAction(item!.actions, "Switch to Orchestrator");
    expect(env.openSwarmSetup).toHaveBeenCalledWith({ step: "providers" });
    expect(onSwitchAgentMode).toHaveBeenCalledWith("orchestrator");
  });

  it("shows nothing on a host without the swarm capability", () => {
    env.supported = false;
    env.status = SWARM_STATUS_OPENCODE_MISSING;
    expect(items({ selectedProvider: "codex", leaderRateLimitedUntil: 1 })).toEqual([]);
  });

  it("shows nothing outside Swarm mode", () => {
    env.status = SWARM_STATUS_OPENCODE_MISSING;
    env.snapshot = exhaustedSnapshot;
    expect(
      items({ agentMode: "chat", selectedProvider: "codex", leaderRateLimitedUntil: 1 }),
    ).toEqual([]);
    expect(items({ agentMode: "orchestrator" })).toEqual([]);
  });

  it("shows nothing when Swarm is healthy", () => {
    expect(items()).toEqual([]);
  });
});
