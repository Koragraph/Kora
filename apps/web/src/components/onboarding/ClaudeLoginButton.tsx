import { ExternalLinkIcon, LogInIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  claudeLoginAction,
  fetchClaudeLoginState,
  type ClaudeLoginState,
} from "../../util/claudeLogin";
import { localApiOrThrow } from "../../localApi";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

const POLL_MS = 1500;

/**
 * "Log in to Claude": the daemon runs `claude auth login` (no Claude Code install needed — Kora's bundled copy works),
 * which opens the browser. While it waits this shows the sign-in page link (in case no browser opened) and a field
 * for the code the page shows when the automatic return does not work. `onLoggedIn` re-runs the health check.
 */
export function ClaudeLoginButton({
  httpBaseUrl,
  onLoggedIn,
  doneText = "Signed in. Checking again…",
  size = "xs",
}: {
  readonly httpBaseUrl: string;
  readonly onLoggedIn: () => void;
  /** What the settled "done" state says (the timeline asks the user to send again). */
  readonly doneText?: string;
  /** "sm" where it is the main action of the screen (the first-run welcome). */
  readonly size?: "xs" | "sm";
}) {
  const [state, setState] = useState<ClaudeLoginState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const onLoggedInRef = useRef(onLoggedIn);
  onLoggedInRef.current = onLoggedIn;
  const waiting = state?.phase === "waiting";
  // A closed browser tab leaves the login waiting forever: after two minutes, say what to do.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setSlow(true), 120_000);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [waiting]);

  // A reload (or another card mounting) while the daemon is still waiting on the browser sign-in: pick that login
  // back up instead of offering a fresh "Sign in" that would restart it. Only "waiting" resumes; an old done/failed
  // phase from earlier says nothing about now.
  useEffect(() => {
    let cancelled = false;
    fetchClaudeLoginState(httpBaseUrl).then(
      (current) => {
        if (!cancelled && current.phase === "waiting") setState(current);
      },
      () => {
        /* an older daemon without the route: the button stays as is */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [httpBaseUrl]);

  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      fetchClaudeLoginState(httpBaseUrl).then(
        (next) => {
          if (cancelled) return;
          setState(next);
          if (next.phase === "done") onLoggedInRef.current();
        },
        () => {
          /* the daemon restarting: keep waiting, the next poll answers */
        },
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [httpBaseUrl, waiting]);

  async function act(body: Parameters<typeof claudeLoginAction>[1]) {
    setBusy(true);
    setError(null);
    try {
      const next = await claudeLoginAction(httpBaseUrl, body);
      setState(next);
      if (next.phase === "done") onLoggedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The login did not start.");
    } finally {
      setBusy(false);
    }
  }

  function submitCode(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    void act({ action: "code", code });
    setCode("");
  }

  if (waiting) {
    return (
      <div data-claude-login="waiting" className="mt-1.5 space-y-1.5 text-xs" aria-live="polite">
        <p className="flex items-center gap-1.5 text-foreground">
          <Spinner className="size-3.5" aria-hidden />
          Finish signing in in your browser, then come back here.
        </p>
        {slow ? (
          <p data-claude-login="slow" className="text-muted-foreground">
            Still waiting? Open the sign-in page again, or Cancel and start over.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {state?.url ? (
            <button
              type="button"
              data-claude-login="open-page"
              onClick={() =>
                void localApiOrThrow()
                  .shell.openExternal(state.url ?? "")
                  .catch(() => {})
              }
              className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              No browser opened? Open the sign-in page
              <ExternalLinkIcon className="size-3" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            data-claude-login="cancel"
            onClick={() => void act({ action: "cancel" })}
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Cancel
          </button>
        </div>
        <form onSubmit={submitCode} className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor="claude-login-code">
            Code from the sign-in page
          </label>
          <input
            id="claude-login-code"
            data-claude-login="code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Page shows a code? Paste it here"
            autoComplete="off"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded-md bg-muted px-2 font-mono text-[11px] text-foreground placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button size="xs" variant="outline" type="submit" disabled={!code.trim() || busy}>
            Submit
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="mt-1.5 space-y-1 text-xs">
      <Button
        size={size}
        data-claude-login="start"
        disabled={busy}
        onClick={() => void act({ action: "start" })}
      >
        {busy ? <Spinner className="size-3.5" aria-hidden /> : <LogInIcon aria-hidden />}
        Sign in to Claude
      </Button>
      {state?.phase === "done" ? (
        <p data-claude-login="done" className="text-muted-foreground">
          {doneText}
        </p>
      ) : null}
      {state?.phase === "failed" || error ? (
        <p data-claude-login="failed" role="alert" className="text-destructive">
          {error ?? state?.message ?? "The login did not finish. Try again."}
        </p>
      ) : null}
    </div>
  );
}
