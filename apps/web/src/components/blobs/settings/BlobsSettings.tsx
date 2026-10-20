import { cn } from "~/util/utils";
import { AutosaveLabel, useAutosave } from "./useAutosave";
import { TeamFilesSection } from "../teamfile/TeamFilesSection";
import { useEngineLabel } from "../shell/useEngineLabel";
import { useBlobsState, useBlobsApi } from "../shell/blobsApi";
import { BlobModelField } from "../shell/BlobModelPicker";
import { SOUL_PRESETS } from "../editor/soulPresets";
import { BrowserEngineRow } from "../browser/BrowserEngineRow";
import { Textarea } from "../../ui/textarea";
import { Switch } from "../../ui/switch";
import { PrefsPageContainer, PrefsSection, PrefsRow } from "../../prefs/prefsLayout";
// Settings → Blobs: "About me" (workspace-wide context every blob reads, ≤24k chars, autosaved) and the defaults a
// New blob starts from.
import type { BlobPermission, BlobDefaults } from "@kora/contracts";
import { useEffect, useState } from "react";

const ABOUT_ME_MAX = 24_000;

/**
 * Load a value over the blobs socket. The first call after a reload or a direct visit can land before the socket is
 * ready and fail; that must never leave the page dead, so it retries (1s, 2s, 4s ... up to 8 tries), retries at once
 * when the blobs snapshot arrives (the socket is up then) and offers a visible Retry once it gives up.
 */
function useLoadedValue<T>(
  load: () => Promise<{ ok: true; value: T } | { ok: false; message: string }>,
  deps: ReadonlyArray<unknown>,
) {
  const { snapshot } = useBlobsState();
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const ready = snapshot ? 1 : 0;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      void load().then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setValue((prev) => prev ?? r.value);
          setError(null);
        } else if (n < 8) {
          timer = setTimeout(() => attempt(n + 1), Math.min(1000 * 2 ** n, 8000));
        } else setError(r.message);
      });
    };
    attempt(0);
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [...deps, ready, nonce]);
  return { value, setValue, error, retry: () => setNonce((n) => n + 1) };
}

export function BlobsSettings(props: {
  readonly aboutMe: { readonly id: string; readonly title: string };
}) {
  return (
    <PrefsPageContainer>
      <AboutMeSection anchorId={props.aboutMe.id} />
      <DefaultsSection />
      <MemorySection />
      <BrowserSection />
      <TeamFilesSection />
    </PrefsPageContainer>
  );
}

function AboutMeSection({ anchorId }: { anchorId: string }) {
  const api = useBlobsApi();
  const loaded = useLoadedValue(() => api.getAboutMe(), [api.hostId]);
  const initial = loaded.value;
  const loadError = loaded.error;
  const field = useAutosave({
    initial,
    save: async (text) => {
      const r = await api.setAboutMe(text.slice(0, ABOUT_ME_MAX));
      return r.ok ? { ok: true } : r;
    },
  });
  const over = field.value.length > ABOUT_ME_MAX;
  return (
    <PrefsSection title="About me" id={anchorId}>
      <PrefsRow
        title="Tell your blobs who you are"
        description="Every blob reads this at the start of every chat: your name, work, people, preferences, how you like things done. Blobs also learn from your chats; this is the part you write yourself."
      >
        <div className="mt-3 space-y-1.5">
          <Textarea
            aria-label="About me"
            data-about-me
            value={field.value}
            disabled={initial === null && loadError === null}
            onChange={(e) => field.setValue(e.target.value)}
            rows={9}
            size="lg"
            placeholder="I’m Sam. I run a small design studio in Lisbon. Sam = my cofounder. I like short answers and sources for anything factual."
          />
          <div className="flex items-center justify-between">
            <AutosaveLabel status={field.status} error={field.error ?? loadError} />
            {loadError && initial === null ? (
              <button type="button" className="text-[11.5px] underline" onClick={loaded.retry}>
                Retry
              </button>
            ) : null}
            <span
              className={cn(
                "ms-auto text-[11.5px] tabular-nums",
                over ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {field.value.length.toLocaleString()} / {ABOUT_ME_MAX.toLocaleString()}
            </span>
          </div>
        </div>
      </PrefsRow>
    </PrefsSection>
  );
}

const PERMISSIONS: ReadonlyArray<{ id: BlobPermission; label: string }> = [
  { id: "ask", label: "Ask" },
  { id: "auto", label: "Auto" },
  { id: "full", label: "Full" },
];

function DefaultsSection() {
  const labelOf = useEngineLabel();
  const api = useBlobsApi();
  const { snapshot } = useBlobsState();
  const loadedDefaults = useLoadedValue<BlobDefaults>(() => api.getDefaults(), [api.hostId]);
  const defaults = loadedDefaults.value;
  const setDefaults = loadedDefaults.setValue;
  const [status, setStatus] = useState<{
    kind: "saving" | "saved" | "error";
    message?: string;
  } | null>(null);

  const persist = async (next: BlobDefaults) => {
    setDefaults(next);
    setStatus({ kind: "saving" });
    const r = await api.setDefaults(next);
    setStatus(r.ok ? { kind: "saved" } : { kind: "error", message: r.message });
  };

  const soul = useAutosave({
    initial: defaults?.soulTemplate ?? null,
    save: async (text) => {
      if (!defaults) return { ok: false, message: "Not loaded yet." };
      const r = await api.setDefaults({ ...defaults, soulTemplate: text });
      if (r.ok) setDefaults(r.value);
      return r.ok ? { ok: true } : r;
    },
  });

  const best = snapshot?.engines.best;
  return (
    <PrefsSection
      title="Defaults for new blobs"
      id="blobs-defaults"
      headerAction={
        status ? (
          <span
            role="status"
            data-autosave={status.kind}
            className={cn(
              "text-[11.5px]",
              status.kind === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {status.kind === "saving"
              ? "Saving…"
              : status.kind === "saved"
                ? "Saved"
                : status.message}
          </span>
        ) : null
      }
    >
      {loadedDefaults.error && !defaults ? (
        <div
          role="alert"
          className="flex items-center gap-3 px-1 pb-2 text-[12.5px] text-destructive"
        >
          <span>Could not load these settings: {loadedDefaults.error}</span>
          <button type="button" className="underline" onClick={loadedDefaults.retry}>
            Retry
          </button>
        </div>
      ) : null}
      <PrefsRow
        title="Model"
        description="The AI a new blob runs on. Best installed picks Claude if you are signed in, then Codex, then a free model."
      >
        <div className="mt-3">
          {defaults ? (
            <BlobModelField
              value={defaults.engine}
              bestLabel={best ? labelOf(best) : null}
              onChange={(engine) => void persist({ ...defaults, engine })}
            />
          ) : null}
        </div>
      </PrefsRow>
      <PrefsRow
        title="Permissions"
        description="Ask checks every step. Auto (recommended) works freely in the blob's own folder and browser and asks before anything outside them. Full never asks. Sending, posting, deleting, paying and signing in always ask, except on Full."
        control={
          <div
            role="radiogroup"
            aria-label="Default permissions"
            className="flex shrink-0 gap-0.5 rounded-full bg-muted p-0.5"
          >
            {PERMISSIONS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={defaults?.permission === p.id}
                disabled={!defaults}
                onClick={() => defaults && void persist({ ...defaults, permission: p.id })}
                className={cn(
                  "h-6 rounded-full px-3 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  defaults?.permission === p.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      />
      <PrefsRow
        title="Starting personality"
        description="The soul a new blob starts with. You can still change it per blob."
      >
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {SOUL_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => soul.setValue(p.text)}
                className="h-7 rounded-full px-3 text-[12px] text-muted-foreground ring-1 ring-border transition-colors hover:text-foreground hover:ring-foreground/40"
              >
                {p.label}
              </button>
            ))}
          </div>
          <Textarea
            aria-label="Starting personality"
            value={soul.value}
            disabled={!defaults}
            onChange={(e) => soul.setValue(e.target.value)}
            rows={5}
            size="lg"
            placeholder="Leave empty to start with a warm, concise coworker."
          />
          <AutosaveLabel status={soul.status} error={soul.error} />
        </div>
      </PrefsRow>
    </PrefsSection>
  );
}

function BrowserSection() {
  return (
    <PrefsSection title="Blob browser">
      <div className="px-4 py-3">
        <BrowserEngineRow />
      </div>
    </PrefsSection>
  );
}

function MemorySection() {
  const api = useBlobsApi();
  const { snapshot } = useBlobsState();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const on = snapshot?.flags.claudeMemoryFallback === true;
  const toggle = async (next: boolean) => {
    setPending(true);
    setError(null);
    const r = await api.setFlag("claudeMemoryFallback", next);
    setPending(false);
    if (!r.ok) setError(r.message);
  };
  return (
    <PrefsSection title="Memory" id="blobs-memory">
      <PrefsRow
        title="Use Claude for memory when no free model is available"
        description="Blobs learn from your chats with a small background call. A free model does it when one is set up; with this on, Claude Haiku 5.5 covers it when no free model is available. Off, learning waits for a free model. Picking who answers in a group chat always uses a quick Claude Haiku call while you are signed in. All Haiku calls count on your Claude plan (at most 150 a day)."
        control={
          <Switch
            aria-label="Use Claude for memory when no free model is available"
            checked={on}
            disabled={snapshot === null || pending}
            onCheckedChange={(next) => void toggle(next)}
          />
        }
      >
        <p data-memory-usage className="mt-2 text-[11.5px] text-muted-foreground">
          {snapshot?.memoryModel
            ? `Learning model: ${snapshot.memoryModel}. `
            : "No learning model right now. "}
          {typeof snapshot?.claudeCallsToday === "number"
            ? `Claude helper calls today: ${snapshot.claudeCallsToday} of 150.`
            : "Claude helper calls today: not reported."}
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-[11.5px] text-destructive">
            {error}
          </p>
        ) : null}
      </PrefsRow>
    </PrefsSection>
  );
}
