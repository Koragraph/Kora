import { create } from "zustand";
import { promptTargetKey, type PromptThreadTarget } from "./promptDraftStore";
import type { PendingPromptAttachment } from "../util/promptAttachments";

/**
 * Pending composer attachments, scoped by draft/thread like the rest of the
 * composer's content. Deliberately NOT persisted: data URLs can be tens of
 * megabytes and only need to survive the current tab, not a reload.
 */
interface PromptAttachmentStoreState {
  attachmentsByThreadKey: Record<string, PendingPromptAttachment[]>;
  addAttachments: (
    target: PromptThreadTarget,
    attachments: ReadonlyArray<PendingPromptAttachment>,
  ) => void;
  removeAttachment: (target: PromptThreadTarget, attachmentId: string) => void;
  clearAttachments: (target: PromptThreadTarget) => void;
}

const EMPTY_ATTACHMENTS: PendingPromptAttachment[] = [];

export const usePromptAttachmentStore = create<PromptAttachmentStoreState>((set) => ({
  attachmentsByThreadKey: {},
  addAttachments: (target, attachments) => {
    if (attachments.length === 0) return;
    const key = promptTargetKey(target);
    set((state) => ({
      attachmentsByThreadKey: {
        ...state.attachmentsByThreadKey,
        [key]: [...(state.attachmentsByThreadKey[key] ?? []), ...attachments],
      },
    }));
  },
  removeAttachment: (target, attachmentId) => {
    const key = promptTargetKey(target);
    set((state) => {
      const existing = state.attachmentsByThreadKey[key];
      if (!existing || existing.length === 0) return state;
      return {
        attachmentsByThreadKey: {
          ...state.attachmentsByThreadKey,
          [key]: existing.filter((attachment) => attachment.id !== attachmentId),
        },
      };
    });
  },
  clearAttachments: (target) => {
    const key = promptTargetKey(target);
    set((state) => {
      if (!(key in state.attachmentsByThreadKey)) return state;
      const next = { ...state.attachmentsByThreadKey };
      delete next[key];
      return { attachmentsByThreadKey: next };
    });
  },
}));

export function usePromptAttachments(target: PromptThreadTarget): PendingPromptAttachment[] {
  const key = promptTargetKey(target);
  return usePromptAttachmentStore(
    (state) => state.attachmentsByThreadKey[key] ?? EMPTY_ATTACHMENTS,
  );
}
