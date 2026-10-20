import { resolveProjectPrefs } from "@kora/shared/projectPrefs";
import { Link } from "@tanstack/react-router";
import { ShieldIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryPrefs } from "../../hooks/usePrefs";
import { cn } from "../../util/utils";

const DISMISSED_KEY = "kora:full-access-note-dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    /* private window: the note just shows again next time */
  }
}

/**
 * Kora's default permission is Full access (a product choice): agents edit files and run commands without asking.
 * Said once, calmly, with where to change it — on the first-run screen, and in a new project's chat until the user
 * clicks "Got it". Renders nothing when the default is anything else.
 */
export function FullAccessNote({
  className,
  dismissible = false,
}: {
  readonly className?: string;
  readonly dismissible?: boolean;
}) {
  const defaultMode = usePrimaryPrefs(
    (settings) => resolveProjectPrefs(settings, null).settings.defaultRuntimeMode,
  );
  const [dismissed, setDismissed] = useState(readDismissed);
  if (defaultMode !== "full-access" || (dismissible && dismissed)) return null;
  return (
    <p
      data-full-access-note
      className={cn(
        "mx-auto flex max-w-xl items-start justify-center gap-2 text-start text-muted-foreground text-xs leading-5",
        className,
      )}
    >
      <ShieldIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        Your agents work with full access in your projects: they edit files and run commands without
        asking each time. To have them ask first, change Permissions in the model menu or in{" "}
        <Link to="/settings/general" className="text-foreground underline-offset-2 hover:underline">
          Settings
        </Link>
        .
        {dismissible ? (
          <>
            {" "}
            <button
              type="button"
              data-full-access-note-dismiss
              onClick={() => {
                writeDismissed();
                setDismissed(true);
              }}
              className="text-foreground underline-offset-2 hover:underline"
            >
              Got it
            </button>
          </>
        ) : null}
      </span>
    </p>
  );
}
