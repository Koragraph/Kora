import type { HostId } from "@kora/contracts";
import { useState } from "react";

import { useHostQuery } from "../../atoms/query";
import { useAtomAction } from "../../atoms/use-atom-command";
import { PrefsSection } from "../prefs/prefsLayout";
import { usePrefsScope } from "../prefs/PrefsScopeContext";
import { Button } from "../ui/button";
import { displayFolder, trustSourceLabel } from "./folderTrust.logic";
import { trustHost } from "./trustAtoms";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

/**
 * Settings → Projects: the folders whose own agent setup (hooks, MCP servers, plugins, tools) Kora's agents may run,
 * each with Revoke. Revoking puts the folder back in restricted mode; a live chat there restarts at its next turn.
 */
export function TrustedFoldersSection() {
  const { environment } = usePrefsScope();
  if (!environment) return null;
  return <TrustedFoldersList hostId={environment.hostId} />;
}

function TrustedFoldersList({ hostId }: { readonly hostId: HostId }) {
  const query = useHostQuery(trustHost.list({ hostId, input: {} }));
  const setTrust = useAtomAction(trustHost.set, COMMAND_OPTIONS);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folders = query.data?.folders ?? [];

  const revoke = async (path: string) => {
    if (pending) return;
    setPending(path);
    setError(null);
    try {
      const result = await setTrust({ hostId, input: { cwd: path, trusted: false } });
      if (result._tag === "Failure") setError("Could not revoke trust.");
    } catch {
      setError("Could not revoke trust.");
    } finally {
      setPending(null);
      query.refresh();
    }
  };

  return (
    <PrefsSection title={`Trusted folders · ${folders.length}`} variant="plain">
      <p className="pb-2 text-xs text-muted-foreground">
        Agents run a trusted folder's own setup — its .claude hooks, MCP servers, plugins and tools.
        Other folders run in restricted mode until you trust them.
      </p>
      {error ? <p className="pb-2 text-xs text-destructive">{error}</p> : null}
      {folders.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No trusted folders.</p>
      ) : (
        <ul
          aria-label="Trusted folders"
          className="divide-y divide-border/50 overflow-hidden rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5"
        >
          {folders.map((folder) => (
            <li key={folder.path} className="flex min-w-0 items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-foreground">
                  {displayFolder(folder.path)}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {trustSourceLabel(folder.source)}
                </span>
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={pending !== null}
                data-folder-trust-revoke={folder.path}
                onClick={() => void revoke(folder.path)}
              >
                {pending === folder.path ? "Revoking…" : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </PrefsSection>
  );
}
