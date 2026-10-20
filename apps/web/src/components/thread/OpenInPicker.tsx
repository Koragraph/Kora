import { cn } from "~/util/utils";
import { useAtomAction } from "~/atoms/use-atom-command";
import { shellHost } from "~/atoms/shell";
import { MenuTrigger, MenuPopup, MenuItem, Menu } from "../ui/menu";
import { GroupSeparator, Group } from "../ui/group";
import { Button } from "../ui/button";
import {
  IntelliJIdeaIcon,
  DataSpellIcon,
  RustRoverIcon,
  DataGripIcon,
  PhpStormIcon,
  RubyMineIcon,
  WebStormIcon,
  PyCharmIcon,
  GoLandIcon,
  CLionIcon,
  RiderIcon,
  AquaIcon,
} from "../JetBrainsLogos";
import {
  VisualStudioCodeInsiders,
  FileExplorerIcon,
  VisualStudioCode,
  AntigravityIcon,
  CursorIcon,
  FinderIcon,
  KiroIcon,
  TraeIcon,
  VSCodium,
  type Icon,
  Zed,
} from "../BrandIcons";
import { useEditorPreference } from "../../workspace/editorPreferences";
import { editorLabelForPlatform } from "../../workspace/editorLabels";
import type { ExternalEditorId, HostId } from "@kora/contracts";
import { useCallback, memo } from "react";
import { FolderClosedIcon, ChevronDownIcon } from "lucide-react";

type OpenInOption = {
  Icon: Icon;
  value: ExternalEditorId;
  kind: "brand" | "generic";
  label: string;
};

const BRAND_EDITORS: ReadonlyArray<readonly [ExternalEditorId, Icon]> = [
  ["cursor", CursorIcon],
  ["trae", TraeIcon],
  ["kiro", KiroIcon],
  ["vscode", VisualStudioCode],
  ["vscode-insiders", VisualStudioCodeInsiders],
  ["vscodium", VSCodium],
  ["zed", Zed],
  ["antigravity", AntigravityIcon],
  ["idea", IntelliJIdeaIcon],
  ["aqua", AquaIcon],
  ["clion", CLionIcon],
  ["datagrip", DataGripIcon],
  ["dataspell", DataSpellIcon],
  ["goland", GoLandIcon],
  ["phpstorm", PhpStormIcon],
  ["pycharm", PyCharmIcon],
  ["rider", RiderIcon],
  ["rubymine", RubyMineIcon],
  ["rustrover", RustRoverIcon],
  ["webstorm", WebStormIcon],
] as ReadonlyArray<readonly [ExternalEditorId, Icon]>;

function fileManagerOption(platform: string): Pick<OpenInOption, "Icon" | "kind"> {
  if (/mac|iphone|ipad|ipod/i.test(platform)) return { Icon: FinderIcon, kind: "brand" };
  if (/^win/i.test(platform)) return { Icon: FileExplorerIcon, kind: "brand" };
  return { Icon: FolderClosedIcon as Icon, kind: "generic" };
}

export const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<ExternalEditorId>,
): Array<OpenInOption> => {
  const catalogue: Array<Omit<OpenInOption, "label">> = [
    ...BRAND_EDITORS.map(([value, Icon]) => ({ Icon, value, kind: "brand" as const })),
    { value: "file-manager" as ExternalEditorId, ...fileManagerOption(platform) },
  ];
  return catalogue
    .filter((option) => availableEditors.includes(option.value))
    .map((option) => ({ ...option, label: editorLabelForPlatform(option.value, platform) }));
};

function OptionIcon({ option, className }: { option: OpenInOption; className?: string }) {
  return (
    <option.Icon
      aria-hidden="true"
      className={cn(
        "size-3.5",
        option.kind === "generic" ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    />
  );
}

export const OpenInPicker = memo(function OpenInPicker({
  hostId,
  availableEditors,
  openInCwd,
  compact = false,
}: {
  hostId: HostId;
  availableEditors: ReadonlyArray<ExternalEditorId>;
  openInCwd: string | null;
  compact?: boolean;
}) {
  const [preferredEditor, setPreferredEditor] = useEditorPreference(availableEditors);
  const openInEditor = useAtomAction(shellHost.openInEditor);
  const options = resolveOpenInOptions(navigator.platform, availableEditors);
  const primary = options.find((option) => option.value === preferredEditor) ?? null;

  const open = useCallback(
    (editor: ExternalEditorId | null) => {
      if (!openInCwd || !editor) return;
      void openInEditor({ hostId, input: { cwd: openInCwd, editor } });
      setPreferredEditor(editor);
    },
    [hostId, openInCwd, openInEditor, setPreferredEditor],
  );

  return (
    <Group aria-label="Open in editor">
      <Button
        aria-label={compact ? "Open file in preferred editor" : undefined}
        className="ps-[calc(--spacing(2)+0.5px)]"
        disabled={!primary || !openInCwd}
        onClick={() => open(preferredEditor)}
        size="xs"
        variant="outline"
      >
        {primary ? <OptionIcon option={primary} /> : null}
        <span
          className={cn(
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ms-0.5",
          )}
        >
          Open
        </span>
      </Button>
      <GroupSeparator className={cn(!compact && "hidden @3xl/header-actions:block")} />
      <Menu>
        <MenuTrigger
          render={<Button aria-label="Choose editor" size="icon-xs" variant="outline" />}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 ? (
            <MenuItem disabled>No installed editors found</MenuItem>
          ) : (
            options.map((option) => (
              <MenuItem key={option.value} onClick={() => open(option.value)}>
                <OptionIcon option={option} className="size-4 sm:size-3.5" />
                {option.label}
              </MenuItem>
            ))
          )}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
