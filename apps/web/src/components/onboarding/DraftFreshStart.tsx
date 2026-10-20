import type { HostProject } from "@kora/client-runtime/store/models";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useGraphFreshness, type GraphFreshness } from "../../hooks/useGraphFreshness";
import { cn, thisComputer } from "../../util/utils";
import { useThreadSummaries } from "../../atoms/entities";
import { useHostHttpBaseUrl } from "../../atoms/hosts";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { agentsStep, useFirstRunChecks } from "./firstRunChecks";
import { FullAccessNote } from "./FullAccessNote";
import { requestIndex } from "./projectSetup";

/** First messages that show what Kora is for on any repo; a click sends the prompt as written. */
export const CODE_STARTERS = [
  {
    label: "Give me a tour of this codebase",
    prompt:
      "Give me a short tour of this codebase: what it does, how it is organised, and where the main pieces live.",
  },
  {
    label: "Find a bug worth fixing",
    prompt:
      "Find one real bug or rough edge in this code. Explain it in a few lines and say how you would fix it.",
  },
  {
    label: "Add a test for the core logic",
    prompt:
      "Add a small test for the most important function in this project, then run the tests and tell me the result.",
  },
] as const;

type IndexLine = {
  readonly tone: "busy" | "done" | "info" | "problem";
  readonly text: string;
  readonly action?: IndexAction;
} | null;
type IndexAction = { readonly label: string; readonly force: boolean };

/** One honest line about the project's index (local, on this Mac), or null when there is nothing worth saying. */
export function indexLineFor(f: GraphFreshness | null, name: string, fresh: boolean): IndexLine {
  if (f === null || f.storeDamaged) return null; // the header chip owns the rare damaged-store case
  if (f.folderMissing)
    return { tone: "problem", text: `${name}'s folder is gone (moved, renamed or deleted).` };
  if (f.indexing) {
    const pct = f.indexing.finalizing ? null : f.indexing.pct;
    return {
      tone: "busy",
      text: `${f.indexing.finalizing ? "Linking calls and imports" : "Indexing"} ${name}${pct != null ? ` · ${pct}%` : ""}: a local map of your code that never leaves ${thisComputer()}. You can start chatting now.`,
    };
  }
  if (f.ingestError) {
    return {
      tone: "problem",
      text: `Indexing ${name} failed: ${f.ingestError.message}`,
      action: { label: "Retry", force: !f.safeToIndex },
    };
  }
  if (f.incomplete)
    return {
      tone: "problem",
      text: `The last index of ${name} did not finish.`,
      action: { label: "Index again", force: !f.safeToIndex },
    };
  if (!f.indexed) {
    if (f.systemFolder)
      return {
        tone: "info",
        text: "Kora never indexes a home or system folder. Open a project folder to get a code map.",
      };
    if (f.isGitRepo === false)
      return {
        tone: "info",
        text: "This folder isn't a git repo. Chat works; Kora can still index it (slower on big folders), and Swarm workers will share it instead of getting their own copies.",
        action: { label: "Index anyway", force: true },
      };
    return {
      tone: "info",
      text: `${name} isn't indexed yet. Indexing builds a local map of your code so your agent reads less.`,
      action: { label: "Index now", force: false },
    };
  }
  // Indexed: worth a word only on a brand-new project (the header chip says it from then on).
  return fresh
    ? {
        tone: "done",
        text: `${name} is indexed (${f.files.toLocaleString()} ${f.files === 1 ? "file" : "files"}, on ${thisComputer()}). Your agent looks code up in it instead of re-reading files.`,
      }
    : null;
}

function ProjectIndexLine({
  project,
  fresh,
}: {
  readonly project: HostProject;
  readonly fresh: boolean;
}) {
  const httpBaseUrl = useHostHttpBaseUrl(project.hostId);
  const cwd = project.workspaceRoot;
  const { freshness, refetch } = useGraphFreshness(httpBaseUrl, cwd);
  const [starting, setStarting] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  // An index started by "Open project" shows up within a second or two: look again soon instead of the slow poll.
  useEffect(() => {
    const timers = [900, 2500, 6000].map((ms) => window.setTimeout(refetch, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [cwd, refetch]);
  const line = indexLineFor(freshness, project.title, fresh);
  if (line === null) return null;
  const Icon = line.tone === "done" ? CheckIcon : line.tone === "problem" ? CircleAlertIcon : null;
  return (
    <p
      data-draft-index-line={line.tone}
      className="flex max-w-xl items-start justify-center gap-2 text-center text-muted-foreground text-xs leading-5"
    >
      {line.tone === "busy" ? <Spinner className="mt-0.5 size-3.5 shrink-0" /> : null}
      {Icon ? (
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            line.tone === "done" ? "text-success" : "text-warning",
          )}
        />
      ) : null}
      <span className="text-start">
        {line.text}
        {line.action && httpBaseUrl ? (
          <>
            {" "}
            <button
              type="button"
              disabled={starting}
              data-draft-index-action
              onClick={() => {
                setStarting(true);
                setIndexError(null);
                void requestIndex(httpBaseUrl, cwd, { force: line.action!.force })
                  .then((res) => setIndexError(res.ok ? null : res.reason))
                  .finally(() => {
                    setStarting(false);
                    window.setTimeout(refetch, 800);
                    window.setTimeout(refetch, 2500);
                  });
              }}
              className="font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60"
            >
              {line.action.label}
            </button>
          </>
        ) : null}
        {indexError ? (
          <span role="alert" className="block text-destructive-foreground">
            Couldn't start indexing: {indexError}
          </span>
        ) : null}
      </span>
    </p>
  );
}

/**
 * Under the composer while a Code draft is empty: for a project with no chats yet, starter prompts (a click sends),
 * then the project's index status in one plain line, then — once — what Full access means. Starters wait for Claude's
 * sign-in (the card above the composer has the Sign in button).
 */
export function DraftFreshStart({
  project,
  onSendStarter,
}: {
  readonly project: HostProject;
  readonly onSendStarter: (prompt: string) => void;
}) {
  const threads = useThreadSummaries();
  const fresh = !threads.some((t) => t.hostId === project.hostId && t.projectId === project.id);
  const { checks, failed } = useFirstRunChecks();
  const step = agentsStep(checks, failed);
  // Disabled only once the check says no agent works: while it is still asking, most users are set up, and a
  // signed-out Claude send fails gently anyway (the reply offers Sign in and puts the message back).
  const canSend = step.kind !== "choose";
  return (
    <div
      data-draft-fresh-start
      className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-3 pt-1"
    >
      {fresh ? (
        <div className="flex flex-wrap items-center justify-center gap-2" data-draft-starters>
          {CODE_STARTERS.map((starter) => {
            const button = (
              <button
                key={starter.label}
                type="button"
                disabled={!canSend}
                data-draft-starter={starter.label}
                onClick={() => onSendStarter(starter.prompt)}
                className="rounded-full border border-border bg-card px-3.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground disabled:cursor-default disabled:opacity-50 disabled:hover:border-border disabled:hover:text-muted-foreground"
              >
                {starter.label}
              </button>
            );
            if (canSend) return button;
            // A disabled button gets no pointer events: the reason hangs on a wrapper.
            return (
              <Tooltip key={starter.label}>
                <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
                <TooltipPopup side="top">Connect a coding agent first (see above)</TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
      <ProjectIndexLine project={project} fresh={fresh} />
      {fresh ? <FullAccessNote dismissible className="max-w-lg" /> : null}
    </div>
  );
}
