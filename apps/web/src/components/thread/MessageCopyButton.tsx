import { cn } from "~/util/utils";
import { useCopyToClipboard } from "~/hooks/useCopyText";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopySuccessToast,
  showAnchoredCopyErrorToast,
} from "../ui/copiedToast";
import { useRef, memo } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

export const MessageCopyButton = memo(function MessageCopyButton({
  label = "Copy to clipboard",
  variant = "outline",
  extraFlavors,
  size = "xs",
  className,
  text,
}: {
  /** Additional clipboard types written beside `text/plain` when the platform allows it. */
  extraFlavors?: Readonly<Record<string, string>>;
  /** Accessible name: what the button copies ("Copy message" for a chat message). */
  label?: string;
  variant?: "outline" | "ghost";
  size?: "xs" | "icon-xs";
  className?: string;
  text: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { isCopied, copyToClipboard } = useCopyToClipboard<void>({
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    onCopy: () => showAnchoredCopySuccessToast(ref),
  });

  const tooltipTriggerPart = (
    <TooltipTrigger
      render={
        <Button
          className={cn("text-muted-foreground hover:text-foreground", className)}
          onClick={() => copyToClipboard(text)}
          disabled={isCopied}
          aria-label={label}
          variant={variant}
          type="button"
          size={size}
          ref={ref}
        />
      }
    >
      {isCopied ? (
        <CheckIcon className="size-3 text-control-checked" />
      ) : (
        <CopyIcon className="size-3" />
      )}
    </TooltipTrigger>
  );

  return (
    <Tooltip>
      {tooltipTriggerPart}
      <TooltipPopup>
        <p>Copy to clipboard</p>
      </TooltipPopup>
    </Tooltip>
  );
});
