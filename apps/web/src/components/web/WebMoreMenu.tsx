import { webBridge } from "./webBridge";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import {
  MenuTrigger,
  MenuSeparator,
  MenuRadioItem,
  MenuSub,
  MenuPopup,
  MenuSubTrigger,
  MenuRadioGroup,
  Menu,
  MenuSubPopup,
  MenuGroupLabel,
  MenuItem,
  MenuGroup,
} from "../ui/menu";
import { Button } from "../ui/button";
import type { ShellWebColorScheme, HostId } from "@kora/contracts";
import { MoreVerticalIcon, RotateCcwIcon, MinusIcon, PlusIcon } from "lucide-react";

type Props = {
  onNativePictureInPicture: () => void;
  onToggleDeviceToolbar: () => void;
  colorScheme: ShellWebColorScheme;
  profileName: string | undefined;
  nativePictureInPicture: boolean;
  deviceToolbarVisible: boolean;
  hasWebContents: boolean;
  tabId: string | null;
  zoomFactor: number;
  profileId: string;
  hostId: HostId;
};

/** Fire and forget: a failing tab call must never surface as an unhandled rejection. */
const quietly = (call: Promise<unknown>) => void call.catch(() => undefined);

const COLOR_SCHEME_CHOICES: ReadonlyArray<readonly [ShellWebColorScheme, string]> = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

export function WebMoreMenu(props: Props) {
  const bridge = webBridge;
  if (!bridge) return null;

  const { tabId } = props;
  const tabDisabled = tabId === null || !props.hasWebContents;
  const onTab = (action: (id: string) => Promise<unknown>) => () => {
    if (tabId !== null) quietly(action(tabId));
  };
  const profileId = props.profileId as Parameters<typeof bridge.clearCookies>[1];

  const menuRadioGroupPart = (
    <MenuRadioGroup
      onValueChange={(value) => {
        if (tabId !== null) quietly(bridge.setColorScheme(tabId, value as ShellWebColorScheme));
      }}
      value={props.colorScheme}
    >
      {COLOR_SCHEME_CHOICES.map(([value, label]) => (
        <MenuRadioItem value={value} key={value}>
          {label}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button aria-label="Preview menu" size="icon-xs" type="button" variant="ghost" />
              }
            />
          }
        >
          <MoreVerticalIcon />
        </TooltipTrigger>
        <TooltipPopup>More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-56" sideOffset={6}>
        <MenuItem disabled={tabDisabled} onClick={onTab((id) => bridge.hardReload(id))}>
          Hard reload
        </MenuItem>
        <MenuItem disabled={tabDisabled} onClick={onTab((id) => bridge.openDevTools(id))}>
          Open DevTools
        </MenuItem>
        <MenuItem onClick={props.onNativePictureInPicture}>
          {props.nativePictureInPicture
            ? "Close separate preview window"
            : "Open separate preview window"}
        </MenuItem>
        <MenuItem onClick={props.onToggleDeviceToolbar}>
          {props.deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={tabDisabled}>Appearance</MenuSubTrigger>
          <MenuSubPopup className="min-w-32">{menuRadioGroupPart}</MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem
          className="justify-between"
          closeOnClick={false}
          disabled={tabDisabled}
          onClick={(event) => event.preventDefault()}
        >
          <span>Zoom</span>
          <span className="flex items-center gap-1">
            <Button
              aria-label="Zoom out"
              disabled={tabDisabled}
              onClick={onTab((id) => bridge.zoomOut(id))}
              size="icon-xs"
              type="button"
              variant="outline"
            >
              <MinusIcon />
            </Button>
            <span className="min-w-12 text-center text-muted-foreground text-xs tabular-nums">
              {`${Math.round(props.zoomFactor * 100)}%`}
            </span>
            <Button
              aria-label="Zoom in"
              disabled={tabDisabled}
              onClick={onTab((id) => bridge.zoomIn(id))}
              size="icon-xs"
              type="button"
              variant="outline"
            >
              <PlusIcon />
            </Button>
            <Button
              aria-label="Reset zoom"
              className="hover:bg-foreground/10 data-pressed:bg-foreground/10"
              disabled={tabDisabled}
              onClick={onTab((id) => bridge.resetZoom(id))}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <RotateCcwIcon />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuGroup>
          {props.profileName ? (
            <MenuGroupLabel className="max-w-64 truncate">{`Profile: ${props.profileName}`}</MenuGroupLabel>
          ) : null}
          <MenuItem onClick={() => quietly(bridge.clearCookies(props.hostId, profileId))}>
            Clear cookies
          </MenuItem>
          <MenuItem onClick={() => quietly(bridge.clearCache(props.hostId, profileId))}>
            Clear cache
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
