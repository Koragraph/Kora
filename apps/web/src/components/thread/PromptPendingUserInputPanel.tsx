import { cn } from "~/util/utils";
import { PromptBanner } from "./PromptBanner";
import { Hint } from "../ui/hint";
import { CollapsibleTrigger, CollapsiblePanel, Collapsible } from "../ui/collapsible";
import type { PendingQuestion } from "../../thread/timeline";
import {
  derivePendingQuestionProgress,
  type PendingQuestionDraftAnswer,
} from "../../thread/pendingUserInput";
import type { RequestId } from "@kora/contracts";
import { useEffect, useState, useRef, memo } from "react";
import { CheckIcon } from "lucide-react";

const ADVANCE_DELAY_MS = 200;

type Props = {
  onToggleOption: (questionId: string, optionValue: string) => void;
  answers: Record<string, PendingQuestionDraftAnswer>;
  onDismiss: (requestId: RequestId) => void;
  pendingUserInputs: PendingQuestion[];
  respondingRequestIds: RequestId[];
  questionIndex: number;
  onAdvance: () => void;
};

function Card({
  prompt,
  responding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
}: Omit<Props, "pendingUserInputs" | "respondingRequestIds"> & {
  prompt: PendingQuestion;
  responding: boolean;
}) {
  const progress = derivePendingQuestionProgress(prompt.questions, answers, questionIndex);
  const question = progress.activeQuestion;

  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<{ questionId: string; value: string } | null>(null);
  const advanceRef = useRef(onAdvance);
  advanceRef.current = onAdvance;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  // Drop the optimistic pick once it no longer applies or the real state has caught up.
  useEffect(() => {
    if (!optimistic) return;
    const stale = optimistic.questionId !== question?.id;
    const caughtUp =
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionValues.includes(optimistic.value);
    if (stale || caughtUp) setOptimistic(null);
  }, [optimistic, question?.id, progress.customAnswer, progress.selectedOptionValues]);

  if (!question) return null;

  const collapsed = collapsedQuestionId === question.id;
  const customBlank = progress.customAnswer.trim().length === 0;
  const total = prompt.questions.length;

  const choose = (value: string) => {
    if (question.multiSelect) {
      onToggleOption(question.id, value);
      return;
    }
    setOptimistic({ questionId: question.id, value });
    onToggleOption(question.id, value);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      advanceRef.current();
    }, ADVANCE_DELAY_MS);
  };

  const dismiss = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.stopPropagation();
    event.preventDefault();
    onDismiss(prompt.requestId);
  };

  return (
    <PromptBanner.Root density="comfortable">
      <Collapsible
        onOpenChange={(open) => setCollapsedQuestionId(open ? null : question.id)}
        open={!collapsed}
      >
        <CollapsibleTrigger
          render={
            <PromptBanner.Row
              render={<button type="button" />}
              title={
                collapsed
                  ? "Show the question and its options"
                  : "Hide the question and its options"
              }
            />
          }
          data-pending-user-input-toggle={collapsed ? "collapsed" : "expanded"}
        >
          <PromptBanner.Icon />
          <PromptBanner.Content>
            <span className="shrink-0 font-medium text-muted-foreground">{question.header}</span>
            {collapsed ? <span className="truncate">{question.question}</span> : null}
          </PromptBanner.Content>
          <PromptBanner.Actions>
            {total > 1 ? (
              <span className="font-medium text-[10px] text-muted-foreground tabular-nums">
                {`${questionIndex + 1}/${total}`}
              </span>
            ) : null}
            <PromptBanner.ToggleIcon expanded={!collapsed} />
            {prompt.dismissible ? (
              <Hint label="Dismiss question without answering">
                <span
                  aria-disabled={responding || undefined}
                  aria-label="Dismiss question without answering"
                  className={cn(
                    "inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
                    responding && "pointer-events-none opacity-50",
                  )}
                  data-pending-user-input-dismiss=""
                  onClick={dismiss}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") dismiss(event);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <XGlyph />
                </span>
              </Hint>
            ) : null}
          </PromptBanner.Actions>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <PromptBanner.Body className="pe-1 pb-1">
            <p className="text-foreground/85 text-sm">{question.question}</p>
            {question.multiSelect ? (
              <p className="mt-1 text-secondary-label text-xs">Pick any that apply.</p>
            ) : null}
            <div
              className="mt-2 flex max-h-[min(40vh,19rem)] flex-col gap-0.5 overflow-y-auto overscroll-contain pb-2"
              data-pending-user-input-options=""
            >
              {question.options.map((option, index) => {
                const value = option.value ?? option.label;
                const optimisticPick =
                  !question.multiSelect &&
                  optimistic?.questionId === question.id &&
                  optimistic.value === value;
                const selected =
                  optimisticPick || (customBlank && progress.selectedOptionValues.includes(value));
                return (
                  <button
                    className={cn(
                      "group flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring",
                      responding ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                      selected ? "text-foreground" : "text-foreground/85 hover:bg-foreground/4",
                    )}
                    disabled={responding}
                    key={`${value}:${index}`}
                    onClick={() => choose(value)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center border font-semibold text-[10.5px] tabular-nums",
                        question.multiSelect ? "rounded-[5px]" : "rounded-full",
                        selected
                          ? "border-foreground bg-foreground text-background"
                          : "border-border text-muted-foreground group-hover:border-foreground/40",
                      )}
                    >
                      {selected && question.multiSelect ? (
                        <CheckIcon className="size-3" />
                      ) : (
                        String.fromCharCode(65 + (index % 26))
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium text-sm">{option.label}</span>
                      {option.description && option.description !== option.label ? (
                        <span className="text-[11px] text-secondary-label">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </PromptBanner.Body>
        </CollapsiblePanel>
      </Collapsible>
    </PromptBanner.Root>
  );
}

function XGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export const PromptPendingUserInputPanel = memo(function PromptPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  ...rest
}: Props) {
  const prompt = pendingUserInputs[0];
  if (!prompt) return null;
  return (
    <Card
      key={prompt.requestId}
      prompt={prompt}
      responding={respondingRequestIds.includes(prompt.requestId)}
      {...rest}
    />
  );
});
