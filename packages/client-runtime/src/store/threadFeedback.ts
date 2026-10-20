import type { ItemId } from "@kora/contracts";

type CodexFeedbackSubmissionDetails = {
  readonly createdAt: string;
  readonly command: string;
  readonly id: ItemId;
};

type CodexFeedbackOutcome =
  | { readonly errorMessage: string; readonly status: "failed" }
  | { readonly feedbackId: string; readonly status: "sent" }
  | { readonly status: "uploading" | "interrupted" };

export type CodexFeedbackSubmission = CodexFeedbackSubmissionDetails & CodexFeedbackOutcome;
