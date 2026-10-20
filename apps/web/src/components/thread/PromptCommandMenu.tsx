import { cn } from "~/util/utils";
import { PromptBanner } from "./PromptBanner";
import { FileEntryIcon } from "./FileEntryIcon";
import { CommandGroup, CommandItem, CommandList, Command } from "../ui/command";
import { Badge } from "../ui/badge";
import type { PromptSlashCommand, PromptTriggerKind } from "../../prompt-logic";
import type { AgentSlashCommand, WorkspaceEntry, AgentSkill, AgentId } from "@kora/contracts";
import {
  formatAgentSkillDisplayName,
  resolveAgentSkillSourceKind,
  type AgentSkillSourceKind,
} from "@kora/client-runtime/agentSkills";
import { useLayoutEffect, type ReactNode, useRef, memo } from "react";
import { UserRoundIcon, SettingsIcon, PackageIcon, BlocksIcon, FolderIcon } from "lucide-react";

export type PromptCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: WorkspaceEntry["kind"];
      label: string;
      description: string;
    }
  | {
      type: "group-member";
      description: string;
      avatar: ReactNode;
      mention: string;
      label: string;
      id: string;
    }
  | {
      command: PromptSlashCommand;
      type: "slash-command";
      description: string;
      label: string;
      id: string;
    }
  | {
      type: "provider-slash-command";
      command: AgentSlashCommand;
      description: string;
      provider: AgentId;
      label: string;
      id: string;
    }
  | {
      description: string;
      skill: AgentSkill;
      provider: AgentId;
      type: "skill";
      label: string;
      id: string;
    };

const SOURCE_BADGES: Record<AgentSkillSourceKind, { Icon: typeof BlocksIcon; label: string }> = {
  app: { Icon: BlocksIcon, label: "App" },
  repo: { Icon: FolderIcon, label: "Repo" },
  project: { Icon: FolderIcon, label: "Project" },
  personal: { Icon: UserRoundIcon, label: "Personal" },
  system: { Icon: SettingsIcon, label: "System" },
  other: { Icon: PackageIcon, label: "Provider" },
};

function emptyText(input: {
  isLoading: boolean;
  triggerKind: PromptTriggerKind | null;
  emptyStateText: string | undefined;
}): string {
  const { isLoading, triggerKind, emptyStateText } = input;
  if (isLoading) {
    return triggerKind === "skill"
      ? "Searching workspace skills..."
      : "Searching workspace files...";
  }
  if (emptyStateText) return emptyStateText;
  if (triggerKind === "skill") return "No skills found. Try / to browse provider commands.";
  if (triggerKind === "path") return "No matching files or folders.";
  return "No matching command.";
}

const Row = memo(function Row({
  item,
  active,
  resolvedTheme,
  triggerKind,
  onHighlightedItemChange,
  onSelect,
}: {
  item: PromptCommandItem;
  active: boolean;
  resolvedTheme: "light" | "dark";
  triggerKind: PromptTriggerKind | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: PromptCommandItem) => void;
}) {
  const skill = item.type === "skill" ? item.skill : null;
  const badge = skill ? SOURCE_BADGES[resolveAgentSkillSourceKind(skill)] : null;

  return (
    <CommandItem
      className={cn(
        "cursor-pointer select-none gap-3 rounded-lg px-3 py-2",
        active
          ? "bg-accent text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
          : "bg-transparent data-highlighted:bg-transparent hover:bg-transparent",
      )}
      data-prompt-item-id={item.id}
      onClick={() => onSelect(item)}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => {
        if (!active) onHighlightedItemChange(item.id);
      }}
      value={item.id}
    >
      {item.type === "group-member" ? (
        <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
          {item.avatar}
        </span>
      ) : null}
      {item.type === "path" ? (
        <FileEntryIcon kind={item.pathKind} pathValue={item.path} theme={resolvedTheme} />
      ) : null}
      <span className="max-w-[45%] shrink-0 truncate font-medium font-sans text-xs">
        {skill && triggerKind === "slash-command" ? (
          <>
            <span className="text-secondary-label">/skill:</span>
            {formatAgentSkillDisplayName(skill)}
          </>
        ) : (
          item.label
        )}
      </span>
      <span className="min-w-0 max-w-[48ch] flex-1 truncate text-left text-secondary-label text-xs">
        {item.description}
      </span>
      {badge ? (
        <Badge className="ms-auto" variant="secondary">
          <badge.Icon />
          {triggerKind === "skill" ? `${badge.label} Skill` : badge.label}
        </Badge>
      ) : null}
    </CommandItem>
  );
});

export const PromptCommandMenu = memo(function PromptCommandMenu({
  items,
  resolvedTheme,
  isLoading,
  triggerKind,
  emptyStateText,
  activeItemId,
  onHighlightedItemChange,
  onSelect,
}: {
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: PromptCommandItem) => void;
  triggerKind: PromptTriggerKind | null;
  resolvedTheme: "light" | "dark";
  activeItemId: string | null;
  items: PromptCommandItem[];
  emptyStateText?: string;
  isLoading: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!activeItemId) return;
    surfaceRef.current
      ?.querySelector(`[data-prompt-item-id="${CSS.escape(activeItemId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(value) =>
        onHighlightedItemChange(typeof value === "string" ? value : null)
      }
    >
      <PromptBanner.Surface
        className="flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap) before:bg-(--chat-composer-attached-surface)! [&_[data-slot=scroll-area-scrollbar]]:my-4"
        data-prompt-command-drawer="true"
        ref={surfaceRef}
      >
        {items.length > 0 ? (
          <CommandList className="max-h-72 min-h-0 overflow-y-auto scroll-pb-6">
            <CommandGroup>
              {items.map((item) => (
                <Row
                  active={item.id === activeItemId}
                  item={item}
                  key={item.id}
                  onHighlightedItemChange={onHighlightedItemChange}
                  onSelect={onSelect}
                  resolvedTheme={resolvedTheme}
                  triggerKind={triggerKind}
                />
              ))}
            </CommandGroup>
          </CommandList>
        ) : (
          <p className="px-5 pt-3.5 pb-7 text-secondary-label text-xs">
            {emptyText({ isLoading, triggerKind, emptyStateText })}
          </p>
        )}
      </PromptBanner.Surface>
    </Command>
  );
});
