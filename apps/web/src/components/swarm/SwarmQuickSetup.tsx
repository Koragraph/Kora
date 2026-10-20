import {
  SWARM_PRIVACY_TEXT_ASSISTANT,
  SWARM_CONSENT_TEXT,
  SWARM_PRIVACY_TEXT,
} from "./SwarmPrivacyNotice";
import { looksOffline } from "./SwarmInstallPanel";
import { Spinner } from "../ui/spinner";
import {
  DialogPanel,
  DialogHeader,
  DialogTitle,
  DialogPopup,
  DialogFooter,
  DialogDescription,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { forgetFirstRunChecks, useFirstRunChecks, claudeStep } from "../onboarding/firstRunChecks";
import { ClaudeLoginButton } from "../onboarding/ClaudeLoginButton";
import { cn, thisComputer, yourComputer } from "../../util/utils";
import { useAtomAction } from "../../atoms/use-atom-command";
import { swarmHost } from "../../atoms/swarm";
import { SWARM_PRIVACY_NOTICE_VERSION, type SwarmStatus, type HostId } from "@kora/contracts";
import {
  type AtomActionResult,
  squashAtomActionFailure,
  isAtomActionInterrupted,
} from "@kora/client-runtime/store/runtime";
import { useEffect, useState, useRef } from "react";
import { CircleAlertIcon, ShieldIcon, CheckIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const ACTIVE_INSTALL = new Set(["downloading", "extracting", "verifying"]);

export type QuickRowState = "done" | "todo" | "busy" | "failed";
export interface QuickRow {
  readonly id: "opencode" | "models";
  readonly state: QuickRowState;
  readonly title: string;
  readonly detail: string;
  /** The running download's operation id (Cancel). */
  readonly cancelId?: string;
  readonly progress?: { readonly done: number; readonly total: number } | null;
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** What the sheet shows for OpenCode and the free models, from the live status (pure: tested). */
export function quickSetupRows(status: SwarmStatus, testing: boolean): readonly QuickRow[] {
  const oc = status.opencode;
  const install = status.install;
  let opencode: QuickRow;
  if (ACTIVE_INSTALL.has(install.phase)) {
    const total = install.totalBytes ?? null;
    opencode = {
      id: "opencode",
      state: "busy",
      title: "OpenCode, the open-source agent the free models run in",
      detail:
        install.phase === "downloading"
          ? `Downloading… ${mb(install.downloadedBytes)}${total ? ` of ${mb(total)}` : ""} MB`
          : install.phase === "extracting"
            ? "Unpacking…"
            : "Checking that it runs…",
      ...(install.operationId ? { cancelId: install.operationId } : {}),
      progress:
        install.phase === "downloading" && total ? { done: install.downloadedBytes, total } : null,
    };
  } else if (oc.installed && oc.versionOk) {
    opencode = {
      id: "opencode",
      state: "done",
      title: "OpenCode, the open-source agent the free models run in",
      detail: `Installed${oc.version ? ` (${oc.version})` : ""}.`,
    };
  } else if (install.phase === "failed") {
    opencode = {
      id: "opencode",
      state: "failed",
      title: "OpenCode, the open-source agent the free models run in",
      detail: looksOffline(install.message)
        ? "The download didn't go through: Kora couldn't reach GitHub. Check your internet connection (or VPN), then try again."
        : `The install didn't finish: ${install.message ?? "unknown error"}. Try again, or install it yourself from Settings → Swarm.`,
    };
  } else {
    opencode = {
      id: "opencode",
      state: "todo",
      title: "OpenCode, the open-source agent the free models run in",
      detail:
        oc.installed && !oc.versionOk
          ? `Kora updates it to ${install.version ?? "a newer version"} (your ${oc.version ?? "copy"} is too old).`
          : `Kora downloads it from GitHub${install.version ? ` (version ${install.version}, about 46 MB)` : ""} into its own folder. Nothing else on ${yourComputer()} changes.`,
    };
  }

  const zen = status.providers.find((p) => p.provider === "zen") ?? null;
  const otherSource = status.providers.some(
    (p) => p.provider !== "zen" && p.enabled && p.lastTest?.ok === true,
  );
  let models: QuickRow;
  if (testing) {
    models = {
      id: "models",
      state: "busy",
      title: "Free models",
      detail: "Checking that the free models answer…",
    };
  } else if (zen?.enabled && zen.lastTest?.ok) {
    const n = zen.lastTest.freeModels.length;
    models = {
      id: "models",
      state: "done",
      title: "Free models",
      detail: `${n} free model${n === 1 ? "" : "s"} ready. Kora picks one for each helper; you never have to choose.`,
    };
  } else if (zen?.enabled && zen.lastTest && !zen.lastTest.ok) {
    models = {
      id: "models",
      state: otherSource ? "done" : "failed",
      title: "Free models",
      detail: otherSource
        ? "OpenCode Zen isn't answering; your other provider takes over."
        : zen.lastTest.outcome === "unreachable" || looksOffline(zen.lastTest.message)
          ? "Kora couldn't reach the free models. Check your internet connection and try again, or add an OpenRouter key in Settings → Swarm."
          : `The free models didn't answer${zen.lastTest.message ? ` (${zen.lastTest.message})` : ""}. Try again in a minute, or add an OpenRouter key in Settings → Swarm.`,
    };
  } else if (!zen?.enabled && (otherSource || status.ready)) {
    models = {
      id: "models",
      state: "done",
      title: "Free models",
      detail: "Using the providers you set up in Settings → Swarm.",
    };
  } else {
    models = {
      id: "models",
      state: "todo",
      title: "Free models",
      detail: "Kora checks that OpenCode's free models answer, then picks one for each helper.",
    };
  }
  return [opencode, models];
}

function RowIcon({ state }: { readonly state: QuickRowState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
        state === "done"
          ? "bg-success/15 text-success"
          : state === "failed"
            ? "bg-warning/15 text-warning"
            : "bg-foreground/8 text-muted-foreground",
      )}
    >
      {state === "done" ? (
        <CheckIcon className="size-3" />
      ) : state === "busy" ? (
        <Spinner className="size-3" />
      ) : state === "failed" ? (
        <CircleAlertIcon className="size-3" />
      ) : (
        <span className="size-1.5 rounded-full bg-current" />
      )}
    </span>
  );
}

/**
 * When Zen free models are in use, recommend adding an OpenRouter or Cerebras key because Zen is rate limited per IP;
 * show the cooldown remaining if cooling data is present in status.
 */
export function ZenRateLimitBanner({
  status,
  className,
}: {
  readonly status: SwarmStatus;
  readonly className?: string;
}) {
  const zen = status.providers.find((p) => p.provider === "zen");
  if (!zen?.enabled) return null;

  const zenCooling = status.models.cooling.filter((c) => c.provider === "zen");
  const maxUntil = zenCooling.length > 0 ? Math.max(...zenCooling.map((c) => c.until)) : null;
  const now = Date.now();
  const remainingMs = maxUntil !== null ? maxUntil - now : null;
  const remainingMins =
    remainingMs !== null && remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 60_000)) : null;

  return (
    <div
      data-swarm-zen-banner
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/8 p-3 text-xs text-warning-foreground",
        className,
      )}
    >
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium text-foreground">
          {remainingMins !== null
            ? `Zen is rate limited per IP (${remainingMins}m cooldown remaining).`
            : "Zen free models are rate limited per IP."}
        </p>
        <p className="text-muted-foreground leading-5">
          Because OpenCode Zen free models share rate limits across your IP, we recommend adding an
          OpenRouter or Cerebras key in Settings → Swarm for reliable worker availability.
        </p>
      </div>
    </div>
  );
}

type Phase = "idle" | "running" | "failed";

/**
 * The first time Swarm is turned on: one sheet. One line on what it is, two rows that tick (OpenCode, free models),
 * the approved privacy notice, and ONE button that accepts the notice, downloads OpenCode when missing, checks the free
 * models and turns Swarm on for the thread that asked. Progress, Cancel, plain errors and Try again; keys and local
 * models stay in Settings → Swarm. A signed-out Claude is flagged first (setup still works).
 */
export function SwarmQuickSetup({
  hostId,
  status,
  isAssistantLane,
  hasPendingSwitch,
  onFinished,
  onClose,
}: {
  readonly hostId: HostId;
  readonly status: SwarmStatus | null;
  readonly isAssistantLane: boolean;
  /** A thread/draft asked for Swarm: finishing turns it on there. */
  readonly hasPendingSwitch: boolean;
  readonly onFinished: () => void;
  readonly onClose: () => void;
}) {
  const setConsent = useAtomAction(swarmHost.setConsent, COMMAND_OPTIONS);
  const installStart = useAtomAction(swarmHost.installStart, COMMAND_OPTIONS);
  const installCancel = useAtomAction(swarmHost.installCancel, COMMAND_OPTIONS);
  const testProvider = useAtomAction(swarmHost.testProvider, COMMAND_OPTIONS);
  const { checks, failed: checksFailed } = useFirstRunChecks();
  const claude = claudeStep(checks, checksFailed);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;
  const runningRef = useRef(false);

  // Leaving the sheet while a download runs keeps it going (Settings → Swarm shows it); nothing else to clean up.
  useEffect(() => () => void (runningRef.current = false), []);

  async function command<A, E>(request: () => Promise<AtomActionResult<A, E>>, fallback: string) {
    const result = await request();
    if (result._tag === "Failure") {
      if (isAtomActionInterrupted(result)) throw new Error("interrupted");
      const failure = squashAtomActionFailure(result);
      throw new Error(failure instanceof Error && failure.message ? failure.message : fallback);
    }
    return result.value;
  }

  const waitForInstall = async (): Promise<"succeeded" | "failed" | "cancelled"> => {
    for (;;) {
      if (!runningRef.current) return "cancelled";
      const phase = statusRef.current?.install.phase;
      if (phase === "succeeded" || phase === "failed" || phase === "cancelled") return phase;
      const oc = statusRef.current?.opencode;
      if (phase === "idle" && oc?.installed && oc.versionOk) return "succeeded";
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
  };

  async function turnOn() {
    if (runningRef.current || status === null) return;
    runningRef.current = true;
    setPhase("running");
    setError(null);
    try {
      const now = statusRef.current ?? status;
      const { acceptedVersion, requiredVersion } = now.consent;
      if (acceptedVersion === null || acceptedVersion < requiredVersion) {
        await command(
          () =>
            setConsent({
              hostId,
              input: { noticeVersion: SWARM_PRIVACY_NOTICE_VERSION, accepted: true },
            }),
          "Kora could not save your choice. Try again.",
        );
      }
      const oc = (statusRef.current ?? now).opencode;
      if (!(oc.installed && oc.versionOk)) {
        if (!ACTIVE_INSTALL.has((statusRef.current ?? now).install.phase)) {
          await command(
            () => installStart({ hostId, input: { confirm: true } }),
            "Kora could not start the OpenCode download. Try again.",
          );
        }
        const outcome = await waitForInstall();
        if (outcome === "cancelled") {
          setPhase("idle");
          return;
        }
        if (outcome === "failed") {
          setPhase("failed"); // the OpenCode row says why
          return;
        }
      }
      const zen = (statusRef.current ?? now).providers.find((p) => p.provider === "zen");
      if (zen?.enabled && !zen.lastTest?.ok) {
        setTesting(true);
        try {
          const tested = await command(
            () => testProvider({ hostId, input: { provider: "zen" } }),
            "Kora could not check the free models.",
          );
          if (!tested.lastTest?.ok && !(statusRef.current?.ready ?? false)) {
            setPhase("failed"); // the models row says why
            return;
          }
        } finally {
          setTesting(false);
        }
      }
      // The status stream lands a moment after the last command: give it a beat before judging readiness.
      for (let i = 0; i < 20 && !(statusRef.current?.ready ?? false); i++) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      if (!(statusRef.current?.ready ?? false)) {
        const blocker = statusRef.current?.blockers[0]?.message ?? "Stretch isn't ready yet.";
        setError(`${blocker}. Settings → Swarm has every option.`);
        setPhase("failed");
        return;
      }
      setPhase("idle");
      onFinished();
    } catch (cause) {
      if (cause instanceof Error && cause.message === "interrupted") {
        setPhase("idle");
        return;
      }
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
      setPhase("failed");
    } finally {
      runningRef.current = false;
    }
  }

  const rows = status ? quickSetupRows(status, testing) : [];
  const running = phase === "running";
  return (
    <DialogPopup className="sm:max-w-md" data-swarm-quick-setup={phase}>
      <DialogHeader>
        <DialogTitle>Turn on Stretch</DialogTitle>
        <DialogDescription>
          {isAssistantLane
            ? "Your agent plans and checks the work while free AI models read and research in parallel. Best for big jobs; for a quick question, chat alone is faster."
            : "Your agent plans and checks the work while free AI models do the legwork in parallel, each in its own copy of your repo. Best for big jobs; for a quick fix, chat alone is faster."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4 text-sm">
        {claude.kind === "sign-in" ? (
          <div
            data-swarm-quick-claude
            className="rounded-lg bg-card p-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/6"
          >
            <p className="font-medium text-foreground text-sm">Claude is signed out</p>
            <p className="mt-0.5 text-muted-foreground text-xs">
              A Claude-led swarm needs it. Codex and OpenCode leads do not; the setup below works
              either way.
            </p>
            <ClaudeLoginButtonForSheet onLoggedIn={forgetFirstRunChecks} />
          </div>
        ) : null}
        {status === null ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" /> Checking Swarm on {thisComputer()}…
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li
                key={row.id}
                data-swarm-quick-row={row.id}
                data-state={row.state}
                className="flex gap-2.5"
              >
                <RowIcon state={row.state} />
                <div className="min-w-0 flex-1">
                  <p className="text-foreground text-sm">{row.title}</p>
                  <p
                    className={cn(
                      "mt-0.5 text-xs leading-5 [overflow-wrap:anywhere]",
                      row.state === "failed" ? "text-foreground/85" : "text-muted-foreground",
                    )}
                    role={row.state === "failed" ? "alert" : undefined}
                  >
                    {row.detail}
                  </p>
                  {row.progress ? (
                    <div
                      role="progressbar"
                      aria-label="OpenCode download"
                      aria-valuemin={0}
                      aria-valuemax={row.progress.total}
                      aria-valuenow={row.progress.done}
                      className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-foreground/10"
                    >
                      <div
                        className="h-full rounded-full bg-foreground/80 transition-[width] duration-300"
                        style={{
                          width: `${Math.min(100, Math.round((row.progress.done / row.progress.total) * 100))}%`,
                        }}
                      />
                    </div>
                  ) : null}
                  {row.cancelId ? (
                    <button
                      type="button"
                      className="mt-1 text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() =>
                        void installCancel({ hostId, input: { operationId: row.cancelId! } })
                      }
                    >
                      Cancel download
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {status ? <ZenRateLimitBanner status={status} /> : null}
        <div className="flex gap-2.5 rounded-lg bg-card p-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/6">
          <ShieldIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-muted-foreground text-xs leading-5" data-swarm-privacy-notice>
            {isAssistantLane ? SWARM_PRIVACY_TEXT_ASSISTANT : SWARM_PRIVACY_TEXT}
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs leading-5" data-swarm-quick-consent>
          Turning Swarm on confirms: “{SWARM_CONSENT_TEXT}” API keys and local models are in{" "}
          <Link
            to="/settings/swarm"
            onClick={onClose}
            className="text-foreground underline-offset-2 hover:underline"
          >
            Settings → Swarm
          </Link>
          .
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Not now
        </Button>
        <Button
          disabled={running || status === null}
          onClick={() => void turnOn()}
          data-swarm-quick-start
        >
          {running ? <Spinner className="size-4" /> : null}
          {running
            ? "Setting up…"
            : phase === "failed"
              ? "Try again"
              : hasPendingSwitch
                ? "Turn on Stretch"
                : "Set up Stretch"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function ClaudeLoginButtonForSheet({ onLoggedIn }: { readonly onLoggedIn: () => void }) {
  const { httpBaseUrl } = useFirstRunChecks();
  return httpBaseUrl ? (
    <ClaudeLoginButton httpBaseUrl={httpBaseUrl} onLoggedIn={onLoggedIn} />
  ) : null;
}
