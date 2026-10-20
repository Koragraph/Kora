import { cn } from "~/util/utils";
import { type PendingApproval } from "../../thread/timeline";
import { memo, useId } from "react";

interface PromptPendingApprovalPanelProps {
  className?: string;
  pendingCount: number;
  approval: PendingApproval;
}

type RequestCopy = { readonly label: string; readonly detail: string };

const FILE_CHANGE_COPY: RequestCopy = { label: "File change approval", detail: "File change" };
const REQUEST_COPY: Record<string, RequestCopy | undefined> = {
  "file-read": { label: "File read approval", detail: "File to read" },
  command: { label: "Command approval", detail: "Command" },
  "mcp-elicitation": { label: "App access approval", detail: "App access request" },
};

export const PromptPendingApprovalPanel = memo(function PromptPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: PromptPendingApprovalPanelProps) {
  const copy = REQUEST_COPY[approval.requestKind] ?? FILE_CHANGE_COPY;
  const fallbackLabel = copy.label;
  // The kind is a description, not a label: a label would replace the command itself for a screen reader.
  // useId, not the requestId: request ids are arbitrary strings and not safe as DOM ids.
  const detailKindId = useId();

  return (
    <span
      aria-label={fallbackLabel}
      className={cn(
        "flex min-w-0 flex-1 gap-2",
        approval.appName ? "items-start py-0.5" : "items-center",
        className,
      )}
      role="group"
    >
      {approval.appName ? (
        <span className="max-w-32 shrink-0 truncate rounded-md bg-foreground/10 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
          {approval.appName}
        </span>
      ) : null}
      <span id={detailKindId} className="sr-only">
        {copy.detail}
      </span>
      <code
        aria-describedby={detailKindId}
        className={cn(
          "block min-w-0 flex-1 overflow-auto text-foreground/85",
          approval.appName
            ? "max-h-24 whitespace-pre-wrap break-words font-sans text-[12px] leading-snug"
            : "max-h-20 whitespace-pre font-mono text-[11px]",
          "[scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
        )}
        data-approval-detail="complete"
        style={approval.appName ? { fontFamily: "var(--font-sans, inherit)" } : undefined}
        tabIndex={0}
      >
        {approval.detail || fallbackLabel}
      </code>
      {pendingCount > 1 ? (
        <span className="shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
          1/{pendingCount}
        </span>
      ) : null}
    </span>
  );
});
