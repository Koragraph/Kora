import { Button } from "~/components/ui/button";
import { LeadBlob } from "~/components/thread/LeadBlob";
import { describeWebError } from "./errorCodeMessages";
import { thisComputer } from "../../util/utils";

interface Props {
  /** Stringified Chromium error, e.g. "ERR_NAME_NOT_RESOLVED". */
  description: string;
  /** Chromium net error code, e.g. -105. */
  code: number;
  onReload: () => void;
  url: string;
}

function isLocalHost(host: string): boolean {
  return (
    /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|$)/.test(host) || host.endsWith(".localhost")
  );
}

/**
 * A page that did not load. Kora's take: the lead blob dozes beside one plain sentence, the
 * likeliest fix is spelled out up front (for a local address that is almost always "the dev
 * server is not running"), and the raw Chromium code stays small underneath for searching.
 */
export function WebUnreachable({ url, code, description, onReload }: Props) {
  const host = safeHost(url) ?? url;
  const friendly = describeWebError(description);
  const errorLabel = description.length > 0 ? description : `ERR_${Math.abs(code) || "FAILED"}`;
  const local = isLocalHost(host);

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-y-auto bg-background">
      <div className="m-auto flex w-full max-w-sm flex-col items-start gap-4 px-6 py-10">
        <span className="flex size-8 items-center justify-center rounded-full bg-card">
          <LeadBlob mood="asleep" />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-[15px] font-medium text-foreground">
            Couldn&rsquo;t open <span className="font-mono text-[14px]">{host}</span>
          </h1>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {friendly.charAt(0).toUpperCase() + friendly.slice(1)}.
          </p>
        </div>
        <p className="border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted-foreground">
          {local
            ? "Nothing is listening there. Start the dev server (or check its port), then try again."
            : `Check that the address is right and that ${thisComputer()} is online, then try again.`}
        </p>
        <div className="flex w-full items-center gap-3 pt-1">
          <Button type="button" size="sm" variant="outline" onClick={onReload}>
            Try again
          </Button>
          <code className="ms-auto truncate text-[10.5px] text-muted-foreground/70">
            {errorLabel}
          </code>
        </div>
      </div>
    </div>
  );
}

function safeHost(url: string): string | null {
  return URL.canParse(url) ? new URL(url).host : null;
}
