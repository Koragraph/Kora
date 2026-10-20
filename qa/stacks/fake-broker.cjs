#!/usr/bin/env node
"use strict";
// A fake Kora broker (services/composio-broker's contract) and a fake Composio API, for the QA stacks. No network, no real
// accounts. The daemon talks to it exactly as it talks to the real Worker:
//   KORA_COMPOSIO_BROKER_URL=http://127.0.0.1:<port>      the broker (register, link, accounts, tools, execute, usage)
//   KORA_COMPOSIO_API_BASE=http://127.0.0.1:<port>/api    "Composio itself" for a pasted ak_ key (accounts, toolkits, tools)
//
// A connect link points at this server (/connect/<id>); opening it (the browser, or `completeLink`) turns the pending account
// ACTIVE, which is the OAuth round trip. /__qa/* is the spec's remote control (set the usage, take the broker down, read state).
//
// Library: `startFakeBroker({ port?, cap? }) -> { url, state, close }`. CLI: `node fake-broker.cjs [port]`.
const http = require("node:http");
const crypto = require("node:crypto");

const CATALOG = [
  ["gmail", "Gmail", "Read, search and send email.", ["Email"]],
  ["outlook", "Outlook", "Mail and calendar from Microsoft 365.", ["Email", "Calendar"]],
  ["googlecalendar", "Google Calendar", "Look at your day and book time.", ["Calendar"]],
  ["slack", "Slack", "Read channels and post messages.", ["Chat"]],
  ["discord", "Discord", "Servers, channels and messages.", ["Chat"]],
  ["github", "GitHub", "Issues, pull requests and repositories.", ["Developer"]],
  ["linear", "Linear", "Issues and projects for product teams.", ["Developer", "Productivity"]],
  ["notion", "Notion", "Pages, databases and notes.", ["Docs", "Productivity"]],
  ["googledrive", "Google Drive", "Files and folders.", ["Docs"]],
  ["googlesheets", "Google Sheets", "Read and write spreadsheets.", ["Docs"]],
  ["trello", "Trello", "Boards and cards.", ["Productivity"]],
  ["asana", "Asana", "Tasks and projects.", ["Productivity"]],
  ["hubspot", "HubSpot", "Contacts, deals and companies.", ["CRM"]],
  ["stripe", "Stripe", "Payments and invoices.", ["Finance"]],
].map(([slug, name, description, categories]) => ({ slug, name, description, logo: null, categories }));
const PAGE = 8;
const ACTIONS = ["FETCH_EMAILS", "LIST_EVENTS", "SEND_EMAIL", "DELETE_EMAIL", "CREATE_EVENT", "SEARCH_ITEMS", "POST_MESSAGE"];

const rid = (p) => `${p}_${crypto.randomBytes(5).toString("hex")}`;

function startFakeBroker({ port = 0, cap = 750 } = {}) {
  const st = {
    cap,
    used: 0,
    down: false,
    closed: false, // registration_closed
    tokens: new Map(), // token -> installId
    accounts: [], // broker side: { id, toolkit, alias, status, install }
    byoAccounts: [{ id: "byo_gmail_1", toolkit: "gmail", alias: "From my own key", status: "ACTIVE" }],
    links: new Map(), // linkId -> account id
    executed: [], // { tool, toolkit, arguments, account_id }
    registered: 0,
    requests: [],
    resetsAt: Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1),
    month: new Date().toISOString().slice(0, 7),
  };
  const send = (res, code, body, type = "application/json") => {
    // Connection: close, so no keep-alive socket outlives a request (the fake must never hold a spec's process open)
    res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*", connection: "close" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => {
        try {
          resolve(d ? JSON.parse(d) : {});
        } catch {
          resolve({});
        }
      });
    });
  const toolsOf = (tk) => {
    const P = tk.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return ACTIONS.map((a) => ({
      slug: `${P}_${a}`,
      name: a.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      description: `${a.toLowerCase().replace(/_/g, " ")} in ${tk}`,
      toolkit: tk,
      inputSchema: { properties: { query: { type: "string" } } },
      readOnly: /FETCH|LIST|SEARCH/.test(a) ? true : null,
    }));
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const body = req.method === "POST" || req.method === "DELETE" ? await readBody(req) : {};
    st.requests.push({ method: req.method, path: p + u.search });
    const self = `http://127.0.0.1:${server.address().port}`;

    // ── QA remote control ────────────────────────────────────────────────────────────────────────────
    if (p === "/__qa/state") return send(res, 200, { ...st, tokens: [...st.tokens.keys()].length, links: [...st.links.keys()] });
    if (p === "/__qa/set") {
      for (const k of ["cap", "used", "down", "closed"]) if (k in body) st[k] = body[k];
      return send(res, 200, { ok: true });
    }
    if (p === "/__qa/reset") {
      st.accounts = []; st.executed = []; st.used = 0; st.tokens.clear(); st.links.clear(); st.registered = 0; st.down = false; st.closed = false;
      return send(res, 200, { ok: true });
    }
    // opening a connect link = finishing the sign-in on the app's own page
    const link = /^\/connect\/([A-Za-z0-9_]+)$/.exec(p);
    if (link) {
      const acct = st.accounts.find((a) => a.id === st.links.get(link[1]));
      if (acct) acct.status = "ACTIVE";
      return send(res, 200, "<!doctype html><title>Connected</title><body style='font:16px system-ui;padding:40px'>Connected. You can close this tab and go back to Kora.</body>", "text/html");
    }
    if (p === "/health") return send(res, st.down ? 503 : 200, { ok: !st.down, ready: !st.down });
    if (st.down) return send(res, 503, { error: { code: "down", message: "down" } });

    // ── "Composio itself" for a pasted ak_ key ───────────────────────────────────────────────────────
    if (p.startsWith("/api/")) {
      const key = req.headers["x-api-key"];
      if (!key || !String(key).startsWith("ak_") || String(key) === "ak_rejected_key_00000") return send(res, 401, { error: { message: "invalid api key" } });
      const q = p.slice(4);
      if (q === "/connected_accounts" && req.method === "GET") {
        return send(res, 200, { items: st.byoAccounts.map((a) => ({ id: a.id, user_id: null, status: a.status, alias: a.alias, toolkit: { slug: a.toolkit } })) });
      }
      if (q === "/toolkits") return send(res, 200, { items: CATALOG.map((t) => ({ slug: t.slug, name: t.name, meta: { description: t.description, categories: t.categories.map((name) => ({ name })) } })), next_cursor: null });
      if (q === "/tools") return send(res, 200, { items: toolsOf(u.searchParams.get("toolkit_slug") || "gmail").map((t) => ({ slug: t.slug, name: t.name, description: t.description, toolkit: { slug: t.toolkit }, input_parameters: t.inputSchema, tags: t.readOnly ? ["readOnlyHint"] : [] })) });
      const ex = /^\/tools\/execute\/([A-Za-z0-9_]+)$/.exec(q);
      if (ex) { st.executed.push({ via: "byo", tool: ex[1], arguments: body.arguments }); return send(res, 200, { successful: true, data: { done: ex[1], via: "your own key" }, error: null }); }
      return send(res, 404, { error: { message: "not found" } });
    }

    // ── the Kora broker ──────────────────────────────────────────────────────────────────────────────
    if (p === "/v1/register" && req.method === "POST") {
      if (st.closed) return send(res, 503, { error: { code: "registration_closed", message: "Kora's app service is not accepting new installs right now." } });
      const token = "kbk_" + crypto.randomBytes(24).toString("hex");
      const install = rid("inst");
      st.tokens.set(token, install);
      st.registered++;
      return send(res, 201, { installId: install, token, limit: st.cap });
    }
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const install = st.tokens.get(token);
    if (!install) return send(res, 401, { error: { code: "unauthorized", message: "unknown install" } });
    const mine = () => st.accounts.filter((a) => a.install === install);
    const pub = (a) => ({ id: a.id, toolkit: a.toolkit, alias: a.alias, status: a.status });

    if (p === "/v1/usage") return send(res, 200, { used: st.used, limit: st.cap, month: st.month, resetsAt: st.resetsAt });
    if (p === "/v1/toolkits") {
      const q = (u.searchParams.get("search") || "").toLowerCase();
      const all = CATALOG.filter((t) => !q || t.name.toLowerCase().includes(q) || t.slug.includes(q) || t.description.toLowerCase().includes(q));
      const from = Number(u.searchParams.get("cursor") || 0);
      const page = all.slice(from, from + PAGE);
      return send(res, 200, { toolkits: page, nextCursor: from + PAGE < all.length ? String(from + PAGE) : null });
    }
    if (p === "/v1/accounts" && req.method === "GET") {
      const tk = u.searchParams.get("toolkit");
      return send(res, 200, { accounts: mine().filter((a) => !tk || a.toolkit === tk).map(pub) });
    }
    const del = /^\/v1\/accounts\/(.+)$/.exec(p);
    if (del && req.method === "DELETE") {
      const id = decodeURIComponent(del[1]);
      const n = st.accounts.length;
      st.accounts = st.accounts.filter((a) => !(a.id === id && a.install === install));
      return send(res, 200, { removed: n - st.accounts.length });
    }
    if (p === "/v1/link" && req.method === "POST") {
      const have = mine().filter((a) => a.toolkit === body.toolkit);
      if (have.length >= 5) return send(res, 409, { error: { code: "account_limit", message: "You can connect up to 5 accounts of one app." } });
      if (have.length && !body.alias) return send(res, 400, { error: { code: "alias_required", message: "Give this account a label so it does not replace the existing one." } });
      if (body.alias && have.some((a) => (a.alias || "").toLowerCase() === String(body.alias).toLowerCase())) return send(res, 409, { error: { code: "alias_in_use", message: "That label is already used." } });
      const acct = { id: rid("ca"), toolkit: body.toolkit, alias: body.alias || null, status: "INITIATED", install };
      st.accounts.push(acct);
      const linkId = rid("lk");
      st.links.set(linkId, acct.id);
      return send(res, 200, { url: `${self}/connect/${linkId}`, expiresAt: Date.now() + 10 * 60_000 });
    }
    if (p === "/v1/tools") return send(res, 200, { tools: toolsOf(u.searchParams.get("toolkit") || "gmail") });
    if (p === "/v1/execute" && req.method === "POST") {
      const act = mine().filter((a) => a.toolkit === body.toolkit && a.status === "ACTIVE");
      if (!act.length) return send(res, 409, { error: { code: "not_connected", message: `No ${body.toolkit} account is connected.` } });
      if (!body.account_id && act.length > 1) return send(res, 409, { error: { code: "account_required", message: "Several accounts are connected. Say which one.", accounts: act.map((a) => ({ id: a.id, alias: a.alias })) } });
      if (st.used >= st.cap) return send(res, 429, { error: { code: "cap_reached", message: "cap", used: st.used, limit: st.cap, month: st.month, resetsAt: st.resetsAt } });
      st.used++;
      st.executed.push({ via: "broker", tool: body.tool, toolkit: body.toolkit, arguments: body.arguments, account_id: body.account_id || act[0].id });
      const a = act.find((x) => x.id === body.account_id) || act[0];
      return send(res, 200, { ok: true, data: { done: body.tool, items: [{ subject: "Welcome" }] }, error: null, account: { id: a.id, alias: a.alias }, usage: { used: st.used, limit: st.cap } });
    }
    return send(res, 404, { error: { code: "not_found", message: "not found" } });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      server.unref();
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url,
        apiBase: `${url}/api`,
        state: st,
        /** Finish a pending sign-in without a browser (what opening the link does). */
        completeLink: async (linkUrl) => { await fetch(linkUrl); },
        control: async (patch) => (await fetch(`${url}/__qa/set`, { method: "POST", body: JSON.stringify(patch) })).json(),
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { startFakeBroker, CATALOG };

if (require.main === module) {
  startFakeBroker({ port: Number(process.argv[2] || 8899) }).then((b) => console.log(`fake broker on ${b.url} (Composio API ${b.apiBase})`));
}
