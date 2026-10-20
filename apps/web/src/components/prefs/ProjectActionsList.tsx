import { PrefsRow } from "./prefsLayout";
import { Button } from "../ui/button";
import { ScriptIcon } from "../projectCommandEditor";
import type { ProjectAction } from "@kora/contracts";
import { SettingsIcon } from "lucide-react";

const projectActionsListCls1 = "px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm";

export function ProjectActionsList({
  scripts,
  disabled,
  onEdit,
}: {
  scripts: readonly ProjectAction[];
  disabled: boolean;
  onEdit: (script: ProjectAction) => void;
}) {
  if (scripts.length === 0) return <p className={projectActionsListCls1}>No actions configured.</p>;
  return scripts.map((script) => {
    return (
      <PrefsRow
        title={
          <span className="flex min-w-0 items-center gap-2">
            <ScriptIcon className="size-4 shrink-0 text-muted-foreground" icon={script.icon} />
            <span className="min-w-0 truncate">{script.name}</span>
            {script.runOnWorktreeCreate ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground">
                setup
              </span>
            ) : null}
            {script.previewUrl ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground max-sm:hidden">
                preview · desktop only
              </span>
            ) : null}
          </span>
        }
        control={
          <>
            <Button
              className="shrink-0 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
              aria-label={`Edit ${script.name}`}
              onClick={() => onEdit(script)}
              disabled={disabled}
              variant="ghost"
              size="icon-xs"
            >
              <SettingsIcon className="size-3.5" />
            </Button>
          </>
        }
        description={<code className="block max-w-full truncate font-mono">{script.command}</code>}
        className="group py-2"
        key={script.id}
      />
    );
  });
}
