// A "Connect Gmail" chip: on a proposal or starter card ("works best with"), or inside a blob's own chat. Click it and the
// app's own sign-in page opens in your browser; the chip flips to connected by itself. When it belongs to a blob
// (`blobId`), connecting also allows that app for that blob (and only that app, only that blob).
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, PlugIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/util/utils";
import { toastManager } from "../../ui/toast";
import { ConnectDialog } from "./ConnectDialog";
import { useAppsApi } from "./appsApi";
import { activeAccountsOf, refreshAppsBrief, useAppsBrief } from "./appsBrief";
import { useConnectApp } from "./useConnectApp";
import { useGrantToolkit } from "./useGrantToolkit";

/** "Google Calendar" -> "googlecalendar" (Composio's slugs are the name without spaces or punctuation). */
function appSlug(nameOrSlug: string): string {
  return nameOrSlug.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function ConnectChip(props: {
  /** A toolkit slug ("gmail") or its display name ("Google Calendar"). */
  readonly app: string;
  /** Shown on the chip; defaults to `app`. */
  readonly label?: string;
  /** Inside this blob's context: connecting (or tapping Allow) allows the app for it. */
  readonly blobId?: string;
  readonly blobName?: string;
  readonly className?: string;
}) {
  const slug = appSlug(props.app);
  const name = props.label ?? props.app;
  const navigate = useNavigate();
  const api = useAppsApi();
  const brief = useAppsBrief();
  const { isGranted, grant } = useGrantToolkit();
  const [granting, setGranting] = useState(false);

  const connect = useConnectApp(async (toolkit) => {
    await refreshAppsBrief(api);
    if (props.blobId) {
      const r = await grant(props.blobId, toolkit);
      if (!r.ok)
        toastManager.add({
          type: "error",
          title: `Could not allow ${name}`,
          description: r.message,
        });
    }
  });

  const have = activeAccountsOf(brief, slug);
  const connected = have.length > 0;
  const allowed = props.blobId ? isGranted(props.blobId, slug) : true;
  const base =
    "inline-flex items-center gap-1 rounded-full px-2 py-px text-[11.5px] leading-4 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

  const chip = (() => {
    if (connected && allowed) {
      return (
        <span
          data-connect-chip={slug}
          data-chip-state="connected"
          className={cn(base, "bg-success/10 text-success-foreground", props.className)}
        >
          <CheckIcon className="size-3" aria-hidden />
          {name} connected
        </span>
      );
    }
    if (connected && !allowed && props.blobId) {
      return (
        <button
          type="button"
          disabled={granting}
          data-connect-chip={slug}
          data-chip-state="allow"
          onClick={async () => {
            setGranting(true);
            const r = await grant(props.blobId!, slug);
            setGranting(false);
            if (!r.ok)
              toastManager.add({
                type: "error",
                title: `Could not allow ${name}`,
                description: r.message,
              });
          }}
          className={cn(
            base,
            "border border-border text-foreground/90 hover:bg-accent/60",
            props.className,
          )}
        >
          <PlugIcon className="size-3" aria-hidden />
          Allow {name}
          {props.blobName ? ` for ${props.blobName}` : ""}
        </button>
      );
    }
    return (
      <button
        type="button"
        data-connect-chip={slug}
        data-chip-state={brief.notSetUp ? "not-set-up" : "connect"}
        aria-description={
          brief.notSetUp
            ? "Connected apps aren't set up yet. This opens the Apps page to show how."
            : undefined
        }
        onClick={() => {
          if (brief.notSetUp) void navigate({ to: "/apps" });
          else void connect.connect(slug, null);
        }}
        className={cn(
          base,
          "border border-dashed border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
          props.className,
        )}
      >
        <PlugIcon className="size-3" aria-hidden />
        Connect {name}
      </button>
    );
  })();

  return (
    <>
      {chip}
      <ConnectDialog
        phase={connect.phase}
        appName={name}
        onClose={connect.reset}
        onRetry={() => void connect.connect(slug, null)}
        onSettings={() => {
          connect.reset();
          void navigate({ to: "/settings/connections" });
        }}
      />
    </>
  );
}
