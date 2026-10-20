// @effect-diagnostics nodeBuiltinImport:off -- the migration runs over plain folders; the tests build them in a temp dir.
// @effect-diagnostics globalDate:off -- fixed clocks are injected; Date is only used to name temp files.
// The Chat -> Kora migration (chatMigration.ts): the pure parts (memory lines, cadences, copy), then the whole run on a
// fixture chat store with fake collaborators: projects -> blobs, General -> Kora, idempotence, resume, dry run, backup.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import type { BlobProfile } from "@kora/contracts";

import {
  buildPlan,
  cadenceToRoutine,
  copyTree,
  instructionsOf,
  migrationModeFromEnv,
  parseMemoryLines,
  renderNotice,
  runChatMigration,
  type LegacyProjectHead,
  type LegacyThread,
  type MigrationEngine,
} from "./chatMigration.ts";
import type { KoraBlobsLike } from "./host.ts";

const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-chatmig-"));
const write = (file: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
};
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

// ── pure parts ─────────────────────────────────────────────────────────────────────────────────────────────────

NodeTest.test(
  "memory.md: facts survive; headings, fences, comments, placeholders, duplicates and noise do not",
  () => {
    const raw = [
      "# Memory",
      "",
      "<!-- agent-maintained -->",
      "## Preferences",
      "- Prefers short bullet summaries",
      "* Likes tea, not coffee",
      "1. Budget is about 2000 euros",
      "- [ ] book the flights",
      "- (none yet)",
      "_none_",
      "TBD",
      "---",
      "```",
      "code that is not a memory",
      "```",
      "- Prefers short bullet summaries", // duplicate
      "- ok", // too short
      "> The user lives in Lisbon",
      "-",
      "A very long note. " + "It keeps going and going and going and going. ".repeat(10),
    ].join("\n");
    const { facts } = parseMemoryLines(raw);
    NodeAssert.ok(facts.includes("Prefers short bullet summaries"));
    NodeAssert.equal(
      facts.filter((f) => f === "Prefers short bullet summaries").length,
      1,
      "deduped",
    );
    NodeAssert.ok(facts.includes("Likes tea, not coffee"));
    NodeAssert.ok(facts.includes("Budget is about 2000 euros"));
    NodeAssert.ok(facts.includes("book the flights"), "a checkbox prefix is stripped");
    NodeAssert.ok(facts.includes("The user lives in Lisbon"), "a quote marker is stripped");
    NodeAssert.ok(
      !facts.some((f) => /code that is not a memory|none|TBD|agent-maintained|Memory$/i.test(f)),
    );
    NodeAssert.ok(
      facts.every((f) => f.length <= 300),
      "every fact fits the memory module's limit",
    );
    NodeAssert.ok(
      facts.some((f) => f.startsWith("A very long note.")),
      "a long line is split at sentence ends",
    );
    NodeAssert.ok(!facts.includes("ok"), "a too-short line is noise, not a memory");
  },
);

NodeTest.test(
  "memory.md: a single sentence over the limit is skipped and reported; noise is dropped quietly",
  () => {
    const { facts, skipped } = parseMemoryLines("x".repeat(400));
    NodeAssert.deepEqual(facts, []);
    NodeAssert.equal(skipped.length, 1);
    NodeAssert.deepEqual(parseMemoryLines("- ok\n- (none yet)\n- TBD\n"), {
      facts: [],
      skipped: [],
    });
  },
);

NodeTest.test("schedules: every Chat cadence maps onto a routine cadence", () => {
  const tz = "Europe/Lisbon";
  NodeAssert.deepEqual(
    cadenceToRoutine({ kind: "hourly", time: "09:30", weekday: null, at: null }, tz),
    { kind: "cron", expr: "30 * * * *", tz },
  );
  NodeAssert.deepEqual(
    cadenceToRoutine({ kind: "daily", time: "07:05", weekday: null, at: null }, tz),
    { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "07:05", tz },
  );
  NodeAssert.deepEqual(
    cadenceToRoutine({ kind: "weekdays", time: "18:00", weekday: null, at: null }, tz),
    { kind: "weekly", days: [1, 2, 3, 4, 5], time: "18:00", tz },
  );
  NodeAssert.deepEqual(
    cadenceToRoutine({ kind: "weekly", time: "08:00", weekday: 3, at: null }, tz),
    { kind: "weekly", days: [3], time: "08:00", tz },
  );
  NodeAssert.deepEqual(
    cadenceToRoutine({ kind: "once", time: null, weekday: null, at: 1234 }, tz),
    { kind: "once", at: 1234 },
  );
  NodeAssert.equal(
    cadenceToRoutine({ kind: "once", time: null, weekday: null, at: null }, tz),
    null,
  );
  NodeAssert.equal(cadenceToRoutine({ kind: "fortnightly" }, tz), null);
  NodeAssert.equal(cadenceToRoutine(undefined, tz), null);
  NodeAssert.deepEqual(
    cadenceToRoutine({ kind: "daily", time: "garbage", weekday: null, at: null }, tz),
    { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "09:00", tz },
    "an unreadable time falls back to 09:00 like Chat did",
  );
});

NodeTest.test(
  "PROJECT.md: the default '# Title' heading is not instructions; real ones are kept",
  () => {
    NodeAssert.equal(instructionsOf("# Trip\n\n", "Trip"), "");
    NodeAssert.equal(
      instructionsOf("# Trip\n\nAlways answer in Portuguese.\n", "Trip"),
      "Always answer in Portuguese.",
    );
    NodeAssert.equal(instructionsOf("Be terse.\n", "Trip"), "Be terse.");
    NodeAssert.equal(
      instructionsOf("# Other heading\nBe terse.", "Trip"),
      "# Other heading\nBe terse.",
    );
  },
);

NodeTest.test(
  "copyTree never overwrites: a different file keeps its name, the newcomer is renamed and reported",
  () => {
    const a = tmp();
    const b = tmp();
    write(NodePath.join(a, "report.md"), "from chat");
    write(NodePath.join(a, "sub", "data.csv"), "1,2");
    write(NodePath.join(a, "same.txt"), "same");
    write(NodePath.join(a, ".hidden"), "x");
    write(NodePath.join(b, "report.md"), "already here");
    write(NodePath.join(b, "same.txt"), "same");
    const r = copyTree(a, b);
    NodeAssert.equal(NodeFS.readFileSync(NodePath.join(b, "report.md"), "utf8"), "already here");
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(b, "report (from Chat).md"), "utf8"),
      "from chat",
    );
    NodeAssert.equal(NodeFS.readFileSync(NodePath.join(b, "sub", "data.csv"), "utf8"), "1,2");
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(b, ".hidden")));
    NodeAssert.equal(r.copied, 2);
    NodeAssert.equal(r.kept, 1, "the identical file counts as kept");
    NodeAssert.deepEqual(r.renamed, [
      [NodePath.join(a, "report.md"), NodePath.join(b, "report (from Chat).md")],
    ]);
    // a second copy changes nothing
    const again = copyTree(a, b);
    NodeAssert.equal(again.copied, 0);
  },
);

NodeTest.test("KORA_CHAT_MIGRATION: run by default, dry-run and off on request", () => {
  NodeAssert.equal(migrationModeFromEnv({}), "run");
  NodeAssert.equal(migrationModeFromEnv({ KORA_CHAT_MIGRATION: "dry-run" }), "dry-run");
  NodeAssert.equal(migrationModeFromEnv({ KORA_CHAT_MIGRATION: "OFF" }), "off");
  NodeAssert.equal(migrationModeFromEnv({ KORA_CHAT_MIGRATION: "whatever" }), "run");
});

// ── fixture + fakes ────────────────────────────────────────────────────────────────────────────────────────────

interface FakeThread extends LegacyThread {
  transcript: string;
}

function fakeWorld(opts: { failMove?: (id: string) => boolean; failNotice?: boolean } = {}) {
  const home = tmp();
  const blobsRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-chatmig-blobs-"));
  const chats = NodePath.join(home, "chats");

  // Chat store: General + two projects (one with everything, one bare)
  write(NodePath.join(chats, "general", "outputs", "pineapple.md"), "# pineapples");
  write(NodePath.join(chats, "general", "scratch", "s1", "report.md"), "scratch");
  write(
    NodePath.join(chats, "projects", "trip-planning", "PROJECT.md"),
    "# Trip Planning\n\nPlan a week in Lisbon. Always answer in Portuguese.\n",
  );
  write(
    NodePath.join(chats, "projects", "trip-planning", "memory.md"),
    "# Memory\n- Prefers trams to taxis\n- Budget is 2000 euros\n- (none yet)\n- api key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA\n",
  );
  write(NodePath.join(chats, "projects", "trip-planning", "files", "passport-notes.txt"), "notes");
  write(NodePath.join(chats, "projects", "trip-planning", "outputs", "itinerary.md"), "# Day 1");
  write(
    NodePath.join(chats, "projects", "trip-planning", "schedules.json"),
    JSON.stringify([
      {
        id: "s-a",
        title: "Morning brief",
        prompt: "Summarise the weather",
        cadence: { kind: "weekdays", time: "08:00", weekday: null, at: null },
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
        lastThreadId: "t-trip-2",
      },
      {
        id: "s-b",
        title: "Weekly review",
        prompt: "Review the plan",
        cadence: { kind: "weekly", time: "17:00", weekday: 5, at: null },
        enabled: false,
        lastRunAt: null,
        nextRunAt: null,
        lastThreadId: null,
      },
      { id: "s-c", title: "Broken", prompt: "", cadence: { kind: "yearly" }, enabled: true },
    ]),
  );
  write(NodePath.join(chats, "projects", "bare", "PROJECT.md"), "# Kora\n");
  write(NodePath.join(chats, "projects", "bare", "memory.md"), "");
  write(NodePath.join(home, "chat", "t_runtime", "meta.json"), "{}");
  write(NodePath.join(home, "kora-daemon", "projects.json"), "[]");

  const trip = NodePath.join(chats, "projects", "trip-planning");
  const threads: FakeThread[] = [
    {
      threadId: "t-gen-1",
      projectId: "chat-general",
      cwd: NodePath.join(chats, "general"),
      title: "pineapples",
      archived: false,
      running: false,
      transcript: `see ${NodePath.join(chats, "general", "outputs", "pineapple.md")}`,
    },
    {
      threadId: "t-gen-2",
      projectId: "chat-general",
      cwd: NodePath.join(chats, "general"),
      title: "old",
      archived: true,
      running: false,
      transcript: "no paths",
    },
    {
      threadId: "t-trip-1",
      projectId: "p-trip",
      cwd: trip,
      title: "flights",
      archived: false,
      running: false,
      transcript: `file ${NodePath.join(trip, "outputs", "itinerary.md")}`,
    },
    {
      threadId: "t-trip-2",
      projectId: "p-trip",
      cwd: trip,
      title: "hotels",
      archived: false,
      running: false,
      transcript: "x",
    },
    {
      threadId: "t-code",
      projectId: "code-1",
      cwd: "/Users/someone/repo",
      title: "not chat",
      archived: false,
      running: false,
      transcript: "code",
    },
  ];
  const heads: LegacyProjectHead[] = [
    {
      id: "chat-general",
      title: "General",
      workspaceRoot: NodePath.join(chats, "general"),
      engine: null,
    },
    {
      id: "p-trip",
      title: "Trip Planning",
      workspaceRoot: trip,
      engine: { instanceId: "claude", model: "haiku", effort: null },
    },
    { id: "code-1", title: "repo", workspaceRoot: "/Users/someone/repo", engine: null },
  ];
  const dropped: string[] = [];
  const notices: Array<{ blobId: string; title: string; text: string }> = [];
  const moves: Array<{ threadId: string; blobId: string }> = [];
  const engine: MigrationEngine = {
    legacyProjects: (isLegacy) =>
      heads.filter((h) => isLegacy(h.workspaceRoot) && !dropped.includes(h.id)),
    legacyThreads: (isLegacy) => threads.filter((t) => isLegacy(t.cwd)),
    upsertBlobProject: () => {},
    moveThread: async (threadId, blob, rewrites) => {
      const t = threads.find((x) => x.threadId === threadId)!;
      if (opts.failMove?.(threadId))
        return { moved: false, transcriptCopied: false, reason: "it is running right now" };
      for (const [from, to] of rewrites) t.transcript = t.transcript.split(from).join(to);
      t.cwd = blob.workspace;
      t.projectId = blob.id;
      moves.push({ threadId, blobId: blob.id });
      return { moved: true, transcriptCopied: threadId === "t-trip-1" };
    },
    dropProject: (id) => {
      if (!threads.some((t) => t.projectId === id)) dropped.push(id);
    },
    postNotice: (blobId, title, text) => {
      if (opts.failNotice) throw new Error("notice boom");
      notices.push({ blobId, title, text });
      return `t-notice-${notices.length}`;
    },
    threadExists: (id) =>
      threads.some((t) => t.threadId === id) || notices.some((_, i) => `t-notice-${i + 1}` === id),
  };

  // blobs runtime fakes
  const profiles = new Map<string, BlobProfile>();
  let n = 0;
  const mk = (id: string, name: string, role: "chief" | "member"): BlobProfile => {
    const workspace = NodePath.join(blobsRoot, name.replace(/\W+/g, "-"));
    for (const d of ["files", "outputs", "scratch"])
      NodeFS.mkdirSync(NodePath.join(workspace, d), { recursive: true });
    return {
      id,
      version: 1,
      name,
      title: role === "chief" ? "Chief" : "x",
      role,
      teamId: "default",
      engine: { instanceId: "claude", model: "sonnet", effort: null },
      permission: "auto",
      outfit: null,
      toolGrants: {
        apps: { mode: "none", allow: [] },
        mcp: [],
        computer: { browser: false, vm: false },
      },
      slug: name,
      workspace,
      templateId: null,
      pinned: false,
      hidden: false,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as BlobProfile;
  };
  profiles.set("blob_kora", mk("blob_kora", "Kora", "chief"));
  const souls = new Map<string, string>();
  const facts: Array<{ scope: string; blobId?: string; text: string }> = [];
  const routines: Array<Record<string, unknown>> = [];
  let kora: KoraBlobsLike["store"] | null = null;
  const store = {
    list: () => [...profiles.values()],
    get: (id: string) => profiles.get(id) ?? null,
    create: (i: { name: string; title: string; soul: string; engine: BlobProfile["engine"] }) => {
      if (
        [...profiles.values()].some(
          (b) => b.name.toLowerCase() === i.name.toLowerCase() && !b.archivedAt,
        )
      )
        throw new Error(`${i.name} is already on the team`);
      const p = mk(`blob_t${++n}`, i.name, "member");
      (p as { engine: unknown }).engine = i.engine;
      (p as { title: string }).title = i.title;
      profiles.set(p.id, p);
      souls.set(p.id, i.soul);
      return p;
    },
    defaults: () => ({ engine: null, permission: "auto", soulTemplate: "" }),
  };
  kora = store as unknown as KoraBlobsLike["store"];
  const blobs = {
    store: kora,
    memory: {
      listFacts: async (a?: { blobId?: string }) => facts.filter((f) => f.blobId === a?.blobId),
      addFact: async (a: { scope: string; blobId?: string; text: string }) => {
        if (/sk-ant-/.test(a.text))
          throw new Error("refusing to store what looks like a credential or ID number");
        facts.push(a);
        return a;
      },
    },
    routines: {
      create: (input: Record<string, unknown>) => {
        const cadence = input.cadence as { kind: string };
        if (cadence.kind === "weekly" && (input.title as string) === "REJECT")
          return { ok: false as const, message: "nope" };
        routines.push(input);
        return { ok: true as const, value: { id: `rt${routines.length}` } };
      },
    },
  } as unknown as KoraBlobsLike;
  return {
    home,
    chats,
    blobsRoot,
    engine,
    blobs,
    threads,
    heads,
    dropped,
    notices,
    moves,
    profiles,
    souls,
    facts,
    routines,
    trip,
  };
}

const run = (w: ReturnType<typeof fakeWorld>, mode: "run" | "dry-run" | "off" = "run") =>
  runChatMigration({
    home: w.home,
    blobs: w.blobs,
    engine: w.engine,
    mode,
    now: () => NOW,
    timeZone: "Europe/Lisbon",
  });

// ── the run ────────────────────────────────────────────────────────────────────────────────────────────────────

NodeTest.test(
  "plan: General, each project folder and every chat thread are found; code threads are not",
  () => {
    const w = fakeWorld();
    const plan = buildPlan(w.home, w.engine);
    NodeAssert.deepEqual(
      plan.map((p) => p.key),
      ["general", "projects/bare", "projects/trip-planning"],
    );
    const general = plan[0]!;
    NodeAssert.deepEqual(general.threadIds.sort(), ["t-gen-1", "t-gen-2"]);
    const trip = plan.find((p) => p.key === "projects/trip-planning")!;
    NodeAssert.equal(trip.title, "Trip Planning");
    NodeAssert.deepEqual(trip.threadIds.sort(), ["t-trip-1", "t-trip-2"]);
    NodeAssert.equal(trip.folder?.files, 1);
    NodeAssert.equal(trip.folder?.schedules.length, 3);
    NodeAssert.ok(!plan.some((p) => p.threadIds.includes("t-code")));
  },
);

NodeTest.test(
  "a project becomes a blob: name, SOUL, memory facts, routines, files, threads; General goes under Kora",
  async () => {
    const w = fakeWorld();
    const out = await run(w);
    NodeAssert.equal(out.status, "done");

    // the blob
    const tripBlob = [...w.profiles.values()].find((b) => b.name === "Trip Planning")!;
    NodeAssert.ok(tripBlob, "named after the project");
    NodeAssert.deepEqual(
      tripBlob.engine,
      { instanceId: "claude", model: "haiku", effort: null },
      "keeps the model the project's chats used",
    );
    const soul = w.souls.get(tripBlob.id)!;
    NodeAssert.match(soul, /Trip Planning/);
    NodeAssert.match(soul, /Always answer in Portuguese/);
    NodeAssert.ok(
      !/^# Trip Planning/m.test(soul.split("Standing brief")[1] ?? ""),
      "the duplicate heading is not copied into the brief",
    );

    // a project whose PROJECT.md heading clashes with an existing blob name is de-duplicated, never merged
    const bare = [...w.profiles.values()].find((b) => b.name === "Kora (Chat)");
    NodeAssert.ok(bare, "a project titled 'Kora' becomes 'Kora (Chat)'");
    NodeAssert.match(w.souls.get(bare!.id)!, /no written instructions/);

    // memory
    const facts = w.facts
      .filter((f) => f.blobId === tripBlob.id)
      .map((f) => f.text)
      .sort();
    NodeAssert.deepEqual(facts, ["Budget is 2000 euros", "Prefers trams to taxis"]);
    NodeAssert.equal(
      w.facts.every((f) => f.scope === "blob"),
      true,
    );

    // routines: cadence + enabled state, results thread = the schedule's last thread, else the project's newest
    NodeAssert.equal(w.routines.length, 2);
    const brief = w.routines.find((r) => r.title === "Morning brief")!;
    NodeAssert.deepEqual(brief.cadence, {
      kind: "weekly",
      days: [1, 2, 3, 4, 5],
      time: "08:00",
      tz: "Europe/Lisbon",
    });
    NodeAssert.equal(brief.paused, false);
    NodeAssert.deepEqual(brief.results, { mode: "thread", threadId: "t-trip-2" });
    NodeAssert.equal(brief.blobId, tripBlob.id);
    const review = w.routines.find((r) => r.title === "Weekly review")!;
    NodeAssert.equal(review.paused, true, "a disabled schedule arrives paused");
    NodeAssert.deepEqual(
      review.results,
      { mode: "thread", threadId: "t-trip-1" },
      "no last thread -> the project's newest chat",
    );

    // files + transcripts
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(tripBlob.workspace, "outputs", "itinerary.md"), "utf8"),
      "# Day 1",
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(tripBlob.workspace, "files", "passport-notes.txt"), "utf8"),
      "notes",
    );
    NodeAssert.deepEqual(
      w.moves
        .filter((m) => m.blobId === tripBlob.id)
        .map((m) => m.threadId)
        .sort(),
      ["t-trip-1", "t-trip-2"],
    );
    const t1 = w.threads.find((t) => t.threadId === "t-trip-1")!;
    NodeAssert.equal(
      t1.transcript,
      `file ${NodePath.join(tripBlob.workspace, "outputs", "itinerary.md")}`,
      "output paths follow the files",
    );
    NodeAssert.equal(t1.cwd, tripBlob.workspace);

    // General -> Kora
    const koraWs = w.profiles.get("blob_kora")!.workspace;
    NodeAssert.deepEqual(
      w.moves
        .filter((m) => m.blobId === "blob_kora")
        .map((m) => m.threadId)
        .sort(),
      ["t-gen-1", "t-gen-2"],
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(koraWs, "outputs", "pineapple.md"), "utf8"),
      "# pineapples",
    );
    NodeAssert.equal(
      w.threads.find((t) => t.threadId === "t-gen-1")!.transcript,
      `see ${NodePath.join(koraWs, "outputs", "pineapple.md")}`,
    );
    NodeAssert.ok(
      !NodeFS.existsSync(NodePath.join(koraWs, "scratch", "s1")),
      "worker scratch is left in the backup",
    );

    // the code thread is untouched
    NodeAssert.equal(w.threads.find((t) => t.threadId === "t-code")!.projectId, "code-1");
    NodeAssert.deepEqual(w.dropped.sort(), ["chat-general", "p-trip"]);
  },
);

NodeTest.test(
  "backup first, nothing deleted: chats/ is renamed to chats.migrated-<date>, stores are copied",
  async () => {
    const w = fakeWorld();
    const out = await run(w);
    NodeAssert.equal(
      out.report?.archivedChatsDir,
      NodePath.join(w.home, "chats.migrated-2026-10-10"),
    );
    NodeAssert.ok(!NodeFS.existsSync(w.chats), "the old folder is gone from its old place...");
    NodeAssert.equal(
      NodeFS.readFileSync(
        NodePath.join(
          w.home,
          "chats.migrated-2026-10-10",
          "projects",
          "trip-planning",
          "memory.md",
        ),
        "utf8",
      ).includes("Prefers trams"),
      true,
      "...but kept whole",
    );
    const backup = out.report!.backupDir!;
    NodeAssert.ok(
      NodeFS.existsSync(NodePath.join(backup, "chat", "t_runtime", "meta.json")),
      "the chat store is backed up",
    );
    NodeAssert.ok(
      NodeFS.existsSync(NodePath.join(backup, "kora-daemon", "projects.json")),
      "the read models are backed up",
    );
    NodeAssert.ok(
      NodeFS.existsSync(NodePath.join(backup, "chats", "general", "outputs", "pineapple.md")),
      "the chats folder is backed up",
    );
    NodeAssert.ok(
      NodeFS.existsSync(NodePath.join(w.home, "chat-migration.json")),
      "the marker is written",
    );
  },
);

NodeTest.test("the notice lists what moved and everything that could not", async () => {
  const w = fakeWorld();
  const out = await run(w);
  NodeAssert.equal(w.notices.length, 1);
  const n = w.notices[0]!;
  NodeAssert.equal(n.blobId, "blob_kora");
  NodeAssert.equal(n.title, "Moved your Chat projects into Kora");
  NodeAssert.match(n.text, /\*\*Trip Planning\*\* is now a blob called \*\*Trip Planning\*\*/);
  NodeAssert.match(n.text, /General\*\* chats are now chats with me/);
  NodeAssert.match(n.text, /could not move/);
  NodeAssert.match(n.text, /routine "Broken" has no readable/);
  NodeAssert.match(n.text, /credential/, "the refused memory line is named");
  NodeAssert.match(n.text, /Nothing was deleted/);
  NodeAssert.equal(renderNotice(out.report!), n.text);
});

NodeTest.test(
  "idempotent: a second run is a no-op (no second blob, fact, routine, notice or backup)",
  async () => {
    const w = fakeWorld();
    await run(w);
    const blobsBefore = w.profiles.size;
    const factsBefore = w.facts.length;
    const routinesBefore = w.routines.length;
    const backups = NodeFS.readdirSync(w.home).filter((f) =>
      f.startsWith("chat-migration-backup-"),
    ).length;
    const again = await run(w);
    NodeAssert.equal(again.status, "already");
    NodeAssert.equal(w.profiles.size, blobsBefore);
    NodeAssert.equal(w.facts.length, factsBefore);
    NodeAssert.equal(w.routines.length, routinesBefore);
    NodeAssert.equal(w.notices.length, 1);
    NodeAssert.equal(
      NodeFS.readdirSync(w.home).filter((f) => f.startsWith("chat-migration-backup-")).length,
      backups,
    );
  },
);

NodeTest.test("a run cut short resumes from its journal: nothing is made twice", async () => {
  const w = fakeWorld({ failNotice: true });
  await NodeAssert.rejects(run(w), /notice boom/); // dies after the work, before the marker
  const blobsAfterCrash = w.profiles.size;
  const factsAfterCrash = w.facts.length;
  const routinesAfterCrash = w.routines.length;
  NodeAssert.ok(
    !NodeFS.existsSync(NodePath.join(w.home, "chat-migration.json")),
    "no marker: the next start retries",
  );
  NodeAssert.ok(NodeFS.existsSync(w.chats), "the old folder is still where it was");

  // next start: the notice works now
  (w.engine as { postNotice: MigrationEngine["postNotice"] }).postNotice = (
    blobId,
    title,
    text,
  ) => {
    w.notices.push({ blobId, title, text });
    return "t-notice-1";
  };
  const out = await run(w);
  NodeAssert.equal(out.status, "done");
  NodeAssert.equal(w.profiles.size, blobsAfterCrash, "no blob twice");
  NodeAssert.equal(w.facts.length, factsAfterCrash, "no fact twice");
  NodeAssert.equal(w.routines.length, routinesAfterCrash, "no routine twice");
  NodeAssert.equal(w.notices.length, 1);
  NodeAssert.match(
    w.notices[0]!.text,
    /\*\*Trip Planning\*\* is now a blob/,
    "the report still counts what the first run did",
  );
  NodeAssert.match(w.notices[0]!.text, /2 chats/);
});

NodeTest.test(
  "dry run reports the plan and changes nothing: no blob, no backup, no marker, folders intact",
  async () => {
    const w = fakeWorld();
    const out = await run(w, "dry-run");
    NodeAssert.equal(out.status, "dry-run");
    NodeAssert.equal(w.profiles.size, 1, "only Kora");
    NodeAssert.equal(w.moves.length, 0);
    NodeAssert.equal(w.notices.length, 0);
    NodeAssert.ok(NodeFS.existsSync(w.chats));
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(w.home, "chat-migration.json")));
    NodeAssert.deepEqual(
      NodeFS.readdirSync(w.home).filter((f) => f.startsWith("chat-migration-backup-")),
      [],
    );
    const report = JSON.parse(
      NodeFS.readFileSync(NodePath.join(w.home, "chat-migration.dry-run.json"), "utf8"),
    );
    NodeAssert.equal(report.mode, "dry-run");
    NodeAssert.equal(report.plan.length, 3);
    NodeAssert.equal(
      report.plan.find((p: { key: string }) => p.key === "projects/trip-planning").threads,
      2,
    );
    // and a real run afterwards still works
    NodeAssert.equal((await run(w)).status, "done");
  },
);

NodeTest.test("mode off does nothing and marks nothing", async () => {
  const w = fakeWorld();
  NodeAssert.equal((await run(w, "off")).status, "off");
  NodeAssert.ok(!NodeFS.existsSync(NodePath.join(w.home, "chat-migration.json")));
  NodeAssert.ok(NodeFS.existsSync(w.chats));
});

NodeTest.test(
  "a chat that cannot move is listed, its project is kept, and chats/ stays where it is",
  async () => {
    const w = fakeWorld({ failMove: (id) => id === "t-trip-2" });
    const out = await run(w);
    NodeAssert.equal(out.status, "partial");
    NodeAssert.ok(NodeFS.existsSync(w.chats), "not archived: something is still there");
    NodeAssert.ok(
      !w.dropped.includes("p-trip"),
      "the project head stays while it still has a chat",
    );
    NodeAssert.ok(w.dropped.includes("chat-general"));
    NodeAssert.match(w.notices[0]!.text, /chat t-trip-2: it is running right now/);
    const marker = JSON.parse(
      NodeFS.readFileSync(NodePath.join(w.home, "chat-migration.json"), "utf8"),
    );
    NodeAssert.equal(marker.status, "partial");
  },
);

NodeTest.test(
  "nothing to migrate (a fresh install): marked done quietly, no blob, no notice",
  async () => {
    const w = fakeWorld();
    NodeFS.rmSync(w.chats, { recursive: true });
    w.threads.length = 0;
    w.heads.length = 0;
    const out = await run(w);
    NodeAssert.equal(out.status, "nothing");
    NodeAssert.equal(w.notices.length, 0);
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(w.home, "chat-migration.json")));
    NodeAssert.equal((await run(w)).status, "already");
  },
);

NodeTest.test("deferred until Kora exists (no marker, so the next start retries)", async () => {
  const w = fakeWorld();
  w.profiles.delete("blob_kora");
  NodeAssert.equal((await run(w)).status, "deferred");
  NodeAssert.ok(!NodeFS.existsSync(NodePath.join(w.home, "chat-migration.json")));
  NodeAssert.equal(w.profiles.size, 0);
});

NodeTest.test(
  "an orphan project folder (no project head, no chats) still becomes a blob",
  async () => {
    const w = fakeWorld();
    w.threads.length = 0;
    w.heads.length = 0;
    const out = await run(w);
    NodeAssert.equal(out.status, "done");
    NodeAssert.ok([...w.profiles.values()].some((b) => b.name === "Trip Planning"));
    NodeAssert.equal(w.routines.length, 2);
    const brief = w.routines.find((r) => r.title === "Morning brief")!;
    NodeAssert.deepEqual(
      brief.results,
      { mode: "dedicated", threadId: null },
      "no chat to report into yet",
    );
  },
);

NodeTest.test(
  "a project head whose folder is gone still moves its chats, into a blob named after the head",
  async () => {
    const w = fakeWorld();
    NodeFS.rmSync(NodePath.join(w.chats, "projects", "trip-planning"), { recursive: true });
    const out = await run(w);
    NodeAssert.equal(out.status, "done");
    const blob = [...w.profiles.values()].find(
      (b) => b.name === "trip-planning" || b.name === "Trip Planning",
    );
    NodeAssert.ok(blob);
    NodeAssert.deepEqual(
      w.moves
        .filter((m) => m.blobId === blob!.id)
        .map((m) => m.threadId)
        .sort(),
      ["t-trip-1", "t-trip-2"],
    );
  },
);

NodeTest.test("an empty General is not mentioned in the notice", async () => {
  const w = fakeWorld();
  w.threads.splice(0, w.threads.length, ...w.threads.filter((t) => t.projectId !== "chat-general"));
  NodeFS.rmSync(NodePath.join(w.chats, "general"), { recursive: true });
  await run(w);
  NodeAssert.doesNotMatch(w.notices[0]!.text, /General/);
  NodeAssert.match(w.notices[0]!.text, /Trip Planning/);
});

NodeTest.test(
  "a new blob's model: the project's own, else the user's default, else the best installed, else Kora's",
  async () => {
    const engineOf = async (
      setup: (w: ReturnType<typeof fakeWorld>) => void,
      bestEngine?: () => { instanceId: string; model: string; effort: null } | null,
    ) => {
      const w = fakeWorld();
      w.heads.find((h) => h.id === "p-trip")!.engine = null;
      setup(w);
      await runChatMigration({
        home: w.home,
        blobs: w.blobs,
        engine: w.engine,
        mode: "run",
        now: () => NOW,
        timeZone: "UTC",
        ...(bestEngine ? { bestEngine } : {}),
      });
      return [...w.profiles.values()].find((b) => b.name === "Trip Planning")!.engine;
    };
    const best = { instanceId: "claude", model: "sonnet", effort: null } as const;
    NodeAssert.deepEqual(
      await engineOf(
        () => {},
        () => best,
      ),
      best,
      "best installed (Sonnet, never the CLI default)",
    );
    NodeAssert.deepEqual(
      await engineOf(() => {}),
      { instanceId: "claude", model: "sonnet", effort: null },
      "Kora's own engine when nothing else is known",
    );
    const mine = { instanceId: "codex", model: "gpt-5", effort: null };
    NodeAssert.deepEqual(
      await engineOf(
        (w) => {
          (w.blobs.store as { defaults: () => unknown }).defaults = () => ({
            engine: mine,
            permission: "ask",
            soulTemplate: "",
          });
        },
        () => best,
      ),
      mine,
      "the user's Settings > Kora defaults win over best installed",
    );
  },
);
