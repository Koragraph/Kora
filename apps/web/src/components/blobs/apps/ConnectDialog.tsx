// The sign-in step of connecting an app: Kora opens the app's own page in your browser; this says what is happening,
// keeps the link visible in case the browser did not come up, and flips to "Connected" by itself. Errors say what to do.

import { localApiOrThrow } from "~/localApi";
import { toastManager } from "~/components/ui/toast";
import type { ConnectPhase } from "./connectFlow";
import { errorCopy } from "./appsModel";
import { Spinner } from "../../ui/spinner";
import {
  DialogTitle,
  DialogPanel,
  DialogHeader,
  DialogDescription,
  DialogPopup,
  DialogFooter,
  Dialog,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { useState } from "react";
import { TriangleAlertIcon, ExternalLinkIcon, CheckIcon, CopyIcon } from "lucide-react";

export function ConnectDialog(props: {
  readonly phase: ConnectPhase;
  readonly appName: string;
  readonly onClose: () => void;
  /** Start over (a fresh link). */
  readonly onRetry: () => void;
  /** An error whose fix lives elsewhere ("byo-key" -> Settings). */
  readonly onSettings?: () => void;
}) {
  const { phase } = props;
  const open = phase.phase !== "idle";
  const [copied, setCopied] = useState(false);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: "Open the link instead.",
      });
    }
  };

  const connectedHeader =
    phase.phase === "connected" ? (
      <DialogHeader>
        <DialogTitle>{props.appName} is connected</DialogTitle>
        <DialogDescription>
          {phase.account.alias ? `Connected as ${phase.account.alias}. ` : ""}Blobs can use it only
          where you allow it.
        </DialogDescription>
      </DialogHeader>
    ) : null;

  const errorBodyBlock =
    phase.phase === "error" ? (
      <ErrorBody
        appName={props.appName}
        code={phase.code}
        message={phase.message}
        onRetry={props.onRetry}
        onClose={props.onClose}
        {...(props.onSettings ? { onSettings: props.onSettings } : {})}
      />
    ) : phase.phase === "connected" ? (
      <>
        {connectedHeader}
        <DialogPanel>
          <div className="flex items-center gap-2 text-[13px] text-foreground" data-connected-ok>
            <span className="grid size-6 place-items-center rounded-full bg-success/12 text-success-foreground">
              <CheckIcon className="size-3.5" aria-hidden />
            </span>
            Done. You can close this.
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button onClick={props.onClose} data-connect-done>
            Done
          </Button>
        </DialogFooter>
      </>
    ) : (
      <>
        <DialogHeader>
          <DialogTitle>Connect {props.appName}</DialogTitle>
          <DialogDescription>
            {phase.phase === "starting"
              ? "Getting a secure sign-in link…"
              : `Finish signing in to ${props.appName} in your browser. This window updates by itself.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div
            className="flex items-center gap-2 text-[13px] text-muted-foreground"
            aria-live="polite"
          >
            <Spinner className="size-4" />
            {phase.phase === "starting" ? "One moment" : "Waiting for you to finish in the browser"}
          </div>
          {phase.phase === "waiting" ? (
            <div
              className="space-y-1.5 rounded-xl bg-card p-3 ring-1 ring-border/70"
              data-connect-fallback
            >
              <p className="text-[12px] text-muted-foreground">Browser did not open?</p>
              <div className="flex flex-wrap items-center gap-1.5">
                <a
                  href={phase.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-connect-link
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-foreground ring-1 ring-border/80 transition-colors hover:bg-accent/60"
                  onClick={(e) => {
                    // inside the desktop app the system browser is the right place; elsewhere the anchor does it
                    if (window.shellBridge) {
                      e.preventDefault();
                      void localApiOrThrow()
                        .shell.openExternal(phase.url)
                        .catch(() => {});
                    }
                  }}
                >
                  Open the sign-in page <ExternalLinkIcon className="size-3.5" aria-hidden />
                </a>
                <Button size="xs" variant="ghost" onClick={() => void copy(phase.url)}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground/80">
                The link works for a few minutes and only once.
              </p>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} data-connect-cancel>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogPopup className="sm:max-w-md" data-connect-dialog={phase.phase}>
        {errorBodyBlock}
      </DialogPopup>
    </Dialog>
  );
}

function ErrorBody(props: {
  readonly appName: string;
  readonly code: string | null;
  readonly message: string;
  readonly onRetry: () => void;
  readonly onClose: () => void;
  readonly onSettings?: () => void;
}) {
  const copy = errorCopy(props.code, props.message);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{props.appName}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div
          className="flex items-start gap-2.5 text-[13px] leading-snug text-foreground/90"
          role="alert"
          data-connect-error={props.code ?? "error"}
        >
          <TriangleAlertIcon
            className="mt-0.5 size-4 shrink-0 text-warning-foreground"
            aria-hidden
          />
          <span>{copy.body}</span>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose}>
          Close
        </Button>
        {copy.action === "byo-key" || copy.action === "settings" || copy.action === "reconnect" ? (
          props.onSettings ? (
            <Button onClick={props.onSettings} data-connect-settings>
              Open Connections
            </Button>
          ) : null
        ) : copy.action === "retry" ? (
          <Button onClick={props.onRetry} data-connect-retry>
            Try again
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
