import { cn } from "~/util/utils";
import { promptFloatingLayerProps } from "./promptEventScope";
import { Spinner } from "../ui/spinner";
import { MenuTrigger, MenuPopup, MenuItem, Menu } from "../ui/menu";
import { Button } from "../ui/button";
import { type PointerEvent, memo } from "react";
import { ChevronDownIcon, ChevronLeftIcon } from "lucide-react";

type PendingAction = {
  isLastQuestion: boolean;
  questionIndex: number;
  isResponding: boolean;
  isComplete: boolean;
  canAdvance: boolean;
};

type Props = {
  preserveComposerFocusOnPointerDown?: boolean;
  onImplementPlanInNewThread: () => void;
  onPreviousPendingQuestion: () => void;
  pendingAction: PendingAction | null;
  sendDisabledReason: string | null;
  offerPlanFollowUp: boolean;
  hasSendableContent: boolean;
  isHostUnavailable: boolean;
  onInterrupt: () => void;
  promptHasText: boolean;
  isConnecting: boolean;
  isSendBusy: boolean;
  isRunning: boolean;
  compact: boolean;
};

const ACTION_COLORS =
  "bg-message-action text-message-action-foreground hover:bg-message-action-hover";

/** The `chip` Button variant ships no layout of its own, so every chip here centres its glyph/label itself
 *  (without it the send arrow sat 9 px left of centre). The `before:` inner-shadow layer must be pinned behind the
 *  content: as a plain flex item it took a gap slot and pushed the stop square 3 px right of centre. */
const CHIP_LAYOUT =
  "relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit]";

function ArrowUp() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
      <path
        d="M7 11.5V2.5M3 6.5l4-4 4 4"
        strokeLinejoin="round"
        strokeLinecap="round"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function StopSquare() {
  return (
    <svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
      <rect fill="currentColor" height="8" rx="1.5" width="8" x="2" y="2" />
    </svg>
  );
}

export const PromptPrimaryActions = memo(function PromptPrimaryActions({
  preserveComposerFocusOnPointerDown = false,
  onImplementPlanInNewThread,
  onPreviousPendingQuestion,
  offerPlanFollowUp,
  sendDisabledReason,
  hasSendableContent,
  isHostUnavailable,
  promptHasText,
  pendingAction,
  isConnecting,
  onInterrupt,
  isSendBusy,
  isRunning,
  compact,
}: Props) {
  const keepFocus = preserveComposerFocusOnPointerDown
    ? { onPointerDown: (event: PointerEvent) => event.preventDefault() }
    : {};
  const sendDisabled = sendDisabledReason !== null;
  const waiting = isConnecting || isSendBusy;

  const stopButton = (sizeClass: string) => (
    <Button
      aria-label="Stop generation"
      className={cn(
        CHIP_LAYOUT,
        "rounded-full bg-destructive/90 text-white shadow-destructive/24 shadow-xs transition-all duration-150 hover:scale-105 hover:bg-destructive motion-reduce:transition-none motion-reduce:hover:scale-100",
        "before:shadow-[inset_0_1px_--theme(--color-white/16%)]",
        sizeClass,
      )}
      onClick={onInterrupt}
      size="icon"
      type="button"
      variant="chip"
      {...keepFocus}
    >
      <StopSquare />
    </Button>
  );

  // ---- 1. a question from the agent is waiting ----
  if (pendingAction) {
    const { questionIndex, isLastQuestion, canAdvance, isResponding, isComplete } = pendingAction;
    const label = isResponding
      ? "Submitting..."
      : compact
        ? isLastQuestion
          ? "Submit"
          : "Next"
        : !isLastQuestion
          ? "Next question"
          : questionIndex > 0
            ? "Submit answers"
            : "Submit answer";
    const submitDisabled =
      isHostUnavailable || isResponding || (isLastQuestion ? !isComplete : !canAdvance);

    return (
      <div className={cn("flex justify-end", compact ? "gap-1.5" : "gap-2")}>
        {isRunning ? stopButton("relative size-8 shrink-0 sm:size-7") : null}
        {questionIndex > 0 ? (
          compact ? (
            <Button
              aria-label="Previous question"
              className="rounded-full"
              disabled={isResponding}
              onClick={onPreviousPendingQuestion}
              size="icon-sm"
              variant="outline"
              {...keepFocus}
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              className="rounded-full"
              disabled={isResponding}
              onClick={onPreviousPendingQuestion}
              size="sm"
              variant="outline"
              {...keepFocus}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          className={cn(CHIP_LAYOUT, "rounded-full", ACTION_COLORS, compact ? "px-3" : "px-4")}
          disabled={submitDisabled}
          size="sm"
          type="submit"
          variant="chip"
          {...keepFocus}
        >
          {label}
        </Button>
      </div>
    );
  }

  // ---- 2. plan follow-up ----
  if (offerPlanFollowUp) {
    const planDisabled = isSendBusy || sendDisabled || isConnecting || isHostUnavailable;
    if (promptHasText) {
      return (
        <Button
          className={cn(
            CHIP_LAYOUT,
            "h-9 rounded-full sm:h-8",
            ACTION_COLORS,
            compact ? "px-3" : "px-4",
          )}
          disabled={planDisabled}
          size="sm"
          type="submit"
          variant="chip"
          {...keepFocus}
        >
          {waiting ? "Sending…" : "Revise plan"}
        </Button>
      );
    }
    return (
      <div className="flex justify-end" data-prompt-implement-actions="true">
        <Button
          className={cn(CHIP_LAYOUT, "h-9 rounded-full rounded-r-none px-4 sm:h-8", ACTION_COLORS)}
          disabled={planDisabled}
          size="sm"
          type="submit"
          variant="chip"
          {...keepFocus}
        >
          {waiting ? "Sending…" : "Build it"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label="More ways to build the plan"
                className={cn(
                  CHIP_LAYOUT,
                  "h-9 rounded-full rounded-l-none border-l border-l-message-action-foreground/20 px-2 sm:h-8",
                  ACTION_COLORS,
                )}
                disabled={planDisabled}
                size="sm"
                variant="chip"
                {...keepFocus}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...promptFloatingLayerProps}>
            <MenuItem disabled={planDisabled} onClick={onImplementPlanInNewThread}>
              Build it in a fresh thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  // ---- 3. send / stop ----
  const ariaLabel = isHostUnavailable
    ? "Kora is disconnected"
    : sendDisabledReason !== null
      ? sendDisabledReason
      : isConnecting
        ? "Connecting"
        : isSendBusy
          ? "Sending"
          : isRunning
            ? "Queue message"
            : "Send message";
  const sendButtonDisabled =
    isSendBusy || sendDisabled || isConnecting || isHostUnavailable || !hasSendableContent;

  const sendButton = (
    <Button
      aria-label={ariaLabel}
      className={cn(
        CHIP_LAYOUT,
        "relative isolate size-9 overflow-hidden rounded-full bg-foreground text-background shadow-black/24 shadow-xs transition-all duration-150 hover:scale-105 hover:bg-foreground/90 motion-reduce:transition-none motion-reduce:hover:scale-100 sm:size-8",
        "not-disabled:before:shadow-[inset_0_1px_--theme(--color-white/16%)] not-disabled:active:before:shadow-[inset_0_1px_--theme(--color-black/8%)] active:shadow-none",
        "disabled:pointer-events-none disabled:scale-100 disabled:opacity-30 disabled:shadow-none",
      )}
      disabled={sendButtonDisabled}
      size="icon"
      type="submit"
      variant="chip"
      {...keepFocus}
    >
      {waiting ? <Spinner className="size-3.5" /> : <ArrowUp />}
    </Button>
  );

  if (!isRunning) return sendButton;

  return (
    <div className="flex items-center gap-1.5">
      {stopButton(hasSendableContent ? "size-9 sm:size-8" : "size-8")}
      {hasSendableContent ? sendButton : null}
    </div>
  );
});
