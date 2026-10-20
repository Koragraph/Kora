import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AgentProfileId } from "./agentProfile.ts";
import { DispatchCommandId, ProjectId, ThreadId } from "./primitives.ts";
import * as Chat from "./chat.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AT = "2025-11-20T09:30:00.000Z";
const LATER = "2025-11-21T09:30:00.000Z";
const THREAD = "th-main";
const PROJECT = "pj-main";
const REPO = "octo/site";
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;

const fails = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), Exit.isFailure);

const optionValue = (
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
) => options?.find((entry) => entry.id === id)?.value;

const decodeCommand = Schema.decodeUnknownEffect(Chat.ChatCommand);
const decodeClientCommand = Schema.decodeUnknownEffect(Chat.ClientChatCommand);
const decodeEvent = Schema.decodeUnknownEffect(Chat.ThreadEvent);
const decodeTurnStart = Schema.decodeUnknownEffect(Chat.ThreadTurnStartCommand);
const decodeMessage = Schema.decodeUnknownEffect(Chat.ThreadMessage);
const decodeThreadCreated = Schema.decodeUnknownEffect(Chat.ThreadCreatedPayload);
const decodeProjectCreated = Schema.decodeUnknownEffect(Chat.ProjectCreatedPayload);
const decodeThreadMeta = Schema.decodeUnknownEffect(Chat.ThreadMetaUpdatedPayload);
const decodeTurnRequested = Schema.decodeUnknownEffect(Chat.ThreadTurnStartRequestedPayload);
const decodeHead = Schema.decodeUnknownEffect(Chat.ChatThreadHead);

/** A user message as sent inside turn.start. */
const userMessage = (messageId: string, extra: Record<string, unknown> = {}) => ({
  messageId,
  role: "user",
  text: "hi there",
  attachments: [],
  ...extra,
});

/** A minimal turn.start command; callers add what the case is about. */
const turnStart = (commandId: string, extra: Record<string, unknown> = {}) => ({
  type: "turn.start",
  commandId,
  threadId: THREAD,
  message: userMessage(`m-${commandId}`),
  createdAt: AT,
  ...extra,
});

/** The envelope every persisted thread event carries. */
const threadEvent = (
  sequence: number,
  type: string,
  commandId: string,
  payload: Record<string, unknown>,
  occurredAt = AT,
) => ({
  sequence,
  eventId: `ev-${commandId}`,
  aggregateKind: "thread",
  aggregateId: THREAD,
  type,
  occurredAt,
  commandId,
  causationEventId: null,
  correlationId: commandId,
  metadata: {},
  payload,
});

/** Stored message fields shared by message decoders. */
const storedMessage = (extra: Record<string, unknown>) => ({
  role: "user",
  text: "see attached",
  turnId: null,
  streaming: false,
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const codexPick = { provider: "codex", model: "gpt-5.5" };

const threadCreated = (extra: Record<string, unknown> = {}) => ({
  threadId: THREAD,
  projectId: PROJECT,
  title: "A thread",
  modelSelection: codexPick,
  branch: null,
  worktreePath: null,
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const projectCreated = (extra: Record<string, unknown> = {}) => ({
  projectId: PROJECT,
  title: "A project",
  workspaceRoot: "/srv/site",
  scripts: [],
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

/** Fields a thread snapshot and a thread head share. */
const threadCore = {
  id: THREAD,
  projectId: PROJECT,
  title: "Old thread",
  session: null,
  latestTurn: null,
  worktreePath: null,
  branch: null,
  archivedAt: null,
  interactionMode: "default",
  runtimeMode: "full-access",
  modelSelection: codexPick,
  updatedAt: AT,
  createdAt: AT,
};

/** host + repository + number + url of a link in REPO. */
const linkKey = (number: number) => ({
  host: "github.com",
  repository: REPO,
  number,
  url: prUrl(number),
});

const headOnly = {
  hasActionableProposedPlan: false,
  hasPendingUserInput: false,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
};

// ---------------------------------------------------------------------------
// Errors and diffs
// ---------------------------------------------------------------------------

describe("dispatch errors", () => {
  it.effect("keep the bootstrap thread disposition", () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknownEffect(Chat.ChatDispatchError)({
        _tag: "ChatDispatchError",
        bootstrapThreadDisposition: "deleted",
        message: "worktree could not be created",
      });
      assert.strictEqual(error.bootstrapThreadDisposition, "deleted");
    }),
  );
});

describe("diff inputs", () => {
  const range = (fromTurnCount: number, toTurnCount: number) => ({
    threadId: THREAD,
    fromTurnCount,
    toTurnCount,
  });
  const turnDiff = Schema.decodeUnknownEffect(Chat.ChatGetTurnDiffInput);

  it.effect("accept an ascending range and the whitespace switch", () =>
    Effect.gen(function* () {
      const plain = yield* turnDiff(range(2, 5));
      assert.deepStrictEqual([plain.fromTurnCount, plain.toTurnCount], [2, 5]);
      const loose = yield* turnDiff({ ...range(2, 5), ignoreWhitespace: true });
      assert.isTrue(loose.ignoreWhitespace);
      const full = yield* Schema.decodeUnknownEffect(Chat.ChatGetFullThreadDiffInput)({
        threadId: THREAD,
        toTurnCount: 5,
        ignoreWhitespace: true,
      });
      assert.isTrue(full.ignoreWhitespace);
    }),
  );

  it.effect("reject a descending range on the input and on the diff itself", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* fails(turnDiff(range(5, 2))));
      assert.isTrue(
        yield* fails(
          Schema.decodeUnknownEffect(Chat.ThreadTurnDiff)({ ...range(5, 2), diff: "--- a" }),
        ),
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

describe("project commands and payloads", () => {
  const create = (extra: Record<string, unknown>) =>
    Schema.decodeUnknownEffect(Chat.ProjectCreateCommand)({
      type: "createProject",
      commandId: "c-create",
      projectId: PROJECT,
      title: "Site",
      workspaceRoot: "/srv/site",
      createdAt: AT,
      ...extra,
    });

  it.effect("project.create trims ids and strings at the boundary", () =>
    Effect.gen(function* () {
      const parsed = yield* create({
        commandId: "  c-create\t",
        projectId: " pj-main ",
        title: "  Site  ",
        workspaceRoot: "\t/srv/site ",
        defaultModelSelection: { provider: "codex", model: "  gpt-5.5-mini " },
      });
      assert.deepStrictEqual(
        [parsed.commandId, parsed.projectId, parsed.title, parsed.workspaceRoot],
        ["c-create", PROJECT, "Site", "/srv/site"],
      );
      assert.isUndefined(parsed.createWorkspaceRootIfMissing);
      assert.deepStrictEqual(parsed.defaultModelSelection, {
        instanceId: AgentProfileId.make("codex"),
        model: "gpt-5.5-mini",
      });
    }),
  );

  it.effect("project.create carries createWorkspaceRootIfMissing", () =>
    Effect.gen(function* () {
      assert.isTrue(
        (yield* create({ createWorkspaceRootIfMissing: true })).createWorkspaceRootIfMissing,
      );
    }),
  );

  it.effect("project.create rejects a title that trims to nothing", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* fails(create({ title: " \t " })));
    }),
  );

  it.effect("old project payloads with a provider-keyed default model still decode", () =>
    Effect.gen(function* () {
      const created = yield* decodeProjectCreated(
        projectCreated({ defaultModelSelection: codexPick }),
      );
      assert.strictEqual(created.defaultModelSelection?.instanceId, "codex");
      const meta = yield* Schema.decodeUnknownEffect(Chat.ProjectMetaUpdatedPayload)({
        projectId: PROJECT,
        defaultModelSelection: { provider: "claude", model: "claude-sonnet-5-5" },
        updatedAt: AT,
      });
      assert.strictEqual(meta.defaultModelSelection?.instanceId, "claude");
    }),
  );

  const metaUpdate = (commandId: string, extra: Record<string, unknown>) =>
    decodeCommand({ type: "updateProjectMeta", commandId, projectId: PROJECT, ...extra });

  it.effect("favicon overrides must point at an image file", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* metaUpdate("c-fav", { faviconPath: "public/logo.png" })).type,
        "updateProjectMeta",
      );
      assert.isTrue(yield* fails(metaUpdate("c-fav-bad", { faviconPath: ".env.local" })));
    }),
  );

  it.effect("icon overrides take Lucide names with palette colours, or an emoji", () =>
    Effect.gen(function* () {
      const lucide = yield* metaUpdate("c-icon", {
        projectIcon: { kind: "lucide", name: "rocket", color: "violet" },
      });
      const emoji = yield* metaUpdate("c-emoji", { projectIcon: { kind: "emoji", emoji: "🧑🏿‍🚀" } });
      assert.deepStrictEqual([lucide.type, emoji.type], ["updateProjectMeta", "updateProjectMeta"]);
      assert.isTrue(
        yield* fails(
          metaUpdate("c-icon-bad", {
            projectIcon: { kind: "lucide", name: "Rocket Ship", color: "infrared" },
          }),
        ),
      );
    }),
  );

  it.effect("monograms accept one or two graphemes of text and a palette colour", () =>
    Effect.gen(function* () {
      const icon = (monogram: string, color = "violet") => ({
        kind: "lucide" as const,
        name: "folder-code",
        color,
        monogram,
      });
      for (const text of ["Z", "Ko", "Ø", "漢字", "कि", "किखि", "à"]) {
        const command = yield* metaUpdate("c-mono", { projectIcon: icon(text) });
        assert.strictEqual(command.type, "updateProjectMeta");
        if (command.type === "updateProjectMeta")
          assert.deepEqual(command.projectIcon as unknown, icon(text));
      }
      const rejected = [
        icon("", "blue"),
        icon("XYZ", "blue"),
        icon("किखिगि", "blue"),
        icon("̀", "blue"),
        icon("A Z", "blue"),
        icon("🛸", "blue"),
        icon("Ko", "infrared"),
      ];
      for (const projectIcon of rejected) {
        assert.isTrue(
          yield* fails(metaUpdate("c-mono-bad", { projectIcon })),
          projectIcon.monogram,
        );
      }
    }),
  );

  it.effect("a client from before monograms reads a monogram icon as its plain icon", () =>
    Effect.gen(function* () {
      const priorIcon = Schema.Union([
        Schema.Struct({
          color: Chat.ProjectBadgeColor,
          name: Schema.String,
          kind: Schema.Literal("lucide"),
        }),
        Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.String }),
      ]);
      const priorHead = Schema.Struct({
        ...Chat.ChatProjectHead.fields,
        projectIcon: Schema.optional(Schema.NullOr(priorIcon)),
      });
      const wire = yield* Schema.encodeEffect(Chat.ChatProjectHead)({
        id: ProjectId.make("pj-mono"),
        title: "Mono",
        workspaceRoot: "/srv/mono",
        defaultModelSelection: null,
        scripts: [],
        createdAt: AT,
        updatedAt: AT,
        projectIcon: { kind: "lucide", name: "folder-code", color: "violet", monogram: "Mo" },
      });
      const seen = yield* Schema.decodeUnknownEffect(priorHead)(wire);
      assert.deepEqual(seen.projectIcon, { kind: "lucide", name: "folder-code", color: "violet" });
    }),
  );
});

// ---------------------------------------------------------------------------
// turn.start
// ---------------------------------------------------------------------------

describe("turn.start", () => {
  it.effect("defaults model, runtime mode and interaction mode", () =>
    Effect.gen(function* () {
      const parsed = yield* decodeTurnStart(turnStart("c-turn"));
      assert.isUndefined(parsed.modelSelection);
      assert.strictEqual(parsed.runtimeMode, Chat.DEFAULT_ACCESS_MODE);
      assert.strictEqual(parsed.interactionMode, Chat.DEFAULT_AGENT_TURN_MODE);
    }),
  );

  it.effect("keeps an explicit model and runtime mode", () =>
    Effect.gen(function* () {
      const parsed = yield* decodeTurnStart(
        turnStart("c-turn-explicit", { modelSelection: codexPick, runtimeMode: "full-access" }),
      );
      assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
      assert.strictEqual(parsed.runtimeMode, "full-access");
      assert.strictEqual(parsed.interactionMode, Chat.DEFAULT_AGENT_TURN_MODE);
    }),
  );

  it.effect("keeps provider-scoped option arrays", () =>
    Effect.gen(function* () {
      const parsed = yield* decodeTurnStart(
        turnStart("c-turn-opts", {
          modelSelection: {
            provider: "codex",
            model: "gpt-5.5-codex",
            options: [
              { id: "fastMode", value: true },
              { id: "reasoningEffort", value: "xhigh" },
            ],
          },
        }),
      );
      const options = parsed.modelSelection?.options;
      assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
      assert.strictEqual(optionValue(options, "reasoningEffort"), "xhigh");
      assert.strictEqual(optionValue(options, "fastMode"), true);
    }),
  );

  it.effect("carries bootstrap instructions for a new thread and worktree", () =>
    Effect.gen(function* () {
      const parsed = yield* decodeTurnStart(
        turnStart("c-turn-boot", {
          bootstrap: {
            runSetupScript: true,
            prepareWorktree: {
              projectCwd: "/srv/site",
              baseBranch: "trunk",
              branch: "kora/try-it",
              startFromOrigin: true,
            },
            createThread: {
              projectId: PROJECT,
              title: "Booted",
              createdAt: AT,
              worktreePath: null,
              branch: null,
              interactionMode: "default",
              runtimeMode: "full-access",
              modelSelection: codexPick,
            },
          },
        }),
      );
      const boot = parsed.bootstrap;
      assert.strictEqual(boot?.createThread?.projectId, PROJECT);
      assert.strictEqual(boot?.prepareWorktree?.baseBranch, "trunk");
      assert.isTrue(boot?.prepareWorktree?.startFromOrigin);
      assert.isTrue(boot?.runSetupScript);
    }),
  );

  it.effect("carries a title seed and a source plan reference", () =>
    Effect.gen(function* () {
      const seeded = yield* decodeTurnStart(turnStart("c-seed", { titleSeed: "Fix flaky login" }));
      assert.strictEqual(seeded.titleSeed, "Fix flaky login");
      const plan = { threadId: "th-plan", planId: "pl-1" };
      const fromPlan = yield* decodeTurnStart(turnStart("c-plan", { sourceProposedPlan: plan }));
      assert.deepStrictEqual(fromPlan.sourceProposedPlan, plan);
    }),
  );

  describe("attachments", () => {
    const pendingId = (n: number) =>
      `pending-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const pngUpload = (n: number) => ({
      type: "image",
      id: pendingId(n),
      name: `shot-${n}.png`,
      mimeType: "image/png",
      sizeBytes: 3,
    });
    const clientTurn = (attachments: unknown[]) =>
      turnStart("c-attach", {
        message: userMessage("m-attach", { attachments }),
        runtimeMode: "full-access",
        interactionMode: "default",
      });

    it.effect("allow up to the per-message limit and refuse one more", () =>
      Effect.gen(function* () {
        const max = Chat.AGENT_SEND_TURN_MAX_ATTACHMENTS;
        const many = (count: number) => Array.from({ length: count }, (_, n) => pngUpload(n));
        yield* decodeClientCommand(clientTurn(many(max)));
        assert.isTrue(yield* fails(decodeClientCommand(clientTurn(many(max + 1)))));
      }),
    );

    it.effect("accept inline images, uploaded images and uploaded files", () =>
      Effect.gen(function* () {
        const command = yield* decodeClientCommand(
          clientTurn([
            {
              type: "image",
              name: "inline.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,eHl6",
            },
            pngUpload(1),
            {
              type: "file",
              id: `${pendingId(2)}-pdf`,
              name: "notes.pdf",
              mimeType: "application/pdf",
              sizeBytes: 3,
            },
          ]),
        );
        if (command.type !== "turn.start") return assert.fail(`unexpected ${command.type}`);
        const [inline, uploaded, file] = command.message.attachments;
        assert.strictEqual(command.message.attachments.length, 3);
        assert.isTrue("dataUrl" in inline!);
        assert.isTrue("id" in uploaded!);
        assert.strictEqual(file!.type, "file");
      }),
    );

    // Persisted events and thread streams have no version negotiation, so an attachment
    // type from a newer build must decode rather than fail the whole message.
    it.effect("tolerate unknown attachment types from newer builds", () =>
      Effect.gen(function* () {
        const novel = {
          type: "hologram",
          id: `${THREAD}-00000000-0000-4000-8000-000000000009-usdz`,
          name: "scene.usdz",
          mimeType: "model/vnd.usdz+zip",
          sizeBytes: 20,
        };
        const message = yield* decodeMessage(storedMessage({ id: "msg-a", attachments: [novel] }));
        assert.deepStrictEqual(
          message.attachments?.map((a) => a.type),
          ["hologram"],
        );
        const sent = yield* Schema.decodeUnknownEffect(Chat.ThreadMessageSentPayload)(
          storedMessage({ threadId: THREAD, messageId: "msg-a", attachments: [novel] }),
        );
        assert.strictEqual(sent.attachments?.[0]!.type, "hologram");
      }),
    );

    // The open member must not swallow a malformed known type.
    it.effect("still validate known attachment types", () =>
      Effect.gen(function* () {
        const withAttachment = (attachment: unknown) =>
          decodeMessage(storedMessage({ id: "msg-b", attachments: [attachment] }));
        const common = {
          id: `${THREAD}-00000000-0000-4000-8000-000000000009-pdf`,
          name: "big.pdf",
        };
        assert.isTrue(
          yield* fails(
            withAttachment({
              ...common,
              type: "file",
              mimeType: "application/pdf",
              sizeBytes: Chat.AGENT_SEND_TURN_MAX_FILE_BYTES + 1,
            }),
          ),
        );
        assert.isTrue(
          yield* fails(
            withAttachment({ ...common, type: "image", mimeType: "application/pdf", sizeBytes: 9 }),
          ),
        );
      }),
    );
  });

  describe("window captures", () => {
    const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
    const tree = {
      format: "element-tree",
      coordinateSpace: "captured-image",
      imageSize: { width: 1024, height: 768 },
      truncated: false,
      root: {
        role: "window",
        name: "index.html",
        bounds: box(0, 0, 1024, 768),
        children: [
          { role: "text", value: "<h1>Hi</h1>", bounds: box(12, 30, 200, 18), children: [] },
        ],
      },
    };
    const source = {
      kind: "capture",
      capturedAt: AT,
      appName: "Browser",
      windowTitle: "index.html",
      accessibleText: "<h1>Hi</h1>",
      accessibility: tree,
      appIdentifier: "org.example.browser",
      appIconDataUrl: "data:image/png;base64,AAAA",
    };

    it.effect("keep capture metadata on an image attachment", () =>
      Effect.gen(function* () {
        const parsed = yield* decodeTurnStart(
          turnStart("c-capture", {
            message: userMessage("m-capture", {
              text: "What is wrong here?",
              attachments: [
                {
                  type: "image",
                  id: "cap-1",
                  name: "window.png",
                  mimeType: "image/png",
                  sizeBytes: 4,
                  source,
                },
              ],
            }),
          }),
        );
        const [image] = parsed.message.attachments;
        assert.strictEqual(image?.type, "image");
        assert.deepStrictEqual((image as Chat.MessageImageAttachment).source as unknown, source);
      }),
    );

    it.effect("refuse an accessibility tree over the size limit", () =>
      Effect.gen(function* () {
        const huge = {
          ...tree,
          root: {
            role: "window",
            bounds: box(0, 0, 1024, 768),
            children: Array.from({ length: 10 }, () => ({
              role: "text",
              value: "w".repeat(8_000),
              bounds: null,
              children: [],
            })),
          },
        };
        assert.isTrue(yield* fails(Schema.decodeUnknownEffect(Chat.CaptureAccessibility)(huge)));
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Thread commands
// ---------------------------------------------------------------------------

describe("thread commands", () => {
  const threadCommand = (type: string, commandId: string, extra: Record<string, unknown> = {}) =>
    decodeCommand({ type, commandId, threadId: THREAD, ...extra });

  it.effect("archive / unarchive and settle / unsettle decode", () =>
    Effect.gen(function* () {
      const decoded = [
        yield* threadCommand("archiveThread", "c-1"),
        yield* threadCommand("unarchiveThread", "c-2"),
        yield* threadCommand("settleThread", "c-3"),
        yield* threadCommand("unsettleThread", "c-4", { reason: "user" }),
      ];
      assert.deepStrictEqual(
        decoded.map((command) => command.type),
        ["archiveThread", "unarchiveThread", "settleThread", "unsettleThread"],
      );
    }),
  );

  // "activity" belongs to the server-side event, so clients cannot forge that reset.
  it.effect("unsettle with reason 'activity' is not a valid command", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* fails(threadCommand("unsettleThread", "c-5", { reason: "activity" })));
    }),
  );

  it.effect("active reorder decodes on both boundaries and needs a key", () =>
    Effect.gen(function* () {
      const input = {
        commandId: "c-order",
        type: "reorderActiveThread",
        threadId: THREAD,
        orderKey: "k3",
      };
      for (const decoded of [yield* decodeClientCommand(input), yield* decodeCommand(input)]) {
        assert.strictEqual(decoded.type, "reorderActiveThread");
        if (decoded.type === "reorderActiveThread") {
          assert.deepStrictEqual([decoded.threadId, decoded.orderKey], [THREAD, "k3"]);
        }
      }
      assert.isTrue(yield* fails(decodeClientCommand({ ...input, orderKey: "  " })));
    }),
  );

  it.effect("meta.update accepts a regenerate request but not together with a title", () =>
    Effect.gen(function* () {
      const regen = yield* threadCommand("updateThreadMeta", "c-regen", {
        regenerateTitle: true,
      });
      assert.strictEqual(regen.type === "updateThreadMeta" && regen.regenerateTitle, true);
      assert.isTrue(
        yield* fails(
          threadCommand("updateThreadMeta", "c-regen-title", {
            title: "Manual",
            regenerateTitle: true,
          }),
        ),
      );
    }),
  );

  it.effect("the internal title completion carries its request id and title", () =>
    Effect.gen(function* () {
      const done = yield* threadCommand("completeTitleRegeneration", "c-done", {
        requestId: "c-regen",
        title: "Better title",
      });
      assert.strictEqual(done.type, "completeTitleRegeneration");
      if (done.type === "completeTitleRegeneration") {
        assert.deepStrictEqual([done.requestId, done.title], ["c-regen", "Better title"]);
      }
    }),
  );

  it.effect("pull request link and unlink decode", () =>
    Effect.gen(function* () {
      const key = { host: "github.com", repository: REPO, number: 7 };
      const link = yield* threadCommand("linkPullRequest", "c-link", {
        source: "manual",
        url: prUrl(7),
        ...key,
      });
      assert.strictEqual(link.type, "linkPullRequest");
      if (link.type === "linkPullRequest") {
        assert.deepStrictEqual([link.source, link.number], ["manual", 7]);
      }
      assert.strictEqual(
        (yield* threadCommand("unlinkPullRequest", "c-unlink", key)).type,
        "unlinkPullRequest",
      );
    }),
  );

  it.effect("pull request sync is internal only, and clients cannot set branchPullRequest", () =>
    Effect.gen(function* () {
      const pr = { projectId: ProjectId.make(PROJECT), repository: REPO, number: 7, url: prUrl(7) };
      const sync = {
        type: "syncPullRequest" as const,
        commandId: DispatchCommandId.make("c-sync"),
        threadId: ThreadId.make(THREAD),
        projectId: pr.projectId,
        seq: 4,
        expected: {
          branchPullRequest: null,
          linkedPullRequest: null,
          worktreePath: null,
          branch: "topic",
          workspaceRoot: "/srv/site",
        },
        branchPullRequest: pr,
        linkedPullRequest: pr,
      };
      assert.deepStrictEqual(yield* decodeCommand(sync), sync);
      assert.isTrue(yield* fails(decodeClientCommand(sync)));
      const cleared = { ...sync, branchPullRequest: null };
      assert.deepStrictEqual(yield* decodeCommand(cleared), cleared);

      const forged = yield* decodeClientCommand({
        type: "updateThreadMeta",
        commandId: "c-forge",
        threadId: THREAD,
        branchPullRequest: pr,
      });
      assert.isFalse("branchPullRequest" in forged);
    }),
  );

  it.effect("history import needs at least one message", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* fails(threadCommand("importThreadHistory", "c-import", { messages: [] })),
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// Thread payloads and events
// ---------------------------------------------------------------------------

describe("thread payloads", () => {
  it.effect("thread.created from old builds gets the default runtime mode", () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadCreated(threadCreated({ interactionMode: "default" }));
      assert.strictEqual(parsed.runtimeMode, Chat.DEFAULT_ACCESS_MODE);
      assert.strictEqual(parsed.modelSelection.instanceId, "codex");
    }),
  );

  it.effect("thread.meta-updated keeps title regeneration and a provider-keyed model", () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadMeta({
        threadId: THREAD,
        regenerateTitle: true,
        previousTitle: "Before",
        titleRegeneration: { requestId: "c-regen", startedAt: AT },
        modelSelection: { provider: "claude", model: "claude-sonnet-5-5" },
        updatedAt: AT,
      });
      assert.deepStrictEqual(
        [
          parsed.previousTitle,
          parsed.titleRegeneration?.requestId,
          parsed.modelSelection?.instanceId,
        ],
        ["Before", "c-regen", "claude"],
      );
    }),
  );

  describe("object-shaped legacy model options become arrays", () => {
    it.effect("on a thread, dropping blank and non-scalar entries", () =>
      Effect.gen(function* () {
        const parsed = yield* decodeThreadCreated(
          threadCreated({
            modelSelection: {
              provider: "claude",
              model: "claude-opus-5-5",
              // Same cleanup as the stored-data migration: junk entries go.
              options: { effort: "high", fastMode: true, blank: "  ", none: null, deep: { a: 1 } },
            },
          }),
        );
        assert.strictEqual(parsed.modelSelection.instanceId, AgentProfileId.make("claude"));
        assert.deepStrictEqual(parsed.modelSelection.options, [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ]);
      }),
    );

    it.effect("on a project default", () =>
      Effect.gen(function* () {
        const parsed = yield* decodeProjectCreated(
          projectCreated({
            defaultModelSelection: { ...codexPick, options: { reasoningEffort: "medium" } },
          }),
        );
        assert.deepStrictEqual(parsed.defaultModelSelection?.options, [
          { id: "reasoningEffort", value: "medium" },
        ]);
      }),
    );

    it.effect("and re-encode as the canonical array", () =>
      Effect.gen(function* () {
        const decoded = yield* decodeThreadCreated(
          threadCreated({ modelSelection: { ...codexPick, options: { fastMode: false } } }),
        );
        const wire = yield* Schema.encodeEffect(Chat.ThreadCreatedPayload)(decoded);
        assert.deepStrictEqual(wire.modelSelection.options, [{ id: "fastMode", value: false }]);
      }),
    );
  });

  describe("turn-start-requested", () => {
    const requested = (extra: Record<string, unknown> = {}) =>
      decodeTurnRequested({ threadId: THREAD, messageId: "m-req", createdAt: AT, ...extra });

    it.effect("defaults everything optional", () =>
      Effect.gen(function* () {
        const parsed = yield* requested();
        assert.isUndefined(parsed.modelSelection);
        assert.isUndefined(parsed.sourceProposedPlan);
        assert.strictEqual(parsed.runtimeMode, Chat.DEFAULT_ACCESS_MODE);
        assert.strictEqual(parsed.interactionMode, Chat.DEFAULT_AGENT_TURN_MODE);
      }),
    );

    it.effect("keeps a source plan and a title seed", () =>
      Effect.gen(function* () {
        const plan = { threadId: "th-plan", planId: "pl-2" };
        assert.deepStrictEqual(
          (yield* requested({ sourceProposedPlan: plan })).sourceProposedPlan,
          plan,
        );
        assert.strictEqual(
          (yield* requested({ titleSeed: "Speed up CI" })).titleSeed,
          "Speed up CI",
        );
      }),
    );
  });

  it.effect("latest turn keeps its source plan", () =>
    Effect.gen(function* () {
      const plan = { threadId: "th-plan", planId: "pl-3" };
      const turn = yield* Schema.decodeUnknownEffect(Chat.ChatLatestTurn)({
        turnId: "tu-4",
        state: "running",
        requestedAt: AT,
        startedAt: LATER,
        completedAt: null,
        assistantMessageId: null,
        sourceProposedPlan: plan,
      });
      assert.deepStrictEqual(turn.sourceProposedPlan, plan);
    }),
  );

  it.effect("a session without a runtime mode gets the default", () =>
    Effect.gen(function* () {
      const session = yield* Schema.decodeUnknownEffect(Chat.ChatSession)({
        lastError: null,
        activeTurnId: null,
        providerThreadId: null,
        providerSessionId: null,
        providerName: null,
        status: "idle",
        threadId: THREAD,
        updatedAt: AT,
      });
      assert.strictEqual(session.runtimeMode, Chat.DEFAULT_ACCESS_MODE);
    }),
  );

  it.effect("proposed plans default their implementation fields and keep them when set", () =>
    Effect.gen(function* () {
      const decodePlan = Schema.decodeUnknownEffect(Chat.ChatPlanProposal);
      const plan = { turnId: "tu-1", planMarkdown: "## Steps", createdAt: AT, updatedAt: AT };
      const fresh = yield* decodePlan({ ...plan, id: "pl-a" });
      assert.deepStrictEqual([fresh.implementedAt, fresh.implementationThreadId], [null, null]);
      const done = yield* decodePlan({
        ...plan,
        id: "pl-b",
        implementedAt: LATER,
        implementationThreadId: "th-impl",
      });
      assert.deepStrictEqual([done.implementedAt, done.implementationThreadId], [LATER, "th-impl"]);
    }),
  );
});

describe("thread snapshots", () => {
  it.effect("old snapshots get settled defaults and an empty pull request list", () =>
    Effect.gen(function* () {
      const thread = yield* Schema.decodeUnknownEffect(Chat.ChatThread)({
        ...threadCore,
        checkpoints: [],
        activities: [],
        messages: [],
        proposedPlans: [],
        deletedAt: null,
      });
      const head = yield* decodeHead({ ...threadCore, ...headOnly });
      for (const snapshot of [thread, head]) {
        assert.isNull(snapshot.settledOverride);
        assert.isNull(snapshot.settledAt);
        assert.deepStrictEqual(snapshot.pullRequests, []);
      }
    }),
  );

  it.effect("the single legacy link survives both directions of a version skew", () =>
    Effect.gen(function* () {
      const legacy = {
        projectId: ProjectId.make(PROJECT),
        repository: REPO,
        number: 7,
        url: prUrl(7),
      };
      // An old server sends only the single link.
      const fromOld = yield* decodeHead({ ...threadCore, ...headOnly, linkedPullRequest: legacy });
      assert.deepStrictEqual(fromOld.pullRequests, []);
      assert.deepStrictEqual(fromOld.linkedPullRequest, legacy);

      // An old client must still find its field in what a new server encodes.
      const wire = yield* Schema.encodeEffect(Chat.ChatThreadHead)({
        ...fromOld,
        pullRequests: [
          {
            host: "github.com",
            repository: legacy.repository,
            number: legacy.number,
            url: legacy.url,
            source: "agent",
            linkedAt: AT,
            snapshot: null,
            stack: null,
          },
        ],
      });
      const oldClient = Schema.Struct({
        linkedPullRequest: Schema.optional(Chat.ThreadLinkedMergeRequest),
      });
      assert.deepStrictEqual(
        (yield* Schema.decodeUnknownEffect(oldClient)(wire)).linkedPullRequest,
        legacy,
      );
    }),
  );

  it.effect("pull request links keep their snapshot and stack", () =>
    Effect.gen(function* () {
      const layer = (n: number) => ({ number: n, headBranch: `stack/${n}`, state: "open" });
      const head = yield* decodeHead({
        ...threadCore,
        ...headOnly,
        branch: "stack/8",
        pullRequests: [
          { ...linkKey(7), stack: null, snapshot: null, linkedAt: AT, source: "agent" },
          {
            ...linkKey(8),
            source: "stack",
            linkedAt: LATER,
            snapshot: {
              syncedAt: LATER,
              updatedAt: LATER,
              title: "Layer two",
              isDraft: false,
              baseBranch: "stack/7",
              headBranch: "stack/8",
              state: "open",
            },
            stack: {
              kind: "native",
              id: "11",
              number: 2,
              url: `https://github.com/${REPO}/stacks/2`,
              base: "trunk",
              layers: [layer(7), layer(8)],
            },
          },
        ],
      });
      const second = head.pullRequests[1];
      assert.strictEqual(head.pullRequests.length, 2);
      assert.strictEqual(second?.stack?.layers.length, 2);
      assert.strictEqual(second?.snapshot?.state, "open");
    }),
  );
});

describe("thread events", () => {
  it.effect("archived and unarchived", () =>
    Effect.gen(function* () {
      const archived = yield* decodeEvent(
        threadEvent(1, "threadArchived", "c-arch", {
          threadId: THREAD,
          archivedAt: AT,
          updatedAt: AT,
        }),
      );
      const unarchived = yield* decodeEvent(
        threadEvent(
          2,
          "threadUnarchived",
          "c-unarch",
          { threadId: THREAD, updatedAt: LATER },
          LATER,
        ),
      );
      if (archived.type !== "threadArchived") return assert.fail(`unexpected ${archived.type}`);
      assert.strictEqual(archived.payload.archivedAt, AT);
      assert.strictEqual(unarchived.type, "threadUnarchived");
    }),
  );

  it.effect("settled and unsettled", () =>
    Effect.gen(function* () {
      const settled = yield* decodeEvent(
        threadEvent(1, "threadSettled", "c-set", {
          threadId: THREAD,
          settledAt: AT,
          updatedAt: AT,
        }),
      );
      const unsettled = yield* decodeEvent(
        threadEvent(
          2,
          "threadUnsettled",
          "c-unset",
          { threadId: THREAD, reason: "user", updatedAt: LATER },
          LATER,
        ),
      );
      assert.deepStrictEqual([settled.type, unsettled.type], ["threadSettled", "threadUnsettled"]);
    }),
  );

  it.effect("meta-updated carries active placement, and old payloads without it still decode", () =>
    Effect.gen(function* () {
      const base = { threadId: THREAD, updatedAt: AT };
      assert.isUndefined((yield* decodeThreadMeta(base)).activeOrderKey);
      assert.isNull((yield* decodeThreadMeta({ ...base, activeOrderKey: null })).activeOrderKey);
      const event = yield* decodeEvent({
        ...threadEvent(1, "threadMetaUpdated", "c-order", { ...base, activeOrderKey: "k3" }, LATER),
        correlationId: null,
      });
      assert.strictEqual(event.type, "threadMetaUpdated");
      if (event.type === "threadMetaUpdated") {
        assert.deepStrictEqual([event.payload.activeOrderKey, event.payload.updatedAt], ["k3", AT]);
      }
    }),
  );

  it.effect("a stored meta-updated event with the old linkedPullRequest still decodes", () =>
    Effect.gen(function* () {
      const event = yield* decodeEvent(
        threadEvent(1, "threadMetaUpdated", "c-old-link", {
          threadId: THREAD,
          linkedPullRequest: { projectId: PROJECT, repository: REPO, number: 7, url: prUrl(7) },
          updatedAt: AT,
        }),
      );
      if (event.type !== "threadMetaUpdated") return assert.fail(`unexpected ${event.type}`);
      assert.strictEqual(event.payload.linkedPullRequest?.number, 7);
    }),
  );
});

// ---------------------------------------------------------------------------
// ModelPick wire shape
// ---------------------------------------------------------------------------

// A pick routes on `instanceId`. Payloads from before instances carried `provider` (a
// driver kind); built-in drivers use that kind as their default instance id, so the
// decoder renames it. Unknown kinds (forks, rollbacks) must decode the same way.
describe("ModelPick", () => {
  const decodePick = Schema.decodeUnknownEffect(Chat.ModelPick);

  it.effect("turns a legacy provider into instanceId and keeps model and options", () =>
    Effect.gen(function* () {
      const options = [{ id: "reasoningEffort", value: "medium" }];
      const pick = yield* decodePick({ provider: "codex", model: "gpt-5.5-codex", options });
      assert.strictEqual(pick.instanceId, AgentProfileId.make("codex"));
      assert.strictEqual(pick.model, "gpt-5.5-codex");
      assert.deepStrictEqual(pick.options, options);
    }),
  );

  it.effect("uses an explicit instanceId, even next to a provider", () =>
    Effect.gen(function* () {
      const work = AgentProfileId.make("codex_work");
      assert.strictEqual(
        (yield* decodePick({ instanceId: "codex_work", model: "m" })).instanceId,
        work,
      );
      assert.strictEqual(
        (yield* decodePick({ provider: "codex", instanceId: "codex_work", model: "m" })).instanceId,
        work,
      );
    }),
  );

  it.effect("decodes an unknown driver kind and encodes the canonical form", () =>
    Effect.gen(function* () {
      const legacy = {
        provider: "lmstudio",
        model: "qwen3:32b",
        options: [{ id: "temperature", value: "0.2" }],
      };
      const pick = yield* decodePick(legacy);
      assert.strictEqual(pick.instanceId, AgentProfileId.make("lmstudio"));
      assert.strictEqual(pick.model, "qwen3:32b");
      assert.deepStrictEqual(yield* Schema.encodeUnknownEffect(Chat.ModelPick)(pick), {
        instanceId: "lmstudio",
        model: "qwen3:32b",
        options: legacy.options,
      });
    }),
  );

  it.effect("rejects an instance id that does not start with a letter", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* fails(decodePick({ instanceId: "9lives", model: "m" })));
    }),
  );
});

// ---------------------------------------------------------------------------
// Agent modes and notices
// ---------------------------------------------------------------------------

describe("agent modes", () => {
  it.effect(
    "swarm decodes, an unknown future mode reads as orchestrator, absent reads as chat",
    () =>
      Effect.gen(function* () {
        const decodeMode = Schema.decodeUnknownEffect(Chat.ThreadAgentModeSetPayload);
        const base = { threadId: THREAD, updatedAt: AT };
        const modes = [
          (yield* decodeMode({ ...base, agentMode: "swarm" })).agentMode,
          (yield* decodeMode({ ...base, agentMode: "flock" })).agentMode,
          (yield* decodeMode(base)).agentMode,
        ];
        assert.deepStrictEqual(modes, ["swarm", "orchestrator", "chat"]);
      }),
  );

  it("every known mode may have workers and an unknown one may not", () => {
    for (const mode of ["chat", "orchestrator", "swarm"] as const)
      assert.isTrue(Chat.isFleetAgentMode(mode));
    assert.isFalse(Chat.isFleetAgentMode("nonsense" as never));
  });

  it.effect("a message may carry a Kora notice", () =>
    Effect.gen(function* () {
      const notice = { kind: "agent-mode-switched", from: "chat", to: "swarm" };
      const message = yield* decodeMessage(
        storedMessage({ id: "msg-n", text: "[kora] Switched to Swarm mode.", notice }),
      );
      assert.deepStrictEqual(message.notice as unknown, notice);
    }),
  );
});
