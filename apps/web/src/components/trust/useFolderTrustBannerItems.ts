import type { HostId } from "@kora/contracts";
import { ShieldQuestionIcon } from "lucide-react";
import { createElement, Fragment, useCallback, useState } from "react";

import { useHostQuery } from "../../atoms/query";
import { useAtomAction } from "../../atoms/use-atom-command";
import type { PromptBannerStackItem } from "../thread/PromptBannerStack";
import { Button } from "../ui/button";
import {
  shouldShowTrustPrompt,
  TRUST_PROMPT_DESCRIPTION,
  TRUST_PROMPT_TITLE,
} from "./folderTrust.logic";
import { trustHost } from "./trustAtoms";

const FOLDER_TRUST_BANNER_ID = "folder-trust";
const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const DISMISSED_KEY = "kora.folderTrust.notNow";

/** "Not now" holds for this app session (and survives a reload); the daemon keeps the folder restricted meanwhile. */
const dismissed = new Set<string>(
  (() => {
    try {
      const raw = window.sessionStorage.getItem(DISMISSED_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  })(),
);
function remember(root: string): void {
  dismissed.add(root);
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch {
    /* storage unavailable: in-memory only */
  }
}

export interface FolderTrustBannerInput {
  readonly hostId: HostId | null;
  /** The thread's (or draft's) folder; null when there is none. */
  readonly cwd: string | null;
  readonly isAssistantLane: boolean;
}

/**
 * The composer's "Trust this folder?" prompt (PromptBannerStack item). Shown while the active thread or draft sits in
 * a folder the user has not trusted — i.e. before the first chat or agent there runs anything from the repository.
 * Trust: the daemon records it and restarts a live session at its next turn with the folder's own settings.
 * Not now: chatting continues in restricted mode.
 */
export function useFolderTrustBannerItems(
  input: FolderTrustBannerInput,
): ReadonlyArray<PromptBannerStackItem> {
  const target =
    input.hostId !== null && input.cwd && !input.isAssistantLane
      ? trustHost.status({ hostId: input.hostId, input: { cwd: input.cwd } })
      : null;
  const query = useHostQuery(target);
  const setTrust = useAtomAction(trustHost.set, COMMAND_OPTIONS);
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = query.data;
  const { refresh } = query;

  const trust = useCallback(async () => {
    if (input.hostId === null || !input.cwd || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setTrust({
        hostId: input.hostId,
        input: { cwd: input.cwd, trusted: true },
      });
      if (result._tag === "Failure") setError("Could not trust this folder.");
    } catch {
      setError("Could not trust this folder.");
    } finally {
      setBusy(false);
      refresh();
    }
  }, [busy, input.cwd, input.hostId, refresh, setTrust]);

  const notNow = useCallback(() => {
    if (status) remember(status.root);
    bump((n) => n + 1);
  }, [status]);

  if (
    !shouldShowTrustPrompt({
      status,
      isAssistantLane: input.isAssistantLane,
      dismissedRoots: dismissed,
    })
  ) {
    return [];
  }
  return [
    {
      id: FOLDER_TRUST_BANNER_ID,
      variant: "warning",
      icon: createElement(ShieldQuestionIcon),
      title: TRUST_PROMPT_TITLE,
      description: error ?? TRUST_PROMPT_DESCRIPTION,
      actions: createElement(
        Fragment,
        null,
        createElement(
          Button,
          {
            key: "trust",
            size: "xs",
            variant: "default",
            disabled: busy,
            onClick: () => void trust(),
          },
          busy ? "Trusting…" : "Trust",
        ),
        createElement(
          Button,
          {
            key: "not-now",
            size: "xs",
            variant: "ghost",
            onClick: notNow,
          },
          "Not now",
        ),
      ),
    },
  ];
}
