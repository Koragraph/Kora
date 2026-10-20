import type { SwarmConsentState } from "@kora/contracts";
import { ShieldAlertIcon } from "lucide-react";
import { useId } from "react";

import { Checkbox } from "../ui/checkbox";

/** The approved notice (SWARM_PRIVACY_NOTICE_VERSION): Code surface, assistant lane, and what accepting means. */
export const SWARM_PRIVACY_TEXT =
  "Free models are free because providers may log your prompts and code and use them to train models. Anything a worker sees (files in its worktree, your task text) may leave your machine to that provider. Don't use Swarm on code you can't share.";
export const SWARM_PRIVACY_TEXT_ASSISTANT =
  "Free models are free because providers may log your prompts and anything a worker reads (files you gave it, web pages, your task text) and use them to train models. That may leave your machine to that provider. Don't use Swarm on anything you can't share.";
export const SWARM_CONSENT_TEXT =
  "I understand free-model providers may store and train on what workers send.";

/**
 * The Swarm privacy notice (copy approved as SWARM_PRIVACY_NOTICE_VERSION; bump that version when
 * this text changes so everyone is asked again) and its consent checkbox. The checkbox reflects the
 * daemon's stored consent; toggling it asks the caller to persist `accepted`.
 */
export function SwarmPrivacyNotice({
  consent,
  pending = false,
  isAssistantLane = false,
  onAcceptedChange,
}: {
  readonly consent: SwarmConsentState;
  readonly pending?: boolean;
  /** assistant-lane workers read files/web pages/task text, not a git worktree — see the body copy. */
  readonly isAssistantLane?: boolean;
  readonly onAcceptedChange: (accepted: boolean) => void;
}) {
  const checkboxId = useId();
  const accepted =
    consent.acceptedVersion !== null && consent.acceptedVersion >= consent.requiredVersion;
  const askedAgain = !accepted && consent.acceptedVersion !== null;
  return (
    <div className="space-y-3 rounded-lg bg-card p-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5">
      <div className="flex gap-2.5">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-1.5 text-sm">
          <p className="font-medium text-foreground">Privacy</p>
          <p className="text-muted-foreground" data-swarm-privacy-notice>
            {isAssistantLane ? SWARM_PRIVACY_TEXT_ASSISTANT : SWARM_PRIVACY_TEXT}
          </p>
          {askedAgain ? (
            <p className="text-foreground/80">
              This notice changed since you last accepted it. Read it and accept again to keep using
              Swarm.
            </p>
          ) : null}
        </div>
      </div>
      <label htmlFor={checkboxId} className="flex cursor-pointer items-start gap-2.5 text-sm">
        <Checkbox
          id={checkboxId}
          className="mt-0.5"
          checked={accepted}
          disabled={pending}
          onCheckedChange={(checked) => onAcceptedChange(checked === true)}
        />
        <span className="text-foreground">{SWARM_CONSENT_TEXT}</span>
      </label>
    </div>
  );
}
