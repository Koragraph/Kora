// The Apps page: connect Gmail, Calendar, Slack and friends once, then allow them per blob. Top to bottom: what is
// wrong or used up (set-up card / cap card / unreachable notice), your connected accounts (labels, status, disconnect, add
// another), and the marketplace (search + categories). Everything works through the daemon's `blobs.apps.*`.

import { cn } from "~/util/utils";
import { isNative } from "~/env";
import { useConnectApp } from "./useConnectApp";
import { useAppsAccounts, useAppsCatalog, useAppsStatus } from "./useAppsData";
import {
  toolkitDisplayName,
  accountStatusWord,
  filterToolkits,
  MAX_ACCOUNTS,
  accountLabel,
  categoriesOf,
  accountsOf,
  isNotSetUp,
  errorCopy,
  capState,
  isActive,
} from "./appsModel";
import { refreshAppsBrief } from "./appsBrief";
import { type AppAccountWire, type AppToolkitWire, useAppsApi } from "./appsApi";
import { SetupGuide } from "./SetupGuide";
import { ConnectDialog } from "./ConnectDialog";
import { UsageMeter, CapCard } from "./CapCard";
import { ByoKeyField } from "./ByoKeyField";
import { AppTile } from "./AppTile";
import { toastManager } from "../../ui/toast";
import { Spinner } from "../../ui/spinner";
import { SidebarInset } from "../../ui/sidebar";
import { Input } from "../../ui/input";
import {
  DialogTitle,
  DialogFooter,
  Dialog,
  DialogPanel,
  DialogPopup,
  DialogHeader,
  DialogDescription,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { useAppSurfaceStore } from "../../assistant/surfaceStore";
import { SurfacePageHeader } from "../../SurfacePageHeader";
import { useEffect, useState, useMemo, useRef } from "react";
import { TriangleAlertIcon, RefreshCwIcon, SearchIcon, CheckIcon, PlusIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

function CategoryPill(props: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-[12px] leading-none font-medium whitespace-nowrap ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.active
          ? "bg-foreground text-background ring-foreground"
          : "text-muted-foreground ring-border/80 hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

export function AppsPage() {
  const api = useAppsApi();
  const navigate = useNavigate();
  const [, setSurface] = useAppSurfaceStore();
  useEffect(() => {
    setSurface("blobs"); // Apps lives beside the roster: the sidebar stays on Blobs
  }, [setSurface]);
  const { status, error: statusError, refresh: refreshStatus, set: setStatus } = useAppsStatus();
  const notSetUp = isNotSetUp(status) || statusError?.code === "not_configured";
  const ready = status !== null && !notSetUp;
  const { accounts, error: accountsError, refresh: refreshAccounts } = useAppsAccounts(ready);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const catalog = useAppsCatalog(ready, search);
  const [labelFor, setLabelFor] = useState<AppToolkitWire | null>(null);
  const [connectingName, setConnectingName] = useState("");
  const lastTry = useRef<{ toolkit: string; alias: string | null } | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const connectApp = useConnectApp(() => {
    void refreshAccounts();
    void refreshStatus();
    void refreshAppsBrief(api);
  });

  const nameOf = (slug: string) => toolkitDisplayName(slug, catalog.toolkits);
  const categories = useMemo(() => categoriesOf(catalog.toolkits), [catalog.toolkits]);
  const shown = useMemo(
    () => filterToolkits(catalog.toolkits, "", category),
    [catalog.toolkits, category],
  );

  const start = (toolkit: string, alias: string | null) => {
    lastTry.current = { toolkit, alias };
    setConnectingName(nameOf(toolkit));
    void connectApp.connect(toolkit, alias);
  };
  const connect = (t: AppToolkitWire) => {
    const have = accountsOf(accounts ?? [], t.slug);
    if (have.length >= MAX_ACCOUNTS) return;
    if (have.length > 0)
      setLabelFor(t); // a second account needs a label
    else start(t.slug, null);
  };

  const disconnect = async (a: AppAccountWire) => {
    const r = await api.disconnect(a.id);
    setDisconnecting(null);
    if (!r.ok)
      toastManager.add({ type: "error", title: "Could not disconnect", description: r.message });
    else toastManager.add({ type: "success", title: `${nameOf(a.toolkit)} disconnected` });
    void refreshAccounts();
    void refreshAppsBrief(api);
  };

  const connected = useMemo(() => {
    const by = new Map<string, AppAccountWire[]>();
    for (const a of accounts ?? []) by.set(a.toolkit, [...(by.get(a.toolkit) ?? []), a]);
    return [...by.entries()].sort((a, b) => nameOf(a[0]).localeCompare(nameOf(b[0])));
  }, [accounts, catalog.toolkits]);

  /** The broker no longer knows this install (a lost token): forget the identity and start clean. Linked accounts were already out of reach. */
  const resetConnection = async () => {
    const r = await api.resetBroker();
    if (!r.ok)
      toastManager.add({ type: "error", title: "Could not reset", description: r.message });
    else {
      setStatus(r.value);
      toastManager.add({
        type: "success",
        title: "Connection reset",
        description: "Connect your apps again.",
      });
    }
    void refreshStatus();
    void refreshAccounts();
    catalog.reload();
    void refreshAppsBrief(api);
  };

  const state = capState(status);
  // `status` itself answers (mode, key) even when the broker cannot: its own `error` says why the usage could not be read
  const statusProblem = status?.error ? { code: status.errorCode, message: status.error } : null;
  const apiError =
    accountsError ??
    catalog.error ??
    statusProblem ??
    (statusError && statusError.code !== "not_configured" ? statusError : null);

  return (
    <SidebarInset
      data-apps-page
      className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SurfacePageHeader electron={isNative} className="border-border/70 border-b">
          <h1 className="text-[15px] font-semibold tracking-tight">Apps</h1>
          <span className="hidden text-[12.5px] text-muted-foreground sm:inline">
            Connect once. Allow them blob by blob.
          </span>
        </SurfacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl space-y-8 px-5 py-6 sm:px-8">
            {status === null && !statusError ? (
              <div
                className="flex items-center gap-2 text-[13px] text-muted-foreground"
                data-apps-loading
              >
                <Spinner className="size-4" /> Loading…
              </div>
            ) : null}

            {notSetUp ? (
              <section
                className="rounded-2xl bg-card p-5 ring-1 ring-border/70"
                data-apps-not-set-up
              >
                <h2 className="text-[15px] font-semibold text-foreground">
                  Connected apps aren&rsquo;t set up yet
                </h2>
                <p className="mt-1 max-w-xl text-[13px] leading-snug text-muted-foreground">
                  Your blobs can read your email, check your calendar and post to Slack, through
                  Composio. To start, paste your own Composio key. It takes about two minutes.
                </p>
                <div className="mt-4 max-w-xl">
                  <ByoKeyField
                    status={status}
                    onStatus={(s) => {
                      setStatus(s);
                      void refreshAppsBrief(api);
                    }}
                    compact
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setGuideOpen((v) => !v)}
                  aria-expanded={guideOpen}
                  data-guide-toggle
                  className="mt-4 text-[12.5px] font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                >
                  {guideOpen ? "Hide the 2-minute guide" : "How do I get a key? 2-minute guide"}
                </button>
                {guideOpen ? (
                  <div className="mt-3 max-w-xl rounded-xl bg-background/60 p-4 ring-1 ring-border/60">
                    <SetupGuide />
                  </div>
                ) : null}
              </section>
            ) : null}

            {ready && state === "capped" && status ? (
              <CapCard
                status={status}
                onPasteKey={() => void navigate({ to: "/settings/connections" })}
              />
            ) : null}

            {apiError && !notSetUp ? (
              <div
                role="alert"
                data-apps-error={apiError.code ?? "error"}
                className="flex items-start gap-2.5 rounded-xl bg-card p-3.5 text-[13px] ring-1 ring-warning/30"
              >
                <TriangleAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-warning-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground">
                    {errorCopy(apiError.code, apiError.message).title}
                  </div>
                  <div className="text-muted-foreground">
                    {errorCopy(apiError.code, apiError.message).body}
                  </div>
                </div>
                {errorCopy(apiError.code, apiError.message).action === "reconnect" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void resetConnection()}
                    data-apps-reset
                  >
                    Reset connection
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      void refreshStatus();
                      void refreshAccounts();
                      catalog.reload();
                    }}
                  >
                    <RefreshCwIcon /> Retry
                  </Button>
                )}
              </div>
            ) : null}

            {ready && state !== "capped" && status ? (
              <UsageMeter status={status} className="max-w-md" />
            ) : null}

            {ready ? (
              <section aria-label="Connected accounts" data-apps-connected>
                <h2 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  Connected
                </h2>
                {accounts === null ? (
                  <div className="h-16 animate-pulse rounded-2xl bg-foreground/[0.04]" />
                ) : connected.length === 0 ? (
                  <p
                    className="rounded-2xl p-4 text-[13px] text-muted-foreground ring-1 ring-border/60 ring-inset"
                    data-apps-none
                  >
                    Nothing connected yet. Pick an app below. Your passwords never reach Kora: you
                    sign in on the app&rsquo;s own page.
                  </p>
                ) : (
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {connected.map(([slug, list]) => (
                      <li
                        key={slug}
                        data-connected-app={slug}
                        className="space-y-2.5 rounded-2xl bg-card p-3.5 ring-1 ring-border/70"
                      >
                        <div className="flex items-center gap-2.5">
                          <AppTile name={nameOf(slug)} size="sm" />
                          <div className="min-w-0 flex-1 text-[14px] font-medium text-foreground">
                            {nameOf(slug)}
                          </div>
                          <span className="text-[11.5px] tabular-nums text-muted-foreground">
                            {list.length} of {MAX_ACCOUNTS}
                          </span>
                        </div>
                        <ul className="divide-y divide-border/50">
                          {list.map((a) => {
                            const s = accountStatusWord(a);
                            return (
                              <li
                                key={a.id}
                                data-account={a.id}
                                className="py-2 first:pt-0 last:pb-0"
                              >
                                <div className="flex items-center gap-2 text-[13px]">
                                  <span
                                    className="min-w-0 flex-1 truncate font-medium text-foreground"
                                    data-account-label
                                  >
                                    {accountLabel(a)}
                                  </span>
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1 text-[11.5px]",
                                      s.tone === "good"
                                        ? "text-success-foreground"
                                        : s.tone === "wait"
                                          ? "text-warning-foreground"
                                          : "text-destructive-foreground",
                                    )}
                                    data-account-status
                                  >
                                    {s.tone === "good" ? (
                                      <CheckIcon className="size-3" aria-hidden />
                                    ) : null}
                                    {s.text}
                                  </span>
                                  {disconnecting === a.id ? null : (
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      onClick={() => setDisconnecting(a.id)}
                                      data-disconnect={a.id}
                                    >
                                      Disconnect
                                    </Button>
                                  )}
                                </div>
                                {disconnecting === a.id ? (
                                  <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-destructive/6 px-3 py-2 text-[12px]">
                                    <span>
                                      Disconnect {accountLabel(a)}? Blobs lose access to it.
                                    </span>
                                    <span className="flex gap-1">
                                      <Button
                                        size="xs"
                                        variant="destructive-outline"
                                        onClick={() => void disconnect(a)}
                                        data-disconnect-confirm
                                      >
                                        Disconnect
                                      </Button>
                                      <Button
                                        size="xs"
                                        variant="ghost"
                                        onClick={() => setDisconnecting(null)}
                                      >
                                        Keep
                                      </Button>
                                    </span>
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                        {list.length < MAX_ACCOUNTS ? (
                          <Button
                            size="xs"
                            variant="outline"
                            data-add-account={slug}
                            onClick={() =>
                              setLabelFor(
                                catalog.toolkits.find((t) => t.slug === slug) ?? {
                                  slug,
                                  name: nameOf(slug),
                                  description: "",
                                  logo: null,
                                  categories: [],
                                },
                              )
                            }
                          >
                            <PlusIcon /> Add another account
                          </Button>
                        ) : (
                          <p className="text-[11.5px] text-muted-foreground">
                            5 of 5 accounts. Disconnect one to add another.
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {ready ? (
              <section aria-label="Marketplace" data-apps-market>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    Marketplace
                  </h2>
                  <div className="relative w-full sm:w-72">
                    <SearchIcon
                      className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      nativeInput
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search apps"
                      aria-label="Search apps"
                      data-apps-search
                      className="ps-8"
                    />
                  </div>
                </div>
                {categories.length > 0 ? (
                  <div
                    className="mb-4 flex flex-wrap gap-1.5"
                    role="group"
                    aria-label="Categories"
                    data-apps-categories
                  >
                    <CategoryPill active={category === null} onClick={() => setCategory(null)}>
                      All
                    </CategoryPill>
                    {categories.map((c) => (
                      <CategoryPill
                        key={c}
                        active={category === c}
                        onClick={() => setCategory(category === c ? null : c)}
                      >
                        {c}
                      </CategoryPill>
                    ))}
                  </div>
                ) : null}
                {catalog.loading && catalog.toolkits.length === 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <div
                        key={i}
                        className="h-28 animate-pulse rounded-2xl bg-foreground/[0.04]"
                      />
                    ))}
                  </div>
                ) : shown.length === 0 ? (
                  <p className="py-8 text-center text-[13px] text-muted-foreground" data-apps-empty>
                    {search ? `No app matches “${search}”.` : "No apps in this category."}
                  </p>
                ) : (
                  <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-apps-grid>
                    {shown.map((t) => {
                      const have = accountsOf(accounts ?? [], t.slug).filter(isActive);
                      return (
                        <li
                          key={t.slug}
                          data-app-card={t.slug}
                          className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4 transition-colors hover:border-foreground/25"
                        >
                          <div className="flex items-start gap-3">
                            <AppTile name={t.name} />
                            <div className="min-w-0">
                              <h3 className="truncate text-[14px] font-semibold text-foreground">
                                {t.name}
                              </h3>
                              <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
                                {t.description || t.categories.join(" · ")}
                              </p>
                            </div>
                          </div>
                          <div className="mt-auto flex items-center justify-between gap-2">
                            <span className="truncate text-[11.5px] text-muted-foreground/80">
                              {t.categories.slice(0, 2).join(" · ")}
                            </span>
                            {have.length ? (
                              <span className="ml-auto inline-flex items-center gap-1 text-[12px] text-emerald-500">
                                <CheckIcon className="size-3.5" /> Connected
                              </span>
                            ) : null}
                            {have.length >= MAX_ACCOUNTS ? (
                              <span className="text-[12px] text-muted-foreground">5 of 5</span>
                            ) : (
                              <Button
                                size="xs"
                                variant={have.length ? "ghost" : "outline"}
                                onClick={() => connect(t)}
                                data-connect={t.slug}
                              >
                                {have.length ? "+ Add account" : "Connect"}
                              </Button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {catalog.hasMore ? (
                  <div className="mt-4 flex justify-center">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={catalog.loadMore}
                      disabled={catalog.loading}
                      data-apps-more
                    >
                      {catalog.loading ? <Spinner className="size-3.5" /> : null}
                      Show more apps
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        </div>
      </div>

      <LabelDialog
        toolkit={labelFor}
        existing={labelFor ? accountsOf(accounts ?? [], labelFor.slug) : []}
        onClose={() => setLabelFor(null)}
        onContinue={(alias) => {
          const t = labelFor;
          setLabelFor(null);
          if (t) start(t.slug, alias);
        }}
      />
      <ConnectDialog
        phase={connectApp.phase}
        appName={connectingName}
        onClose={connectApp.reset}
        onRetry={() => {
          const t = lastTry.current;
          if (t) start(t.toolkit, t.alias);
        }}
        onSettings={() => {
          connectApp.reset();
          void navigate({ to: "/settings/connections" });
        }}
      />
    </SidebarInset>
  );
}

/** A second (or later) account of the same app needs a label so a blob can say which one. */
function LabelDialog(props: {
  readonly toolkit: AppToolkitWire | null;
  readonly existing: ReadonlyArray<AppAccountWire>;
  readonly onClose: () => void;
  readonly onContinue: (alias: string) => void;
}) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (props.toolkit) setLabel("");
  }, [props.toolkit]);
  const taken = props.existing.some(
    (a) => (a.alias ?? "").trim().toLowerCase() === label.trim().toLowerCase(),
  );
  const mustLabel = props.existing.length > 0;
  const ok = label.trim().length > 0 && !taken;
  const used = new Set(props.existing.map((a) => (a.alias ?? "").toLowerCase()));
  return (
    <Dialog open={props.toolkit !== null} onOpenChange={(o) => !o && props.onClose()}>
      <DialogPopup className="sm:max-w-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) props.onContinue(label.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Add another {props.toolkit?.name ?? "account"}</DialogTitle>
            <DialogDescription>
              {mustLabel
                ? "Give it a label so a blob can tell which account to use."
                : "Optionally name this account."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2.5">
            <Input
              nativeInput
              autoFocus
              value={label}
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Work"
              aria-label="Account label"
              data-account-label-input
            />
            <div className="flex flex-wrap gap-1.5">
              {["Work", "Personal"]
                .filter((s) => !used.has(s.toLowerCase()))
                .map((s) => (
                  <CategoryPill key={s} active={label === s} onClick={() => setLabel(s)}>
                    {s}
                  </CategoryPill>
                ))}
            </div>
            {taken ? (
              <p className="text-[12px] text-destructive-foreground">
                You already have an account called {label.trim()}.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok} data-label-continue>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
