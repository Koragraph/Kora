import { useAvailablePrefsSearchItems } from "./useAvailablePrefsSearchItems";
import {
  isPrefsOverviewVisible,
  KORA_ONLY_PREFS_PATHS,
  PREFS_SECTION_LABELS,
  searchPrefs,
  type PrefsPath,
} from "./prefsSearch";
import { validatePrefsScopeSearch } from "./prefsScope";
import { scrollToPrefsTarget } from "./prefsLayout";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenu,
  SidebarContent,
  SidebarGroup,
} from "../ui/sidebar";
import { Button } from "../ui/button";
import { cn } from "../../util/utils";
import { useKoraSurfaceOn } from "../../koraSurface";
import { useHosts } from "../../atoms/hosts";
import { useEffect, useState, useMemo, useRef } from "react";
import {
  PanelsTopLeftIcon,
  ArrowLeftIcon,
  Settings2Icon,
  ActivityIcon,
  KeyRoundIcon,
  HexagonIcon,
  type LucideIcon,
  SearchIcon,
  GaugeIcon,
  CoinsIcon,
  SmileIcon,
  PlugIcon,
  BotIcon,
  CpuIcon,
  PuzzleIcon,
  XIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { lastAppLocation } from "./lastAppLocation";

const SECTION_ICONS: Record<PrefsPath, LucideIcon> = {
  "/settings/general": Settings2Icon,
  "/settings/token-savings": CoinsIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/providers": BotIcon,
  "/settings/extensions": PuzzleIcon,
  "/settings/swarm": HexagonIcon,
  "/settings/blobs": SmileIcon,
  "/settings/connections": PlugIcon,
  "/settings/outside": KeyRoundIcon,
  "/settings/engines": CpuIcon,
  "/settings/usage": GaugeIcon,
  "/settings/diagnostics": ActivityIcon,
};

const RESULTS_ID = "settings-search-results";
const resultId = (id: string) => `settings-search-result-${id}`;

export function PrefsNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { environments } = useHosts();
  const searchableItems = useAvailablePrefsSearchItems();
  const koraSurfaceOn = useKoraSurfaceOn();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const scopeSearch = useMemo(
    () => validatePrefsScopeSearch(location.search as Record<string, unknown>),
    [location.search],
  );
  const swarmSupported = environments.some(
    (environment) => environment.daemonConfig?.environment.capabilities.swarm === true,
  );

  const sections = (Object.keys(PREFS_SECTION_LABELS) as PrefsPath[]).filter((path) => {
    if (path === "/settings/projects") return isPrefsOverviewVisible(scopeSearch);
    if (path === "/settings/swarm") return swarmSupported;
    if (KORA_ONLY_PREFS_PATHS.has(path)) return koraSurfaceOn;
    return true;
  });

  const searching = query.trim() !== "";
  const results = useMemo(
    () =>
      searching
        ? searchPrefs(
            query,
            searchableItems.filter((item) => !(item.swarmOnly && !swarmSupported)),
          )
        : [],
    [query, searchableItems, searching, swarmSupported],
  );
  const active = Math.min(activeIndex, Math.max(0, results.length - 1));
  const activeItem = results[active];

  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(resultId(activeItem.id))?.scrollIntoView({ block: "nearest" });
  }, [activeItem]);

  // Back = the page you opened Settings from (recorded by AppNavLayout), never a history step: history can hold other
  // Settings pages or nothing at all, which left Back doing nothing.
  const goBack = () => {
    const from = lastAppLocation();
    if (from) void navigate({ href: from });
    else void navigate({ to: "/" });
  };

  const openSection = (path: PrefsPath) => {
    void navigate({ to: path as never, hash: "", replace: true, hashScrollIntoView: false });
  };

  const openResult = (index: number) => {
    const item = results[index];
    if (!item) return;
    const targetId = item.targetId ?? item.id;
    setQuery("");
    setActiveIndex(0);
    if (pathname === item.to && location.hash.replace(/^#/, "") === targetId) {
      scrollToPrefsTarget(targetId);
      return;
    }
    void navigate({
      state: { settingsTargetHighlight: true } as never,
      hashScrollIntoView: false,
      to: item.to as never,
      hash: targetId,
      replace: true,
    });
  };

  const isActivePath = (path: string) => pathname === path || pathname.startsWith(`${path}/`);

  const pBlock = searching ? (
    results.length === 0 ? (
      <p className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground" role="status">
        No settings found
      </p>
    ) : (
      <SidebarMenu
        id={RESULTS_ID}
        role="listbox"
        aria-label="Settings search results"
        className="pl-px"
      >
        {results.map((item, index) => {
          const Icon = SECTION_ICONS[item.to];
          const isActive = index === active;
          const sidebarMenuButtonPart = (
            <SidebarMenuButton
              id={resultId(item.id)}
              role="option"
              aria-selected={isActive}
              tabIndex={-1}
              isActive={isActive}
              className="h-auto min-h-10 items-start gap-2 rounded-2xl px-2.5 py-2 text-left hover:bg-sidebar-row-hover"
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => openResult(index)}
            >
              <Icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground/60" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-sidebar-foreground">
                  {item.title}
                </span>
                <span className="truncate text-[11px] text-sidebar-muted-foreground">
                  {PREFS_SECTION_LABELS[item.to]}
                </span>
              </span>
            </SidebarMenuButton>
          );

          return <SidebarMenuItem key={item.id}>{sidebarMenuButtonPart}</SidebarMenuItem>;
        })}
      </SidebarMenu>
    )
  ) : (
    <SidebarMenu className="pl-px">
      {sections.map((path) => {
        const Icon = SECTION_ICONS[path];
        const isActive = isActivePath(path);
        const sidebarMenuButtonPart2 = (
          <SidebarMenuButton
            data-prefs-nav-item
            data-active={isActive ? "true" : "false"}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "ml-0 h-8 gap-2 rounded-md pl-3 text-[13px] font-normal transition-colors",
              isActive
                ? "bg-transparent text-sidebar-foreground"
                : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            )}
            onClick={() => openSection(path)}
          >
            <Icon className={cn("size-3.5", isActive ? "opacity-100" : "opacity-60")} />
            <span>{PREFS_SECTION_LABELS[path]}</span>
          </SidebarMenuButton>
        );

        return <SidebarMenuItem key={path}>{sidebarMenuButtonPart2}</SidebarMenuItem>;
      })}
    </SidebarMenu>
  );

  return (
    <SidebarContent className="overflow-x-hidden">
      <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
        <div className="mb-1 flex h-8 items-center gap-1.5 pl-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            onClick={goBack}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <h2 className="text-[15px] font-semibold tracking-tight text-sidebar-foreground">
            Settings
          </h2>
        </div>

        <div className="mb-2 flex h-8 items-center gap-2 rounded-full bg-sidebar-control-surface px-3 text-sm text-sidebar-muted-foreground transition-colors focus-within:bg-sidebar-row-active dark:bg-(--lift-inset-bg) dark:shadow-(--lift-inset-shadow)">
          <SearchIcon className="size-3.5 shrink-0" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-label="Search settings"
            placeholder="Search"
            aria-expanded={searching && results.length > 0 ? true : undefined}
            aria-controls={searching && results.length > 0 ? RESULTS_ID : undefined}
            aria-activedescendant={activeItem ? resultId(activeItem.id) : undefined}
            value={query}
            className="h-auto min-w-0 flex-1 bg-transparent p-0 text-[13px] leading-normal font-normal text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && results.length > 0) {
                event.preventDefault();
                setActiveIndex((active + 1) % results.length);
              } else if (event.key === "ArrowUp" && results.length > 0) {
                event.preventDefault();
                setActiveIndex((active - 1 + results.length) % results.length);
              } else if (event.key === "Enter" && results.length > 0) {
                event.preventDefault();
                openResult(active);
              } else if (event.key === "Escape" && searching) {
                setQuery("");
                setActiveIndex(0);
              }
            }}
          />
          {searching ? (
            <Button
              variant="ghost"
              size="icon-micro"
              aria-label="Clear settings search"
              className="hover:bg-sidebar-control-surface"
              onClick={() => {
                setQuery("");
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>

        {pBlock}
      </SidebarGroup>
    </SidebarContent>
  );
}
