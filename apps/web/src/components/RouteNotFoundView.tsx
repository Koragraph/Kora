import { Link } from "@tanstack/react-router";

import { APP_DISPLAY_NAME } from "../branding";
import { LeadBlob } from "./thread/LeadBlob";
import { Button } from "./ui/button";

/** The page for an address nothing answers: an unknown path, or a thread link that resolves to nothing. */
export function RouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-xs flex-col items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-full bg-card">
          <LeadBlob mood="attentive" />
        </div>
        <h1 className="text-[15px] font-medium text-foreground">Nothing lives at this address</h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          The link may be from an older {APP_DISPLAY_NAME}, or the thread it pointed at is gone.
        </p>
        <Button size="sm" variant="outline" render={<Link to="/" replace />}>
          Back to threads
        </Button>
      </div>
    </main>
  );
}
