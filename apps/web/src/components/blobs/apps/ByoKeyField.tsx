// "Paste your own Composio key": validate -> save, status, remove. Used by Settings > Connections and by the Apps page
// when connected apps are not set up. The key lives in this component's state only while it is typed; the daemon checks it
// against Composio before saving (a typo never replaces a working setup) and never sends it back.

import { errorCopy } from "./appsModel";
import { type AppsStatus, useAppsApi } from "./appsApi";
import { Spinner } from "../../ui/spinner";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { useState } from "react";
import { KeyRoundIcon, CheckIcon } from "lucide-react";

export function ByoKeyField(props: {
  readonly status: AppsStatus | null;
  readonly onStatus: (s: AppsStatus) => void;
  /** Focus the field when it mounts (the cap card's "paste your own key" button). */
  readonly autoFocus?: boolean;
  readonly compact?: boolean;
}) {
  const api = useAppsApi();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const has = props.status?.byoKeySet === true;

  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy("save");
    setError(null);
    const r = await api.setKey(key.trim());
    setBusy(null);
    if (!r.ok) {
      setError(errorCopy(r.code, r.message).body || r.message);
      return;
    }
    setKey(""); // the key is not kept on screen or in state once saved
    setSaved(true);
    props.onStatus(r.value);
  };
  const clear = async () => {
    setBusy("clear");
    setError(null);
    const r = await api.clearKey();
    setBusy(null);
    setSaved(false);
    if (!r.ok) setError(r.message);
    else props.onStatus(r.value);
  };

  if (has) {
    return (
      <div className="flex flex-wrap items-center gap-3" data-byo-state="set">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-foreground">
          <span className="grid size-5 place-items-center rounded-full bg-success/12 text-success-foreground">
            <CheckIcon className="size-3" aria-hidden />
          </span>
          Using your Composio key. No limit on app calls.
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void clear()}
          data-byo-clear
        >
          {busy === "clear" ? <Spinner className="size-3" /> : null}
          Remove key
        </Button>
        {error ? <span className="text-[12px] text-destructive-foreground">{error}</span> : null}
        {saved ? (
          <span className="text-[12px] text-muted-foreground">
            Saved. It is checked against Composio first and stored securely on this Mac.
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className="space-y-2"
      data-byo-state="empty"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <KeyRoundIcon
            className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            placeholder="ak_… (your Composio project key)"
            onChange={(e) => setKey(e.target.value)}
            className="ps-8 font-mono text-[12.5px]"
            autoFocus={props.autoFocus === true}
            aria-label="Composio project key"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            type="password"
            data-byo-input
            value={key}
            nativeInput
          />
        </div>
        <Button
          type="submit"
          size={props.compact ? "sm" : "default"}
          disabled={!key.trim() || busy !== null}
          data-byo-save
        >
          {busy === "save" ? <Spinner className="size-3.5" /> : null}
          {busy === "save" ? "Checking" : "Save key"}
        </Button>
      </div>
      {error ? (
        <p className="text-[12px] text-destructive-foreground" role="alert" data-byo-error>
          {error}
        </p>
      ) : (
        <p className="text-[11.5px] text-muted-foreground">
          Checked with Composio before it is saved, then stored securely on this Mac. Kora never
          shows it again.
        </p>
      )}
    </form>
  );
}
