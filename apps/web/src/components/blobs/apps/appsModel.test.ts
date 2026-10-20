import { describe, expect, it } from "vite-plus/test";

import type { AppsStatus, AppToolkitWire } from "./appsApi";
import {
  NO_GRANTS,
  appLabel,
  capState,
  categoriesOf,
  errorCopy,
  filterToolkits,
  grantedAppSlugs,
  grantsAllowTool,
  grantsAllowToolkit,
  grantsLine,
  isNotSetUp,
  normalizeGrants,
  reasonWords,
  resetsLabel,
  setToolGrant,
  setToolkitGrant,
  splitTools,
  toolWords,
  usageLine,
  withToolkitGranted,
  type AppGrants,
} from "./appsModel";

const status = (
  over: Partial<AppsStatus> & { used?: number; limit?: number | null } = {},
): AppsStatus => ({
  mode: "broker",
  byoKeySet: false,
  brokerConfigured: true,
  secretStore: "keychain",
  usage: {
    mode: "broker",
    used: over.used ?? 10,
    limit: over.limit === undefined ? 750 : over.limit,
    month: "2026-10",
    resetsAt: Date.UTC(2026, 10, 1),
    capReached: (over.used ?? 10) >= (over.limit ?? 750),
  },
  error: null,
  errorCode: null,
  ...over,
});

describe("readiness and the cap card", () => {
  it("no broker and no key = not set up (never a broken grid)", () => {
    expect(
      isNotSetUp({ ...status(), mode: "unavailable", brokerConfigured: false, usage: null }),
    ).toBe(true);
    expect(isNotSetUp(status())).toBe(false);
    expect(isNotSetUp(null)).toBe(false);
  });
  it("cap states: ok, near at 90%, capped at the limit, byo has none", () => {
    expect(capState(status({ used: 100 }))).toBe("ok");
    expect(capState(status({ used: 675 }))).toBe("near");
    expect(capState(status({ used: 750 }))).toBe("capped");
    expect(
      capState({
        ...status(),
        mode: "byo",
        byoKeySet: true,
        usage: {
          mode: "byo",
          used: 5000,
          limit: null,
          month: "2026-10",
          resetsAt: null,
          capReached: false,
        },
      }),
    ).toBe("byo");
    expect(capState(null)).toBe("unavailable");
  });
  it("words: x of 750 used, and the reset day in UTC", () => {
    expect(usageLine(status({ used: 312 }).usage)).toBe(
      "312 of 750 free app calls used this month",
    );
    expect(resetsLabel(Date.UTC(2026, 10, 1))).toBe("November 1");
    expect(
      usageLine({
        mode: "byo",
        used: 3,
        limit: null,
        month: "m",
        resetsAt: null,
        capReached: false,
      }),
    ).toBeNull();
  });
});

describe("error copy by code", () => {
  it.each([
    ["cap_reached", /used up/, "byo-key"],
    ["broker_down", /unreachable/, "retry"],
    ["alias_required", /label/i, "label"],
    ["account_limit", /5 of 5/, null],
    ["link_expired", /expired/, "retry"],
    ["bad_key", /key/i, null],
    ["registration_closed", /paused/, "byo-key"],
    ["not_configured", /not set up/, "settings"],
  ] as const)("%s", (code, re, action) => {
    const c = errorCopy(code, "daemon text");
    expect(c.title + c.body).toMatch(re);
    expect(c.action).toBe(action);
  });
  it("an unknown code keeps the daemon's own words", () => {
    expect(errorCopy("weird", "Specific message").body).toBe("Specific message");
  });
});

describe("marketplace", () => {
  const tk = (
    slug: string,
    name: string,
    categories: string[],
    description = "",
  ): AppToolkitWire => ({ slug, name, description, logo: null, categories });
  const all = [
    tk("gmail", "Gmail", ["Email"], "Read and send mail"),
    tk("slack", "Slack", ["Chat"]),
    tk("github", "GitHub", ["Developer"]),
    tk("outlook", "Outlook", ["Email"]),
    tk("zeta", "Zeta", ["Odd"]),
    tk("zed", "Zed", ["Odd"]),
    tk("abc", "Abc", ["Aaa"]),
  ];
  it("categories: the well-known ones first in a fixed order, the rest by size", () => {
    expect(categoriesOf(all)).toEqual(["Email", "Chat", "Developer", "Odd", "Aaa"]);
  });
  it("search matches name, slug and description; a category narrows", () => {
    expect(filterToolkits(all, "mail", null).map((t) => t.slug)).toEqual(["gmail"]); // "Read and send mail" is Gmail's description; Outlook only says Email as a category
    expect(filterToolkits(all, "", "Email").map((t) => t.slug)).toEqual(["gmail", "outlook"]);
    expect(filterToolkits(all, "git", "Developer").map((t) => t.slug)).toEqual(["github"]);
    expect(filterToolkits(all, "nothing", null)).toEqual([]);
  });
  it("labels: known names, tidy fallback", () => {
    expect(appLabel("googlecalendar")).toBe("Google Calendar");
    expect(appLabel("x")).toBe("X");
    expect(appLabel("my_new-app")).toBe("My new app");
  });
});

describe("per-blob grants", () => {
  const list = (...allow: string[]): AppGrants => ({ mode: "list", allow });
  it("default and garbage are none", () => {
    expect(normalizeGrants(undefined)).toEqual(NO_GRANTS);
    expect(normalizeGrants({ mode: "bogus" } as never)).toEqual(NO_GRANTS);
  });
  it("whole app via toolkit:slug; single tools by slug; all allows everything; none nothing", () => {
    expect(grantsAllowToolkit(list("toolkit:gmail"), "gmail")).toBe(true);
    expect(grantsAllowTool(list("toolkit:gmail"), "gmail", "GMAIL_SEND_EMAIL")).toBe(true);
    expect(grantsAllowTool(list("GMAIL_FETCH_EMAILS"), "gmail", "GMAIL_FETCH_EMAILS")).toBe(true);
    expect(grantsAllowTool(list("GMAIL_FETCH_EMAILS"), "gmail", "GMAIL_SEND_EMAIL")).toBe(false);
    expect(grantsAllowTool({ mode: "all", allow: [] }, "slack", "SLACK_X")).toBe(true);
    expect(grantsAllowTool(NO_GRANTS, "slack", "SLACK_X")).toBe(false);
  });
  it("the app switch: on adds toolkit:gmail and drops its single tools; off removes both", () => {
    const slugs = ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"];
    expect(
      setToolkitGrant(list("GMAIL_FETCH_EMAILS", "toolkit:slack"), "gmail", true, slugs),
    ).toEqual(list("toolkit:slack", "toolkit:gmail"));
    expect(setToolkitGrant(list("toolkit:gmail", "toolkit:slack"), "gmail", false, slugs)).toEqual(
      list("toolkit:slack"),
    );
  });
  it("a tool checkbox: single tools add up to the whole app, and unticking one of a whole app expands the rest", () => {
    const slugs = ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL", "GMAIL_DELETE_EMAIL"];
    let g = list();
    g = setToolGrant(g, "gmail", "GMAIL_FETCH_EMAILS", true, slugs);
    expect(g).toEqual(list("GMAIL_FETCH_EMAILS"));
    g = setToolGrant(g, "gmail", "GMAIL_SEND_EMAIL", true, slugs);
    g = setToolGrant(g, "gmail", "GMAIL_DELETE_EMAIL", true, slugs);
    expect(g).toEqual(list("toolkit:gmail")); // every tool = the app (stays right when the app gains tools)
    const narrowed = setToolGrant(g, "gmail", "GMAIL_SEND_EMAIL", false, slugs);
    expect([...narrowed.allow].sort()).toEqual(["GMAIL_DELETE_EMAIL", "GMAIL_FETCH_EMAILS"]);
    expect(grantsAllowTool(narrowed, "gmail", "GMAIL_SEND_EMAIL")).toBe(false);
  });
  it("a connect chip inside a blob allows that app for that blob only (never widens all, never drops others)", () => {
    expect(withToolkitGranted(undefined, "gmail")).toEqual(list("toolkit:gmail"));
    expect(withToolkitGranted(list("toolkit:slack"), "gmail")).toEqual(
      list("toolkit:slack", "toolkit:gmail"),
    );
    expect(withToolkitGranted(list("toolkit:gmail"), "gmail")).toEqual(list("toolkit:gmail"));
    expect(withToolkitGranted({ mode: "all", allow: [] }, "gmail")).toEqual({
      mode: "all",
      allow: [],
    });
  });
  it("summaries read the grant without knowing what is connected", () => {
    expect(grantedAppSlugs(list("toolkit:gmail", "GOOGLECALENDAR_LIST_EVENTS"))).toEqual([
      "gmail",
      "googlecalendar",
    ]);
    expect(grantsLine(list("toolkit:gmail", "GOOGLECALENDAR_LIST_EVENTS"))).toBe(
      "Gmail and Google Calendar",
    );
    expect(grantsLine({ mode: "all", allow: [] })).toBe("All connected apps");
    expect(grantsLine(NO_GRANTS)).toBe("No apps");
    expect(grantsLine(list("toolkit:a", "toolkit:b", "toolkit:c"))).toBe("3 apps");
  });
  it("tools split into reading and 'asks first'", () => {
    const t = (slug: string, outbound: boolean) => ({
      slug,
      name: slug,
      description: "",
      toolkit: "gmail",
      readOnly: null,
      outbound,
    });
    const s = splitTools([t("B_SEND", true), t("A_FETCH", false)]);
    expect(s.reads.map((x) => x.slug)).toEqual(["A_FETCH"]);
    expect(s.asks.map((x) => x.slug)).toEqual(["B_SEND"]);
  });
});

describe("decision log words", () => {
  it("reasons and tool names read as sentences", () => {
    expect(reasonWords("user_approved")).toBe("You allowed it");
    expect(reasonWords("cap_reached")).toBe("Free calls used up");
    expect(reasonWords("something_new")).toBe("something new");
    expect(toolWords("GMAIL_SEND_EMAIL")).toBe("Send email");
  });
});
