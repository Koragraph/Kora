import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { SWARM_PRIVACY_NOTICE_VERSION, type HostId, type SwarmStatus } from "@kora/contracts";
import { BotIcon, FileTextIcon, HexagonIcon } from "lucide-react";
import { useState } from "react";

import { swarmWorkerBackendLabel } from "../../util/swarm";
import { swarmHost } from "../../atoms/swarm";
import { useAtomAction } from "../../atoms/use-atom-command";
import { SwarmPrivacyNotice } from "./SwarmPrivacyNotice";

/**
 * The assistant lane has no git/worktree/merge — workers there read and research in their own
 * scratch folder and hand results back for the lead to check, not code that merges anywhere.
 */
const howItWorks = (backend: string, isAssistantLane: boolean) =>
  [
    {
      icon: BotIcon,
      title: "Your agent leads",
      body: "Your lead agent — Claude, Codex or OpenCode — on your own plan, plans the task, hands out the legwork and reviews every result.",
    },
    {
      icon: HexagonIcon,
      title: "Workers do the legwork",
      body: isAssistantLane
        ? `${backend} workers on free, cheap or local models each read and research in their own scratch folder, in a pane you can watch and steer.`
        : `${backend} workers on free, cheap or local models each work in their own git worktree, in a pane you can watch and steer.`,
    },
    {
      icon: FileTextIcon,
      title: "Results are checked",
      body: isAssistantLane
        ? "Each worker reports back and your lead agent checks its results before using them. Swarm pays off on big, mechanical or parallel work; on a small ask your lead agent alone is quicker."
        : "Each worker reports back and Kora checks its changes before they merge. Swarm pays off on big, mechanical or parallel work; on a small fix your lead agent alone is quicker.",
    },
  ] as const;

/** Step 1: how Swarm works, then the privacy notice with its required consent. */
export function SwarmIntroStep({
  hostId,
  status,
  isAssistantLane = false,
}: {
  readonly hostId: HostId;
  readonly status: SwarmStatus;
  /** assistant-lane workers read/research in a scratch folder, never git/code — see `howItWorks`. */
  readonly isAssistantLane?: boolean;
}) {
  const setConsent = useAtomAction(swarmHost.setConsent, {
    reportFailure: false,
    reportDefect: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeConsent(accepted: boolean) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await setConsent({
        hostId,
        input: { noticeVersion: SWARM_PRIVACY_NOTICE_VERSION, accepted },
      });
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        const failure = squashAtomActionFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not save your choice.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {howItWorks(swarmWorkerBackendLabel(status), isAssistantLane).map(
          ({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3 text-sm">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="font-medium text-foreground">{title}.</span>{" "}
                <span className="text-muted-foreground">{body}</span>
              </span>
            </li>
          ),
        )}
      </ul>
      <SwarmPrivacyNotice
        consent={status.consent}
        pending={pending}
        isAssistantLane={isAssistantLane}
        onAcceptedChange={(accepted) => void changeConsent(accepted)}
      />
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
