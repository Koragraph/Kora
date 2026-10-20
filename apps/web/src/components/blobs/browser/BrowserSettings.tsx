// This blob's browser settings: whether pages may download files into its folder, which local dev servers it may
// open (loopback and the LAN are blocked otherwise), and "Clear browser data" (signs it out of every site). Saved on the blob's profile (`toolGrants.computer`), applied to the
// running browser at once. Shown under the live view in the Computer tab and in the blob editor's Access section.
import type { BlobProfile } from "@kora/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { resolvePrimaryHostHttpUrl } from "~/hosts/primary/target";
import { fetchPrimaryHost } from "~/hosts/primary/shellAuth";

import { Switch } from "../../ui/switch";
import { useBlobsApi } from "../shell/blobsApi";
import { useBlobRoster } from "../shell/useBlobRoster";
import { BrowserEngineRow } from "./BrowserEngineRow";
import {
  MAX_LOCAL_HOSTS,
  addLocalHost,
  parseLocalHost,
  removeLocalHost,
} from "./browserSettingsModel";

export function BrowserSettings(props: { readonly profile: BlobProfile }) {
  const api = useBlobsApi();
  const { profile } = props;
  const computer = profile.toolGrants.computer;
  const hosts = computer.allowLocalHosts ?? [];
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (next: { allowDownloads?: boolean; allowLocalHosts?: string[] }) => {
    setBusy(true);
    setError(null);
    const r = await api.update(profile.id, {
      toolGrants: { ...profile.toolGrants, computer: { ...computer, ...next } },
    });
    setBusy(false);
    if (!r.ok) setError(r.message);
  };

  const add = async () => {
    if (!draft.trim()) return;
    const entry = parseLocalHost(draft);
    if (!entry) {
      setError("Use a host like localhost:5173, 127.0.0.1:3000 or *.test.");
      return;
    }
    if (hosts.length >= MAX_LOCAL_HOSTS) {
      setError(`Up to ${MAX_LOCAL_HOSTS} addresses.`);
      return;
    }
    setDraft("");
    await save({ allowLocalHosts: addLocalHost(hosts, entry) });
  };

  return (
    <div className="space-y-3 rounded-xl bg-card p-3 ring-1 ring-border/70" data-browser-settings>
      <BrowserEngineRow />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-foreground">Allow downloads</div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
            Pages can save files into this blob&apos;s downloads folder. Installers and scripts are
            always refused.
          </p>
        </div>
        <Switch
          size="sm"
          checked={computer.allowDownloads === true}
          disabled={busy}
          aria-label="Allow downloads"
          data-browser-downloads
          onCheckedChange={(v) => void save({ allowDownloads: v === true })}
        />
      </div>
      <div>
        <div className="text-[12.5px] font-medium text-foreground">Local dev servers</div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
          Addresses on this Mac or your network are blocked. List the ones this blob may open, like
          a site you are building.
        </p>
        {hosts.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5" data-browser-hosts>
            {hosts.map((h) => (
              <li
                key={h}
                className="flex items-center gap-1 rounded-md bg-accent/60 py-0.5 ps-2 pe-0.5 text-[11.5px] text-foreground"
              >
                <code>{h}</code>
                <button
                  type="button"
                  aria-label={`Remove ${h}`}
                  disabled={busy}
                  onClick={() => void save({ allowLocalHosts: removeLocalHost(hosts, h) })}
                  className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="localhost:5173"
            aria-label="Add a local address"
            data-browser-host-input
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded-md bg-background px-2 text-[12px] text-foreground ring-1 ring-border/70 outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            data-browser-host-add
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <PlusIcon className="size-3.5" />
            Add
          </button>
        </form>
        {error ? (
          <p
            className="mt-1.5 text-[11.5px] text-destructive"
            role="alert"
            data-browser-settings-error
          >
            {error}
          </p>
        ) : null}
      </div>
      <ClearBrowserData blobId={profile.id} name={profile.name} />
    </div>
  );
}

/** Sign the blob out of every site: closes its browser, then deletes its private profile (cookies, sign-ins, history). */
function ClearBrowserData(props: { readonly blobId: string; readonly name: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const clear = async () => {
    setState("busy");
    try {
      const res = await fetchPrimaryHost(
        resolvePrimaryHostHttpUrl("/api/blob-browser/clear", { blobId: props.blobId }),
        { method: "POST" },
      );
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
    setConfirming(false);
  };
  return (
    <div className="flex items-start gap-3" data-browser-clear>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-foreground">Signed-in sites</div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
          {state === "done"
            ? `${props.name}'s browser data is cleared. It is signed out of every site.`
            : state === "error"
              ? "Couldn't clear the browser data. Try again."
              : `${props.name} stays signed in to sites you log into in its browser. Clearing signs it out of all of them and closes its browser.`}
        </p>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void clear()}
            disabled={state === "busy"}
            data-browser-clear-confirm
            className="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-destructive transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={state === "busy"}
          data-browser-clear-start
          className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Clear browser data
        </button>
      )}
    </div>
  );
}

/** The same form for a blob id, reading the live roster (so a change shows at once wherever it is mounted). */
export function BrowserSettingsFor(props: { readonly blobId: string }) {
  const { entries } = useBlobRoster();
  const profile = entries.get(props.blobId)?.blob ?? null;
  return profile ? <BrowserSettings profile={profile} /> : null;
}
