// "Setting up the blob browser": the one-time download of the private browser a blob uses. Calm and honest about size;
// progress is real (the daemon reports bytes), failure is a sentence and a retry, success simply goes away.

import { cn } from "~/util/utils";
import { Button } from "~/components/ui/button";
import {
  downloadSizeLabel,
  type InstallState,
  installLabel,
  type EngineInfo,
} from "./browserModel";
import { DownloadIcon, MonitorIcon } from "lucide-react";

export function InstallScreen(props: {
  readonly name: string;
  readonly engine: EngineInfo | null;
  readonly install: InstallState;
  readonly onInstall: () => void;
}) {
  const { install, engine } = props;
  const running = install.state === "running";
  const failed = install.state === "error";
  const size = downloadSizeLabel(engine);
  const unsupported = engine !== null && !engine.supported;
  const pct = Math.round(Math.min(1, Math.max(0, install.fraction)) * 100);

  return (
    <div
      className="flex h-full min-h-[340px] flex-col items-center justify-center gap-3 px-8 pb-10 text-center"
      data-browser-install={install.state}
    >
      <span className="grid size-12 place-items-center rounded-2xl bg-card text-muted-foreground ring-1 ring-border/70">
        <MonitorIcon className="size-5" />
      </span>
      <div>
        <h3 className="text-[14px] font-medium text-foreground">
          {running ? "Setting up the blob browser" : "Give blobs a browser"}
        </h3>
        <p className="mx-auto mt-1 max-w-[270px] text-[12.5px] leading-snug text-muted-foreground">
          {unsupported
            ? "A blob's browser isn't available on this Mac yet."
            : running
              ? `One time only. It stays on this Mac, and ${props.name} is the only one who uses it.`
              : `${props.name} can look things up on the web in a private browser of its own, and you can watch it work and step in. It needs a one-time download (${size}).`}
        </p>
      </div>

      {running ? (
        <div className="w-full max-w-[260px]">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-card ring-1 ring-border/70"
            aria-label="Setting up the blob browser"
            aria-valuenow={pct}
            aria-valuemax={100}
            role="progressbar"
            aria-valuemin={0}
          >
            <div
              className={cn(
                "h-full rounded-full bg-foreground transition-[width] duration-200",
                install.total === 0 && "w-1/4 animate-pulse",
              )}
              style={install.total > 0 ? { width: `${pct}%` } : undefined}
            />
          </div>
          <p className="mt-2 text-[11.5px] text-muted-foreground" data-browser-install-label>
            {installLabel(install)}
          </p>
        </div>
      ) : null}

      {failed ? (
        <p
          className="max-w-[270px] text-[12px] leading-snug text-muted-foreground"
          role="alert"
          data-browser-install-error
        >
          Setup didn't finish. {installLabel(install)}
        </p>
      ) : null}

      {!running && !unsupported ? (
        <Button size="sm" onClick={props.onInstall} data-browser-install-button>
          <DownloadIcon className="size-3.5" />
          {failed ? "Try again" : `Set up (${size})`}
        </Button>
      ) : null}
    </div>
  );
}
