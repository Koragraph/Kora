import { surfacesInGroup, dockGroupOf, type DockGroup } from "./rightDock.logic";
import { DockGroupTabs, type DockRailItem } from "./DockControls";
import { webBridge } from "../web/webBridge";
import { WebPanelShell, type WebPanelMode } from "../web/WebPanelShell";
import { FaviconImage } from "../web/WebFaviconIcon";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { MenuTrigger, MenuPopup, MenuItem, Menu } from "../ui/menu";
import { Button } from "../ui/button";
import { FileEntryIcon } from "../thread/FileEntryIcon";
import { COLLAPSED_NAV_TITLEBAR_INSET_CLASS } from "../../workspace/workspaceTitlebar";
import { usePreviewDefaults } from "../../webview/browserDefaults";
import { cn } from "../../util/utils";
import type { ShellWebOverlay } from "../../stores/webStateStore";
import type { DockSurface } from "../../stores/dockStore";
import { readLocalApi } from "../../localApi";
import { useTheme } from "../../hooks/useTheme";
import { isNative } from "../../env";
import { ptyLabelFor } from "@kora/shared/ptyLabels";
import type { WebSessionSnapshot } from "@kora/contracts";
import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import {
  ArrowRightToLineIcon,
  ArrowLeftToLineIcon,
  SquareTerminalIcon,
  ChevronsRightIcon,
  ChevronDownIcon,
  VolumeOffIcon,
  Volume2Icon,
  Globe2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";

export function tabMuteMenuItem(input: {
  overlay: ShellWebOverlay | null;
  canResolveRuntimeTabId: boolean;
}): { label: string; disabled: boolean } {
  return {
    label: input.overlay?.audioMuted ? "Unmute page" : "Mute page",
    // The server session id can resolve before the desktop has made the tab; muting then fails silently.
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

interface RightDockPanelProps {
  /** Session tab id to the desktop's runtime tab id. */
  webRuntimeTabId?: ((tabId: string) => string) | undefined;
  previewSessions: Readonly<Record<string, WebSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, ShellWebOverlay>>;
  onAddBrowserInProfile: (profileId: string) => void;
  terminalLabelsById: ReadonlyMap<string, string>;
  onCopyFilePath: (relativePath: string) => void;
  onCloseSurface: (surface: DockSurface) => void;
  onActivate: (surface: DockSurface) => void;
  onSelectGroup: (group: DockGroup) => void;
  pendingSurfaceIds: ReadonlySet<string>;
  surfaces: readonly DockSurface[];
  groups: readonly DockRailItem[];
  activeSurfaceId: string | null;
  onToggleMaximize?: () => void;
  onAddTerminal: () => void;
  widthStorageKey?: string;
  onAddBrowser: () => void;
  defaultWidth?: number;
  canMaximize?: boolean;
  maximized?: boolean;
  children: ReactNode;
  onHide: () => void;
  mode: WebPanelMode;
  open?: boolean;
}

const NO_DRAG = "[-webkit-app-region:no-drag]";

function urlOf(session: WebSessionSnapshot | undefined): string | null {
  const nav = session?.navStatus as { _tag: string; url?: string } | undefined;
  return nav && nav._tag !== "Idle" && nav.url ? nav.url : null;
}

function surfaceTitle(
  surface: DockSurface,
  session: WebSessionSnapshot | undefined,
  terminalLabels: ReadonlyMap<string, string>,
): string {
  switch (surface.kind) {
    case "files":
      return "All files";
    case "file":
      return surface.relativePath.slice(
        Math.max(surface.relativePath.lastIndexOf("\\"), surface.relativePath.lastIndexOf("/")) + 1,
      );
    case "terminal":
      return terminalLabels.get(surface.activeTerminalId) ?? ptyLabelFor(surface.activeTerminalId);
    case "fleet":
      return "Workers";
    case "preview": {
      const nav = session?.navStatus as { _tag: string; url?: string; title?: string } | undefined;
      if (!nav || nav._tag === "Idle") return "New page";
      if (nav.title?.trim()) return nav.title;
      try {
        return new URL(nav.url ?? "").host || "New page";
      } catch {
        return "New page";
      }
    }
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function SurfaceIcon(props: {
  surface: DockSurface;
  session: WebSessionSnapshot | undefined;
  overlay: ShellWebOverlay | undefined;
  theme: "light" | "dark";
}) {
  const { surface, session, overlay } = props;
  if (surface.kind === "preview") {
    const url = urlOf(session);
    const captured =
      overlay?.favicon && url && sameOrigin(overlay.favicon.pageUrl, url)
        ? overlay.favicon.dataUrl
        : null;
    const fallback = <Globe2Icon className="size-3" />;
    // The page's own icon as the in-app browser captured it; never a favicon service (local-only).
    return (
      <FaviconImage
        sources={[captured]}
        fallback={fallback}
        className="size-3 rounded-sm object-contain"
      />
    );
  }
  if (surface.kind === "file") {
    return (
      <FileEntryIcon
        pathValue={surface.relativePath}
        kind="file"
        theme={props.theme}
        className="size-3"
      />
    );
  }
  if (surface.kind === "terminal") return <SquareTerminalIcon className="size-3" />;
  return null;
}

function HeaderIconButton(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className={cn("size-7 text-muted-foreground hover:text-foreground", NO_DRAG)}
            aria-label={props.label}
            onClick={props.onClick}
            variant="ghost"
            size="icon-xs"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function RightDockPanel(props: RightDockPanelProps) {
  const { mode, surfaces, activeSurfaceId, previewSessions, desktopByTabId, webRuntimeTabId } =
    props;
  const { resolvedTheme } = useTheme();
  const browserDefaults = usePreviewDefaults();
  const stripRef = useRef<HTMLDivElement>(null);

  const active = surfaces.find((surface) => surface.id === activeSurfaceId) ?? null;
  const group = active ? dockGroupOf(active) : null;
  const members = group ? surfacesInGroup(surfaces, group) : [];
  const showStrip =
    group === "browser" ||
    group === "terminal" ||
    (group === "files" && members.some((surface) => surface.kind === "file"));
  const nativeInline = isNative && mode === "inline";
  const profiles = browserDefaults.profiles ?? [];

  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>("[data-active-tab='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSurfaceId]);

  const setMuted = (runtimeId: string, muted: boolean) => {
    void Promise.resolve(webBridge?.setAudioMuted(runtimeId, muted)).catch(() => undefined);
  };

  const openTabMenu = async (event: MouseEvent, surface: DockSurface) => {
    event.stopPropagation();
    event.preventDefault();
    const api = readLocalApi();
    if (!api) {
      return;
    }
    const overlay =
      surface.kind === "preview" && surface.resourceId
        ? desktopByTabId[surface.resourceId]
        : undefined;
    const runtimeId =
      surface.kind === "preview" && surface.resourceId
        ? webRuntimeTabId?.(surface.resourceId)
        : undefined;
    const mute = tabMuteMenuItem({
      overlay: overlay ?? null,
      canResolveRuntimeTabId: runtimeId !== undefined,
    });
    const items = [
      ...(surface.kind === "file" ? [{ id: "copy-path" as const, label: "Copy path" }] : []),
      ...(surface.kind === "preview"
        ? [{ id: "toggle-mute" as const, label: mute.label, disabled: mute.disabled }]
        : []),
      { id: "close" as const, label: "Close" },
    ];
    const choice = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
    if (choice === "copy-path" && surface.kind === "file")
      props.onCopyFilePath(surface.relativePath);
    else if (choice === "toggle-mute" && overlay && runtimeId)
      setMuted(runtimeId, !overlay.audioMuted);
    else if (choice === "close") props.onCloseSurface(surface);
  };

  return (
    <WebPanelShell
      mode={mode}
      {...(props.defaultWidth === undefined ? {} : { defaultWidth: props.defaultWidth })}
      {...(props.widthStorageKey === undefined ? {} : { widthStorageKey: props.widthStorageKey })}
      {...(props.open === undefined ? {} : { open: props.open })}
      {...(props.maximized === undefined ? {} : { maximized: props.maximized })}
    >
      <div
        data-dock-tabbar
        data-dock-group={group ?? undefined}
        className={cn(
          "@container/dock flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 pr-2 pl-3",
          !showStrip && "border-b border-border",
          nativeInline && "drag-region",
          mode === "inline" && props.maximized && COLLAPSED_NAV_TITLEBAR_INSET_CLASS,
        )}
      >
        <DockGroupTabs items={props.groups} activeGroup={group} onSelect={props.onSelectGroup} />
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-0.5">
          {mode === "inline" && props.canMaximize && props.onToggleMaximize ? (
            <HeaderIconButton
              label={props.maximized ? "Back to the side" : "Spread over the chat"}
              onClick={props.onToggleMaximize}
            >
              {props.maximized ? (
                <ArrowRightToLineIcon className="size-3.5" />
              ) : (
                <ArrowLeftToLineIcon className="size-3.5" />
              )}
            </HeaderIconButton>
          ) : null}
          <HeaderIconButton label="Tuck the dock away" onClick={props.onHide}>
            <ChevronsRightIcon className="size-3.5" />
          </HeaderIconButton>
        </div>
      </div>

      {showStrip ? (
        <div
          data-dock-strip
          className="flex h-9 min-h-9 items-stretch gap-3 border-b border-border pr-2 pl-3"
        >
          <ScrollArea hideScrollbars scrollFade className="min-w-0 flex-1 rounded-none">
            <div
              ref={stripRef}
              data-dock-tab-list
              role="tablist"
              className="flex h-full w-max items-stretch gap-3"
            >
              {members.map((surface) => {
                const session =
                  surface.kind === "preview" && surface.resourceId
                    ? previewSessions[surface.resourceId]
                    : undefined;
                const overlay =
                  surface.kind === "preview" && surface.resourceId
                    ? desktopByTabId[surface.resourceId]
                    : undefined;
                const runtimeId =
                  surface.kind === "preview" && surface.resourceId
                    ? webRuntimeTabId?.(surface.resourceId)
                    : undefined;
                const title = surfaceTitle(surface, session, props.terminalLabelsById);
                const isActive = surface.id === activeSurfaceId;
                const showAudio = overlay?.audible === true && runtimeId !== undefined;
                return (
                  <div
                    key={surface.id}
                    role="tab"
                    aria-selected={isActive}
                    data-active-tab={isActive ? "true" : undefined}
                    className={cn(
                      "group/tab relative flex max-w-44 items-center gap-1.5 text-xs",
                      NO_DRAG,
                      isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                    onMouseDown={(event) => {
                      if (event.button === 1) event.preventDefault();
                    }}
                    onAuxClick={(event) => {
                      if (event.button === 1) props.onCloseSurface(surface);
                    }}
                    onContextMenu={(event) => void openTabMenu(event, surface)}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 cursor-pointer items-center gap-1.5"
                      onClick={() => props.onActivate(surface)}
                    >
                      <SurfaceIcon
                        surface={surface}
                        session={session}
                        overlay={overlay}
                        theme={resolvedTheme}
                      />
                      <span className="truncate">{title}</span>
                      {props.pendingSurfaceIds.has(surface.id) ? (
                        <span className="size-1.5 shrink-0 rounded-full bg-current" />
                      ) : null}
                    </button>
                    {showAudio ? (
                      <button
                        type="button"
                        aria-label={overlay!.audioMuted ? `Unmute ${title}` : `Mute ${title}`}
                        className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-muted"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMuted(runtimeId!, !overlay!.audioMuted);
                        }}
                      >
                        {overlay!.audioMuted ? (
                          <VolumeOffIcon className="size-3" />
                        ) : (
                          <Volume2Icon className="size-3" />
                        )}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Close ${title}`}
                      className={cn(
                        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100",
                        isActive ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onCloseSurface(surface);
                      }}
                    >
                      <XIcon className="size-3" />
                    </button>
                    <span
                      className={cn(
                        "absolute inset-x-0 -bottom-px h-0.5 rounded-full",
                        isActive ? "bg-foreground" : "bg-transparent group-hover/tab:bg-border",
                      )}
                    />
                  </div>
                );
              })}
            </div>
          </ScrollArea>
          {group === "browser" ? (
            <div className="flex shrink-0 items-center">
              <HeaderIconButton label="New page" onClick={props.onAddBrowser}>
                <PlusIcon className="size-3.5" />
              </HeaderIconButton>
              {profiles.length > 1 ? (
                <Menu>
                  <MenuTrigger
                    aria-label="New page in a profile"
                    className={cn(
                      "flex h-7 w-4 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
                      NO_DRAG,
                    )}
                  >
                    <ChevronDownIcon className="size-3" />
                  </MenuTrigger>
                  <MenuPopup align="end" side="bottom" sideOffset={6} className="max-w-56 min-w-40">
                    {profiles.map((profile) => (
                      <MenuItem
                        key={profile.id}
                        onClick={() => props.onAddBrowserInProfile(profile.id)}
                      >
                        <span className="truncate">{profile.name}</span>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          ) : null}
          {group === "terminal" ? (
            <div className="flex shrink-0 items-center">
              <HeaderIconButton label="Open a shell" onClick={props.onAddTerminal}>
                <PlusIcon className="size-3.5" />
              </HeaderIconButton>
            </div>
          ) : null}
        </div>
      ) : null}

      <div data-dock-surface-content className="flex min-h-0 flex-1 flex-col">
        {active ? (
          props.children
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
            <p className="text-sm text-foreground">Nothing open</p>
            <p className="max-w-60 text-xs text-muted-foreground">
              Pick Workers, Files, Browser or Terminal above.
            </p>
          </div>
        )}
      </div>
    </WebPanelShell>
  );
}
