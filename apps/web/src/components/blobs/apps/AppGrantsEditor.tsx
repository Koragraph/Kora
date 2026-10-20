// The blob editor's "Apps" section: which connected apps this blob may use. None is the default (an imported or new blob
// can touch nothing); "All connected apps"; or "Choose": per app, the whole app with one switch, or single tools. Tools that
// send, post, delete or pay are marked "asks first": they ask you every time, whatever you allow here (only Full skips it).
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, ShieldAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/util/utils";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { AppTile } from "./AppTile";
import { useAppsApi, type AppToolWire } from "./appsApi";
import { activeAccountsOf, useAppsBrief } from "./appsBrief";
import {
  NO_GRANTS,
  appLabel,
  grantsAllowTool,
  grantsAllowToolkit,
  normalizeGrants,
  setToolGrant,
  setToolkitGrant,
  splitTools,
  toolWords,
  type AppGrants,
} from "./appsModel";

const MODES: ReadonlyArray<{ id: AppGrants["mode"]; label: string; body: string }> = [
  {
    id: "none",
    label: "No apps",
    body: "This blob cannot touch your connected apps. The safe default.",
  },
  {
    id: "all",
    label: "All connected apps",
    body: "Every app you connect, now and later. Sending still asks first.",
  },
  {
    id: "list",
    label: "Choose",
    body: "Pick the apps, or even single actions, this blob may use.",
  },
];

export function AppGrantsEditor(props: {
  readonly blobName: string;
  readonly grants: AppGrants;
  readonly onChange: (next: AppGrants) => void;
}) {
  const brief = useAppsBrief();
  const navigate = useNavigate();
  const grants = normalizeGrants(props.grants);
  const connected = useMemo(() => {
    const slugs = new Set<string>();
    for (const a of brief.accounts)
      if (a.status.toUpperCase() === "ACTIVE") slugs.add(a.toolkit.toLowerCase());
    return [...slugs].sort();
  }, [brief.accounts]);

  const setMode = (mode: AppGrants["mode"]) => {
    if (mode === grants.mode) return;
    if (mode === "none") props.onChange(NO_GRANTS);
    else if (mode === "all") props.onChange({ mode: "all", allow: [] });
    // from "all" to "Choose" every connected app stays allowed as a whole: narrowing starts from what it had
    else
      props.onChange({
        mode: "list",
        allow: grants.mode === "all" ? connected.map((c) => `toolkit:${c}`) : [],
      });
  };

  if (!brief.loaded) {
    return (
      <div
        className="flex items-center gap-2 text-[12.5px] text-muted-foreground"
        data-grants-loading
      >
        <Spinner className="size-3.5" /> Loading your apps…
      </div>
    );
  }

  return (
    <div className="space-y-4" data-app-grants>
      {brief.notSetUp ? (
        <div
          className="rounded-xl bg-card p-3 text-[12.5px] leading-snug ring-1 ring-border"
          data-grants-not-set-up
        >
          <span className="font-medium text-foreground">
            Connected apps aren&rsquo;t set up yet.
          </span>{" "}
          <span className="text-muted-foreground">
            Paste your own Composio key first, then come back to choose what {props.blobName} may
            use.
          </span>
          <div className="mt-2">
            <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/apps" })}>
              Set up apps
            </Button>
          </div>
        </div>
      ) : null}

      <div role="radiogroup" aria-label="Apps this blob may use" className="grid gap-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={grants.mode === m.id}
            data-grant-mode={m.id}
            onClick={() => setMode(m.id)}
            className={cn(
              "flex items-start gap-3 rounded-xl p-3 text-left ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              grants.mode === m.id ? "bg-card ring-foreground/40" : "ring-border hover:bg-card/60",
            )}
          >
            <span
              className={cn(
                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ring-1",
                grants.mode === m.id ? "ring-foreground" : "ring-border",
              )}
            >
              {grants.mode === m.id ? <span className="size-2 rounded-full bg-foreground" /> : null}
            </span>
            <span>
              <span className="block text-[13px] font-medium text-foreground">
                {m.label}
                {m.id === "none" ? (
                  <span className="ms-1.5 text-[11px] font-normal text-muted-foreground">
                    default
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                {m.body}
              </span>
            </span>
          </button>
        ))}
      </div>

      {grants.mode !== "none" && !brief.notSetUp && connected.length === 0 ? (
        <p
          className="rounded-xl p-3 text-[12.5px] text-muted-foreground ring-1 ring-border"
          data-grants-no-apps
        >
          Nothing is connected yet.{" "}
          <button
            type="button"
            className="font-medium text-foreground underline underline-offset-2"
            onClick={() => void navigate({ to: "/apps" })}
          >
            Connect an app
          </button>{" "}
          and it shows up here.
        </p>
      ) : null}

      {grants.mode === "list" && connected.length > 0 ? (
        <ul className="space-y-2" data-grants-apps>
          {connected.map((slug) => (
            <ToolkitGrant
              key={slug}
              slug={slug}
              accounts={activeAccountsOf(brief, slug).length}
              grants={grants}
              onChange={props.onChange}
            />
          ))}
        </ul>
      ) : null}

      <p className="flex items-start gap-2 text-[11.5px] leading-snug text-muted-foreground">
        <ShieldAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
        Sending, posting, deleting and paying ask you first every time, whatever you allow here.
        Only a blob on Full skips that.
      </p>
    </div>
  );
}

function ToolkitGrant(props: {
  readonly slug: string;
  readonly accounts: number;
  readonly grants: AppGrants;
  readonly onChange: (next: AppGrants) => void;
}) {
  const api = useAppsApi();
  const { slug, grants } = props;
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<ReadonlyArray<AppToolWire> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || tools !== null) return;
    let live = true;
    void api.tools(slug).then((r) => {
      if (!live) return;
      if (r.ok) setTools(r.value);
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [open, tools, api, slug]);

  const slugs = tools?.map((t) => t.slug) ?? [];
  const whole = grantsAllowToolkit(grants, slug);
  const picked = tools ? tools.filter((t) => grantsAllowTool(grants, slug, t.slug)).length : 0;
  const some =
    !whole &&
    grants.allow.some(
      (e) =>
        !e.toLowerCase().startsWith("toolkit:") &&
        e.toUpperCase().startsWith(slug.toUpperCase().replace(/[^A-Z0-9]/g, "") + "_"),
    );
  const name = appLabel(slug);
  const parts = tools ? splitTools(tools) : null;

  return (
    <li data-grant-app={slug} className="rounded-xl bg-card ring-1 ring-border/80">
      <div className="flex items-center gap-2.5 p-3">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${name} actions`}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <AppTile name={name} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-foreground">{name}</span>
            <span className="block text-[11.5px] text-muted-foreground">
              {whole
                ? "All actions"
                : some
                  ? tools
                    ? `${picked} of ${tools.length} actions`
                    : "Some actions"
                  : "Off"}
              {props.accounts > 1 ? ` · ${props.accounts} accounts` : ""}
            </span>
          </span>
        </button>
        <label className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
          All of {name}
          <Switch
            size="sm"
            checked={whole}
            data-grant-whole={slug}
            onCheckedChange={(on) => props.onChange(setToolkitGrant(grants, slug, on, slugs))}
            aria-label={`Allow all of ${name}`}
          />
        </label>
      </div>
      {open ? (
        <div className="border-t border-border/60 px-3 py-2.5" data-grant-tools={slug}>
          {error ? (
            <p className="text-[12px] text-destructive-foreground">{error}</p>
          ) : parts === null ? (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Spinner className="size-3.5" /> Loading actions…
            </div>
          ) : (
            <div className="space-y-3">
              {[
                { title: "Reading and drafting", list: parts.reads },
                { title: "Asks you first", list: parts.asks },
              ]
                .filter((g) => g.list.length > 0)
                .map((g) => (
                  <div key={g.title}>
                    <div className="mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">
                      {g.title}
                    </div>
                    <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                      {g.list.map((t) => (
                        <li key={t.slug}>
                          <label className="flex cursor-pointer items-center gap-2 py-0.5 text-[12.5px] text-foreground/90">
                            <Checkbox
                              checked={grantsAllowTool(grants, slug, t.slug)}
                              data-grant-tool={t.slug}
                              onCheckedChange={(on) =>
                                props.onChange(
                                  setToolGrant(grants, slug, t.slug, on === true, slugs),
                                )
                              }
                            />
                            <span className="min-w-0 truncate">{t.name || toolWords(t.slug)}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}
