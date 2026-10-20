import { usePrefsProjectGroups } from "./usePrefsProjectGroups";
import { findProjectGroup } from "./prefsScope";
import { PrefsPageContainer, SettingResetButton, PrefsSection, PrefsRow } from "./prefsLayout";
import { projectGroupTitleNeedsUpdate } from "./ProjectPrefsPanel.logic";
import { ProjectActionsPrefs } from "./ProjectActionsPrefs";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { ProjectFavicon } from "../ProjectIcon";
import { cn } from "../../util/utils";
import { usePromptDraftStore } from "../../stores/promptDraftStore";
import type { NavProjectGroupMember, NavProjectSnapshot } from "../../navProjectGrouping";
import { readLocalApi } from "../../localApi";
import { useAtomAction } from "../../atoms/use-atom-command";
import { projectHost } from "../../atoms/projects";
import { useHosts } from "../../atoms/hosts";
import { useThreadSummaries } from "../../atoms/entities";
import type { ProjectIconOverride, HostId } from "@kora/contracts";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { hostProjectRef } from "@kora/client-runtime/host";
import { useEffect, Suspense, useState, useRef, lazy } from "react";
import { Trash2Icon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { refreshArchivedThreadsForHost } from "../../util/archivedThreadsState";

const ProjectIconPicker = lazy(() =>
  import("./ProjectIconPicker").then((mod) => ({ default: mod.ProjectIconPicker })),
);

export type ProjectPrefsCategory = "general";

interface RememberedSelection {
  projectKey: string;
  hostId: HostId | null;
  checkoutKey: string | null;
  memberKeys: string[];
}

const projectPrefsPanelCls1 =
  "flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground";

export function ProjectPrefsPanel(props: {
  projectKey: string;
  hostId?: HostId | null;
  checkoutKey?: string | null;
}) {
  const { projectKey, hostId = null, checkoutKey = null } = props;
  const navigate = useNavigate();
  const groups = usePrefsProjectGroups();
  const selected = findProjectGroup(groups, projectKey);
  const members = (selected?.memberProjects ?? []).filter(
    (member) =>
      (hostId === null || member.hostId === hostId) &&
      (checkoutKey === null || member.physicalProjectKey === checkoutKey),
  );
  const remembered = useRef<RememberedSelection | null>(null);

  // When a grouping rule change replaces the project key, follow the remembered checkouts to their new group.
  useEffect(() => {
    if (members.length > 0) {
      remembered.current = {
        projectKey,
        hostId,
        checkoutKey,
        memberKeys: members.map((member) => member.physicalProjectKey),
      };
      return;
    }
    const last = remembered.current;
    const sameTarget =
      last !== null &&
      last.projectKey === projectKey &&
      last.hostId === hostId &&
      last.checkoutKey === checkoutKey;
    if (!sameTarget) {
      return;
    }
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (!successor) return;
    void navigate({
      search: {
        project: successor.projectKey,
        machine: hostId ?? undefined,
        checkout: checkoutKey ?? undefined,
      } as never,
      hashScrollIntoView: false,
      replace: true,
      to: ".",
    });
  });

  if (!selected) {
    return (
      <div className={projectPrefsPanelCls1}>
        {groups.length > 0
          ? "This project is no longer available."
          : "Add a project from the sidebar to configure it here."}
      </div>
    );
  }
  if (members.length === 0) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This checkout is no longer available in the selected project and environment.
      </p>
    );
  }

  const scopedGroup: NavProjectSnapshot = { ...selected, memberProjects: members };
  return (
    <ProjectDetail
      hasOtherMembers={members.length < selected.memberProjects.length}
      key={`${projectKey}:${hostId ?? "all"}:${checkoutKey ?? "all"}`}
      group={scopedGroup}
    />
  );
}

function ProjectDetail({
  hasOtherMembers,
  group,
}: {
  group: NavProjectSnapshot;
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate();
  const { environments } = useHosts();
  const threads = useThreadSummaries();
  const updateProject = useAtomAction(projectHost.update, { reportFailure: false });
  const deleteProject = useAtomAction(projectHost.delete, { reportFailure: false });
  const members = group.memberProjects;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [nameEdited, setNameEdited] = useState(false);

  const representative =
    members.find(
      (member) => environments.find((env) => env.hostId === member.hostId)?.daemonConfig,
    ) ?? members[0]!;
  const hostLabel = (hostId: HostId) =>
    environments.find((env) => env.hostId === hostId)?.label ?? null;

  const report = (title: string, cause: unknown, member?: NavProjectGroupMember) => {
    const suffix =
      members.length > 1
        ? ` on ${(member && hostLabel(member.hostId)) ?? "the current environment"}`
        : "";
    toastManager.add({
      type: "error",
      title: `${title}${suffix}`,
      description: cause instanceof Error && cause.message ? cause.message : "An error occurred.",
    });
  };

  /** Applies the same change to every member, one host at a time; the first failure stops it. */
  const updateAllMembers = async (
    fields: Record<string, unknown>,
    failureTitle: string,
  ): Promise<boolean> => {
    for (const member of members) {
      const env = environments.find((entry) => entry.hostId === member.hostId);
      if (!env || env.connection.phase !== "connected" || !env.daemonConfig) {
        toastManager.add({
          description: `Connect ${env?.label ?? "the selected environment"} and try again.`,
          title: failureTitle,
          type: "error",
        });
        return false;
      }
    }
    for (const member of members) {
      const result = await updateProject({
        hostId: member.hostId,
        input: { projectId: member.id, ...fields },
      } as never);
      if (result._tag === "Failure") {
        if (!isAtomActionInterrupted(result))
          report(failureTitle, squashAtomActionFailure(result), member);
        return false;
      }
    }
    return true;
  };

  const rename = async (value: string) => {
    const title = value.trim();
    if (title === "") {
      toastManager.add({ type: "warning", title: "Project title cannot be empty" });
      return;
    }
    if (
      !projectGroupTitleNeedsUpdate(
        members.map((member) => member.title),
        title,
        nameEdited,
      )
    )
      return;
    await updateAllMembers({ title }, "Failed to rename project");
    setNameEdited(false);
  };

  const saveIcon = async (icon: ProjectIconOverride | null) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await updateAllMembers(
        { faviconPath: null, projectIcon: icon },
        "Failed to update project icon",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const removeMembers = async (targets: readonly NavProjectGroupMember[]) => {
    const api = readLocalApi();
    if (!api) return;
    const targetIds = new Set(targets.map((member) => `${member.hostId}:${member.id}`));
    const threadCount = threads.filter((thread) =>
      targetIds.has(`${thread.hostId}:${thread.projectId}`),
    ).length;
    const wholeGroup = targets.length === members.length && !hasOtherMembers;
    const kind = hasOtherMembers || !wholeGroup ? "checkout" : "project";
    const label = targets.length === 1 ? targets[0]!.title : group.displayName;
    const chats = `${threadCount} chat${threadCount === 1 ? "" : "s"}`;
    // What goes, which folder it is, and that the files stay. The button names the cost.
    const lines = [
      threadCount > 0
        ? `Remove ${kind} "${label}" and permanently delete its ${chats} (archived ones too)?`
        : `Remove ${kind} "${label}" and delete any archived chats?`,
      ...(targets.length === 1 ? [`Path: ${targets[0]!.workspaceRoot}`] : []),
      wholeGroup
        ? "Files on disk stay. This can't be undone."
        : "Other entries in this project stay. Files on disk stay. This can't be undone.",
    ];
    const confirmLabel = threadCount > 0 ? `Remove and delete ${chats}` : "Remove";
    if (!(await api.dialogs.confirm(lines.join("\n"), { variant: "destructive", confirmLabel })))
      return;

    for (const member of targets) {
      const result = await deleteProject({
        hostId: member.hostId,
        input: { projectId: member.id, force: true },
      } as never);
      if (result._tag === "Failure") {
        const cause = squashAtomActionFailure(result);
        toastManager.add({
          title: `Failed to remove "${member.title}"`,
          description:
            cause instanceof Error && cause.message ? cause.message : "An error occurred.",
          type: "error",
        });
        return;
      }
      usePromptDraftStore
        .getState()
        .clearProjectDraftThreadId(hostProjectRef(member.hostId, member.id));
      // Its archived threads went with it: the sidebar's "Archived (N)" must not keep counting them.
      refreshArchivedThreadsForHost(member.hostId);
    }
    if (wholeGroup) void navigate({ to: "/", replace: true });
  };

  const icon = members.find((member) => member.projectIcon)?.projectIcon ?? null;
  const hasOverride = members.some((member) => member.faviconPath || member.projectIcon);
  const iconLabel =
    icon?.kind === "lucide"
      ? `${icon.monogram ?? icon.name} · ${icon.color}`
      : icon?.kind === "emoji"
        ? icon.emoji
        : "automatic";

  let removalExplanation =
    "Deletes the project entry and its chats, and takes out what Kora added to the folder (its CLAUDE.md and AGENTS.md block, hook entries and folder trust). Your own files are not touched.";
  if (members.length > 1) {
    removalExplanation = `Deletes all ${members.length} checkout entries and their threads on every machine, and takes out what Kora added to the folder (its CLAUDE.md and AGENTS.md block, hook entries and folder trust). Your own files are not touched.`;
  }
  if (hasOtherMembers) {
    removalExplanation =
      "Deletes the selected machine's checkout entries and their chats. Other machines and files on disk are not touched.";
  }

  return (
    <PrefsPageContainer className="gap-6">
      <PrefsSection id="project-overview" title="Project" hideTitle variant="plain">
        <div className="flex items-center gap-4 rounded-lg bg-card p-4 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5">
          <div className="relative">
            <button
              type="button"
              aria-label="Choose a project icon"
              disabled={saving}
              className="group grid size-14 place-items-center rounded-xl bg-background ring-1 ring-border transition-colors hover:ring-foreground/30 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              onClick={() => setPickerOpen(true)}
            >
              <ProjectFavicon project={representative} className="size-8" />
              <span className="absolute -bottom-5 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
                Change
              </span>
            </button>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div
              className={cn(
                "-ml-2 w-full rounded-md border border-transparent hover:border-border focus-within:border-border focus-within:bg-background",
              )}
            >
              <input
                key={group.displayName}
                aria-label="Project name"
                defaultValue={group.displayName}
                className="h-8 w-full bg-transparent px-2 text-lg leading-8 font-semibold tracking-tight text-foreground outline-none"
                onChange={() => setNameEdited(true)}
                onBlur={(event) => void rename(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {representative.workspaceRoot}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Icon: {iconLabel}</span>
              {hasOverride ? (
                <SettingResetButton
                  label="project icon"
                  disabled={saving}
                  onClick={() => void saveIcon(null)}
                />
              ) : null}
            </div>
          </div>
        </div>
      </PrefsSection>

      {pickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPicker
            current={icon}
            projectName={group.displayName}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSelect={(next) => void saveIcon(next)}
          />
        </Suspense>
      ) : null}

      <ProjectActionsPrefs />

      {members.length > 1 ? (
        <PrefsSection title="Checkouts">
          {members.map((member) => (
            <PrefsRow
              key={`${member.hostId}:${member.id}`}
              title={hostLabel(member.hostId) ?? "Environment"}
              description={member.workspaceRoot}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Remove checkout ${member.workspaceRoot}`}
                  onClick={() => void removeMembers([member])}
                >
                  Remove
                </Button>
              }
            />
          ))}
        </PrefsSection>
      ) : null}

      <PrefsSection title="Remove">
        <PrefsRow
          title={
            hasOtherMembers
              ? "Remove checkout"
              : members.length > 1
                ? "Remove this project everywhere"
                : "Remove project"
          }
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              onClick={() => void removeMembers(members)}
            >
              <Trash2Icon className="size-4" />
              {hasOtherMembers
                ? "Remove checkout"
                : members.length > 1
                  ? "Remove all entries"
                  : "Remove project"}
            </Button>
          }
          description={removalExplanation}
        />
      </PrefsSection>
    </PrefsPageContainer>
  );
}
