import { persist, type StorageValue } from "zustand/middleware";
import { create } from "zustand";
import { useMemo } from "react";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { canonicalModelSlug, createModelPick } from "@kora/shared/modelOptions";
import {
  replaceContextChipReferences,
  formatContextChipReference,
  collectContextChipReferences,
} from "@kora/shared/contextChipReferences";
import type { UnifiedPrefs } from "@kora/contracts/clientPrefs";
import {
  type WebMarkupPayload,
  type ThreadId,
  type HostThreadRef,
  type HostProjectRef,
  type ProjectId,
  type HostId,
  type AgentStatus,
  type AgentOptionSelection,
  type AgentId,
  WebMarkupPayloadSchema,
  ModelPick,
  migrateLegacyAgentId,
  defaultProfileIdForDriver,
  DEFAULT_MODEL_BY_AGENT,
  DEFAULT_MODEL,
  AgentTurnMode,
  AgentProfileId,
  AccessMode,
} from "@kora/contracts";
import {
  hostThreadRef,
  hostProjectRef,
  hostThreadKey,
  hostProjectKey,
} from "@kora/client-runtime/host";

import {
  type TerminalExcerptDraft,
  normalizeTerminalExcerptText,
  migrateLegacyTerminalExcerptPlaceholders,
} from "../util/terminalContext";
import { createDeferredStorage } from "../util/storage";
import { elementContextToWebMarkup } from "../util/elementContext";
import {
  type ContextChipReference,
  toContextChipId,
  removeInlineContextLink,
  ensureInlineContextLinks,
  appendInlineContextLink,
} from "../util/contextChipReferences";
import {
  webMarkupContextReference,
  webMarkupContextId,
  terminalExcerptReference,
  reviewCommentContextReference,
  reviewCommentContextId,
} from "../util/contextChipRecords";
import { DEFAULT_ACCESS_MODE, DEFAULT_TURN_MODE } from "../types";
import {
  ReviewCommentContextSchema,
  type ReviewCommentContext,
} from "../thread/reviewCommentContext";
import { resolveAppModelPick, resolveAppModelPickForInstance } from "../modelPick";

export const PROMPT_DRAFT_STORAGE_KEY = "kora:prompt-drafts:v1";
const STORE_VERSION = 9;
const PERSIST_DEBOUNCE_MS = 300;

export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;

export type DraftThreadEnvMode = "local" | "worktree";
export type PromptThreadTarget = HostThreadRef | DraftId;

export interface ContextChipAddOptions {
  /** false: append synchronously instead of asking the composer to place it at the caret. */
  insertAtCaret?: boolean;
  allowDuplicateReference?: boolean;
  /** false: the caller already put the chip in the prompt. */
  appendReference?: boolean;
}

/** Runtime-only (never persisted): lets a mounted composer place chips at its caret. */
export type ContextChipInsertionHandler = (refs: ReadonlyArray<ContextChipReference>) => boolean;

export interface PromptThreadDraftState {
  prompt: string;
  terminalContexts: TerminalExcerptDraft[];
  previewAnnotations: WebMarkupPayload[];
  reviewComments: ReviewCommentContext[];
  modelSelectionByProvider: Partial<Record<AgentProfileId, ModelPick>>;
  activeProvider: AgentProfileId | null;
  /** true only when a human picked it; seeds leave it unset so later seeds may replace it. */
  modelSelectionExplicit?: boolean;
  runtimeMode: AccessMode | null;
  interactionMode: AgentTurnMode | null;
}

export interface DraftSessionState {
  promotedTo?: HostThreadRef | null;
  startFromOrigin: boolean;
  envMode: DraftThreadEnvMode;
  worktreePath: string | null;
  branch: string | null;
  interactionMode: AgentTurnMode;
  runtimeMode: AccessMode;
  createdAt: string;
  loadBalancedHostId?: HostId | null;
  hostSelection?: "auto" | "manual";
  logicalProjectKey: string;
  projectId: ProjectId;
  hostId: HostId;
  threadId: ThreadId;
  draftId: DraftId;
}
export type DraftThreadState = DraftSessionState;

export interface EffectivePromptModelState {
  selectedModel: string;
  modelOptions: Partial<Record<string, ReadonlyArray<AgentOptionSelection>>> | null;
}

type DraftThreadOptions = {
  loadBalancedHostId?: HostId | null;
  hostSelection?: "auto" | "manual";
  interactionMode?: AgentTurnMode;
  runtimeMode?: AccessMode;
  startFromOrigin?: boolean;
  envMode?: DraftThreadEnvMode;
  createdAt?: string;
  worktreePath?: string | null;
  branch?: string | null;
  threadId?: ThreadId;
};

type SetModelSelectionOptions = { explicit?: boolean; replaceOptions?: boolean };
type ProviderOptionSettings = {
  instanceId?: AgentProfileId;
  model?: string;
  persistSticky?: boolean;
};

interface PromptDraftStoreData {
  stickyActiveProvider: AgentProfileId | null;
  stickyModelSelectionByProvider: Partial<Record<AgentProfileId, ModelPick>>;
  rewindingThreadKeys: ReadonlySet<string>;
  backgroundSubmissionThreadKeys: Record<string, true>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  draftThreadsByThreadKey: Record<string, DraftSessionState>;
  draftsByThreadKey: Record<string, PromptThreadDraftState>;
}

interface PromptDraftStoreActions {
  getComposerDraft: (dest: PromptThreadTarget) => PromptThreadDraftState | null;
  getDraftThreadByLogicalProjectKey: (keyName: string) => DraftSessionState | null;
  getDraftSessionByLogicalProjectKey: (keyName: string) => DraftSessionState | null;
  getDraftThreadByProjectRef: (handle: HostProjectRef) => DraftSessionState | null;
  getDraftSessionByProjectRef: (handle: HostProjectRef) => DraftSessionState | null;
  getDraftSession: (draftId: DraftId) => DraftSessionState | null;
  getDraftSessionByRef: (handle: HostThreadRef) => DraftSessionState | null;
  getDraftThreadByRef: (handle: HostThreadRef) => DraftSessionState | null;
  getDraftThread: (dest: PromptThreadTarget) => DraftSessionState | null;
  listDraftThreadKeys: () => string[];
  hasDraftThreadsInHost: (hostKey: HostId) => boolean;
  setLogicalProjectDraftThreadId: (
    keyName: string,
    projKey: HostProjectRef,
    draftId: DraftId,
    opts?: DraftThreadOptions,
  ) => void;
  setProjectDraftThreadId: (
    projKey: HostProjectRef,
    draftId: DraftId,
    opts?: DraftThreadOptions,
  ) => void;
  setDraftThreadContext: (
    dest: PromptThreadTarget,
    opts: DraftThreadOptions & { projectRef?: HostProjectRef },
  ) => void;
  clearProjectDraftThreadId: (projKey: HostProjectRef) => void;
  clearProjectDraftThreadById: (projKey: HostProjectRef, dest: PromptThreadTarget) => void;
  markDraftThreadPromoting: (dest: PromptThreadTarget, promotedTo?: HostThreadRef) => void;
  finalizePromotedDraftThread: (dest: PromptThreadTarget) => void;
  clearDraftThread: (dest: PromptThreadTarget) => void;
  setStickyModelSelection: (choice: ModelPick) => void;
  applyStickyState: (dest: PromptThreadTarget) => void;
  setPrompt: (dest: PromptThreadTarget, promptText: string) => void;
  setTerminalContexts: (dest: PromptThreadTarget, scopes: TerminalExcerptDraft[]) => void;
  setModelSelection: (
    dest: PromptThreadTarget,
    choice: ModelPick | null | undefined,
    opts?: SetModelSelectionOptions,
  ) => void;
  setModelOptions: (
    dest: PromptThreadTarget,
    optionsByAgent: Partial<Record<string, ReadonlyArray<AgentOptionSelection> | undefined>>,
  ) => void;
  setProviderModelOptions: (
    dest: PromptThreadTarget,
    vendor: AgentId,
    opts: ReadonlyArray<AgentOptionSelection> | null | undefined,
    conf?: ProviderOptionSettings,
  ) => void;
  setRuntimeMode: (dest: PromptThreadTarget, flavor: AccessMode | null | undefined) => void;
  setInteractionMode: (dest: PromptThreadTarget, flavor: AgentTurnMode | null | undefined) => void;
  insertTerminalContext: (
    dest: PromptThreadTarget,
    promptText: string,
    excerpt: TerminalExcerptDraft,
    pos: number,
  ) => boolean;
  addTerminalContext: (dest: PromptThreadTarget, excerpt: TerminalExcerptDraft) => void;
  addTerminalContexts: (
    dest: PromptThreadTarget,
    scopes: TerminalExcerptDraft[],
    opts?: ContextChipAddOptions,
  ) => void;
  removeTerminalContext: (dest: PromptThreadTarget, contextId: string) => void;
  clearTerminalContexts: (dest: PromptThreadTarget) => void;
  addPreviewAnnotation: (
    dest: PromptThreadTarget,
    annotation: WebMarkupPayload,
    opts?: ContextChipAddOptions,
  ) => void;
  setPreviewAnnotations: (dest: PromptThreadTarget, notes: WebMarkupPayload[]) => void;
  removePreviewAnnotation: (dest: PromptThreadTarget, annotationId: string) => void;
  addReviewComment: (
    dest: PromptThreadTarget,
    remark: ReviewCommentContext,
    opts?: ContextChipAddOptions,
  ) => void;
  setReviewComments: (dest: PromptThreadTarget, comments: ReviewCommentContext[]) => void;
  removeReviewComment: (dest: PromptThreadTarget, commentId: string) => void;
  setContextInsertionHandler: (
    dest: PromptThreadTarget,
    cb: ContextChipInsertionHandler | null,
  ) => (() => void) | undefined;
  clearComposerContent: (dest: PromptThreadTarget) => void;
  clearComposerPrompt: (dest: PromptThreadTarget) => void;
}

type PromptDraftStoreState = PromptDraftStoreData & PromptDraftStoreActions;

// ---------- small helpers ----------

const EMPTY_THREAD_DRAFT: PromptThreadDraftState = Object.freeze({
  prompt: "",
  terminalContexts: Object.freeze([]) as unknown as TerminalExcerptDraft[],
  previewAnnotations: Object.freeze([]) as unknown as WebMarkupPayload[],
  reviewComments: Object.freeze([]) as unknown as ReviewCommentContext[],
  modelSelectionByProvider: Object.freeze({}) as Partial<Record<AgentProfileId, ModelPick>>,
  interactionMode: null,
  runtimeMode: null,
  activeProvider: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const isAccessMode = Schema.is(AccessMode);
const isTurnMode = Schema.is(AgentTurnMode);
const isWebMarkup = Schema.is(WebMarkupPayloadSchema);
const isReviewComment = Schema.is(ReviewCommentContextSchema);
const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const decodePick = Schema.decodeUnknownOption(ModelPick);

const draftKey = (dest: PromptThreadTarget): string | null => {
  if (typeof dest === "string") return dest.trim() || null;
  return hostThreadKey(dest);
};

function isEmptyDraft(composer: PromptThreadDraftState): boolean {
  return (
    composer.prompt === "" &&
    composer.terminalContexts.length === 0 &&
    composer.previewAnnotations.length === 0 &&
    composer.reviewComments.length === 0 &&
    Object.keys(composer.modelSelectionByProvider).length === 0 &&
    composer.activeProvider === null &&
    composer.runtimeMode === null &&
    composer.interactionMode === null
  );
}

export function promptDraftHasUserContent(
  draft: PromptThreadDraftState | null | undefined,
): boolean {
  return (
    !!draft &&
    (draft.prompt.trim() !== "" ||
      draft.terminalContexts.length > 0 ||
      draft.previewAnnotations.length > 0 ||
      draft.reviewComments.length > 0)
  );
}

export function promptTargetKey(dest: HostThreadRef | DraftId): string {
  return typeof dest === "string" ? dest.trim() : hostThreadKey(dest);
}

const sameThread = (session: DraftSessionState, handle: HostThreadRef) =>
  session.hostId === handle.hostId && session.threadId === handle.threadId;

function findSessionByRef(
  sessions: Record<string, DraftSessionState>,
  handle: HostThreadRef,
): DraftSessionState | null {
  for (const sess of Object.values(sessions)) if (sameThread(sess, handle)) return sess;
  return null;
}

/** A ref reads its own composer if it has one, else the draft session that became it. */
function resolveDraftKey(data: PromptDraftStoreData, dest: PromptThreadTarget): string | null {
  if (typeof dest === "string") return dest.trim() || null;
  const own = hostThreadKey(dest);
  if (data.draftsByThreadKey[own]) return own;
  return findSessionByRef(data.draftThreadsByThreadKey, dest)?.draftId ?? own;
}

function resolveSession(
  data: PromptDraftStoreData,
  dest: PromptThreadTarget,
): DraftSessionState | null {
  if (typeof dest === "string") return data.draftThreadsByThreadKey[dest.trim()] ?? null;
  return findSessionByRef(data.draftThreadsByThreadKey, dest);
}

function threadIdForTarget(data: PromptDraftStoreData, dest: PromptThreadTarget): ThreadId {
  if (typeof dest !== "string") return dest.threadId;
  const target = dest.trim();
  return (data.draftThreadsByThreadKey[target]?.threadId ?? target) as ThreadId;
}

// ---------- context chips ----------

const normalizeSelectionOptions = (
  opts: ReadonlyArray<AgentOptionSelection> | null | undefined,
): AgentOptionSelection[] | undefined => {
  if (!opts) return undefined;
  const byId = new Map<string, AgentOptionSelection>();
  for (const option of opts) {
    if (!isRecord(option) || !isNonEmptyString(option.id)) continue;
    if (typeof option.value === "string" && option.value.trim() === "") continue;
    if (typeof option.value !== "string" && typeof option.value !== "boolean") continue;
    byId.set(option.id, { id: option.id, value: option.value });
  }
  return byId.size > 0 ? [...byId.values()] : undefined;
};

function normalizeTerminalContext(
  unparsed: TerminalExcerptDraft,
  restoredThreadId: ThreadId,
): TerminalExcerptDraft | null {
  if (!isRecord(unparsed) || !isNonEmptyString(unparsed.id)) return null;
  const termKey = String(unparsed.terminalId ?? "").trim();
  const terminalLabel = String(unparsed.terminalLabel ?? "").trim();
  if (!termKey || !terminalLabel) return null;
  if (!Number.isInteger(unparsed.lineStart) || unparsed.lineStart < 1) return null;
  if (!Number.isInteger(unparsed.lineEnd) || unparsed.lineEnd < unparsed.lineStart) return null;
  return {
    id: toContextChipId(unparsed.id.trim()),
    threadId: restoredThreadId,
    createdAt: String(unparsed.createdAt ?? ""),
    terminalId: termKey,
    terminalLabel,
    lineStart: unparsed.lineStart,
    lineEnd: unparsed.lineEnd,
    text: normalizeTerminalExcerptText(typeof unparsed.text === "string" ? unparsed.text : ""),
  };
}

const selectionSignature = (ch: TerminalExcerptDraft) =>
  `${ch.terminalId}\u0000${ch.lineStart}\u0000${ch.lineEnd}`;

function normalizeTerminalContexts(
  unparsed: ReadonlyArray<TerminalExcerptDraft>,
  restoredThreadId: ThreadId,
  alreadyHeld: ReadonlyArray<TerminalExcerptDraft> = [],
): TerminalExcerptDraft[] {
  const ids = new Set(alreadyHeld.map((ch) => ch.id));
  const signatures = new Set(alreadyHeld.map(selectionSignature));
  const accepted: TerminalExcerptDraft[] = [];
  for (const cand of unparsed) {
    const excerpt = normalizeTerminalContext(cand, restoredThreadId);
    if (!excerpt || ids.has(excerpt.id) || signatures.has(selectionSignature(excerpt))) continue;
    ids.add(excerpt.id);
    signatures.add(selectionSignature(excerpt));
    accepted.push(excerpt);
  }
  return accepted;
}

/** A compact copy for storage: the screenshot pixels are not worth keeping in a draft. */
function compactAnnotation(annotation: WebMarkupPayload): WebMarkupPayload {
  return annotation.screenshot
    ? { ...annotation, screenshot: { ...annotation.screenshot, dataUrl: "" } }
    : annotation;
}

const contextReferencesOf = (draft: {
  terminalContexts: ReadonlyArray<TerminalExcerptDraft>;
  previewAnnotations: ReadonlyArray<WebMarkupPayload>;
  reviewComments: ReadonlyArray<ReviewCommentContext>;
}): ContextChipReference[] => [
  ...draft.terminalContexts.map(terminalExcerptReference),
  ...draft.reviewComments.map(reviewCommentContextReference),
  ...draft.previewAnnotations.map(webMarkupContextReference),
];

function stripReferences(promptText: string, contextIds: Iterable<string>): string {
  let result = promptText;
  for (const contextId of contextIds) result = removeInlineContextLink(result, contextId).prompt;
  return result;
}

// ---------- draft sessions ----------

function buildSession(
  draftId: DraftId,
  logicalProjectKey: string,
  projKey: HostProjectRef,
  earlierFound: DraftSessionState | undefined,
  opts: DraftThreadOptions,
): DraftSessionState {
  const projectChanged =
    !!earlierFound &&
    (earlierFound.hostId !== projKey.hostId || earlierFound.projectId !== projKey.projectId);
  // A new project/host invalidates machine-specific workspace state but not the user's env choice.
  const branch =
    opts.branch !== undefined
      ? opts.branch
      : projectChanged
        ? null
        : (earlierFound?.branch ?? null);
  const worktreePath =
    opts.worktreePath !== undefined
      ? opts.worktreePath
      : projectChanged
        ? null
        : (earlierFound?.worktreePath ?? null);
  const loadBalancedHostId =
    opts.loadBalancedHostId !== undefined
      ? opts.loadBalancedHostId
      : projectChanged
        ? null
        : earlierFound?.loadBalancedHostId;
  const hostSelection = opts.hostSelection ?? earlierFound?.hostSelection;

  return {
    draftId,
    threadId: opts.threadId ?? earlierFound?.threadId ?? (draftId as unknown as ThreadId),
    hostId: projKey.hostId,
    projectId: projKey.projectId,
    logicalProjectKey,
    ...(hostSelection !== undefined ? { hostSelection } : {}),
    ...(loadBalancedHostId !== undefined ? { loadBalancedHostId } : {}),
    createdAt: opts.createdAt ?? earlierFound?.createdAt ?? new Date().toISOString(),
    runtimeMode: opts.runtimeMode ?? earlierFound?.runtimeMode ?? DEFAULT_ACCESS_MODE,
    interactionMode: opts.interactionMode ?? earlierFound?.interactionMode ?? DEFAULT_TURN_MODE,
    branch,
    worktreePath,
    envMode: opts.envMode ?? (worktreePath ? "worktree" : (earlierFound?.envMode ?? "local")),
    startFromOrigin: opts.startFromOrigin ?? earlierFound?.startFromOrigin ?? false,
    promotedTo: null,
  };
}

const shallowEqual = (left: object, right: object) => {
  const ak = Object.keys(left);
  const bk = Object.keys(right);
  return ak.length === bk.length && ak.every((k) => (left as never)[k] === (right as never)[k]);
};

const hasOwn = (obj: object, k: string) => Object.prototype.hasOwnProperty.call(obj, k);

function omit<Item extends object>(source: Item, keys: Iterable<string>): Item {
  const discard = new Set(keys);
  return Object.fromEntries(Object.entries(source).filter(([k]) => !discard.has(k))) as Item;
}

function removeDraftEverywhere(
  data: PromptDraftStoreData,
  draftId: string,
): Partial<PromptDraftStoreData> {
  return {
    draftThreadsByThreadKey: omit(data.draftThreadsByThreadKey, [draftId]),
    draftsByThreadKey: omit(data.draftsByThreadKey, [draftId]),
    logicalProjectDraftThreadKeyByLogicalProjectKey: Object.fromEntries(
      Object.entries(data.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([, id]) => id !== draftId,
      ),
    ),
  };
}

function pickFromMap(
  table: Partial<Record<AgentProfileId, ModelPick>>,
): Partial<Record<AgentProfileId, ModelPick>> {
  return { ...table };
}

/** Everything about a model pick that is safe to keep: valid instance slug, canonical model, clean options. */
function normalizeModelPick(unparsed: unknown): ModelPick | null {
  const decoded = decodePick(unparsed);
  if (Option.isNone(decoded)) return null;
  const { instanceId, model, options } = decoded.value;
  if (!INSTANCE_ID_PATTERN.test(instanceId)) return null;
  const driver = driverOfInstance(instanceId);
  const canonical = canonicalModelSlug(model, driver);
  if (!canonical) return null;
  return createModelPick(instanceId, canonical, normalizeSelectionOptions(options));
}

/** Custom instances are named `<driver>_<suffix>`; default instances are the driver slug itself. */
function driverOfInstance(instKey: string): AgentId {
  return (instKey.split("_")[0] ?? instKey) as AgentId;
}

// ---------- persistence shapes ----------

interface PersistedDraftSession {
  promotedTo?: { hostId: HostId; threadId: ThreadId } | null;
  startFromOrigin: boolean;
  envMode: DraftThreadEnvMode;
  worktreePath: string | null;
  branch: string | null;
  interactionMode: AgentTurnMode;
  runtimeMode: AccessMode;
  createdAt: string;
  loadBalancedHostId?: HostId | null;
  hostSelection?: "auto" | "manual";
  logicalProjectKey?: string;
  projectId: ProjectId;
  hostId: HostId;
  threadId: ThreadId;
}

interface PersistedPromptDraftStoreState {
  draftsByThreadKey: Record<string, Record<string, unknown>>;
  draftThreadsByThreadKey: Record<string, PersistedDraftSession>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  stickyModelSelectionByProvider?: Partial<Record<AgentProfileId, ModelPick>>;
  stickyActiveProvider?: AgentProfileId | null;
}

type PersistedStateInput = Pick<
  PromptDraftStoreData,
  | "draftsByThreadKey"
  | "draftThreadsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  | "stickyModelSelectionByProvider"
  | "stickyActiveProvider"
>;

function serializeDraft(draft: PromptThreadDraftState): Record<string, unknown> | null {
  if (isEmptyDraft(draft)) return null;
  return {
    prompt: draft.prompt,
    ...(draft.terminalContexts.length > 0
      ? {
          terminalContexts: draft.terminalContexts.map((ch) => ({
            id: ch.id,
            threadId: ch.threadId,
            createdAt: ch.createdAt,
            terminalId: ch.terminalId,
            terminalLabel: ch.terminalLabel,
            lineStart: ch.lineStart,
            lineEnd: ch.lineEnd,
            text: ch.text,
          })),
        }
      : {}),
    ...(draft.previewAnnotations.length > 0
      ? { previewAnnotations: [...draft.previewAnnotations] }
      : {}),
    ...(draft.reviewComments.length > 0 ? { reviewComments: [...draft.reviewComments] } : {}),
    ...(Object.keys(draft.modelSelectionByProvider).length > 0
      ? { modelSelectionByProvider: { ...draft.modelSelectionByProvider } }
      : {}),
    ...(draft.activeProvider !== null ? { activeProvider: draft.activeProvider } : {}),
    ...(draft.modelSelectionExplicit === true ? { modelSelectionExplicit: true } : {}),
    ...(draft.runtimeMode !== null ? { runtimeMode: draft.runtimeMode } : {}),
    ...(draft.interactionMode !== null ? { interactionMode: draft.interactionMode } : {}),
  };
}

function serializeSession(session: DraftSessionState): PersistedDraftSession {
  return {
    threadId: session.threadId,
    hostId: session.hostId,
    projectId: session.projectId,
    logicalProjectKey: session.logicalProjectKey,
    ...(session.hostSelection !== undefined ? { hostSelection: session.hostSelection } : {}),
    ...(session.loadBalancedHostId !== undefined
      ? { loadBalancedHostId: session.loadBalancedHostId }
      : {}),
    createdAt: session.createdAt,
    runtimeMode: session.runtimeMode,
    interactionMode: session.interactionMode,
    branch: session.branch,
    worktreePath: session.worktreePath,
    envMode: session.envMode,
    startFromOrigin: session.startFromOrigin,
    ...(session.promotedTo !== undefined
      ? {
          promotedTo: session.promotedTo
            ? { hostId: session.promotedTo.hostId, threadId: session.promotedTo.threadId }
            : null,
        }
      : {}),
  };
}

export function partializePromptDraftStoreState(
  state: PersistedStateInput,
): PersistedPromptDraftStoreState {
  const mapped = new Set(Object.values(state.logicalProjectDraftThreadKeyByLogicalProjectKey));
  const keptSessions: Record<string, PersistedDraftSession> = {};
  for (const [id, session] of Object.entries(state.draftThreadsByThreadKey)) {
    const worthKeeping =
      mapped.has(id) ||
      !!session.promotedTo ||
      promptDraftHasUserContent(state.draftsByThreadKey[id]);
    if (worthKeeping) keptSessions[id] = serializeSession(session);
  }

  const drafts: Record<string, Record<string, unknown>> = {};
  for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
    // A composer belonging to a session we are not keeping goes with it.
    if (hasOwn(state.draftThreadsByThreadKey, key) && !hasOwn(keptSessions, key)) continue;
    const serialized = serializeDraft(draft);
    if (serialized) drafts[key] = serialized;
  }

  const sticky = state.stickyModelSelectionByProvider ?? {};
  return {
    draftsByThreadKey: drafts,
    draftThreadsByThreadKey: keptSessions,
    logicalProjectDraftThreadKeyByLogicalProjectKey: Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(([, id]) =>
        hasOwn(keptSessions, id),
      ),
    ),
    ...(Object.keys(sticky).length > 0 ? { stickyModelSelectionByProvider: sticky } : {}),
    ...(state.stickyActiveProvider ? { stickyActiveProvider: state.stickyActiveProvider } : {}),
  };
}

// ---------- hydration / migration ----------

const LEGACY_CODEX_OPTION_KEYS: Record<string, string> = {
  effort: "reasoningEffort",
  codexFastMode: "fastMode",
  serviceTier: "serviceTier",
};

function selectionsFromUnknown(val: unknown): AgentOptionSelection[] | undefined {
  if (Array.isArray(val)) return normalizeSelectionOptions(val as AgentOptionSelection[]);
  if (!isRecord(val)) return undefined;
  return normalizeSelectionOptions(
    Object.entries(val).flatMap(([id, v]) =>
      typeof v === "string" || typeof v === "boolean"
        ? [{ id: LEGACY_CODEX_OPTION_KEYS[id] ?? id, value: v }]
        : [],
    ),
  );
}

/** Reads a persisted model map in any historical spelling. */
function hydrateModelMap(unparsed: unknown): Partial<Record<AgentProfileId, ModelPick>> {
  const picks: Partial<Record<AgentProfileId, ModelPick>> = {};
  if (!isRecord(unparsed)) return picks;
  for (const [key, value] of Object.entries(unparsed)) {
    if (!isRecord(value)) continue;
    const instanceKey = migrateLegacyAgentId(key);
    const withInstance = { instanceId: instanceKey, ...value, ...(value.instanceId ? {} : {}) };
    const choice = normalizeModelPick(withInstance.instanceId === undefined ? value : withInstance);
    if (choice) picks[choice.instanceId] = choice;
  }
  return picks;
}

function hydrateSticky(persisted: Record<string, unknown>): {
  map: Partial<Record<AgentProfileId, ModelPick>>;
  active: AgentProfileId | null;
} {
  const table = hydrateModelMap(persisted.stickyModelSelectionByProvider);
  let engaged: AgentProfileId | null = null;
  const activeRaw = migrateLegacyAgentId(persisted.stickyActiveProvider);
  if (typeof activeRaw === "string" && INSTANCE_ID_PATTERN.test(activeRaw)) {
    engaged = activeRaw as AgentProfileId;
  }

  // Storage from before per-provider memory: one sticky model, optionally with a provider.
  const legacyModel = persisted.stickyModelSelection ?? undefined;
  if (Object.keys(table).length === 0) {
    const legacyProvider = migrateLegacyAgentId(
      typeof persisted.stickyProvider === "string" ? persisted.stickyProvider : "codex",
    );
    const modelText =
      isRecord(legacyModel) && typeof legacyModel.model === "string"
        ? legacyModel.model
        : typeof persisted.stickyModel === "string"
          ? persisted.stickyModel
          : null;
    if (modelText && INSTANCE_ID_PATTERN.test(legacyProvider)) {
      const optionSource =
        (isRecord(persisted.stickyModelOptions) &&
          (persisted.stickyModelOptions as Record<string, unknown>)[legacyProvider]) ||
        (isRecord(legacyModel) ? legacyModel.options : undefined);
      const choice = normalizeModelPick({
        instanceId: legacyProvider,
        model: modelText,
        ...(selectionsFromUnknown(optionSource)
          ? { options: selectionsFromUnknown(optionSource) }
          : {}),
      });
      if (choice) table[choice.instanceId] = choice;
      if (typeof persisted.stickyProvider === "string" && choice) engaged = choice.instanceId;
    }
  }
  return { map: table, active: engaged };
}

function hydrateTerminalContexts(
  unparsed: unknown,
  fallbackThread: ThreadId,
): TerminalExcerptDraft[] {
  if (!Array.isArray(unparsed)) return [];
  const excerpts: TerminalExcerptDraft[] = [];
  for (const rec of unparsed) {
    if (!isRecord(rec)) continue;
    if (
      !isNonEmptyString(rec.id) ||
      !isNonEmptyString(rec.createdAt) ||
      !isNonEmptyString(rec.terminalId) ||
      !isNonEmptyString(rec.terminalLabel) ||
      typeof rec.lineStart !== "number" ||
      typeof rec.lineEnd !== "number" ||
      !Number.isFinite(rec.lineStart) ||
      !Number.isFinite(rec.lineEnd)
    ) {
      continue;
    }
    const restoredThreadId = (
      typeof rec.threadId === "string" ? rec.threadId : fallbackThread
    ) as ThreadId;
    const excerpt = normalizeTerminalContext(
      {
        id: rec.id,
        threadId: restoredThreadId,
        createdAt: rec.createdAt,
        terminalId: rec.terminalId,
        terminalLabel: rec.terminalLabel,
        lineStart: rec.lineStart,
        lineEnd: rec.lineEnd,
        text: typeof rec.text === "string" ? rec.text : "",
      },
      restoredThreadId,
    );
    if (excerpt && !excerpts.some((ch) => ch.id === excerpt.id)) excerpts.push(excerpt);
  }
  return excerpts;
}

/** Old messages linked chips by the raw producer id; rewrite them to the kind-scoped id. */
function rewriteLegacyContextLinks(
  promptText: string,
  records: ReadonlyArray<{ kind: string; producerId: string; contextId: string }>,
): string {
  if (!promptText.includes("kora-context:")) return promptText;
  return replaceContextChipReferences(promptText, (occurrence) => {
    const matched = records.find(
      (res) =>
        res.kind === occurrence.kind &&
        res.contextId !== occurrence.contextId &&
        (occurrence.contextId === res.producerId ||
          occurrence.contextId === toContextChipId(res.producerId)),
    );
    return matched
      ? formatContextChipReference({
          kind: occurrence.kind,
          contextId: matched.contextId as never,
          label: occurrence.label,
        })
      : occurrence.source;
  });
}

function hydrateDraft(unparsed: unknown, keyName: string): PromptThreadDraftState | null {
  if (!isRecord(unparsed)) return null;
  const threadHint = keyName as ThreadId;

  const terminalContexts = hydrateTerminalContexts(unparsed.terminalContexts, threadHint);
  const previewAnnotations: WebMarkupPayload[] = [];
  if (Array.isArray(unparsed.previewAnnotations)) {
    for (const candidate of unparsed.previewAnnotations)
      if (isWebMarkup(candidate)) previewAnnotations.push(compactAnnotation(candidate));
  }
  // Older drafts stored picked elements; they are annotations now.
  if (Array.isArray(unparsed.elementContexts)) {
    for (const elem of unparsed.elementContexts) {
      if (!isRecord(elem) || !isRecord(elem.context ?? elem)) continue;
      try {
        const origin = (elem.context ?? elem) as never;
        const annotationId =
          typeof elem.id === "string" ? elem.id : `element-${previewAnnotations.length + 1}`;
        const annotation = elementContextToWebMarkup(
          origin,
          annotationId,
          String(elem.pickedAt ?? new Date(0).toISOString()),
        );
        if (isWebMarkup(annotation)) previewAnnotations.push(annotation);
      } catch {
        /* unusable legacy element */
      }
    }
  }
  const reviewComments = Array.isArray(unparsed.reviewComments)
    ? (unparsed.reviewComments.filter(isReviewComment) as ReviewCommentContext[])
    : [];

  let modelSelectionByProvider = hydrateModelMap(unparsed.modelSelectionByProvider);
  let activeProviderRaw = migrateLegacyAgentId(unparsed.activeProvider);
  if (Object.keys(modelSelectionByProvider).length === 0) {
    // Single-selection spellings.
    const legacyPick = normalizeModelPick(unparsed.modelSelection);
    if (legacyPick) {
      modelSelectionByProvider = { [legacyPick.instanceId]: legacyPick };
      activeProviderRaw ??= legacyPick.instanceId;
    } else if (typeof unparsed.model === "string" && typeof unparsed.provider === "string") {
      const choice = normalizeModelPick({
        instanceId: migrateLegacyAgentId(unparsed.provider),
        model: unparsed.model,
        ...(selectionsFromUnknown(unparsed.modelOptions)
          ? { options: selectionsFromUnknown(unparsed.modelOptions) }
          : {}),
      });
      if (choice) modelSelectionByProvider = { [choice.instanceId]: choice };
    }
  }
  const activeProvider =
    typeof activeProviderRaw === "string" && INSTANCE_ID_PATTERN.test(activeProviderRaw)
      ? (activeProviderRaw as AgentProfileId)
      : null;

  // Chips must always have their inline links; legacy placeholders bind to contexts in order.
  const legacyRecords = [
    ...terminalContexts.map((ch) => ({
      kind: "terminal",
      producerId: ch.id,
      contextId: terminalExcerptReference(ch).contextId,
    })),
    ...reviewComments.map((ch) => ({
      kind: "review-comment",
      producerId: ch.id,
      contextId: reviewCommentContextId(ch.id) as string,
    })),
    ...previewAnnotations.map((annotation) => ({
      kind: "preview-annotation",
      producerId: annotation.id,
      contextId: webMarkupContextId(annotation.id) as string,
    })),
  ];
  let promptText = typeof unparsed.prompt === "string" ? unparsed.prompt : "";
  promptText = migrateLegacyTerminalExcerptPlaceholders(
    promptText,
    terminalContexts.map((ch) => ({ ...ch })),
  );
  promptText = rewriteLegacyContextLinks(promptText, legacyRecords);
  promptText = ensureInlineContextLinks(
    promptText,
    contextReferencesOf({ terminalContexts, previewAnnotations, reviewComments }),
  );

  const draft: PromptThreadDraftState = {
    prompt: promptText,
    terminalContexts,
    previewAnnotations,
    reviewComments,
    modelSelectionByProvider,
    activeProvider,
    ...(unparsed.modelSelectionExplicit === true ? { modelSelectionExplicit: true } : {}),
    runtimeMode: isAccessMode(unparsed.runtimeMode) ? unparsed.runtimeMode : null,
    interactionMode: isTurnMode(unparsed.interactionMode) ? unparsed.interactionMode : null,
  };
  return isEmptyDraft(draft) ? null : draft;
}

function hydrateSession(
  unparsed: unknown,
  draftId: string,
  hostHint: HostId | undefined,
): DraftSessionState | null {
  if (!isRecord(unparsed)) return null;
  const hostKey = (unparsed.hostId ?? unparsed.environmentId ?? hostHint) as unknown;
  if (!isNonEmptyString(hostKey) || !isNonEmptyString(unparsed.projectId)) return null;
  const worktreePath = typeof unparsed.worktreePath === "string" ? unparsed.worktreePath : null;
  const envMode: DraftThreadEnvMode =
    unparsed.envMode === "worktree" || unparsed.envMode === "local"
      ? unparsed.envMode
      : worktreePath
        ? "worktree"
        : "local";
  const promoted = unparsed.promotedTo;
  return {
    draftId: draftId as DraftId,
    threadId: (isNonEmptyString(unparsed.threadId) ? unparsed.threadId : draftId) as ThreadId,
    hostId: hostKey as HostId,
    projectId: unparsed.projectId as ProjectId,
    logicalProjectKey: isNonEmptyString(unparsed.logicalProjectKey)
      ? unparsed.logicalProjectKey
      : hostProjectKey(hostProjectRef(hostKey as HostId, unparsed.projectId as ProjectId)),
    ...(unparsed.hostSelection === "auto" || unparsed.hostSelection === "manual"
      ? { hostSelection: unparsed.hostSelection }
      : {}),
    ...(isNonEmptyString(unparsed.loadBalancedHostId)
      ? { loadBalancedHostId: unparsed.loadBalancedHostId as HostId }
      : unparsed.loadBalancedHostId === null
        ? { loadBalancedHostId: null }
        : {}),
    createdAt:
      typeof unparsed.createdAt === "string" ? unparsed.createdAt : new Date(0).toISOString(),
    runtimeMode: isAccessMode(unparsed.runtimeMode) ? unparsed.runtimeMode : DEFAULT_ACCESS_MODE,
    interactionMode: isTurnMode(unparsed.interactionMode)
      ? unparsed.interactionMode
      : DEFAULT_TURN_MODE,
    branch: typeof unparsed.branch === "string" ? unparsed.branch : null,
    worktreePath,
    envMode,
    startFromOrigin: unparsed.startFromOrigin === true,
    promotedTo:
      isRecord(promoted) && isNonEmptyString(promoted.hostId) && isNonEmptyString(promoted.threadId)
        ? hostThreadRef(promoted.hostId as HostId, promoted.threadId as ThreadId)
        : null,
  };
}

interface HydratedStore {
  draftsByThreadKey: Record<string, PromptThreadDraftState>;
  draftThreadsByThreadKey: Record<string, DraftSessionState>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  stickyModelSelectionByProvider: Partial<Record<AgentProfileId, ModelPick>>;
  stickyActiveProvider: AgentProfileId | null;
}

/** Normalises persisted data of any version into the current in-memory shapes. */
function hydratePersistedState(persisted: unknown): HydratedStore {
  const stored = isRecord(persisted) ? persisted : {};

  // Sessions: current name first, then the older ones keyed by thread id.
  const rawSessions = isRecord(stored.draftThreadsByThreadKey)
    ? stored.draftThreadsByThreadKey
    : isRecord(stored.draftThreadsByThreadId)
      ? stored.draftThreadsByThreadId
      : {};
  const draftThreadsByThreadKey: Record<string, DraftSessionState> = {};
  for (const [id, raw] of Object.entries(rawSessions)) {
    const sess = hydrateSession(raw, id, undefined);
    if (sess) draftThreadsByThreadKey[id] = sess;
  }

  const rawMappings = [
    stored.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stored.projectDraftThreadKeyByProjectKey,
    stored.projectDraftThreadIdByProjectKey,
    stored.projectDraftThreadIdByProjectId,
  ].find(isRecord);
  const logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {};
  for (const [key, id] of Object.entries(rawMappings ?? {})) {
    if (isNonEmptyString(key) && isNonEmptyString(id)) {
      logicalProjectDraftThreadKeyByLogicalProjectKey[key] = id;
    }
  }

  // Raw thread-id keys get their host from the session that names the same thread.
  const hostByThreadId = new Map<string, HostId>();
  for (const sess of Object.values(draftThreadsByThreadKey)) {
    hostByThreadId.set(sess.threadId, sess.hostId);
  }
  const rawDrafts = isRecord(stored.draftsByThreadKey)
    ? stored.draftsByThreadKey
    : isRecord(stored.draftsByThreadId)
      ? stored.draftsByThreadId
      : {};
  const draftsByThreadKey: Record<string, PromptThreadDraftState> = {};
  for (const [rawKey, raw] of Object.entries(rawDrafts)) {
    const hostInfo = hasOwn(draftThreadsByThreadKey, rawKey)
      ? undefined
      : hostByThreadId.get(rawKey);
    const keyName = hostInfo ? hostThreadKey(hostThreadRef(hostInfo, rawKey as ThreadId)) : rawKey;
    const draft = hydrateDraft(raw, rawKey);
    if (draft) draftsByThreadKey[keyName] = draft;
  }

  const sticky = hydrateSticky(stored);
  return {
    draftsByThreadKey,
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: sticky.map,
    stickyActiveProvider: sticky.active,
  };
}

/** Before version 9 an empty draft session carried a model that was only ever a seed. */
function stripLegacyModelSeeds(hydrated: HydratedStore): HydratedStore {
  const draftsByThreadKey = { ...hydrated.draftsByThreadKey };
  for (const key of Object.keys(hydrated.draftThreadsByThreadKey)) {
    const draft = draftsByThreadKey[key];
    if (!draft || draft.modelSelectionExplicit || promptDraftHasUserContent(draft)) continue;
    const stripped: PromptThreadDraftState = {
      ...draft,
      modelSelectionByProvider: {},
      activeProvider: null,
    };
    if (isEmptyDraft(stripped)) delete draftsByThreadKey[key];
    else draftsByThreadKey[key] = stripped;
  }
  return { ...hydrated, draftsByThreadKey };
}

// ---------- persistence wiring ----------

const deferredStorage = createDeferredStorage<StorageValue<PromptDraftStoreState>>(
  typeof window !== "undefined" ? safeLocalStorage() : undefined,
  (val) =>
    JSON.stringify({
      version: val.version,
      // The live store is reduced to its persisted shape only now; storage written by tests or
      // older code arrives already shaped and passes through.
      state:
        typeof (val.state as { setPrompt?: unknown }).setPrompt === "function"
          ? partializePromptDraftStoreState(val.state)
          : val.state,
    }),
  PERSIST_DEBOUNCE_MS,
);

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// ---------- the store ----------

const insertionHandlers = new Map<string, ContextChipInsertionHandler>();

export const usePromptDraftStore = create<PromptDraftStoreState>()(
  persist(
    (bag, get) => {
      /** Applies `update` to one composer; empty composers are removed. */
      const editDraft = (
        dest: PromptThreadTarget,
        update: (
          current: PromptThreadDraftState,
          data: PromptDraftStoreData,
        ) => PromptThreadDraftState,
      ) =>
        bag((data) => {
          const keyName = resolveDraftKey(data, dest);
          if (keyName === null) return data;
          const live = data.draftsByThreadKey[keyName];
          const fallbackBase = live ?? EMPTY_THREAD_DRAFT;
          const upcoming = update(fallbackBase, data);
          if (upcoming === fallbackBase) return data;
          if (isEmptyDraft(upcoming)) {
            if (!live) return data;
            return { draftsByThreadKey: omit(data.draftsByThreadKey, [keyName]) };
          }
          return { draftsByThreadKey: { ...data.draftsByThreadKey, [keyName]: upcoming } };
        });

      const readDraft = (dest: PromptThreadTarget): PromptThreadDraftState | null => {
        const data = get();
        const keyName = resolveDraftKey(data, dest);
        return keyName === null ? null : (data.draftsByThreadKey[keyName] ?? null);
      };

      const handlerFor = (dest: PromptThreadTarget) => {
        const keyName = resolveDraftKey(get(), dest);
        return keyName === null ? undefined : insertionHandlers.get(keyName);
      };

      /** Asks the composer to place chips at its caret. Runs outside any state update: it writes the prompt itself. */
      const placeAtCaret = (
        dest: PromptThreadTarget,
        refs: ContextChipReference[],
        opts: ContextChipAddOptions | undefined,
      ): boolean => {
        if (refs.length === 0) return false;
        if (opts?.appendReference === false) return true;
        if (opts?.insertAtCaret === false) return false;
        return handlerFor(dest)?.(refs) ?? false;
      };

      const sessionMatching = (data: PromptDraftStoreData, handle: HostProjectRef) => {
        const candidates = Object.values(data.draftThreadsByThreadKey).filter(
          (session) =>
            session.hostId === handle.hostId &&
            session.projectId === handle.projectId &&
            !session.promotedTo,
        );
        const mapped = new Set(Object.values(data.logicalProjectDraftThreadKeyByLogicalProjectKey));
        return candidates.find((session) => mapped.has(session.draftId)) ?? candidates[0] ?? null;
      };

      const setLogical: PromptDraftStoreActions["setLogicalProjectDraftThreadId"] = (
        logicalKey,
        projKey,
        draftIdInput,
        opts = {},
      ) =>
        bag((data) => {
          const keyName = logicalKey.trim();
          const draftId = draftIdInput.trim() as DraftId;
          if (!keyName || !draftId) return data;
          const earlierFound = data.draftThreadsByThreadKey[draftId];
          const sess = buildSession(draftId, keyName, projKey, earlierFound, opts);

          const mappings = Object.fromEntries(
            Object.entries(data.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
              ([k, id]) => k === keyName || id !== draftId,
            ),
          );
          const displaced = mappings[keyName];
          mappings[keyName] = draftId;

          const unchanged =
            earlierFound &&
            shallowEqual(earlierFound, sess) &&
            displaced === draftId &&
            Object.keys(mappings).length ===
              Object.keys(data.logicalProjectDraftThreadKeyByLogicalProjectKey).length;
          if (unchanged) return data;

          let sessions = { ...data.draftThreadsByThreadKey, [draftId]: sess };
          let drafts = data.draftsByThreadKey;
          if (displaced && displaced !== draftId) {
            const stillMapped = Object.values(mappings).includes(displaced);
            const old = sessions[displaced];
            // An invested draft (typed text, attachments) outlives its mapping: the sidebar lists it.
            if (
              old &&
              !stillMapped &&
              !old.promotedTo &&
              !promptDraftHasUserContent(drafts[displaced])
            ) {
              sessions = omit(sessions, [displaced]);
              drafts = omit(drafts, [displaced]);
            }
          }
          return {
            draftThreadsByThreadKey: sessions,
            draftsByThreadKey: drafts,
            logicalProjectDraftThreadKeyByLogicalProjectKey: mappings,
          };
        });

      const sessionFor = (data: PromptDraftStoreData, dest: PromptThreadTarget) =>
        resolveSession(data, dest);

      const getDraftSession = (draftId: DraftId) =>
        get().draftThreadsByThreadKey[draftId.trim()] ?? null;
      const getByLogicalKey = (keyName: string) => {
        const data = get();
        const draftId = data.logicalProjectDraftThreadKeyByLogicalProjectKey[keyName];
        const sess = draftId ? data.draftThreadsByThreadKey[draftId] : undefined;
        return sess && !sess.promotedTo ? sess : null;
      };
      const getByProjectRef = (handle: HostProjectRef) => {
        const data = get();
        return getByLogicalKey(hostProjectKey(handle)) ?? sessionMatching(data, handle);
      };
      const getByRef = (handle: HostThreadRef) =>
        findSessionByRef(get().draftThreadsByThreadKey, handle);

      const mutateModel = (
        dest: PromptThreadTarget,
        change: (draft: PromptThreadDraftState) => PromptThreadDraftState,
      ) => editDraft(dest, (draft) => change(draft));

      const setStickyFromPick = (choice: ModelPick, keepPreviousOptions: boolean) =>
        bag((data) => {
          const prior = data.stickyModelSelectionByProvider[choice.instanceId];
          // Model and effort are remembered as a pair: an effort picked for another model (Max on Sonnet) must not ride
          // along onto the next one (Opus 4.7 at Max, invisible in the composer label).
          const opts = choice.options?.length
            ? choice.options
            : keepPreviousOptions && prior?.model === choice.model
              ? prior?.options
              : undefined;
          return {
            stickyModelSelectionByProvider: {
              ...data.stickyModelSelectionByProvider,
              [choice.instanceId]: createModelPick(choice.instanceId, choice.model, opts),
            },
            stickyActiveProvider: choice.instanceId,
          };
        });

      const addChips = <Item>(
        dest: PromptThreadTarget,
        accepted: Item[],
        referencesOf: (item: Item) => ContextChipReference,
        opts: ContextChipAddOptions | undefined,
        withItems: (draft: PromptThreadDraftState, elems: Item[]) => PromptThreadDraftState,
      ) => {
        if (accepted.length === 0) return;
        const refs = accepted.map(referencesOf);
        const placed = placeAtCaret(dest, refs, opts);
        editDraft(dest, (draft) => {
          const updated = withItems(draft, accepted);
          if (placed || opts?.appendReference === false) return updated;
          if (opts?.allowDuplicateReference === true) {
            // A deliberate second chip for the same record.
            return {
              ...updated,
              prompt: refs.reduce(
                (str, handle) => appendInlineContextLink(str, handle),
                updated.prompt,
              ),
            };
          }
          return {
            ...updated,
            prompt: ensureInlineContextLinks(updated.prompt, refs),
          };
        });
      };

      return {
        stickyActiveProvider: null,
        stickyModelSelectionByProvider: {},
        rewindingThreadKeys: new Set<string>(),
        backgroundSubmissionThreadKeys: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        draftThreadsByThreadKey: {},
        draftsByThreadKey: {},

        getComposerDraft: readDraft,
        getDraftThreadByLogicalProjectKey: getByLogicalKey,
        getDraftSessionByLogicalProjectKey: getByLogicalKey,
        getDraftThreadByProjectRef: getByProjectRef,
        getDraftSessionByProjectRef: getByProjectRef,
        getDraftSession,
        getDraftSessionByRef: getByRef,
        getDraftThreadByRef: getByRef,
        getDraftThread: (dest) =>
          typeof dest === "string" ? getDraftSession(dest as DraftId) : getByRef(dest),
        listDraftThreadKeys: () => Object.keys(get().draftThreadsByThreadKey),
        hasDraftThreadsInHost: (hostKey) =>
          Object.values(get().draftThreadsByThreadKey).some(
            (session) => session.hostId === hostKey,
          ),

        setLogicalProjectDraftThreadId: setLogical,
        setProjectDraftThreadId: (projKey, draftId, opts) =>
          setLogical(hostProjectKey(projKey), projKey, draftId, opts),

        setDraftThreadContext: (dest, opts) =>
          bag((data) => {
            const sess = sessionFor(data, dest);
            if (!sess) return data;
            const { projectRef } = opts;
            const projectChanged =
              !!projectRef &&
              (projectRef.hostId !== sess.hostId || projectRef.projectId !== sess.projectId);

            const branch =
              opts.branch !== undefined ? opts.branch : projectChanged ? null : sess.branch;
            const worktreePath =
              opts.worktreePath !== undefined
                ? opts.worktreePath
                : projectChanged
                  ? null
                  : sess.worktreePath;
            const pinned = opts.branch != null || opts.worktreePath != null;
            const hostSelection = opts.hostSelection ?? (pinned ? "manual" : sess.hostSelection);
            const loadBalancedHostId =
              opts.loadBalancedHostId !== undefined
                ? opts.loadBalancedHostId
                : projectChanged
                  ? null
                  : sess.loadBalancedHostId;

            const upcoming: DraftSessionState = {
              ...sess,
              hostId: projectRef?.hostId ?? sess.hostId,
              projectId: projectRef?.projectId ?? sess.projectId,
              branch,
              worktreePath,
              envMode: opts.envMode ?? (worktreePath ? "worktree" : sess.envMode),
              startFromOrigin: opts.startFromOrigin ?? sess.startFromOrigin,
              runtimeMode: opts.runtimeMode ?? sess.runtimeMode,
              interactionMode: opts.interactionMode ?? sess.interactionMode,
              ...(hostSelection !== undefined ? { hostSelection } : {}),
              ...(loadBalancedHostId !== undefined ? { loadBalancedHostId } : {}),
            };
            if (shallowEqual(upcoming, sess)) return data;
            return {
              draftThreadsByThreadKey: {
                ...data.draftThreadsByThreadKey,
                [sess.draftId]: upcoming,
              },
            };
          }),

        clearProjectDraftThreadId: (projKey) =>
          bag((data) => {
            const doomed = Object.values(data.draftThreadsByThreadKey)
              .filter(
                (session) =>
                  session.hostId === projKey.hostId && session.projectId === projKey.projectId,
              )
              .map((session) => session.draftId as string);
            if (doomed.length === 0) return data;
            return {
              draftThreadsByThreadKey: omit(data.draftThreadsByThreadKey, doomed),
              draftsByThreadKey: omit(data.draftsByThreadKey, doomed),
              logicalProjectDraftThreadKeyByLogicalProjectKey: Object.fromEntries(
                Object.entries(data.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
                  ([, id]) => !doomed.includes(id),
                ),
              ),
            };
          }),

        clearProjectDraftThreadById: (projKey, dest) =>
          bag((data) => {
            const sess = sessionFor(data, dest);
            if (!sess || sess.hostId !== projKey.hostId || sess.projectId !== projKey.projectId) {
              return data;
            }
            return removeDraftEverywhere(data, sess.draftId);
          }),

        markDraftThreadPromoting: (dest, promotedTo) =>
          bag((data) => {
            const sess = sessionFor(data, dest);
            if (!sess) return data;
            const handle = promotedTo ?? hostThreadRef(sess.hostId, sess.threadId);
            if (sess.promotedTo && shallowEqual(sess.promotedTo, handle)) return data;
            return {
              draftThreadsByThreadKey: {
                ...data.draftThreadsByThreadKey,
                [sess.draftId]: { ...sess, promotedTo: handle },
              },
            };
          }),

        finalizePromotedDraftThread: (dest) =>
          bag((data) => {
            const sess = sessionFor(data, dest);
            if (!sess?.promotedTo) return data;
            const destination = hostThreadKey(sess.promotedTo);
            const blob = data.draftsByThreadKey[sess.draftId];
            const removed = removeDraftEverywhere(data, sess.draftId);
            const drafts = { ...(removed.draftsByThreadKey ?? {}) };
            // What was typed during setup follows the thread to its permanent key.
            if (blob) drafts[destination] = blob;
            return { ...removed, draftsByThreadKey: drafts };
          }),

        clearDraftThread: (dest) =>
          bag((data) => {
            const sess = sessionFor(data, dest);
            const keyName = resolveDraftKey(data, dest);
            if (!sess && (keyName === null || !data.draftsByThreadKey[keyName])) return data;
            const removed = sess ? removeDraftEverywhere(data, sess.draftId) : {};
            return {
              ...removed,
              draftsByThreadKey: omit(
                removed.draftsByThreadKey ?? data.draftsByThreadKey,
                keyName ? [keyName] : [],
              ),
            };
          }),

        setStickyModelSelection: (choice) => {
          const pick = normalizeModelPick(choice);
          if (pick) setStickyFromPick(pick, true);
        },

        applyStickyState: (dest) =>
          editDraft(dest, (draft, data) => {
            const { modelSelectionExplicit: _dropped, ...rest } = draft;
            return {
              ...rest,
              modelSelectionByProvider: pickFromMap(data.stickyModelSelectionByProvider),
              activeProvider: data.stickyActiveProvider,
            };
          }),

        setPrompt: (dest, promptText) =>
          editDraft(dest, (draft) =>
            draft.prompt === promptText ? draft : { ...draft, prompt: promptText },
          ),

        setTerminalContexts: (dest, scopes) =>
          editDraft(dest, (draft, data) => {
            const normalized = normalizeTerminalContexts(scopes, threadIdForTarget(data, dest));
            const retained = new Set(normalized.map((ch) => ch.id));
            const dropped = draft.terminalContexts
              .filter((ch) => !retained.has(ch.id))
              .map((ch) => terminalExcerptReference(ch).contextId as string);
            const promptText = ensureInlineContextLinks(
              stripReferences(draft.prompt, dropped),
              normalized.map(terminalExcerptReference),
            );
            return { ...draft, terminalContexts: normalized, prompt: promptText };
          }),

        setModelSelection: (dest, choice, opts) => {
          const pick = normalizeModelPick(choice);
          if (!pick) return;
          mutateModel(dest, (draft) => {
            const earlierFound = draft.modelSelectionByProvider[pick.instanceId];
            const keepOptions = !pick.options?.length && !opts?.replaceOptions;
            const merged = createModelPick(
              pick.instanceId,
              pick.model,
              keepOptions ? earlierFound?.options : pick.options,
            );
            const { modelSelectionExplicit: _previous, ...rest } = draft;
            return {
              ...rest,
              modelSelectionByProvider: {
                ...draft.modelSelectionByProvider,
                [merged.instanceId]: merged,
              },
              activeProvider: merged.instanceId,
              ...(opts?.explicit === true ? { modelSelectionExplicit: true } : {}),
            };
          });
        },

        setModelOptions: (dest, optionsByAgent) =>
          mutateModel(dest, (draft) => {
            let table = draft.modelSelectionByProvider;
            for (const variant of ["codex", "claude", "cursor", "opencode"] as const) {
              if (!(variant in optionsByAgent)) continue;
              const instKey = defaultProfileIdForDriver(variant as AgentId);
              const model =
                table[instKey]?.model ??
                (DEFAULT_MODEL_BY_AGENT as Record<string, string | undefined>)[variant] ??
                DEFAULT_MODEL;
              table = {
                ...table,
                [instKey]: createModelPick(
                  instKey,
                  model,
                  normalizeSelectionOptions(optionsByAgent[variant]),
                ),
              };
            }
            return table === draft.modelSelectionByProvider
              ? draft
              : { ...draft, modelSelectionByProvider: table };
          }),

        setProviderModelOptions: (dest, vendor, opts, conf) => {
          const instKey = conf?.instanceId ?? defaultProfileIdForDriver(vendor);
          let flushed: ModelPick | null = null;
          mutateModel(dest, (draft) => {
            const model =
              draft.modelSelectionByProvider[instKey]?.model ??
              conf?.model ??
              (DEFAULT_MODEL_BY_AGENT as Record<string, string | undefined>)[vendor] ??
              DEFAULT_MODEL;
            flushed = createModelPick(instKey, model, normalizeSelectionOptions(opts));
            return {
              ...draft,
              modelSelectionByProvider: {
                ...draft.modelSelectionByProvider,
                [instKey]: flushed,
              },
              // Trait edits are the user's intent.
              modelSelectionExplicit: true,
              activeProvider: conf?.instanceId ? instKey : draft.activeProvider,
            };
          });
          if (flushed && conf?.persistSticky === true) {
            const choice: ModelPick = flushed;
            bag((data) => ({
              stickyModelSelectionByProvider: {
                ...data.stickyModelSelectionByProvider,
                [choice.instanceId]: choice,
              },
              stickyActiveProvider: choice.instanceId,
            }));
          }
        },

        setRuntimeMode: (dest, flavor) => {
          const val = isAccessMode(flavor) ? flavor : null;
          editDraft(dest, (draft) =>
            draft.runtimeMode === val ? draft : { ...draft, runtimeMode: val },
          );
        },

        setInteractionMode: (dest, flavor) => {
          const val = isTurnMode(flavor) ? flavor : null;
          editDraft(dest, (draft) =>
            draft.interactionMode === val ? draft : { ...draft, interactionMode: val },
          );
        },

        insertTerminalContext: (dest, promptText, excerpt, pos) => {
          let inserted = false;
          editDraft(dest, (draft, data) => {
            const [accepted] = normalizeTerminalContexts(
              [excerpt],
              threadIdForTarget(data, dest),
              draft.terminalContexts,
            );
            if (!accepted) return draft;
            inserted = true;
            const when = Math.max(0, Math.min(Math.floor(pos), draft.terminalContexts.length));
            const scopes = [...draft.terminalContexts];
            scopes.splice(when, 0, accepted);
            return { ...draft, prompt: promptText, terminalContexts: scopes };
          });
          return inserted;
        },

        addTerminalContext: (dest, excerpt) => get().addTerminalContexts(dest, [excerpt]),

        addTerminalContexts: (dest, scopes, opts) => {
          const data = get();
          const keyName = resolveDraftKey(data, dest);
          if (keyName === null) return;
          const held = data.draftsByThreadKey[keyName]?.terminalContexts ?? [];
          const accepted = normalizeTerminalContexts(scopes, threadIdForTarget(data, dest), held);
          addChips(dest, accepted, terminalExcerptReference, opts, (draft, elems) => ({
            ...draft,
            terminalContexts: [...draft.terminalContexts, ...elems],
          }));
        },

        removeTerminalContext: (dest, contextId) =>
          editDraft(dest, (draft) => {
            const wanted = new Set([contextId, toContextChipId(contextId)]);
            const gone = draft.terminalContexts.filter((ch) => wanted.has(ch.id));
            if (gone.length === 0) return draft;
            return {
              ...draft,
              terminalContexts: draft.terminalContexts.filter((ch) => !wanted.has(ch.id)),
              prompt: stripReferences(
                draft.prompt,
                gone.map((ch) => terminalExcerptReference(ch).contextId as string),
              ),
            };
          }),

        clearTerminalContexts: (dest) =>
          editDraft(dest, (draft) =>
            draft.terminalContexts.length === 0
              ? draft
              : {
                  ...draft,
                  terminalContexts: [],
                  prompt: stripReferences(
                    draft.prompt,
                    draft.terminalContexts.map(
                      (ch) => terminalExcerptReference(ch).contextId as string,
                    ),
                  ),
                },
          ),

        addPreviewAnnotation: (dest, annotation, opts) => {
          const compact = compactAnnotation(annotation);
          const referenced = collectContextChipReferences(readDraft(dest)?.prompt ?? "").some(
            (obj) => obj.contextId === webMarkupContextId(compact.id),
          );
          const wantsReference = opts?.allowDuplicateReference === true || !referenced;
          addChips(
            dest,
            wantsReference ? [compact] : [],
            webMarkupContextReference,
            opts,
            (draft) => draft,
          );
          editDraft(dest, (draft) => {
            const pos = draft.previewAnnotations.findIndex(
              (existing) => existing.id === compact.id,
            );
            const previewAnnotations =
              pos < 0
                ? [...draft.previewAnnotations, compact]
                : draft.previewAnnotations.map((existing, idx) =>
                    idx === pos ? compact : existing,
                  );
            return { ...draft, previewAnnotations };
          });
        },

        setPreviewAnnotations: (dest, notes) =>
          editDraft(dest, (draft) => {
            const upcoming = notes.filter(isWebMarkup).map(compactAnnotation);
            const retained = new Set(upcoming.map((annotation) => annotation.id));
            const dropped = draft.previewAnnotations
              .filter((annotation) => !retained.has(annotation.id))
              .map((annotation) => webMarkupContextId(annotation.id) as string);
            return {
              ...draft,
              previewAnnotations: upcoming,
              prompt: ensureInlineContextLinks(
                stripReferences(draft.prompt, dropped),
                upcoming.map(webMarkupContextReference),
              ),
            };
          }),

        removePreviewAnnotation: (dest, annotationId) =>
          editDraft(dest, (draft) => {
            if (!draft.previewAnnotations.some((annotation) => annotation.id === annotationId))
              return draft;
            return {
              ...draft,
              previewAnnotations: draft.previewAnnotations.filter(
                (annotation) => annotation.id !== annotationId,
              ),
              prompt: stripReferences(draft.prompt, [webMarkupContextId(annotationId) as string]),
            };
          }),

        addReviewComment: (dest, remark, opts) => {
          if (!isReviewComment(remark)) return;
          const referenced = collectContextChipReferences(readDraft(dest)?.prompt ?? "").some(
            (obj) => obj.contextId === reviewCommentContextId(remark.id),
          );
          const wantsReference = opts?.allowDuplicateReference === true || !referenced;
          addChips(
            dest,
            wantsReference ? [remark] : [],
            reviewCommentContextReference,
            opts,
            (draft) => draft,
          );
          editDraft(dest, (draft) => {
            const pos = draft.reviewComments.findIndex((ch) => ch.id === remark.id);
            const reviewComments =
              pos < 0
                ? [...draft.reviewComments, remark]
                : draft.reviewComments.map((ch, idx) => (idx === pos ? remark : ch));
            return { ...draft, reviewComments };
          });
        },

        setReviewComments: (dest, comments) =>
          editDraft(dest, (draft) => {
            const upcoming = comments.filter(isReviewComment);
            const retained = new Set(upcoming.map((ch) => ch.id));
            const dropped = draft.reviewComments
              .filter((ch) => !retained.has(ch.id))
              .map((ch) => reviewCommentContextId(ch.id) as string);
            return {
              ...draft,
              reviewComments: upcoming,
              prompt: ensureInlineContextLinks(
                stripReferences(draft.prompt, dropped),
                upcoming.map(reviewCommentContextReference),
              ),
            };
          }),

        removeReviewComment: (dest, commentId) =>
          editDraft(dest, (draft) => {
            if (!draft.reviewComments.some((ch) => ch.id === commentId)) return draft;
            return {
              ...draft,
              reviewComments: draft.reviewComments.filter((ch) => ch.id !== commentId),
              prompt: stripReferences(draft.prompt, [reviewCommentContextId(commentId) as string]),
            };
          }),

        setContextInsertionHandler: (dest, cb) => {
          const keyName = resolveDraftKey(get(), dest);
          if (keyName === null) return undefined;
          if (cb === null) {
            insertionHandlers.delete(keyName);
            return undefined;
          }
          insertionHandlers.set(keyName, cb);
          return () => {
            if (insertionHandlers.get(keyName) === cb) insertionHandlers.delete(keyName);
          };
        },

        clearComposerContent: (dest) =>
          editDraft(dest, (draft) =>
            draft.prompt === "" &&
            draft.terminalContexts.length === 0 &&
            draft.previewAnnotations.length === 0 &&
            draft.reviewComments.length === 0
              ? draft
              : {
                  ...draft,
                  reviewComments: [],
                  previewAnnotations: [],
                  terminalContexts: [],
                  prompt: "",
                },
          ),

        clearComposerPrompt: (dest) =>
          editDraft(dest, (draft) => {
            const promptText = ensureInlineContextLinks("", contextReferencesOf(draft));
            return promptText === draft.prompt ? draft : { ...draft, prompt: promptText };
          }),
      };
    },
    {
      name: PROMPT_DRAFT_STORAGE_KEY,
      version: STORE_VERSION,
      storage: {
        getItem: (name) => {
          const unparsed = deferredStorage.getItem(name);
          if (typeof unparsed !== "string") return null;
          try {
            return JSON.parse(unparsed) as StorageValue<PromptDraftStoreState>;
          } catch {
            return null;
          }
        },
        setItem: (name, val) => deferredStorage.setItem(name, val),
        removeItem: (name) => deferredStorage.removeItem(name),
      },
      partialize: (snap) => snap,
      migrate: (savedVal, version) => {
        const hydrated = hydratePersistedState(savedVal);
        return (version < STORE_VERSION ? stripLegacyModelSeeds(hydrated) : hydrated) as never;
      },
      merge: (savedVal, live) => ({ ...live, ...hydratePersistedState(savedVal) }),
    },
  ),
);

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => deferredStorage.flush());
}

// ---------- non-store entry points ----------

const store = () => usePromptDraftStore.getState();

export function beginBackgroundDraftSubmissionByRef(threadHandle: HostThreadRef): void {
  usePromptDraftStore.setState((state) => ({
    backgroundSubmissionThreadKeys: {
      ...state.backgroundSubmissionThreadKeys,
      [hostThreadKey(threadHandle)]: true,
    },
  }));
}

export function clearBackgroundDraftSubmissionByRef(threadHandle: HostThreadRef): void {
  usePromptDraftStore.setState((state) => {
    const keyName = hostThreadKey(threadHandle);
    return keyName in state.backgroundSubmissionThreadKeys
      ? { backgroundSubmissionThreadKeys: omit(state.backgroundSubmissionThreadKeys, [keyName]) }
      : state;
  });
}

export function useBackgroundDraftSubmissionPending(threadHandle: HostThreadRef | null): boolean {
  return usePromptDraftStore(
    (state) =>
      threadHandle !== null &&
      state.backgroundSubmissionThreadKeys[hostThreadKey(threadHandle)] === true,
  );
}

export function clearPromptDraftsHost(hostKey: HostId): void {
  const scopedPrefix = `${hostKey}:`;
  usePromptDraftStore.setState((state) => {
    const sessionIds = Object.values(state.draftThreadsByThreadKey)
      .filter((sess) => sess.hostId === hostKey)
      .map((sess) => sess.draftId as string);
    const doomedDrafts = Object.keys(state.draftsByThreadKey).filter(
      (keyName) => sessionIds.includes(keyName) || keyName.startsWith(scopedPrefix),
    );
    return {
      draftThreadsByThreadKey: omit(state.draftThreadsByThreadKey, sessionIds),
      draftsByThreadKey: omit(state.draftsByThreadKey, doomedDrafts),
      logicalProjectDraftThreadKeyByLogicalProjectKey: Object.fromEntries(
        Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
          ([, id]) => !sessionIds.includes(id),
        ),
      ),
      backgroundSubmissionThreadKeys: Object.fromEntries(
        Object.entries(state.backgroundSubmissionThreadKeys).filter(
          ([k]) => !k.startsWith(scopedPrefix),
        ),
      ) as Record<string, true>,
      rewindingThreadKeys: new Set(
        [...state.rewindingThreadKeys].filter((k) => !k.startsWith(scopedPrefix)),
      ),
    };
  });
  deferredStorage.flush();
}

export function markDraftPromoted(threadHandle: HostThreadRef): void {
  const sess = findSessionByRef(store().draftThreadsByThreadKey, threadHandle);
  if (sess) store().markDraftThreadPromoting(sess.draftId, threadHandle);
}

export function restoreFailedBackgroundDraftThread(
  draftId: DraftId,
  stalledDraft: DraftThreadState,
  restoredThreadId: ThreadId,
): void {
  const revived: DraftThreadState = {
    ...stalledDraft,
    draftId,
    threadId: restoredThreadId,
    promotedTo: null,
  };
  usePromptDraftStore.setState((current) => ({
    draftThreadsByThreadKey: { ...current.draftThreadsByThreadKey, [draftId]: revived },
  }));
}

export function finalizePromotedDraftByRef(threadHandle: HostThreadRef): void {
  const sess = findSessionByRef(store().draftThreadsByThreadKey, threadHandle);
  if (sess) {
    if (!sess.promotedTo) store().markDraftThreadPromoting(sess.draftId, threadHandle);
    store().finalizePromotedDraftThread(sess.draftId);
  }
  clearBackgroundDraftSubmissionByRef(threadHandle);
}

// ---------- hooks and derived state ----------

export function usePromptThreadDraft(dest: PromptThreadTarget): PromptThreadDraftState {
  return usePromptDraftStore((state) => state.getComposerDraft(dest)) ?? EMPTY_THREAD_DRAFT;
}

export function deriveEffectivePromptModelState(input: {
  draft:
    | Pick<PromptThreadDraftState, "activeProvider" | "modelSelectionByProvider">
    | null
    | undefined;
  providers: ReadonlyArray<AgentStatus>;
  selectedProvider: AgentId;
  selectedInstanceId?: AgentProfileId | undefined;
  threadModelSelection: ModelPick | null | undefined;
  projectModelSelection: ModelPick | null | undefined;
  settings: UnifiedPrefs;
}): EffectivePromptModelState {
  const { draft, providers, selectedProvider, settings } = input;
  const instKey = input.selectedInstanceId ?? defaultProfileIdForDriver(selectedProvider);
  const isAntigravity = (selectedProvider as string) === "antigravity";
  const thread = input.threadModelSelection ?? null;
  const proj = input.projectModelSelection ?? null;
  const inherited = thread?.model ?? proj?.model ?? null;

  const resolvedBase = resolveAppModelPickForInstance(instKey, settings, providers, inherited, {
    preserveUnavailableSelection: thread?.instanceId === instKey,
  });
  const baseModel =
    resolvedBase ??
    (isAntigravity ? "" : resolveAppModelPick(selectedProvider, settings, providers, inherited));

  const bucket = draft?.modelSelectionByProvider ?? {};
  const driverBucket = (bucket as Record<string, ModelPick | undefined>)[selectedProvider];
  const savedPick =
    bucket[instKey] ??
    (isAntigravity && instKey !== (selectedProvider as string) ? undefined : driverBucket);

  const chosenModel = savedPick
    ? (resolveAppModelPickForInstance(instKey, settings, providers, savedPick.model, {
        preserveUnavailableSelection: true,
      }) ?? baseModel)
    : baseModel;

  const opts =
    savedPick?.options ??
    (thread?.instanceId === instKey ? thread.options : undefined) ??
    (proj?.instanceId === instKey ? proj.options : undefined);
  return {
    selectedModel: chosenModel,
    modelOptions: opts ? { [instKey]: opts } : null,
  };
}

export function useEffectivePromptModelState(input: {
  threadRef?: HostThreadRef | null | undefined;
  draftId?: DraftId | null | undefined;
  providers: ReadonlyArray<AgentStatus>;
  selectedProvider: AgentId;
  selectedInstanceId?: AgentProfileId | undefined;
  threadModelSelection: ModelPick | null | undefined;
  projectModelSelection: ModelPick | null | undefined;
  settings: UnifiedPrefs;
}): EffectivePromptModelState {
  const dest: PromptThreadTarget | null = input.threadRef ?? input.draftId ?? null;
  const draft = usePromptDraftStore((state) => (dest ? state.getComposerDraft(dest) : null));
  const { providers, selectedProvider, selectedInstanceId, settings } = input;
  const { threadModelSelection, projectModelSelection } = input;
  return useMemo(
    () =>
      deriveEffectivePromptModelState({
        draft: draft,
        providers,
        selectedProvider,
        selectedInstanceId,
        threadModelSelection,
        projectModelSelection,
        settings,
      }),
    [
      draft,
      providers,
      selectedProvider,
      selectedInstanceId,
      threadModelSelection,
      projectModelSelection,
      settings,
    ],
  );
}
