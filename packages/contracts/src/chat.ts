import * as Struct from "effect/Struct";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ThreadMessageContext } from "./contextChip.ts";
import { AgentOptionSelections } from "./agentOptions.ts";
import { RepositoryIdentity, ThreadWorkspaceMode } from "./host.ts";
import {
  TurnId,
  TrimmedString,
  NonblankString,
  ThreadId,
  AgentItemId,
  ProjectId,
  CountingNumber,
  WholeNumber,
  ItemId,
  IsoInstant,
  EventId,
  DispatchCommandId,
  ClientSurface,
  TurnCheckpointRef,
  RequestId,
} from "./primitives.ts";
import { migrateLegacyAgentId, AgentProfileId } from "./agentProfile.ts";
import {
  MergeRequestState,
  MergeRequestReviewDecision,
  MergeRequestMergeability,
  MergeRequestChecksState,
  MergeRequestActor,
} from "./mergeRequest.ts";

export const CHAT_METHODS = {
  dispatch: "chat.dispatch",
  listArchivedThreads: "chat.thread.listArchived",
  subscribeThreads: "chat.threads.subscribe",
  subscribeThread: "chat.thread.subscribe",
} as const;

const EAGER_APPROVALS = ["untrusted", "on-failure", "on-request"] as const;
export const AgentApprovalPolicy = Schema.Literals([...EAGER_APPROVALS, "never"]);
export type AgentApprovalPolicy = typeof AgentApprovalPolicy.Type;
const SANDBOX_LEVELS = ["read-only", "workspace-write"] as const;
export const AgentSandboxMode = Schema.Literals([...SANDBOX_LEVELS, "danger-full-access"]);
export type AgentSandboxMode = typeof AgentSandboxMode.Type;

/**
 * `ModelPick` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultProfileIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelPickWire = Schema.Struct({
  instanceId: AgentProfileId,
  model: NonblankString,
  options: Schema.optionalKey(AgentOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelPickSource = Schema.Struct({
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  provider: Schema.optional(Schema.Unknown),
});

export const ModelPick = ModelPickSource.pipe(
  Schema.decodeTo(
    ModelPickWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultProfileIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `AgentProfileId`.
        const legacySlug = typeof raw.provider === "string" ? raw.provider : undefined;
        const routing = migrateLegacyAgentId(raw.instanceId ?? legacySlug);
        const decoded: Record<string, unknown> = { model: raw.model, instanceId: routing };
        if (raw.options !== undefined) decoded.options = raw.options;
        return Effect.succeed(decoded as typeof ModelPickWire.Encoded);
      },
      encode: (value) => {
        const legacy: Record<string, unknown> = {
          instanceId: value.instanceId,
          model: value.model,
        };
        if (value.options !== undefined) legacy.options = value.options;
        return Effect.succeed(legacy as typeof ModelPickSource.Encoded);
      },
    }),
  ),
);
export type ModelPick = typeof ModelPick.Type;

const GUARDED_ACCESS = ["approval-required", "auto-accept-edits"] as const;
export const AccessMode = Schema.Literals([...GUARDED_ACCESS, "auto", "full-access"]);
export type AccessMode = typeof AccessMode.Type;
export const DEFAULT_ACCESS_MODE: AccessMode = "full-access";
export const AgentTurnMode = Schema.Literals(["default", "plan"]);
export type AgentTurnMode = typeof AgentTurnMode.Type;
export const DEFAULT_AGENT_TURN_MODE: AgentTurnMode = "default";
/**
 * How the thread's agent works: a plain CHAT agent, an ORCHESTRATOR that coordinates a
 * fleet of worker agents (live terminal panes the human can steer), or SWARM — Claude leads
 * and free-model OpenCode workers do the legwork in steerable panes. Picked in the composer
 * ("Chat | Orchestrator | Swarm"); orthogonal to plan/build (`interactionMode`).
 */
export const ThreadAgentMode = Schema.Literals(["chat", "orchestrator", "swarm"]);
export type ThreadAgentMode = typeof ThreadAgentMode.Type;
export const DEFAULT_THREAD_AGENT_MODE: ThreadAgentMode = "chat";
/**
 * Modes that can have workers — every mode: a plain chat delegates too (kora_spawn after the worker picker), so its
 * workers show as blobs / panes, notes reach it, and the fleet panel is offered. Mirrors the runtime's
 * `isFleetAgentMode` (packages/runtime/src/session/events.ts). An unknown future mode fails closed (false).
 */
export const isFleetAgentMode = (m: ThreadAgentMode): boolean =>
  m === "chat" || m === "orchestrator" || m === "swarm";
const THREAD_AGENT_MODES: ReadonlyArray<string> = ThreadAgentMode.literals;
/**
 * Server → client agent mode, decoded leniently: any string is accepted and an UNKNOWN value
 * (a mode added by a newer daemon) maps to "orchestrator" instead of failing the decode, which
 * would tear the shell/thread stream for a stale bundle. A missing key defaults to "chat".
 */
const LenientThreadAgentMode = Schema.String.pipe(
  Schema.decodeTo(
    ThreadAgentMode,
    SchemaTransformation.transform({
      decode: (raw: string): ThreadAgentMode =>
        THREAD_AGENT_MODES.includes(raw) ? (raw as ThreadAgentMode) : "orchestrator",
      encode: (mode: ThreadAgentMode): string => mode,
    }),
  ),
);
const AgentModeWithDefault = LenientThreadAgentMode.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_AGENT_MODE)),
);
export const AgentRequestKind = Schema.Literals([
  "command",
  ...(["file-read", "file-change"] as const),
  "mcp-elicitation",
]);
export type AgentRequestKind = typeof AgentRequestKind.Type;
export const AgentApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type AgentApprovalDecision = typeof AgentApprovalDecision.Type;
export const AgentApprovalOption = Schema.Struct({
  decision: AgentApprovalDecision,
  label: NonblankString,
  /** Provider-supplied caution shown next to the option, such as a prompt injection warning. */
  warning: Schema.optional(NonblankString),
});
export type AgentApprovalOption = typeof AgentApprovalOption.Type;
export const AgentUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type AgentUserInputAnswers = typeof AgentUserInputAnswers.Type;

const MEBIBYTE = 1_048_576;
export const AGENT_SEND_TURN_MAX_ATTACHMENTS = 8;
export const AGENT_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const AGENT_SEND_TURN_MAX_FILE_BYTES = MEBIBYTE * 50;
export const AGENT_SEND_TURN_MAX_IMAGE_BYTES = MEBIBYTE * 10;
/** Composer uploads ride the UI websocket as base64 data URLs, so a non-image upload is capped
 *  well below the stored-file limit: a 25 MB file is ~34 MB of JSON on the daemon's event loop. */
export const AGENT_SEND_TURN_MAX_UPLOAD_FILE_BYTES = MEBIBYTE * 25;
const LEGACY_IMAGE_TYPES = ["image/gif", "image/jpeg"] as const;
export const AGENT_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES = [
  ...LEGACY_IMAGE_TYPES,
  "image/png",
  "image/webp",
] as const;

const AGENT_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const AGENT_SEND_TURN_MAX_UPLOAD_FILE_DATA_URL_CHARS = 35_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
const PromptAttachmentId = NonblankString.check(
  Schema.isPattern(/^[a-z0-9_-]+$/i),
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
);
export type PromptAttachmentId = (typeof PromptAttachmentId)["Type"];

const CAPTURE_ACCESSIBLE_TEXT_MAX_CHARS = 32_000;
const CAPTURE_ACCESSIBILITY_MAX_NODES = 10_000;
const CAPTURE_ACCESSIBILITY_MAX_SERIALIZED_CHARS = 32_000;

const CaptureAccessibilityBounds = Schema.Struct({
  x: WholeNumber,
  y: WholeNumber,
  width: CountingNumber,
  height: CountingNumber,
});

const optionalFlag = Schema.optional(Schema.Boolean);
const CaptureAccessibilityState = Schema.Struct({
  visible: optionalFlag,
  selected: optionalFlag,
  focused: optionalFlag,
  expanded: optionalFlag,
  enabled: optionalFlag,
  editable: optionalFlag,
  checked: Schema.optional(Schema.Literals(["on", "off", "mixed"])),
  busy: optionalFlag,
  active: optionalFlag,
});

export interface CaptureAccessibilityNode {
  readonly children: Array<CaptureAccessibilityNode>;
  readonly actions?: Array<string>;
  readonly state?: typeof CaptureAccessibilityState.Type;
  readonly bounds: typeof CaptureAccessibilityBounds.Type | null;
  readonly description?: string;
  readonly value?: string;
  readonly name?: string;
  readonly role: string;
}

/** Non-blank text of at most `max` characters. */
const textUpTo = (max: number) => NonblankString.check(Schema.isMaxLength(max));
/** A mutable array of at most `max` items. */
const listUpTo = <S extends Schema.Top>(item: S, max: number) =>
  Schema.mutable(Schema.Array(item)).check(Schema.isMaxLength(max));

const childNodeCodec = (): Schema.Codec<CaptureAccessibilityNode> => CaptureAccessibilityNode;
const optionalText = (max: number) => Schema.optionalKey(textUpTo(max));

export const CaptureAccessibilityNode: Schema.Codec<CaptureAccessibilityNode> = Schema.Struct({
  role: textUpTo(100),
  name: optionalText(1_000),
  value: optionalText(8_000),
  description: optionalText(2_000),
  bounds: Schema.NullOr(CaptureAccessibilityBounds),
  state: Schema.optionalKey(CaptureAccessibilityState),
  actions: Schema.optionalKey(listUpTo(textUpTo(100), 32)),
  children: listUpTo(Schema.suspend(childNodeCodec), CAPTURE_ACCESSIBILITY_MAX_NODES),
});

const CaptureAccessibilityWire = Schema.Union([
  Schema.Struct({
    truncated: Schema.Boolean,
    text: NonblankString.check(Schema.isMaxLength(CAPTURE_ACCESSIBLE_TEXT_MAX_CHARS)),
    format: Schema.Literal("flat-text"),
  }),
  Schema.Struct({
    root: CaptureAccessibilityNode,
    truncated: Schema.Boolean,
    imageSize: Schema.Struct({ width: CountingNumber, height: CountingNumber }),
    coordinateSpace: Schema.Literal("captured-image"),
    format: Schema.Literal("element-tree"),
  }),
]);
export const CaptureAccessibility = CaptureAccessibilityWire.check(
  Schema.makeFilter((accessibility: typeof CaptureAccessibilityWire.Type) => {
    if (accessibility.format !== "element-tree") return undefined;
    let visited = 0;
    const pending = [accessibility.root];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      visited += 1;
      if (visited > CAPTURE_ACCESSIBILITY_MAX_NODES) {
        return `Accessibility trees must not exceed ${CAPTURE_ACCESSIBILITY_MAX_NODES} nodes.`;
      }
      pending.push(...node.children);
    }
    return (
      JSON.stringify(accessibility).length <= CAPTURE_ACCESSIBILITY_MAX_SERIALIZED_CHARS ||
      `Accessibility trees must not exceed ${CAPTURE_ACCESSIBILITY_MAX_SERIALIZED_CHARS} serialized characters.`
    );
  }),
);
export type CaptureAccessibility = typeof CaptureAccessibility.Type;

const PngDataUrl = NonblankString.check(
  Schema.isMaxLength(100_000),
  Schema.isPattern(/^data:image\/png;base64,/i),
);

export const CaptureSource = Schema.Struct({
  kind: Schema.Literal("capture"),
  capturedAt: IsoInstant,
  appName: textUpTo(255),
  windowTitle: TrimmedString.check(Schema.isMaxLength(1_000)),
  accessibleText: Schema.optional(textUpTo(CAPTURE_ACCESSIBLE_TEXT_MAX_CHARS)),
  accessibility: Schema.optional(CaptureAccessibility),
  appIdentifier: Schema.optional(textUpTo(255)),
  appIconDataUrl: Schema.optional(PngDataUrl),
});
export type CaptureSource = typeof CaptureSource.Type;

const AttachmentName = textUpTo(255);
/** The id and display name every stored attachment carries, right after its `type`. */
const storedAttachmentHead = { id: PromptAttachmentId, name: AttachmentName } as const;
const bytesAtMost = (max: number) => WholeNumber.check(Schema.isLessThanOrEqualTo(max));

export const MessageImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  ...storedAttachmentHead,
  mimeType: textUpTo(100).check(Schema.isPattern(/^image\//i)),
  sizeBytes: bytesAtMost(AGENT_SEND_TURN_MAX_IMAGE_BYTES),
  source: Schema.optional(CaptureSource),
});
export type MessageImageAttachment = Schema.Schema.Type<typeof MessageImageAttachment>;

export const PastedTextAttachmentSource = Schema.TaggedStruct("pasted-text", {});
export type PastedTextAttachmentSource = Schema.Schema.Type<typeof PastedTextAttachmentSource>;

export const MessageFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  ...storedAttachmentHead,
  mimeType: textUpTo(100),
  sizeBytes: bytesAtMost(AGENT_SEND_TURN_MAX_FILE_BYTES).check(Schema.isGreaterThanOrEqualTo(1)),
  /**
   * Clipboard text folded by a client. Providers keep these path-only so the agent
   * can inspect the file selectively instead of eagerly spending the same context
   * the fold is intended to preserve.
   */
  source: Schema.optional(PastedTextAttachmentSource),
});
export type MessageFileAttachment = typeof MessageFileAttachment.Type;

/**
 * Catch-all for attachment types this build does not know. Attachments ride on
 * persisted events and thread streams, so a newer server or client must be able
 * to introduce a type without making older readers fail to decode the whole
 * message. Decoders keep the shared base fields; consumers skip these or render
 * them as unsupported. Mirrors how `ChatThreadActivity` keeps `kind`
 * open. The known discriminators are excluded so a malformed image or file
 * attachment fails its own schema instead of sliding through here with its
 * size and mime constraints unchecked.
 */
const NotAKnownAttachmentType = textUpTo(50).check(Schema.isPattern(/^(?!(?:image|file)$)/));

export const ChatUnknownAttachment = Schema.Struct({
  type: NotAKnownAttachmentType,
  ...storedAttachmentHead,
  mimeType: textUpTo(100),
  sizeBytes: WholeNumber,
});
export type ChatUnknownAttachment = typeof ChatUnknownAttachment.Type;

/** A stored image plus its bytes as a data URL, as a client uploads it. */
const UploadChatImageAttachment = Schema.Struct({
  ...MessageImageAttachment.fields,
  /** Client-side id, so context records can bind to the attachment before it has a server id. */
  id: Schema.optional(PromptAttachmentId),
  dataUrl: textUpTo(AGENT_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const MessageAttachment = Schema.Union([
  MessageImageAttachment,
  MessageFileAttachment,
  ChatUnknownAttachment,
]);
export type MessageAttachment = typeof MessageAttachment.Type;

export const AskAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([MessageImageAttachment, MessageFileAttachment])).pipe(
    Schema.check(Schema.isMaxLength(AGENT_SEND_TURN_MAX_ATTACHMENTS)),
  ),
);
export type AskAttachments = typeof AskAttachments.Type;

export const AskAttachmentAnswerPayload = Schema.Struct({
  requestId: RequestId,
  questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  answers: AgentUserInputAnswers,
  attachmentsByQuestionId: AskAttachments,
});
export type AskAttachmentAnswerPayload = typeof AskAttachmentAnswerPayload.Type;
/** Any non-image file (PDF, video, archive, data…): stored by the daemon and handed to the agent
 *  natively (PDF → Claude document block) or as a readable path. */
const UploadChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  /** Client-side id, so context records can bind to the attachment before it has a server id. */
  id: Schema.optional(PromptAttachmentId),
  name: NonblankString.check(Schema.isMaxLength(255)),
  mimeType: NonblankString.check(Schema.isMaxLength(100)),
  sizeBytes: WholeNumber.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(AGENT_SEND_TURN_MAX_UPLOAD_FILE_BYTES),
  ),
  dataUrl: NonblankString.check(Schema.isMaxLength(AGENT_SEND_TURN_MAX_UPLOAD_FILE_DATA_URL_CHARS)),
});
export type UploadChatFileAttachment = typeof UploadChatFileAttachment.Type;

const UploadMessageAttachment = Schema.Union([UploadChatImageAttachment, UploadChatFileAttachment]);
export type UploadMessageAttachment = typeof UploadMessageAttachment.Type;

export const ProjectCommandIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectCommandIcon = typeof ProjectCommandIcon.Type;

export const ProjectAction = Schema.Struct({
  id: NonblankString,
  name: NonblankString,
  command: NonblankString,
  icon: ProjectCommandIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /**
   * For `runOnWorktreeCreate` scripts: when false, the agent's first turn waits
   * for the script to exit. Absent or true starts the agent right away and
   * lets the script finish in the background.
   */
  async: Schema.optional(Schema.Boolean),
  /**
   * URL to open in the in-app browser preview when this script runs (or
   * when the user explicitly requests a preview). Optional; only honored on
   * the desktop build.
   */
  previewUrl: Schema.optional(NonblankString),
  /**
   * When true, automatically open the preview panel pointed at `previewUrl`
   * the moment this script starts. Ignored without `previewUrl` or on web.
   */
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectAction = typeof ProjectAction.Type;

export const ProjectFaviconPath = NonblankString.check(
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
  Schema.isMaxLength(1024),
);
export type ProjectFaviconPath = (typeof ProjectFaviconPath)["Type"];

export const ProjectBadgeColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectBadgeColor = typeof ProjectBadgeColor.Type;

const ProjectLucideIconName = NonblankString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

const ProjectEmoji = NonblankString.check(Schema.isMaxLength(32));

const initialsSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const ProjectMonogramText = NonblankString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u),
  Schema.makeFilter((text) => Array.from(initialsSegmenter.segment(text)).length <= 2),
);

const LucideProjectIcon = Schema.Struct({
  kind: Schema.Literal("lucide"),
  name: ProjectLucideIconName,
  color: ProjectBadgeColor,
  // Older clients ignore this field and render the named Lucide icon instead.
  monogram: Schema.optional(ProjectMonogramText),
});
const EmojiProjectIcon = Schema.Struct({ kind: Schema.Literal("emoji"), emoji: ProjectEmoji });

export const ProjectIconOverride = Schema.Union([LucideProjectIcon, EmojiProjectIcon]);
export type ProjectIconOverride = typeof ProjectIconOverride.Type;

/**
 * Which top-level surface a project belongs to. "code" = a repo/folder the Code surface works in (graph,
 * worktrees, merge gate). "blobs" = a blob's working folder under ~/Blobs (one project per blob,
 * `projectId === blobId`; no graph, no worktree). Absent = "code". (The old Chat surface, "chat", was folded into
 * Kora in 2026-10; its projects became blobs.)
 */
export const ProjectSurface = Schema.Literals(["code", "blobs"]);
export type ProjectSurface = typeof ProjectSurface.Type;

/**
 * Per-project switches a user can set or clear: background pull, favicon path and icon.
 * All optional on the wire so snapshots and commands from older builds still decode.
 */
const projectLookOverrides = {
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
} as const;

export const ChatProject = Schema.Struct({
  id: ProjectId,
  title: NonblankString,
  workspaceRoot: NonblankString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelPick),
  // Per-project override for where new threads start. Null/absent means
  // "no override": clients fall back to kora.json, then the global setting.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadWorkspaceMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  // Optional on the wire so cached snapshots from older servers still decode.
  // Optional on the wire so cached snapshots from older servers still decode.
  ...projectLookOverrides,
  surface: Schema.optional(ProjectSurface),
  scripts: Schema.Array(ProjectAction),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
  deletedAt: Schema.NullOr(IsoInstant),
});
export type ChatProject = typeof ChatProject.Type;

export const ThreadMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type ThreadMessageRole = typeof ThreadMessageRole.Type;

/**
 * A user-role message Kora (not the human) sent to the agent: a mode-switch notice and/or
 * queued fleet notes. The web renders it as a compact muted row, never as a user bubble; it
 * still counts as a user-role turn boundary. Old bundles ignore the key (a plain bubble).
 */
export const ThreadMessageNotice = Schema.Struct({
  kind: Schema.Literals(["agent-mode-switched", "fleet-note"]),
  from: Schema.optionalKey(LenientThreadAgentMode),
  to: Schema.optionalKey(LenientThreadAgentMode),
});
export type ThreadMessageNotice = typeof ThreadMessageNotice.Type;

export const ThreadMessage = Schema.Struct({
  id: ItemId,
  role: ThreadMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(MessageAttachment)),
  context: Schema.optional(ThreadMessageContext),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
  notice: Schema.optionalKey(ThreadMessageNotice),
  /** Blobs groups: the blob that wrote this assistant message (a group thread has many authors). Absent in single-blob threads. */
  authorBlobId: Schema.optionalKey(Schema.String),
  /** Blobs groups: the blob ids a user message was routed to ("to Popo, Junip"). */
  to: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Blobs groups: how the routing was decided (mention / all / lead / auto / auto-fallback ...). */
  routeWhy: Schema.optionalKey(Schema.String),
  /** Blobs groups: a system note ("Junip is taking too long, so the group moved on."), drawn as a muted centred row. */
  kind: Schema.optionalKey(Schema.Literal("note")),
  /** Blobs outside access: the client name when the person's message came in through `kora mcp --team`. */
  via: Schema.optionalKey(Schema.String),
});
export type ThreadMessage = Schema.Schema.Type<typeof ThreadMessage>;

export const ChatPlanProposalId = NonblankString;
export type ChatPlanProposalId = Schema.Schema.Type<typeof ChatPlanProposalId>;

export const ChatPlanProposal = Schema.Struct({
  id: ChatPlanProposalId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: NonblankString,
  implementedAt: Schema.NullOr(IsoInstant).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});
export type ChatPlanProposal = typeof ChatPlanProposal.Type;

const SourcePlanProposalReference = Schema.Struct({
  threadId: ThreadId,
  planId: ChatPlanProposalId,
});

export const ChatSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type ChatSessionStatus = typeof ChatSessionStatus.Type;

export const ChatSession = Schema.Struct({
  threadId: ThreadId,
  status: ChatSessionStatus,
  providerName: Schema.NullOr(NonblankString),
  providerInstanceId: Schema.optional(AgentProfileId),
  runtimeMode: AccessMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_ACCESS_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(NonblankString),
  updatedAt: IsoInstant,
});
export type ChatSession = typeof ChatSession.Type;

export const ChatCheckpointFile = Schema.Struct({
  path: NonblankString,
  kind: NonblankString,
  additions: WholeNumber,
  deletions: WholeNumber,
});
export type ChatCheckpointFile = typeof ChatCheckpointFile.Type;

export const ChatCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type ChatCheckpointStatus = typeof ChatCheckpointStatus.Type;

export const ChatCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: WholeNumber,
  checkpointRef: TurnCheckpointRef,
  status: ChatCheckpointStatus,
  files: Schema.Array(ChatCheckpointFile),
  assistantMessageId: Schema.NullOr(ItemId),
  completedAt: IsoInstant,
});
export type ChatCheckpointSummary = Schema.Schema.Type<typeof ChatCheckpointSummary>;

export const ChatThreadActivityTone = Schema.Literals(["info", "tool", "approval", "error"]);
export type ChatThreadActivityTone = Schema.Schema.Type<typeof ChatThreadActivityTone>;

export const ChatThreadActivity = Schema.Struct({
  id: EventId,
  tone: ChatThreadActivityTone,
  kind: NonblankString,
  summary: NonblankString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(WholeNumber),
  createdAt: IsoInstant,
});
export type ChatThreadActivity = typeof ChatThreadActivity.Type;

const ChatLatestTurnState = Schema.Literals(["running", "interrupted", "completed", "error"]);
export type ChatLatestTurnState = typeof ChatLatestTurnState.Type;

export const ChatLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: ChatLatestTurnState,
  requestedAt: IsoInstant,
  startedAt: Schema.NullOr(IsoInstant),
  completedAt: Schema.NullOr(IsoInstant),
  assistantMessageId: Schema.NullOr(ItemId),
  sourceProposedPlan: Schema.optional(SourcePlanProposalReference),
});
export type ChatLatestTurn = typeof ChatLatestTurn.Type;

// Version changes even when a manual rename keeps the same text.
export const ThreadTitleState = Schema.Struct({
  source: Schema.Literals(["manual", "generated"]),
  version: DispatchCommandId,
  needsRefinement: Schema.Boolean,
});
export type ThreadTitleState = Schema.Schema.Type<typeof ThreadTitleState>;

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: DispatchCommandId,
  startedAt: IsoInstant,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

/**
 * Legacy single-PR link. Still emitted as the thread's derived current pull
 * request (see `@kora/shared/threadPullRequests`) so clients from before
 * `pullRequests` keep working independently of their release schedule.
 */
export const ThreadLinkedMergeRequest = Schema.Struct({
  projectId: ProjectId,
  repository: NonblankString,
  number: CountingNumber,
  url: NonblankString,
});
export type ThreadLinkedMergeRequest = typeof ThreadLinkedMergeRequest.Type;

/** Who created a thread ↔ pull request link. `stack-dismissed` is a tombstone
 * for a native-stack member the user unlinked, so the sync reactor does not
 * re-add it; clients hide it. */
export const ThreadMergeRequestLinkSource = Schema.Literals([
  "manual",
  "created",
  "agent",
  "stack",
  "stack-dismissed",
]);
export type ThreadMergeRequestLinkSource = typeof ThreadMergeRequestLinkSource.Type;

/**
 * Host state persisted on a link by the sync reactor; null until first sync. The overview
 * fields are optional: a host whose cheap read lacks them leaves them out, and snapshots
 * written before they existed still decode.
 */
export const ThreadMergeRequestSnapshot = Schema.Struct({
  state: MergeRequestState,
  title: NonblankString,
  headBranch: NonblankString,
  baseBranch: NonblankString,
  isDraft: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoInstant),
  syncedAt: IsoInstant,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(MergeRequestActor)),
  additions: Schema.optional(WholeNumber),
  deletions: Schema.optional(WholeNumber),
  changedFiles: Schema.optional(WholeNumber),
  reviewDecision: Schema.optional(Schema.NullOr(MergeRequestReviewDecision)),
  checksState: Schema.optional(Schema.NullOr(MergeRequestChecksState)),
  mergeability: Schema.optional(MergeRequestMergeability),
});
export type ThreadMergeRequestSnapshot = typeof ThreadMergeRequestSnapshot.Type;

export const ThreadMergeRequestStackLayer = Schema.Struct({
  number: CountingNumber,
  headBranch: NonblankString,
  state: MergeRequestState,
});
export type ThreadMergeRequestStackLayer = typeof ThreadMergeRequestStackLayer.Type;

/** A host-native stack the pull request belongs to. Layers run bottom to top. */
export const ThreadMergeRequestStack = Schema.Struct({
  kind: Schema.Literal("native"),
  id: NonblankString,
  number: CountingNumber,
  url: NonblankString,
  base: NonblankString,
  layers: Schema.Array(ThreadMergeRequestStackLayer),
});
export type ThreadMergeRequestStack = typeof ThreadMergeRequestStack.Type;

/** Identity of a pull request as a thread link sees it: host-level, so the
 * same PR linked from two projects (or two environments) compares equal. */
export const ThreadMergeRequestKey = Schema.Struct({
  host: NonblankString,
  repository: NonblankString,
  number: CountingNumber,
});
export type ThreadMergeRequestKey = typeof ThreadMergeRequestKey.Type;

export const ThreadMergeRequestLink = Schema.Struct({
  ...ThreadMergeRequestKey.fields,
  url: NonblankString,
  source: ThreadMergeRequestLinkSource,
  linkedAt: IsoInstant,
  snapshot: Schema.NullOr(ThreadMergeRequestSnapshot),
  stack: Schema.NullOr(ThreadMergeRequestStack),
});
export type ThreadMergeRequestLink = typeof ThreadMergeRequestLink.Type;

/**
 * Where a thread came from (Blobs). Absent / null = started by the user. "kora" = delegated by the Chief (a job
 * step), "routine" = a scheduled run, "continue" = a rate-limit "continue on a free model" seed. Nullable ids, never
 * undefined.
 */
export const ThreadOrigin = Schema.Struct({
  kind: Schema.Literals(["user", "kora", "routine", "continue", "group"]),
  jobId: Schema.NullOr(Schema.String),
  stepId: Schema.NullOr(Schema.String),
  fromThreadId: Schema.NullOr(Schema.String),
  fromBlobId: Schema.NullOr(Schema.String),
  /** "routine" threads only: which routine / which run this hidden execution thread belongs to. */
  routineId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  runId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** "group" threads only: a member's own provider session for a group thread (hidden; the group thread is the transcript). */
  groupId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  groupThreadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Outside access: the client name that started this thread through `kora mcp --team`. */
  via: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ThreadOrigin = typeof ThreadOrigin.Type;

export const ChatThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: NonblankString,
  modelSelection: ModelPick,
  runtimeMode: AccessMode,
  interactionMode: AgentTurnMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_TURN_MODE)),
  ),
  agentMode: AgentModeWithDefault,
  branch: Schema.NullOr(NonblankString),
  worktreePath: Schema.NullOr(NonblankString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedMergeRequest)),
  // Optional so payloads from pre-link servers still decode.
  pullRequests: Schema.Array(ThreadMergeRequestLink).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedMergeRequest)),
  latestTurn: Schema.NullOr(ChatLatestTurn),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
  archivedAt: Schema.NullOr(IsoInstant).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoInstant).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // When the thread last re-entered the active list (any thread.unsettled).
  // Anchors the active-list sort so an unsettled thread surfaces at the top
  // instead of sinking back to its creation-order slot. Cleared on settle.
  // Optional so payloads from pre-stamp servers still decode.
  unsettledAt: Schema.optional(Schema.NullOr(IsoInstant)),
  // Snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // Optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoInstant)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoInstant)),
  // Active pinned threads render in the pinned block. Settled and snoozed
  // threads remain in their respective shelves even when pinned.
  // Optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoInstant)),
  // Fractional index for user-arranged pinned order. Keyed threads sort by
  // string comparison ahead of keyless ones (which keep creation order), so
  // servers never need each other's threads to agree on the merged list.
  // Optional so payloads from pre-reorder servers still decode.
  pinOrderKey: Schema.optional(Schema.NullOr(NonblankString)),
  // Manual Active placement. Keyless threads retain their creation/re-entry
  // order above the arranged run. Settling clears this slot.
  activeOrderKey: Schema.optional(Schema.NullOr(NonblankString)),
  // Pending-only state. Optional so older servers remain compatible.
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  /** Blobs: where the thread came from (absent / null = the user started it). */
  origin: Schema.optional(Schema.NullOr(ThreadOrigin)),
  /** Blobs: a routine's execution thread. It never shows in a sidebar / list; it is reachable by id ("Open run"). */
  hidden: Schema.optional(Schema.Boolean),
  deletedAt: Schema.NullOr(IsoInstant),
  messages: Schema.Array(ThreadMessage),
  proposedPlans: Schema.Array(ChatPlanProposal).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(ChatThreadActivity),
  checkpoints: Schema.Array(ChatCheckpointSummary),
  session: Schema.NullOr(ChatSession),
});
export type ChatThread = typeof ChatThread.Type;

export const ChatReadModel = Schema.Struct({
  seq: WholeNumber,
  projects: Schema.Array(ChatProject),
  threads: Schema.Array(ChatThread),
  updatedAt: IsoInstant,
});
export type ChatReadModel = typeof ChatReadModel.Type;

export const ChatProjectHead = Schema.Struct({
  id: ProjectId,
  title: NonblankString,
  workspaceRoot: NonblankString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelPick),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadWorkspaceMode)),
  // Optional on the wire so cached snapshots from older servers still decode.
  ...projectLookOverrides,
  surface: Schema.optional(ProjectSurface),
  scripts: Schema.Array(ProjectAction),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});
export type ChatProjectHead = typeof ChatProjectHead.Type;

const BackgroundLiveness = Schema.Literals(["working", "monitoring"]);
const PlanProgress = Schema.Struct({
  step: NonblankString,
  completedSteps: WholeNumber,
  totalSteps: WholeNumber,
});

export const ChatThreadHead = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: NonblankString,
  modelSelection: ModelPick,
  runtimeMode: AccessMode,
  interactionMode: AgentTurnMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_TURN_MODE)),
  ),
  agentMode: AgentModeWithDefault,
  branch: Schema.NullOr(NonblankString),
  worktreePath: Schema.NullOr(NonblankString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedMergeRequest)),
  pullRequests: Schema.Array(ThreadMergeRequestLink).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedMergeRequest)),
  latestTurn: Schema.NullOr(ChatLatestTurn),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
  archivedAt: Schema.NullOr(IsoInstant).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoInstant).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // See ChatThread.unsettledAt: last re-entry into the active list.
  unsettledAt: Schema.optional(Schema.NullOr(IsoInstant)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoInstant)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoInstant)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoInstant)),
  pinOrderKey: Schema.optional(Schema.NullOr(NonblankString)),
  activeOrderKey: Schema.optional(Schema.NullOr(NonblankString)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  /** Blobs: where the thread came from (absent / null = the user started it). */
  origin: Schema.optional(Schema.NullOr(ThreadOrigin)),
  /** Blobs: a routine's execution thread. It never shows in a sidebar / list; it is reachable by id ("Open run"). */
  hidden: Schema.optional(Schema.Boolean),
  session: Schema.NullOr(ChatSession),
  latestUserMessageAt: Schema.NullOr(IsoInstant),
  hasActionableProposedPlan: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasPendingApprovals: Schema.Boolean,
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(BackgroundLiveness)),
  /**
   * Current plan step while a turn runs, for the Working indicators
   * (sidebar row, in-chat working line). Cleared when the turn settles —
   * never persists as stale UI. Optional so old servers/clients interop.
   */
  planProgress: Schema.optional(Schema.NullOr(PlanProgress)),
});
export type ChatThreadHead = typeof ChatThreadHead.Type;

export const ThreadIndexSnapshot = Schema.Struct({
  seq: WholeNumber,
  projects: Schema.Array(ChatProjectHead),
  threads: Schema.Array(ChatThreadHead),
  updatedAt: IsoInstant,
});
export type ThreadIndexSnapshot = typeof ThreadIndexSnapshot.Type;

/** One index change: a `kind` tag, its sequence number, then what changed. */
const indexChange = <const Kind extends string, const Body extends Schema.Struct.Fields>(
  kind: Kind,
  body: Body,
) => Schema.Struct({ kind: Schema.Literal(kind), sequence: WholeNumber, ...body });

export const ThreadIndexEvent = Schema.Union([
  indexChange("project-upserted", { project: ChatProjectHead }),
  indexChange("project-removed", { projectId: ProjectId }),
  indexChange("thread-upserted", { thread: ChatThreadHead }),
  indexChange("thread-removed", { threadId: ThreadId }),
]);
export type ThreadIndexEvent = typeof ThreadIndexEvent.Type;

const SynchronizedMarker = Schema.Struct({ kind: Schema.Literal("synchronized") });

export const ThreadIndexItem = Schema.Union([
  SynchronizedMarker,
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: ThreadIndexSnapshot,
  }),
  ThreadIndexEvent,
]);
export type ThreadIndexItem = typeof ThreadIndexItem.Type;

export const ChatSubscribeThreadsInput = Schema.Struct({
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(WholeNumber),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type ChatSubscribeThreadsInput = typeof ChatSubscribeThreadsInput.Type;

export const ChatSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * When provided, the server skips the initial snapshot frame and instead
   * replays events after this sequence before streaming live events. Clients
   * that load the snapshot over HTTP pass the snapshot's sequence here so the
   * live subscription resumes without a gap (overlapping events are deduped by
   * sequence on the client).
   */
  afterSequence: Schema.optionalKey(WholeNumber),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * When provided, the fallback snapshot frame (sent when `afterSequence` is
   * missing or the catch-up gap is too large) is windowed to the last
   * `turnLimit` user-anchored turns and carries `page` metadata. Absent means
   * the fallback snapshot is the full thread, preserving pre-pagination client
   * behavior. Live events are unaffected either way.
   */
  turnLimit: Schema.optionalKey(CountingNumber),
});
export type ChatSubscribeThreadInput = typeof ChatSubscribeThreadInput.Type;

/**
 * Page metadata for a windowed thread detail read. `beforeCursor` is opaque and
 * exclusive: passing it back returns the adjacent disjoint slice of older
 * turns. `null` means the thread is fully loaded below this page. The
 * `seq` mirrors the top-level snapshot sequence so history pages
 * can be sequence-checked against live state before merging.
 */
export const ChatThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(NonblankString),
  hasMore: Schema.Boolean,
  seq: WholeNumber,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `seq` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(WholeNumber),
});
export type ChatThreadDetailPage = typeof ChatThreadDetailPage.Type;

export const ChatThreadDetailSnapshot = Schema.Struct({
  seq: WholeNumber,
  thread: ChatThread,
  // Present only on windowed responses. Absent on full snapshots (and from
  // pre-pagination servers), which clients treat as fully loaded.
  page: Schema.optional(ChatThreadDetailPage),
});
export type ChatThreadDetailSnapshot = typeof ChatThreadDetailSnapshot.Type;

/** `type` + `commandId`: the head every dispatched command starts with. */
const commandHead = <const Kind extends string>(kind: Kind) => ({
  type: Schema.Literal(kind),
  commandId: DispatchCommandId,
});

/** A command aimed at one project: the command head, `projectId`, then its own fields. */
const projectCommand = <const Kind extends string, const Rest extends Schema.Struct.Fields>(
  kind: Kind,
  rest: Rest,
) => Schema.Struct({ ...commandHead(kind), projectId: ProjectId, ...rest });

/** A command aimed at one thread: the command head, `threadId`, then its own fields. */
const threadCommand = <const Kind extends string, const Rest extends Schema.Struct.Fields>(
  kind: Kind,
  rest: Rest,
) => Schema.Struct({ ...commandHead(kind), threadId: ThreadId, ...rest });

export const ProjectCreateCommand = projectCommand("createProject", {
  title: NonblankString,
  workspaceRoot: NonblankString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  /** Ignored: the server derives a project's surface from its folder (blob workspaces are "blobs", everything else "code"). */
  surface: Schema.optional(ProjectSurface),
  // Retained for older clients that sent an automatic create-time seed. The
  // server ignores it; explicit project defaults use project.meta.update.
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelPick)),
  createdAt: IsoInstant,
});

const ProjectMetaUpdateCommand = projectCommand("updateProjectMeta", {
  title: Schema.optional(NonblankString),
  workspaceRoot: Schema.optional(NonblankString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelPick)),
  // Absent = leave unchanged; null = clear the override.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadWorkspaceMode)),
  ...projectLookOverrides,
  scripts: Schema.optional(Schema.Array(ProjectAction)),
});

const ProjectDeleteCommand = projectCommand("deleteProject", {
  force: Schema.optional(Schema.Boolean),
});

const ThreadCreateCommand = threadCommand("createThread", {
  projectId: ProjectId,
  title: NonblankString,
  modelSelection: ModelPick,
  runtimeMode: AccessMode,
  interactionMode: AgentTurnMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_TURN_MODE)),
  ),
  agentMode: Schema.optional(ThreadAgentMode),
  branch: Schema.NullOr(NonblankString),
  worktreePath: Schema.NullOr(NonblankString),
  createdAt: IsoInstant,
  historyImport: Schema.optional(Schema.Literal(true)),
});

const ThreadDeleteCommand = threadCommand("deleteThread", {});

const ThreadArchiveCommand = threadCommand("archiveThread", {});

const ThreadUnarchiveCommand = threadCommand("unarchiveThread", {});

const ThreadSettleCommand = threadCommand("settleThread", {});

const ThreadAutoSettleCommand = threadCommand("autoSettleThread", {
  seq: WholeNumber,
  settledAt: IsoInstant,
});

const ThreadUnsettleCommand = threadCommand("unsettleThread", {
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = threadCommand("snoozeThread", {
  // The wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoInstant,
});

const ThreadUnsnoozeCommand = threadCommand("unsnoozeThread", {
  // Commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal("user"),
});

const ThreadPinCommand = threadCommand("pinThread", {
  // Initial slot in the user-arranged pinned order (see ThreadPinReorderCommand).
  // Optional: clients on pre-reorder servers omit it, and the pinned block
  // falls back to creation order for keyless threads.
  orderKey: Schema.optional(NonblankString),
});

const ThreadUnpinCommand = threadCommand("unpinThread", {});

const ThreadPinReorderCommand = threadCommand("reorderPinnedThread", {
  // Fractional index key: pinned threads sort by plain string comparison of
  // these keys, so a drag writes one key to one thread — neighbors (possibly
  // on other servers) are never touched. Clients compute a key that sorts
  // between the dropped position's neighbors.
  orderKey: NonblankString,
});

const ThreadActiveReorderCommand = threadCommand("reorderActiveThread", {
  orderKey: NonblankString,
});

const ThreadMetaUpdateCommand = threadCommand("updateThreadMeta", {
  title: Schema.optional(NonblankString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelPick),
  branch: Schema.optional(Schema.NullOr(NonblankString)),
  expectedBranch: Schema.optional(Schema.NullOr(NonblankString)),
  worktreePath: Schema.optional(Schema.NullOr(NonblankString)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedMergeRequest)),
}).check(
  Schema.makeFilter(({ title, regenerateTitle }) =>
    regenerateTitle !== true || title === undefined
      ? true
      : "title and regenerateTitle cannot be specified together",
  ),
);

const ThreadMergeRequestLinkCommand = threadCommand("linkPullRequest", {
  ...ThreadMergeRequestKey.fields,
  url: NonblankString,
  source: ThreadMergeRequestLinkSource,
});

const ThreadMergeRequestUnlinkCommand = threadCommand("unlinkPullRequest", {
  ...ThreadMergeRequestKey.fields,
});

const ThreadAccessModeSetCommand = threadCommand("setThreadRuntimeMode", {
  runtimeMode: AccessMode,
  createdAt: IsoInstant,
});

const ThreadTurnModeSetCommand = threadCommand("setThreadInteractionMode", {
  interactionMode: AgentTurnMode,
  createdAt: IsoInstant,
});

const ThreadAgentModeSetCommand = threadCommand("setThreadAgentMode", {
  agentMode: ThreadAgentMode,
  createdAt: IsoInstant,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: NonblankString,
  modelSelection: ModelPick,
  runtimeMode: AccessMode,
  interactionMode: AgentTurnMode,
  agentMode: Schema.optional(ThreadAgentMode),
  branch: Schema.NullOr(NonblankString),
  worktreePath: Schema.NullOr(NonblankString),
  createdAt: IsoInstant,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: NonblankString,
  baseBranch: NonblankString,
  startFromOrigin: Schema.optional(Schema.Boolean),
  branch: Schema.optional(NonblankString),
});

/** Work to do before the turn: any subset of create the thread, prepare a worktree, run setup. */
const ThreadTurnStartBootstrap = Schema.Struct({
  runSetupScript: Schema.optional(Schema.Boolean),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
});
export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = threadCommand("turn.start", {
  message: Schema.Struct({
    messageId: ItemId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(MessageAttachment),
    context: Schema.optional(ThreadMessageContext),
  }),
  modelSelection: Schema.optional(ModelPick),
  titleSeed: Schema.optional(NonblankString),
  runtimeMode: AccessMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_ACCESS_MODE))),
  interactionMode: AgentTurnMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_TURN_MODE)),
  ),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourcePlanProposalReference),
  createdAt: IsoInstant,
});

const ClientThreadTurnStartCommand = threadCommand("turn.start", {
  message: Schema.Struct({
    messageId: ItemId,
    role: Schema.Literal("user"),
    text: Schema.String,
    // The composer caps at the same limit; this is the daemon's own check on the wire.
    attachments: Schema.Array(Schema.Union([UploadMessageAttachment, MessageAttachment])).check(
      Schema.isMaxLength(AGENT_SEND_TURN_MAX_ATTACHMENTS),
    ),
    context: Schema.optional(ThreadMessageContext),
  }),
  modelSelection: Schema.optional(ModelPick),
  titleSeed: Schema.optional(NonblankString),
  runtimeMode: AccessMode,
  interactionMode: AgentTurnMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourcePlanProposalReference),
  createdAt: IsoInstant,
});

const ThreadTurnInterruptCommand = threadCommand("turn.interrupt", {
  turnId: Schema.optional(TurnId),
  createdAt: IsoInstant,
});

const ThreadApprovalRespondCommand = threadCommand("approval.respond", {
  requestId: RequestId,
  decision: AgentApprovalDecision,
  createdAt: IsoInstant,
});

const ThreadUserInputRespondCommand = threadCommand("user-input.respond", {
  requestId: RequestId,
  answers: AgentUserInputAnswers,
  attachmentsByQuestionId: Schema.optional(AskAttachments),
  createdAt: IsoInstant,
});

// Closes an async question without answering it. The agent is not messaged;
// the composer is simply released. Native callback questions cannot be dismissed
// this way because the provider is blocked waiting on a reply.
const ThreadUserInputDismissCommand = threadCommand("user-input.dismiss", {
  requestId: RequestId,
  createdAt: IsoInstant,
});

const ThreadCheckpointRevertCommand = threadCommand("revertThreadCheckpoint", {
  turnCount: WholeNumber,
  createdAt: IsoInstant,
});

// A separate command makes older servers reject history-only rewinds rather than
// ignoring an unfamiliar option and restoring files.
const ThreadConversationRevertCommand = threadCommand("revertThreadConversation", {
  turnCount: ThreadCheckpointRevertCommand.fields.turnCount,
  createdAt: IsoInstant,
});

const ThreadSessionStopCommand = threadCommand("session.stop", {
  createdAt: IsoInstant,
  // Settle-cleanup stops are conditional: the decider drops the stop if the
  // thread was re-engaged (unsettled, session starting/running, or a queued
  // turn start) between the settle and this command. Guarding in the decider
  // closes the race a post-settle snapshot read cannot: commands are decided
  // serially against the authoritative read model.
  onlyIfSettled: Schema.optional(Schema.Boolean),
});

/** Commands clients may send, in two runs around the turn-start variant (which differs per side). */
const clientCommandsBeforeTurn = [
  // Projects.
  ProjectCreateCommand,
  ProjectDeleteCommand,
  ProjectMetaUpdateCommand,
  // Thread lifecycle and placement.
  ThreadCreateCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadDeleteCommand,
  ThreadPinCommand,
  ThreadPinReorderCommand,
  ThreadUnpinCommand,
  ThreadActiveReorderCommand,
  ThreadSettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsettleCommand,
  ThreadUnsnoozeCommand,
  // Thread settings and links.
  ThreadMetaUpdateCommand,
  ThreadAgentModeSetCommand,
  ThreadAccessModeSetCommand,
  ThreadTurnModeSetCommand,
  ThreadMergeRequestLinkCommand,
  ThreadMergeRequestUnlinkCommand,
] as const;
const clientCommandsAfterTurn = [
  ThreadApprovalRespondCommand,
  ThreadUserInputDismissCommand,
  ThreadUserInputRespondCommand,
  ThreadTurnInterruptCommand,
  ThreadSessionStopCommand,
  ThreadCheckpointRevertCommand,
  ThreadConversationRevertCommand,
] as const;

/** What the daemon dispatches: stored attachments only. */
const DispatchableClientChatCommand = Schema.Union([
  ...clientCommandsBeforeTurn,
  ThreadTurnStartCommand,
  ...clientCommandsAfterTurn,
]);
export type DispatchableClientChatCommand = typeof DispatchableClientChatCommand.Type;

/** What a client may put on the wire: the turn start may carry uploads. */
export const ClientChatCommand = Schema.Union([
  ...clientCommandsBeforeTurn,
  ClientThreadTurnStartCommand,
  ...clientCommandsAfterTurn,
]);
export type ClientChatCommand = typeof ClientChatCommand.Type;

const ThreadSessionSetCommand = threadCommand("setThreadSession", {
  session: ChatSession,
  createdAt: IsoInstant,
});

const ThreadMessageAssistantDeltaCommand = threadCommand("appendAssistantDelta", {
  messageId: ItemId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoInstant,
});

const ThreadMessageAssistantCompleteCommand = threadCommand("completeAssistantMessage", {
  messageId: ItemId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoInstant,
});

const ThreadHistoryImportCommand = threadCommand("importThreadHistory", {
  messages: Schema.Array(
    Schema.Struct({
      messageId: ItemId,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: IsoInstant,
    }),
  ).check(Schema.isNonEmpty()),
});

/**
 * Persists a user message without starting a turn. Used by worktree bootstraps
 * so the send is durable while the worktree is still being prepared; the
 * turn that follows references the same message id.
 */
const ThreadMessageUserAppendCommand = threadCommand("appendUserMessage", {
  message: Schema.Struct({
    messageId: ItemId,
    text: Schema.String,
    attachments: Schema.Array(MessageAttachment),
    context: Schema.optional(ThreadMessageContext),
  }),
  createdAt: IsoInstant,
});

const ThreadPlanProposalUpsertCommand = threadCommand("upsertProposedPlan", {
  proposedPlan: ChatPlanProposal,
  createdAt: IsoInstant,
});

const ThreadTurnDiffCompleteCommand = threadCommand("completeTurnDiff", {
  turnId: TurnId,
  completedAt: IsoInstant,
  checkpointRef: TurnCheckpointRef,
  status: ChatCheckpointStatus,
  files: Schema.Array(ChatCheckpointFile),
  assistantMessageId: Schema.optional(ItemId),
  checkpointTurnCount: WholeNumber,
  createdAt: IsoInstant,
});

const ThreadActivityAppendCommand = threadCommand("appendThreadActivity", {
  activity: ChatThreadActivity,
  createdAt: IsoInstant,
});

const ThreadRevertCompleteCommand = threadCommand("completeThreadRevert", {
  turnCount: WholeNumber,
  createdAt: IsoInstant,
});

const ThreadTitleGenerateCompleteCommand = threadCommand("completeTitleGeneration", {
  expectedTitle: NonblankString,
  expectedVersion: Schema.NullOr(DispatchCommandId),
  title: NonblankString,
  needsRefinement: Schema.Boolean,
});

const ThreadTitleRefineCommand = threadCommand("refineThreadTitle", {
  expectedVersion: DispatchCommandId,
});

const ThreadTitleRegenerationCompleteCommand = threadCommand("completeTitleRegeneration", {
  requestId: DispatchCommandId,
  title: Schema.optional(NonblankString),
});

const ThreadMergeRequestSyncCommand = threadCommand("syncPullRequest", {
  projectId: ProjectId,
  seq: WholeNumber,
  expected: Schema.Struct({
    workspaceRoot: NonblankString,
    branch: Schema.NullOr(NonblankString),
    worktreePath: Schema.NullOr(NonblankString),
    linkedPullRequest: Schema.NullOr(ThreadLinkedMergeRequest),
    branchPullRequest: Schema.NullOr(ThreadLinkedMergeRequest),
  }),
  branchPullRequest: Schema.NullOr(ThreadLinkedMergeRequest),
  linkedPullRequest: Schema.optional(ThreadLinkedMergeRequest),
});

const ThreadMergeRequestLinkSyncCommand = threadCommand("syncPullRequestLink", {
  ...ThreadMergeRequestKey.fields,
  snapshot: ThreadMergeRequestSnapshot,
  stack: Schema.NullOr(ThreadMergeRequestStack),
});

/** Server-only commands: provider runtime output, title jobs, sync and settle sweeps. */
const InternalChatCommand = Schema.Union([
  // Session and message stream from the provider.
  ThreadSessionSetCommand,
  ThreadMessageUserAppendCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadHistoryImportCommand,
  // Turn results.
  ThreadActivityAppendCommand,
  ThreadPlanProposalUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadRevertCompleteCommand,
  // Title jobs.
  ThreadTitleGenerateCompleteCommand,
  ThreadTitleRefineCommand,
  ThreadTitleRegenerationCompleteCommand,
  // Background sweeps.
  ThreadAutoSettleCommand,
  ThreadMergeRequestLinkSyncCommand,
  ThreadMergeRequestSyncCommand,
]);
export type InternalChatCommand = Schema.Schema.Type<typeof InternalChatCommand>;

export const ChatCommand = Schema.Union([DispatchableClientChatCommand, InternalChatCommand]);
export type ChatCommand = Schema.Schema.Type<typeof ChatCommand>;

/** Leading field of every thread-scoped payload. */
const aboutThread = { threadId: ThreadId } as const;

export const ChatAggregateKind = Schema.Literals(["project", "thread"]);
export type ChatAggregateKind = Schema.Schema.Type<typeof ChatAggregateKind>;
export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: NonblankString,
  workspaceRoot: NonblankString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelPick),
  // Optional so persisted events from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  surface: Schema.optional(ProjectSurface),
  scripts: Schema.Array(ProjectAction),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(NonblankString),
  workspaceRoot: Schema.optional(NonblankString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelPick)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadWorkspaceMode)),
  ...projectLookOverrides,
  scripts: Schema.optional(Schema.Array(ProjectAction)),
  updatedAt: IsoInstant,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoInstant,
});

export const ThreadCreatedPayload = Schema.Struct({
  ...aboutThread,
  projectId: ProjectId,
  title: NonblankString,
  modelSelection: ModelPick,
  runtimeMode: AccessMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_ACCESS_MODE))),
  interactionMode: AgentTurnMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_TURN_MODE)),
  ),
  agentMode: AgentModeWithDefault,
  branch: Schema.NullOr(NonblankString),
  worktreePath: Schema.NullOr(NonblankString),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const ThreadDeletedPayload = Schema.Struct({
  ...aboutThread,
  deletedAt: IsoInstant,
});

export const ThreadArchivedPayload = Schema.Struct({
  ...aboutThread,
  archivedAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  ...aboutThread,
  updatedAt: IsoInstant,
});

export const ThreadSettledPayload = Schema.Struct({
  ...aboutThread,
  settledAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const ThreadUnsettledPayload = Schema.Struct({
  ...aboutThread,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoInstant,
});

export const ThreadSnoozedPayload = Schema.Struct({
  ...aboutThread,
  snoozedUntil: IsoInstant,
  snoozedAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  ...aboutThread,
  // user: explicit "wake now". activity: real work arrived (user message /
  // session coming alive) and the decider cleared the snooze — mirrors
  // thread.unsettled's activity resets. Timer wakes emit no event: clients
  // derive them from snoozedUntil passing.
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoInstant,
});

export const ThreadPinnedPayload = Schema.Struct({
  ...aboutThread,
  pinnedAt: IsoInstant,
  // Absent on re-pins of an already-pinned thread (the existing key wins)
  // and on pins from clients that predate reordering.
  pinOrderKey: Schema.optional(NonblankString),
  updatedAt: IsoInstant,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  ...aboutThread,
  updatedAt: IsoInstant,
});

export const ThreadPinReorderedPayload = Schema.Struct({
  ...aboutThread,
  orderKey: NonblankString,
  updatedAt: IsoInstant,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  ...aboutThread,
  // Order updates use this existing event so older clients can ignore the
  // new field while continuing to decode the event stream.
  activeOrderKey: Schema.optional(Schema.NullOr(NonblankString)),
  title: Schema.optional(NonblankString),
  /** Intent marker consumed by the title-generation reactor. Keeping this on
      the existing event lets older clients safely ignore the new field. */
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  /** Title at request time, used to avoid overwriting a later manual rename. */
  previousTitle: Schema.optional(NonblankString),
  /** Pending state shared with clients. Null clears a matching request. */
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  modelSelection: Schema.optional(ModelPick),
  branch: Schema.optional(Schema.NullOr(NonblankString)),
  worktreePath: Schema.optional(Schema.NullOr(NonblankString)),
  // No longer produced; kept so persisted events from before
  // thread.pull-request-linked still decode and replay into the link table.
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedMergeRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedMergeRequest)),
  updatedAt: IsoInstant,
});

export const ThreadMergeRequestLinkedPayload = Schema.Struct({
  ...aboutThread,
  link: ThreadMergeRequestLink,
  updatedAt: IsoInstant,
});
export type ThreadMergeRequestLinkedPayload = typeof ThreadMergeRequestLinkedPayload.Type;

export const ThreadMergeRequestUnlinkedPayload = Schema.Struct({
  ...aboutThread,
  ...ThreadMergeRequestKey.fields,
  updatedAt: IsoInstant,
});
export type ThreadMergeRequestUnlinkedPayload = typeof ThreadMergeRequestUnlinkedPayload.Type;

export const ThreadMergeRequestSyncedPayload = Schema.Struct({
  ...aboutThread,
  ...ThreadMergeRequestKey.fields,
  snapshot: ThreadMergeRequestSnapshot,
  stack: Schema.NullOr(ThreadMergeRequestStack),
  updatedAt: IsoInstant,
});
export type ThreadMergeRequestSyncedPayload = typeof ThreadMergeRequestSyncedPayload.Type;

export const ThreadAccessModeSetPayload = Schema.Struct({
  ...aboutThread,
  runtimeMode: AccessMode,
  updatedAt: IsoInstant,
});

export const ThreadTurnModeSetPayload = Schema.Struct({
  ...aboutThread,
  interactionMode: AgentTurnMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_TURN_MODE)),
  ),
  updatedAt: IsoInstant,
});

export const ThreadAgentModeSetPayload = Schema.Struct({
  ...aboutThread,
  agentMode: AgentModeWithDefault,
  updatedAt: IsoInstant,
});

export const ThreadMessageSentPayload = Schema.Struct({
  ...aboutThread,
  messageId: ItemId,
  role: ThreadMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(MessageAttachment)),
  context: Schema.optional(ThreadMessageContext),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
  notice: Schema.optionalKey(ThreadMessageNotice),
  /** Blobs groups: the blob that wrote this assistant message (a group thread has many authors). Absent in single-blob threads. */
  authorBlobId: Schema.optionalKey(Schema.String),
  /** Blobs groups: the blob ids a user message was routed to ("to Popo, Junip"). */
  to: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Blobs groups: how the routing was decided (mention / all / lead / auto / auto-fallback ...). */
  routeWhy: Schema.optionalKey(Schema.String),
  /** Blobs groups: a system note ("Junip is taking too long, so the group moved on."), drawn as a muted centred row. */
  kind: Schema.optionalKey(Schema.Literal("note")),
  /** Blobs outside access: the client name when the person's message came in through `kora mcp --team`. */
  via: Schema.optionalKey(Schema.String),
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  ...aboutThread,
  messageId: ItemId,
  modelSelection: Schema.optional(ModelPick),
  titleSeed: Schema.optional(NonblankString),
  runtimeMode: AccessMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_ACCESS_MODE))),
  interactionMode: AgentTurnMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_TURN_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourcePlanProposalReference),
  createdAt: IsoInstant,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  ...aboutThread,
  turnId: Schema.optional(TurnId),
  createdAt: IsoInstant,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  ...aboutThread,
  requestId: RequestId,
  decision: AgentApprovalDecision,
  createdAt: IsoInstant,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  ...aboutThread,
  requestId: RequestId,
  answers: AgentUserInputAnswers,
  attachmentsByQuestionId: Schema.optional(AskAttachments),
  createdAt: IsoInstant,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  ...aboutThread,
  turnCount: WholeNumber,
  restoreFiles: Schema.optional(Schema.Boolean),
  createdAt: IsoInstant,
});

export const ThreadRevertedPayload = Schema.Struct({
  ...aboutThread,
  turnCount: WholeNumber,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  ...aboutThread,
  createdAt: IsoInstant,
});

export const ThreadSessionSetPayload = Schema.Struct({
  ...aboutThread,
  session: ChatSession,
});

export const ThreadPlanProposalUpsertedPayload = Schema.Struct({
  ...aboutThread,
  proposedPlan: ChatPlanProposal,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  ...aboutThread,
  turnId: TurnId,
  checkpointTurnCount: WholeNumber,
  checkpointRef: TurnCheckpointRef,
  status: ChatCheckpointStatus,
  files: Schema.Array(ChatCheckpointFile),
  assistantMessageId: Schema.NullOr(ItemId),
  completedAt: IsoInstant,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  ...aboutThread,
  activity: ChatThreadActivity,
});

/**
 * Which client connection dispatched the command that produced an event.
 * Stamped by the chat engine on client-dispatched commands; absent on
 * provider/server-originated events and on commands from clients too old to
 * report it.
 */
export const ChatClientOrigin = Schema.Struct({
  surface: Schema.optional(ClientSurface),
  appVersion: Schema.optional(NonblankString),
});
export type ChatClientOrigin = typeof ChatClientOrigin.Type;

export const ThreadEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(NonblankString),
  providerItemId: Schema.optional(AgentItemId),
  adapterKey: Schema.optional(NonblankString),
  requestId: Schema.optional(RequestId),
  ingestedAt: Schema.optional(IsoInstant),
  historyImport: Schema.optional(Schema.Boolean),
  /**
   * The user message was persisted ahead of its turn (worktree bootstrap).
   * Reactors that key off a user message as "turn is starting" wait for the
   * turn-start event instead.
   */
  deferredTurn: Schema.optional(Schema.Boolean),
  origin: Schema.optional(ChatClientOrigin),
});
export type ThreadEventMetadata = typeof ThreadEventMetadata.Type;

const EventBaseFields = {
  sequence: WholeNumber,
  eventId: EventId,
  aggregateKind: ChatAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoInstant,
  commandId: Schema.NullOr(DispatchCommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(DispatchCommandId),
  metadata: ThreadEventMetadata,
} as const;

/** One persisted event kind: the shared envelope plus its literal `type` and payload. */
const eventOf = <const Kind extends string, Payload extends Schema.Top>(
  kind: Kind,
  payload: Payload,
) => Schema.Struct({ ...EventBaseFields, type: Schema.Literal(kind), payload });

export const ThreadEvent = Schema.Union([
  eventOf("projectCreated", ProjectCreatedPayload),
  eventOf("projectMetaUpdated", ProjectMetaUpdatedPayload),
  eventOf("projectDeleted", ProjectDeletedPayload),
  eventOf("threadCreated", ThreadCreatedPayload),
  eventOf("threadDeleted", ThreadDeletedPayload),
  eventOf("threadArchived", ThreadArchivedPayload),
  eventOf("threadUnarchived", ThreadUnarchivedPayload),
  eventOf("threadSettled", ThreadSettledPayload),
  eventOf("threadUnsettled", ThreadUnsettledPayload),
  eventOf("threadSnoozed", ThreadSnoozedPayload),
  eventOf("threadUnsnoozed", ThreadUnsnoozedPayload),
  eventOf("threadPinned", ThreadPinnedPayload),
  eventOf("threadUnpinned", ThreadUnpinnedPayload),
  eventOf("threadPinReordered", ThreadPinReorderedPayload),
  eventOf("threadMetaUpdated", ThreadMetaUpdatedPayload),
  eventOf("pullRequestLinked", ThreadMergeRequestLinkedPayload),
  eventOf("pullRequestUnlinked", ThreadMergeRequestUnlinkedPayload),
  eventOf("pullRequestSynced", ThreadMergeRequestSyncedPayload),
  eventOf("threadRuntimeModeSet", ThreadAccessModeSetPayload),
  eventOf("threadInteractionModeSet", ThreadTurnModeSetPayload),
  eventOf("threadAgentModeSet", ThreadAgentModeSetPayload),
  eventOf("threadMessageSent", ThreadMessageSentPayload),
  eventOf("turnStartRequested", ThreadTurnStartRequestedPayload),
  eventOf("turnInterruptRequested", ThreadTurnInterruptRequestedPayload),
  eventOf("approvalResponseRequested", ThreadApprovalResponseRequestedPayload),
  eventOf("userInputResponseRequested", ThreadUserInputResponseRequestedPayload),
  eventOf("checkpointRevertRequested", ThreadCheckpointRevertRequestedPayload),
  eventOf("threadReverted", ThreadRevertedPayload),
  eventOf("sessionStopRequested", ThreadSessionStopRequestedPayload),
  eventOf("threadSessionSet", ThreadSessionSetPayload),
  eventOf("proposedPlanUpserted", ThreadPlanProposalUpsertedPayload),
  eventOf("turnDiffCompleted", ThreadTurnDiffCompletedPayload),
  eventOf("threadActivityAppended", ThreadActivityAppendedPayload),
]);
export type ThreadEvent = typeof ThreadEvent.Type;

const threadSnapshotItem = Schema.Struct({
  snapshot: ChatThreadDetailSnapshot,
  kind: Schema.Literal("snapshot"),
});
const threadEventItem = Schema.Struct({ event: ThreadEvent, kind: Schema.Literal("event") });

export const ThreadStreamItem = Schema.Union([
  SynchronizedMarker,
  threadSnapshotItem,
  threadEventItem,
]);
export type ThreadStreamItem = typeof ThreadStreamItem.Type;

const turnRangeOrdered = Schema.makeFilter(
  (input: { readonly fromTurnCount: number; readonly toTurnCount: number }) =>
    input.toTurnCount >= input.fromTurnCount ||
    new SchemaIssue.InvalidValue({
      message: "fromTurnCount must be less than or equal to toTurnCount",
    }),
  { identifier: "ChatTurnDiffRange" },
);

export const TurnCountRange = Schema.Struct({
  toTurnCount: WholeNumber,
  fromTurnCount: WholeNumber,
}).check(turnRangeOrdered);

const PRESERVE_RANGE_CHECKS = { unsafePreserveChecks: true } as const;

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({ diff: Schema.String, threadId: ThreadId }),
  PRESERVE_RANGE_CHECKS,
);

const ProjectionThreadTurnStatus = Schema.Literals([
  "error",
  "interrupted",
  "completed",
  "running",
]);
export type ProjectionThreadTurnStatus = Schema.Schema.Type<typeof ProjectionThreadTurnStatus>;

const ProjectionCheckpointRow = Schema.Struct({
  ...aboutThread,
  turnId: TurnId,
  checkpointTurnCount: WholeNumber,
  checkpointRef: TurnCheckpointRef,
  status: ChatCheckpointStatus,
  files: Schema.Array(ChatCheckpointFile),
  assistantMessageId: Schema.NullOr(ItemId),
  completedAt: IsoInstant,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const DispatchResult = Schema.Struct({
  sequence: WholeNumber,
});
export type DispatchResult = typeof DispatchResult.Type;

export const ChatGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
    threadId: ThreadId,
  }),
  PRESERVE_RANGE_CHECKS,
);
export type ChatGetTurnDiffInput = typeof ChatGetTurnDiffInput.Type;

export const ChatGetTurnDiffResult = ThreadTurnDiff;
export type ChatGetTurnDiffResult = typeof ChatGetTurnDiffResult.Type;

export const ChatGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: WholeNumber,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ChatGetFullThreadDiffInput = typeof ChatGetFullThreadDiffInput.Type;

export const ChatGetFullThreadDiffResult = ThreadTurnDiff;
export type ChatGetFullThreadDiffResult = typeof ChatGetFullThreadDiffResult.Type;

export const ChatThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type ChatThreadSearchSource = typeof ChatThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const ChatSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type ChatSearchThreadsInput = typeof ChatSearchThreadsInput.Type;

export const ChatThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: ChatThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoInstant),
});
export type ChatThreadSearchMatch = typeof ChatThreadSearchMatch.Type;

export const ChatSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(ChatThreadSearchMatch),
});
export type ChatSearchThreadsResult = typeof ChatSearchThreadsResult.Type;

export const ChatGetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path from the workflow's runHandles.scriptPath. The server
   * re-derives containment; the client value is a hint, never trusted. */
  scriptPath: NonblankString,
});
export type ChatGetWorkflowScriptInput = typeof ChatGetWorkflowScriptInput.Type;

export const ChatGetWorkflowScriptResult = Schema.Struct({
  scriptPath: NonblankString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type ChatGetWorkflowScriptResult = typeof ChatGetWorkflowScriptResult.Type;

const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "read-failed": "Script read failed.",
  "changed-during-read": "Script changed between resolution and open.",
  "not-regular-file": "Script is not a regular file.",
  "not-js": "Resolved script is not a .js file.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-found": "Script not found.",
  "root-unavailable": "Script root unavailable.",
  "invalid-path": "Workflow scripts must be absolute .js paths.",
} as const;

const WORKFLOW_SCRIPT_ERROR_REASONS = [
  ...(["invalid-path", "root-unavailable"] as const),
  ...(["not-found", "outside-root", "not-js"] as const),
  ...(["not-regular-file", "changed-during-read", "read-failed"] as const),
] as const satisfies ReadonlyArray<keyof typeof WORKFLOW_SCRIPT_ERROR_MESSAGES>;

export class ChatGetWorkflowScriptError extends Schema.TaggedError<ChatGetWorkflowScriptError>()(
  "ChatGetWorkflowScriptError",
  {
    cause: Schema.optional(Schema.Defect()),
    scriptPath: Schema.String,
    reason: Schema.Literals(WORKFLOW_SCRIPT_ERROR_REASONS),
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}

export const ChatRpcSchemas = {
  dispatchCommand: {
    input: ClientChatCommand,
    output: DispatchResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: ThreadIndexSnapshot,
  },
  subscribeThread: {
    input: ChatSubscribeThreadInput,
    output: ThreadStreamItem,
  },
  subscribeShell: {
    input: ChatSubscribeThreadsInput,
    output: ThreadIndexItem,
  },
} as const;

export class ChatSnapshotError extends Schema.TaggedError<ChatSnapshotError>()(
  "ChatSnapshotError",
  {
    message: NonblankString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ChatDispatchError extends Schema.TaggedError<ChatDispatchError>()(
  "ChatDispatchError",
  {
    message: NonblankString,
    cause: Schema.optional(Schema.Defect()),
    bootstrapThreadDisposition: Schema.optional(Schema.Literal("deleted")),
  },
) {}

export class ChatGetTurnDiffError extends Schema.TaggedError<ChatGetTurnDiffError>()(
  "ChatGetTurnDiffError",
  {
    message: NonblankString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ChatGetFullThreadDiffError extends Schema.TaggedError<ChatGetFullThreadDiffError>()(
  "ChatGetFullThreadDiffError",
  {
    message: NonblankString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ChatSearchThreadsError extends Schema.TaggedError<ChatSearchThreadsError>()(
  "ChatSearchThreadsError",
  {
    message: NonblankString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
