import { TooltipTrigger, TooltipPopup, Tooltip } from "./ui/tooltip";
import {
  useSidebarVisibility,
  useSidebarToggle,
  SidebarProvider,
  SidebarTrigger,
  SidebarRail,
  Sidebar,
} from "./ui/sidebar";
import {
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_NAV_WIDTH_STORAGE_KEY,
  resolveInitialThreadNavWidth,
  resolveThreadNavMaximumWidth,
  THREAD_NAV_MIN_WIDTH,
} from "./threadNavWidth";
import { PrefsNav } from "./prefs/PrefsNav";
import { rememberAppLocation } from "./prefs/lastAppLocation";
import { NavChromeHeader } from "./nav/NavChrome";
import { useSurfaceSwitch } from "./assistant/useSurfaceSwitch";
import { SurfaceSwitcher } from "./assistant/SurfaceSwitcher";
import ThreadNav from "./ThreadNav";
import { isMacPlatform } from "../util/utils";
import { terminalFocusOwner } from "../util/terminalFocus";
import { resolveAppShortcut } from "./appShortcuts";
import { removeLocalStorageItem, getLocalStorageItem } from "../hooks/useLocalStorage";
import { isNative } from "../env";
import { useProjects } from "../atoms/entities";
import {
  PanelAnimationSuppressionProvider,
  usePanelNavigationSuppression,
  usePanelAnimationPrefs,
} from "../appearance/panelAnimations";
import { useSyncExternalStore, useCallback, type ReactNode, useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import { useLocation, useNavigate } from "@tanstack/react-router";

const SURFACE_SWITCHER_WIDTH_PX = 132; // traffic lights (90px) + toggle + gap + this must end inside the sidebar (272px minimum)
// Below this the sidebar starts closed so the titlebar switcher doesn't cover the thread title.
const PHONE_WIDTH_PX = 640;

const SETTINGS_PAGES: ReadonlySet<string> = new Set([
  "general",
  "token-savings",
  "providers",
  "extensions",
  "swarm",
  "blobs",
  "connections",
  "outside",
  "engines",
  "diagnostics",
  "projects",
  "usage",
]);

const isSettingsPath = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/");

function subscribeToResize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}
const readViewportWidth = () => window.innerWidth;
const readServerViewportWidth = () => 1280;

function useViewportWidth(): number {
  return useSyncExternalStore(subscribeToResize, readViewportWidth, readServerViewportWidth);
}

function readStoredWidth(): number | null {
  try {
    return getLocalStorageItem(THREAD_NAV_WIDTH_STORAGE_KEY, Schema.Finite);
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return null;
  }
}

function useWindowFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(() => {
    const bridge = typeof window === "undefined" ? undefined : window.shellBridge;
    return typeof bridge?.getWindowFullscreenState === "function"
      ? bridge.getWindowFullscreenState()
      : false;
  });

  useEffect(() => {
    const bridge = window.shellBridge;
    if (typeof bridge?.onWindowFullscreenStateChange !== "function") return;
    const unsubscribe = bridge.onWindowFullscreenStateChange(setFullscreen);
    if (typeof bridge.getWindowFullscreenState === "function") {
      setFullscreen(bridge.getWindowFullscreenState());
    }
    return unsubscribe;
  }, []);

  return fullscreen;
}

/** ⌘B toggles the sidebar, ⌘, opens Settings (the desktop menu's Settings item has no accelerator). */
function AppShortcuts({ onSettings }: { onSettings: boolean }): null {
  const toggleSidebar = useSidebarToggle();
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = resolveAppShortcut(event, isMacPlatform(navigator.platform));
      if (!action) return;
      if (action === "toggle-sidebar") {
        if (terminalFocusOwner() !== null) return;
        event.preventDefault();
        toggleSidebar();
        return;
      }
      event.preventDefault();
      if (!onSettings) void navigate({ to: "/settings/general" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, onSettings, toggleSidebar]);
  return null;
}

// Settings unmounts ThreadNav; holding the projects subscription here avoids a zero-project flash on return.
const ProjectProjectionRetention = (): null => {
  useProjects();
  return null;
};

function NavControl() {
  const sidebarVisible = useSidebarVisibility();
  const [surface, switchSurface] = useSurfaceSwitch();

  return (
    // Sidebar open (md and up): the row spans to the sidebar's right edge, so the Kora | Code switch sits at the end of
    // the sidebar's header, after the traffic lights and the toggle. Closed: the switch follows the toggle.
    <div
      data-sidebar-open={sidebarVisible ? "true" : "false"}
      className="pointer-events-none fixed top-[var(--workspace-controls-top,0px)] left-[var(--workspace-controls-left,0px)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center gap-[var(--workspace-titlebar-control-gap)] data-[sidebar-open=true]:md:w-[calc(var(--sidebar-width)-var(--workspace-controls-left,0px)-1px)] data-[sidebar-open=true]:md:pr-2 [&>*]:pointer-events-auto"
    >
      <Tooltip>
        <TooltipTrigger render={<SidebarTrigger aria-label="Toggle main sidebar" />} />
        <TooltipPopup side="bottom">Toggle main sidebar</TooltipPopup>
      </Tooltip>
      <SurfaceSwitcher
        value={surface}
        onChange={switchSurface}
        className="w-[var(--surface-switcher-width)] md:in-data-[sidebar-open=true]:ml-auto"
      />
    </div>
  );
}

export function AppNavLayout({ children }: { readonly children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = useLocation({ select: (location) => location.href });
  const navigate = useNavigate();
  const onSettings = isSettingsPath(pathname);
  useEffect(() => {
    if (!onSettings) rememberAppLocation(href);
  }, [onSettings, href]);
  // An address under /settings that no page owns would leave an empty pane: go to the first page.
  const unknownSettingsPage =
    onSettings && !SETTINGS_PAGES.has(pathname.replace(/\/+$/, "").split("/")[2] ?? "");
  useEffect(() => {
    if (unknownSettingsPage) void navigate({ to: "/settings/general", replace: true });
  }, [navigate, unknownSettingsPage]);

  const panelPrefs = usePanelAnimationPrefs();
  const suppressed = usePanelNavigationSuppression(pathname);
  const animationsOn = panelPrefs.active && !suppressed;

  const viewportWidth = useViewportWidth();
  const maxNavWidth = resolveThreadNavMaximumWidth(viewportWidth);
  const [navWidth, setNavWidth] = useState(() =>
    resolveInitialThreadNavWidth(readStoredWidth(), window.innerWidth),
  );

  const fullscreen = useWindowFullscreen();
  const macShell = isNative && isMacPlatform(navigator.platform);

  const resetNavWidth = useCallback(() => {
    try {
      removeLocalStorageItem(THREAD_NAV_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setNavWidth(resolveInitialThreadNavWidth(null, window.innerWidth));
  }, []);

  useEffect(() => {
    const bridge = window.shellBridge;
    if (!bridge?.onMenuAction) return;
    return bridge.onMenuAction((action: string) => {
      if (action === "open-settings" && !onSettings) void navigate({ to: "/settings/general" });
    });
  }, [navigate, onSettings]);

  const providerStyle = {
    "--sidebar-width": `${navWidth}px`,
    "--panel-animation-duration": `${panelPrefs.durationMs}ms`,
    "--surface-switcher-width": `${SURFACE_SWITCHER_WIDTH_PX}px`,
    "--workspace-titlebar-extra-left": `calc(${SURFACE_SWITCHER_WIDTH_PX}px + var(--workspace-titlebar-control-gap))`,
    ...(macShell && !fullscreen
      ? { "--workspace-controls-left": "var(--desktop-window-controls-inset, 90px)" }
      : {}),
  } as React.CSSProperties;

  return (
    <PanelAnimationSuppressionProvider value={suppressed}>
      <SidebarProvider
        defaultOpen={window.innerWidth >= PHONE_WIDTH_PX}
        data-panel-animations={animationsOn ? "true" : "false"}
        className="h-dvh! min-h-0!"
        style={providerStyle}
      >
        <ProjectProjectionRetention />
        <AppShortcuts onSettings={onSettings} />
        <Sidebar
          variant="sidebar"
          data-prefs-surface={onSettings ? "" : undefined}
          data-app-sidebar=""
          collapsible="offcanvas"
          className="border-sidebar-border bg-sidebar text-sidebar-foreground dark:border-white/7"
          side="left"
          resizable={{
            storageKey: THREAD_NAV_WIDTH_STORAGE_KEY,
            minWidth: THREAD_NAV_MIN_WIDTH,
            maxWidth: maxNavWidth,
            onResize: setNavWidth,
            shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) => {
              const shrinking = nextWidth <= currentWidth;
              return shrinking || wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH;
            },
          }}
        >
          {onSettings ? (
            <>
              <NavChromeHeader isNative={isNative} />
              <PrefsNav pathname={pathname} />
            </>
          ) : (
            <ThreadNav />
          )}
          <SidebarRail onDoubleClick={resetNavWidth} />
        </Sidebar>
        {children}
        <NavControl />
      </SidebarProvider>
    </PanelAnimationSuppressionProvider>
  );
}
