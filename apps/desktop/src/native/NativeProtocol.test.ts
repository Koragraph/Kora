import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

type Handler = (request: Request) => Response | Promise<Response>;

/** Electron's protocol module as a registry: the scheme → handler map and the fetch the proxy uses. */
const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  handle: vi.fn(),
  unhandle: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("electron", () => ({
  net: { fetch: electron.fetch },
  protocol: { handle: electron.handle, unhandle: electron.unhandle },
}));

import * as NativeProtocol from "./NativeProtocol.ts";

const live = NativeProtocol.layer.pipe(Layer.provide(NodeServices.layer));
const withFs = Layer.merge(live, NodeServices.layer);

beforeEach(() => {
  electron.handlers.clear();
  electron.handle
    .mockReset()
    .mockImplementation((scheme: string, h: Handler) => void electron.handlers.set(scheme, h));
  electron.unhandle.mockReset();
  electron.fetch.mockReset();
});

/** Send a request to whatever is registered for the URL's scheme. */
const send = (url: string, init?: RequestInit) =>
  Effect.promise(async () => {
    const scheme = new URL(url).protocol.slice(0, -1);
    const handler = electron.handlers.get(scheme);
    if (!handler) throw new Error(`nothing registered for ${scheme}:`);
    return handler(new Request(url, init));
  });
const body = (r: Response) => Effect.promise(() => r.text());
const register = (input: NativeProtocol.ShellProtocolRegistrationInput) =>
  Effect.flatMap(NativeProtocol.NativeProtocol, (p) => p.registerDesktopProtocol(input));

/** A temp folder holding `files` (a stand-in for the built web client). */
const builtClient = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* Effect.forEach(Object.entries(files), ([name, text]) =>
      fs.writeFileString(`${dir}/${name}`, text),
    );
    return dir;
  });

/** CSP directives as name → sources. */
const directives = (policy: string) =>
  new Map(
    policy.split("; ").map((d) => {
      const [name = "", ...sources] = d.split(" ");
      return [name, sources] as const;
    }),
  );

describe("serving the built client from disk", () => {
  it.effect("routes, assets, misses and hostile paths", () =>
    Effect.gen(function* () {
      yield* register({
        scheme: "kora",
        assetDirectory: yield* builtClient({
          "index.html": "<html>kora</html>",
          "main.js": "export {};",
        }),
      });

      const route = yield* send("kora://app/settings/extensions");
      assert.equal(
        yield* body(route),
        "<html>kora</html>",
        "an app route falls back to index.html",
      );
      assert.include(route.headers.get("content-security-policy") ?? "", "default-src 'self'");
      const dotted = yield* send("kora://app/thread/a.b.c", { headers: { accept: "text/html" } });
      assert.equal(
        yield* body(dotted),
        "<html>kora</html>",
        "a dotted route that asks for HTML is still a route",
      );

      const asset = yield* send("kora://app/main.js?cache=2");
      assert.equal(yield* body(asset), "export {};");
      assert.match(asset.headers.get("content-type") ?? "", /javascript/);

      const statuses = yield* Effect.all([
        send("kora://app/nope.js"),
        send("kora://app/%2e%2e%2fsecret.txt"),
        send("kora://app/%zz"),
        send("kora://app/", { method: "DELETE" }),
      ]);
      assert.deepEqual(
        statuses.map((r) => r.status),
        [404, 404, 400, 405],
      );
      assert.lengthOf(electron.fetch.mock.calls, 0, "never touches the network");
    }).pipe(Effect.provide(withFs), Effect.scoped),
  );

  it.effect("a missing build answers 500 with a page that says so", () =>
    Effect.gen(function* () {
      const dir = yield* builtClient({});
      yield* register({ scheme: "kora", assetDirectory: `${dir}/not-built` });
      const page = yield* send("kora://app/");
      assert.equal(page.status, 500);
      assert.include(yield* body(page), "could not load its interface");
    }).pipe(Effect.provide(withFs), Effect.scoped),
  );
});

describe("proxying to a dev server", () => {
  it.effect(
    "forwards the path and query, drops browser-origin headers, unregisters on scope close",
    () =>
      Effect.gen(function* () {
        electron.fetch.mockResolvedValue(new Response("pong"));
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* register({
              scheme: "kora-dev",
              targetOrigin: new URL("http://127.0.0.1:4000/"),
            });
            const reply = yield* send("kora-dev://app/api/ping?deep=1", {
              headers: {
                accept: "application/json",
                origin: "kora-dev://app",
                referer: "kora-dev://app/x",
                "sec-fetch-site": "same-origin",
              },
            });
            assert.equal(yield* body(reply), "pong");
            const csp = directives(reply.headers.get("content-security-policy") ?? "");
            assert.deepEqual(csp.get("script-src"), [
              "'self'",
              "'unsafe-inline'",
              "'wasm-unsafe-eval'",
            ]);
            assert.includeMembers(csp.get("connect-src") ?? [], [
              "'self'",
              "http://127.0.0.1:*",
              "ws://127.0.0.1:*",
            ]);
            assert.includeMembers(csp.get("img-src") ?? [], ["kora-dev:", "blob:", "data:"]);
            assert.includeMembers(csp.get("font-src") ?? [], ["kora-dev:", "data:"]);
          }),
        );
        assert.deepEqual(
          [...electron.handle.mock.calls.map((c) => c[0])],
          ["kora-preview", "kora-dev"],
        );
        const [target, init] = electron.fetch.mock.calls[0] ?? [];
        assert.equal(target, "http://127.0.0.1:4000/api/ping?deep=1");
        const forwarded = new Headers(init?.headers);
        assert.equal(forwarded.get("accept"), "application/json");
        for (const h of ["origin", "referer", "sec-fetch-site"])
          assert.isNull(forwarded.get(h), `${h} is not forwarded`);
        assert.deepEqual(electron.unhandle.mock.calls, [["kora-dev"], ["kora-preview"]]);
      }).pipe(Effect.provide(live)),
  );

  it.effect("a request for another host is refused without a network call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* register({ scheme: "kora", targetOrigin: new URL("http://127.0.0.1:4000/") });
        assert.equal((yield* send("kora://elsewhere/")).status, 404);
        assert.lengthOf(electron.fetch.mock.calls, 0);
      }),
    ).pipe(Effect.provide(live)),
  );

  it.effect("a dev server that is still starting is retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        electron.fetch
          .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
          .mockResolvedValueOnce(new Response("up"));
        yield* register({ scheme: "kora-dev", targetOrigin: new URL("http://127.0.0.1:4100/") });
        assert.equal(yield* body(yield* send("kora-dev://app/")), "up");
        assert.lengthOf(electron.fetch.mock.calls, 2);
      }),
    ).pipe(Effect.provide(live)),
  );
});

describe("HTML previews", () => {
  it.effect("have their own scheme; an unknown document is a 404", () =>
    Effect.gen(function* () {
      yield* register({ scheme: "kora", targetOrigin: new URL("http://127.0.0.1:4000/") });
      assert.equal((yield* send(`kora-preview://doc/${"f".repeat(32)}`)).status, 404);
    }).pipe(Effect.provide(live), Effect.scoped),
  );
});

describe("registration failures", () => {
  it.effect("registering", () =>
    Effect.gen(function* () {
      const boom = new Error("handle refused");
      electron.handle.mockImplementationOnce(() => {
        throw boom;
      });
      const failure = yield* Effect.flip(
        Effect.scoped(
          register({ scheme: "kora-dev", targetOrigin: new URL("http://127.0.0.1:1/") }),
        ),
      );
      assert.instanceOf(failure, NativeProtocol.NativeProtocolRegistrationError);
      assert.deepInclude(failure, { scheme: "kora-dev", cause: boom });
      assert.equal(failure.message, 'Failed to register Electron protocol scheme "kora-dev".');
    }).pipe(Effect.provide(live)),
  );

  it.effect("unregistering dies with the scheme", () =>
    Effect.gen(function* () {
      const boom = new Error("unhandle refused");
      electron.unhandle.mockImplementationOnce(() => {
        throw boom;
      });
      const exit = yield* Effect.exit(
        Effect.scoped(register({ scheme: "kora", targetOrigin: new URL("http://127.0.0.1:1/") })),
      );
      if (Exit.isSuccess(exit)) throw new Error("expected a defect");
      const failure = Cause.squash(exit.cause) as NativeProtocol.NativeProtocolUnregistrationError;
      assert.instanceOf(failure, NativeProtocol.NativeProtocolUnregistrationError);
      assert.deepInclude(failure, { scheme: "kora", cause: boom });
      assert.equal(failure.message, 'Failed to unregister Electron protocol scheme "kora".');
    }).pipe(Effect.provide(live)),
  );
});

describe("content security policy", () => {
  it("dev: inline script for Vite's preamble; the network limited to loopback", () => {
    const csp = directives(
      NativeProtocol.makeShellContentSecurityPolicy({
        scheme: "kora",
        targetOrigin: new URL("http://127.0.0.1:4000/"),
      }),
    );
    assert.deepEqual(csp.get("script-src"), ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]);
    // The renderer holds a bearer token: it may talk to this machine only.
    assert.sameMembers(csp.get("connect-src") ?? [], [
      "'self'",
      "http://127.0.0.1:*",
      "ws://127.0.0.1:*",
      "http://localhost:*",
      "ws://localhost:*",
      "http://[::1]:*",
      "ws://[::1]:*",
    ]);
    assert.sameMembers(csp.get("img-src") ?? [], [
      "'self'",
      "kora:",
      "blob:",
      "data:",
      "http:",
      "https:",
    ]);
    assert.sameMembers(csp.get("media-src") ?? [], ["'self'", "kora:", "blob:", "http:", "https:"]);
    assert.sameMembers(csp.get("frame-src") ?? [], [
      "'self'",
      "blob:",
      "http:",
      "https:",
      "kora-preview:",
    ]);
    assert.sameMembers(csp.get("font-src") ?? [], ["'self'", "kora:", "data:"]);
    assert.deepEqual(
      ["object-src", "base-uri", "frame-ancestors"].map((d) => csp.get(d)),
      [["'none'"], ["'self'"], ["'self'"]],
    );
  });

  it("packaged: no inline script at all", () => {
    const csp = directives(
      NativeProtocol.makeShellContentSecurityPolicy({
        scheme: "kora",
        assetDirectory: "/Applications/Kora.app/Contents/Resources/web",
      }),
    );
    assert.deepEqual(csp.get("script-src"), ["'self'", "'wasm-unsafe-eval'"]);
  });
});
