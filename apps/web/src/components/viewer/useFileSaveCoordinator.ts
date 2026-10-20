import { useAtomAction } from "~/atoms/use-atom-command";
import { projectHost } from "~/atoms/projects";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import type { HostId } from "@kora/contracts";
import { createRef, useEffect, useMemo } from "react";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  onPendingChange: (relativePath: string, pending: boolean) => void;
  relativePath: string;
  hostId: HostId;
  cwd: string;
}

export function useFileSaveCoordinator({
  onPendingChange,
  relativePath,
  hostId,
  cwd,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> {
  const writeFile = useAtomAction(projectHost.writeFile);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    return {
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          persist: (nextContents) =>
            writeFile({
              hostId,
              input: { cwd, relativePath, contents: nextContents },
            }),
          onConfirmed: (confirmedContents) => {
            confirmProjectFileQueryData(hostId, cwd, relativePath, confirmedContents);
          },
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
        });
        coordinatorRef.current = coordinator;
        const teardown = () => {
          coordinator.dispose();
          coordinatorRef.current = null;
        };
        return teardown;
      },
      change: (contents: string) => coordinatorRef.current?.change(contents),
    };
  }, [cwd, hostId, onPendingChange, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}
