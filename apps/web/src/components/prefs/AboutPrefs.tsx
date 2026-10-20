import { useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import { primaryDaemonConfigAtom } from "../../atoms/server";
import {
  checkForUpdates,
  describeUpdateStatus,
  reportBug,
  restartToUpdate,
  useShellUpdateState,
} from "../../shellUpdates";
import { useCopyToClipboard } from "../../hooks/useCopyText";
import { Button } from "../ui/button";
import { PrefsRow } from "./prefsLayout";
import { searchableSetting } from "./prefsSearch";
import { thisComputer, terminalAppName } from "../../util/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { cliPathProblem, useFirstRunChecks } from "../onboarding/firstRunChecks";
export function UpdatesPrefsRow() {
  const state = useShellUpdateState();
  const [pending, setPending] = useState(false);
  if (!state) return null;
  const { text, action, busy } = describeUpdateStatus(state);
  const run = (request: () => Promise<unknown>) => {
    setPending(true);
    void request().finally(() => setPending(false));
  };
  return (
    <PrefsRow
      {...searchableSetting("updates")}
      description={text}
      control={
        action === "restart" ? (
          <Button size="sm" onClick={() => run(restartToUpdate)} disabled={pending}>
            Restart to update
          </Button>
        ) : action === "check" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => run(checkForUpdates)}
            disabled={pending || busy}
          >
            {pending || busy ? "Checking…" : "Check now"}
          </Button>
        ) : null
      }
    />
  );
}

/** Settings → About: the bug form on GitHub (version filled in) and, in the app, the logs to attach to it. */
export function ReportBugPrefsRow() {
  const revealLogs = typeof window === "undefined" ? undefined : window.shellBridge?.revealLogs;
  return (
    <PrefsRow
      {...searchableSetting("report-bug")}
      description="Opens a bug report on GitHub with your Kora version filled in. If something broke, attach server.log from Show logs."
      control={
        <div className="flex shrink-0 gap-2">
          {revealLogs ? (
            <Button size="sm" variant="outline" onClick={() => void revealLogs()}>
              Show logs
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={reportBug}>
            Report a bug
          </Button>
        </div>
      }
    />
  );
}

/**
 * Settings → Diagnostics / About: PATH hint when ~/.local/bin is not on PATH.
 */
export function CliPathPrefsRow() {
  const { checks } = useFirstRunChecks();
  const cliPath = cliPathProblem(checks);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const cmd = "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.zshrc && source ~/.zshrc";

  if (!cliPath) return null;

  return (
    <PrefsRow
      title="Kora on PATH"
      description={
        <div className="space-y-1.5">
          <p>{cliPath.detail}</p>
          <code className="inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">
            {cmd}
          </code>
        </div>
      }
      control={
        <Button size="sm" variant="outline" onClick={() => copyToClipboard(cmd)}>
          {isCopied ? "Copied" : "Copy PATH command"}
        </Button>
      }
    />
  );
}

function UninstallDialog({
  open,
  onOpenChange,
  cli,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly cli: string;
}) {
  const stopCmd = `${cli} server stop`;
  const uninstallCmd = `${cli} uninstall`;
  const stopCopy = useCopyToClipboard();
  const uninstallCopy = useCopyToClipboard();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Uninstall Kora</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3 pt-2 text-start text-xs leading-5">
            <span className="block text-foreground">
              Uninstalling stops the background service and removes Kora's hooks, skills, and
              managed configurations from repositories.
            </span>
            <span className="block text-muted-foreground">
              To uninstall, quit Kora and run these two commands in {terminalAppName()}:
            </span>
            <div className="space-y-2 rounded-lg bg-muted/50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-[11px] text-foreground">{stopCmd}</code>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => stopCopy.copyToClipboard(stopCmd)}
                >
                  {stopCopy.isCopied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-[11px] text-foreground">{uninstallCmd}</code>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => uninstallCopy.copyToClipboard(uninstallCmd)}
                >
                  {uninstallCopy.isCopied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
            <span className="block text-muted-foreground">
              After running the commands, drag <strong>Kora.app</strong> from Applications to the
              Trash.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter variant="bare">
          <AlertDialogClose render={<Button variant="outline" />}>Close</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/**
 * Settings → General: why something keeps running after the window closes, and how to stop it. The service is what the
 * `kora` command, git hooks and Swarm workers talk to. Stopping it from inside the app would be undone by the app
 * (it restarts the service while it is open), so the stop is the terminal command, one click to copy.
 */
export function BackgroundServicePrefsRow() {
  const revealLogs = typeof window === "undefined" ? undefined : window.shellBridge?.revealLogs;
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  // Kora Dev's CLI is kora-dev: `kora server stop` there would stop the stable app's service instead.
  const cli = useAtomValue(primaryDaemonConfigAtom)?.environment.cliName ?? "kora";
  const stop = `${cli} server stop`;
  return (
    <>
      <PrefsRow
        title="Background service"
        description={`Kora runs a small service on ${thisComputer()} so the ${cli} command, git hooks and Swarm workers keep working after you close the window. To stop it, quit Kora and run ${stop} in ${terminalAppName()} (the app starts it again when it opens).`}
        control={
          <div className="flex shrink-0 gap-2" data-background-service>
            <Button size="sm" variant="outline" onClick={() => copyToClipboard(stop)}>
              {isCopied ? "Copied" : "Copy stop command"}
            </Button>
            {revealLogs ? (
              <Button size="sm" variant="outline" onClick={() => void revealLogs()}>
                Show logs
              </Button>
            ) : null}
          </div>
        }
      />
    </>
  );
}

/**
 * Settings → About: 'Uninstall Kora…' row with confirm dialog.
 */
export function UninstallPrefsRow() {
  const [open, setOpen] = useState(false);
  const cli = useAtomValue(primaryDaemonConfigAtom)?.environment.cliName ?? "kora";
  return (
    <>
      <PrefsRow
        title="Uninstall"
        description="Stop Kora's background service, remove hooks from repositories, and remove Kora from this Mac."
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Uninstall Kora…
          </Button>
        }
      />
      <UninstallDialog open={open} onOpenChange={setOpen} cli={cli} />
    </>
  );
}
