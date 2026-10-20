import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const os = vi.hoisted(() => ({ openExternal: vi.fn(), writeText: vi.fn() }));
vi.mock("electron", () => ({
  shell: { openExternal: os.openExternal },
  clipboard: { writeText: os.writeText },
}));

import * as NativeShell from "./NativeShell.ts";

const withShell = <A, E>(body: (s: NativeShell.NativeShell["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(NativeShell.NativeShell, body).pipe(Effect.provide(NativeShell.layer));

beforeEach(() => {
  os.openExternal.mockReset().mockResolvedValue(undefined);
  os.writeText.mockReset().mockResolvedValue(undefined);
});

describe("links handed to the OS", () => {
  const handedOver = [
    "https://kora.example/docs?x=1",
    "http://localhost:5173/",
    "vscode://vscode-remote/ssh-remote+build-box/srv/app",
    "zed://ssh/build-box/srv/app",
    "zed://ssh/build-box/",
  ];
  const refused = [
    ["a local file", "file:///etc/hosts"],
    ["an arbitrary app handler", "vscode://ms-python.python/run?cmd=x"],
    ["a zed link of the wrong shape", "zed://extension/someone"],
    ["a vscode link with zed's shape", "vscode://ssh/build-box/srv/app"],
    ["a user in a vscode remote link", "vscode://me@vscode-remote/ssh-remote+build-box/srv"],
    ["a password in a vscode remote link", "vscode://:pw@vscode-remote/ssh-remote+build-box/srv"],
    ["a user in a zed host", "zed://ssh/me@build-box/srv"],
    ["a vscode remote link with no host", "vscode://vscode-remote/ssh-remote+"],
    ["not a URL", "build-box:/srv"],
  ] as const;

  it.effect("web pages and well-formed remote-editor links are opened", () =>
    withShell((s) =>
      Effect.gen(function* () {
        const results = yield* Effect.forEach(handedOver, (u) => s.openExternal(u));
        assert.deepEqual(
          results,
          handedOver.map(() => true),
        );
        assert.deepEqual(
          os.openExternal.mock.calls.map(([u]) => u),
          handedOver,
        );
      }),
    ),
  );

  it.effect.each(refused)("refuses %s without asking the OS", ([, link]) =>
    withShell((s) =>
      Effect.gen(function* () {
        assert.isFalse(yield* s.openExternal(link));
        assert.lengthOf(os.openExternal.mock.calls, 0);
      }),
    ),
  );

  it.effect("anything that is not a string is refused", () =>
    withShell((s) =>
      Effect.map(s.openExternal({ href: "https://x.dev" }), (r) => assert.isFalse(r)),
    ),
  );

  it.effect("a link the OS rejects reports false instead of failing", () =>
    withShell((s) =>
      Effect.gen(function* () {
        os.openExternal.mockRejectedValueOnce(new Error("no handler"));
        assert.isFalse(yield* s.openExternal("https://kora.example/"));
      }),
    ),
  );
});

describe("clipboard", () => {
  it.effect("copies text, and a refused write is swallowed", () =>
    withShell((s) =>
      Effect.gen(function* () {
        yield* s.copyText("kora ext list");
        os.writeText.mockRejectedValueOnce(new Error("clipboard locked"));
        yield* s.copyText("second");
        assert.deepEqual(os.writeText.mock.calls, [["kora ext list"], ["second"]]);
      }),
    ),
  );
});
