import { searchableSetting } from "./prefsSearch";
import { PrefsPageContainer, PrefsSection, PrefsRow } from "./prefsLayout";
import { Switch } from "../ui/switch";
import { Spinner } from "../ui/spinner";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "../ui/select";
import { Button } from "../ui/button";
import {
  SwarmLocalModelsPanel,
  SwarmSupplyModePicker,
  SwarmPaidModelsPanel,
} from "../swarm/SwarmSupplyPanels";
import { SwarmSetupDialog } from "../swarm/SwarmSetupDialog";
import { SwarmReadinessChecklist } from "../swarm/SwarmReadinessChecklist";
import { SwarmProvidersStep } from "../swarm/SwarmProvidersStep";
import { SwarmPrivacyNotice } from "../swarm/SwarmPrivacyNotice";
import { SwarmOpencodeStep } from "../swarm/SwarmOpencodeStep";
import { SwarmKoragentStep } from "../swarm/SwarmKoragentStep";
import { swarmWorkerBackend } from "../../util/swarm";
import { openSwarmQuickSetup, openSwarmSetup } from "../../stores/swarmSetupStore";
import { useSwarmStatus } from "../../hooks/useSwarmStatus";
import { IS_PRO_EDITION } from "../../branding";
import { useAtomAction } from "../../atoms/use-atom-command";
import { swarmHost } from "../../atoms/swarm";
import { SWARM_PRIVACY_NOTICE_VERSION, type SwarmStatus, type HostId } from "@kora/contracts";
import {
  type AtomActionResult,
  squashAtomActionFailure,
  isAtomActionInterrupted,
} from "@kora/client-runtime/store/runtime";
import { useState, useRef } from "react";
import { ChevronRightIcon } from "lucide-react";
import { thisComputer } from "../../util/utils";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const AUTOMATIC = "__automatic__";
const AUTOMATIC_LABEL = "Automatic (best available)";
const BACKEND_LABELS = { opencode: "OpenCode", koragent: "Koragent" } as const;

/** Every free model the daemon knows about: probe results plus the available catalog. */
function modelChoices(status: SwarmStatus): string[] {
  const ids = new Set<string>();
  for (const provider of status.providers) {
    for (const id of provider.lastTest?.freeModels ?? []) ids.add(id);
  }
  for (const model of status.models.available) ids.add(model.id);
  if (status.preferences.defaultModel !== null) ids.add(status.preferences.defaultModel);
  return [...ids].toSorted();
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    minute: "2-digit",
    year: "numeric",
    hour: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SwarmPrefsContent({ hostId, status }: { hostId: HostId; status: SwarmStatus }) {
  const setPreferences = useAtomAction(swarmHost.setPreferences, COMMAND_OPTIONS);
  const setConsent = useAtomAction(swarmHost.setConsent, COMMAND_OPTIONS);
  const [pending, setPending] = useState<"model" | "consent" | "backend" | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<{
    section: "model" | "consent" | "backend";
    message: string;
  } | null>(null);

  async function run<A, E>(
    section: "model" | "consent" | "backend",
    request: () => Promise<AtomActionResult<A, E>>,
  ) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(section);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        const failure = squashAtomActionFailure(result);
        setError({
          section,
          message: failure instanceof Error ? failure.message : "Could not save the change.",
        });
      }
    } catch {
      setError({ section, message: "Could not save the change." });
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  const changeConsent = (accepted: boolean) =>
    void run("consent", () =>
      setConsent({ hostId, input: { noticeVersion: SWARM_PRIVACY_NOTICE_VERSION, accepted } }),
    );
  const consentAccepted =
    status.consent.acceptedVersion !== null &&
    status.consent.acceptedVersion >= status.consent.requiredVersion;
  const choices = modelChoices(status);
  // The backend switch exists only on daemons that report `workerBackend` (older ones: OpenCode only).
  // Koragent workers are Kora Pro: the free edition has no choice to offer, so no row at all.
  const backendSupported =
    IS_PRO_EDITION &&
    (status.workerBackend !== undefined || swarmWorkerBackend(status) === "koragent");
  const backend = swarmWorkerBackend(status);
  const defaultModel = status.preferences.defaultModel;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-6" data-swarm-prefs-intro>
        Stretch (the engine is called Swarm) makes your usage last: your agent does small work
        itself and hands the rest to free AI models that work in parallel, each in its own copy of
        your project, then to cheap Claude Haiku or GPT Luna workers if no free one is available.
        Turn it on per chat with the Stretch button in the message box. This page sets up the free
        models.
      </p>
      <PrefsSection title={`Stretch on ${thisComputer()}`}>
        <PrefsRow
          title="Free AI helpers"
          description={
            consentAccepted
              ? "On: the Swarm button in the message box can hand big jobs to free models."
              : "Off. Turning it on downloads OpenCode if needed, checks the free models and asks you once about privacy."
          }
          status={
            error?.section === "consent" ? (
              <span role="alert" className="text-destructive">
                {error.message}
              </span>
            ) : undefined
          }
          control={
            <Switch
              data-swarm-enabled-switch
              checked={consentAccepted}
              disabled={pending !== null}
              aria-label="Free AI helpers (Swarm)"
              onCheckedChange={(checked) => {
                if (checked) openSwarmQuickSetup();
                else changeConsent(false);
              }}
            />
          }
        />
      </PrefsSection>

      <PrefsSection
        {...searchableSetting("swarm")}
        title="Status"
        variant="plain"
        headerAction={
          <Button size="xs" variant="outline" onClick={() => openSwarmSetup()}>
            Step-by-step setup
          </Button>
        }
      >
        <SwarmReadinessChecklist
          status={status}
          essentialOnly
          onFix={(step) => openSwarmSetup({ step })}
        />
      </PrefsSection>

      <details
        data-swarm-more-options
        className="group/more rounded-lg [&_summary::-webkit-details-marker]:hidden"
      >
        <summary className="flex cursor-pointer select-none items-center gap-1.5 py-2 font-medium text-foreground text-sm">
          <ChevronRightIcon
            className="size-4 text-muted-foreground transition-transform group-open/more:rotate-90"
            aria-hidden
          />
          More options
          <span className="font-normal text-muted-foreground text-xs">
            providers, keys, local models, worker model, privacy
          </span>
        </summary>
        <div className="space-y-6 pt-2">
          {/* A choice only on daemons that can run Koragent workers; otherwise a disabled select said nothing useful. */}
          {backendSupported ? (
            <PrefsSection title="Worker program">
              <PrefsRow
                title="Workers run in"
                description="OpenCode, the open-source agent, or Koragent, Kora's own (it reports progress to Kora directly). New workers use the choice; running ones keep theirs."
                status={
                  error?.section === "backend" ? (
                    <span role="alert" className="text-destructive">
                      {error.message}
                    </span>
                  ) : undefined
                }
                control={
                  <Select
                    value={backend}
                    disabled={pending !== null || !backendSupported}
                    onValueChange={(value) => {
                      if (value !== "opencode" && value !== "koragent") return;
                      if (value === backend) return;
                      void run("backend", () =>
                        setPreferences({ hostId, input: { workerBackend: value } }),
                      );
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full sm:w-44"
                      aria-label="Swarm worker backend"
                    >
                      <SelectValue>{BACKEND_LABELS[backend]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem hideIndicator value="opencode">
                        {BACKEND_LABELS.opencode}
                      </SelectItem>
                      <SelectItem hideIndicator value="koragent">
                        {BACKEND_LABELS.koragent}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />
            </PrefsSection>
          ) : null}

          {IS_PRO_EDITION && backend === "koragent" ? (
            <PrefsSection title="Koragent" variant="plain">
              <SwarmKoragentStep hostId={hostId} status={status} showIntro={false} />
            </PrefsSection>
          ) : (
            <PrefsSection title="OpenCode" variant="plain">
              <SwarmOpencodeStep hostId={hostId} status={status} showIntro={false} />
            </PrefsSection>
          )}

          <PrefsSection title="Free model sources" variant="plain">
            <p className="text-muted-foreground text-xs">
              Where the free models come from. Workers try these from top to bottom and move on when
              one is busy. OpenCode Zen works without a key; OpenRouter needs your own (free) key.
            </p>
            <SwarmProvidersStep hostId={hostId} status={status} showOrderControls />
            <SwarmSupplyModePicker hostId={hostId} status={status} />
          </PrefsSection>

          <PrefsSection title="Paid models (optional, your OpenRouter key)" variant="plain">
            <div className="rounded-lg bg-card p-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5">
              <SwarmPaidModelsPanel hostId={hostId} status={status} />
            </div>
          </PrefsSection>

          <PrefsSection
            title={`Models on ${thisComputer()} (optional: Ollama / LM Studio)`}
            variant="plain"
          >
            <div className="space-y-2 rounded-lg bg-card p-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5">
              <p className="text-muted-foreground text-xs">
                Private: workers on a local model never send your code off this machine.
              </p>
              <SwarmLocalModelsPanel hostId={hostId} status={status} />
            </div>
          </PrefsSection>

          <PrefsSection title="Worker model">
            <PrefsRow
              title="Start workers on"
              description="Automatic (recommended) picks the best free model that is working right now and switches when one is busy."
              status={
                error?.section === "model" ? (
                  <span role="alert" className="text-destructive">
                    {error.message}
                  </span>
                ) : undefined
              }
              control={
                <Select
                  value={defaultModel ?? AUTOMATIC}
                  disabled={pending !== null}
                  onValueChange={(value) => {
                    if (typeof value !== "string") return;
                    const next = value === AUTOMATIC ? null : value;
                    if (next === defaultModel) return;
                    void run("model", () =>
                      setPreferences({ hostId, input: { defaultModel: next } }),
                    );
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full sm:w-64"
                    aria-label="Default swarm model"
                  >
                    <SelectValue>{defaultModel ?? AUTOMATIC_LABEL}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value={AUTOMATIC}>
                      {AUTOMATIC_LABEL}
                    </SelectItem>
                    {choices.map((id) => (
                      <SelectItem key={id} hideIndicator value={id}>
                        {id}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          </PrefsSection>

          <PrefsSection title="Consent" variant="plain">
            <SwarmPrivacyNotice
              consent={status.consent}
              pending={pending !== null}
              onAcceptedChange={changeConsent}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
              <span className="text-muted-foreground">
                {consentAccepted && status.consent.acceptedAt !== null
                  ? `Accepted ${formatDate(status.consent.acceptedAt)}.`
                  : "Not accepted. Swarm stays off until you accept."}
              </span>
              {consentAccepted ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => changeConsent(false)}
                >
                  Withdraw consent
                </Button>
              ) : null}
            </div>
          </PrefsSection>
        </div>
      </details>
    </>
  );
}

/**
 * Settings → Swarm: readiness, the OpenCode install, providers (keys, tests, order), paid
 * OpenRouter models under a spend cap, local models, the default worker model and the privacy
 * consent. Hidden, not broken, on daemons without Swarm.
 */
export function SwarmPrefsPanel({ hostId }: { readonly hostId: HostId }) {
  const { supported, status } = useSwarmStatus(hostId);
  return (
    <PrefsPageContainer>
      {!supported ? (
        <p className="text-muted-foreground text-sm">
          Swarm isn't available on this machine's Kora. Update Kora to use it.
        </p>
      ) : status === null ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner className="size-4" />
          Checking Swarm setup…
        </div>
      ) : (
        <SwarmPrefsContent hostId={hostId} status={status} />
      )}
      <SwarmSetupDialog hostId={hostId} onStartSwarm={() => undefined} />
    </PrefsPageContainer>
  );
}
