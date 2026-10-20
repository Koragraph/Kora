import { useEffect, useRef, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  useRouter,
  useParams,
  useLocation,
  redirect,
  createRootRoute,
  Outlet,
} from "@tanstack/react-router";
import { hostProjectKey, hostProjectRef } from "@kora/client-runtime/host";
import { useAtomValue } from "@effect/atom-react";

import {
  selectProjectGroupingPrefs,
  derivePhysicalProjectKeyFromPath,
  deriveLogicalProjectKeyFromPrefs,
} from "../workspace/logicalProject";
import { installShellPasteAsText } from "../util/shellPasteAsText";
import { configureClientTracing } from "../tracing/clientTracing";
import { resolveThreadPageRef } from "../thread/threadRoutes";
import { PlanAgentSelectionHeal } from "../thread/planAgentSelectionHeal";
import { useViewStateStore } from "../stores/uiStateStore";
import { PromptHandleContext } from "../promptHandleContext";
import { resolveInitialDaemonAuthGateState } from "../hosts/primary";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import { useClientPrefs } from "../hooks/usePrefs";
import { useCopyToClipboard } from "../hooks/useCopyText";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { BrowserMiniHost } from "../components/blobs/browser/pip/BrowserMiniHost";
import { Button } from "../components/ui/button";
import { LeadBlob } from "../components/thread/LeadBlob";
import type { ChatPromptHandle } from "../components/thread/ChatPrompt";
import { ShellLaunchCoordinator } from "../components/shell/ShellLaunchCoordinator";
import { UpdateReadyToastCoordinator } from "../components/nav/UpdateReady";
import { HireFlyInLayer } from "../components/blobs/gallery/HireFlyIn";
import { BlobsApiProviders } from "../components/blobs/BlobsApiProviders";
import { KoraSurfaceOnly } from "../components/kora/KoraSurfaceOnly";
import { TurnNotifications } from "../components/TurnNotifications";
import { SlowRpcRequestToastCoordinator } from "../components/SlowRequestToasts";
import { CustomSnoozeDialogHost } from "../components/SnoozeUntilDialog";
import { ConfirmDialogHost } from "../components/ConfirmDialogs";
import { RouteNotFoundView } from "../components/RouteNotFoundView";
import { AppNavLayout } from "../components/AppNavLayout";
import { isLegacyChatPath } from "../chatSurface";
import { formatDocumentTitle } from "../appTitle";
import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { primaryDaemonConfigAtom, primaryDaemonWelcomeAtom } from "../atoms/server";
import { readProjects, setActiveHostId, useThreadSummary } from "../atoms/entities";
import { applyAppearanceFontVariables } from "../appearance/appearanceFonts";
import { applyAppearanceContrast } from "../appearance/appearanceContrast";

export const Route = createRootRoute({
  head: () => ({ meta: [{ title: APP_DISPLAY_NAME }] }),
  notFoundComponent: RouteNotFoundView,
  errorComponent: RootRouteErrorView,
  component: RootRouteView,
  beforeLoad: async ({ location }) => {
    if (isLegacyChatPath(location.pathname)) throw redirect({ to: "/blobs", replace: true });
    return { authGateState: await resolveInitialDaemonAuthGateState() };
  },
});

// ---------- appearance + title sync ----------

function DocumentTitleSync() {
  const pathname = useLocation({ select: (l) => l.pathname });
  const routeParams = useParams({ strict: false });
  const threadTitle = useThreadSummary(resolveThreadPageRef(routeParams))?.title ?? null;

  useEffect(() => {
    document.title = formatDocumentTitle({
      appDisplayName: APP_DISPLAY_NAME,
      pathname,
      threadTitle,
    });
  }, [pathname, threadTitle]);
  return null;
}

function ContrastAppearanceSync() {
  const scheme = useClientPrefs((prefs) => prefs.diffColorScheme);
  const contrast = useClientPrefs((prefs) => prefs.appearanceContrast);
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-diff-color-scheme", scheme);
    applyAppearanceContrast(html, contrast);
  }, [scheme, contrast]);
  return null;
}

function GlassAppearanceSync() {
  const opacity = useClientPrefs((prefs) => prefs.glassOpacity);
  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--glass-opacity", `${opacity}%`);
    if (opacity === 100) style.setProperty("--glass-blur", "0px");
    else style.removeProperty("--glass-blur");
  }, [opacity]);
  return null;
}

function FontAppearanceSync() {
  const sans = useClientPrefs((prefs) => prefs.fontFamilySans);
  const codeFamily = useClientPrefs((prefs) => prefs.fontFamilyCode);
  const composer = useClientPrefs((prefs) => prefs.fontFamilyComposer);
  const sizeInterface = useClientPrefs((prefs) => prefs.fontSizeInterface);
  const sizePrompt = useClientPrefs((prefs) => prefs.fontSizePrompt);
  const sizeCode = useClientPrefs((prefs) => prefs.fontSizeCode);
  const smoothing = useClientPrefs((prefs) => prefs.fontSmoothing);
  useEffect(() => {
    applyAppearanceFontVariables(document.documentElement, {
      sans,
      code: codeFamily,
      composer,
      sizeInterface,
      sizePrompt,
      sizeCode,
      smoothing,
    });
  }, [sans, codeFamily, composer, sizeInterface, sizePrompt, sizeCode, smoothing]);
  return null;
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => void configureClientTracing(), []);
  return null;
}

// ---------- daemon events ----------

function EventRouter() {
  const router = useRouter();
  const cfg = useAtomValue(primaryDaemonConfigAtom);
  const welcome = useAtomValue(primaryDaemonWelcomeAtom);
  const groupingPrefs = useClientPrefs(selectProjectGroupingPrefs);
  const handledBootstrapThread = useRef<string | null>(null);

  useEffect(() => {
    if (cfg) setActiveHostId(cfg.environment.hostId);
  }, [cfg]);

  useEffect(() => {
    if (!welcome) return;
    setActiveHostId(welcome.environment.hostId);
    const { bootstrapProjectId, bootstrapThreadId } = welcome;
    if (!bootstrapProjectId || !bootstrapThreadId) return;

    try {
      const hostKey = welcome.environment.hostId;
      const projKey = hostProjectRef(hostKey, bootstrapProjectId);
      const proj = readProjects().find(
        (candidate) => candidate.hostId === hostKey && candidate.id === bootstrapProjectId,
      );
      const keyName = proj
        ? deriveLogicalProjectKeyFromPrefs(proj, groupingPrefs)
        : welcome.cwd
          ? derivePhysicalProjectKeyFromPath(hostKey, welcome.cwd)
          : hostProjectKey(projKey);
      useViewStateStore.getState().setProjectExpanded(keyName, true);

      const handledKey = `${hostKey}:${bootstrapThreadId}`;
      if (router.state.location.pathname === "/" && handledBootstrapThread.current !== handledKey) {
        handledBootstrapThread.current = handledKey;
        void router
          .navigate({
            to: "/$hostId/$threadId",
            params: { hostId: hostKey, threadId: bootstrapThreadId },
            replace: true,
          })
          .catch(() => undefined);
      }
    } catch {
      /* the landing page still works without the jump */
    }
  }, [groupingPrefs, router, welcome]);

  return null;
}

// ---------- shell ----------

function RootRouteView() {
  const { authGateState } = Route.useRouteContext();
  const pathname = useLocation({ select: (l) => l.pathname });
  const promptHandle = useRef<ChatPromptHandle | null>(null);

  useEffect(() => installShellPasteAsText(window.shellBridge, window), []);
  useEffect(() => {
    const fr = requestAnimationFrame(() => syncBrowserChromeTheme());
    return () => cancelAnimationFrame(fr);
  }, [pathname]);

  // The diagnostics page has to work while the daemon is down, so it gets no providers.
  if (pathname === "/pair" || pathname === "/connect" || authGateState.status !== "authenticated") {
    return (
      <>
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <FontAppearanceSync />
        <GlassAppearanceSync />
        <ContrastAppearanceSync />
        <DocumentTitleSync />
        <AuthenticatedTracingBootstrap />
        <ShellLaunchCoordinator />
        <TurnNotifications />
        <UpdateReadyToastCoordinator />
        <ConfirmDialogHost />
        <KoraSurfaceOnly>
          <HireFlyInLayer />
        </KoraSurfaceOnly>
        <CustomSnoozeDialogHost />
        <SlowRpcRequestToastCoordinator />
        <EventRouter />
        <PlanAgentSelectionHeal />
        <BlobsApiProviders>
          <PromptHandleContext value={promptHandle}>
            <AppNavLayout>
              <Outlet />
            </AppNavLayout>
            <KoraSurfaceOnly>
              <BrowserMiniHost />
            </KoraSurfaceOnly>
          </PromptHandleContext>
        </BlobsApiProviders>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

// ---------- not found + crash ----------

function Avatar({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-9 items-center justify-center rounded-full bg-card">{children}</div>
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message || "";
  if (typeof err === "string") return err;
  if (err === undefined || err === null) return "";
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return "";
  }
}

function headline(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "A screen failed to load and did not say why.";
}

function buildCrashReport(err: unknown, pathname: string): string {
  const describe = (value: unknown) =>
    describeError(value) || "No additional error details are available.";
  const stamp = new Date().toISOString();
  const header = [`${APP_DISPLAY_NAME} ${APP_VERSION}`, `Path: ${pathname}`, "Time: " + stamp];
  const sections = [describe(err)];
  const causeOf = (value: unknown) => (value instanceof Error ? value.cause : undefined);
  for (let cause = causeOf(err), depth = 0; depth < 5 && cause != null; depth++) {
    sections.push("", "Caused by:", describe(cause));
    cause = causeOf(cause);
  }
  return [...header, "", ...sections].join("\n");
}

function RootRouteErrorView({ error }: { error: unknown }) {
  const router = useRouter();
  const report = buildCrashReport(error, router.state.location.pathname);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-report" });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-5 py-10 text-foreground">
      <section className="flex w-full max-w-lg flex-col items-start gap-4">
        <Avatar>
          <LeadBlob mood="asleep" />
        </Avatar>
        <div>
          <h1 className="text-lg font-medium tracking-tight">
            {APP_DISPLAY_NAME} tripped over this screen.
          </h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {headline(error)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void router.invalidate()}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
            Restart the window
          </Button>
          <Button size="sm" variant="ghost" onClick={() => copyToClipboard(report, undefined)}>
            {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
            {isCopied ? "Copied" : "Copy the report"}
          </Button>
        </div>
        <details className="w-full text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            What went wrong, in full
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-card px-3 py-2 text-foreground/85">
            {report}
          </pre>
        </details>
      </section>
    </div>
  );
}
