import * as Schema from "effect/Schema";

import { WorkspaceFile } from "./workspaceFile.ts";

/**
 * The Blobs surface contract (docs/bots/ARCH.md section 3): persistent AI coworker agents ("blobs") and the
 * Chief blob ("Kora"). A blob is a Chat-style project (`blobId === projectId`, `ProjectSurface` "blobs"); its
 * threads ride the normal thread wire, so this file only carries what threads cannot: the roster/profile, memory,
 * about-me, defaults, usage, files and the Phase 2 job / proposal / template shapes.
 *
 * Wire rules as swarm.ts: every result field is required and nullable (`NullOr`, never undefined); timestamps are
 * epoch-ms numbers, never `DateTimeUtc`. Input patches use `optionalKey` (absent = unchanged).
 */
export const BLOB_METHODS = {
  subscribe: "blobs.subscribe",
  list: "blobs.list",
  get: "blobs.get",
  create: "blobs.create",
  update: "blobs.update",
  setSoul: "blobs.setSoul",
  archive: "blobs.archive",
  rehire: "blobs.rehire",
  delete: "blobs.delete",
  duplicate: "blobs.duplicate",
  getAboutMe: "blobs.getAboutMe",
  setAboutMe: "blobs.setAboutMe",
  getDefaults: "blobs.getDefaults",
  setDefaults: "blobs.setDefaults",
  setFlag: "blobs.setFlag",
  usage: "blobs.usage",
  files: "blobs.files",
  memoryList: "blobs.memory.list",
  memoryEdit: "blobs.memory.edit",
  memoryForget: "blobs.memory.forget",
  memoryImportant: "blobs.memory.important",
  memoryUndo: "blobs.memory.undo",
  memoryConfirm: "blobs.memory.confirm",
  memorySetCore: "blobs.memory.setCore",
  memorySearch: "blobs.memory.search",
  templates: "blobs.templates.list",
  hireTemplates: "blobs.templates.hire", // Phase 2
  jobGet: "blobs.job.get",
  jobCancel: "blobs.job.cancel",
  jobFeedback: "blobs.job.feedback", // Phase 2
  proposalDismiss: "blobs.proposal.dismiss",
  confirmResolve: "blobs.confirm.resolve", // Phase 2
  continueOnFree: "blobs.thread.continueOnFree",
  undoSelfChange: "blobs.selfChange.undo",
  // Phase 4: routines + webhooks
  routinesSnapshot: "blobs.routines.snapshot",
  routinesSubscribe: "blobs.routines.subscribe",
  routinesThreads: "blobs.routines.threads",
  routinesPreview: "blobs.routines.preview",
  routinesSave: "blobs.routines.save",
  routinesSetPaused: "blobs.routines.setPaused",
  routinesRemove: "blobs.routines.remove",
  routinesRunNow: "blobs.routines.runNow",
  routinesCancelRun: "blobs.routines.cancelRun",
  routinesCreateTrigger: "blobs.routines.createTrigger",
  routinesRotateTrigger: "blobs.routines.rotateTrigger",
  routinesDeleteTrigger: "blobs.routines.deleteTrigger",
  routinesConfirm: "blobs.routines.confirm",
  // Phase 5: connected apps
  appsStatus: "blobs.apps.status",
  appsSetKey: "blobs.apps.setKey",
  appsClearKey: "blobs.apps.clearKey",
  appsResetBroker: "blobs.apps.resetBroker",
  appsToolkits: "blobs.apps.toolkits",
  appsAccounts: "blobs.apps.accounts",
  appsConnect: "blobs.apps.connect",
  appsDisconnect: "blobs.apps.disconnect",
  appsTools: "blobs.apps.tools",
  appsDecisions: "blobs.apps.decisions",
} as const;

export class BlobError extends Schema.TaggedError<BlobError>()("BlobError", {
  operation: Schema.String,
  message: Schema.String,
  code: Schema.NullOr(Schema.String),
}) {}

/** The fixed id of the Chief blob. */
export const CHIEF_BLOB_ID = "blob_kora";

export const BlobRole = Schema.Literals(["chief", "member"]);
export type BlobRole = Schema.Schema.Type<typeof BlobRole>;
export const BlobPermission = Schema.Literals(["ask", "auto", "full"]);
export type BlobPermission = Schema.Schema.Type<typeof BlobPermission>;

export const BlobEngine = Schema.Struct({
  /** Provider instance: claude | codex | opencode. */
  instanceId: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});
export type BlobEngine = Schema.Schema.Type<typeof BlobEngine>;

export const BlobOutfitWire = Schema.Struct({
  head: Schema.NullOr(Schema.String),
  face: Schema.NullOr(Schema.String),
  neck: Schema.NullOr(Schema.String),
});
export type BlobOutfitWire = Schema.Schema.Type<typeof BlobOutfitWire>;

/** A standing "Always for this blob" answer to an approval card (Profile > Permissions lists and removes them). */
export const ApprovalRule = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["command", "path", "app"]),
  /** command: the program ("git status"); path: an absolute folder; app: the action's tool slug. */
  match: Schema.String,
  label: Schema.String,
  at: Schema.Number,
});
export type ApprovalRule = Schema.Schema.Type<typeof ApprovalRule>;

export const BlobToolGrants = Schema.Struct({
  /** Phase 5. */
  apps: Schema.Struct({
    mode: Schema.Literals(["none", "all", "list"]),
    allow: Schema.Array(Schema.String),
  }),
  /** Phase 5. */
  mcp: Schema.Array(Schema.String),
  /** Phase 6. */
  computer: Schema.Struct({
    browser: Schema.Boolean,
    vm: Schema.Boolean,
    /** Phase 6: let the blob's browser save downloads into <workspace>/downloads (default off). */
    allowDownloads: Schema.optionalKey(Schema.Boolean),
    /** Phase 6: local dev servers the blob's browser may open (`localhost`, `127.0.0.1:5173`, `*.test`). */
    allowLocalHosts: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  /** "Always for this blob" approvals; absent on profiles written before they existed. */
  approvals: Schema.optionalKey(Schema.Array(ApprovalRule)),
});
export type BlobToolGrants = Schema.Schema.Type<typeof BlobToolGrants>;

export const BlobProfile = Schema.Struct({
  id: Schema.String,
  version: Schema.Literal(1),
  name: Schema.String,
  title: Schema.String,
  role: BlobRole,
  teamId: Schema.String,
  engine: BlobEngine,
  permission: BlobPermission,
  /** null => `defaultOutfitFor(id)` on the client. */
  outfit: Schema.NullOr(BlobOutfitWire),
  toolGrants: BlobToolGrants,
  slug: Schema.String,
  /** Absolute path of the blob's Finder folder (`~/Blobs/<slug>`). */
  workspace: Schema.String,
  templateId: Schema.NullOr(Schema.String),
  /** Free helpers for this blob's legwork (OpenCode free models, at most two at a time). Absent = on. */
  helpers: Schema.optionalKey(Schema.Boolean),
  pinned: Schema.Boolean,
  hidden: Schema.Boolean,
  archivedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type BlobProfile = Schema.Schema.Type<typeof BlobProfile>;

/** The editable subset of a profile (id / version / role / slug / workspace / createdAt are fixed; archive and rehire have their own RPCs). */
export const BlobProfilePatch = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  teamId: Schema.optionalKey(Schema.String),
  engine: Schema.optionalKey(BlobEngine),
  permission: Schema.optionalKey(BlobPermission),
  outfit: Schema.optionalKey(Schema.NullOr(BlobOutfitWire)),
  toolGrants: Schema.optionalKey(BlobToolGrants),
  templateId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  helpers: Schema.optionalKey(Schema.Boolean),
  pinned: Schema.optionalKey(Schema.Boolean),
  hidden: Schema.optionalKey(Schema.Boolean),
});
export type BlobProfilePatch = Schema.Schema.Type<typeof BlobProfilePatch>;

export const BlobDefaults = Schema.Struct({
  /** null = best installed engine. */
  engine: Schema.NullOr(BlobEngine),
  permission: BlobPermission,
  soulTemplate: Schema.String,
});
export type BlobDefaults = Schema.Schema.Type<typeof BlobDefaults>;

export const BlobEngineAvailability = Schema.Struct({
  best: Schema.NullOr(BlobEngine),
  claude: Schema.Struct({ ready: Schema.Boolean }),
  codex: Schema.Struct({ ready: Schema.Boolean }),
  opencode: Schema.Struct({ ready: Schema.Boolean, freeModels: Schema.Number }),
});
export type BlobEngineAvailability = Schema.Schema.Type<typeof BlobEngineAvailability>;

export const BlobFlagKey = Schema.Literals([
  "concurrencyWarningDismissed",
  "galleryDismissed",
  "claudeMemoryFallback",
]);
export type BlobFlagKey = Schema.Schema.Type<typeof BlobFlagKey>;
export const BlobFlags = Schema.Struct({
  concurrencyWarningDismissed: Schema.Boolean,
  galleryDismissed: Schema.Boolean,
  /** "Use Claude for memory when no free model is available" (Settings > Blobs). Off by default. */
  claudeMemoryFallback: Schema.Boolean,
});
export type BlobFlags = Schema.Schema.Type<typeof BlobFlags>;

export const BlobsSnapshot = Schema.Struct({
  seq: Schema.Number,
  /** Every non-deleted blob, archived ones included (the roster filters on `archivedAt`). */
  blobs: Schema.Array(BlobProfile),
  flags: BlobFlags,
  engines: BlobEngineAvailability,
  koraReady: Schema.Boolean,
  /** Display name of the model that learns memory from chats ("Big Pickle · free", "Claude Haiku 5.5"); null = none available. */
  memoryModel: Schema.NullOr(Schema.String),
  /** Background Claude (Haiku) helper calls made today for memory / routing (the daemon counts; capped per day). */
  claudeCallsToday: Schema.optionalKey(Schema.Number),
  /** The daemon's Kora surface switch (runtime edition.ts). Absent (an older daemon) or "coming-soon" = the client shows
   *  the coming-soon screen; the snapshot is then empty and every other blobs.* call answers "Kora is coming soon". */
  koraSurface: Schema.optionalKey(Schema.Literals(["coming-soon", "on"])),
});
export type BlobsSnapshot = Schema.Schema.Type<typeof BlobsSnapshot>;

/** The `blobs.subscribe` stream: snapshot-only; re-emitted on every profile / flag / engine change. */
export const BlobsStreamEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: BlobsSnapshot,
});
export type BlobsStreamEvent = Schema.Schema.Type<typeof BlobsStreamEvent>;

export const BlobSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
});
export type BlobSkill = Schema.Schema.Type<typeof BlobSkill>;

export const BlobDetail = Schema.Struct({
  profile: BlobProfile,
  soul: Schema.String,
  core: Schema.Struct({ you: Schema.String, blob: Schema.String }),
  skills: Schema.Array(BlobSkill),
});
export type BlobDetail = Schema.Schema.Type<typeof BlobDetail>;

/** `{input, cached, output, turns}`: mirrors `ThreadRecord.leaderUsage` (input excludes cache reads). */
export const TokenTotals = Schema.Struct({
  input: Schema.Number,
  cached: Schema.Number,
  output: Schema.Number,
  turns: Schema.Number,
});
export type TokenTotals = Schema.Schema.Type<typeof TokenTotals>;

export const BlobUsage = Schema.Struct({
  blobId: Schema.String,
  total: TokenTotals,
  byThread: Schema.Array(
    Schema.Struct({ threadId: Schema.String, title: Schema.String, totals: TokenTotals }),
  ),
});
export type BlobUsage = Schema.Schema.Type<typeof BlobUsage>;

// ── memory (wire mirror of the runtime memory module; builders adapt, contracts never import it) ─────────────

export const BlobMemoryScope = Schema.Literals(["you", "blob", "team"]);
export type BlobMemoryScope = Schema.Schema.Type<typeof BlobMemoryScope>;

export const BlobFact = Schema.Struct({
  id: Schema.String,
  scope: BlobMemoryScope,
  blobId: Schema.NullOr(Schema.String),
  text: Schema.String,
  since: Schema.Number,
  until: Schema.NullOr(Schema.Number),
  confidence: Schema.Number,
  important: Schema.Boolean,
  sourceThreadId: Schema.NullOr(Schema.String),
  sourceMessageId: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.Number),
});
export type BlobFact = Schema.Schema.Type<typeof BlobFact>;

export const MemoryReceipt = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["added", "updated", "retired", "held"]),
  scope: BlobMemoryScope,
  text: Schema.String,
  previousText: Schema.NullOr(Schema.String),
  factId: Schema.NullOr(Schema.String),
  undone: Schema.Boolean,
  /** held: why it was not saved silently. */
  reason: Schema.NullOr(Schema.String),
});
export type MemoryReceipt = Schema.Schema.Type<typeof MemoryReceipt>;

export const BlobEpisodeHit = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  at: Schema.Number,
  score: Schema.Number,
});
export type BlobEpisodeHit = Schema.Schema.Type<typeof BlobEpisodeHit>;

// ── Phase 2: templates, proposals, jobs, cards ───────────────────────────────────────────────────────────────

export const BlobDraft = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  job: Schema.String,
  howItWorks: Schema.Array(Schema.String),
  soul: Schema.String,
  /** null = the best installed engine when hired. */
  engine: Schema.NullOr(BlobEngine),
  permission: BlobPermission,
  outfit: Schema.NullOr(BlobOutfitWire),
  apps: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String),
  routines: Schema.Array(Schema.Struct({ title: Schema.String, cadence: Schema.String })),
  templateId: Schema.NullOr(Schema.String),
});
export type BlobDraft = Schema.Schema.Type<typeof BlobDraft>;

export const BlobTemplate = Schema.Struct({
  id: Schema.String,
  draft: BlobDraft,
  blurb: Schema.String,
  exampleAsks: Schema.Array(Schema.String),
  wants: Schema.Array(Schema.String),
});
export type BlobTemplate = Schema.Schema.Type<typeof BlobTemplate>;

export const JobStep = Schema.Struct({
  id: Schema.String,
  blobId: Schema.String,
  blobName: Schema.String,
  title: Schema.String,
  task: Schema.String,
  kind: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  status: Schema.Literals(["queued", "running", "needs-you", "done", "failed", "cancelled"]),
  threadId: Schema.NullOr(Schema.String),
  resultGist: Schema.NullOr(Schema.String),
  outputs: Schema.Array(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
});
export type JobStep = Schema.Schema.Type<typeof JobStep>;

export const JobCardPayload = Schema.Struct({
  cardKind: Schema.Literal("job"),
  cardId: Schema.String,
  version: Schema.Number,
  title: Schema.String,
  status: Schema.Literals(["planned", "running", "done", "failed", "cancelled"]),
  steps: Schema.Array(JobStep),
  createdAt: Schema.Number,
});
export type JobCardPayload = Schema.Schema.Type<typeof JobCardPayload>;

export const ProposalCardPayload = Schema.Struct({
  cardKind: Schema.Literal("proposal"),
  cardId: Schema.String,
  version: Schema.Number,
  draft: BlobDraft,
  state: Schema.Literals(["open", "hired", "dismissed"]),
  hiredBlobId: Schema.NullOr(Schema.String),
});
export type ProposalCardPayload = Schema.Schema.Type<typeof ProposalCardPayload>;

/** An edit / retire / hire Kora wants the user to approve with a click (Phase 2 ruling: one tidy card). */
export const ConfirmCardPayload = Schema.Struct({
  cardKind: Schema.Literal("confirm"),
  cardId: Schema.String,
  version: Schema.Number,
  action: Schema.Literals(["edit", "retire", "hire"]),
  blobId: Schema.NullOr(Schema.String),
  blobName: Schema.NullOr(Schema.String),
  summary: Schema.String,
  details: Schema.Array(Schema.String),
  state: Schema.Literals(["open", "confirmed", "dismissed", "failed"]),
  result: Schema.NullOr(Schema.String),
});
export type ConfirmCardPayload = Schema.Schema.Type<typeof ConfirmCardPayload>;

export const MemoryReceiptCardPayload = Schema.Struct({
  cardKind: Schema.Literal("memory"),
  cardId: Schema.String,
  version: Schema.Number,
  receipts: Schema.Array(MemoryReceipt),
});
export type MemoryReceiptCardPayload = Schema.Schema.Type<typeof MemoryReceiptCardPayload>;

export const SelfChangeCardPayload = Schema.Struct({
  cardKind: Schema.Literal("self-change"),
  cardId: Schema.String,
  version: Schema.Number,
  what: Schema.String,
  undoToken: Schema.String,
  undone: Schema.Boolean,
});
export type SelfChangeCardPayload = Schema.Schema.Type<typeof SelfChangeCardPayload>;

export const RateLimitCardPayload = Schema.Struct({
  cardKind: Schema.Literal("rate-limit"),
  cardId: Schema.String,
  version: Schema.Number,
  engine: Schema.String,
  resetsAt: Schema.NullOr(Schema.Number),
  threadId: Schema.String,
});
export type RateLimitCardPayload = Schema.Schema.Type<typeof RateLimitCardPayload>;

/** A finished routine run's dated report, posted into the routine's results thread (Phase 4). */
export const RoutineReportCardPayload = Schema.Struct({
  cardKind: Schema.Literal("routine-report"),
  cardId: Schema.String,
  version: Schema.Number,
  routineId: Schema.String,
  runId: Schema.String,
  blobId: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  ranAt: Schema.Number,
  text: Schema.String,
  outputs: Schema.Array(Schema.String),
  /** The hidden execution thread: "Open run" navigates there. */
  executionThreadId: Schema.NullOr(Schema.String),
  resultsThreadId: Schema.String,
});
export type RoutineReportCardPayload = Schema.Schema.Type<typeof RoutineReportCardPayload>;

/** Asks before a routine change lands (another blob's routine without Full access, or the 20-routine guard). */
export const RoutineConfirmCardPayload = Schema.Struct({
  cardKind: Schema.Literal("routine-confirm"),
  cardId: Schema.String,
  version: Schema.Number,
  token: Schema.String,
  blobId: Schema.String,
  summary: Schema.String,
  details: Schema.Array(Schema.String),
  state: Schema.Literals(["open", "confirmed", "dismissed", "failed"]),
  result: Schema.NullOr(Schema.String),
});
export type RoutineConfirmCardPayload = Schema.Schema.Type<typeof RoutineConfirmCardPayload>;

/** A blob wanted an app that is not connected (or not allowed for it): the transcript offers the Connect / Allow chip. */
export const AppConnectCardPayload = Schema.Struct({
  cardKind: Schema.Literal("app-connect"),
  cardId: Schema.String,
  version: Schema.Number,
  blobId: Schema.String,
  toolkit: Schema.String,
  reason: Schema.Literals(["not_connected", "not_granted"]),
});
export type AppConnectCardPayload = Schema.Schema.Type<typeof AppConnectCardPayload>;

/** The payload of a `blob.card` activity; the client shows the highest `version` per `cardId`. */
export const BlobCardPayload = Schema.Union([
  JobCardPayload,
  ProposalCardPayload,
  ConfirmCardPayload,
  MemoryReceiptCardPayload,
  SelfChangeCardPayload,
  RateLimitCardPayload,
  RoutineReportCardPayload,
  RoutineConfirmCardPayload,
  AppConnectCardPayload,
]);
export type BlobCardPayload = Schema.Schema.Type<typeof BlobCardPayload>;

// ── RPC inputs / results ─────────────────────────────────────────────────────────────────────────────────────

export const BlobsSubscribeInput = Schema.Struct({});
export type BlobsSubscribeInput = Schema.Schema.Type<typeof BlobsSubscribeInput>;
export const BlobsListInput = Schema.Struct({});
export type BlobsListInput = Schema.Schema.Type<typeof BlobsListInput>;
export const BlobIdInput = Schema.Struct({ blobId: Schema.String });
export type BlobIdInput = Schema.Schema.Type<typeof BlobIdInput>;
export const BlobCreateInput = Schema.Struct({
  draft: BlobDraft,
  proposalId: Schema.NullOr(Schema.String),
});
export type BlobCreateInput = Schema.Schema.Type<typeof BlobCreateInput>;
export const BlobUpdateInput = Schema.Struct({ blobId: Schema.String, patch: BlobProfilePatch });
export type BlobUpdateInput = Schema.Schema.Type<typeof BlobUpdateInput>;
export const BlobSetTextInput = Schema.Struct({ blobId: Schema.String, text: Schema.String });
export type BlobSetTextInput = Schema.Schema.Type<typeof BlobSetTextInput>;
export const BlobAboutMe = Schema.Struct({ text: Schema.String });
export type BlobAboutMe = Schema.Schema.Type<typeof BlobAboutMe>;
export const BlobDeleteInput = Schema.Struct({
  blobId: Schema.String,
  /** Must equal the blob's current name: the real-delete confirmation. */
  confirmName: Schema.String,
});
export type BlobDeleteInput = Schema.Schema.Type<typeof BlobDeleteInput>;
export const BlobFlagInput = Schema.Struct({ key: BlobFlagKey, value: Schema.Boolean });
export type BlobFlagInput = Schema.Schema.Type<typeof BlobFlagInput>;
export const BlobEmptyResult = Schema.Struct({});
export type BlobEmptyResult = Schema.Schema.Type<typeof BlobEmptyResult>;

export const BlobFilesInput = Schema.Struct({
  blobId: Schema.String,
  since: Schema.NullOr(Schema.Number),
});
export type BlobFilesInput = Schema.Schema.Type<typeof BlobFilesInput>;
export const BlobFiles = Schema.Struct({ files: Schema.Array(WorkspaceFile) });
export type BlobFiles = Schema.Schema.Type<typeof BlobFiles>;

export const BlobMemoryListInput = Schema.Struct({
  scope: BlobMemoryScope,
  blobId: Schema.NullOr(Schema.String),
  includeRetired: Schema.Boolean,
});
export type BlobMemoryListInput = Schema.Schema.Type<typeof BlobMemoryListInput>;
export const BlobMemoryList = Schema.Struct({
  facts: Schema.Array(BlobFact),
  core: Schema.String,
  /** Memories held for the user's OK in this scope (kind "held"; confirm with `blobs.memory.confirm`). Survives reloads. */
  held: Schema.Array(MemoryReceipt),
});
export type BlobMemoryList = Schema.Schema.Type<typeof BlobMemoryList>;
export const BlobMemoryEditInput = Schema.Struct({ factId: Schema.String, text: Schema.String });
export type BlobMemoryEditInput = Schema.Schema.Type<typeof BlobMemoryEditInput>;
export const BlobMemoryFactInput = Schema.Struct({ factId: Schema.String });
export type BlobMemoryFactInput = Schema.Schema.Type<typeof BlobMemoryFactInput>;
export const BlobMemoryImportantInput = Schema.Struct({
  factId: Schema.String,
  important: Schema.Boolean,
});
export type BlobMemoryImportantInput = Schema.Schema.Type<typeof BlobMemoryImportantInput>;
export const BlobMemoryUndoInput = Schema.Struct({ receiptId: Schema.String });
export type BlobMemoryUndoInput = Schema.Schema.Type<typeof BlobMemoryUndoInput>;
export const BlobMemoryConfirmInput = Schema.Struct({
  receiptId: Schema.String,
  save: Schema.Boolean,
});
export type BlobMemoryConfirmInput = Schema.Schema.Type<typeof BlobMemoryConfirmInput>;
export const BlobMemorySetCoreInput = Schema.Struct({
  scope: Schema.Literals(["you", "blob"]),
  blobId: Schema.NullOr(Schema.String),
  text: Schema.String,
});
export type BlobMemorySetCoreInput = Schema.Schema.Type<typeof BlobMemorySetCoreInput>;
export const BlobMemoryCore = Schema.Struct({ core: Schema.String });
export type BlobMemoryCore = Schema.Schema.Type<typeof BlobMemoryCore>;
export const BlobMemorySearchInput = Schema.Struct({
  blobId: Schema.String,
  query: Schema.String,
  limit: Schema.Number,
});
export type BlobMemorySearchInput = Schema.Schema.Type<typeof BlobMemorySearchInput>;
export const BlobMemorySearchResult = Schema.Struct({ episodes: Schema.Array(BlobEpisodeHit) });
export type BlobMemorySearchResult = Schema.Schema.Type<typeof BlobMemorySearchResult>;

export const BlobTemplates = Schema.Struct({ templates: Schema.Array(BlobTemplate) });
export type BlobTemplates = Schema.Schema.Type<typeof BlobTemplates>;
export const BlobHireTemplatesInput = Schema.Struct({ templateIds: Schema.Array(Schema.String) });
export type BlobHireTemplatesInput = Schema.Schema.Type<typeof BlobHireTemplatesInput>;
export const BlobHired = Schema.Struct({ profiles: Schema.Array(BlobProfile) });
export type BlobHired = Schema.Schema.Type<typeof BlobHired>;

export const BlobJobGetInput = Schema.Struct({ jobId: Schema.String });
export type BlobJobGetInput = Schema.Schema.Type<typeof BlobJobGetInput>;
export const BlobJobCancelInput = Schema.Struct({
  jobId: Schema.String,
  stepId: Schema.NullOr(Schema.String),
});
export type BlobJobCancelInput = Schema.Schema.Type<typeof BlobJobCancelInput>;
export const BlobJobFeedbackInput = Schema.Struct({
  jobId: Schema.String,
  stepId: Schema.String,
  reaction: Schema.Literals(["good", "redo"]),
});
export type BlobJobFeedbackInput = Schema.Schema.Type<typeof BlobJobFeedbackInput>;
export const BlobProposalDismissInput = Schema.Struct({ proposalId: Schema.String });
export type BlobProposalDismissInput = Schema.Schema.Type<typeof BlobProposalDismissInput>;
export const BlobConfirmResolveInput = Schema.Struct({
  cardId: Schema.String,
  accept: Schema.Boolean,
});
export type BlobConfirmResolveInput = Schema.Schema.Type<typeof BlobConfirmResolveInput>;
export const BlobConfirmResolveResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  profiles: Schema.Array(BlobProfile),
});
export type BlobConfirmResolveResult = Schema.Schema.Type<typeof BlobConfirmResolveResult>;
/** Undo a blob's own SOUL / model edit: the `undoToken` of a `self-change` card. */
export const BlobUndoSelfChangeInput = Schema.Struct({ token: Schema.String });
export type BlobUndoSelfChangeInput = Schema.Schema.Type<typeof BlobUndoSelfChangeInput>;
export const BlobUndoSelfChangeResult = Schema.Struct({ undone: Schema.Boolean });
export type BlobUndoSelfChangeResult = Schema.Schema.Type<typeof BlobUndoSelfChangeResult>;
export const BlobContinueOnFreeInput = Schema.Struct({ threadId: Schema.String });
export type BlobContinueOnFreeInput = Schema.Schema.Type<typeof BlobContinueOnFreeInput>;
export const BlobContinueOnFreeResult = Schema.Struct({ threadId: Schema.String });
export type BlobContinueOnFreeResult = Schema.Schema.Type<typeof BlobContinueOnFreeResult>;

// ── Phase 4: routines + webhooks ─────────────────────────────────────────────────────────────────────────────
// Twins of runtime/src/blobs/routines/{types,service}.ts (the runtime never imports this file). Every result field is
// required; the webhook SECRET appears only in `RoutineTriggerSecret`, on create / rotate.

export const RoutineCadence = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("interval"),
    everyMinutes: Schema.Number,
    anchor: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    days: Schema.Array(Schema.Number),
    time: Schema.String,
    tz: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("cron"), expr: Schema.String, tz: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("once"), at: Schema.Number }),
]);
export type RoutineCadence = Schema.Schema.Type<typeof RoutineCadence>;

export const RoutineResults = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("thread"), threadId: Schema.String }),
  Schema.Struct({ mode: Schema.Literal("dedicated"), threadId: Schema.NullOr(Schema.String) }),
]);
export type RoutineResults = Schema.Schema.Type<typeof RoutineResults>;

export const RoutineRunStatus = Schema.Literals([
  "queued",
  "active",
  "waiting",
  "completed",
  "missed",
  "failed",
  "cancelled",
]);
export const RoutineRunSource = Schema.Literals(["schedule", "catch-up", "manual", "webhook"]);

export const RoutineRunWire = Schema.Struct({
  id: Schema.String,
  routineId: Schema.String,
  blobId: Schema.String,
  title: Schema.String,
  status: RoutineRunStatus,
  source: RoutineRunSource,
  dueAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number),
  threadId: Schema.NullOr(Schema.String),
  koraThreadId: Schema.NullOr(Schema.String),
  resultsThreadId: Schema.NullOr(Schema.String),
  report: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  outputs: Schema.Array(Schema.String),
  webhookId: Schema.NullOr(Schema.String),
  updatedAt: Schema.Number,
});
export type RoutineRunWire = Schema.Schema.Type<typeof RoutineRunWire>;

export const RoutineTriggerWire = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  url: Schema.String,
  createdAt: Schema.Number,
  rotatedAt: Schema.NullOr(Schema.Number),
  lastEventAt: Schema.NullOr(Schema.Number),
});
export type RoutineTriggerWire = Schema.Schema.Type<typeof RoutineTriggerWire>;

export const RoutineWire = Schema.Struct({
  id: Schema.String,
  blobId: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  cadence: RoutineCadence,
  paused: Schema.Boolean,
  results: RoutineResults,
  rememberLastRun: Schema.Boolean,
  maxRunMinutes: Schema.NullOr(Schema.Number),
  catchUp: Schema.Literals(["none", "one"]),
  triggers: Schema.Array(RoutineTriggerWire),
  cursor: Schema.Number,
  suggestedCadence: Schema.NullOr(Schema.String),
  createdBy: Schema.Literals(["user", "self", "kora", "template"]),
  skipped: Schema.Number,
  lastRunAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  nextRunAt: Schema.NullOr(Schema.Number),
  live: Schema.NullOr(RoutineRunWire),
  lastRun: Schema.NullOr(RoutineRunWire),
});
export type RoutineWire = Schema.Schema.Type<typeof RoutineWire>;

export const RoutinesSnapshot = Schema.Struct({
  routines: Schema.Array(RoutineWire),
  runs: Schema.Array(RoutineRunWire),
  webhook: Schema.Struct({
    baseUrl: Schema.String,
    receiverUp: Schema.Boolean,
    port: Schema.Number,
  }),
});
export type RoutinesSnapshot = Schema.Schema.Type<typeof RoutinesSnapshot>;

export const RoutineThreadChoice = Schema.Struct({ id: Schema.String, title: Schema.String });
export const RoutineThreadsResult = Schema.Struct({ threads: Schema.Array(RoutineThreadChoice) });
export type RoutineThreadsResult = Schema.Schema.Type<typeof RoutineThreadsResult>;

export const RoutinePreviewInput = Schema.Struct({ cadence: RoutineCadence });
export type RoutinePreviewInput = Schema.Schema.Type<typeof RoutinePreviewInput>;
export const RoutinePreviewResult = Schema.Struct({
  words: Schema.String,
  next: Schema.Array(Schema.Number),
});
export type RoutinePreviewResult = Schema.Schema.Type<typeof RoutinePreviewResult>;

export const RoutineSaveInput = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  blobId: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  cadence: RoutineCadence,
  results: RoutineResults,
  rememberLastRun: Schema.Boolean,
  maxRunMinutes: Schema.NullOr(Schema.Number),
  catchUp: Schema.Literals(["none", "one"]),
  paused: Schema.Boolean,
});
export type RoutineSaveInput = Schema.Schema.Type<typeof RoutineSaveInput>;
export const RoutineSetPausedInput = Schema.Struct({
  routineId: Schema.String,
  paused: Schema.Boolean,
});
export type RoutineSetPausedInput = Schema.Schema.Type<typeof RoutineSetPausedInput>;
export const RoutineIdInput = Schema.Struct({ routineId: Schema.String });
export type RoutineIdInput = Schema.Schema.Type<typeof RoutineIdInput>;
export const RoutineRunIdInput = Schema.Struct({ runId: Schema.String });
export type RoutineRunIdInput = Schema.Schema.Type<typeof RoutineRunIdInput>;
export const RoutineRunNowResult = Schema.Struct({ runId: Schema.String });
export type RoutineRunNowResult = Schema.Schema.Type<typeof RoutineRunNowResult>;
export const RoutineCreateTriggerInput = Schema.Struct({
  routineId: Schema.String,
  label: Schema.String,
});
export type RoutineCreateTriggerInput = Schema.Schema.Type<typeof RoutineCreateTriggerInput>;
export const RoutineTriggerIdInput = Schema.Struct({
  routineId: Schema.String,
  triggerId: Schema.String,
});
export type RoutineTriggerIdInput = Schema.Schema.Type<typeof RoutineTriggerIdInput>;
export const RoutineTriggerSecret = Schema.Struct({
  trigger: RoutineTriggerWire,
  secret: Schema.String,
});
export type RoutineTriggerSecret = Schema.Schema.Type<typeof RoutineTriggerSecret>;
export const RoutineConfirmInput = Schema.Struct({ token: Schema.String, accept: Schema.Boolean });
export type RoutineConfirmInput = Schema.Schema.Type<typeof RoutineConfirmInput>;

/** `blobs.routines.subscribe`: one frame whenever a blob's routines or runs change (the client then re-reads the snapshot). */
export const RoutinesChangedEvent = Schema.Struct({
  blobId: Schema.NullOr(Schema.String),
  routineId: Schema.NullOr(Schema.String),
});
export type RoutinesChangedEvent = Schema.Schema.Type<typeof RoutinesChangedEvent>;
export const RoutinesSubscribeInput = Schema.Struct({});

// ── Phase 5: connected apps ──────────────────────────────────────────────────────────────────────────────────

export const AppsUsage = Schema.Struct({
  mode: Schema.Literals(["byo", "broker", "unavailable"]),
  used: Schema.Number,
  /** null = unlimited (the user's own Composio key). */
  limit: Schema.NullOr(Schema.Number),
  month: Schema.String,
  resetsAt: Schema.NullOr(Schema.Number),
  capReached: Schema.Boolean,
});
export type AppsUsage = Schema.Schema.Type<typeof AppsUsage>;

export const AppsStatus = Schema.Struct({
  mode: Schema.Literals(["byo", "broker", "unavailable"]),
  byoKeySet: Schema.Boolean,
  brokerConfigured: Schema.Boolean,
  secretStore: Schema.String,
  usage: Schema.NullOr(AppsUsage),
  /** Why the usage could not be read (the broker is down, this install is unknown to it...), in words; `errorCode` is the stable code. */
  error: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
});
export type AppsStatus = Schema.Schema.Type<typeof AppsStatus>;

export const AppsSetKeyInput = Schema.Struct({ key: Schema.String });
export type AppsSetKeyInput = Schema.Schema.Type<typeof AppsSetKeyInput>;

export const AppToolkitWire = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  logo: Schema.NullOr(Schema.String),
  categories: Schema.Array(Schema.String),
});
export type AppToolkitWire = Schema.Schema.Type<typeof AppToolkitWire>;
export const AppsToolkitsInput = Schema.Struct({
  search: Schema.NullOr(Schema.String),
  cursor: Schema.NullOr(Schema.String),
});
export type AppsToolkitsInput = Schema.Schema.Type<typeof AppsToolkitsInput>;
export const AppsToolkitsResult = Schema.Struct({
  toolkits: Schema.Array(AppToolkitWire),
  nextCursor: Schema.NullOr(Schema.String),
});
export type AppsToolkitsResult = Schema.Schema.Type<typeof AppsToolkitsResult>;

export const AppAccountWire = Schema.Struct({
  id: Schema.String,
  toolkit: Schema.String,
  alias: Schema.NullOr(Schema.String),
  status: Schema.String,
});
export type AppAccountWire = Schema.Schema.Type<typeof AppAccountWire>;
export const AppsAccountsInput = Schema.Struct({ toolkit: Schema.NullOr(Schema.String) });
export type AppsAccountsInput = Schema.Schema.Type<typeof AppsAccountsInput>;
export const AppsAccountsResult = Schema.Struct({ accounts: Schema.Array(AppAccountWire) });
export type AppsAccountsResult = Schema.Schema.Type<typeof AppsAccountsResult>;

export const AppsConnectInput = Schema.Struct({
  toolkit: Schema.String,
  alias: Schema.NullOr(Schema.String),
});
export type AppsConnectInput = Schema.Schema.Type<typeof AppsConnectInput>;
export const AppsConnectResult = Schema.Struct({ url: Schema.String, expiresAt: Schema.Number });
export type AppsConnectResult = Schema.Schema.Type<typeof AppsConnectResult>;
export const AppsDisconnectInput = Schema.Struct({ accountId: Schema.String });
export type AppsDisconnectInput = Schema.Schema.Type<typeof AppsDisconnectInput>;
export const AppsDisconnectResult = Schema.Struct({ removed: Schema.Number });
export type AppsDisconnectResult = Schema.Schema.Type<typeof AppsDisconnectResult>;

export const AppToolWire = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  toolkit: Schema.String,
  readOnly: Schema.NullOr(Schema.Boolean),
  /** Sends / posts / deletes / pays / books or cannot be classified: always asks the user first (except on Full access). */
  outbound: Schema.Boolean,
});
export type AppToolWire = Schema.Schema.Type<typeof AppToolWire>;
export const AppsToolsInput = Schema.Struct({ toolkit: Schema.String });
export type AppsToolsInput = Schema.Schema.Type<typeof AppsToolsInput>;
export const AppsToolsResult = Schema.Struct({ tools: Schema.Array(AppToolWire) });
export type AppsToolsResult = Schema.Schema.Type<typeof AppsToolsResult>;

export const AppDecisionWire = Schema.Struct({
  at: Schema.Number,
  kind: Schema.Literals(["decision", "result"]),
  blobId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  tool: Schema.String,
  toolkit: Schema.String,
  account: Schema.NullOr(Schema.String),
  decision: Schema.Literals(["allow", "deny"]),
  reason: Schema.String,
  outbound: Schema.Boolean,
  outcome: Schema.NullOr(Schema.String),
});
export type AppDecisionWire = Schema.Schema.Type<typeof AppDecisionWire>;
export const AppsDecisionsInput = Schema.Struct({
  blobId: Schema.NullOr(Schema.String),
  limit: Schema.Number,
});
export type AppsDecisionsInput = Schema.Schema.Type<typeof AppsDecisionsInput>;
export const AppsDecisionsResult = Schema.Struct({ decisions: Schema.Array(AppDecisionWire) });
export type AppsDecisionsResult = Schema.Schema.Type<typeof AppsDecisionsResult>;
