import type { HostThreadRef } from "@kora/contracts";
import { useEffect, useState } from "react";

import { canLogInFromApp } from "../../util/claudeLogin";
import { fetchHealthReport } from "../../util/healthCheck";
import { useHostHttpBaseUrl, usePrimaryHostId } from "../../atoms/hosts";
import { resolveThreadDetailRef, useThreadDetail, useThreadSummary } from "../../atoms/entities";
import { usePromptHandleContext } from "../../promptHandleContext";
import { ClaudeLoginButton } from "./ClaudeLoginButton";
import { forgetFirstRunChecks } from "./firstRunChecks";

/** One shared answer for every signed-out row on screen (each check spawns `claude`), re-asked after a while. */
const TTL_MS = 30_000;
let cached: { base: string; at: number; offer: Promise<boolean> } | null = null;
function offerLogin(base: string): Promise<boolean> {
  if (cached && cached.base === base && Date.now() - cached.at < TTL_MS) return cached.offer;
  const offer = fetchHealthReport(base, { only: ["claude-cli", "claude-auth"], probe: false }).then(
    (report) => report.checks.some(canLogInFromApp),
    () => false,
  );
  cached = { base, at: Date.now(), offer };
  return offer;
}

/**
 * Under a "Claude isn't signed in" reply: the Log in to Claude button, but only while the Mac is still signed out
 * (an old failed turn says nothing once the user has logged in) and only on daemons that can run the login. Once
 * signed in, the message that failed goes back into the (empty) composer, ready to send.
 */
export function SignedOutLoginAction({
  threadRef = null,
}: {
  readonly threadRef?: HostThreadRef | null;
}) {
  const hostId = usePrimaryHostId();
  const httpBaseUrl = useHostHttpBaseUrl(hostId);
  // A client-reserved draft id is not on the server yet: wait for its shell before asking for detail.
  const shell = useThreadSummary(threadRef);
  const thread = useThreadDetail(
    resolveThreadDetailRef(threadRef, { shellExists: shell !== null, waitForShell: true }),
  );
  const composerRef = usePromptHandleContext();
  const [offer, setOffer] = useState(false);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!httpBaseUrl) return;
    let live = true;
    void offerLogin(httpBaseUrl).then((yes) => {
      if (live) setOffer(yes);
    });
    return () => {
      live = false;
    };
  }, [httpBaseUrl]);
  if (!offer || !httpBaseUrl) return null;
  const lastRequest =
    thread?.messages.findLast((m) => m.role === "user" && m.text.trim().length > 0)?.text ?? null;
  return (
    <div data-signed-out-login className="mt-1">
      <ClaudeLoginButton
        httpBaseUrl={httpBaseUrl}
        doneText={
          restored
            ? "Signed in. Your message is back in the box: press Send."
            : "Signed in. Send your message again."
        }
        onLoggedIn={() => {
          cached = null;
          forgetFirstRunChecks();
          const composer = composerRef?.current ?? null;
          if (composer && lastRequest && composer.getSendContext().prompt.trim().length === 0) {
            if (composer.insertTextAtEnd(lastRequest)) {
              composer.focusAtEnd();
              setRestored(true);
            }
          }
        }}
      />
    </div>
  );
}
