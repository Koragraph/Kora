import { CHAT_METHODS, DispatchCommandId, type ClientChatCommand } from "@kora/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { HostSupervisor } from "../link/supervisor.ts";
import {
  request,
  type HostRpcFailure,
  type HostRpcSuccess,
  type HostRpcUnavailableError,
} from "../wire/client.ts";

type Kind = ClientChatCommand["type"];
type Command<K extends Kind> = Extract<ClientChatCommand, { readonly type: K }>;

/** Callers may pass their own id and, for timestamped commands, their own creation time. */
type OptionalStamp<K extends Kind> = {
  readonly commandId?: DispatchCommandId;
} & ("createdAt" extends keyof Command<K> ? { readonly createdAt?: Command<K>["createdAt"] } : {});
type InputFor<K extends Kind> = Omit<Command<K>, "type" | "commandId" | "createdAt"> &
  OptionalStamp<K>;
/** What callers pass for each command kind. */
type Inputs = { [K in Kind]: InputFor<K> };

// Projects
export type CreateProjectInput = Inputs["createProject"];
export type UpdateProjectInput = Inputs["updateProjectMeta"];
export type DeleteProjectInput = Inputs["deleteProject"];
// Thread lifecycle and placement
export type CreateThreadInput = Inputs["createThread"];
export type ArchiveThreadInput = Inputs["archiveThread"];
export type UnarchiveThreadInput = Inputs["unarchiveThread"];
export type DeleteThreadInput = Inputs["deleteThread"];
export type SettleThreadInput = Inputs["settleThread"];
export type UnsettleThreadInput = Inputs["unsettleThread"];
export type SnoozeThreadInput = Inputs["snoozeThread"];
export type UnsnoozeThreadInput = Inputs["unsnoozeThread"];
export type PinThreadInput = Inputs["pinThread"];
export type ReorderPinnedThreadInput = Inputs["reorderPinnedThread"];
export type UnpinThreadInput = Inputs["unpinThread"];
export type ReorderActiveThreadInput = Inputs["reorderActiveThread"];
// Thread settings and links
export type UpdateThreadMetadataInput = Inputs["updateThreadMeta"];
export type LinkThreadMergeRequestInput = Inputs["linkPullRequest"];
export type UnlinkThreadMergeRequestInput = Inputs["unlinkPullRequest"];
export type SetThreadAccessModeInput = Inputs["setThreadRuntimeMode"];
export type SetThreadTurnModeInput = Inputs["setThreadInteractionMode"];
export type SetThreadAgentModeInput = Inputs["setThreadAgentMode"];
// Turns, replies and the session
export type StartThreadTurnInput = Inputs["turn.start"];
export type InterruptThreadTurnInput = Inputs["turn.interrupt"];
export type RespondToThreadApprovalInput = Inputs["approval.respond"];
export type RespondToThreadUserInputInput = Inputs["user-input.respond"];
export type DismissThreadUserInputInput = Inputs["user-input.dismiss"];
export type StopThreadSessionInput = Inputs["session.stop"];
/** `restoreFiles: false` rewinds the conversation only and leaves files alone. */
export type RevertThreadCheckpointInput = Inputs["revertThreadCheckpoint"] & {
  readonly restoreFiles?: boolean;
};

type DispatchMethod = typeof CHAT_METHODS.dispatch;
type CommandEffect = Effect.Effect<
  HostRpcSuccess<DispatchMethod>,
  HostRpcFailure<DispatchMethod> | HostRpcUnavailableError,
  HostSupervisor | Crypto.Crypto
>;

/** The caller's id, or a fresh random one. */
const idFor = (input: { readonly commandId?: DispatchCommandId }) =>
  input.commandId !== undefined
    ? Effect.succeed(input.commandId)
    : Crypto.Crypto.pipe(
        Effect.flatMap((crypto) => crypto.randomUUIDv4),
        Effect.orDie,
        Effect.map((uuid) => DispatchCommandId.make(uuid)),
      );

/** The caller's time, or now as ISO-8601. */
const timeFor = (input: { readonly createdAt?: string }) =>
  input.createdAt !== undefined
    ? Effect.succeed(input.createdAt)
    : Effect.map(DateTime.now, (now) => DateTime.formatIso(now));

const send = (command: object) => request(CHAT_METHODS.dispatch, command as ClientChatCommand);

/** A command that carries only an id. */
function plain<K extends Kind>(type: K, span: string): (input: InputFor<K>) => CommandEffect {
  return Effect.fn(span)(function* (input: InputFor<K>) {
    const commandId = yield* idFor(input);
    return yield* send({ ...input, type, commandId });
  });
}

/** A command that carries an id and a creation time. */
function stamped<K extends Kind>(type: K, span: string): (input: InputFor<K>) => CommandEffect {
  return Effect.fn(span)(function* (input: InputFor<K>) {
    const { commandId, createdAt } = yield* Effect.all({
      commandId: idFor(input),
      createdAt: timeFor(input as { readonly createdAt?: string }),
    });
    return yield* send({ ...input, type, commandId, createdAt });
  });
}

const span = (name: string) => `HostCommands.${name}`;

export const createProject = stamped("createProject", span("createProject"));
export const updateProject = plain("updateProjectMeta", span("updateProject"));
export const deleteProject = plain("deleteProject", span("deleteProject"));

export const createThread = stamped("createThread", span("createThread"));
export const deleteThread = plain("deleteThread", span("deleteThread"));
export const archiveThread = plain("archiveThread", span("archiveThread"));
export const unarchiveThread = plain("unarchiveThread", span("unarchiveThread"));
export const settleThread = plain("settleThread", span("settleThread"));
export const unsettleThread = plain("unsettleThread", span("unsettleThread"));
export const snoozeThread = plain("snoozeThread", span("snoozeThread"));
export const unsnoozeThread = plain("unsnoozeThread", span("unsnoozeThread"));
export const pinThread = plain("pinThread", span("pinThread"));
export const unpinThread = plain("unpinThread", span("unpinThread"));
export const reorderPinnedThread = plain("reorderPinnedThread", span("reorderPinnedThread"));
export const reorderActiveThread = plain("reorderActiveThread", span("reorderActiveThread"));
export const patchThreadMeta = plain("updateThreadMeta", span("patchThreadMeta"));
export const linkThreadMergeRequest = plain("linkPullRequest", span("linkThreadMergeRequest"));
export const unlinkThreadMergeRequest = plain(
  "unlinkPullRequest",
  span("unlinkThreadMergeRequest"),
);

export const setThreadAccessMode = stamped("setThreadRuntimeMode", span("setThreadAccessMode"));
export const setThreadTurnMode = stamped("setThreadInteractionMode", span("setThreadTurnMode"));
export const setThreadAgentMode = stamped("setThreadAgentMode", span("setThreadAgentMode"));
export const startThreadTurn = stamped("turn.start", span("startThreadTurn"));
export const interruptThreadTurn = stamped("turn.interrupt", span("interruptThreadTurn"));
export const respondToThreadApproval = stamped("approval.respond", span("respondToThreadApproval"));
export const respondToThreadUserInput = stamped(
  "user-input.respond",
  span("respondToThreadUserInput"),
);
export const dismissThreadUserInput = stamped("user-input.dismiss", span("dismissThreadUserInput"));
export const stopThreadSession = stamped("session.stop", span("stopThreadSession"));

const revertKeepingFiles = stamped("revertThreadConversation", span("revertThreadCheckpoint"));
const revertRestoringFiles = stamped("revertThreadCheckpoint", span("revertThreadCheckpoint"));

export const revertThreadCheckpoint = ({
  restoreFiles,
  ...rest
}: RevertThreadCheckpointInput): CommandEffect =>
  restoreFiles === false ? revertKeepingFiles(rest) : revertRestoringFiles(rest);
