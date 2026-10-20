import { Suspense, useCallback, useState } from "react";
import { Undo2 } from "lucide-react";
import {
  useNavigate,
  useLocation,
  redirect,
  createFileRoute,
  Outlet,
  Navigate,
} from "@tanstack/react-router";

import { isNative } from "../env";
import { Skeleton } from "../components/ui/skeleton";
import { SidebarInset } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { usePrefsProjectGroups } from "../components/prefs/usePrefsProjectGroups";
import {
  getPrefsSearchTargetScope,
  isPrefsSearchScopeAvailable,
} from "../components/prefs/prefsSearch";
import {
  retainPrefsScope,
  validatePrefsRouteSearch,
} from "../components/prefs/prefsScopeNavigation";
import type { PrefsScopeSearch } from "../components/prefs/prefsScope";
import { PrefsScopeNotice } from "../components/prefs/PrefsScopeNotice";
import { PrefsScopeProvider, usePrefsScope } from "../components/prefs/PrefsScopeContext";
import { usePrefsRestore } from "../components/prefs/PrefsPanels";
import { PrefsPageHeader } from "../components/prefs/PrefsPageHeader";
import { SurfacePageHeader } from "../components/SurfacePageHeader";
import { useHosts } from "../atoms/hosts";

// Pages that only make sense for this device or machine hide the scope selector.
const DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/diagnostics",
  "/settings/usage",
  "/settings/blobs",
  "/settings/connections",
  "/settings/outside",
  "/settings/engines",
]);
const MACHINE_PATHS: ReadonlySet<string> = new Set([
  "/settings/providers",
  "/settings/swarm",
  "/settings/extensions",
]);

const KNOWN_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/token-savings",
  "/settings/providers",
  "/settings/extensions",
  "/settings/swarm",
  "/settings/projects",
  "/settings/usage",
  ...DEVICE_ONLY_PATHS,
]);

const normalizePath = (pathname: string) => pathname.replace(/\/+$/, "") || "/";

export const Route = createFileRoute("/settings")({
  validateSearch: validatePrefsRouteSearch,
  search: { middlewares: [retainPrefsScope] },
  beforeLoad: ({ context, location }) => {
    const loc = normalizePath(location.pathname);
    // Diagnostics is the one page that still works when the local service is down: it says why.
    if (context.authGateState.status !== "authenticated" && loc !== "/settings/diagnostics") {
      throw redirect({ to: "/settings/diagnostics", replace: true });
    }
    if (loc === "/settings" || !KNOWN_PATHS.has(loc)) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: PrefsRouteLayout,
  // Hard load of an address no settings page owns.
  notFoundComponent: () => <Navigate to="/settings/general" replace />,
});

function ScopeBoundary({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const { scope, connectedHosts } = usePrefsScope();
  const hash = useLocation({ select: (l) => l.hash });
  const loc = normalizePath(pathname);

  if (DEVICE_ONLY_PATHS.has(loc) || loc === "/settings/projects") return <>{children}</>;

  const dest = hash ? getPrefsSearchTargetScope(hash) : null;
  if (dest && !isPrefsSearchScopeAvailable(dest.scope, scope.kind)) {
    const required = dest.scope;
    const noticeTarget =
      required === "environment" || required === "project" || required === "checkout"
        ? required
        : "all";
    return (
      <PrefsScopeNotice target={noticeTarget} targetId={hash}>
        {`${dest.title} is not available for the selected target. Choose its owning scope to continue.`}
      </PrefsScopeNotice>
    );
  }
  if (scope.kind === "unavailable") {
    return <p className="p-8 text-sm text-muted-foreground">{scope.message}</p>;
  }
  if (scope.kind === "environment" && connectedHosts.length === 0) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        Reconnect {scope.label} to change its settings.
      </p>
    );
  }
  return <>{children}</>;
}

function SettingsSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading settings"
      data-prefs-skeleton
      className="mx-auto w-full max-w-3xl space-y-4 px-6 py-8"
    >
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function PrefsRouteLayout() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });

  const selectScope = useCallback(
    (upcoming: PrefsScopeSearch) => {
      void navigate({
        to: pathname,
        // All three axes are sent so "all" (key absence) still counts as an explicit choice.
        search: {
          project: upcoming.project,
          machine: upcoming.machine,
          checkout: upcoming.checkout,
        },
        hash: undefined,
        resetScroll: false,
      } as never);
    },
    [navigate, pathname],
  );

  // An address under /settings that no page owns (client-side navigation skips beforeLoad's match): first page.
  // Only for /settings addresses: while you LEAVE Settings this layout still renders once with the new address, and
  // treating that as "unknown settings page" bounced every Back straight into Defaults (you could never leave).
  const loc = normalizePath(pathname);
  const underSettings = loc === "/settings" || loc.startsWith("/settings/");
  if (underSettings && !KNOWN_PATHS.has(loc)) {
    return <Navigate to="/settings/general" replace />;
  }

  return (
    <PrefsScopeProvider search={search} onChange={selectScope}>
      <PrefsLayoutBody search={search} pathname={pathname} selectScope={selectScope} />
    </PrefsScopeProvider>
  );
}

// Everything that reads the scope lives below the provider.
function PrefsLayoutBody(props: {
  search: PrefsScopeSearch;
  pathname: string;
  selectScope: (upcoming: PrefsScopeSearch) => void;
}) {
  const { search, pathname, selectScope } = props;
  const groups = usePrefsProjectGroups();
  const { environments } = useHosts();
  const [restoreCount, setRestoreCount] = useState(0);
  const { changedSettingLabels, restoreDefaults } = usePrefsRestore(() =>
    setRestoreCount((n) => n + 1),
  );
  const loc = normalizePath(pathname);
  const showScope = !DEVICE_ONLY_PATHS.has(loc) && !MACHINE_PATHS.has(loc);
  const changeCount = changedSettingLabels.length;

  return (
    <>
      <SidebarInset
        data-prefs-surface
        className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          <SurfacePageHeader electron={isNative} className="border-b border-border/70">
            <div className="flex w-full items-center gap-3">
              <PrefsPageHeader
                pathname={pathname}
                {...(showScope
                  ? { scope: { value: search, groups, environments, onChange: selectScope } }
                  : {})}
              />
              {(loc === "/settings/general" || loc === "/settings/token-savings") &&
              changeCount > 0 ? (
                <div className="ms-auto flex shrink-0 items-center">
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label="Back to Kora defaults"
                    title={changedSettingLabels.join(", ")}
                    onClick={() => void restoreDefaults()}
                  >
                    <Undo2 className="size-3.5" />
                    {/* Icon-only on a phone: the label covered the scope picker at 375 px (pl9 S3-1). It resets to
                        Kora's defaults (it never was an undo of your last edits). */}
                    <span className="hidden sm:inline">{`Reset ${changeCount} to defaults`}</span>
                  </Button>
                </div>
              ) : null}
            </div>
          </SurfacePageHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <ScopeBoundary pathname={pathname}>
              <Suspense fallback={<SettingsSkeleton />}>
                <Outlet key={`${JSON.stringify(search)}:${restoreCount}`} />
              </Suspense>
            </ScopeBoundary>
          </div>
        </div>
      </SidebarInset>
    </>
  );
}
