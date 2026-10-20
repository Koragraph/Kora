import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonblankString, WholeNumber, CountingNumber } from "./primitives.ts";

// What is left of the provider-neutral runtime vocabulary: the tool-trace
// presentation types, the "ask" question shape, the context-window snapshot and the
// task-kind classifier. The driver event union went with the removed server drivers.

export type RuntimeItemStatus = "inProgress" | "completed" | "failed" | "declined";

export const ToolLifecycleItemType = Schema.Literals([
  ...(["command_execution", "file_change"] as const),
  ...(["mcp_tool_call", "dynamic_tool_call"] as const),
  ...(["collab_agent_tool_call", "web_search", "image_view"] as const),
]);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

const isToolItem = Schema.is(ToolLifecycleItemType);
export const isToolLifecycleItemType = (value: string): value is ToolLifecycleItemType =>
  isToolItem(value);

export const ThreadTokenUsageSnapshot = Schema.Struct({
  usedTokens: WholeNumber,
  totalProcessedTokens: Schema.optionalKey(WholeNumber),
  maxTokens: Schema.optionalKey(CountingNumber),
  inputTokens: Schema.optionalKey(WholeNumber),
  cachedInputTokens: Schema.optionalKey(WholeNumber),
  outputTokens: Schema.optionalKey(WholeNumber),
  reasoningOutputTokens: Schema.optionalKey(WholeNumber),
  lastUsedTokens: Schema.optionalKey(WholeNumber),
  lastInputTokens: Schema.optionalKey(WholeNumber),
  lastCachedInputTokens: Schema.optionalKey(WholeNumber),
  lastOutputTokens: Schema.optionalKey(WholeNumber),
  lastReasoningOutputTokens: Schema.optionalKey(WholeNumber),
  toolUses: Schema.optionalKey(WholeNumber),
  durationMs: Schema.optionalKey(WholeNumber),
  compactsAutomatically: Schema.optionalKey(Schema.Boolean),
  autoCompactThreshold: Schema.optionalKey(CountingNumber),
});
export type ThreadTokenUsageSnapshot = typeof ThreadTokenUsageSnapshot.Type;

// ---------------------------------------------------------------------------
// Tool trace presentation
// ---------------------------------------------------------------------------

export const ToolTraceSurface = Schema.Literals(["browser", "computer"]);
export type ToolTraceSurface = typeof ToolTraceSurface.Type;

const url4096 = NonblankString.check(Schema.isMaxLength(4096));

export const ToolTraceAppRef = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("app-id"),
    appId: NonblankString.check(Schema.isMaxLength(512), Schema.isPattern(/^[A-Za-z0-9._-]+$/)),
  }),
  Schema.Struct({
    _tag: Schema.Literal("display-name"),
    displayName: NonblankString.check(Schema.isMaxLength(160)),
  }),
]);
export type ToolTraceAppRef = typeof ToolTraceAppRef.Type;

export const ToolTraceIcon = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("website"),
    pageUrl: url4096,
    faviconUrl: Schema.optionalKey(url4096),
    faviconUrlDark: Schema.optionalKey(url4096),
  }),
  Schema.Struct({ _tag: Schema.Literal("native-app"), app: ToolTraceAppRef }),
  Schema.Struct({
    _tag: Schema.Literal("themed-logo"),
    logoUrl: url4096,
    logoUrlDark: Schema.optionalKey(url4096),
  }),
]);
export type ToolTraceIcon = typeof ToolTraceIcon.Type;

export const ToolTraceSource = Schema.Struct({
  key: NonblankString.check(Schema.isMaxLength(512)),
  name: NonblankString.check(Schema.isMaxLength(160)),
  kind: Schema.Literals(["browser", "computer", "integration"]),
  icon: Schema.optionalKey(ToolTraceIcon),
});
export type ToolTraceSource = typeof ToolTraceSource.Type;

// ---------------------------------------------------------------------------
// Questions an agent asks the user
// ---------------------------------------------------------------------------

const AskQuestionOption = Schema.Struct({
  label: NonblankString,
  description: Schema.String,
  value: Schema.optionalKey(Schema.String),
});
export type UserInputQuestionOption = typeof AskQuestionOption.Type;

export const AskQuestion = Schema.Struct({
  id: NonblankString,
  header: NonblankString,
  question: NonblankString,
  options: Schema.Array(AskQuestionOption),
  allowCustomAnswer: Schema.optionalKey(Schema.Boolean),
  multiSelect: Schema.optionalKey(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
export type AskQuestion = typeof AskQuestion.Type;

// ---------------------------------------------------------------------------
// Task kinds
// ---------------------------------------------------------------------------

// Watch-loop tasks and plan-mode bookkeeping are never agents. A denylist on purpose:
// the SDK's agent-flavoured names drift (subagent, local_agent, local_workflow, ...).
const NON_AGENT_TASK_TYPES: ReadonlySet<string> = new Set([
  "monitor",
  "monitor_mcp",
  "local_bash",
  "shell",
  "plan",
  "dream",
]);

type TaskShape = Partial<Record<"taskType" | "agentId", string | undefined>>;

export function classifyTaskAgentKind({ taskType, agentId }: TaskShape): "agent" | "background" {
  const typed = taskType !== undefined;
  const agentFlavoured = typed && !NON_AGENT_TASK_TYPES.has(taskType);
  const ownedByAgent = (agentId ?? "").trim() !== "";
  // A nested agent can outlive its parent, so only an agent-flavoured type stays in the roster;
  // a free-standing task is an agent unless its type says otherwise.
  if (ownedByAgent) return agentFlavoured ? "agent" : "background";
  return typed && !agentFlavoured ? "background" : "agent";
}
