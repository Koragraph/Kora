import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Crypto, Effect, Layer, PlatformError } from "effect";
import { beforeEach, vi } from "vite-plus/test";

type PermissionAsk = (
  wc: null,
  permission: string,
  answer: (ok: boolean) => void,
  details: object,
) => void;
type PermissionCheck = (wc: null, permission: string, origin: string, details: object) => boolean;

/** An Electron session that remembers what was done to it. Set `failNext` to make one clear reject. */
class FakeSession {
  userAgent =
    "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Kora/0.1.14 Chrome/146.0.0.0 Electron/41.5.0 Safari/537.36";
  cleared: string[] = [];
  listeners: string[] = [];
  ask?: PermissionAsk;
  check?: PermissionCheck;
  failNext: { what: "storage" | "cache"; error: Error } | undefined;
  getUserAgent = () => this.userAgent;
  setUserAgent = (next: string) => void (this.userAgent = next);
  setPermissionRequestHandler = (fn: PermissionAsk) => void (this.ask = fn);
  setPermissionCheckHandler = (fn: PermissionCheck) => void (this.check = fn);
  on = (event: string) => void this.listeners.push(event);
  clearStorageData = (opts: { storages: string[] }) =>
    this.clear("storage", opts.storages.join("+"));
  clearCache = () => this.clear("cache", "cache");
  private clear(what: "storage" | "cache", label: string) {
    const failure = this.failNext?.what === what ? this.failNext.error : undefined;
    if (failure) this.failNext = undefined;
    else this.cleared.push(label);
    return failure ? Promise.reject(failure) : Promise.resolve();
  }
}

const electron = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  opened: 0,
  refuseNext: undefined as Error | undefined,
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/downloads" },
  session: {
    fromPartition: (partition: string) => {
      const refusal = electron.refuseNext;
      electron.refuseNext = undefined;
      if (refusal) throw refusal;
      electron.opened++;
      // Created lazily so the class above is initialised by then.
      if (!electron.sessions.has(partition)) electron.sessions.set(partition, new FakeSession());
      return electron.sessions.get(partition);
    },
  },
}));

import * as WebPartitions from "./WebPartitions.ts";

const sessionAt = (partition: string) => electron.sessions.get(partition) as FakeSession;
const run = <A, E>(body: (svc: WebPartitions.WebPartitions["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(WebPartitions.WebPartitions, body).pipe(
    Effect.provide(WebPartitions.layer.pipe(Layer.provide(NodeServices.layer))),
  );

beforeEach(() => {
  electron.sessions.clear();
  electron.opened = 0;
  electron.refuseNext = undefined;
});

describe("partition names", () => {
  // Pinned: a change in how names are derived would silently log every user out of every preview.
  it.effect("are stable, and one session is opened per scope however often it is asked for", () =>
    run((svc) =>
      Effect.gen(function* () {
        assert.equal(
          yield* svc.getPartition("scope-a"),
          "persist:kora-preview-f051bb2c68cb7b2fe969",
        );
        assert.equal(yield* svc.getPartition("a::b"), "persist:kora-preview-78f0be89237d77f7a70e");
        const [first, again] = [yield* svc.getSession("scope-a"), yield* svc.getSession("scope-a")];
        assert.strictEqual(first, again);
        assert.equal(electron.opened, 1);
      }),
    ),
  );

  it.effect("never let two different scopes share cookies", () =>
    run((svc) =>
      Effect.gen(function* () {
        const names = [
          yield* svc.getPartition("p\ud800"), // a lone surrogate…
          yield* svc.getPartition("p�"), // …is not the replacement character it encodes to,
          yield* svc.getPartition("p\\ud800"), // nor its escape typed by hand
          yield* svc.getPartition("a::b"), // a default-profile scope…
          yield* svc.getPartition("a::b", true, "profile"), // …is not a named profile with the same text
        ];
        assert.equal(new Set(names).size, names.length);
        assert.equal(names[4], "persist:kora-preview-profile-78f0be89237d77f7a70e");
        assert.isTrue(names.every((name) => svc.isPartition(name)));
      }),
    ),
  );
});

describe("what a preview session allows", () => {
  it.effect(
    "keeps Electron's own User-Agent (a rewritten one sends Cloudflare's check into a loop)",
    () =>
      run((svc) =>
        Effect.gen(function* () {
          const before = new FakeSession().userAgent;
          yield* svc.getSession("scope-a");
          assert.equal(sessionAt(yield* svc.getPartition("scope-a")).userAgent, before);
        }),
      ),
  );

  it.effect(
    "grants by site: clipboard writes everywhere, dev-server extras on localhost only",
    () =>
      run((svc) =>
        Effect.gen(function* () {
          yield* svc.getSession("scope-a");
          const session = sessionAt(yield* svc.getPartition("scope-a"));
          assert.deepEqual(session.listeners, ["will-download"]);
          /** The same answer must come from both the request and the check handler. */
          const allowed = (permission: string, url: string) => {
            let asked: boolean | undefined;
            session.ask!(null, permission, (ok) => (asked = ok), { requestingUrl: url });
            const checked = session.check!(null, permission, url, { requestingUrl: url });
            assert.equal(asked, checked, `${permission} on ${url}`);
            return checked;
          };
          const table: Array<[string, string, boolean]> = [
            ["clipboard-sanitized-write", "https://example.com/", true],
            ["clipboard-sanitized-write", "http://localhost:3000/", true],
            ["clipboard-read", "https://example.com/", false],
            ["notifications", "https://example.com/", false],
            ["geolocation", "https://example.com/", false],
            ["media", "https://example.com/", false],
            ["clipboard-read", "http://localhost:5173/", true],
            ["notifications", "http://127.0.0.1:3000/", true],
            ["geolocation", "http://localhost:5173/", true],
            ["clipboard-write", "http://localhost:3000/", false], // not a real Electron permission
            ["midi", "http://localhost:3000/", false],
            ["local-fonts", "http://localhost:3000/", false],
            ["media", "http://localhost:3000/", false],
          ];
          for (const [permission, url, expected] of table) {
            assert.equal(allowed(permission, url), expected, `${permission} on ${url}`);
          }
        }),
      ),
  );
});

describe("clearing cookies and cache", () => {
  it.effect("reaches every open session", () =>
    run((svc) =>
      Effect.gen(function* () {
        for (const scope of ["scope-a", "scope-b"]) yield* svc.getSession(scope);
        yield* svc.clearCookies();
        yield* svc.clearCache();
        for (const session of electron.sessions.values()) {
          assert.deepEqual((session as FakeSession).cleared, [
            "cookies+localstorage+indexdb+serviceworkers",
            "cache",
          ]);
        }
      }),
    ),
  );

  it.effect(
    "opens a session that is not open yet when its partition is named (after a restart)",
    () =>
      run((svc) =>
        Effect.gen(function* () {
          const partition = yield* svc.getPartition("scope-later");
          assert.isFalse(electron.sessions.has(partition), "naming it opens nothing");
          yield* svc.clearCookies([partition]);
          yield* svc.getSession("scope-later");
          yield* svc.clearCookies([partition]);
          assert.isAtLeast(sessionAt(partition).cleared.length, 1);
        }),
      ),
  );

  it.effect("a failure names its partition, and every other session is still cleared", () =>
    run((svc) =>
      Effect.gen(function* () {
        for (const scope of ["scope-a", "scope-b"]) yield* svc.getSession(scope);
        const [a, b] = [yield* svc.getPartition("scope-a"), yield* svc.getPartition("scope-b")];

        const diskFull = new Error("disk full");
        sessionAt(b).failNext = { what: "storage", error: diskFull };
        const storage = yield* Effect.flip(svc.clearCookies());
        assert.instanceOf(storage, WebPartitions.BrowserSessionStorageClearError);
        assert.deepInclude(storage, { partition: b, cause: diskFull });
        assert.equal(
          storage.message,
          `Failed to clear desktop preview browser storage for partition ${b}.`,
        );
        assert.lengthOf(sessionAt(a).cleared, 1);

        const locked = new Error("cache locked");
        sessionAt(a).failNext = { what: "cache", error: locked };
        const cache = yield* Effect.flip(svc.clearCache());
        assert.instanceOf(cache, WebPartitions.BrowserSessionCacheClearError);
        assert.deepInclude(cache, { partition: a, cause: locked });
        assert.equal(
          cache.message,
          `Failed to clear the desktop preview browser cache for partition ${a}.`,
        );
        assert.include(sessionAt(b).cleared, "cache");
      }),
    ),
  );
});

describe("errors keep their cause out of the message", () => {
  it.effect("a name that cannot be derived keeps the scope and the whole failure chain", () => {
    const native = new Error("digest unavailable");
    const platform = PlatformError.systemError({
      cause: native,
      method: "digest",
      module: "Crypto",
      _tag: "Unknown",
    });
    const noDigest = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({ randomBytes: (n) => new Uint8Array(n), digest: () => Effect.fail(platform) }),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.flatMap(WebPartitions.WebPartitions, (svc) => svc.getPartition("scope-x")),
      );
      assert.instanceOf(error, WebPartitions.BrowserSessionPartitionDerivationError);
      assert.deepInclude(error, { scope: "scope-x", cause: platform });
      assert.strictEqual(error.cause.reason.cause, native);
      assert.equal(
        error.message,
        "Failed to derive a desktop preview browser partition for scope scope-x.",
      );
    }).pipe(Effect.provide(WebPartitions.layer.pipe(Layer.provide(noDigest))));
  });

  it.effect("a session Electron refuses to make keeps scope, partition and Electron's error", () =>
    run((svc) =>
      Effect.gen(function* () {
        const refusal = new Error("not ready");
        const partition = yield* svc.getPartition("scope-y");
        electron.refuseNext = refusal;
        const error = yield* Effect.flip(svc.getSession("scope-y"));
        assert.instanceOf(error, WebPartitions.BrowserSessionCreationError);
        assert.deepInclude(error, { scope: "scope-y", partition, cause: refusal });
        assert.notInclude(error.message, refusal.message);
      }),
    ),
  );
});
