import { CheckIcon, FolderOpenIcon, GitBranchIcon, FolderIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { isNative } from "../../env";
import { useAddLocalFolderProject } from "../../hooks/useAddLocalFolderProject";
import { cn, thisComputer } from "../../util/utils";
import { KoraMark } from "../KoraWordmark";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ClaudeLoginButton } from "./ClaudeLoginButton";
import {
  agentsStep,
  cliPathProblem,
  forgetFirstRunChecks,
  gitProblem,
  useFirstRunChecks,
} from "./firstRunChecks";
import { FullAccessNote } from "./FullAccessNote";
import { OtherAgentSteps } from "./OtherAgentSteps";
import { useRecentProjects, type RecentProject } from "./projectSetup";
import { FixWithCopy, Segments } from "./SetupCheck";

type StepState = "done" | "current" | "waiting" | "later";

function StepBadge({ index, state }: { readonly index: number; readonly state: StepState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums",
        state === "done"
          ? "bg-success/15 text-success"
          : state === "current"
            ? "bg-foreground text-background"
            : "bg-foreground/8 text-muted-foreground",
      )}
    >
      {state === "done" ? (
        <CheckIcon className="size-3.5" />
      ) : state === "waiting" ? (
        <Spinner className="size-3.5" />
      ) : (
        index
      )}
    </span>
  );
}

function WelcomeStep({
  index,
  state,
  title,
  children,
  testId,
}: {
  readonly index: number;
  readonly state: StepState;
  readonly title: string;
  readonly children?: ReactNode;
  readonly testId: string;
}) {
  return (
    <li
      data-first-run-step={testId}
      data-state={state}
      aria-current={state === "current" ? "step" : undefined}
      className={cn(
        "flex gap-3 rounded-xl px-4 py-3.5 transition-colors",
        state === "current"
          ? "bg-card ring-1 ring-black/5 dark:bg-white/4 dark:ring-white/8"
          : "bg-transparent",
      )}
    >
      <StepBadge index={index} state={state} />
      <div className={cn("min-w-0 flex-1", state === "later" && "opacity-60")}>
        <p
          className={cn(
            "text-sm font-medium",
            state === "done" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
        </p>
        {children}
      </div>
    </li>
  );
}

function RecentProjectChips({
  projects,
  busyPath,
  onOpen,
}: {
  readonly projects: readonly RecentProject[];
  readonly busyPath: string | null;
  readonly onOpen: (path: string) => void;
}) {
  if (projects.length === 0) return null;
  return (
    <div className="mt-3" data-first-run-recents>
      <p className="text-muted-foreground text-xs">Recently opened in Claude Code</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {projects.map((project) => {
          const Icon = project.isGitRepo ? GitBranchIcon : FolderIcon;
          return (
            <Tooltip key={project.path}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    data-first-run-recent={project.path}
                    disabled={busyPath !== null}
                    onClick={() => onOpen(project.path)}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-[12.5px] text-foreground transition-colors hover:border-foreground/25 hover:bg-foreground/5 disabled:opacity-60"
                  />
                }
              >
                {busyPath === project.path ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="truncate">{project.name}</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">{project.displayPath}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The very first screen (Code surface, no project yet): what Kora is in one line, then three steps that tick as they
 * are done — connect a coding agent (Claude signs in from the app, no Terminal), open a project (picker, typed path in a browser, or one click on
 * a folder your agents already know), and the first message (in the project's chat, with starter prompts). Nothing
 * red before the user did anything; the permission default is said once, calmly, at the bottom.
 */
export function FirstRunWelcome() {
  const { httpBaseUrl, checks, checking, failed, recheck } = useFirstRunChecks();
  const git = gitProblem(checks);
  const cliPath = cliPathProblem(checks);
  const step1 = agentsStep(checks, failed);
  const addProject = useAddLocalFolderProject();
  const recents = useRecentProjects(httpBaseUrl);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = step1.kind === "done";

  const open = async (path?: string) => {
    setBusy(path ?? "picker");
    setError(null);
    try {
      const result = await addProject(path);
      if (result.kind === "failed") setError(result.message);
    } finally {
      setBusy(null);
    }
  };

  const step1State: StepState =
    step1.kind === "done" ? "done" : step1.kind === "checking" ? "waiting" : "current";
  const step2State: StepState = busy !== null ? "waiting" : ready ? "current" : "later";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        data-first-run-welcome
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden bg-background"
      >
        <div className="m-auto w-full max-w-xl px-6 py-10 [@media(max-height:720px)]:py-5">
          <header className="text-center">
            <KoraMark className="mx-auto size-10 opacity-90 [@media(max-height:720px)]:size-8" />
            <h1 className="mt-4 [@media(max-height:720px)]:mt-2 font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
              Welcome to Kora
            </h1>
            <p className="mx-auto mt-2 max-w-md text-muted-foreground text-sm leading-6">
              Your coding agents (Claude Code, Codex, OpenCode, Antigravity), with a map of your
              code. Index a project once, on {thisComputer()}, and they find what they need without
              re-reading files.
            </p>
          </header>

          <ol className="mt-8 space-y-1.5 [@media(max-height:720px)]:mt-5" aria-label="Get started">
            <WelcomeStep
              index={1}
              state={step1State}
              testId="sign-in"
              title={
                step1.kind === "done"
                  ? step1.agents.length > 0
                    ? `Ready: ${step1.agents.join(", ")}`
                    : "Coding agent ready"
                  : "Connect a coding agent"
              }
            >
              {step1.kind === "checking" ? (
                <p className="mt-0.5 text-muted-foreground text-xs">Checking {thisComputer()}…</p>
              ) : step1.kind === "done" ? (
                step1.detail ? (
                  <p className="mt-0.5 text-muted-foreground text-xs">{step1.detail}</p>
                ) : null
              ) : step1.kind === "choose" ? (
                <>
                  <p className="mt-0.5 text-muted-foreground text-xs leading-5">
                    Kora works with any one of these. Claude has a one-click login; the others use
                    their own.
                  </p>
                  {step1.claude.kind === "sign-in" && httpBaseUrl ? (
                    <div className="mt-2.5">
                      <ClaudeLoginButton
                        size="sm"
                        httpBaseUrl={httpBaseUrl}
                        doneText="Signed in."
                        onLoggedIn={forgetFirstRunChecks}
                      />
                    </div>
                  ) : step1.claude.kind === "fix" ? (
                    <div className="mt-1 space-y-1.5 text-xs [overflow-wrap:anywhere]">
                      {step1.claude.problems.map((problem) => (
                        <div key={problem.id}>
                          <span className="text-foreground">
                            <Segments text={problem.detail} />
                          </span>
                          {problem.fix ? <FixWithCopy fix={problem.fix} /> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <OtherAgentSteps className="mt-1.5" />
                  <Button size="xs" variant="outline" onClick={recheck} className="mt-2">
                    Check again
                  </Button>
                </>
              ) : (
                <div className="mt-1 space-y-2 text-xs">
                  <p className="text-muted-foreground">
                    Kora couldn't check your agents on {thisComputer()} just now.
                  </p>
                  <Button size="xs" variant="outline" onClick={recheck}>
                    Try again
                  </Button>
                </div>
              )}
            </WelcomeStep>

            <WelcomeStep index={2} state={step2State} testId="project" title="Open a project">
              <p className="mt-0.5 text-muted-foreground text-xs leading-5">
                Pick a folder with code you want to work on. A git repository works best.
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={ready ? "default" : "outline"}
                  disabled={busy !== null}
                  data-first-run-open-folder
                  onClick={() => void open()}
                >
                  {busy === "picker" ? <Spinner className="size-4" /> : <FolderOpenIcon />}
                  {isNative ? "Choose a folder…" : "Enter a folder path…"}
                </Button>
              </div>
              {git ? (
                <div
                  data-first-run-git
                  role="status"
                  className="mt-3 rounded-lg bg-foreground/4 px-3 py-2.5 text-xs leading-5 [overflow-wrap:anywhere]"
                >
                  <p className="text-foreground">
                    <Segments text={git.detail} />
                  </p>
                  {git.fix ? <FixWithCopy fix={git.fix} /> : null}
                  <Button
                    size="xs"
                    variant="outline"
                    className="mt-2"
                    disabled={checking}
                    data-first-run-git-recheck
                    onClick={recheck}
                  >
                    {checking ? "Checking…" : "Check again"}
                  </Button>
                </div>
              ) : null}
              {recents ? (
                <RecentProjectChips
                  projects={recents}
                  busyPath={busy}
                  onOpen={(path) => void open(path)}
                />
              ) : null}
              {error ? (
                <p role="alert" className="mt-2 text-destructive text-xs">
                  {error}
                </p>
              ) : null}
            </WelcomeStep>

            <WelcomeStep
              index={3}
              state="later"
              testId="first-message"
              title="Ask your first question"
            >
              <p className="mt-0.5 text-muted-foreground text-xs leading-5">
                Start with a tour of your code or a small change. Click{" "}
                <strong className="font-medium text-foreground">Index now</strong> to build the code
                map; you can chat right away.
              </p>
              {cliPath ? (
                <div
                  data-first-run-cli-path
                  role="status"
                  className="mt-3 rounded-lg bg-foreground/4 px-3 py-2.5 text-xs leading-5 [overflow-wrap:anywhere]"
                >
                  <p className="text-foreground">
                    <Segments text={cliPath.detail} />
                  </p>
                  {cliPath.fix ? <FixWithCopy fix={cliPath.fix} /> : null}
                  <Button
                    size="xs"
                    variant="outline"
                    className="mt-2"
                    disabled={checking}
                    data-first-run-cli-path-recheck
                    onClick={recheck}
                  >
                    {checking ? "Checking…" : "Check again"}
                  </Button>
                </div>
              ) : null}
            </WelcomeStep>
          </ol>

          <FullAccessNote className="mt-8 [@media(max-height:720px)]:mt-5" />
        </div>
      </div>
    </SidebarInset>
  );
}
