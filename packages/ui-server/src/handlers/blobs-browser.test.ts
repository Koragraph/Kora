// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off -- a plain node:test harness driving a real listener from outside.
// The live route of the blob browser: message validation, the session core against a fake host (single controller,
// backpressure, input order, approvals, hand-back), and the real route behind the same node-level auth guard the
// daemon uses (`makeLocalAuth`): no secret / foreign Origin refused, unknown blob 404, JPEG frames out, input in.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as NodeHttp from "node:http";
import * as net from "node:net";
import crypto from "node:crypto";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import { makeLocalAuth } from "../localAuth.ts";
import {
  attachLiveSession,
  blobBrowserLiveRoute,
  browserClose,
  browserEngineSnapshot,
  browserStartInstall,
  browserHandBack,
  browserStatus,
  HIGH_WATER_BYTES,
  LIVE_PATH_RE,
  MAX_VIEWERS,
  parseClientMessage,
  type LiveBrowserHost,
  type LiveBrowserSource,
  type LiveInput,
  type LiveSocket,
} from "./blobs-browser.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
};

// ------------------------------------------------------------------ a fake blob browser host

class FakeHost extends EventEmitter implements LiveBrowserHost {
  controller: "agent" | "user" = "agent";
  running = true;
  viewers = 0;
  inputs: LiveInput[] = [];
  keyframes = 0;
  handBacks = 0;
  answered: Array<[string, boolean]> = [];
  pending: Array<{ id: string; summary: string; url: string }> = [];
  inputDelayMs = 0;
  status() {
    return {
      running: this.running,
      controller: this.controller,
      tabs: [{ index: 0, title: "Rialto", url: "http://x/cinema", active: true }],
      viewers: this.viewers,
      pendingApprovals: this.pending,
      working: false,
      tool: null,
    };
  }
  controlState() {
    return { controller: this.controller, idleMs: 0, releaseAfterMs: 8000 };
  }
  addViewer() {
    this.viewers++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.viewers--;
    };
  }
  async userInput(msg: LiveInput) {
    if (this.inputDelayMs) await sleep(this.inputDelayMs);
    // the real host: hover alone never takes over, anything else does
    if (
      !(
        msg.t === "mouse" &&
        msg.type === "mouseMoved" &&
        !msg.buttons &&
        this.controller !== "user"
      )
    ) {
      if (this.controller !== "user") {
        this.controller = "user";
        this.emit("control", this.controlState());
      }
      this.inputs.push(msg);
    }
  }
  handBack() {
    this.handBacks++;
    if (this.controller === "user") {
      this.controller = "agent";
      this.emit("control", this.controlState());
    }
  }
  async keyframe() {
    this.keyframes++;
  }
  answerApproval(id: string, allow: boolean) {
    const ok = this.pending.some((p) => p.id === id);
    if (ok) this.answered.push([id, allow]);
    return ok;
  }
}

const makeSource = (
  hosts: Record<string, FakeHost>,
  over: Partial<LiveBrowserSource> = {},
): LiveBrowserSource & { closed: string[]; installs: number } => {
  const closed: string[] = [];
  let installs = 0;
  return {
    get: (id) => hosts[id],
    engine: {
      status: async () => ({
        supported: true,
        installed: true,
        version: "155.0.8059.39",
        downloadBytes: 102_429_510,
      }),
      install: async (onProgress) => {
        installs++;
        onProgress?.({ phase: "download", received: 50, total: 100, fraction: 0.5 });
        await sleep(5);
      },
    },
    close: async (id) => {
      closed.push(id);
    },
    ...over,
    closed,
    get installs() {
      return installs;
    },
  };
};

class FakeSocket implements LiveSocket {
  texts: Array<Record<string, unknown>> = [];
  frames: Uint8Array[] = [];
  buffered = 0;
  closedWith: [number | undefined, string | undefined] | null = null;
  sendText(t: string) {
    this.texts.push(JSON.parse(t));
  }
  sendBinary(b: Uint8Array) {
    this.frames.push(b);
  }
  bufferedAmount() {
    return this.buffered;
  }
  close(code?: number, reason?: string) {
    this.closedWith = [code, reason];
  }
  last(t: string) {
    return [...this.texts].reverse().find((m) => m.t === t);
  }
}

const mouse = (
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  x = 10,
  y = 10,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    t: "mouse",
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : "left",
    clickCount: 1,
    ...extra,
  });

// ------------------------------------------------------------------ message validation

test("client messages are validated: garbage, oversize and out-of-range values are dropped", () => {
  assert.deepEqual(parseClientMessage(mouse("mousePressed", 100.5, 200)), {
    t: "mouse",
    type: "mousePressed",
    x: 100.5,
    y: 200,
    button: "left",
    clickCount: 1,
  });
  for (const bad of [
    "not json",
    "[]",
    "null",
    '{"t":"nope"}',
    '{"t":"mouse","type":"mouseMoved","x":"1","y":2}',
    '{"t":"mouse","type":"explode","x":1,"y":2}',
    '{"t":"mouse","type":"mouseMoved","x":1e9,"y":2}',
    '{"t":"mouse","type":"mousePressed","x":1,"y":2,"button":"thumb"}',
    '{"t":"mouse","type":"mousePressed","x":1,"y":2,"clickCount":99}',
    '{"t":"key","type":"keyDown","key":""}',
    '{"t":"key","type":"keyDown","key":"' + "a".repeat(40) + '"}',
    '{"t":"key","type":"hover","key":"a"}',
    '{"t":"text","text":""}',
    '{"t":"approve","id":"","allow":true}',
    '{"t":"approve","id":"a","allow":"yes"}',
    '{"t":"ping","ts":"x"}',
    "x".repeat(200_000),
  ])
    assert.equal(parseClientMessage(bad), null, bad.slice(0, 60));
  assert.deepEqual(parseClientMessage('{"t":"release"}'), { t: "release" });
  assert.deepEqual(parseClientMessage('{"t":"approve","id":"ab12","allow":false}'), {
    t: "approve",
    id: "ab12",
    allow: false,
  });
  assert.deepEqual(
    parseClientMessage(
      '{"t":"key","type":"keyDown","key":"a","code":"KeyA","text":"a","vk":65,"modifiers":8}',
    ),
    { t: "key", type: "keyDown", key: "a", code: "KeyA", text: "a", vk: 65, modifiers: 8 },
  );
  // unknown extra fields never survive (nothing the client invents reaches CDP)
  assert.equal(
    "evil" in (parseClientMessage('{"t":"text","text":"hi","evil":1}') as object),
    false,
  );
});

test("the ticket path matches only /blob-browser/<id>/live", () => {
  assert.ok(LIVE_PATH_RE.test("/blob-browser/blob_01H/live"));
  for (const p of [
    "/blob-browser//live",
    "/blob-browser/a/b/live",
    "/blob-browser/a/live/",
    "/blob-browser/../ws/live",
    "/ws",
    "/blob-browser/a%2F/live",
  ])
    assert.ok(!LIVE_PATH_RE.test(p), p);
});

// ------------------------------------------------------------------ session core

test("session: hello with state + engine, frames out, keyframe on connect, viewer counted and released", async () => {
  const host = new FakeHost();
  const sock = new FakeSocket();
  const src = makeSource({ b1: host });
  const s = attachLiveSession(src, "b1", host, sock)!;
  assert.ok(s);
  assert.equal(host.viewers, 1);
  const hello = sock.last("hello")!;
  assert.equal(hello.running, true);
  assert.equal(hello.controller, "agent");
  assert.deepEqual(hello.viewport, { width: 1280, height: 800 });
  assert.equal((hello.tabs as unknown[]).length, 1);
  await until(() => !!sock.last("engine"));
  assert.equal(sock.last("engine")!.installed, true);
  assert.equal(host.keyframes, 1);
  host.emit("frame", Buffer.from([0xff, 0xd8, 1, 2, 3]), {});
  assert.equal(sock.frames.length, 1);
  assert.deepEqual([...sock.frames[0]!], [0xff, 0xd8, 1, 2, 3]);
  s.dispose();
  assert.equal(host.viewers, 0);
  host.emit("frame", Buffer.from([1]), {});
  assert.equal(sock.frames.length, 1, "no frames after dispose");
  assert.equal(host.listenerCount("frame"), 0, "listeners removed");
});

test("session: input is forwarded in order, hover alone never takes over, pointer moves coalesce", async () => {
  const host = new FakeHost();
  host.inputDelayMs = 15;
  const sock = new FakeSocket();
  const s = attachLiveSession(makeSource({ b: host }), "b", host, sock)!;
  // hover while the agent drives: ignored
  s.onMessage(mouse("mouseMoved", 1, 1));
  await sleep(40);
  assert.equal(host.controller, "agent");
  assert.equal(host.inputs.length, 0);
  assert.equal(s.stats().inputIgnored, 1);
  // press / release / key / text arrive in order and flip control
  s.onMessage(mouse("mousePressed", 5, 6, { buttons: 1 }));
  s.onMessage(mouse("mouseMoved", 6, 7, { buttons: 1 }));
  s.onMessage(mouse("mouseMoved", 7, 8, { buttons: 1 }));
  s.onMessage(mouse("mouseMoved", 8, 9, { buttons: 1 }));
  s.onMessage(mouse("mouseReleased", 8, 9));
  s.onMessage(JSON.stringify({ t: "key", type: "keyDown", key: "a", text: "a", vk: 65 }));
  s.onMessage(JSON.stringify({ t: "text", text: "pasted" }));
  await until(() => host.inputs.at(-1)?.t === "text");
  assert.equal(host.controller, "user");
  const kinds = host.inputs.map((i) => (i.t === "mouse" ? i.type : i.t));
  assert.equal(kinds[0], "mousePressed");
  assert.ok(
    kinds.indexOf("mouseReleased") > kinds.lastIndexOf("mouseMoved"),
    "release stays after the moves",
  );
  assert.ok(
    kinds.filter((k) => k === "mouseMoved").length <= 2,
    "three queued moves collapsed: " + kinds.join(","),
  );
  assert.deepEqual(kinds.slice(-2), ["key", "text"]);
  assert.equal(s.isController, true);
  // the state now says you control
  await until(() =>
    sock.texts.some((m) => m.t === "state" && m.controller === "user" && m.youControl === true),
  );
  // "Hand back"
  s.onMessage('{"t":"release"}');
  assert.equal(host.controller, "agent");
  s.dispose();
});

test("session: one controller at a time; the other window watches, is told once, and can take over after hand-back", async () => {
  const host = new FakeHost();
  const src = makeSource({ b: host });
  const a = new FakeSocket();
  const b = new FakeSocket();
  const sa = attachLiveSession(src, "b", host, a)!;
  const sb = attachLiveSession(src, "b", host, b)!;
  assert.equal(host.viewers, 2);
  sa.onMessage(mouse("mousePressed", 1, 1, { buttons: 1 }));
  await until(() => host.inputs.length === 1);
  assert.equal(sa.isController, true);
  // B tries to drive: ignored, busy notice (rate limited), nothing reaches the browser
  sb.onMessage(mouse("mousePressed", 2, 2, { buttons: 1 }));
  sb.onMessage(JSON.stringify({ t: "key", type: "keyDown", key: "x" }));
  sb.onMessage(JSON.stringify({ t: "text", text: "intruder" }));
  await sleep(40);
  assert.equal(host.inputs.length, 1);
  assert.equal(sb.stats().inputIgnored, 3);
  assert.equal(b.texts.filter((m) => m.t === "busy").length, 1, "one notice, not three");
  assert.equal(sb.isController, false);
  // B still receives frames and state: watching works
  host.emit("frame", Buffer.from([9, 9]), {});
  assert.equal(a.frames.length, 1);
  assert.equal(b.frames.length, 1);
  // B can approve (any window can answer) but cannot release someone else's control
  sb.onMessage('{"t":"release"}');
  assert.equal(host.controller, "user", "B's release does not take A's control away");
  // A hands back; B may drive now
  sa.onMessage('{"t":"release"}');
  assert.equal(host.controller, "agent");
  sb.onMessage(mouse("mousePressed", 3, 3, { buttons: 1 }));
  await until(() => host.inputs.length === 2);
  assert.equal(sb.isController, true);
  assert.equal(sa.isController, false);
  // the controller's window closes: the agent gets the browser back
  sb.dispose();
  assert.equal(host.controller, "agent");
  sa.dispose();
  assert.equal(host.viewers, 0);
});

test("session: backpressure drops frames while the socket buffer is high, then sends a keyframe once it drains", async () => {
  const host = new FakeHost();
  const sock = new FakeSocket();
  const s = attachLiveSession(makeSource({ b: host }), "b", host, sock)!;
  const base = host.keyframes;
  host.emit("frame", Buffer.alloc(50_000, 1), {});
  assert.equal(sock.frames.length, 1);
  sock.buffered = HIGH_WATER_BYTES + 1; // the client stopped reading
  for (let i = 0; i < 25; i++) host.emit("frame", Buffer.alloc(50_000, 2), {});
  assert.equal(sock.frames.length, 1, "no frame queued behind a full buffer");
  assert.equal(s.stats().framesDropped, 25);
  assert.equal(host.keyframes, base, "no keyframe while still backed up");
  sock.buffered = 10_000; // drained
  await until(() => host.keyframes > base, 1500);
  assert.equal(host.keyframes, base + 1, "exactly one fresh keyframe after the drain");
  host.emit("frame", Buffer.alloc(100, 3), {});
  assert.equal(sock.frames.length, 2, "frames flow again");
  s.dispose();
});

test("session: approvals are answered from the panel; a stale answer is reported, not applied", () => {
  const host = new FakeHost();
  host.pending = [{ id: "ab12", summary: "Place order on cinema.example", url: "http://x" }];
  const sock = new FakeSocket();
  const s = attachLiveSession(makeSource({ b: host }), "b", host, sock)!;
  assert.deepEqual(sock.last("hello")!.approvals, [
    { id: "ab12", summary: "Place order on cinema.example", url: "http://x" },
  ]);
  s.onMessage('{"t":"approve","id":"ab12","allow":false}');
  assert.deepEqual(host.answered, [["ab12", false]]);
  s.onMessage('{"t":"approve","id":"zzzz","allow":true}');
  assert.equal(host.answered.length, 1);
  assert.equal(sock.last("approval-gone")!.id, "zzzz");
  s.dispose();
});

test("session: ping, close request, too many viewers, idle timeout", async () => {
  const host = new FakeHost();
  const src = makeSource({ b: host });
  const sock = new FakeSocket();
  const s = attachLiveSession(src, "b", host, sock, { idleTimeoutMs: 120 })!;
  s.onMessage('{"t":"ping","ts":1234}');
  assert.equal(sock.last("pong")!.ts, 1234);
  s.onMessage('{"t":"close"}');
  await sleep(5);
  assert.deepEqual(src.closed, ["b"]);
  await until(() => sock.closedWith !== null, 1500);
  assert.equal(sock.closedWith![0], 1001, "a silent client is dropped");
  assert.equal(host.viewers, 0);
  // viewer cap
  const socks: FakeSocket[] = [];
  const sessions = [];
  for (let i = 0; i < MAX_VIEWERS; i++) {
    socks.push(new FakeSocket());
    sessions.push(attachLiveSession(src, "b", host, socks[i]!)!);
  }
  const extra = new FakeSocket();
  assert.equal(attachLiveSession(src, "b", host, extra), null);
  assert.equal(extra.last("error")!.code, "too_many_viewers");
  assert.equal(extra.closedWith![0], 1013);
  sessions.forEach((x) => x.dispose());
});

test("session: engine install is shared and progress reaches every open panel", async () => {
  const host = new FakeHost();
  const src = makeSource({ b: host });
  const a = new FakeSocket();
  const b = new FakeSocket();
  const sa = attachLiveSession(src, "b", host, a)!;
  const sb = attachLiveSession(src, "b", host, b)!;
  sa.onMessage('{"t":"install"}');
  sb.onMessage('{"t":"install"}');
  await until(() => !!a.texts.find((m) => m.t === "install" && m.state === "done"));
  assert.equal(src.installs, 1, "one install for two panels");
  for (const s of [a, b]) {
    const phases = s.texts.filter((m) => m.t === "install").map((m) => `${m.phase}:${m.state}`);
    assert.ok(phases.includes("download:running"), phases.join(","));
    assert.ok(phases.includes("done:done"), phases.join(","));
  }
  // a failing install reports a one-line reason and can be retried
  const failing = makeSource(
    { b: host },
    {
      engine: {
        status: async () => ({
          supported: true,
          installed: false,
          version: null,
          downloadBytes: 1,
        }),
        install: async () => {
          throw new Error("engine download failed: HTTP 503\nstack...");
        },
      },
    },
  );
  const c = new FakeSocket();
  const sc = attachLiveSession(failing, "b", host, c)!;
  sc.onMessage('{"t":"install"}');
  await until(() => !!c.texts.find((m) => m.t === "install" && m.state === "error"));
  assert.equal(c.last("install")!.message, "engine download failed: HTTP 503");
  sa.dispose();
  sb.dispose();
  sc.dispose();
});

test("RPC helpers: status / hand back / close refuse unknown or malformed blob ids", async () => {
  const host = new FakeHost();
  const src = makeSource({ b1: host });
  assert.equal((await browserStatus(src, "b1"))!.running, true);
  assert.equal(await browserStatus(src, "nope"), null);
  assert.equal(await browserStatus(src, "../etc"), null);
  host.controller = "user";
  assert.equal(browserHandBack(src, "b1"), true);
  assert.equal(host.controller, "agent");
  assert.equal(browserHandBack(src, "x"), false);
  assert.equal(await browserClose(src, "b1"), true);
  assert.deepEqual(src.closed, ["b1"]);
  assert.equal(await browserClose(src, "x"), false);
});

// ------------------------------------------------------------------ the real route behind the daemon's auth guard

const TOKEN = "t".repeat(40);
let port = 0;
let stop: (() => Promise<void>) | null = null;
let httpServer: NodeHttp.Server | null = null;
const host1 = new FakeHost();
const source = makeSource({ blob_one: host1 });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

test.before(async () => {
  port = await freePort();
  const auth = makeLocalAuth({ token: TOKEN, port });
  // the same guard `serveUi` puts in front of every request and upgrade (server.ts guardedDaemon)
  const guarded = (): NodeHttp.Server => {
    const server = (httpServer = NodeHttp.createServer());
    const emit = server.emit.bind(server) as (e: string, ...a: unknown[]) => boolean;
    server.emit = ((event: string, ...args: unknown[]) => {
      if (event === "upgrade") {
        const [req, socket] = args as [NodeHttp.IncomingMessage, net.Socket];
        const v = auth.check(req);
        if (!v.ok) {
          socket.end(
            `HTTP/1.1 ${v.status} ${v.status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
          return true;
        }
      }
      return emit(event, ...args);
    }) as typeof server.emit;
    return server;
  };
  const routes = blobBrowserLiveRoute(() => source);
  const layer = NodeHttpServer.layer(guarded, { host: "127.0.0.1", port });
  const app = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(layer),
  );
  const fiber = Effect.runFork(Layer.launch(app).pipe(Effect.provide(NodeServices.layer)));
  stop = async () => {
    httpServer?.closeAllConnections();
    await Effect.runPromise(Fiber.interrupt(fiber));
  };
  await sleep(300);
});
test.after(async () => {
  await stop?.();
});

function open(
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  ws: WebSocket;
  text: Array<Record<string, unknown>>;
  frames: Uint8Array[];
  status: "open" | "refused";
}> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers } as never);
    ws.binaryType = "arraybuffer";
    const out = {
      ws,
      text: [] as Array<Record<string, unknown>>,
      frames: [] as Uint8Array[],
      status: "refused" as "open" | "refused",
    };
    const timer = setTimeout(() => resolve(out), 4000);
    ws.onopen = () => {
      out.status = "open";
      clearTimeout(timer);
      resolve(out);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(out);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") out.text.push(JSON.parse(e.data));
      else out.frames.push(new Uint8Array(e.data as ArrayBuffer));
    };
  });
}
const AUTH = { "x-kora-ui-token": TOKEN };

test("route: no secret, a wrong secret and a foreign Origin are refused before the upgrade; the right secret is served", async () => {
  assert.equal((await open("/blob-browser/blob_one/live")).status, "refused");
  assert.equal(
    (await open("/blob-browser/blob_one/live", { "x-kora-ui-token": "wrong" })).status,
    "refused",
  );
  assert.equal(
    (await open("/blob-browser/blob_one/live", { ...AUTH, Origin: "https://evil.example" })).status,
    "refused",
  );
  assert.equal(host1.viewers, 0, "refused connections never reached the host");
  const ok = await open("/blob-browser/blob_one/live", { ...AUTH, Origin: "kora://app" });
  assert.equal(ok.status, "open");
  await until(() => ok.text.some((m) => m.t === "hello"));
  assert.equal(host1.viewers, 1);
  ok.ws.close();
  await until(() => host1.viewers === 0);
  assert.equal(host1.viewers, 0, "closing the socket releases the viewer");
});

test("route: an unknown blob is a 404 before any upgrade", async () => {
  assert.equal((await open("/blob-browser/ghost/live", AUTH)).status, "refused");
  const res = await fetch(`http://127.0.0.1:${port}/blob-browser/ghost/live`, { headers: AUTH });
  assert.equal(res.status, 404);
  assert.equal(host1.viewers, 0);
});

test("route: JPEG frames out as binary, JSON in, input reaches the host, one controller at a time", async () => {
  const a = await open("/blob-browser/blob_one/live", AUTH);
  const b = await open("/blob-browser/blob_one/live", AUTH);
  await until(() => a.text.some((m) => m.t === "hello") && b.text.some((m) => m.t === "hello"));
  assert.equal(host1.viewers, 2);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    crypto.randomBytes(3000),
    Buffer.from([0xff, 0xd9]),
  ]);
  host1.emit("frame", jpeg, {});
  await until(() => a.frames.length === 1 && b.frames.length === 1);
  assert.equal(a.frames[0]!.byteLength, jpeg.byteLength);
  assert.deepEqual([...a.frames[0]!.subarray(0, 2)], [0xff, 0xd8]);
  // A drives
  a.ws.send(mouse("mousePressed", 40, 50, { buttons: 1 }));
  a.ws.send(mouse("mouseReleased", 40, 50));
  a.ws.send(
    JSON.stringify({ t: "key", type: "keyDown", key: "Enter", code: "Enter", vk: 13, text: "\r" }),
  );
  await until(() => host1.inputs.length === 3);
  assert.deepEqual(
    host1.inputs.map((i) => i.t),
    ["mouse", "mouse", "key"],
  );
  assert.equal((host1.inputs[0] as { x: number }).x, 40);
  // B cannot while A drives
  b.ws.send(mouse("mousePressed", 1, 1, { buttons: 1 }));
  await until(() => b.text.some((m) => m.t === "busy"));
  assert.equal(host1.inputs.length, 3);
  // ping/pong round trip over the real socket
  a.ws.send('{"t":"ping","ts":42}');
  await until(() => a.text.some((m) => m.t === "pong"));
  // Hand back from A
  a.ws.send('{"t":"release"}');
  await until(() => host1.controller === "agent");
  // malformed input is ignored, the socket survives
  a.ws.send("garbage");
  a.ws.send('{"t":"mouse","type":"mousePressed","x":"NaN","y":1}');
  a.ws.send('{"t":"ping","ts":7}');
  await until(() => a.text.filter((m) => m.t === "pong").length === 2);
  a.ws.close();
  b.ws.close();
  await until(() => host1.viewers === 0);
});

test("route: a client that stops reading is dropped frame-by-frame, not queued; the host and other windows stay fast", async () => {
  // a raw TCP client that completes the handshake and then never reads
  const stuck = net.connect(port, "127.0.0.1");
  await new Promise<void>((r) => stuck.once("connect", () => r()));
  const key = crypto.randomBytes(16).toString("base64");
  stuck.write(
    `GET /blob-browser/blob_one/live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nx-kora-ui-token: ${TOKEN}\r\n\r\n`,
  );
  await until(() => host1.viewers === 1);
  stuck.pause();
  let stuckBytes = 0;
  stuck.on("data", (d) => (stuckBytes += d.length));
  const healthy = await open("/blob-browser/blob_one/live", AUTH);
  await until(() => healthy.text.some((m) => m.t === "hello"));
  let received = 0;
  healthy.ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") received++;
  });
  const frame = Buffer.alloc(200_000, 7);
  const N = 120; // 24 MB offered, paced like a busy page (~100 frames/s)
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    host1.emit("frame", frame, {});
    await sleep(10);
  }
  const emitMs = performance.now() - t0;
  await sleep(300);
  assert.ok(received >= N * 0.8, `the healthy window kept getting frames (${received}/${N})`);
  assert.ok(
    emitMs < N * 10 * 2.5,
    `the host was never stalled by the stuck client (${Math.round(emitMs)} ms for ${N} frames)`,
  );
  // the stuck client's backlog is bounded: after it wakes up it receives far less than was offered
  stuck.resume();
  await sleep(500);
  assert.ok(
    stuckBytes < N * frame.length * 0.8,
    `the stuck client was sent ${(stuckBytes / 1e6).toFixed(1)} MB of ${((N * frame.length) / 1e6).toFixed(0)} MB offered`,
  );
  stuck.destroy();
  healthy.ws.close();
  await until(() => host1.viewers === 0, 4000);
  assert.equal(host1.viewers, 0);
});

test("engine status + install over plain HTTP helpers: no live session needed, progress is readable, errors stay visible, installed wins", async () => {
  let installed = false;
  let release: (() => void) | null = null;
  const src = makeSource(
    {},
    {
      engine: {
        status: async () => ({
          supported: true,
          installed,
          version: installed ? "155" : null,
          downloadBytes: 102_429_510,
        }),
        install: async (onProgress) => {
          onProgress?.({ phase: "download", received: 50, total: 100, fraction: 0.5 });
          await new Promise<void>((r) => (release = r));
          installed = true;
        },
      },
    },
  );
  // before anything: not installed, idle
  let snap = await browserEngineSnapshot(src);
  assert.deepEqual([snap.installed, snap.install.state], [false, "idle"]);
  // start it with NO socket attached; a second start shares the same install
  browserStartInstall(src);
  browserStartInstall(src);
  await until(() => release !== null);
  snap = await browserEngineSnapshot(src);
  assert.equal(snap.install.state, "running");
  assert.equal(snap.install.fraction, 0.5);
  assert.equal(snap.install.received, 50);
  release!();
  await until(() => installed);
  await sleep(20);
  snap = await browserEngineSnapshot(src);
  assert.deepEqual([snap.installed, snap.install.state, snap.install.fraction], [true, "done", 1]);
  // a failed install keeps its one-line reason until the next try
  const failing = makeSource(
    {},
    {
      engine: {
        status: async () => ({
          supported: true,
          installed: false,
          version: null,
          downloadBytes: 1,
        }),
        install: async () => {
          throw new Error("engine download failed: HTTP 503\nat x");
        },
      },
    },
  );
  browserStartInstall(failing);
  await sleep(30);
  const failed = await browserEngineSnapshot(failing);
  assert.deepEqual(
    [failed.install.state, failed.install.message],
    ["error", "engine download failed: HTTP 503"],
  );
});
