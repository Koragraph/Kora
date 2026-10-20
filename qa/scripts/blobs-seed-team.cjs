#!/usr/bin/env node
"use strict";
// Seeds Kora's Phase 2 scenario into an isolated QA stack WITHOUT a model: the team (Popo, Junip), three proposal
// cards (hire / tweak / dismiss), two confirm cards (edit Popo, retire Junip), a job in progress with a delegated
// "from Kora" thread, and Kora's thread with every card in it. The stores are the runtime's own (dist/blobs/jobs.js), so
// clicking in the UI exercises the real daemon code: hire, dismiss, confirm, cancel, undo.
//
//   node qa/scripts/blobs-seed-team.cjs <stackN> [--force]      prints the ids as JSON (also <stack>/team-seed.json)
//
// Order matters: blobs are created offline, the daemon mirrors them into projects on boot, THEN threads are written to
// the projection while it is stopped (the engine hydrates threads from disk at start).
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const RT = path.join(ROOT, "packages/runtime");
const { stack } = require(path.join(ROOT, "qa/stacks/env.cjs"));
const n = Number(process.argv[2]);
const force = process.argv.includes("--force");
if (!(n >= 1 && n <= 4)) {
  console.error("usage: blobs-seed-team.cjs <stackN 1..4> [--force]");
  process.exit(2);
}
const s = stack(n);
const seedFile = path.join(s.base, "team-seed.json");
if (fs.existsSync(seedFile) && !force) {
  console.log(fs.readFileSync(seedFile, "utf8").trim());
  process.exit(0);
}

const ctl = (cmd) =>
  execFileSync(process.execPath, [path.join(ROOT, "qa/stacks/stack.cjs"), cmd, String(n)], {
    stdio: "inherit",
    timeout: 120_000,
  });
const uuid = () => crypto.randomUUID();
const MIN = 60_000;
// The runtime reads these lazily: point it at the stack before touching any of its modules.
process.env.KORA_HOME = s.home;
process.env.KORA_BLOBS_ROOT = s.env.KORA_BLOBS_ROOT;
const load = (rel) => require(path.join(RT, "dist", rel));

(async () => {
  ctl("stop");
  const { BlobStore } = load("blobs/store.js");
  const { KORA_SOUL, hireTemplate } = load("blobs/templates.js");
  const { JobStore, ProposalStore, ConfirmStore, jobCard } = load("blobs/jobs.js");
  const ENGINE = { instanceId: "claude", model: "sonnet", effort: null };
  const store = new BlobStore();
  const kora = store.ensureKora(ENGINE, KORA_SOUL);
  const byName = (name) => store.list({ includeArchived: true }).find((b) => b.name === name);
  const hire = (id) =>
    byName(id[0].toUpperCase() + id.slice(1)) ??
    hireTemplate(store, id, { defaultEngine: ENGINE }).profile;
  let popo = hire("popo");
  let junip = hire("junip");
  // A same-named blob an earlier spec made by hand (a blank title) would break the "Researcher -> Lead Researcher" card: the scenario
  // is about the starters, so they keep the starters' titles.
  if (!popo.title) popo = store.update(popo.id, { title: "Researcher" });
  if (!junip.title) junip = store.update(junip.id, { title: "Writer" });

  ctl("start"); // the daemon mirrors the blobs into projects
  const { KoraClient } = load("protocol/client.js");
  const client = new KoraClient(s.env.KORA_SOCKET_PATH);
  await client.connect();
  const mkThread = async (cwd, title) => {
    const created = await client.call("chat.thread.create", {
      agent: "claude",
      cwd,
      agentMode: "chat",
      model: { model: "claude-sonnet-5" },
      title,
    });
    return created.id ?? created.threadId;
  };
  const koraKt = await mkThread(kora.workspace, "Lisbon trip (QA)");
  const popoKt = await mkThread(popo.workspace, "Neighbourhood research (from Kora)");
  const needsKt = await mkThread(kora.workspace, "Needs you (QA)");
  const junipKt = await mkThread(junip.workspace, "Itinerary summary (from Kora)");
  client.close();
  ctl("stop");

  // The Kora thread file that already exists for these (the create above made empty ones): replaced below.
  const threadsDir = path.join(s.home, "kora-daemon", "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  for (const f of fs.readdirSync(threadsDir)) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(threadsDir, f), "utf8"));
      if (/\(QA\)$|\(from Kora\)$/.test(t.title ?? ""))
        fs.rmSync(path.join(threadsDir, f), { force: true });
    } catch {
      /* unreadable: leave */
    }
  }
  for (const f of ["proposals.json", "confirms.json"])
    fs.rmSync(path.join(s.home, "blobs", f), { force: true });
  fs.rmSync(path.join(s.home, "blobs", "jobs"), { recursive: true, force: true });

  const now = Date.now();
  const draftOf = (name, title, job, over = {}) => ({
    name,
    title,
    job,
    howItWorks: ["Checks every morning", "Flags what changed", "Never acts without asking"],
    soul: `You are ${name}, a ${title.toLowerCase()}. Calm and exact. ${job}.`,
    engine: ENGINE,
    permission: "ask",
    outfit: { head: "beanie", face: null, neck: null },
    apps: ["Shopify"],
    skills: ["refund-triage"],
    routines: [{ title: "Daily digest", cadence: "Weekdays at 17:00" }],
    templateId: null,
    ...over,
  });
  const proposals = new ProposalStore();
  const pHire = proposals.create(
    draftOf("Tiki", "Refund Watcher", "Watches your Shopify orders and pings you about refunds"),
    koraKt,
  );
  const pTweak = proposals.create(
    draftOf("Zibbo", "Receipts Clerk", "Files every receipt you forward into one tidy sheet", {
      outfit: { head: "cap", face: null, neck: null },
    }),
    koraKt,
  );
  const pNo = proposals.create(
    draftOf("Wumpy", "Trip Sentinel", "Watches flight prices for your trips"),
    koraKt,
  );

  const confirms = new ConfirmStore();
  const cEdit = confirms.create({
    action: { kind: "edit", blobId: popo.id, patch: { title: "Lead Researcher" } },
    blobId: popo.id,
    blobName: popo.name,
    summary: `Update ${popo.name}`,
    details: [`Title: ${popo.title} -> Lead Researcher`],
    koraThreadId: koraKt,
  });
  const cRetire = confirms.create({
    action: { kind: "retire", blobId: junip.id },
    blobId: junip.id,
    blobName: junip.name,
    summary: `Retire ${junip.name}`,
    details: ["Its threads, memory and folder are kept; Rehire brings it back."],
    koraThreadId: koraKt,
  });

  // the delegated thread's id is the UI thread id (a uuid): the job step points at it
  const popoThreadId = uuid();
  const jobStore = new JobStore();
  const step = (over) => ({
    output: null,
    state: "planned",
    threadId: null,
    brief: null,
    queuedAt: null,
    queuedReason: null,
    resultGist: null,
    finalText: null,
    outputs: [],
    startedAt: null,
    finishedAt: null,
    checkingSince: null,
    attempts: 0,
    redo: false,
    tokens: 0,
    error: null,
    dependsOn: [],
    kind: "travel",
    ...over,
  });
  const job = {
    id: "job_qa_lisbon",
    title: "Lisbon trip",
    koraThreadId: koraKt,
    createdAt: now - 20 * MIN,
    updatedAt: now - 5 * MIN,
    version: 3,
    cancelled: false,
    steps: [
      step({
        id: "s1",
        blobId: popo.id,
        blobName: popo.name,
        title: "Research neighbourhoods",
        task: "Research neighbourhoods",
        state: "done",
        threadId: popoThreadId,
        attempts: 1,
        startedAt: now - 18 * MIN,
        finishedAt: now - 8 * MIN,
        resultGist: "Alfama and Graça fit a family of four.",
        finalText: "Alfama and Graça fit a family of four.",
        outputs: [path.join(popo.workspace, "outputs", "lisbon.md")],
      }),
      step({
        id: "s2",
        blobId: junip.id,
        blobName: junip.name,
        title: "Draft the out-of-office email",
        task: "Draft the out-of-office email",
        kind: "writing",
        state: "planned",
        dependsOn: [],
      }),
      step({
        id: "s3",
        blobId: junip.id,
        blobName: junip.name,
        title: "Write the itinerary summary",
        task: "Write the itinerary summary",
        kind: "writing",
        dependsOn: ["s2"],
      }),
    ],
  };
  jobStore.add(job);
  // A second job, in its own Kora thread: ONE step parked on the user (Junip's last message is a question). The daemon restart that
  // ends this seed re-reads it (reconcile) and must leave it waiting; the needs-you spec then answers it in Junip's thread.
  const ASK = "Before I start, which dates should the itinerary cover? Please tell me.";
  const junipThreadId = uuid();
  const job2 = {
    id: "job_qa_needs",
    title: "Itinerary summary",
    koraThreadId: needsKt,
    createdAt: now - 6 * MIN,
    updatedAt: now - 2 * MIN,
    version: 2,
    cancelled: false,
    steps: [
      step({
        id: "s1",
        blobId: junip.id,
        blobName: junip.name,
        title: "Write the itinerary summary",
        task: "Write the itinerary summary",
        kind: "writing",
        state: "waiting",
        threadId: junipThreadId,
        attempts: 1,
        startedAt: now - 5 * MIN,
        resultGist: ASK,
        finalText: ASK,
      }),
    ],
  };
  jobStore.add(job2);
  // the finished step earned a delegation-log row (Kora accepted it): that is what the user's Good / Redo attaches to
  fs.rmSync(path.join(s.home, "blobs", "delegation.jsonl"), { force: true });
  const { DelegationLog } = load("blobs/delegation.js");
  new DelegationLog().append({
    jobId: job.id,
    stepId: "s1",
    blobId: popo.id,
    kind: "travel",
    title: "Research neighbourhoods",
    brief: "Research neighbourhoods in Lisbon",
    outcome: "done",
    durationMs: 10 * MIN,
    tokens: 1200,
  });
  fs.mkdirSync(path.join(popo.workspace, "outputs"), { recursive: true });
  fs.writeFileSync(
    path.join(popo.workspace, "outputs", "lisbon.md"),
    "# Lisbon\n\nAlfama and Graça.\n",
  );

  // ── thread projections ──────────────────────────────────────────────────────────────────────────────────────────
  let seq = 2000;
  const nextSeq = () => (seq += 1);
  const msg = (role, text, turnId, at) => ({
    id: `msg_${role[0]}_${uuid()}`,
    role,
    text,
    turnId: role === "assistant" ? turnId : null,
    streaming: false,
    createdAt: new Date(at).toISOString(),
    updatedAt: new Date(at).toISOString(),
  });
  const card = (payload, turnId, at, summary) => ({
    id: uuid(),
    tone: "info",
    kind: "blob.card",
    summary,
    payload,
    turnId,
    sequence: nextSeq(),
    createdAt: new Date(at).toISOString(),
  });
  const turn = [uuid(), uuid()];
  const t1 = now - 24 * MIN;
  const kMessages = [
    msg(
      "user",
      "Plan my Lisbon trip: research the neighbourhoods and draft the out-of-office email. Also build me a refund watcher.",
      null,
      t1,
    ),
    msg(
      "assistant",
      "On it. I split this between Popo and Junip, and I have an idea for a refund watcher.",
      turn[0],
      t1 + 8_000,
    ),
    msg("user", "Looks good. Anything else?", null, t1 + 15 * MIN),
    msg(
      "assistant",
      "A receipts clerk would help too. Retiring Junip is optional.",
      turn[1],
      t1 + 15 * MIN + 6_000,
    ),
  ];
  const kActivities = [
    card(jobCard(job), turn[0], t1 + 9_000, `Job: ${job.title}`),
    card(proposals.card(pHire), turn[0], t1 + 10_000, "Blob proposal: Tiki"),
    card(proposals.card(pTweak), turn[1], t1 + 15 * MIN + 7_000, "Blob proposal: Zibbo"),
    card(proposals.card(pNo), turn[1], t1 + 15 * MIN + 8_000, "Blob proposal: Wumpy"),
    card(confirms.card(cEdit), turn[1], t1 + 15 * MIN + 9_000, cEdit.summary),
    card(confirms.card(cRetire), turn[1], t1 + 15 * MIN + 10_000, cRetire.summary),
  ];
  const record = (o) => ({
    threadId: o.threadId,
    koraThreadId: o.koraThreadId,
    projectId: o.blob.id,
    cwd: o.blob.workspace,
    title: o.title,
    modelSelection: o.blob.engine,
    runtimeMode: "approval-required",
    interactionMode: "default",
    agentMode: "chat",
    branch: null,
    worktreePath: null,
    createdAt: new Date(o.messages[0].createdAt).toISOString(),
    updatedAt: o.messages.at(-1).updatedAt,
    messages: o.messages,
    activities: o.activities,
    session: null,
    latestTurn: {
      turnId: o.turn,
      state: "completed",
      requestedAt: o.messages[0].createdAt,
      startedAt: o.messages[0].createdAt,
      completedAt: o.messages.at(-1).createdAt,
      assistantMessageId: o.messages.at(-1).id,
    },
    latestUserMessageAt: o.messages.filter((m) => m.role === "user").at(-1).createdAt,
    koraSessionId: null,
    providerDriver: "claude",
    ...(o.origin ? { origin: o.origin } : {}),
  });
  const koraThreadId = uuid();
  const pMessages = [
    msg(
      "user",
      "Goal: research neighbourhoods in Lisbon for a family of four. Inputs: mid budget, May. Done: a one-page brief in outputs/lisbon.md with sources.",
      null,
      now - 18 * MIN,
    ),
    msg(
      "assistant",
      "Alfama and Graça fit a family of four. The brief is in outputs/lisbon.md.",
      turn[0],
      now - 10 * MIN,
    ),
  ];
  fs.writeFileSync(
    path.join(threadsDir, `${koraThreadId}.json`),
    JSON.stringify(
      record({
        threadId: koraThreadId,
        koraThreadId: koraKt,
        blob: kora,
        title: "Lisbon trip (QA)",
        messages: kMessages,
        activities: kActivities,
        turn: turn[1],
      }),
    ),
  );
  fs.writeFileSync(
    path.join(threadsDir, `${popoThreadId}.json`),
    JSON.stringify(
      record({
        threadId: popoThreadId,
        koraThreadId: popoKt,
        blob: popo,
        title: "Neighbourhood research (from Kora)",
        messages: pMessages,
        activities: [],
        turn: turn[0],
        origin: {
          kind: "kora",
          jobId: job.id,
          stepId: "s1",
          fromThreadId: koraKt,
          fromBlobId: kora.id,
        },
      }),
    ),
  );

  const nMessages = [
    msg("user", "Write the itinerary summary for the Lisbon trip.", null, now - 6 * MIN),
    msg("assistant", ASK, turn[1], now - 5 * MIN),
  ];
  const needsThreadId = uuid();
  fs.writeFileSync(
    path.join(threadsDir, `${needsThreadId}.json`),
    JSON.stringify(
      record({
        threadId: needsThreadId,
        koraThreadId: needsKt,
        blob: kora,
        title: "Needs you (QA)",
        messages: [
          msg("user", "Get the itinerary summary written.", null, now - 7 * MIN),
          msg("assistant", "Junip is on it.", turn[1], now - 6 * MIN + 5_000),
        ],
        activities: [card(jobCard(job2), turn[1], now - 6 * MIN + 6_000, `Job: ${job2.title}`)],
        turn: turn[1],
      }),
    ),
  );
  fs.writeFileSync(
    path.join(threadsDir, `${junipThreadId}.json`),
    JSON.stringify(
      record({
        threadId: junipThreadId,
        koraThreadId: junipKt,
        blob: junip,
        title: "Itinerary summary (from Kora)",
        messages: nMessages,
        activities: [],
        turn: turn[1],
        origin: {
          kind: "kora",
          jobId: job2.id,
          stepId: "s1",
          fromThreadId: needsKt,
          fromBlobId: kora.id,
        },
      }),
    ),
  );

  ctl("start");
  const out = {
    stack: n,
    kora: kora.id,
    popo: { id: popo.id, name: popo.name, title: popo.title, workspace: popo.workspace },
    junip: { id: junip.id, name: junip.name, workspace: junip.workspace },
    koraThreadId,
    popoThreadId,
    koraKt,
    jobId: job.id,
    needsThreadId,
    junipThreadId,
    needsJobId: job2.id,
    proposals: { hire: pHire.id, tweak: pTweak.id, dismiss: pNo.id },
    confirms: { edit: cEdit.id, retire: cRetire.id },
    names: { hire: "Tiki", tweak: "Zibbo", dismiss: "Wumpy" },
  };
  fs.writeFileSync(seedFile, JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify(out));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
