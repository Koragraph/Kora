import { ProjectInitials } from "./ProjectInitials";
import { deriveProjectIdentity } from "../workspace/projectIdentity";
import { cn } from "../util/utils";
import { projectIconColorClassName } from "../appearance/projectIconColors";
import type { HostProject } from "@kora/client-runtime/store/models";
import { type ComponentType, Suspense, lazy } from "react";
import { FolderCodeIcon } from "lucide-react";

export type ProjectFaviconProject = Pick<
  HostProject,
  "hostId" | "workspaceRoot" | "title" | "faviconPath" | "projectIcon"
>;

type FallbackIconComponent = ComponentType<{ className?: string }>;

const LazyDynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((mod) => ({ default: mod.DynamicIcon })),
);

function FallbackIcon({
  projectName,
  emoji,
  icon: Icon,
  className,
}: {
  readonly projectName?: string | undefined;
  readonly emoji?: string | undefined;
  readonly icon: FallbackIconComponent;
  readonly className?: string | undefined;
}) {
  if (projectName !== undefined && projectName.trim() !== "") {
    const identity = deriveProjectIdentity(projectName);
    return (
      <ProjectInitials text={identity.monogram} color={identity.color} className={className} />
    );
  }
  if (emoji) {
    return (
      <span
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center leading-none [container-type:size]",
          className,
        )}
        aria-hidden="true"
      >
        <span className="leading-none" style={{ fontSize: "80cqh" }}>
          {emoji}
        </span>
      </span>
    );
  }
  return <Icon className={cn("size-3.5 shrink-0 icon-muted", className)} />;
}

/**
 * Identity icon for a project. Callers pass the whole project record so title, favicon and the icon override
 * always travel together; a display label standing in for the title would change the automatic monogram.
 */
export function ProjectFavicon({
  project,
  className,
  fallbackIcon,
}: {
  readonly project: ProjectFaviconProject;
  readonly className?: string | undefined;
  readonly fallbackIcon?: FallbackIconComponent;
}) {
  const override = project.projectIcon;

  if (override?.kind === "lucide" && override.monogram) {
    return (
      <ProjectInitials text={override.monogram} color={override.color} className={className} />
    );
  }

  if (override?.kind === "emoji") {
    return <FallbackIcon emoji={override.emoji} icon={FolderCodeIcon} className={className} />;
  }

  if (override?.kind === "lucide") {
    const colorClass = projectIconColorClassName(override.color);
    const folder = <FolderCodeIcon className="size-full text-[inherit]" />;
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center",
          colorClass,
          className,
        )}
      >
        <Suspense fallback={folder}>
          <LazyDynamicIcon
            name={override.name as never}
            className={cn("size-full", colorClass)}
            fallback={() => folder}
          />
        </Suspense>
      </span>
    );
  }

  return (
    <FallbackIcon
      projectName={project.title}
      icon={fallbackIcon ?? FolderCodeIcon}
      className={className}
    />
  );
}
