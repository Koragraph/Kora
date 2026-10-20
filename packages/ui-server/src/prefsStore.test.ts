// @effect-diagnostics nodeBuiltinImport:off -- the test drives the store against a temp KORA_HOME on disk.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DaemonConfigStreamEvent, DaemonPrefs, RPC_METHODS } from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { daemonConfig } from "./config.ts";
import { buildHandlers } from "./handlers.ts";
import { loadPrefs, settingsPath, updateSettings } from "./prefsStore.ts";

// Never touch the real ~/.kora: every test points the store at a temp home first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kora-settings-"));
loadPrefs(path.join(home, "settings.json"));

const handlers = buildHandlers() as Record<string, (input: unknown) => unknown>;
const call = (tag: string, input: unknown) => handlers[tag]!(input);
const instances = (settings: DaemonPrefs) =>
  settings.providerInstances as Record<string, { driver: string; enabled?: boolean }>;

test("server.updateSettings applies, persists and returns the patch (Default permissions / switches)", async () => {
  const before = daemonConfig.settings;
  const result = await Effect.runPromise(
    call(RPC_METHODS.daemonPrefsUpdate, {
      patch: {
        defaultRuntimeMode: "approval-required",
        newWorktreesStartFromOrigin: !before.newWorktreesStartFromOrigin,
        enableProviderUpdateChecks: !before.enableProviderUpdateChecks,
      },
    }) as Effect.Effect<DaemonPrefs>,
  );
  assert.equal(result.defaultRuntimeMode, "approval-required");
  assert.equal(result.newWorktreesStartFromOrigin, !before.newWorktreesStartFromOrigin);
  assert.equal(result.enableProviderUpdateChecks, !before.enableProviderUpdateChecks);
  assert.equal(daemonConfig.settings.defaultRuntimeMode, "approval-required");
  // The success value must encode, and the built-in providers stay registered.
  Schema.encodeSync(DaemonPrefs)(result);
  assert.equal(instances(result).claude?.enabled, true);

  const persisted = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  assert.equal(persisted.defaultRuntimeMode, "approval-required");
});

test("persisted settings survive a daemon restart (loadPrefs)", () => {
  updateSettings({ defaultRuntimeMode: "auto-accept-edits" });
  const reloaded = loadPrefs(path.join(home, "settings.json"));
  assert.equal(reloaded.defaultRuntimeMode, "auto-accept-edits");
  assert.equal(instances(reloaded).codex?.driver, "codex");
});

test("an unreadable settings file keeps the current settings instead of throwing", () => {
  const bad = path.join(home, "bad.json");
  fs.writeFileSync(bad, "{not json");
  const current = daemonConfig.settings;
  assert.equal(loadPrefs(bad), current);
  loadPrefs(path.join(home, "settings.json"));
});

// Deterministic under load (F5, 2026-10-02): the old version forked the collector, slept 20 ms and then updated —
// on a loaded machine the subscription was not live yet, the update was missed and `take(2)` waited forever (a full
// `pnpm test` hung for an hour here). Now the update fires only once the snapshot frame has arrived (the listener is
// registered by then), other frame types (provider statuses) are ignored, and the whole thing has a deadline.
test(
  "subscribeDaemonConfig streams a settingsUpdated frame after each update, JSON-safe",
  { timeout: 20_000 },
  async () => {
    const stream = call(RPC_METHODS.subscribeDaemonConfig, {}) as Stream.Stream<{ type: string }>;
    const frames = await Effect.runPromise(
      stream.pipe(
        Stream.tap((frame) =>
          frame.type === "snapshot"
            ? Effect.sync(() => updateSettings({ defaultRuntimeMode: "full-access" }))
            : Effect.void,
        ),
        Stream.filter((frame) => frame.type === "snapshot" || frame.type === "settingsUpdated"),
        Stream.take(2),
        Stream.runCollect,
        Effect.timeout("15 seconds"),
      ),
    );
    const list = [...frames] as Array<{ type: string; payload?: { settings: DaemonPrefs } }>;
    assert.deepEqual(
      list.map((frame) => frame.type),
      ["snapshot", "settingsUpdated"],
    );
    assert.equal(list[1]!.payload!.settings.defaultRuntimeMode, "full-access");
    // Encodes against the wire schema and survives the JSON codec with no `undefined` anywhere.
    const encoded = Schema.encodeSync(DaemonConfigStreamEvent)(list[1] as never);
    assert.deepEqual(JSON.parse(JSON.stringify(encoded)), encoded);
  },
);

test("per-project overrides save, survive a restart and resolve for that project (pl2 S2-3)", async () => {
  const { resolveProjectPrefs } = await import("@kora/shared/projectPrefs");
  // The client gates every project-scope save on this flag.
  assert.equal(daemonConfig.environment.capabilities.projectSettingsOverrides, true);
  const pick = { instanceId: "claude", model: "claude-haiku-5-5" };
  updateSettings({
    projectSettingsOverrides: { "proj-a": { defaultModelSelection: pick } },
  } as never);
  loadPrefs(settingsPath());
  const settings = daemonConfig.settings;
  const resolved = resolveProjectPrefs(settings, "proj-a" as never);
  assert.equal(
    (resolved.settings.defaultModelSelection as { model?: string } | null)?.model,
    "claude-haiku-5-5",
  );
  assert.equal(resolved.sources.defaultModelSelection, "project");
  assert.notEqual(
    (
      resolveProjectPrefs(settings, "proj-b" as never).settings.defaultModelSelection as {
        model?: string;
      } | null
    )?.model,
    "claude-haiku-5-5",
  );
});

test("a removed project's per-project settings are dropped, others kept (plv S3-5)", async () => {
  const { dropProjectPrefs } = await import("./prefsStore.ts");
  const pick = { instanceId: "claude", model: "claude-haiku-5-5" };
  updateSettings({
    projectSettingsOverrides: {
      "proj-gone": { defaultModelSelection: pick },
      "proj-kept": { defaultModelSelection: pick },
    },
  } as never);
  assert.equal(dropProjectPrefs("proj-gone"), true);
  assert.equal(dropProjectPrefs("proj-never"), false);
  const persisted = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  assert.equal(Object.hasOwn(persisted.projectSettingsOverrides, "proj-gone"), false);
  assert.equal(Object.hasOwn(persisted.projectSettingsOverrides, "proj-kept"), true);
  assert.equal(
    Object.hasOwn(daemonConfig.settings.projectSettingsOverrides as object, "proj-gone"),
    false,
  );
});
