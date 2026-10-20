// @effect-diagnostics nodeBuiltinImport:off -- a plain node:test harness.
// Phase 7 + 6 as the ui-server wires them: routing of engine ids (ACP / API / `claude:<account>`), the provider entries the
// composer needs (driver === instanceId, listed even when unavailable), the engines.do handler (a key is never echoed),
// and the single-use ticket that lets a browser open the blob browser's live view.
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeTest from "node:test";

import { engineAvailabilityFrom } from "./blobsEngine.ts";
import { daemonConfig } from "./config.ts";
import { type KoraEnginesLike, setHost, type UiHost } from "./host.ts";
import { syncEngineProviders } from "./enginesProviders.ts";
import { accountOfForTests, routeAgentForTests } from "./kora-chat.ts";
import { doEngines } from "./handlers/engines.ts";
import { makeLocalAuth } from "./localAuth.ts";
import { LIVE_PATH_RE } from "./handlers/blobs-browser.ts";

const assert: typeof NodeAssert = NodeAssert;
const test = NodeTest.test;
type Picker = Awaited<ReturnType<KoraEnginesLike["pickerEngines"]>>;

function fakeEngines(state: {
  picker: Picker;
  accounts: Array<{ name: string; label: string }>;
  known: string[];
}) {
  const events = new NodeEvents.EventEmitter();
  const calls: Array<[string, unknown]> = [];
  const view = () => ({
    engines: [],
    acp: [],
    endpoints: [],
    accounts: [],
    presets: [],
    acpIdleMinutes: 10,
  });
  const e: KoraEnginesLike = {
    view: async () => view(),
    pickerEngines: async () => state.picker,
    accountList: () => state.accounts,
    route: (id) => (state.known.includes(id) ? { driver: id, koraAgent: id } : null),
    acpSave: (i) => void calls.push(["acpSave", i]),
    acpRemove: (id) => void calls.push(["acpRemove", id]),
    acpModels: async () => ({ models: [{ id: "m1", name: "M1" }], current: "m1" }),
    setIdleMinutes: (m) => void calls.push(["idle", m]),
    setExecutable: (en, p) => {
      calls.push(["exe", [en, p]]);
      return {};
    },
    apiSave: (i) => {
      calls.push(["apiSave", i]);
      return {};
    },
    apiRemove: async (id) => void calls.push(["apiRemove", id]),
    apiSetKey: async (id, key) => void calls.push(["setKey", [id, key]]),
    apiClearKey: async (id) => void calls.push(["clearKey", id]),
    apiTest: async (id, key) => {
      calls.push(["test", [id, key]]);
      return { ok: true, kind: "ok", message: "ok", modelCount: 3 };
    },
    apiModels: async () => [{ id: "a", name: "a" }],
    accountAdd: (i) => {
      calls.push(["accountAdd", i]);
      return { name: i.name };
    },
    accountRename: () => {},
    accountRemove: () => {},
    accountCheck: async (n) => ({ name: n }),
    on: (ev, fn) => events.on(ev, fn),
  };
  return { e, calls, events };
}

function bind(e: KoraEnginesLike) {
  setHost({ engines: e, log: () => {} } as unknown as UiHost);
}

const providers = () =>
  daemonConfig.providers as unknown as Array<{
    instanceId: string;
    driver: string;
    status: string;
    installed: boolean;
    message?: string;
    models: Array<{ slug: string; isDefault?: boolean }>;
    badgeLabel?: string;
  }>;
const instances = () =>
  daemonConfig.settings.providerInstances as Record<string, { driver: string; enabled: boolean }>;

test("routing: engine ids reach their own driver, accounts reach Claude, the rest falls back to Claude", () => {
  const f = fakeEngines({ picker: [], accounts: [], known: ["gemini", "acp-hermes", "api-groq"] });
  bind(f.e);
  assert.deepEqual(routeAgentForTests("claude"), { driver: "claude", koraAgent: "claude" });
  assert.deepEqual(routeAgentForTests("codex"), { driver: "codex", koraAgent: "codex" });
  assert.deepEqual(routeAgentForTests("opencode"), { driver: "opencode", koraAgent: "opencode" });
  // Antigravity is built in (no Settings > Engines row needed): driver === instanceId === the session's providerName
  assert.deepEqual(routeAgentForTests("antigravity"), {
    driver: "antigravity",
    koraAgent: "antigravity",
  });
  assert.deepEqual(routeAgentForTests("claude-work"), { driver: "claude", koraAgent: "claude" });
  assert.deepEqual(routeAgentForTests("gemini"), { driver: "gemini", koraAgent: "gemini" });
  assert.deepEqual(routeAgentForTests("api-groq"), { driver: "api-groq", koraAgent: "api-groq" });
  assert.deepEqual(
    routeAgentForTests("api-removed"),
    { driver: "claude", koraAgent: "claude" },
    "an unknown id is Claude, as before",
  );
  assert.deepEqual(routeAgentForTests(undefined), { driver: "claude", koraAgent: "claude" });
  assert.equal(accountOfForTests("claude-work"), "work");
  assert.equal(accountOfForTests("claude"), null);
  assert.equal(accountOfForTests("codex:work"), null);
  assert.equal(accountOfForTests("claude-Bad Name"), null);
});

test("providers: usable engines get a provider + instance entry with driver === instanceId; unavailable ones stay with their reason; removal cleans up", async () => {
  const st = {
    picker: [
      {
        id: "gemini",
        label: "Gemini CLI",
        family: "acp" as const,
        available: true,
        models: [],
        defaultModel: null,
      },
      {
        id: "api-groq",
        label: "Groq",
        family: "api" as const,
        available: false,
        reason: "Groq needs an API key. Add one in Settings > Engines.",
        models: [],
        defaultModel: null,
      },
      {
        id: "api-lm",
        label: "LM Studio",
        family: "api" as const,
        available: true,
        models: [
          { id: "qwen", name: "Qwen" },
          { id: "llama", name: "Llama" },
        ],
        defaultModel: "llama",
      },
    ] as Picker,
    accounts: [{ name: "work", label: "Work" }],
    known: [] as string[],
  };
  const f = fakeEngines(st);
  bind(f.e);
  assert.equal(await syncEngineProviders(), true);
  const by = (id: string) => providers().find((p) => p.instanceId === id)!;
  assert.equal(by("gemini").driver, "gemini");
  assert.equal(by("gemini").status, "ready");
  assert.deepEqual(
    by("gemini").models.map((m) => m.slug),
    ["default"],
    "a placeholder until its models are discovered",
  );
  assert.equal(by("gemini").badgeLabel, "ACP");
  assert.equal(by("api-groq").status, "error");
  assert.equal(by("api-groq").installed, false);
  assert.match(by("api-groq").message!, /needs an API key/);
  assert.equal(by("api-lm").models.find((m) => m.isDefault)?.slug, "llama");
  assert.equal(
    by("claude-work").driver,
    "claude",
    "an account is the Claude driver on its own login",
  );
  assert.ok(by("claude-work").models.length > 0, "with Claude's models");
  for (const id of ["gemini", "api-groq", "api-lm", "claude-work"])
    assert.ok(
      instances()[id]?.enabled,
      `${id} is enabled in providerInstances or the composer forces it off`,
    );
  assert.equal(await syncEngineProviders(), false, "nothing changed: no frame");
  // "best installed" is Claude, Codex or a free model - an ACP / API engine is never chosen for the user
  const best = engineAvailabilityFrom(null).best;
  assert.ok(
    best === null || ["claude", "codex", "opencode"].includes(best.instanceId),
    `best installed was ${best?.instanceId}`,
  );

  st.picker = [st.picker[0]!];
  st.accounts = [];
  assert.equal(await syncEngineProviders(), true);
  assert.ok(
    !providers().some((p) => p.instanceId === "api-groq" || p.instanceId === "claude-work"),
  );
  assert.ok(!("api-groq" in instances()));
  assert.ok(
    providers().some((p) => p.instanceId === "claude"),
    "the built-in providers are untouched",
  );
  st.picker = [];
  await syncEngineProviders();
  assert.ok(!providers().some((p) => p.instanceId === "gemini"));
});

test("engines.do: each action reaches the service; a key goes in once and no result echoes it", async () => {
  const f = fakeEngines({ picker: [], accounts: [], known: [] });
  bind(f.e);
  const r1 = await doEngines(f.e, { op: "api.setKey", id: "groq", key: "gsk_secret_value_123" });
  assert.deepEqual(f.calls.at(-1), ["setKey", ["groq", "gsk_secret_value_123"]]);
  assert.ok(!JSON.stringify(r1).includes("gsk_secret_value_123"));
  const r2 = await doEngines(f.e, { op: "api.test", id: "groq", key: "gsk_typed_000000" });
  assert.deepEqual(r2.test, { ok: true, kind: "ok", message: "ok", modelCount: 3 });
  assert.ok(!JSON.stringify(r2).includes("gsk_typed"));
  const r3 = await doEngines(f.e, { op: "acp.models", agentId: "gemini" });
  assert.deepEqual(r3.models, [{ id: "m1", name: "M1" }]);
  assert.equal(r3.current, "m1");
  await doEngines(f.e, { op: "acp.save", agentId: "gemini", args: ["--acp"], executable: null });
  assert.deepEqual(f.calls.at(-1), [
    "acpSave",
    { agentId: "gemini", executable: null, args: ["--acp"] },
  ]);
  await doEngines(f.e, { op: "exe.set", engine: "codex", path: "/opt/codex" });
  await doEngines(f.e, { op: "account.add", name: "work", label: "Work" });
  assert.deepEqual(f.calls.at(-1), ["accountAdd", { name: "work", label: "Work" }]);
  const r4 = await doEngines(f.e, { op: "refresh" });
  assert.ok(r4.view);
});

test("the blob browser's live view opens with a single-use ticket, on its own path only", () => {
  const auth = makeLocalAuth({ token: "t".repeat(43), port: 8811 });
  const req = (url: string) => ({ method: "GET", url, headers: { host: "127.0.0.1:8811" } });
  assert.ok(LIVE_PATH_RE.test("/blob-browser/blob_abc123/live"));
  const t = auth.issueTicket().ticket;
  assert.equal(auth.check(req(`/blob-browser/blob_abc123/live?wsTicket=${t}`)).ok, true);
  assert.equal(
    auth.check(req(`/blob-browser/blob_abc123/live?wsTicket=${t}`)).ok,
    false,
    "single use",
  );
  assert.equal(
    auth.check(req("/blob-browser/blob_abc123/live")).ok,
    false,
    "no credential, no view",
  );
  const t2 = auth.issueTicket().ticket;
  assert.equal(
    auth.check(req(`/blob-browser/../api/x?wsTicket=${t2}`)).ok,
    false,
    "a ticket is not a general credential",
  );
  assert.equal(auth.check(req(`/api/blobs/x?wsTicket=${t2}`)).ok, false);
  assert.equal(auth.check(req(`/blob-browser/blob_abc123/live/extra?wsTicket=${t2}`)).ok, false);
});
