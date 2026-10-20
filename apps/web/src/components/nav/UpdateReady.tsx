/**
 * "Restart to update": once the desktop app has downloaded a new version, a button sits at the bottom of the
 * sidebar until the user restarts (quitting Kora installs it too), and a toast says so once per version.
 */
import { RotateCwIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { restartToUpdate, useShellUpdateState } from "../../shellUpdates";
import { readLocalApi } from "../../localApi";
import { useThreadSummaries } from "../../atoms/entities";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function useRunningChatCount(): number {
  return useThreadSummaries().filter((shell) => shell.session?.status === "running").length;
}

/** Restarting stops running turns and their workers: say so first when anything is running. */
async function confirmAndRestart(runningChats: number): Promise<void> {
  const api = readLocalApi();
  if (runningChats > 0 && api) {
    const chats = runningChats === 1 ? "1 chat is" : `${runningChats} chats are`;
    const ok = await api.dialogs.confirm(
      `${chats} still working.\nRestarting stops them and any workers they started. Quitting Kora later installs the update too.`,
      { confirmLabel: "Restart now" },
    );
    if (!ok) return;
  }
  await restartToUpdate();
}

export function UpdateReadyButton() {
  const state = useShellUpdateState();
  const running = useRunningChatCount();
  if (state?.status !== "downloaded") return null;
  const version = state.downloadedVersion;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => void confirmAndRestart(running)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-sidebar-row-active px-2 text-[12px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-row-hover"
          >
            <RotateCwIcon className="size-3.5 shrink-0" />
            Restart to update
          </button>
        }
      />
      <TooltipPopup side="top">
        {version ? `Kora ${version} is ready.` : "An update is ready."} Running agents restart too;
        quitting Kora installs it as well.
      </TooltipPopup>
    </Tooltip>
  );
}

export function UpdateReadyToastCoordinator() {
  const state = useShellUpdateState();
  const running = useRunningChatCount();
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  const announced = useRef<string | null>(null);
  const version = state?.status === "downloaded" ? (state.downloadedVersion ?? "") : null;
  useEffect(() => {
    if (version === null || announced.current === version) return;
    announced.current = version;
    const toastId = toastManager.add({
      type: "info",
      title: version ? `Kora ${version} is ready` : "An update is ready",
      description: "Restart to finish updating. Running agents restart too.",
      data: { hideCopyButton: true },
      actionProps: {
        children: "Restart",
        onClick: () => {
          toastManager.close(toastId);
          void confirmAndRestart(runningRef.current);
        },
      },
    });
  }, [version]);
  return null;
}
