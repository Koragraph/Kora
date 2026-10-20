// Settings > Connections: where connected apps get their key (Kora's free service by default, your own Composio key if
// you paste one), how many free calls are left, and the accounts you have linked.
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { PrefsPageContainer, PrefsRow, PrefsSection } from "../../prefs/prefsLayout";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { ByoKeyField } from "./ByoKeyField";
import { CapCard, UsageMeter } from "./CapCard";
import { SetupGuide } from "./SetupGuide";
import { useAppsApi } from "./appsApi";
import { refreshAppsBrief } from "./appsBrief";
import {
  accountLabel,
  accountStatusWord,
  capState,
  errorCopy,
  isNotSetUp,
  toolkitDisplayName,
} from "./appsModel";
import { useAppsAccounts, useAppsStatus } from "./useAppsData";

export function ConnectionsSettings(props: { readonly anchorId?: string }) {
  const api = useAppsApi();
  const navigate = useNavigate();
  const { status, error, set } = useAppsStatus();
  const notSetUp = isNotSetUp(status) || error?.code === "not_configured";
  const { accounts, refresh: refreshAccounts } = useAppsAccounts(status !== null && !notSetUp);
  const [guide, setGuide] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = capState(status);

  const onStatus = (s: NonNullable<typeof status>) => {
    set(s);
    void refreshAccounts();
    void refreshAppsBrief(api);
  };
  const disconnect = async (id: string, name: string) => {
    const r = await api.disconnect(id);
    if (!r.ok)
      toastManager.add({ type: "error", title: "Could not disconnect", description: r.message });
    else toastManager.add({ type: "success", title: `${name} disconnected` });
    void refreshAccounts();
    void refreshAppsBrief(api);
  };
  const reset = async () => {
    setBusy(true);
    const r = await api.resetBroker();
    setBusy(false);
    setConfirmReset(false);
    if (!r.ok)
      toastManager.add({ type: "error", title: "Could not reset", description: r.message });
    else {
      onStatus(r.value);
      toastManager.add({
        type: "success",
        title: "Connection reset",
        description: "Connect your apps again from the Apps page.",
      });
    }
  };

  return (
    <PrefsPageContainer>
      <PrefsSection title="Connected apps" id={props.anchorId} data-connections>
        <PrefsRow
          title={
            notSetUp
              ? "Not set up yet"
              : status?.mode === "byo"
                ? "Your Composio key"
                : "Kora's free app service"
          }
          description={
            notSetUp
              ? "To connect apps, paste your own Composio key. It takes about two minutes."
              : status?.mode === "byo"
                ? "Apps run on your own Composio account, so there is no monthly limit."
                : "Free for everyone: a monthly allowance of app calls. Your own Composio key removes the limit."
          }
        >
          <div className="mt-3 space-y-3">
            {error && !notSetUp ? (
              <p
                className="text-[12.5px] text-destructive-foreground"
                role="alert"
                data-connections-error={error.code ?? "error"}
              >
                {errorCopy(error.code, error.message).title}.{" "}
                {errorCopy(error.code, error.message).body}
              </p>
            ) : null}
            {status && !notSetUp ? <UsageMeter status={status} className="max-w-md" /> : null}
            {state === "capped" && status ? (
              <CapCard
                status={status}
                onPasteKey={() =>
                  document.querySelector<HTMLInputElement>("[data-byo-input]")?.focus()
                }
              />
            ) : null}
          </div>
        </PrefsRow>

        <PrefsRow
          title="Use your own Composio key"
          description="Paste a Composio project key (starts with ak_). It wins over Kora's service, is checked before it is saved, and is stored securely on this Mac."
        >
          <div className="mt-3 max-w-xl" data-connections-key>
            <ByoKeyField status={status} onStatus={onStatus} compact />
            {!status?.byoKeySet ? (
              <>
                <button
                  type="button"
                  onClick={() => setGuide((v) => !v)}
                  aria-expanded={guide}
                  data-guide-toggle
                  className="mt-3 text-[12.5px] font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                >
                  {guide ? "Hide the 2-minute guide" : "How do I get a key? 2-minute guide"}
                </button>
                {guide ? (
                  <div className="mt-3 rounded-xl bg-card p-4 ring-1 ring-border/60">
                    <SetupGuide />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </PrefsRow>

        {status && !notSetUp ? (
          <PrefsRow
            title="Linked accounts"
            description="Sign-ins you made on each app's own page. Kora never sees the password."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigate({ to: "/apps" })}
                data-open-apps
              >
                Open Apps
              </Button>
            }
          >
            <ul className="mt-3 divide-y divide-border/50" data-connections-accounts>
              {accounts === null ? (
                <li className="py-2 text-[12.5px] text-muted-foreground">Loading…</li>
              ) : accounts.length === 0 ? (
                <li className="py-2 text-[12.5px] text-muted-foreground">Nothing connected yet.</li>
              ) : (
                accounts.map((a) => {
                  const name = toolkitDisplayName(a.toolkit, []);
                  const s = accountStatusWord(a);
                  return (
                    <li
                      key={a.id}
                      data-connection-account={a.id}
                      className="flex items-center gap-3 py-2 text-[13px]"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-foreground">{name}</span>
                        <span className="text-muted-foreground"> · {accountLabel(a)}</span>
                      </span>
                      <span className="text-[11.5px] text-muted-foreground">{s.text}</span>
                      <Button size="xs" variant="ghost" onClick={() => void disconnect(a.id, name)}>
                        Disconnect
                      </Button>
                    </li>
                  );
                })
              )}
            </ul>
          </PrefsRow>
        ) : null}

        {status?.mode === "broker" ? (
          <PrefsRow
            title="Reset the connection"
            description="Forgets this Mac's identity with Kora's app service. Your linked accounts are lost and must be connected again."
            control={
              confirmReset ? (
                <span className="flex gap-1">
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() => void reset()}
                    data-reset-confirm
                  >
                    Reset
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmReset(true)}
                  data-reset-broker
                >
                  Reset connection
                </Button>
              )
            }
          />
        ) : null}
      </PrefsSection>
      <p className="px-1 text-[11.5px] text-muted-foreground" data-connections-footnote>
        Secrets are{" "}
        {status?.secretStore.includes("keychain")
          ? "kept in your macOS Keychain"
          : status?.secretStore.includes("credman")
            ? "kept in Windows Credential Manager"
            : "kept in a private file on this computer"}
        , never in a profile, a log or a chat.
      </p>
    </PrefsPageContainer>
  );
}
