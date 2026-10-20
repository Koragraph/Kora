// @effect-diagnostics nodeBuiltinImport:off -- platform path forms (\w\app on Windows) for the expected wire values.
import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

import { RPC_METHODS, TRUST_METHODS, type TrustOperationError } from "@kora/contracts";
import * as Effect from "effect/Effect";

import { mergedHandlerTags } from "../handlers.ts";
import { setHost, type UiHost } from "../host.ts";
import { trustHandlers, type KoraTrustLike } from "./trust.ts";

const status = (cwd: string, trusted: boolean) => ({
  cwd,
  root: cwd,
  trusted,
  trustedBy: trusted ? cwd : null,
  source: trusted ? "user" : null,
  canTrust: true,
  reason: null,
  extra: undefined,
});

function bind(trust: Partial<KoraTrustLike> | undefined, logs: string[] = []): void {
  setHost({ trust, log: (...p: unknown[]) => logs.push(p.join(" ")) } as unknown as UiHost);
}
type Outcome = { _tag: "Right"; right: unknown } | { _tag: "Left"; left: TrustOperationError };
const run = (tag: string, input: unknown): Promise<Outcome> =>
  Effect.runPromise(
    (trustHandlers[tag]!(input) as Effect.Effect<unknown, TrustOperationError>).pipe(
      Effect.map((right): Outcome => ({ _tag: "Right", right })),
      Effect.catch((left) => Effect.succeed<Outcome>({ _tag: "Left", left })),
    ),
  );

test("every trust RPC is registered with a real handler", () => {
  const real = mergedHandlerTags();
  for (const tag of Object.values(TRUST_METHODS)) assert.ok(real.has(tag), tag);
});

test("trust.get / trust.set delegate to UiHost.trust with the wire shape (no undefined)", async () => {
  const W = path.normalize("/w/app"); // \w\app on Windows
  const calls: string[] = [];
  const logs: string[] = [];
  bind(
    {
      status: (cwd) => (calls.push(`status ${cwd}`), status(cwd, false)),
      trust: (cwd) => (calls.push(`trust ${cwd}`), status(cwd, true)),
      revoke: (cwd) => (calls.push(`revoke ${cwd}`), status(cwd, false)),
    },
    logs,
  );
  const got = await run(RPC_METHODS.trustGet, { cwd: "/w/app" });
  assert.equal(got._tag, "Right");
  assert.deepEqual((got as { right: unknown }).right, {
    cwd: W,
    root: W,
    trusted: false,
    trustedBy: null,
    source: null,
    canTrust: true,
    reason: null,
  });
  const set = await run(RPC_METHODS.trustSet, { cwd: "/w/app", trusted: true });
  assert.equal((set as { right: { trusted: boolean } }).right.trusted, true);
  await run(RPC_METHODS.trustSet, { cwd: "~/x", trusted: false });
  assert.deepEqual(calls, [`status ${W}`, `trust ${W}`, `revoke ${path.join(os.homedir(), "x")}`]);
  assert.ok(logs.some((l) => l.includes(`granted: ${W}`)));
});

test("bad input and store refusals are typed TrustOperationErrors, never a hang or defect", async () => {
  bind({
    status: () => status("/x", false),
    trust: () => {
      throw new Error("Cannot trust /Users/me: your home folder cannot be trusted");
    },
    revoke: () => status("/x", false),
  });
  for (const input of [{ cwd: "relative/path" }, { cwd: "" }, {}, { cwd: "/a\0b" }]) {
    const r = await run(RPC_METHODS.trustGet, input);
    assert.equal(r._tag, "Left", JSON.stringify(input));
  }
  const missingFlag = await run(RPC_METHODS.trustSet, { cwd: "/a" });
  assert.equal(missingFlag._tag, "Left");
  const refused = await run(RPC_METHODS.trustSet, { cwd: "/Users/me", trusted: true });
  assert.equal(refused._tag, "Left");
  const err = (refused as { left: TrustOperationError }).left;
  assert.equal(err._tag, "TrustOperationError");
  assert.match(err.message, /home folder/);
});

test("an older daemon without UiHost.trust answers an error, not a hang", async () => {
  bind(undefined);
  const r = await run(RPC_METHODS.trustList, {});
  assert.equal(r._tag, "Left");
});

test("trust.list maps the store's entries", async () => {
  bind({
    list: () => [
      { path: "/a", trustedAt: 5, source: "migration" },
      { path: 7 },
      { path: "/b", trustedAt: "x", source: "weird" },
    ],
  });
  const r = await run(RPC_METHODS.trustList, {});
  assert.deepEqual((r as { right: unknown }).right, {
    folders: [
      { path: "/a", trustedAt: 5, source: "migration" },
      { path: "/b", trustedAt: 0, source: "user" },
    ],
  });
});
