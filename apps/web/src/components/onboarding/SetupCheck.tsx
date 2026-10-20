import { Link } from "@tanstack/react-router";
import { CheckIcon, CircleAlertIcon, CopyIcon, LogInIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyText";
import { fixSegments } from "../../util/healthCheck";
import { cn } from "../../util/utils";
import { usePrimaryHostId } from "../../atoms/hosts";
import { ClaudeLoginButton } from "./ClaudeLoginButton";
import { OtherAgentSteps } from "./OtherAgentSteps";
import {
  claudeStep,
  cliPathProblem,
  firstRunProblems,
  forgetFirstRunChecks,
  useFirstRunChecks,
} from "./firstRunChecks";

export { FIRST_RUN_CHECKS, firstRunProblems, cliPathProblem } from "./firstRunChecks";

/** Plain text with `backticked` commands shown as code. */
export function Segments({ text }: { readonly text: string }) {
  return (
    <>
      {fixSegments(text).map((segment, index) =>
        segment.code ? (
          <code
            key={`${index}:${segment.text}`}
            className="rounded bg-muted px-1 py-px font-mono text-[11px] text-foreground"
          >
            {segment.text}
          </code>
        ) : (
          <span key={`${index}:${segment.text}`}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** The fix line, with a one-click copy of its first command (it goes into a terminal). */
export function FixWithCopy({ fix }: { readonly fix: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const command = fixSegments(fix).find((segment) => segment.code)?.text ?? null;
  return (
    <span className="mt-0.5 flex items-start gap-1.5 text-muted-foreground">
      <span className="min-w-0 flex-1">
        <Segments text={fix} />
      </span>
      {command ? (
        <button
          type="button"
          data-setup-check="copy"
          aria-label={isCopied ? "Copied" : `Copy ${command}`}
          onClick={() => copyToClipboard(command)}
          className="mt-px shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </button>
      ) : null}
    </span>
  );
}

/**
 * The empty states' setup line: does at least one agent (Claude Code, Codex, OpenCode, Antigravity) work on this Mac?
 * A new user who skips this finds out only when the first message fails, so it shows here — calmly: nothing has failed yet, it is one step to do. A
 * Mac with no agent that can run the Claude login gets one card with Log in to Claude (no Terminal) and the other
 * three ways in; anything else lists what to fix with its command. Renders nothing on daemons without `/api/doctor`.
 */
export function SetupCheck({
  className,
  problemsOnly = false,
  requireClaude = false,
}: {
  readonly className?: string;
  /** Show nothing when all is well (the empty chat, where a "ready" line would be noise). */
  readonly problemsOnly?: boolean;
  /** A Claude thread needs the Claude login even when another agent works. */
  readonly requireClaude?: boolean;
}) {
  const hostId = usePrimaryHostId();
  const { httpBaseUrl, checks, checking, recheck } = useFirstRunChecks();

  if (checks === null) return null;
  const step = claudeStep(checks, false);
  const { problems, readyLine } = firstRunProblems(checks, { requireClaude });
  const cliPath = cliPathProblem(checks);
  const allProblems = [...problems, ...(cliPath ? [cliPath] : [])];
  if (allProblems.length === 0) {
    return readyLine && !problemsOnly ? (
      <p
        data-setup-check="ready"
        className={cn(
          "flex items-center justify-center gap-1.5 text-muted-foreground text-xs",
          className,
        )}
      >
        <CheckIcon className="size-3.5 text-success" aria-hidden />
        {readyLine}
      </p>
    ) : null;
  }
  const card = cn(
    "rounded-xl bg-card p-3.5 text-start ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/6",
    className,
  );
  if (step.kind === "sign-in" && httpBaseUrl && problems.length > 0) {
    // The one thing to do happens in Kora: no command, no health-check chrome.
    return (
      <div data-setup-check="sign-in" role="status" className={card}>
        <div className="flex items-start gap-2.5">
          <LogInIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground text-sm">
              {requireClaude ? "Sign in to Claude to start" : "Connect a coding agent to start"}
            </p>
            <p className="mt-0.5 text-muted-foreground text-xs leading-5">
              {requireClaude
                ? "Kora runs on your Claude plan. It opens your browser; no Terminal needed."
                : "Sign in to Claude here (it opens your browser; no Terminal needed), or use one of these."}
            </p>
            <ClaudeLoginButton httpBaseUrl={httpBaseUrl} onLoggedIn={forgetFirstRunChecks} />
            {requireClaude ? null : <OtherAgentSteps className="mt-2" />}
            {cliPath ? (
              <div className="mt-3 border-t border-border/50 pt-2 text-xs">
                <span className="text-foreground">
                  <Segments text={cliPath.detail} />
                </span>
                {cliPath.fix ? <FixWithCopy fix={cliPath.fix} /> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div data-setup-check="problems" role="status" className={cn("space-y-2", card)}>
      <p className="font-medium text-foreground text-sm">
        {allProblems.length === 1
          ? "One thing to set up before your first message"
          : "A few things to set up before your first message"}
      </p>
      <ul className="space-y-2">
        {allProblems.map((check) => (
          <li key={check.id} className="flex gap-2 text-xs">
            <CircleAlertIcon
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                check.status === "fail" ? "text-warning" : "text-muted-foreground",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span className="text-foreground">
                <Segments text={check.detail} />
              </span>
              {check.fix ? <FixWithCopy fix={check.fix} /> : null}
            </span>
          </li>
        ))}
      </ul>
      {!requireClaude && problems.some((c) => c.id.startsWith("claude")) ? (
        <div>
          <p className="text-muted-foreground text-xs">Or use another agent:</p>
          <OtherAgentSteps />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          data-setup-check="recheck"
          disabled={checking}
          onClick={recheck}
          className="text-foreground text-xs underline-offset-2 hover:underline disabled:opacity-60"
        >
          {checking ? "Checking…" : "Check again"}
        </button>
        <Link
          to="/settings/diagnostics"
          search={{ machine: hostId ?? undefined }}
          className="inline-block text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
        >
          Run the full health check
        </Link>
      </div>
    </div>
  );
}
