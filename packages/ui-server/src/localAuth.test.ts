// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off -- a plain node:test harness driving a real listener from outside.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensureUiToken, makeLocalAuth } from "./localAuth.ts";

const TOKEN = "t".repeat(43);
const req = (url: string, headers: Record<string, string>, method = "GET") => ({
  method,
  url,
  headers: { host: "127.0.0.1:8811", ...headers },
});

test("ensureUiToken creates a private secret once and reuses it (tightening a loose mode)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kora-ui-token-"));
  try {
    const a = ensureUiToken(home);
    const file = path.join(home, "ui-token");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600); // no mode bits on Windows
    fs.chmodSync(file, 0o644);
    assert.equal(ensureUiToken(home), a);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600); // no mode bits on Windows
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("tickets are single-use and expire after a minute", () => {
  let now = 1_000;
  const auth = makeLocalAuth({ token: TOKEN, port: 8811, now: () => now });
  const a = auth.issueTicket().ticket;
  assert.equal(auth.check(req(`/ws?wsTicket=${a}`, {})).ok, true);
  assert.equal(auth.check(req(`/ws?wsTicket=${a}`, {})).ok, false);
  const b = auth.issueTicket().ticket;
  now += 60_001;
  assert.equal(auth.check(req(`/ws?wsTicket=${b}`, {})).ok, false);
  // A ticket is only good for /ws.
  const c = auth.issueTicket().ticket;
  assert.equal(auth.check(req(`/api/auth/session?wsTicket=${c}`, {})).ok, false);
});

test("the credential is accepted as a bearer or the x-kora-ui-token header, never partially", () => {
  const auth = makeLocalAuth({ token: TOKEN, port: 8811 });
  assert.equal(auth.check(req("/api/x", { authorization: `Bearer ${TOKEN}` })).ok, true);
  assert.equal(auth.check(req("/api/x", { "x-kora-ui-token": TOKEN })).ok, true);
  assert.equal(auth.check(req("/api/x", { authorization: `Bearer ${TOKEN.slice(1)}` })).ok, false);
  assert.equal(
    auth.check(req("/api/x", { authorization: "Bearer kora-local-dev-token" })).ok,
    false,
  );
});

test("Host and Origin allow-lists; KORA_UI_ALLOWED_ORIGINS extends the origins", () => {
  const auth = makeLocalAuth({ token: TOKEN, port: 8811, extraOrigins: ["http://localhost:5733"] });
  const ok = { "x-kora-ui-token": TOKEN };
  assert.equal(auth.check({ url: "/api/x", headers: { host: "localhost:8811", ...ok } }).ok, true);
  assert.equal(auth.check({ url: "/api/x", headers: { host: "127.0.0.1:8797", ...ok } }).ok, false);
  assert.equal(auth.check({ url: "/", headers: { host: "attacker.test:8811" } }).ok, false);
  assert.equal(auth.check({ url: "/", headers: {} }).ok, false);
  assert.equal(auth.check(req("/api/x", { ...ok, origin: "http://localhost:5733" })).ok, true);
  assert.equal(auth.check(req("/api/x", { ...ok, origin: "null" })).ok, false);
  assert.equal(auth.check(req("/api/x", { ...ok, origin: "http://localhost:3000" })).ok, false);
  // Preflights and readiness probes need no secret, but still an allowed origin.
  assert.equal(auth.check(req("/api/x", { origin: "kora://app" }, "OPTIONS")).ok, true);
  assert.equal(auth.check(req("/.well-known/kora/host", {})).ok, true);
  assert.equal(
    auth.check(req("/.well-known/kora/host", { origin: "https://evil.example" })).ok,
    false,
  );
});

// Security sweep 2026-10-04: the credential-free paths were matched on the WHATWG-normalized path, so a target the
// router dispatches to a protected route but `new URL` folds to `/` (`/api/attachments/%2e%2e/%2e%2e`) skipped auth.
test("credential-free paths match the RAW request path, never a normalized one", () => {
  const auth = makeLocalAuth({ token: TOKEN, port: 8811 });
  for (const sneaky of [
    "/api/attachments/%2e%2e/%2e%2e",
    "/api/attachments/../..",
    "/api/chat/threads/%2E%2E/%2e%2e/%2e%2e",
    "/api/auth/session/..%2f..%2f",
    "/api\\..\\..",
    "/oauth/token/../api/auth/session",
    "/./",
    "//",
    "/#/api/auth/session",
    "http://127.0.0.1:8811/",
  ]) {
    const v = auth.check(req(sneaky, {}));
    assert.equal(v.ok, false, `${sneaky} must need the secret`);
  }
  // The real public paths (with a query) and the ticketed /ws still work.
  assert.equal(auth.check(req("/", {})).ok, true);
  assert.equal(auth.check(req("/.well-known/kora/host?x=1", {})).ok, true);
  assert.equal(auth.check(req("/oauth/token", {}, "POST")).ok, true);
  const t = auth.issueTicket().ticket;
  assert.equal(auth.check(req(`/ws/../ws?wsTicket=${t}`, {})).ok, false);
  const t2 = auth.issueTicket().ticket;
  assert.equal(auth.check(req(`/ws?wsTicket=${t2}`, {})).ok, true);
});

test("an OPTIONS request carrying Upgrade is not a preflight and gets no credential-free pass", () => {
  const auth = makeLocalAuth({ token: TOKEN, port: 8811 });
  assert.equal(auth.check(req("/ws", { upgrade: "websocket" }, "OPTIONS")).ok, false);
  assert.equal(auth.check(req("/ws", { origin: "kora://app" }, "OPTIONS")).ok, true);
});
