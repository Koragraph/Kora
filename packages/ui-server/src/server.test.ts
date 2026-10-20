// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off -- a plain node:test harness driving a real listener from outside.
// The UI API is served on loopback, but loopback is not a trust boundary: every web page the user opens can
// dial ws://127.0.0.1:<port>/ws (browsers never preflight a WebSocket upgrade) and send simple cross-origin
// requests. These tests drive a real `serveUi` listener the way a hostile page would, and the way the desktop does.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { serveUi, type UiServerHandle } from "./server.ts";

const EVIL = "https://evil.example";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Open `/ws` with the given headers and call the `server.probe` RPC. "called" = the RPC answered. */
function tryRpc(url: string, headers: Record<string, string>): Promise<"called" | "refused"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers } as never);
    let settled = false;
    const done = (v: "called" | "refused") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* closed */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done("refused"), 4000);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({ _tag: "Request", id: "1", tag: "daemon.probe", payload: {}, headers: [] }),
      );
    ws.onmessage = (e) => {
      if (String(e.data).includes('"requestId":"1"')) done("called");
    };
    ws.onerror = () => done("refused");
    ws.onclose = () => done("refused");
  });
}

let ui: UiServerHandle;
let port: number;
let home: string;
let token: string;
const base = () => `http://127.0.0.1:${port}`;

test.before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kora-ui-sec-"));
  port = await freePort();
  ui = await serveUi({ host: "127.0.0.1", port, koraHome: home });
  const file = path.join(home, "ui-token");
  token = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
});

test.after(async () => {
  await ui?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("a WebSocket from a foreign web origin cannot reach the RPC server", async () => {
  assert.equal(await tryRpc(`ws://127.0.0.1:${port}/ws`, { Origin: EVIL }), "refused");
});

test("a WebSocket without the daemon secret is refused, even from the app origin", async () => {
  assert.equal(await tryRpc(`ws://127.0.0.1:${port}/ws`, { Origin: "kora://app" }), "refused");
});

test("the secret file is private to the user", () => {
  const st = fs.statSync(path.join(home, "ui-token"));
  if (process.platform !== "win32") assert.equal(st.mode & 0o777, 0o600); // Windows: no mode bits (the profile's ACL)
  assert.ok(token.length >= 32);
});

test("the desktop path works: token exchange -> ws ticket -> /ws RPC", async () => {
  const exchange = await fetch(`${base()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: token,
      subject_token_type: "x",
    }).toString(),
  });
  assert.equal(exchange.status, 200);
  const { access_token } = (await exchange.json()) as { access_token: string };
  const issued = await fetch(`${base()}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}`, origin: "kora://app" },
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("access-control-allow-origin"), "kora://app");
  const { ticket } = (await issued.json()) as { ticket: string };
  const url = `ws://127.0.0.1:${port}/ws?wsTicket=${encodeURIComponent(ticket)}`;
  assert.equal(await tryRpc(url, { Origin: "kora://app" }), "called");
  // Tickets are single-use.
  assert.equal(await tryRpc(url, { Origin: "kora://app" }), "refused");
});

test("the token header also opens /ws (dev proxy / CLI tools); a foreign origin still cannot", async () => {
  assert.equal(await tryRpc(`ws://127.0.0.1:${port}/ws`, { "x-kora-ui-token": token }), "called");
  assert.equal(
    await tryRpc(`ws://127.0.0.1:${port}/ws`, { "x-kora-ui-token": token, Origin: EVIL }),
    "refused",
  );
});

test("a legacy desktop credential gets a clear 401, not a session", async () => {
  const r = await fetch(`${base()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ subject_token: "kora-desktop" }).toString(),
  });
  assert.equal(r.status, 401);
  const body = (await r.json()) as { _tag: string; code: string };
  assert.equal(body._tag, "HostAuthInvalidError");
  assert.equal(body.code, "auth_invalid");
});

test("/api/* needs the secret and never answers a foreign origin", async () => {
  const anon = await fetch(`${base()}/api/auth/session`);
  assert.equal(anon.status, 401);
  const evil = await fetch(`${base()}/api/auth/session`, {
    headers: { authorization: `Bearer ${token}`, origin: EVIL },
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const ok = await fetch(`${base()}/api/auth/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.headers.get("access-control-allow-origin"), "*");
});

test("DNS rebinding: a foreign Host header is refused", async () => {
  const r = await new Promise<number>((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `GET /.well-known/kora/host HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    let buf = "";
    sock.on("data", (d) => (buf += d.toString()));
    sock.on("end", () => resolve(Number(buf.split(" ")[1])));
    sock.on("error", reject);
  });
  assert.equal(r, 403);
  const ok = await fetch(`http://localhost:${port}/.well-known/kora/host`);
  assert.equal(ok.status, 200);
});

test("CORS preflight from the app origin still succeeds", async () => {
  const r = await fetch(`${base()}/api/auth/websocket-ticket`, {
    method: "OPTIONS",
    headers: {
      origin: "kora://app",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization",
    },
  });
  assert.ok(r.status < 300, `preflight status ${r.status}`);
  assert.equal(r.headers.get("access-control-allow-origin"), "kora://app");
});

// B6 (night 2026-10-04): with the UI port held by another program the server said "listening", then died on
// EADDRINUSE; the daemon logged "chat UI server on :8820" and status reported it while nothing of Kora answered.
test("serveUi refuses a port another program holds, with a plain reason", async () => {
  const { portFree } = await import("./server.ts");
  const other = net.createServer((sock) => sock.end("not kora"));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  const port = (other.address() as { port: number }).port;
  try {
    await assert.rejects(portFree("127.0.0.1", port), /already in use by another program/);
    await assert.rejects(serveUi({ host: "127.0.0.1", port }), /already in use/);
  } finally {
    await new Promise<void>((r) => other.close(() => r()));
  }
  await portFree("127.0.0.1", port);
});

/**
 * One raw HTTP exchange (exact request target, no client-side normalization); resolves the status line's code, or
 * 0 when the server dropped the connection without one (it stopped reading an oversized body).
 */
function rawStatus(text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(text));
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`no answer to ${text.split("\r\n")[0]}`));
    }, 5000);
    const settle = () => {
      clearTimeout(timer);
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      resolve(m ? Number(m[1]) : 0);
    };
    sock.on("data", (d) => {
      buf += d.toString();
      if (/^HTTP\/1\.1 \d{3}/.test(buf)) {
        sock.destroy();
        settle();
      }
    });
    sock.on("error", settle);
    sock.on("close", settle);
  });
}

// Security sweep 2026-10-04: the guard's credential-free check normalized `%2e%2e` segments, the router did not —
// this request reached the attachment route without the secret (its own id check was all that stopped it).
test("a dot-segment target the router dispatches to a protected route still needs the secret", async () => {
  for (const target of ["/api/attachments/%2e%2e/%2e%2e", "/api/attachments/../.."]) {
    const status = await rawStatus(
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(status, 401, target);
  }
});

test("an OPTIONS websocket upgrade without the secret is refused", async () => {
  const status = await rawStatus(
    `OPTIONS /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
  );
  assert.equal(status, 401);
});

test("/oauth/token (reachable before auth) refuses an oversized body instead of buffering it", async () => {
  const { MAX_HTTP_BODY_BYTES } = await import("./server.ts");
  // Declared length: refused before a byte is read.
  const declared = await rawStatus(
    `POST /oauth/token HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${MAX_HTTP_BODY_BYTES * 64}\r\n\r\nsubject_token=`,
  );
  assert.equal(declared, 413);
  // Chunked (no declared length): reading stops at the cap — the daemon drops the connection (or answers 401) even
  // though the body carries the real secret first; it never buffers past the cap or hands out a session for it.
  const pad = "a".repeat(MAX_HTTP_BODY_BYTES + 1024);
  const body = `subject_token=${token}&pad=${pad}`;
  const chunked = await rawStatus(
    `POST /oauth/token HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      `Content-Type: application/x-www-form-urlencoded\r\nTransfer-Encoding: chunked\r\n\r\n` +
      `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`,
  );
  assert.ok(
    chunked === 0 || chunked === 401 || chunked === 413,
    `chunked over-cap body got ${chunked}`,
  );
  // A normal exchange still works.
  const ok = await fetch(`${base()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ subject_token: token }).toString(),
  });
  assert.equal(ok.status, 200);
});

test("serveUi refuses a non-loopback bind", async () => {
  await assert.rejects(serveUi({ host: "0.0.0.0", port: 0 }), /only listens on loopback/);
  await assert.rejects(serveUi({ host: "", port: 0 }), /only listens on loopback/);
});

test("identity challenge: the daemon proves it holds the secret without anyone sending it", async () => {
  // The client side of the protocol (what the desktop runs before it sends the secret anywhere).
  const { daemonIdentityProof, newIdentityNonce } =
    await import("../../client-runtime/src/auth/identity.ts");
  const nonce = newIdentityNonce();
  const r = await fetch(`${base()}/.well-known/kora/identity?nonce=${nonce}`, {
    headers: { origin: "kora://app" },
  });
  assert.equal(r.status, 200, "public: no credential needed");
  const { v, proof } = (await r.json()) as { v: number; proof: string };
  assert.equal(v, 1);
  assert.equal(proof, await daemonIdentityProof(token, port, nonce), "client and daemon agree");
  assert.notEqual(proof, await daemonIdentityProof("not-the-secret", port, nonce));
  assert.notEqual(proof, await daemonIdentityProof(token, port + 1, nonce), "bound to the port");
  // A short / malformed nonce is refused (no proof for chosen tiny inputs).
  const bad = await fetch(`${base()}/.well-known/kora/identity?nonce=abc`);
  assert.equal(bad.status, 400);
  // Still behind Host/Origin.
  const evil = await fetch(`${base()}/.well-known/kora/identity?nonce=${nonce}`, {
    headers: { origin: EVIL },
  });
  assert.equal(evil.status, 403);
});

test("blob HTTP routes answer nothing while Kora is coming soon (a token-only POST must not start an engine download)", async () => {
  const auth = { authorization: `Bearer ${token}` };
  const install = await fetch(`${base()}/api/blob-browser/engine/install`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(install.status, 404);
  assert.match(JSON.stringify(await install.json()), /coming soon/);
  for (const p of ["/api/blob-browser/engine", "/api/blobs/blob_x/file?path=a.txt"]) {
    assert.equal((await fetch(`${base()}${p}`, { headers: auth })).status, 404, p);
  }
});
