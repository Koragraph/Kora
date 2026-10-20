import type { ChatThreadHead, HostId, ThreadId, ThreadIndexSnapshot } from "@kora/contracts";
import * as Crypto from "effect/Crypto";
import type { Atom } from "effect/unstable/reactivity";

import {
  unsnoozeThread,
  unsettleThread,
  unpinThread,
  unlinkThreadMergeRequest,
  unarchiveThread,
  stopThreadSession,
  startThreadTurn,
  snoozeThread,
  settleThread,
  setThreadTurnMode,
  setThreadAgentMode,
  setThreadAccessMode,
  revertThreadCheckpoint,
  respondToThreadUserInput,
  respondToThreadApproval,
  reorderPinnedThread,
  reorderActiveThread,
  pinThread,
  patchThreadMeta,
  linkThreadMergeRequest,
  interruptThreadTurn,
  dismissThreadUserInput,
  deleteThread,
  createThread,
  archiveThread,
} from "../commands/commands.ts";
import type { HostRegistry } from "../link/registry.ts";
import { createAtomActionScheduler, createHostCommand } from "./runtime.ts";
import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";
import { canSnooze } from "./threadSettled.ts";

export type {
  UpdateThreadMetadataInput,
  UnsnoozeThreadInput,
  UnsettleThreadInput,
  UnpinThreadInput,
  UnlinkThreadMergeRequestInput,
  UnarchiveThreadInput,
  StopThreadSessionInput,
  StartThreadTurnInput,
  SnoozeThreadInput,
  SettleThreadInput,
  ReorderActiveThreadInput,
  ReorderPinnedThreadInput,
  PinThreadInput,
  SetThreadAccessModeInput,
  SetThreadTurnModeInput,
  RevertThreadCheckpointInput,
  DismissThreadUserInputInput,
  RespondToThreadUserInputInput,
  RespondToThreadApprovalInput,
  LinkThreadMergeRequestInput,
  InterruptThreadTurnInput,
  DeleteThreadInput,
  CreateThreadInput,
  ArchiveThreadInput,
} from "../commands/commands.ts";

const sessionBusy = (thread: ChatThreadHead) =>
  thread.session?.status === "starting" || thread.session?.status === "running";

/** Local copy of the fields every settle/snooze transition clears the "needs you" flags on. */
const withoutPendingFlags = (thread: ChatThreadHead): ChatThreadHead => ({
  ...thread,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
});

export function createThreadHostAtoms<R, E>(
  runtime: Atom.AtomRuntime<HostRegistry | Crypto.Crypto | R, E>,
  snapshotAtom: (hostId: HostId) => Atom.Atom<ThreadIndexSnapshot | null>,
) {
  const lifecycle = createOptimisticThreadLifecycle(snapshotAtom);
  const scheduler = createAtomActionScheduler();
  const concurrency = {
    mode: "serial",
    key: (target: { readonly hostId: HostId; readonly input: { readonly threadId: ThreadId } }) =>
      JSON.stringify([target.hostId, target.input.threadId]),
  } as const;

  const make = <Input extends { readonly threadId: ThreadId }>(
    name: string,
    execute: (input: Input) => ReturnType<typeof settleThread>,
  ) =>
    createHostCommand(runtime, {
      label: `environment-data:commands:thread:${name}`,
      scheduler,
      concurrency,
      execute: (input: Input) => execute(input),
    });

  const settle = lifecycle.wrap(make("settle", settleThread), (thread, _input, now, accepted) => {
    if (!accepted && (!canSnooze(thread, { now }) || sessionBusy(thread))) return thread;
    return {
      ...withoutPendingFlags(thread),
      settledOverride: "settled",
      settledAt: thread.settledOverride === "settled" && thread.settledAt ? thread.settledAt : now,
      snoozedUntil: null,
      snoozedAt: null,
      pinOrderKey: null,
      pinnedAt: null,
      activeOrderKey: null,
      unsettledAt: null,
    };
  });

  const unsettle = lifecycle.wrap(make("unsettle", unsettleThread), (thread, input, now) => ({
    ...thread,
    settledOverride: input.reason === "user" ? "active" : null,
    settledAt: null,
    unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? now) : now,
  }));

  const snooze = lifecycle.wrap(make("snooze", snoozeThread), (thread, input, now, accepted) => {
    if (!accepted && !canSnooze(thread, { now })) return thread;
    if (!(Date.parse(input.snoozedUntil) > Date.parse(now))) return thread;
    return {
      ...withoutPendingFlags(thread),
      snoozedUntil: input.snoozedUntil,
      snoozedAt:
        thread.snoozedUntil === input.snoozedUntil && thread.snoozedAt ? thread.snoozedAt : now,
    };
  });

  const unsnooze = lifecycle.wrap(make("unsnooze", unsnoozeThread), (thread) => ({
    ...thread,
    snoozedUntil: null,
    snoozedAt: null,
  }));

  const pin = lifecycle.wrap(make("pin", pinThread), (thread, input, now) => {
    const wasPinned = Boolean(thread.pinnedAt);
    const base: ChatThreadHead = {
      ...thread,
      pinnedAt: thread.pinnedAt ?? now,
      pinOrderKey: wasPinned ? thread.pinOrderKey : (input.orderKey ?? null),
      snoozedAt: null,
      snoozedUntil: null,
    };
    return thread.settledOverride === "settled" ||
      (thread.settledAt && thread.settledOverride !== "active")
      ? { ...base, settledOverride: "active", settledAt: null, unsettledAt: now }
      : base;
  });

  const unpin = lifecycle.wrap(make("unpin", unpinThread), (thread) => ({
    ...thread,
    pinnedAt: null,
    pinOrderKey: null,
  }));

  const reorderPin = lifecycle.wrap(make("reorder-pin", reorderPinnedThread), (thread, input) => ({
    ...thread,
    pinOrderKey: input.orderKey,
  }));

  const reorderActive = lifecycle.wrap(
    make("reorder-active", reorderActiveThread),
    (thread, input) => ({ ...thread, activeOrderKey: input.orderKey }),
  );

  return {
    create: make("create", createThread),
    delete: make("delete", deleteThread),
    archive: make("archive", archiveThread),
    unarchive: make("unarchive", unarchiveThread),
    settle,
    unsettle,
    snooze,
    unsnooze,
    pin,
    unpin,
    reorderPin,
    reorderActive,
    updateMetadata: make("update-metadata", patchThreadMeta),
    linkPullRequest: make("link-pull-request", linkThreadMergeRequest),
    unlinkPullRequest: make("unlink-pull-request", unlinkThreadMergeRequest),
    setRuntimeMode: make("set-runtime-mode", setThreadAccessMode),
    setInteractionMode: make("set-interaction-mode", setThreadTurnMode),
    setAgentMode: make("set-agent-mode", setThreadAgentMode),
    startTurn: make("start-turn", startThreadTurn),
    interruptTurn: make("interrupt-turn", interruptThreadTurn),
    respondToApproval: make("respond-to-approval", respondToThreadApproval),
    respondToUserInput: make("respond-to-user-input", respondToThreadUserInput),
    dismissUserInput: make("dismiss-user-input", dismissThreadUserInput),
    revertCheckpoint: make("revert-checkpoint", revertThreadCheckpoint),
    stopSession: make("stop-session", stopThreadSession),
    snapshotAtom: lifecycle.snapshotAtom,
  };
}
