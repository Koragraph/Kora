// Seeding for the Blobs transcript + memory specs (Slice D). A blob thread needs three things the generic `stack.cjs
// seed` does not make: a blob, a thread inside its project with `blob.card` activities, and memory (facts, core notes,
// receipts) in the stack's memory.db. The blob is created through the UI by the spec; this file does the rest while the
// stack's daemon is stopped (the ui-server reads thread projections from disk at start), then starts it again.
//
// Memory is written through the runtime's own memory module (dist/memory) with a scripted extractor, so the receipts
// in the seeded cards are REAL ones: clicking Undo in the UI calls the daemon, which undoes them in memory.db.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const STACK_CTL = path.join(ROOT, "qa/stacks/stack.cjs");
const { stack: stackEnv } = require(path.join(ROOT, "qa/stacks/env.cjs"));
const RT = path.join(ROOT, "packages/runtime");

const uuid = () => crypto.randomUUID();
const MIN = 60_000;

function ctl(command, n) {
  execFileSync(process.execPath, [STACK_CTL, command, String(n)], {
    stdio: "inherit",
    timeout: 90_000,
  });
}

/** The blob created through the UI, found on disk by name. */
export function loadBlob(n, name) {
  const s = stackEnv(n);
  const dir = path.join(s.home, "blobs");
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, entry, "profile.json");
    if (!fs.existsSync(file)) continue;
    const profile = JSON.parse(fs.readFileSync(file, "utf8"));
    if (profile.name === name) return profile;
  }
  throw new Error(
    `stack${n}: no blob named "${name}" on disk (create it through the editor first)`,
  );
}

// ── fixture files (outputs/) ─────────────────────────────────────────────────────────────────────────────────

async function writeOutputs(workspace) {
  const outputs = path.join(workspace, "outputs");
  fs.mkdirSync(outputs, { recursive: true });
  const { buildXlsx, buildZip } = await import(
    path.join(ROOT, "apps/web/src/components/blobs/previews/testZip.ts")
  );
  const cell = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const num = (ref, v, s = 0) => `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${v}</v></c>`;
  const chargers = [
    ["Wallbox Pulsar Plus", 649, 48, 4.5],
    ["ChargePoint Home Flex", 699, 50, 4.4],
    ["Tesla Wall Connector", 475, 48, 4.6],
    ["Emporia Smart", 399, 48, 4.3],
    ["Grizzl-E Classic", 399, 40, 4.5],
  ];
  const rows = [
    `<row r="1">${["Charger", "Price (USD)", "Max amps", "Rating"].map((h, i) => cell(`${"ABCD"[i]}1`, h)).join("")}</row>`,
    ...chargers.map(
      ([name, price, amps, rating], i) =>
        `<row r="${i + 2}">${cell(`A${i + 2}`, name)}${num(`B${i + 2}`, price)}${num(`C${i + 2}`, amps)}${num(`D${i + 2}`, rating)}</row>`,
    ),
    ...Array.from({ length: 150 }, (_x, i) => {
      const r = i + 7;
      return `<row r="${r}">${cell(`A${r}`, `Archived model ${i + 1}`)}${num(`B${r}`, 300 + i * 3)}${num(`C${r}`, 32 + (i % 3) * 8)}${num(`D${r}`, 3 + (i % 20) / 10)}</row>`;
    }),
  ].join("");
  const xlsx = buildXlsx({
    sheets: [
      { name: "Comparison", xml: `<dimension ref="A1:D156"/><sheetData>${rows}</sheetData>` },
      {
        name: "Install costs",
        xml: `<dimension ref="A1:C3"/><sheetData><row r="1">${["Item", "Low", "High"].map((h, i) => cell(`${"ABC"[i]}1`, h)).join("")}</row><row r="2">${cell("A2", "Electrician visit")}${num("B2", 250)}${num("C2", 600)}</row><row r="3">${cell("A3", "Permit (Dallas)")}${num("B3", 75)}${num("C3", 150)}</row></sheetData>`,
      },
    ],
  });
  fs.writeFileSync(path.join(outputs, "ev-chargers.xlsx"), xlsx);

  fs.writeFileSync(
    path.join(outputs, "garage-circuit-notes.csv"),
    [
      "Item,Amps,Note",
      '"Existing breaker",40,"Double-pole, labelled ""dryer"""',
      "Charger target,32,80% of breaker rating",
      "Wire gauge,8 AWG,Copper; run is under 40 ft",
      '"Permit, inspection",n/a,"Dallas requires a permit for a new 240 V circuit"',
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outputs, "launch-brief.docx"),
    buildZip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        "<w:document><w:body><w:p><w:r><w:t>Home charging brief</w:t></w:r></w:p><w:p><w:r><w:t>Recommendation: a 40 amp plug-in unit on the existing dryer circuit, installed by a licensed electrician.</w:t></w:r></w:p></w:body></w:document>",
      "docProps/core.xml":
        "<cp:coreProperties><dc:title>Home charging brief</dc:title></cp:coreProperties>",
      "docProps/app.xml": "<Properties><Pages>3</Pages></Properties>",
    }),
  );
  const slide = (t) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  fs.writeFileSync(
    path.join(outputs, "charger-options.pptx"),
    buildZip({
      "ppt/presentation.xml": "<p:presentation/>",
      "ppt/slides/slide1.xml": slide("EV charger options for the garage"),
      "ppt/slides/slide2.xml": slide("Shortlist and prices"),
      "ppt/slides/slide3.xml": slide("Install plan"),
      "ppt/slides/slide4.xml": slide("Next steps"),
    }),
  );
  // The two Office files are real ones (the runtime's own doc tools), so macOS Quick Look can draw their first page for the cards'
  // preview. They keep what the cards read: a title, a recommendation, three pages, four slides.
  const { runDocTool } = require(path.join(RT, "dist/blobs/doctools/index.js"));
  const docx = await runDocTool(
    "docx",
    "write",
    {
      path: path.join(outputs, "launch-brief.docx"),
      overwrite: true,
      title: "Home charging brief",
      blocks: [
        { type: "heading", level: 1, text: "Recommendation" },
        {
          type: "paragraph",
          text: "A 40 amp plug-in unit on the existing dryer circuit, installed by a licensed electrician.",
        },
        { type: "heading", level: 2, text: "Shortlist" },
        {
          type: "table",
          header: ["Unit", "Price", "Amps"],
          rows: [
            ["Wallbox Pulsar Plus", "$649", "48"],
            ["Emporia Smart", "$399", "48"],
            ["Tesla Wall Connector", "$475", "48"],
          ],
        },
        {
          type: "bullets",
          items: [
            "Dallas needs a permit for a new 240 V circuit",
            "Install takes half a day",
            "Rebates apply before December",
          ],
        },
      ],
    },
    outputs,
  );
  const pptx = await runDocTool(
    "pptx",
    "write",
    {
      path: path.join(outputs, "charger-options.pptx"),
      overwrite: true,
      title: "EV charger options for the garage",
      slides: [
        {
          title: "EV charger options for the garage",
          subtitle: "Three units clear the bar for a 40 amp circuit",
        },
        {
          title: "Shortlist and prices",
          table: {
            header: ["Unit", "Price"],
            rows: [
              ["Wallbox Pulsar Plus", "$649"],
              ["Emporia Smart", "$399"],
              ["Tesla Wall Connector", "$475"],
            ],
          },
        },
        { title: "Install plan", bullets: ["Permit first", "Electrician visit", "Mount and test"] },
        { title: "Next steps", text: "Pick a unit, book the electrician, file the permit." },
      ],
    },
    outputs,
  );
  if (!docx.ok || !pptx.ok) throw new Error(`seed office files: ${JSON.stringify({ docx, pptx })}`);
  {
    // the card reads its page count from docProps/app.xml; the generator does not write one
    const JSZip = require(require.resolve("jszip", { paths: [RT] }));
    const file = path.join(outputs, "launch-brief.docx");
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const app =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>3</Pages></Properties>';
    zip.file("docProps/app.xml", app);
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  }
  fs.writeFileSync(
    path.join(outputs, "permit-checklist.pdf"),
    "%PDF-1.4\n1 0 obj<</Type /Pages /Kids [2 0 R] /Count 2>>endobj\n2 0 obj<</Type /Page>>endobj\n3 0 obj<</Title (Dallas permit checklist)>>endobj\n%%EOF\n",
  );
  fs.writeFileSync(
    path.join(outputs, "summary.md"),
    "# Charger shortlist\n\nThree units clear the bar for a **40 amp** circuit:\n\n1. Grizzl-E Classic: cheapest, rugged\n2. Emporia Smart: app + load balancing\n3. Tesla Wall Connector: best fit and finish\n\n> Prices checked this week; they move.\n",
  );
}

// ── memory ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What a seeded turn tells the (scripted) extractor to do. */
const SCRIPT = [
  {
    user: "I live in Dallas and my garage has a 40 amp circuit.",
    ops: [
      { op: "add", scope: "you", text: "You live in Dallas.", confidence: 0.95, important: false },
      {
        op: "add",
        scope: "blob",
        text: "Garage has a 40 amp circuit (EV charger project).",
        confidence: 0.9,
      },
    ],
  },
  {
    user: "Please keep answers short, I read on my phone.",
    ops: [
      {
        op: "add",
        scope: "you",
        text: "You prefer short answers.",
        confidence: 0.95,
        important: true,
        explicit: true,
      },
    ],
  },
  {
    user: "My doctor says I should avoid caffeine, so skip coffee-shop suggestions.",
    ops: [
      {
        op: "add",
        scope: "you",
        text: "Avoids caffeine on a doctor's advice.",
        confidence: 0.9,
        sensitive: true,
      },
    ],
  },
];

async function seedMemory(s, blob, threadId, messageIds, now) {
  const memModule = require(path.join(RT, "dist/memory/index.js"));
  fs.mkdirSync(path.join(s.home, "blobs"), { recursive: true });
  const dbPath = path.join(s.home, "blobs", "memory.db");
  let clock = now - 45 * 86_400_000;
  let current = 0;
  const mem = memModule.openMemory({
    dbPath,
    extractor: async () => JSON.stringify({ ops: SCRIPT[current].ops }),
    now: () => clock,
  });
  // Older context first, so the "since" dates in the tab span months.
  clock = now - 120 * 86_400_000;
  await mem.addFact({ scope: "you", text: "Works with a cofounder named Sam.", important: true });
  clock = now - 80 * 86_400_000;
  await mem.addFact({ scope: "you", text: "Prefers morning meetings before 11 AM." });
  clock = now - 30 * 86_400_000;
  await mem.addFact({
    scope: "blob",
    blobId: blob.id,
    text: "Cite sources as footnotes, not inline links.",
  });
  mem.setCore("you", blob.id, "Name: Sam\nTimezone: America/Chicago\nRole: founder");
  mem.setCore("blob", blob.id, "Research for Sam. Short answers, sources as footnotes.");

  const receipts = [];
  const turnTimes = [now - 38 * MIN, now - 31 * MIN, now - 20 * MIN];
  for (current = 0; current < SCRIPT.length; current += 1) {
    clock = turnTimes[current];
    const got = await mem.ingestTurn({
      blobId: blob.id,
      threadId,
      userMessageId: messageIds[current].user,
      assistantMessageId: messageIds[current].assistant,
      messageId: messageIds[current].user,
      userText: SCRIPT[current].user,
      assistantText: "Got it.",
      at: turnTimes[current],
    });
    receipts.push(got);
  }
  mem.close();
  return receipts;
}

// ── the conversation ─────────────────────────────────────────────────────────────────────────────────────────

const ANSWER = [
  "Here is the short version. Three units fit a **40 amp** circuit:",
  "",
  "| Charger | Price | Max amps | Why |",
  "| --- | --- | --- | --- |",
  "| Grizzl-E Classic | $399 | 40 | Cheapest, built like a tank |",
  "| Emporia Smart | $399 | 48 | App, load balancing |",
  "| Tesla Wall Connector | $475 | 48 | Best fit and finish |",
  "",
  "A few notes:",
  "",
  "- On a 40 amp breaker, size the charger for **32 amps** (80% rule).",
  "- Dallas wants a permit for a new 240 V circuit; I put the checklist together.",
  "",
  "```bash",
  "# the breaker label to look for",
  "grep -i dryer circuit-notes.txt",
  "```",
  "",
  "I saved the details: `ev-chargers.xlsx` (prices, 2 sheets), `garage-circuit-notes.csv`, `launch-brief.docx`, `charger-options.pptx`, `permit-checklist.pdf` and `summary.md`.",
].join("\n");

function toolActivities(turnId, t0, nextSeq) {
  const out = [];
  const mk = (kind, summary, payload, dt) =>
    out.push({
      id: uuid(),
      tone: "tool",
      kind,
      summary,
      payload,
      turnId,
      sequence: nextSeq(),
      createdAt: new Date(t0 + dt).toISOString(),
    });
  const a = uuid();
  const b = uuid();
  mk(
    "command_execution",
    "Search the web",
    {
      itemId: a,
      toolName: "Bash",
      input: { command: "curl -s 'https://example.com/ev-chargers'" },
    },
    1000,
  );
  mk("tool_result", "tool completed", { itemId: a, status: "completed", output: "ok" }, 2500);
  mk(
    "file_read",
    "Read circuit notes",
    { itemId: b, toolName: "Read", input: { file_path: "files/circuit-notes.txt" } },
    3000,
  );
  mk(
    "tool_result",
    "tool completed",
    { itemId: b, status: "completed", output: "40 amp double pole" },
    3300,
  );
  return out;
}

/**
 * Seeds the "Popo" scenario on stack `n` for a blob the spec already created through the editor, and restarts the
 * daemon. Returns what the specs assert on.
 */
export async function seedBlobScenario(
  n,
  blobName,
  { threadTitle = "EV chargers for the garage", reuse = false } = {},
) {
  const s = stackEnv(n);
  const blob = loadBlob(n, blobName);
  const threadsDir = path.join(s.home, "kora-daemon", "threads");
  const seededThreadFiles = [];
  for (const file of fs.existsSync(threadsDir) ? fs.readdirSync(threadsDir) : []) {
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(threadsDir, file), "utf8"));
      if (existing.projectId === blob.id && existing.title === threadTitle) {
        if (reuse) return { blob, threadId: existing.threadId, threadTitle, reused: true };
        seededThreadFiles.push(path.join(threadsDir, file));
      }
    } catch {
      /* unreadable projection: ignore */
    }
  }
  ctl("start", n); // idempotent: the thread below is created through the live daemon
  const { KoraClient } = require(path.join(RT, "dist/protocol/client.js"));
  const client = new KoraClient(s.env.KORA_SOCKET_PATH);
  await client.connect();
  const created = await client.call("chat.thread.create", {
    agent: "claude",
    cwd: blob.workspace,
    agentMode: "chat",
    model: { model: "claude-sonnet-5" },
    title: threadTitle,
  });
  const koraThreadId = created.id ?? created.threadId;
  client.close();
  ctl("stop", n);
  // A rerun starts from the same clean scenario: the specs mutate memory (undo, approve, forget), so the previous
  // run's thread projection and memory.db are replaced, not extended.
  for (const file of seededThreadFiles) fs.rmSync(file, { force: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(path.join(s.home, "blobs", `memory.db${suffix}`), { force: true });
  }

  const now = Date.now();
  const threadId = uuid();
  const turn = [uuid(), uuid(), uuid(), uuid()];
  const msg = (role, text, turnId, at, id = `msg_${role[0]}_${uuid()}`) => ({
    id,
    role,
    text,
    turnId: role === "assistant" ? turnId : null,
    streaming: false,
    createdAt: new Date(at).toISOString(),
    updatedAt: new Date(at).toISOString(),
  });
  const t1 = now - 40 * MIN;
  const t2 = now - 31 * MIN;
  const t9 = now - 20 * MIN;
  const t4 = now - 6 * MIN;
  const messages = [
    msg(
      "user",
      "Hey Popo, can you compare a few EV chargers for my garage? I live in Dallas and the garage has a 40 amp circuit.",
      null,
      t1,
    ),
    msg(
      "assistant",
      "On it. Let me check the circuit notes and a few current prices first.",
      turn[0],
      t1 + 6_000,
    ),
    msg("assistant", ANSWER, turn[0], t1 + 52_000),
    msg("user", "Please keep answers short, I read on my phone.", null, t2),
    msg("assistant", "Got it. Short from here on.", turn[1], t2 + 5_000),
    msg(
      "user",
      "My doctor says I should avoid caffeine, so skip coffee-shop suggestions.",
      null,
      t9,
    ),
    msg("assistant", "Noted, no coffee-shop spots.", turn[2], t9 + 4_000),
    msg("user", "Draft the permit email to the city for me.", null, t4),
  ];
  const messageIds = [
    { user: messages[0].id, assistant: messages[2].id },
    { user: messages[3].id, assistant: messages[4].id },
    { user: messages[5].id, assistant: messages[6].id },
  ];
  let seq = 1000;
  const nextSeq = () => (seq += 1);
  const receipts = await seedMemory(s, blob, threadId, messageIds, now);

  const wire = (list, scopes) =>
    list.map((r, i) => ({
      id: r.id,
      kind: r.kind === "pending" ? "held" : r.kind,
      scope: scopes[i] ?? "you",
      text: r.text,
      previousText: null,
      factId: r.factId || null,
      undone: false,
      reason: r.kind === "pending" ? "Health details are saved only with your OK." : null,
    }));
  const card = (cardId, turnId, at, summary, payload) => ({
    id: uuid(),
    tone: "info",
    kind: "blob.card",
    summary,
    payload: { cardId, version: 1, ...payload },
    turnId,
    sequence: nextSeq(),
    createdAt: new Date(at).toISOString(),
  });
  const memoryCard1 = card("mem-turn-1", turn[0], t1 + 60_000, "Remembered: You live in Dallas.", {
    cardKind: "memory",
    receipts: wire(receipts[0], ["you", "blob"]),
  });
  const memoryCard2 = card(
    "mem-turn-2",
    turn[1],
    t2 + 9_000,
    "Remembered: You prefer short answers.",
    {
      cardKind: "memory",
      receipts: wire(receipts[1], ["you"]),
    },
  );
  const selfChange = card("sc-turn-2", turn[1], t2 + 8_000, "Updated my style: shorter answers", {
    cardKind: "self-change",
    what: "Updated my style: keep answers short and phone-friendly",
    undoToken: `sc_${uuid().slice(0, 8)}`,
    undone: false,
  });
  const heldCard = card(
    "mem-turn-3",
    turn[2],
    t9 + 8_000,
    "Remember: You avoid caffeine on a doctor's advice.",
    {
      cardKind: "memory",
      receipts: wire(receipts[2], ["you"]),
    },
  );
  const rateLimit = card("rl-turn-4", turn[3], t4 + 20_000, "Claude is at its limit", {
    cardKind: "rate-limit",
    engine: "claude",
    resetsAt: now + 52 * MIN,
    threadId: koraThreadId,
  });
  const activities = [
    ...toolActivities(turn[0], t1, nextSeq),
    memoryCard1,
    selfChange,
    memoryCard2,
    heldCard,
    rateLimit,
  ];
  const last = messages.at(-1);
  const record = {
    threadId,
    koraThreadId,
    projectId: blob.id,
    cwd: blob.workspace,
    title: threadTitle,
    modelSelection: blob.engine,
    runtimeMode: "approval-required",
    interactionMode: "default",
    agentMode: "chat",
    branch: null,
    worktreePath: null,
    createdAt: new Date(t1 - 1000).toISOString(),
    updatedAt: last.updatedAt,
    messages,
    activities,
    session: null,
    latestTurn: {
      turnId: turn[2],
      state: "completed",
      requestedAt: new Date(t9).toISOString(),
      startedAt: new Date(t9).toISOString(),
      completedAt: new Date(t9 + 5_000).toISOString(),
      assistantMessageId: messages[6].id,
    },
    latestUserMessageAt: last.createdAt,
    koraSessionId: null,
    providerDriver: "claude",
  };
  const dataDir = path.join(s.home, "kora-daemon", "threads");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, `${threadId}.json`), JSON.stringify(record));
  await writeOutputs(blob.workspace);
  ctl("start", n);
  return {
    blob,
    threadId,
    threadTitle,
    receiptIds: receipts.map((list) => list.map((r) => r.id)),
    cardIds: {
      memory1: "mem-turn-1",
      memory2: "mem-turn-2",
      held: "mem-turn-3",
      rateLimit: "rl-turn-4",
      selfChange: "sc-turn-2",
    },
    xlsxPath: path.join(blob.workspace, "outputs", "ev-chargers.xlsx"),
  };
}

/** Serves a workspace file for the browser's `GET /api/blobs/:id/file?path=` until the daemon grows that route. */
export async function serveBlobFiles(page, workspace) {
  await page.route(/\/api\/blobs\/[^/]+\/file\?/, async (route) => {
    const url = new URL(route.request().url());
    const rel = url.searchParams.get("path") ?? "";
    const target = path.resolve(workspace, rel);
    if (!target.startsWith(workspace + path.sep) || !fs.existsSync(target)) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ _tag: "HostResourceNotFoundError" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      body: fs.readFileSync(target),
      headers: { "access-control-allow-origin": "*" },
    });
  });
}
