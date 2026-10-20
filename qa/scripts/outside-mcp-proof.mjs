// Real stdio proof of `kora mcp --team` with the OFFICIAL MCP TypeScript SDK client against an isolated QA stack's daemon.
//   KORA_TEAM_TOKEN=<token> node qa/scripts/outside-mcp-proof.mjs <stack N> [phase]
//   phase "live" (default): list tools, list_blobs, send_message to a blob (the stub engine answers), wait_for, read_thread, search,
//                            list_outputs, a forbidden tool, bad arguments
//   phase "revoked":        every call is refused with the revoked-token message (run after the token was revoked in Settings)
// Prints ONE JSON object on stdout (the spec reads it); exit 1 when a check fails. The token travels in the child's env
// (KORA_TEAM_TOKEN), never on argv.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const require = createRequire(import.meta.url);
const { stack: stackEnv, childEnv } = require(path.join(ROOT, "qa/stacks/env.cjs"));

const CLIENT_NAME = process.env.MCP_CLIENT_NAME ?? "Claude Desktop";
const n = Number(process.argv[2] ?? 1);
const phase = process.argv[3] ?? "live";
const token = process.env.KORA_TEAM_TOKEN;
if (!token) {
  console.error("KORA_TEAM_TOKEN is required");
  process.exit(2);
}

// The SDK is not a runtime dependency; find it in the pnpm store (as the runtime's own mcp-team test does).
const store = path.join(ROOT, "node_modules/.pnpm");
const sdkDir = fs.readdirSync(store).find((d) => d.startsWith("@modelcontextprotocol+sdk@"));
if (!sdkDir) {
  console.error("the MCP SDK is not in the pnpm store");
  process.exit(2);
}
const sdkRoot = path.join(store, sdkDir, "node_modules/@modelcontextprotocol/sdk");
const { Client } = await import(path.join(sdkRoot, "dist/esm/client/index.js"));
const { StdioClientTransport } = await import(path.join(sdkRoot, "dist/esm/client/stdio.js"));

const s = stackEnv(n);
const env = { ...childEnv(s), KORA_TEAM_TOKEN: token };
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, "packages/runtime/bin/kora.js"), "mcp", "--team", "--socket", s.env.KORA_SOCKET_PATH],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "Claude Desktop", version: "0.0.1" }, { capabilities: {} });
const out = { phase, checks: [] };
const check = (name, ok, detail = null) => out.checks.push({ name, ok: !!ok, ...(detail != null ? { detail } : {}) });
const text = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");
const json = (r) => {
  try {
    return JSON.parse(text(r));
  } catch {
    return null;
  }
};

try {
  try {
    await client.connect(transport);
  } catch (e) {
    check("connect", false, String(e?.message ?? e));
    throw e;
  }
  if (phase === "revoked") {
    // a revoked token never gets a tool list; the bridge may refuse the connection or answer isError on every call
    let refused = false;
    try {
      const tools = await client.listTools();
      const r = await client.callTool({ name: "list_blobs", arguments: {} });
      refused = r.isError === true && /revoked|not valid/i.test(text(r));
      out.toolCount = tools.tools.length;
      out.revokedText = text(r);
    } catch (e) {
      refused = true;
      out.revokedText = String(e?.message ?? e);
    }
    check("revoked token is refused", refused, out.revokedText);
  } else {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    out.tools = names;
    for (const must of ["list_blobs", "get_blob", "list_threads", "read_thread", "search", "send_message", "ask_kora", "wait_for", "set_model", "interrupt", "list_outputs"])
      check(`tool ${must}`, names.includes(must));
    check("no approval / delete / settings / secrets tools", !names.some((x) => /approv|delet|setting|secret|memory|grant|hire|soul|browser/i.test(x)), names.join(","));

    const blobs = json(await client.callTool({ name: "list_blobs", arguments: {} }));
    const popo = blobs?.blobs?.find((b) => b.name === "Popo");
    out.blobs = blobs?.blobs?.map((b) => b.name);
    check("list_blobs shows the team", !!popo && blobs.blobs.some((b) => b.name === "Kora"));

    const sent = await client.callTool({ name: "send_message", arguments: { blob: "Popo", text: "[stub:say Popo heard the outside client] hello from MCP" } });
    const sentJson = json(sent);
    check("send_message returns a thread at once", !sent.isError && !!sentJson?.thread, text(sent).slice(0, 200));
    const thread = sentJson?.thread;
    out.thread = thread;

    const waited = await client.callTool({ name: "wait_for", arguments: { thread, timeout_s: 45 } });
    const waitedJson = json(waited);
    out.waited = waitedJson;
    check("wait_for ends settled with the reply", waitedJson?.status === "settled" && /Popo heard the outside client/.test(waitedJson?.reply ?? ""), text(waited).slice(0, 300));

    const read = await client.callTool({ name: "read_thread", arguments: { thread } });
    const readJson = json(read);
    out.messages = readJson?.messages;
    check("read_thread returns the transcript with the via client on the user row", readJson?.messages?.some((r) => r.role === "user" && r.via === CLIENT_NAME) === true, text(read).slice(0, 400));
    check("read_thread has the assistant reply", readJson?.messages?.some((r) => r.role === "assistant" && /heard the outside client/.test(r.text)) === true);

    const threads = json(await client.callTool({ name: "list_threads", arguments: { blob: "Popo" } }));
    check("list_threads lists it", !!threads?.threads?.some((t) => t.id === thread));
    const found = json(await client.callTool({ name: "search", arguments: { query: "heard the outside" } }));
    check("search finds the thread", !!found?.hits?.some((h) => h.kind === "thread" && h.id === thread), JSON.stringify(found).slice(0, 200));
    const outputs = await client.callTool({ name: "list_outputs", arguments: { blob: "Popo" } });
    check("list_outputs answers", !outputs.isError);
    const bad = await client.callTool({ name: "send_message", arguments: { blob: "Popo" } });
    check("bad arguments are an error, not a crash", bad.isError === true && /text is required/i.test(text(bad)), text(bad));
    const unknown = await client.callTool({ name: "answer_approval", arguments: { id: "x", allow: true } });
    check("a forbidden tool does not exist", unknown.isError === true, text(unknown));
  }
} catch (e) {
  check("run", false, String(e?.message ?? e));
} finally {
  await client.close().catch(() => {});
}
console.log(JSON.stringify(out));
process.exit(out.checks.every((c) => c.ok) ? 0 : 1);
