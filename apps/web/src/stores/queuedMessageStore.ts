import type { WebMarkupPayload } from "@kora/contracts";
import { create } from "zustand";

import type { PromptSubmissionIntent } from "../prompt-logic";
import type { PendingPromptAttachment } from "../util/promptAttachments";
import type { TerminalExcerptDraft } from "../util/terminalContext";
import { randomUUID } from "../util/utils";
import type { ReviewCommentContext } from "../thread/reviewCommentContext";

export interface QueuedPromptMessage {
  createdAt: string;
  id: string;
  prompt: string;
  queuedAfterToolActivityId: string | null;
  submissionIntent: PromptSubmissionIntent;
  holdUntilUserAction?: boolean;
  terminalContexts: TerminalExcerptDraft[];
  previewAnnotations: WebMarkupPayload[];
  reviewComments: ReviewCommentContext[];
  attachments: PendingPromptAttachment[];
}

export interface QueuedMessageStoreState {
  drainGeneration: number;
  queuesByThreadKey: Record<string, QueuedPromptMessage[]>;
  drain(threadKey: string): QueuedPromptMessage[];
  enqueue(threadKey: string, message: Omit<QueuedPromptMessage, "id">): QueuedPromptMessage;
  holdAtFront(threadKey: string, message: QueuedPromptMessage): void;
  remove(threadKey: string, id: string): QueuedPromptMessage | null;
  take(threadKey: string, id: string, toolActivityId: string | null): QueuedPromptMessage | null;
}

export type TurnPhase = "connecting" | "running" | "ready" | "disconnected";

export interface QueuedDueInspection {
  readonly message: Pick<QueuedPromptMessage, "queuedAfterToolActivityId" | "holdUntilUserAction">;
  readonly phase: TurnPhase;
  readonly latestToolActivityId: string | null;
}

export type CompletedToolActivityLike = {
  readonly createdAt: string;
  readonly id: string;
  readonly sequence?: number | undefined;
  readonly kind: string;
};

const NO_QUEUED_MESSAGES: readonly QueuedPromptMessage[] = Object.freeze([]);

export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => {
  return {
    drainGeneration: 0,
    queuesByThreadKey: {},

    drain(threadKey: string): QueuedPromptMessage[] {
      const active = get().queuesByThreadKey[threadKey];
      if (!active || active.length === 0) {
        return [];
      }

      set((curr) => {
        const nextMap = { ...curr.queuesByThreadKey };
        delete nextMap[threadKey];
        return {
          queuesByThreadKey: nextMap,
          drainGeneration: curr.drainGeneration + 1,
        };
      });

      return active;
    },

    enqueue(threadKey: string, message: Omit<QueuedPromptMessage, "id">): QueuedPromptMessage {
      const created: QueuedPromptMessage = {
        ...message,
        id: randomUUID(),
      };

      set((curr) => {
        const existing = curr.queuesByThreadKey[threadKey] ?? NO_QUEUED_MESSAGES;
        return {
          queuesByThreadKey: {
            ...curr.queuesByThreadKey,
            [threadKey]: [...existing, created],
          },
        };
      });

      return created;
    },

    holdAtFront(threadKey: string, message: QueuedPromptMessage): void {
      set((curr) => {
        const currentList = curr.queuesByThreadKey[threadKey] ?? NO_QUEUED_MESSAGES;
        const remainder = currentList.filter((item) => item.id !== message.id);
        const restored: QueuedPromptMessage = {
          ...message,
          holdUntilUserAction: true,
        };

        return {
          queuesByThreadKey: {
            ...curr.queuesByThreadKey,
            [threadKey]: [restored, ...remainder],
          },
        };
      });
    },

    remove(threadKey: string, id: string): QueuedPromptMessage | null {
      const currentList = get().queuesByThreadKey[threadKey];
      if (!currentList) return null;

      const found = currentList.find((item) => item.id === id);
      if (!found) return null;

      set((curr) => {
        const list = curr.queuesByThreadKey[threadKey];
        if (!list) return {};
        const remaining = list.filter((item) => item.id !== id);
        const nextMap = { ...curr.queuesByThreadKey };

        if (remaining.length === 0) {
          delete nextMap[threadKey];
        } else {
          nextMap[threadKey] = remaining;
        }

        return { queuesByThreadKey: nextMap };
      });

      return found;
    },

    take(threadKey: string, id: string, toolActivityId: string | null): QueuedPromptMessage | null {
      const currentList = get().queuesByThreadKey[threadKey];
      if (!currentList) return null;

      const target = currentList.find((item) => item.id === id);
      if (!target) return null;

      set((curr) => {
        const list = curr.queuesByThreadKey[threadKey];
        if (!list) return {};

        const updatedRemainder = list
          .filter((item) => item.id !== id)
          .map((item) =>
            item.queuedAfterToolActivityId === toolActivityId
              ? item
              : { ...item, queuedAfterToolActivityId: toolActivityId },
          );

        const nextMap = { ...curr.queuesByThreadKey };
        if (updatedRemainder.length === 0) {
          delete nextMap[threadKey];
        } else {
          nextMap[threadKey] = updatedRemainder;
        }

        return { queuesByThreadKey: nextMap };
      });

      return target;
    },
  };
});

export function latestCompletedToolActivityId(
  activities: readonly CompletedToolActivityLike[],
): string | null {
  let highest: CompletedToolActivityLike | null = null;

  for (const item of activities) {
    if (item.kind !== "tool.completed") continue;
    if (!highest) {
      highest = item;
      continue;
    }

    const prevSeq = highest.sequence ?? -1;
    const currSeq = item.sequence ?? -1;

    if (currSeq > prevSeq) {
      highest = item;
    } else if (currSeq === prevSeq && item.createdAt > highest.createdAt) {
      highest = item;
    }
  }

  return highest?.id ?? null;
}

export function isQueuedMessageDue(input: QueuedDueInspection): boolean {
  if (input.message.holdUntilUserAction) {
    return false;
  }
  if (input.phase === "connecting") {
    return false;
  }
  if (input.phase !== "running") {
    return true;
  }
  return input.latestToolActivityId !== input.message.queuedAfterToolActivityId;
}

export function useQueuedMessages(threadKey: string): QueuedPromptMessage[] {
  return useQueuedMessageStore(
    (state) => state.queuesByThreadKey[threadKey] ?? (NO_QUEUED_MESSAGES as QueuedPromptMessage[]),
  );
}
