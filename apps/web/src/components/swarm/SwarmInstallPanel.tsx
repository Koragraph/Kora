/** Copy-only alternatives. Kora never runs these; the primary button downloads a pinned release. */

import { Spinner } from "../ui/spinner";
import { Button } from "../ui/button";
import { localApiOrThrow } from "../../localApi";
import { writeTextToClipboard } from "../../hooks/useCopyText";
import type { SwarmOpencodeStatus, SwarmInstallState } from "@kora/contracts";
import { useState } from "react";
import { ExternalLinkIcon, RotateCwIcon, CheckIcon, CopyIcon } from "lucide-react";

const MANUAL_COMMANDS = [
  {
    id: "brew",
    label: "Homebrew (recommended by OpenCode)",
    command: "brew install anomalyco/tap/opencode",
  },
  {
    id: "script",
    label: "Install script",
    command: "curl -fsSL https://opencode.ai/install | bash",
  },
  { id: "npm", label: "npm", command: "npm i -g opencode-ai" },
] as const;

const OPENCODE_DOCS_URL = "https://opencode.ai/docs";

const ACTIVE_PHASES = new Set<SwarmInstallState["phase"]>([
  "verifying",
  "extracting",
  "downloading",
]);

const PHASE_LABELS: Partial<Record<SwarmInstallState["phase"], string>> = {
  downloading: "Downloading OpenCode",
  extracting: "Unpacking OpenCode",
  verifying: "Checking that OpenCode runs",
};

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function ManualInstall({
  onCheckAgain,
  disabled,
}: {
  readonly onCheckAgain: () => void;
  readonly disabled: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="space-y-3" data-swarm-manual-install>
      <p className="text-muted-foreground text-xs">
        Prefer to install it yourself? Run one of these in a terminal, then click Check again.
      </p>
      <ul className="space-y-2">
        {MANUAL_COMMANDS.map((entry) => (
          <li key={entry.id} className="space-y-1">
            <span className="text-muted-foreground text-xs">{entry.label}</span>
            <div className="flex items-center gap-2 rounded-md bg-background px-2.5 py-1.5 ring-1 ring-black/5 dark:ring-white/5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {entry.command}
              </code>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Copy ${entry.label} command`}
                onClick={() => {
                  void writeTextToClipboard(entry.command, `${entry.label} command`)
                    .then(() => setCopied(entry.id))
                    .catch(() => setCopied(null));
                }}
              >
                {copied === entry.id ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        If you installed it in a terminal and Kora still can't find it, click Check again. Kora also
        looks in ~/.opencode/bin, Homebrew and npm global bin.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={disabled} onClick={onCheckAgain}>
          <RotateCwIcon />
          Check again
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void localApiOrThrow()
              .shell.openExternal(OPENCODE_DOCS_URL)
              .catch(() => {})
          }
        >
          OpenCode docs
          <ExternalLinkIcon />
        </Button>
      </div>
    </div>
  );
}

/** A download failure that reads like no network (fetch failed, DNS, refused, timed out). */
export function looksOffline(message: string | null): boolean {
  return (
    message !== null &&
    /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|timed? ?out|offline/i.test(
      message,
    )
  );
}

/**
 * OpenCode detection and install: found / not found / progress / failed. The primary action asks
 * the daemon to download a pinned OpenCode release (`swarm.install.start {confirm: true}`); the
 * brew / script / npm commands are shown only to copy.
 */
export function SwarmInstallPanel({
  opencode,
  install,
  pending = false,
  error = null,
  onInstall,
  onCancel,
  onCheckAgain,
}: {
  readonly opencode: SwarmOpencodeStatus;
  readonly install: SwarmInstallState;
  /** A command is in flight (install start, cancel or check again). */
  readonly pending?: boolean;
  /** The last command's failure, if any. */
  readonly error?: string | null;
  readonly onInstall: () => void;
  readonly onCancel: (operationId: string) => void;
  readonly onCheckAgain: () => void;
}) {
  const [showManual, setShowManual] = useState(false);
  const active = ACTIVE_PHASES.has(install.phase);
  const found = opencode.installed && opencode.versionOk;
  const versionLabel = install.version ?? null;
  const installLabel = `Download & install OpenCode${versionLabel ? ` ${versionLabel}` : ""}`;

  if (active) {
    const label = PHASE_LABELS[install.phase] ?? "Installing OpenCode";
    const hasTotal =
      install.phase === "downloading" && install.totalBytes !== null && install.totalBytes > 0;
    return (
      <div className="space-y-3" data-swarm-install-state="progress">
        <div className="flex items-center gap-2 text-sm">
          <Spinner className="size-4" />
          <span role="status" className="text-foreground">
            {label}
            {versionLabel ? ` ${versionLabel}` : ""}…
          </span>
        </div>
        <div className="h-1">
          {hasTotal ? (
            <progress
              aria-label="OpenCode download"
              className="block h-1 w-full accent-foreground"
              value={install.downloadedBytes}
              max={install.totalBytes ?? undefined}
            />
          ) : null}
        </div>
        {install.phase === "downloading" ? (
          <p className="text-muted-foreground text-xs tabular-nums">
            {megabytes(install.downloadedBytes)} MB
            {install.totalBytes !== null ? ` of ${megabytes(install.totalBytes)} MB` : ""}
          </p>
        ) : null}
        {install.message ? (
          <p className="text-muted-foreground text-xs">{install.message}</p>
        ) : null}
        {install.operationId ? (
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => install.operationId && onCancel(install.operationId)}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    );
  }

  if (found) {
    return (
      <div className="space-y-3" data-swarm-install-state="found">
        <div className="flex items-start gap-2 text-sm">
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <p className="min-w-0 text-foreground">
            OpenCode {opencode.version ?? ""} found
            {opencode.path ? (
              <>
                {" "}
                at{" "}
                <code className="font-mono text-xs [overflow-wrap:anywhere]">{opencode.path}</code>
              </>
            ) : null}
          </p>
        </div>
        {/* Kora's own copy lives in ~/.kora/tools by design: never on PATH, nothing to explain. */}
        {!opencode.onDaemonPath && opencode.source !== "kora" ? (
          <p className="text-muted-foreground text-xs">
            Found outside Kora's PATH; Kora will use the full path.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" disabled={pending} onClick={onCheckAgain}>
            <RotateCwIcon />
            Check again
          </Button>
          <Button size="xs" variant="ghost" disabled={pending} onClick={onInstall}>
            Reinstall
          </Button>
        </div>
      </div>
    );
  }

  const failed = install.phase === "failed";
  return (
    <div className="space-y-4" data-swarm-install-state={failed ? "failed" : "missing"}>
      {opencode.installed && !opencode.versionOk ? (
        <p className="text-foreground text-sm">
          OpenCode {opencode.version ?? ""} is too old. Kora needs {opencode.minVersion} or newer.
        </p>
      ) : (
        <p className="text-foreground text-sm">OpenCode isn't installed or Kora can't find it.</p>
      )}
      {failed ? (
        <div
          role="alert"
          className="space-y-1 rounded-md bg-destructive/8 px-3 py-2 text-sm dark:bg-destructive/16"
        >
          <p className="font-medium text-foreground">Install failed</p>
          <p className="text-foreground/80 text-xs [overflow-wrap:anywhere]">
            {install.message ?? "OpenCode could not be installed."}
          </p>
          {looksOffline(install.message) ? (
            <p className="text-foreground/80 text-xs">
              Kora couldn't reach GitHub. Check your internet connection (or VPN / proxy), then
              retry.
            </p>
          ) : null}
        </div>
      ) : install.phase === "cancelled" ? (
        <p className="text-muted-foreground text-xs">Install cancelled.</p>
      ) : null}
      <div className="space-y-1.5 text-xs text-muted-foreground" data-swarm-install-method>
        <p>
          <span className="font-medium text-foreground">What happens:</span> Kora downloads the
          official OpenCode{versionLabel ? ` ${versionLabel}` : ""} release for macOS from GitHub
          (github.com/anomalyco/opencode), unpacks it into ~/.kora/tools/opencode and checks that it
          runs.
        </p>
        <p>
          Nothing else changes: no shell files are edited, nothing is installed globally, no sudo.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={onInstall}>
          {failed ? "Retry" : installLabel}
        </Button>
        {failed ? (
          <Button size="sm" variant="outline" onClick={() => setShowManual(true)}>
            I'll install it myself
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showManual}
            onClick={() => setShowManual((open) => !open)}
          >
            Install it myself
          </Button>
        )}
      </div>
      {showManual ? <ManualInstall onCheckAgain={onCheckAgain} disabled={pending} /> : null}
    </div>
  );
}
