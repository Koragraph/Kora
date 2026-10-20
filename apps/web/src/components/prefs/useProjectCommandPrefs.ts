import { toastManager } from "../ui/toast";
import type { NewProjectCommandInput } from "../projectCommandEditor";
import { nextProjectCommandId, buildProjectCommand } from "../../workspace/projectCommandList";
import { useAtomAction } from "../../atoms/use-atom-command";
import { daemonHost } from "../../atoms/server";
import { useProjects } from "../../atoms/entities";
import { resolveProjectCommands } from "@kora/shared/projectCommands";
import { clearProjectPrefsOverrides } from "@kora/shared/projectPrefs";
import type { ProjectAction, DaemonPrefs, ProjectId, HostId } from "@kora/contracts";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import type { AtomActionResult } from "@kora/client-runtime/store/runtime";
import { useCallback, useState, useRef } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";

interface ScriptTarget {
  hostId: HostId;
  settings: DaemonPrefs;
  project?: { id: ProjectId; scripts: readonly ProjectAction[] };
}

type ScriptResult = AtomActionResult<void, unknown>;

export function useProjectCommandPrefs(targets: readonly ScriptTarget[]) {
  const updateSettings = useAtomAction(daemonHost.updateSettings, {
    label: "project actions update",
    reportFailure: false,
  });
  const projects = useProjects();
  const [saving, setSaving] = useState(false);
  const running = useRef(false);

  const persist = useCallback(
    async (
      transform: (current: readonly ProjectAction[]) => readonly ProjectAction[] | null,
    ): Promise<ScriptResult> => {
      if (running.current || targets.length === 0) {
        toastManager.add({
          type: "error",
          title: "Actions not saved",
          description: "No available machine, or another action change is saving.",
        });
        return AsyncResult.failure(
          Cause.fail(new Error("Actions were not saved.")),
        ) as ScriptResult;
      }
      running.current = true;
      setSaving(true);
      try {
        for (const target of targets) {
          const { project, settings } = target;
          const current = project
            ? resolveProjectCommands(settings, project)
            : settings.defaultProjectScripts;
          const next = transform(current);
          const patch = project
            ? {
                projectSettingsOverrides: {
                  [project.id]:
                    next === null
                      ? clearProjectPrefsOverrides(settings, project.id, ["defaultProjectScripts"])
                      : {
                          ...settings.projectSettingsOverrides?.[project.id],
                          defaultProjectScripts: next,
                        },
                },
              }
            : { defaultProjectScripts: next ?? [] };
          const result = await updateSettings({ hostId: target.hostId, input: { patch } } as never);
          if (result._tag === "Failure") {
            if (!isAtomActionInterrupted(result)) {
              const cause = squashAtomActionFailure(result);
              toastManager.add({
                description:
                  cause instanceof Error && cause.message ? cause.message : "An error occurred.",
                title: "Failed to save project actions",
                type: "error",
              });
            }
            return result as unknown as ScriptResult;
          }
        }
        return AsyncResult.success(undefined) as ScriptResult;
      } finally {
        running.current = false;
        setSaving(false);
      }
    },
    [targets, updateSettings],
  );

  const submit = useCallback(
    (scriptId: string | null, input: NewProjectCommandInput): Promise<ScriptResult> => {
      const existingIds = new Set<string>();
      for (const project of projects)
        for (const script of project.scripts) existingIds.add(script.id);
      for (const target of targets) {
        for (const script of target.settings.defaultProjectScripts) existingIds.add(script.id);
        for (const entry of Object.values(target.settings.projectSettingsOverrides ?? {})) {
          for (const script of entry?.defaultProjectScripts ?? []) existingIds.add(script.id);
        }
        for (const script of target.project?.scripts ?? []) existingIds.add(script.id);
      }
      const id = scriptId ?? nextProjectCommandId(input.name, [...existingIds]);
      const script = buildProjectCommand(id, input);
      return persist((current) => {
        const mapped = current.map((existing) => {
          if (existing.id === id) return script;
          // Only one script may run on worktree creation.
          return input.runOnWorktreeCreate && existing.runOnWorktreeCreate
            ? { ...existing, runOnWorktreeCreate: false }
            : existing;
        });
        return scriptId === null ? [...mapped, script] : mapped;
      });
    },
    [persist, projects, targets],
  );

  return { saving, persist, submit };
}
