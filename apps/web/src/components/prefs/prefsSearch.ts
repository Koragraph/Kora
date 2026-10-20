import {
  validatePrefsScopeSearch,
  type ResolvedPrefsScope,
  type PrefsScopeSearch,
} from "./prefsScope";
import { normalizeSearchText, isMacPlatform } from "../../util/utils";
import { isNative } from "../../env";

export type PrefsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/token-savings"
  | "/settings/providers"
  | "/settings/extensions"
  | "/settings/swarm"
  | "/settings/blobs"
  | "/settings/connections"
  | "/settings/outside"
  | "/settings/engines"
  | "/settings/usage"
  | "/settings/diagnostics";

export type PrefsSearchScope =
  | "environment-defaults"
  | "project-defaults"
  | "environment"
  | "checkout"
  | "project";

export interface PrefsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: PrefsPath;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  readonly scope?: PrefsSearchScope;
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  readonly hostOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly swarmOnly?: boolean;
}

export interface PrefsSearchAvailability {
  readonly hasHost: boolean;
  readonly hasProviderSettingsHost: boolean;
  readonly hasSwarm?: boolean;
  /** The Kora surface is on (koraSurface.ts). Absent/false = coming soon: Kora's own pages are not searchable. */
  readonly koraSurfaceOn?: boolean;
}

/** Settings pages that exist only for Kora (blobs); hidden while it is coming soon. Engines stays: Code uses it too. */
export const KORA_ONLY_PREFS_PATHS: ReadonlySet<string> = new Set([
  "/settings/blobs",
  "/settings/connections",
  "/settings/outside",
]);

// Pages whose settings only make sense for a project render at any selection otherwise.
const CATEGORY_SCOPE: Partial<Record<PrefsPath, PrefsSearchScope>> = {
  "/settings/projects": "project",
};

export const PREFS_SEARCH_ITEMS = [
  {
    to: "/settings/general",
    scope: "project-defaults",
    title: "Project defaults and overrides",
    id: "project-defaults",
    searchTerms: ["model workspace environments projects inheritance checkout"],
  },
  {
    to: "/settings/projects",
    title: "Project overview",
    id: "project-overview",
    searchTerms: ["name icon emoji image checkout remove delete"],
  },
  {
    to: "/settings/general",
    scope: "project-defaults",
    title: "Default model",
    id: "default-model",
    searchTerms: ["new thread project provider reasoning effort"],
  },
  {
    to: "/settings/general",
    scope: "project-defaults",
    title: "Permissions",
    id: "default-permissions",
    searchTerms: [
      "new thread default runtime mode supervised approvals auto accept edits full access",
    ],
  },
  {
    to: "/settings/general",
    scope: "project-defaults",
    title: "Compact long conversations at",
    id: "claude-compact-at",
    searchTerms: [
      "context window compaction compact auto 200k 400k 1m million tokens cost usage claude long conversation",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Token savings",
    id: "token-savings",
    searchTerms: ["tokens cost usage savings cheaper cache context"],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Trim big command output",
    id: "bash-trim",
    searchTerms: [
      "bash command output test build log trim spill tail errors tokens cost savings shadow",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Keep cache warm",
    id: "cache-warm",
    searchTerms: ["cache keep warm ttl expire hour idle return tokens cost savings shadow proxy"],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Remember what the agent touched",
    id: "inject-recall",
    searchTerms: [
      "injection recall follow-up that file declaration graph hints tokens cost savings",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Point at the likely code for a bug report",
    id: "inject-bug-prose",
    searchTerms: [
      "bug report plain english localize likely declarations graph wrong slow off by one injection tokens cost savings shadow",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Auto model",
    id: "auto-model",
    searchTerms: ["auto model routing haiku cheaper light work questions cost save money tokens"],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Sonnet for ordinary work",
    id: "auto-sonnet",
    searchTerms: [
      "auto sonnet opus middle tier cheaper half price model routing effort cost save money tokens",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Cheaper models near your plan limit",
    id: "auto-headroom",
    searchTerms: [
      "plan limit usage weekly 5-hour headroom auto sonnet opus subscription rate limit save stretch my plan",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Low effort for chores",
    id: "auto-effort",
    searchTerms: [
      "auto effort low high thinking chore commit push run tests cheaper save money tokens",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Hand long runs to a cheap worker",
    id: "lead-handoff",
    searchTerms: [
      "delegate worker haiku sonnet hand off commands build test loop lead cheaper save money tokens",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Quick answers from the graph",
    id: "quick-answers",
    searchTerms: [
      "who calls where is defined rename blast radius graph composer no agent turn instant",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Swarm worker token limit",
    id: "swarm-token-ceiling",
    searchTerms: ["swarm worker ceiling budget stop exploring tokens cost opencode"],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Bounded reads",
    id: "bounded-reads",
    searchTerms: [
      "read file window outline lines tokens cost context savings claude whole file offset limit shadow",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Lean context",
    id: "lean-context",
    searchTerms: ["skills memory auto-memory context tokens cost savings claude new threads"],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Trim old output on resume",
    id: "cold-resume-masking",
    searchTerms: [
      "resume cache expired idle hour tool output trim mask elide tokens cost savings claude thread",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Offer a fresh start for new tasks",
    id: "task-boundary-chip",
    searchTerms: [
      "new task compact brief handoff fresh thread long context tokens cost savings suggestion",
    ],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Model switch cost note",
    id: "model-switch-chip",
    searchTerms: ["switch model cache re-cache price cost tokens thread note"],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "Looks-stuck notice",
    id: "runaway-guard",
    searchTerms: ["stuck loop repeat retry same file same command stop runaway tokens cost"],
  },
  {
    to: "/settings/general",
    title: "Desktop alerts",
    id: "thread-notifications",
    searchTerms: ["notification sound alert completion input approval desktop"],
  },
  {
    to: "/settings/general",
    title: "Heads-up inside Kora",
    id: "in-app-notifications",
    searchTerms: ["notification toast popup completion input approval failure"],
  },
  {
    to: "/settings/general",
    title: "Working chats in the sidebar",
    id: "sidebar-working-style",
    searchTerms: ["sidebar running busy agent working indicator outline rail line animation glow"],
  },
  {
    to: "/settings/general",
    title: "Clock",
    id: "time-format",
    searchTerms: ["time format timestamp locale system browser os 12 hour 24 hour"],
  },
  {
    to: "/settings/general",
    scope: "project-defaults",
    title: "How replies arrive",
    id: "response-streaming",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    to: "/settings/general",
    title: "Skills in the / menu",
    id: "skills-in-slash-menu",
    searchTerms: ["command menu dollar $ slash /"],
  },
  {
    to: "/settings/general",
    title: "Fold the prompt while reading",
    id: "composer-collapse",
    searchTerms: ["composer rest resting scroll wheel conversation timeline shrink minimize"],
  },
  {
    to: "/settings/general",
    scope: "environment-defaults",
    title: "New projects open from",
    id: "add-project-starts-in",
    searchTerms: ["base directory folder browser path home"],
  },
  {
    to: "/settings/general",
    title: "Keep sleeping workers' branches",
    id: "worker-branch-retention",
    searchTerms: ["workers sleep idle branch delete unmerged retention days swarm"],
  },
  {
    to: "/settings/general",
    title: "Limit Claude's background traffic",
    id: "claude-limit-telemetry",
    searchTerms: [
      "privacy telemetry analytics statsig nonessential traffic network hosts updates error reporting",
    ],
  },
  {
    to: "/settings/general",
    title: "Check before archiving",
    id: "archive-confirmation",
    searchTerms: ["confirmation ask before thread second click inline action"],
  },
  {
    to: "/settings/general",
    title: "Check before deleting",
    id: "delete-confirmation",
    searchTerms: ["confirmation ask before thread chat history"],
  },
  {
    to: "/settings/general",
    title: "Diagnostics",
    id: "diagnostics",
    searchTerms: ["logs traces processes resource history failures spans cpu memory"],
  },
  {
    to: "/settings/general",
    title: "Updates",
    id: "updates",
    searchTerms: ["update upgrade new version release download restart install check"],
  },
  {
    to: "/settings/general",
    title: "Report a bug",
    id: "report-bug",
    searchTerms: ["bug issue problem crash feedback support github logs help"],
  },
  {
    to: "/settings/providers",
    title: "Agents",
    id: "providers",
    searchTerms: [
      "agents cli codex claude cursor grok opencode antigravity google sign in sign out install subscription instances authentication api key models configuration binary path config directory endpoint arguments environment variables display name providers turn on off custom favorite hidden auto compact",
    ],
  },
  {
    to: "/settings/extensions",
    title: "Extensions (MCP servers and skills)",
    id: "extensions",
    searchTerms: [
      "extensions mcp server servers tools plugins skills skill add install import catalog github playwright context7 notion sentry supabase filesystem fetch memory claude code codex opencode antigravity keychain secret token workers",
    ],
  },
  {
    to: "/settings/swarm",
    title: "Swarm",
    id: "swarm",
    swarmOnly: true,
    searchTerms: [
      "swarm stretch free models opencode koragent worker backend openrouter cerebras zen keys api key privacy consent workers readiness install provider order default model",
    ],
  },
  {
    to: "/settings/blobs",
    title: "About me (Kora)",
    id: "blobs-about-me",
    searchTerms: [
      "blobs coworkers context profile name preferences people tone memory defaults new blob",
    ],
  },
  {
    to: "/settings/connections",
    title: "Connected apps (Connections)",
    id: "connected-apps",
    searchTerms: [
      "connections apps composio gmail calendar slack github notion key api key byo free calls monthly limit 750 accounts disconnect reset broker keychain",
    ],
  },
  {
    to: "/settings/engines",
    title: "Engines (ACP agents, API endpoints, Claude accounts)",
    id: "engines",
    searchTerms: [
      "engines acp agent gemini grok cursor kimi qwen droid hermes api endpoint openrouter deepseek groq mistral fireworks lmstudio ollama anthropic key model claude account second login work personal path executable",
    ],
  },
  {
    to: "/settings/outside",
    title: "Outside access (Claude Desktop, Cursor, Claude Code)",
    id: "outside-access",
    searchTerms: [
      "outside access mcp claude desktop cursor claude code codex token api orchestrate team blobs kora mcp --team revoke audit log rate limit config json",
    ],
  },
  {
    to: "/settings/usage",
    title: "Show what Kora saved",
    id: "kora-savings",
    searchTerms: [
      "savings saved money dollars cost api price estimate kora saved you swarm reads graph cache trims hide show",
    ],
  },
  {
    to: "/settings/usage",
    title: "Plan limits",
    id: "plan-limits",
    searchTerms: [
      "usage rate limit quota five hour weekly session reset tokens cost context window compact claude codex plan max pro plus",
    ],
  },
  {
    to: "/settings/projects",
    title: "Actions",
    id: "project-actions",
    searchTerms: ["commands scripts setup run dev server checkout worktree kora.json import"],
  },
  {
    to: "/settings/token-savings",
    scope: "project-defaults",
    title: "OpenAI agent output limits",
    id: "codex-savings",
    searchTerms: ["codex savings tool output limit auto compact features tokens cost"],
  },
] as const satisfies readonly PrefsSearchItem[];

// Key order is the sidebar order.
export const PREFS_SECTION_LABELS: Readonly<Record<PrefsPath, string>> = {
  "/settings/projects": "Project",
  "/settings/general": "Defaults",
  "/settings/token-savings": "Token savings",
  "/settings/providers": "Agents",
  "/settings/extensions": "Extensions",
  "/settings/swarm": "Stretch",
  "/settings/blobs": "Kora",
  "/settings/connections": "Connections",
  "/settings/outside": "Outside access",
  "/settings/engines": "Engines",
  "/settings/usage": "Usage",
  "/settings/diagnostics": "Diagnostics",
};

export type PrefsSearchItemId = (typeof PREFS_SEARCH_ITEMS)[number]["id"];

export function getPrefsSearchTargetScope(
  targetId: string,
): { title: string; scope: PrefsSearchScope | null } | null {
  const items: readonly PrefsSearchItem[] = PREFS_SEARCH_ITEMS;
  const byId = items.find((candidate) => candidate.id === targetId);
  const item = byId ?? items.find((candidate) => candidate.targetId === targetId);
  if (!item) return null;
  return { title: item.title, scope: item.scope ?? CATEGORY_SCOPE[item.to] ?? null };
}

export function isPrefsSearchScopeAvailable(
  requiredScope: PrefsSearchScope | null,
  scopeKind: ResolvedPrefsScope["kind"],
): boolean {
  if (requiredScope === null) {
    return true;
  }
  const allowed: Record<PrefsSearchScope, ReadonlyArray<ResolvedPrefsScope["kind"]>> = {
    "project-defaults": ["environment", "all", "project", "checkout"],
    "environment-defaults": ["environment", "all"],
    project: ["project", "checkout"],
    checkout: ["checkout"],
    environment: ["environment"],
  };
  return allowed[requiredScope].includes(scopeKind);
}

export function isPrefsOverviewVisible(search: PrefsScopeSearch): boolean {
  const clean = validatePrefsScopeSearch({ ...search });
  if (clean.checkout && !clean.project) return false;
  return clean.project !== undefined;
}

export function searchableSetting(id: PrefsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const item = PREFS_SEARCH_ITEMS.find((candidate) => candidate.id === id)!;
  return { id: item.id, title: item.title };
}

export function filterAvailablePrefsSearchItems(
  availability: PrefsSearchAvailability,
): ReadonlyArray<PrefsSearchItem> {
  return (PREFS_SEARCH_ITEMS as readonly PrefsSearchItem[]).filter((item) => {
    if (item.hostOnly && !availability.hasHost) return false;
    if (item.providerSettingsOnly && !availability.hasProviderSettingsHost) return false;
    if (item.swarmOnly && availability.hasSwarm === false) return false;
    if (KORA_ONLY_PREFS_PATHS.has(item.to) && !availability.koraSurfaceOn) return false;
    return true;
  });
}

export function searchPrefs(
  query: string,
  items: ReadonlyArray<PrefsSearchItem> = PREFS_SEARCH_ITEMS,
): ReadonlyArray<PrefsSearchItem> {
  const phrase = normalizeSearchText(query);
  if (phrase === "") return [];
  const tokens = phrase.split(" ").filter(Boolean);
  const mac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

  const ranked: Array<{ item: PrefsSearchItem; rank: number; order: number }> = [];
  items.forEach((item, order) => {
    if (item.desktopOnly && !isNative) return;
    if (item.macOnly && !mac) return;

    const title = normalizeSearchText(item.title);
    const fields = [
      title,
      normalizeSearchText(PREFS_SECTION_LABELS[item.to]),
      ...(item.searchTerms ?? []).map(normalizeSearchText),
    ];
    if (!tokens.every((token) => fields.some((field) => field.includes(token)))) return;

    const tiers: boolean[] = [
      fields.some((field) => field.includes(phrase)),
      tokens.every((token) => title.includes(token)),
      title.includes(phrase),
      title.startsWith(phrase),
      title === phrase,
    ];
    const rank = tiers.lastIndexOf(true) + 1;
    ranked.push({ item, rank, order });
  });

  return ranked.sort((a, b) => b.rank - a.rank || a.order - b.order).map((entry) => entry.item);
}
