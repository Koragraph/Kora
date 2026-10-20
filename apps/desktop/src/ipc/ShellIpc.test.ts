import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as ShellIpc from "./ShellIpc.ts";

/**
 * An ipcMain that keeps what was registered, so a test can call it like Electron would. `failOn` makes one
 * ipcMain call throw: its name, and which call of it (1 = the first).
 */
function fakeIpcMain(failOn?: { call: keyof ShellIpc.ShellIpcMain; nth: number; error: Error }) {
  const invoke = new Map<string, ShellIpc.ShellIpcHandleListener>();
  const sync = new Map<string, ShellIpc.ShellIpcSyncListener>();
  const seen = new Map<string, number>();
  const step = (call: keyof ShellIpc.ShellIpcMain) => {
    const n = (seen.get(call) ?? 0) + 1;
    seen.set(call, n);
    if (failOn?.call === call && failOn.nth === n) throw failOn.error;
  };
  const main: ShellIpc.ShellIpcMain = {
    handle: (channel, fn) => (step("handle"), void invoke.set(channel, fn)),
    removeHandler: (channel) => (step("removeHandler"), void invoke.delete(channel)),
    on: (channel, fn) => (step("on"), void sync.set(channel, fn)),
    removeAllListeners: (channel) => (step("removeAllListeners"), void sync.delete(channel)),
  };
  return { main, invoke, sync };
}

const appFrame = { url: "kora://app/" };
const strangerFrame = { url: "https://evil.example/" };

describe("registering handlers", () => {
  it.effect("an invoke handler gets the sender's event along with the payload", () =>
    Effect.gen(function* () {
      const ipc = fakeIpcMain();
      const events: unknown[] = [];
      yield* ShellIpc.make(ipc.main).handle({
        channel: "t.echo",
        handler: (_payload, event) => Effect.sync(() => void events.push(event)),
      });
      const event = { sender: { id: 3 } };
      yield* Effect.promise(async () => ipc.invoke.get("t.echo")!(event, "hi"));
      assert.deepEqual(events, [event]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a failed registration names the kind of handler and the channel, keeping the cause apart",
    () =>
      Effect.gen(function* () {
        const boom = new Error("ipcMain said no");
        const ipc = ShellIpc.make(fakeIpcMain({ call: "handle", nth: 1, error: boom }).main);
        const failure = yield* Effect.flip(
          ipc.handle({ channel: "t.refused", handler: () => Effect.void }).pipe(Effect.scoped),
        );
        assert.instanceOf(failure, ShellIpc.ShellIpcRegistrationError);
        assert.deepInclude(failure, { handlerKind: "invoke", channel: "t.refused", cause: boom });
        assert.match(failure.message, /invoke.*t\.refused/);
        assert.notInclude(failure.message, boom.message);
      }),
  );

  it.effect("a failed removal at scope close is a defect that says which handler it was", () =>
    Effect.gen(function* () {
      const boom = new Error("could not remove");
      // removeAllListeners runs once before registering (to clear a stale one) and once at close.
      const ipc = ShellIpc.make(
        fakeIpcMain({ call: "removeAllListeners", nth: 2, error: boom }).main,
      );
      const exit = yield* Effect.exit(
        ipc.handleSync({ channel: "t.sync", handler: () => Effect.void }).pipe(Effect.scoped),
      );
      assert.isTrue(Exit.isFailure(exit));
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      assert.instanceOf(defect, ShellIpc.ShellIpcUnregistrationError);
      assert.deepInclude(defect, { handlerKind: "sync", channel: "t.sync", cause: boom });
      assert.notInclude(defect.message, boom.message);
    }),
  );
});

describe("who may call (isShellAppFrame)", () => {
  const top = (url: string, type = "window") => ({
    sender: { getType: () => type },
    senderFrame: { url, parent: null },
  });

  it.each(["kora://app/", "kora-dev://app/settings?x=1"])(
    "the app's own top frame at %s",
    (url) => {
      assert.isTrue(ShellIpc.isShellAppFrame(top(url)));
    },
  );

  it.each([
    "https://evil.example/",
    "http://localhost:5173/",
    "kora://evil/",
    "kora://user:pass@app/",
    "blob:kora://app/123",
    "file:///etc/passwd",
    "about:blank",
    "not a url",
  ])("not a frame at %s", (url) => {
    assert.isFalse(ShellIpc.isShellAppFrame(top(url)));
  });

  it("not a frame inside the app, a preview guest on the app's URL, a missing or disposed frame", () => {
    const disposed = {
      get url(): string {
        throw new Error("Render frame was disposed");
      },
    };
    for (const evt of [
      {
        sender: { getType: () => "window" },
        senderFrame: { url: "kora://app/", parent: appFrame },
      },
      top("kora://app/", "webview"),
      { senderFrame: null },
      {},
      { senderFrame: disposed },
    ]) {
      assert.isFalse(ShellIpc.isShellAppFrame(evt));
    }
  });

  it.effect("a stranger's call is refused before the handler runs, for invoke and sync alike", () =>
    Effect.gen(function* () {
      const ipc = fakeIpcMain();
      const shell = ShellIpc.make(ipc.main, ShellIpc.isShellAppFrame);
      let ran = 0;
      const count = () => Effect.sync(() => void ran++);
      yield* shell.handle({ channel: "t.inv", handler: count });
      yield* shell.handleSync({ channel: "t.sync", handler: count });

      const answer = yield* Effect.promise(() =>
        Promise.resolve()
          .then(() =>
            ipc.invoke.get("t.inv")!({ sender: { id: 9 }, senderFrame: strangerFrame }, null),
          )
          .then(
            () => "answered",
            (e: Error) => e.message,
          ),
      );
      assert.include(answer, "untrusted sender");
      const syncEvent: ShellIpc.ShellIpcSyncEvent = {
        returnValue: "unset",
        senderFrame: strangerFrame,
      };
      ipc.sync.get("t.sync")!(syncEvent);
      assert.isNull(syncEvent.returnValue);
      assert.equal(ran, 0);

      yield* Effect.promise(async () =>
        ipc.invoke.get("t.inv")!({ sender: { id: 1 }, senderFrame: appFrame }, null),
      );
      assert.equal(ran, 1);
    }).pipe(Effect.scoped),
  );
});
