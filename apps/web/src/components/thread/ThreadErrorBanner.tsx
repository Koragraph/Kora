import { fixSegments } from "~/util/healthCheck";
import { friendlyAgentErrorCopy } from "~/util/agentErrorCopy";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { AlertDescription, AlertAction, Alert } from "../ui/alert";
import { memo } from "react";
import { CircleAlertIcon, CopyIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { writeTextToClipboard } from "../../hooks/useCopyText";
import { toastManager } from "../ui/toast";

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  if (error === null) {
    return null;
  }
  return `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  currentError: string | null,
  dismissed: boolean,
): boolean {
  if (dismissed) return false;
  return getThreadErrorBannerKey(threadKey, currentError) !== null;
}

// Session-scoped (module-level so it survives ThreadView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key plus message, so navigating away to a thread
// with no error cannot resurrect the banner, while a different error message
// on the same thread still appears.
const dismissedBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey === null) return;
  dismissedBannerKeys.add(bannerKey);
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey === null ? false : dismissedBannerKeys.has(bannerKey);
}

/** Calm copy names Terminal commands in backticks: those parts render as code, not as quotes. */
function ErrorText({ text }: { text: string }) {
  return fixSegments(text).map(({ code, text: part }, index) => {
    const key = `${index}:${part}`;
    if (!code) return <span key={key}>{part}</span>;
    return (
      <code key={key} className="rounded bg-destructive/10 px-1 py-px font-mono text-[0.92em]">
        {part}
      </code>
    );
  });
}

function copyErrorDetails(error: string) {
  const report = (type: "success" | "error", title: string) => toastManager.add({ type, title });
  void writeTextToClipboard(error, "error details").then(
    () => report("success", "Error details copied"),
    () => report("error", "Couldn't copy the error"),
  );
}

type ThreadErrorBannerProps = {
  /** Puts the last request back in the composer (the user sends it; nothing is re-sent behind their back). */
  onRetry?: (() => void) | undefined;
  onDismiss?: () => void;
  error: string | null;
};

function ErrorBanner({ error, onDismiss, onRetry }: ThreadErrorBannerProps) {
  if (!error) return null;
  // Calm copy for errors the user can't act on as written; the raw text stays in the tooltip.
  const calm = friendlyAgentErrorCopy(error) ?? error;
  const message = (
    <Tooltip>
      <TooltipTrigger render={<div className="line-clamp-3" />}>
        <ErrorText text={calm} />
      </TooltipTrigger>
      <TooltipPopup className="max-w-96 whitespace-pre-wrap" side="top">
        {error}
      </TooltipPopup>
    </Tooltip>
  );
  const actions = (
    <AlertAction>
      {onRetry ? (
        <Button onClick={onRetry} size="xs" variant="ghost">
          <RotateCcwIcon aria-hidden="true" />
          Put prompt back
        </Button>
      ) : null}
      {/* The full error, for keyboard users and bug reports (the tooltip is hover-only). */}
      <Button
        aria-label="Copy error details"
        onClick={() => copyErrorDetails(error)}
        size="icon-xs"
        variant="ghost"
      >
        <CopyIcon />
      </Button>
      {onDismiss ? (
        <Button aria-label="Dismiss error" onClick={onDismiss} size="icon-xs" variant="ghost">
          <XIcon className="text-destructive" />
        </Button>
      ) : null}
    </AlertAction>
  );
  const width = "pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3";
  return (
    <div className={width}>
      <Alert
        className="alert-glass"
        controlAlignment="first-line"
        data-variant="error"
        variant="error"
      >
        <CircleAlertIcon />
        <AlertDescription>{message}</AlertDescription>
        {actions}
      </Alert>
    </div>
  );
}

export const ThreadErrorBanner = memo(ErrorBanner);
