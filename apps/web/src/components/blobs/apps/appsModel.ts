// Connected apps, client side: pure helpers (no React, no clock except what is passed in). Grants editing, the cap card's
// words, the not-set-up state, error copy by code, and the gallery's category list.
import type { AppAccountWire, AppToolkitWire, AppToolWire, AppsStatus, AppsUsage } from "./appsApi";

/** `BlobToolGrants.apps` as the profile stores it. An entry in `allow` is an exact tool slug or `toolkit:<slug>`. */
export interface AppGrants {
  readonly mode: "none" | "all" | "list";
  readonly allow: ReadonlyArray<string>;
}
export const NO_GRANTS: AppGrants = { mode: "none", allow: [] };

const FREE_CALLS_FALLBACK = 750;

// ── readiness ────────────────────────────────────────────────────────────────────────────────────────
/** No broker baked into this build and no key pasted: the Apps page explains setup instead of showing a broken grid. */
export function isNotSetUp(status: AppsStatus | null): boolean {
  return status !== null && status.mode === "unavailable";
}

export type CapState = "ok" | "near" | "capped" | "byo" | "unavailable";
/** What the cap card shows: nothing special, "getting close" (90%), "used up", or "no limit" on the user's own key. */
export function capState(status: AppsStatus | null): CapState {
  if (!status || status.mode === "unavailable") return "unavailable";
  if (status.mode === "byo") return "byo";
  const u = status.usage;
  if (!u || u.limit === null) return "ok";
  if (u.capReached || u.used >= u.limit) return "capped";
  return u.used / u.limit >= 0.9 ? "near" : "ok";
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export function resetsLabel(resetsAt: number | null): string | null {
  if (resetsAt === null) return null;
  const d = new Date(resetsAt);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "312 of 750 free app calls used this month". */
export function usageLine(u: AppsUsage | null): string | null {
  if (!u || u.limit === null) return null;
  return `${u.used.toLocaleString("en-US")} of ${u.limit.toLocaleString("en-US")} free app calls used this month`;
}

export function usageFraction(u: AppsUsage | null): number {
  if (!u || !u.limit) return 0;
  return Math.max(0, Math.min(1, u.used / u.limit));
}

// ── errors ───────────────────────────────────────────────────────────────────────────────────────────
export type ErrorAction = "byo-key" | "label" | "retry" | "reconnect" | "settings" | null;
/** The words and next step for an error code. The daemon's own message stays the fallback and is never replaced by raw text. */
export function errorCopy(
  code: string | null,
  message: string,
): { title: string; body: string; action: ErrorAction } {
  switch (code) {
    case "cap_reached":
      return {
        title: "Free app calls used up for this month",
        body: "Kora Pro is coming. You can also paste your own Composio key for unlimited calls.",
        action: "byo-key",
      };
    case "broker_down":
      return {
        title: "Connected apps are unreachable",
        body: "Kora's app service is down or this Mac is offline. Nothing was used from your monthly calls.",
        action: "retry",
      };
    case "registration_closed":
      return {
        title: "Free connected apps are paused",
        body: "Kora's app service is not accepting new installs right now. Paste your own Composio key to use apps today.",
        action: "byo-key",
      };
    case "alias_required":
      return {
        title: "Give this account a label",
        body: "A second account of the same app needs a label, like Work or Personal.",
        action: "label",
      };
    case "alias_in_use":
      return {
        title: "That label is taken",
        body: "Pick a different label for this account.",
        action: "label",
      };
    case "account_limit":
      return {
        title: "5 of 5 accounts",
        body: "Disconnect one account of this app to add another.",
        action: null,
      };
    case "link_expired":
      return {
        title: "That link expired",
        body: "Start the connection again to get a fresh one.",
        action: "retry",
      };
    case "bad_key":
      return {
        title: "That key did not work",
        body: message || "Composio keys start with ak_. Copy the project key again.",
        action: null,
      };
    case "unauthorized":
      return {
        title: "Kora's app service does not know this install",
        body: "Reset the connection and connect your apps again. Accounts linked before are out of reach, and nothing was used from your monthly calls.",
        action: "reconnect",
      };
    case "not_configured":
      return {
        title: "Connected apps are not set up yet",
        body: "Paste your own Composio key to start.",
        action: "settings",
      };
    default:
      return { title: "Something went wrong", body: message, action: "retry" };
  }
}

// ── toolkits / categories ────────────────────────────────────────────────────────────────────────────
const CATEGORY_ORDER = [
  "Email",
  "Calendar",
  "Chat",
  "Developer",
  "Docs",
  "Productivity",
  "CRM",
  "Finance",
  "Social",
];
const norm = (s: string) => s.trim().toLowerCase();

/** Categories present in a toolkit list: the well-known ones first (in a fixed order), then the rest by size. */
export function categoriesOf(toolkits: ReadonlyArray<AppToolkitWire>): string[] {
  const counts = new Map<string, number>();
  for (const t of toolkits) for (const c of t.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  const known = CATEGORY_ORDER.filter((c) => [...counts.keys()].some((k) => norm(k) === norm(c)));
  const rest = [...counts.entries()]
    .filter(([c]) => !CATEGORY_ORDER.some((k) => norm(k) === norm(c)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c]) => c);
  return [
    ...known.map((k) => [...counts.keys()].find((c) => norm(c) === norm(k)) ?? k),
    ...rest,
  ].slice(0, 10);
}

export function filterToolkits(
  toolkits: ReadonlyArray<AppToolkitWire>,
  query: string,
  category: string | null,
): AppToolkitWire[] {
  const q = norm(query);
  return toolkits.filter(
    (t) =>
      (category === null || t.categories.some((c) => norm(c) === norm(category))) &&
      (q === "" ||
        norm(t.name).includes(q) ||
        norm(t.slug).includes(q) ||
        norm(t.description).includes(q)),
  );
}

export const MAX_ACCOUNTS = 5;

export function accountsOf(
  accounts: ReadonlyArray<AppAccountWire>,
  toolkit: string,
): AppAccountWire[] {
  return accounts.filter((a) => a.toolkit.toLowerCase() === toolkit.toLowerCase());
}
export const isActive = (a: AppAccountWire): boolean => a.status.toUpperCase() === "ACTIVE";
export function accountLabel(a: AppAccountWire): string {
  return a.alias?.trim() || "Main account";
}
/** Status in a word, for a row. */
export function accountStatusWord(a: AppAccountWire): {
  text: string;
  tone: "good" | "wait" | "bad";
} {
  const s = a.status.toUpperCase();
  if (s === "ACTIVE") return { text: "Connected", tone: "good" };
  if (s === "INITIATED" || s === "INITIALIZING" || s === "PENDING")
    return { text: "Waiting for sign-in", tone: "wait" };
  return { text: "Needs reconnecting", tone: "bad" };
}

const KNOWN_NAMES: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googlesheets: "Google Sheets",
  googledocs: "Google Docs",
  slack: "Slack",
  github: "GitHub",
  notion: "Notion",
  linear: "Linear",
  outlook: "Outlook",
  discord: "Discord",
  jira: "Jira",
  hubspot: "HubSpot",
  x: "X",
  twitter: "X",
  linkedin: "LinkedIn",
  trello: "Trello",
  asana: "Asana",
  airtable: "Airtable",
};
/** A well-known app's display name from its slug, or a tidied slug. */
export function appLabel(slug: string): string {
  const k = slug.toLowerCase();
  return KNOWN_NAMES[k] ?? slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[_-]+/g, " ");
}

/** A toolkit slug as a display name when the catalog has not loaded ("googlecalendar" -> "Google Calendar" is a catalog job; this is the fallback). */
export function toolkitDisplayName(slug: string, toolkits: ReadonlyArray<AppToolkitWire>): string {
  const hit = toolkits.find((t) => t.slug.toLowerCase() === slug.toLowerCase());
  if (hit) return hit.name;
  return appLabel(slug);
}

// ── per-blob grants ──────────────────────────────────────────────────────────────────────────────────
const tkEntry = (toolkit: string) => `toolkit:${toolkit.toLowerCase()}`;

export function normalizeGrants(g: AppGrants | null | undefined): AppGrants {
  if (!g || (g.mode !== "all" && g.mode !== "list")) return NO_GRANTS;
  return { mode: g.mode, allow: [...(g.allow ?? [])] };
}

export function grantsAllowToolkit(g: AppGrants, toolkit: string): boolean {
  if (g.mode === "all") return true;
  return g.mode === "list" && g.allow.some((e) => e.toLowerCase() === tkEntry(toolkit));
}

export function grantsAllowTool(g: AppGrants, toolkit: string, slug: string): boolean {
  if (g.mode === "all") return true;
  if (g.mode !== "list") return false;
  return (
    grantsAllowToolkit(g, toolkit) || g.allow.some((e) => e.toUpperCase() === slug.toUpperCase())
  );
}

/** Toolkits the grants name (whole app or at least one tool): the "Gmail · 3 tools" summary. */
function grantedToolkits(g: AppGrants, connected: ReadonlyArray<string>): string[] {
  if (g.mode === "all") return [...connected];
  if (g.mode !== "list") return [];
  return connected.filter((tk) => {
    const prefix = tk.toUpperCase().replace(/[^A-Z0-9]/g, "") + "_";
    return (
      grantsAllowToolkit(g, tk) ||
      g.allow.some(
        (e) => !e.toLowerCase().startsWith("toolkit:") && e.toUpperCase().startsWith(prefix),
      )
    );
  });
}

/** "all of Gmail" on / off. Off also drops that app's single-tool entries. */
export function setToolkitGrant(
  g: AppGrants,
  toolkit: string,
  on: boolean,
  toolSlugs: ReadonlyArray<string>,
): AppGrants {
  if (g.mode === "all") {
    // narrowing from "all": everything else stays allowed as whole apps is unknown here, so the caller switches to list first
    return g;
  }
  const slugs = new Set(toolSlugs.map((s) => s.toUpperCase()));
  const kept = g.allow.filter(
    (e) => e.toLowerCase() !== tkEntry(toolkit) && !slugs.has(e.toUpperCase()),
  );
  return { mode: "list", allow: on ? [...kept, tkEntry(toolkit)] : kept };
}

/** One tool on / off inside an app whose "all of it" switch may be on (turning one off expands to the others). */
export function setToolGrant(
  g: AppGrants,
  toolkit: string,
  slug: string,
  on: boolean,
  allToolSlugs: ReadonlyArray<string>,
): AppGrants {
  if (g.mode !== "list") return g;
  const wholeApp = grantsAllowToolkit(g, toolkit);
  let allow = [...g.allow];
  if (wholeApp && !on) {
    allow = allow.filter((e) => e.toLowerCase() !== tkEntry(toolkit));
    allow.push(...allToolSlugs.filter((s) => s.toUpperCase() !== slug.toUpperCase()));
  } else if (on) {
    if (!allow.some((e) => e.toUpperCase() === slug.toUpperCase())) allow.push(slug);
  } else {
    allow = allow.filter((e) => e.toUpperCase() !== slug.toUpperCase());
  }
  // every tool picked = the whole app (stays correct when the app gains tools)
  const picked =
    allToolSlugs.length > 0 &&
    allToolSlugs.every((s) => allow.some((e) => e.toUpperCase() === s.toUpperCase()));
  if (picked) {
    const slugs = new Set(allToolSlugs.map((s) => s.toUpperCase()));
    allow = allow.filter((e) => !slugs.has(e.toUpperCase()));
    allow.push(tkEntry(toolkit));
  }
  return { mode: "list", allow: [...new Set(allow)] };
}

/** Connecting an app from a blob's own chip allows that app for that blob (UX ruling), without widening anything else. */
export function withToolkitGranted(g: AppGrants | null | undefined, toolkit: string): AppGrants {
  const cur = normalizeGrants(g);
  if (cur.mode === "all" || grantsAllowToolkit(cur, toolkit)) return cur;
  return { mode: "list", allow: [...(cur.mode === "list" ? cur.allow : []), tkEntry(toolkit)] };
}

/** Apps a grant names, without needing to know what is connected: "toolkit:gmail" and "GMAIL_SEND_EMAIL" both say gmail. */
export function grantedAppSlugs(g: AppGrants): string[] {
  if (g.mode !== "list") return [];
  const out = new Set<string>();
  for (const e of g.allow)
    out.add(
      e.toLowerCase().startsWith("toolkit:")
        ? e.slice(8).trim().toLowerCase()
        : (e.split("_")[0] ?? "").toLowerCase(),
    );
  out.delete("");
  return [...out];
}

/** "Gmail and Google Calendar" / "All connected apps" / "No apps". */
export function grantsLine(g: AppGrants | null | undefined): string {
  const cur = normalizeGrants(g);
  if (cur.mode === "all") return "All connected apps";
  const names = grantedAppSlugs(cur).map(appLabel);
  if (names.length === 0) return "No apps";
  return names.length <= 2 ? names.join(" and ") : `${names.length} apps`;
}

function grantsSummary(
  g: AppGrants,
  connected: ReadonlyArray<string>,
  names: (slug: string) => string,
): string {
  const cur = normalizeGrants(g);
  if (cur.mode === "none") return "No apps";
  if (cur.mode === "all") return "All connected apps";
  const tks = grantedToolkits(cur, connected);
  if (tks.length === 0) return "No apps";
  return tks.length <= 2 ? tks.map(names).join(" and ") : `${tks.length} apps`;
}

/** Tools grouped for the editor: reading first, then the ones that ask first. */
export function splitTools(tools: ReadonlyArray<AppToolWire>): {
  reads: AppToolWire[];
  asks: AppToolWire[];
} {
  const byName = (a: AppToolWire, b: AppToolWire) => a.name.localeCompare(b.name);
  return {
    reads: tools.filter((t) => !t.outbound).sort(byName),
    asks: tools.filter((t) => t.outbound).sort(byName),
  };
}

// ── decision log ─────────────────────────────────────────────────────────────────────────────────────
const REASON_WORDS: Record<string, string> = {
  granted: "Allowed",
  user_approved: "You allowed it",
  user_denied: "You said no",
  full_access_skip: "Allowed (Full)",
  not_granted: "Not allowed for this blob",
  no_approval_channel: "Needed your OK, nobody to ask",
  cap_reached: "Free calls used up",
  not_connected: "App not connected",
  account_required: "Needed an account label",
  bad_request: "Not a valid request",
};
export function reasonWords(reason: string): string {
  return REASON_WORDS[reason] ?? reason.replace(/_/g, " ");
}

/** "GMAIL_SEND_EMAIL" -> "Send email". */
export function toolWords(slug: string): string {
  const parts = slug.split("_");
  const rest = (parts.length > 1 ? parts.slice(1) : parts).join(" ").toLowerCase();
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
