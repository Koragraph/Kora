/** Offer an explicit target change when a category has no settings at this scope. */

import { usePrefsProjectGroups } from "./usePrefsProjectGroups";
import type { PrefsScopeSearch } from "./prefsScope";
import { PrefsPageContainer } from "./prefsLayout";
import { usePrefsScope } from "./PrefsScopeContext";
import { Button } from "../ui/button";
import { AlertDescription, AlertAction, Alert } from "../ui/alert";
import { useHosts } from "../../atoms/hosts";
import { useLocation, useNavigate } from "@tanstack/react-router";

export function PrefsScopeNotice({
  children,
  target,
  targetId,
}: {
  target: "environment" | "all" | "project" | "checkout";
  targetId?: string;
  children: string;
}) {
  const { selectScope, search } = usePrefsScope();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useHosts();
  const groups = usePrefsProjectGroups();
  const choices: { label: string; search: PrefsScopeSearch }[] =
    target === "checkout"
      ? groups
          .filter(
            (group) =>
              search.project === undefined ||
              group.projectKey === search.project ||
              search.project === "",
          )
          .flatMap((group) =>
            group.memberProjects.map((member) => ({
              search: {
                project: group.projectKey,
                machine: member.hostId,
                checkout: member.physicalProjectKey,
              },
              label: `${group.displayName} · ${member.hostLabel ?? "Environment"} · ${member.workspaceRoot}`,
            })),
          )
      : target === "project"
        ? groups.map((group) => ({
            search: { project: group.projectKey },
            label: group.displayName,
          }))
        : target === "environment"
          ? environments.map((entry) => ({
              label: environments.some(
                (other) => other.hostId !== entry.hostId && other.label === entry.label,
              )
                ? `${entry.label} · ${entry.displayUrl || entry.hostId}`
                : entry.label,
              search: { machine: entry.hostId },
            }))
          : [{ label: "Open all environments", search: {} }];

  const alertActionPart = (
    <AlertAction className="flex-wrap gap-2">
      {choices.map((choice) => (
        <Button
          className="max-w-full break-all text-left"
          key={JSON.stringify(choice.search)}
          onClick={() => {
            if (targetId)
              void navigate({ search: () => choice.search, hash: targetId, to: pathname });
            else selectScope(choice.search);
          }}
          size="sm-multiline"
          variant="outline"
        >
          {choice.label}
        </Button>
      ))}
    </AlertAction>
  );

  const alertDescriptionPart = (
    <AlertDescription>
      <p>{children}</p>
      {alertActionPart}
    </AlertDescription>
  );

  return (
    <PrefsPageContainer>
      <Alert role="status">{alertDescriptionPart}</Alert>
    </PrefsPageContainer>
  );
}
