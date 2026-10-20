import { PrefsSection } from "./prefsLayout";
import { Spinner } from "../ui/spinner";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "../ui/select";
import { Button } from "../ui/button";
import { ClaudeLoginButton } from "../onboarding/ClaudeLoginButton";
import { cn } from "../../util/utils";
import {
  exportDiagnostics,
  fetchHealthReport,
  checksForSurface,
  summarizeHealth,
  type HealthReport,
  type HealthStatus,
  type HealthCheck,
  fixSegments,
  orderChecks,
} from "../../util/healthCheck";
import { canLogInFromApp } from "../../util/claudeLogin";
import { localApiOrThrow } from "../../localApi";
import { useCopyToClipboard } from "../../hooks/useCopyText";
import { projectSurface } from "../../chatSurface";
import { useHostHttpBaseUrl } from "../../atoms/hosts";
import { useProjects } from "../../atoms/entities";
import type { HostId } from "@kora/contracts";
import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import {
  CircleAlertIcon,
  DownloadIcon,
  CircleXIcon,
  FolderIcon,
  CheckIcon,
  MinusIcon,
  CopyIcon,
} from "lucide-react";

const NO_PROJECT = "__none__";

function StatusIcon({ status }: { readonly status: HealthStatus }) {
  switch (status) {
    case "ok":
      return <CheckIcon className="size-3.5 text-success" aria-hidden />;
    case "warn":
      return <CircleAlertIcon className="size-3.5 text-warning" aria-hidden />;
    case "fail":
      return <CircleXIcon className="size-3.5 text-destructive" aria-hidden />;
    case "skip":
      return <MinusIcon className="size-3.5 text-muted-foreground" aria-hidden />;
  }
}

const STATUS_LABELS: Record<HealthStatus, string> = {
  ok: "ok",
  warn: "warning",
  fail: "problem",
  skip: "skipped",
};

function FixLine({ fix }: { readonly fix: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const segments = fixSegments(fix);
  const firstCommand = segments.find((segment) => segment.code)?.text ?? null;
  return (
    <span className="mt-1 flex items-start gap-1.5 text-foreground/80 text-xs">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {segments.map((segment, index) =>
          segment.code ? (
            <code
              key={`${index}:${segment.text}`}
              className="rounded bg-muted px-1 py-px font-mono text-[11px]"
            >
              {segment.text}
            </code>
          ) : (
            <span key={`${index}:${segment.text}`}>{segment.text}</span>
          ),
        )}
      </span>
      {firstCommand ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={isCopied ? "Copied" : `Copy ${firstCommand}`}
          onClick={() => copyToClipboard(firstCommand)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      ) : null}
    </span>
  );
}

function HealthRow({
  check,
  login,
}: {
  readonly check: HealthCheck;
  /** Set on a failed Claude login row the daemon can fix itself ("Log in to Claude"). */
  readonly login?: { readonly httpBaseUrl: string; readonly onLoggedIn: () => void } | undefined;
}) {
  return (
    <li
      data-health-check={check.id}
      data-status={check.status}
      className="flex items-start gap-3 px-3 py-2 text-sm"
    >
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
        <StatusIcon status={check.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">{check.label}</span>
        <span className="sr-only">, {STATUS_LABELS[check.status]}</span>
        <span
          className={cn(
            "block text-xs [overflow-wrap:anywhere]",
            check.status === "fail" || check.status === "warn"
              ? "text-foreground/80"
              : "text-muted-foreground",
          )}
        >
          {check.detail}
        </span>
        {check.fix && check.status !== "ok" ? <FixLine fix={check.fix} /> : null}
        {login && canLogInFromApp(check) ? (
          <ClaudeLoginButton httpBaseUrl={login.httpBaseUrl} onLoggedIn={login.onLoggedIn} />
        ) : null}
      </span>
    </li>
  );
}

/**
 * Settings → Diagnostics "Health check": the daemon's `kora doctor` rows (daemon, Claude Code and
 * its login, OpenCode, the graph index for a project, disk, ports, Swarm providers, local models),
 * each with its fix, plus "Export diagnostics" (a redacted bundle to ~/Downloads or a chosen
 * folder). Self-contained: it talks to `/api/doctor*` over plain HTTP, not the RPC contract.
 */
export function HealthCheckSection({ hostId }: { readonly hostId: HostId | null }) {
  const httpBaseUrl = useHostHttpBaseUrl(hostId);
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects
        .filter((project) => project.hostId === hostId)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [allProjects, hostId],
  );
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const cwd = projectRoot ?? projects[0]?.workspaceRoot ?? null;
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ path: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const runId = useRef(0);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const run = useCallback(
    async (probe: boolean) => {
      if (!httpBaseUrl) return;
      const id = ++runId.current;
      setRunning(true);
      setError(null);
      try {
        const next = await fetchHealthReport(httpBaseUrl, { cwd, probe });
        if (id === runId.current) setReport(next);
      } catch (cause) {
        if (id === runId.current) {
          setError(cause instanceof Error ? cause.message : "The health check failed.");
        }
      } finally {
        if (id === runId.current) setRunning(false);
      }
    },
    [cwd, httpBaseUrl],
  );

  // First look is quick (no provider probes); "Run again" re-tests the Swarm providers too.
  useEffect(() => {
    void run(false);
  }, [run]);

  async function exportBundle(chooseFolder: boolean) {
    if (!httpBaseUrl || exporting) return;
    let dir: string | null = null;
    if (chooseFolder) {
      dir = await localApiOrThrow()
        .dialogs.pickFolder()
        .catch(() => null);
      if (dir === null) return;
    }
    setExporting(true);
    setExportError(null);
    setExported(null);
    try {
      setExported(await exportDiagnostics(httpBaseUrl, { cwd, dir }));
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const shownReport = report
    ? checksForSurface(report, projectSurface(projects.find((p) => p.workspaceRoot === cwd)))
    : null;
  const summary = shownReport ? summarizeHealth(shownReport) : null;
  const canPickFolder = typeof window !== "undefined" && window.shellBridge !== undefined;

  const selectBlock =
    projects.length > 0 ? (
      <Select
        value={cwd ?? NO_PROJECT}
        onValueChange={(value) => {
          if (typeof value === "string") setProjectRoot(value === NO_PROJECT ? null : value);
        }}
      >
        <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Project to check">
          <SelectValue>
            {projects.find((project) => project.workspaceRoot === cwd)?.title ?? "Project"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} align="end">
          {projects.map(({ id, title, workspaceRoot }) => (
            <SelectItem hideIndicator value={workspaceRoot} key={id}>
              {title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : null;

  return (
    <PrefsSection
      id="health-check"
      title="Health check"
      variant="plain"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={running || !httpBaseUrl}
          onClick={() => void run(true)}
        >
          {running ? <Spinner className="size-3" /> : null}
          {running ? "Checking…" : "Run again"}
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
          <span
            role="status"
            className={cn(
              summary?.tone === "fail"
                ? "text-destructive"
                : summary?.tone === "warn"
                  ? "text-foreground/80"
                  : "text-muted-foreground",
            )}
          >
            {error ??
              summary?.text ??
              (running
                ? "Checking…"
                : httpBaseUrl
                  ? "Not checked yet"
                  : // No connection to the daemon: "Not checked yet" beside a disabled button read as broken.
                    "Kora's local service isn't reachable, so nothing can be checked. Quit and reopen Kora to start it again.")}
          </span>
          {selectBlock}
        </div>

        {report ? (
          <ul
            aria-label="Health checks"
            aria-busy={running}
            className="divide-y divide-border/50 overflow-hidden rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5"
          >
            {orderChecks(shownReport?.checks ?? report.checks).map((check) => (
              <HealthRow
                key={check.id}
                check={check}
                login={httpBaseUrl ? { httpBaseUrl, onLoggedIn: () => void run(false) } : undefined}
              />
            ))}
          </ul>
        ) : running ? (
          <div className="flex items-center gap-2 px-1 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Checking Kora, your agents and this project…
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 px-1">
          <Button
            size="xs"
            variant="outline"
            disabled={exporting || !httpBaseUrl}
            onClick={() => void exportBundle(false)}
          >
            <DownloadIcon />
            {exporting ? "Exporting…" : "Export diagnostics"}
          </Button>
          {canPickFolder ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={exporting || !httpBaseUrl}
              onClick={() => void exportBundle(true)}
            >
              <FolderIcon />
              Choose folder…
            </Button>
          ) : null}
          <span className="text-muted-foreground text-xs">
            Versions, these checks and recent Kora logs, with keys, tokens, emails and your home
            folder removed. Saved to Downloads unless you choose a folder.
          </span>
        </div>
        {exported ? (
          <p role="status" className="flex items-center gap-1.5 px-1 text-foreground/80 text-xs">
            <span className="min-w-0 [overflow-wrap:anywhere]">
              Saved <code className="font-mono text-[11px]">{exported.path}</code>. Read it before
              you share it.
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={isCopied ? "Copied" : "Copy the file path"}
              onClick={() => copyToClipboard(exported.path)}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </p>
        ) : null}
        {exportError ? (
          <p role="alert" className="px-1 text-destructive text-xs [overflow-wrap:anywhere]">
            {exportError}
          </p>
        ) : null}
      </div>
    </PrefsSection>
  );
}
