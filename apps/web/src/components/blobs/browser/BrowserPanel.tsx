// The Computer tab of a blob's side panel: its own browser, live. You watch it work, step in with the mouse and keyboard
// (the blob pauses until you "Hand back"), approve the things it must ask about (buy / book / send) right here, and see
// a calm one-time setup when the browser has not been downloaded yet.
import {
  ChevronsLeftRightIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorIcon,
  PowerIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/util/utils";
import { BrowserViewport } from "./BrowserViewport";
import { InstallScreen } from "./InstallScreen";
import {
  ApprovalBar,
  ReconnectingNote,
  StageNote,
  StatusChip,
  TabStrip,
  TakeoverBanner,
  UrlPill,
  useNow,
} from "./parts";
import { deriveStatus, footerHint, handBackRemaining, isEmptyPage } from "./browserModel";
import { useBrowserEngine } from "./useBrowserEngine";
import { useLiveBrowser } from "./useLiveBrowser";
import { usePipStore } from "./pip/pipStore";

export function BrowserPanel(props: { readonly blobId: string; readonly blobName: string }) {
  const { blobId, blobName } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useLiveBrowser(blobId, canvasRef);
  const { state } = live;
  const [expanded, setExpanded] = useState(false);
  const [answered, setAnswered] = useState<string | null>(null);
  // the floating mini-window steps aside while this full pane is open (one live socket per blob)
  useEffect(() => usePipStore.getState().paneMounted(blobId), [blobId]);

  // Re-evaluate when the "Working" hold after the agent's last call runs out.
  const holding = state.workedUntil > Date.now();
  const statusNow = useNow(holding, 500);
  const view = deriveStatus(state, holding ? statusNow : Date.now());
  const activeTab = state.tabs.find((t) => t.active) ?? state.tabs[0] ?? null;
  const driving = state.controller === "user" && state.youControl;
  const watchingOnly = state.controller === "user" && !state.youControl;
  const approval = state.approvals[0] ?? null;
  // Setup is asked over plain HTTP, so it shows even when the live socket never opens (no page exists before the engine does);
  // the socket's own engine/install frames only refine it.
  const engine = useBrowserEngine();
  const httpEngine = engine.snapshot;
  const engineInfo = httpEngine ?? state.engine;
  // the socket's frames are the live ones while it is open; over plain HTTP the daemon's own answer carries the same progress
  const installState =
    state.install.state !== "idle" ? state.install : (httpEngine?.install ?? state.install);
  const needsInstall = engineInfo !== null && !engineInfo.installed;

  // The countdown only ticks while the user drives; the daemon's own timer is the authority, this just shows it. It runs
  // from the last input, or from the moment control changed hands when nothing was typed yet (a tab click).
  const [drivingSince, setDrivingSince] = useState(0);
  useEffect(() => setDrivingSince(driving ? Date.now() : 0), [driving]);
  const now = useNow(driving, 250);
  const remaining = handBackRemaining({
    driving,
    lastInputAt: Math.max(live.lastInputAt, drivingSince),
    releaseAfterMs: state.releaseAfterMs,
    now,
  });

  useEffect(() => {
    if (!approval || approval.id !== answered)
      setAnswered((a) => (a && state.approvals.some((x) => x.id === a) ? a : null));
  }, [approval, answered, state.approvals]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.activeElement !== canvasRef.current) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const handBack = useCallback(() => live.send({ t: "release" }), [live]);
  const answer = useCallback(
    (allow: boolean) => {
      if (!approval) return;
      setAnswered(approval.id);
      live.send({ t: "approve", id: approval.id, allow });
    },
    [approval, live],
  );
  const install = engine.start;
  // the engine just arrived (install finished): the live socket was never useful before, connect it afresh
  const wasMissing = useRef(false);
  useEffect(() => {
    if (needsInstall) wasMissing.current = true;
    else if (wasMissing.current && engineInfo?.installed) {
      wasMissing.current = false;
      live.retry();
    }
  }, [needsInstall, engineInfo?.installed, live]);

  if (needsInstall) {
    return (
      <div className="h-full">
        <InstallScreen
          name={blobName}
          engine={engineInfo}
          install={installState}
          onInstall={install}
        />
      </div>
    );
  }

  const empty = isEmptyPage(state);
  const showPicture = state.hasFrame && !empty;
  const offline = state.connection !== "open";

  return (
    <>
      {expanded ? (
        <div
          className="fixed inset-0 z-40 bg-black/60"
          aria-hidden
          onClick={() => setExpanded(false)}
        />
      ) : null}
      <section
        aria-label={`${blobName}'s browser`}
        className={cn(
          "flex flex-col gap-2.5 p-3",
          expanded
            ? "fixed inset-5 z-50 rounded-2xl border border-border bg-background shadow-2xl"
            : "h-full",
        )}
        data-browser-panel
        data-browser-connection={state.connection}
        data-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <UrlPill
            url={activeTab?.url ?? ""}
            title={activeTab?.title ?? ""}
            placeholder={empty ? "No page open" : "…"}
          />
          <StatusChip view={view} />
          <button
            type="button"
            aria-label={expanded ? "Shrink the browser" : "Make the browser bigger"}
            onClick={() => setExpanded((v) => !v)}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </button>
        </div>

        <TabStrip
          tabs={state.tabs}
          disabled={watchingOnly || offline}
          onPick={(index) => live.send({ t: "tab", index })}
        />

        {driving ? (
          <TakeoverBanner
            name={blobName}
            remainingMs={remaining}
            releaseAfterMs={state.releaseAfterMs}
            onHandBack={handBack}
          />
        ) : null}
        {watchingOnly || state.busyNotice ? (
          <div
            className="flex items-center gap-2 rounded-xl bg-card px-3 py-2 text-[12px] text-muted-foreground ring-1 ring-border/70"
            role="status"
            data-browser-watching
          >
            <ChevronsLeftRightIcon className="size-3.5 shrink-0" aria-hidden />
            <span>{state.busyNotice ?? "Another Kora window is driving this browser."}</span>
          </div>
        ) : null}
        {approval ? (
          <ApprovalBar
            name={blobName}
            approval={approval}
            more={state.approvals.length - 1}
            answered={answered === approval.id}
            onAnswer={answer}
          />
        ) : null}

        <div
          className={cn(
            "relative min-h-0 overflow-hidden rounded-xl ring-1",
            showPicture ? "bg-black" : "bg-card",
            driving ? "ring-foreground/50" : "ring-border/70",
            expanded ? "flex-1" : "aspect-[16/10] w-full",
          )}
          data-browser-stage
        >
          <BrowserViewport
            canvasRef={canvasRef}
            viewport={state.viewport}
            canDrive={!offline && state.running && !watchingOnly && showPicture}
            driving={driving}
            visible={showPicture}
            label={`${blobName}'s browser. Click to take over.`}
            onSend={live.send}
            onInput={live.noteInput}
          />
          {empty && !offline ? (
            <StageNote
              icon={<MonitorIcon className="size-5 text-muted-foreground" />}
              title={`${blobName} hasn't opened a page yet`}
            >
              When it browses, you'll watch it here and can step in any time.
            </StageNote>
          ) : null}
          {!empty && !state.running && !offline ? (
            <StageNote
              tone="veil"
              icon={<PowerIcon className="size-4 text-muted-foreground" />}
              title="Browser closed"
            >
              It wakes up the next time {blobName} needs the web.
            </StageNote>
          ) : null}
          {offline ? (
            <ReconnectingNote
              unavailable={state.connection === "unavailable"}
              onRetry={live.retry}
            />
          ) : null}
        </div>

        <div className="flex min-h-6 items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
          <span className="min-w-0 truncate" data-browser-hint>
            {footerHint(view, {
              running: state.running,
              showPicture,
              driving,
              watchingOnly,
              approval: !!approval,
              name: blobName,
            })}
          </span>
          {state.running ? (
            <button
              type="button"
              onClick={() => live.send({ t: "close" })}
              data-browser-close
              className="h-6 shrink-0 rounded-md px-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Close browser
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}
