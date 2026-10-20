import { useProjectCommandPrefs } from "./useProjectCommandPrefs";
import { PrefsSection, PrefsRow } from "./prefsLayout";
import { ProjectActionsList } from "./ProjectActionsList";
import { usePrefsScope } from "./PrefsScopeContext";
import {
  MenuTrigger,
  MenuItem,
  MenuPopup,
  MenuGroupLabel,
  Menu,
  MenuGroup,
  MenuSeparator,
} from "../ui/menu";
import { Button } from "../ui/button";
import {
  EMPTY_PROJECT_COMMAND_INPUT,
  type ProjectCommandEditorRequest,
  ProjectCommandEditorDialog,
  editorRequestForScript,
  type NewProjectCommandInput,
  ScriptIcon,
} from "../projectCommandEditor";
import { useKoraProjectFileState } from "../../hooks/useKoraProjectFileScripts";
import { useHosts } from "../../atoms/hosts";
import type { ProjectAction, HostId } from "@kora/contracts";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { useState, useMemo } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";

const NO_HOST = "none" as HostId;

export function ProjectActionsPrefs() {
  const { scope, targets, target } = usePrefsScope();
  const { environments } = useHosts();
  const [request, setRequest] = useState<ProjectCommandEditorRequest | null>(null);

  const scripts: readonly ProjectAction[] = target?.settings.defaultProjectScripts ?? [];
  const representativeJson = JSON.stringify(scripts);
  const mixed = targets.some(
    (candidate) => JSON.stringify(candidate.settings.defaultProjectScripts) !== representativeJson,
  );

  const scopeMembers = scope.members;
  const hostEntries = useMemo(() => {
    const entries = [];
    for (const candidate of targets) {
      const config = environments.find((env) => env.hostId === candidate.hostId)?.daemonConfig;
      if (!config) continue;
      const member = scopeMembers.find((m) => m.id === candidate.projectId);
      // A server without override support would accept the record, report success and lose the edit.
      if (member && config.environment.capabilities.projectSettingsOverrides !== true) continue;
      entries.push({
        hostId: candidate.hostId,
        // Raw environment settings, so override entries are extended instead of derived from resolved values.
        settings: config.settings,
        ...(member ? { project: { id: member.id, scripts: member.scripts } } : {}),
      });
    }
    return entries;
  }, [environments, scopeMembers, targets]);

  const { saving, persist, submit } = useProjectCommandPrefs(hostEntries);

  const representativeMember =
    scope.members.find((member) => member.id === target?.projectId) ?? scope.members[0];
  const fileState = useKoraProjectFileState(
    representativeMember?.hostId ?? NO_HOST,
    representativeMember?.workspaceRoot ?? null,
  );
  const importable = fileState.scripts.filter(
    (fileScript) =>
      !scripts.some(
        (existing) =>
          existing.command === fileScript.command ||
          existing.name.toLowerCase() === fileScript.name.toLowerCase(),
      ),
  );

  const importScript = async (fileScript: (typeof importable)[number]) => {
    const runOnWorktreeCreate = fileScript.runOnWorktreeCreate ?? false;
    const previewUrl = fileScript.previewUrl ?? null;
    const payload: NewProjectCommandInput = {
      autoOpenPreview: previewUrl !== null ? (fileScript.autoOpenPreview ?? false) : false,
      waitForSetup: runOnWorktreeCreate && fileScript.async === false,
      icon: fileScript.icon ?? "play",
      command: fileScript.command,
      name: fileScript.name,
      runOnWorktreeCreate,
      previewUrl,
    };
    const result = await submit(null, payload);
    if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
      const cause = squashAtomActionFailure(result);
      setRequest({
        error: cause instanceof Error && cause.message ? cause.message : "Failed to import action.",
        initial: payload,
        scriptId: null,
      });
    }
  };

  return (
    <PrefsSection id="project-actions" title="Actions">
      <PrefsRow
        description="Commands that run in this project's checkout or its worktree."
        control={
          <div className="flex flex-wrap items-center gap-1.5">
            {importable.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button id="import-scripts" variant="ghost" size="xs" disabled={saving} />
                  }
                >
                  <span>Import scripts</span>
                  <ChevronDownIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" className="w-72">
                  <MenuGroup>
                    <MenuGroupLabel>Import from kora.json</MenuGroupLabel>
                    <p className="px-2 pb-2 text-sm text-pretty text-muted-foreground">
                      Add actions declared by this checkout without editing them first.
                    </p>
                    <MenuSeparator />
                    {importable.map((fileScript) => (
                      <MenuItem key={fileScript.name} onClick={() => void importScript(fileScript)}>
                        <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{fileScript.name}</span>
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {fileScript.command}
                          </span>
                        </span>
                      </MenuItem>
                    ))}
                  </MenuGroup>
                </MenuPopup>
              </Menu>
            ) : null}
            <Button
              variant="outline"
              size="xs"
              disabled={saving || targets.length === 0}
              onClick={() =>
                setRequest({ scriptId: null, initial: { ...EMPTY_PROJECT_COMMAND_INPUT } })
              }
            >
              <PlusIcon className="size-3.5" />
              Add action
            </Button>
          </div>
        }
        settingKeys={["defaultProjectScripts"]}
        serverScoped
        onResetOverride={() => void persist(() => null)}
        mixed={mixed}
        title="Actions"
      />
      {mixed ? (
        <PrefsRow
          description="Choose one environment to edit its list. Adding an action here adds it on every selected environment."
          title="Different actions across environments"
        />
      ) : (
        <ProjectActionsList
          onEdit={(script) => setRequest(editorRequestForScript(script))}
          scripts={scripts}
          disabled={saving}
        />
      )}
      {fileState.status === "invalid" ? (
        <PrefsRow
          title={<span className="text-warning">kora.json is invalid</span>}
          description="A kora.json exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values."
        />
      ) : null}
      <ProjectCommandEditorDialog
        request={request}
        onSubmit={submit}
        onDelete={(scriptId) =>
          void persist((current) => current.filter((script) => script.id !== scriptId))
        }
        onClose={() => setRequest(null)}
      />
    </PrefsSection>
  );
}
