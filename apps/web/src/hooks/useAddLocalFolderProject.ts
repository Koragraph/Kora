import { useCallback } from "react";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { hostProjectRef } from "@kora/client-runtime/host";

import { useStartThread } from "./useStartThread";
import { usePrimaryPrefs } from "./usePrefs";
import { newProjectId, thisComputer, exampleProjectPath } from "../util/utils";
import { inferProjectTitleFromPath } from "../util/projectPaths";
import { readLocalApi } from "../localApi";
import { toastManager } from "../components/ui/toast";
import { fetchGraphStatus } from "../components/onboarding/projectSetup";
import { useAtomAction } from "../atoms/use-atom-command";
import { projectHost } from "../atoms/projects";
import { useHostHttpBaseUrl, usePrimaryHostId } from "../atoms/hosts";

/** Shown when "Open project" runs without the desktop bridge and the browser cannot ask for a path. */
export const ADD_FOLDER_NEEDS_SHELL_TOAST = {
  type: "info",
  title: "Folders are added from the Kora desktop app",
  description:
    "The browser can't open the macOS folder picker. Type an absolute path (/Users/you/…), or add the folder from the Kora app.",
} as const;

export type AddFolderResult =
  | { readonly kind: "added" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The browser fallback for the folder picker: an absolute path typed by the user. `null` = cancelled
 * or left empty, `undefined` = this browser cannot ask (no `window.prompt`), or not an absolute path.
 */
function askFolderPath(baseDirectory = ""): string | null | undefined {
  if (typeof window.prompt !== "function") return undefined;
  // Settings › "New projects open from": prefill it when it is an absolute path (a browser can't expand ~).
  const base = baseDirectory.trim().replace(/\/+$/, "");
  let answer: string | null;
  try {
    answer = window.prompt(
      `Folder to open (absolute path on ${thisComputer()}, e.g. ${exampleProjectPath()})`,
      base.startsWith("/") ? `${base}/` : undefined,
    );
  } catch {
    // Some embedded browsers define prompt() but throw "not supported": same as having no prompt at all.
    return undefined;
  }
  if (answer === null) return null;
  const loc = answer.trim().replace(/\/+$/, "");
  if (!loc) return null;
  return loc.startsWith("/") ? loc : undefined;
}

/**
 * "Open project" = pick a folder (the native macOS picker; a typed path in a plain browser; or a `path` handed in, e.g.
 * a recent Claude Code folder on the first-run screen), add it as a project, then open a chat in it. Opening a project
 * NEVER starts an index: indexing only runs when the user asks (the graph chip / the chat's index line / the CLI).
 * A folder that does not exist is refused with a plain message instead of becoming a project that says "Folder
 * missing".
 */
export function useAddLocalFolderProject(): (loc?: string) => Promise<AddFolderResult> {
  const primaryHostId = usePrimaryHostId();
  const baseDirectory = usePrimaryPrefs((prefs) => prefs.addProjectBaseDirectory ?? "");
  const httpOrigin = useHostHttpBaseUrl(primaryHostId);
  const createProject = useAtomAction(projectHost.create, { reportFailure: false });
  const { openNewThread } = useStartThread();

  return useCallback(
    async (givenPath?: string): Promise<AddFolderResult> => {
      if (typeof window === "undefined" || primaryHostId == null) return { kind: "cancelled" };
      let picked: string | null = givenPath ?? null;
      if (picked === null) {
        if (window.shellBridge === undefined) {
          // A plain browser has no folder picker: ask for the path instead of doing nothing (the daemon
          // runs on this Mac, so a path typed here is the same folder the desktop picker would return).
          const typed = askFolderPath(baseDirectory);
          if (typed === undefined) {
            toastManager.add(ADD_FOLDER_NEEDS_SHELL_TOAST);
            return { kind: "cancelled" };
          }
          picked = typed;
        } else {
          const apiClient = readLocalApi();
          if (!apiClient) return { kind: "cancelled" };
          try {
            picked = await apiClient.dialogs.pickFolder(
              baseDirectory.trim() ? { initialPath: baseDirectory } : undefined,
            );
          } catch {
            return { kind: "cancelled" }; // user cancelled or the dialog failed
          }
        }
      }
      if (!picked) return { kind: "cancelled" };

      const phase = httpOrigin ? await fetchGraphStatus(httpOrigin, picked) : null;
      if (phase?.folderMissing) {
        const msg = `There is no folder at ${picked}. Check the path and try again.`;
        toastManager.add({
          type: "error",
          title: "Couldn't open that folder",
          description: msg,
        });
        return { kind: "failed", message: msg };
      }

      const projectId = newProjectId();
      const outcomeVal = await createProject({
        hostId: primaryHostId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(picked),
          workspaceRoot: picked,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (outcomeVal._tag === "Failure") {
        if (isAtomActionInterrupted(outcomeVal)) return { kind: "cancelled" };
        const fault = squashAtomActionFailure(outcomeVal);
        const msg =
          fault instanceof Error && fault.message
            ? fault.message
            : "Kora could not add this folder. Try again.";
        toastManager.add({
          type: "error",
          title: "Couldn't open that folder",
          description: msg,
        });
        return { kind: "failed", message: msg };
      }

      await openNewThread(hostProjectRef(primaryHostId, projectId));
      return { kind: "added" };
    },
    [primaryHostId, httpOrigin, createProject, openNewThread, baseDirectory],
  );
}
