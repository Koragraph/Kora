import { fetchPrimaryHost } from "../hosts/primary/shellAuth";
import { useEffect, useState } from "react";

/**
 * Whether the folder a chat runs in is a git repository, from the daemon's
 * `GET /api/graph/status?cwd=` (`isGitRepo`). Swarm needs one: every worker gets its own git
 * worktree. Asked once per folder (a folder rarely turns into a repo mid-session; a failed read is
 * retried on the next mount). null while unknown, and whenever the daemon can't say.
 */
const cache = new Map<string, boolean>();
const GIT_REPO_EVENT = "kora:project-is-git-repo";

/** After "Set up git here": every mounted hook for that folder flips to true without a refetch. */
export function markProjectIsGitRepo(httpBaseUrl: string, cwd: string, value: boolean): void {
  cache.set(`${httpBaseUrl}\u0000${cwd}`, value);
  window.dispatchEvent(
    new CustomEvent(GIT_REPO_EVENT, { detail: { key: `${httpBaseUrl}\u0000${cwd}`, value } }),
  );
}

export function useProjectIsGitRepo(
  httpBaseUrl: string | null,
  cwd: string | null,
): boolean | null {
  const key = httpBaseUrl && cwd ? `${httpBaseUrl}\u0000${cwd}` : null;
  const [value, setValue] = useState<boolean | null>(key ? (cache.get(key) ?? null) : null);

  useEffect(() => {
    if (!key || !httpBaseUrl || !cwd) {
      setValue(null);
      return;
    }
    let cancelled = false;
    const onMark = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; value: boolean }>).detail;
      if (d?.key === key && !cancelled) setValue(d.value);
    };
    window.addEventListener(GIT_REPO_EVENT, onMark);
    const unlisten = () => {
      cancelled = true;
      window.removeEventListener(GIT_REPO_EVENT, onMark);
    };
    const cached = cache.get(key);
    if (cached !== undefined) {
      setValue(cached);
      return unlisten;
    }
    setValue(null);
    void (async () => {
      try {
        const url = new URL("/api/graph/status", httpBaseUrl);
        url.searchParams.set("cwd", cwd);
        const res = await fetchPrimaryHost(url.toString());
        if (!res.ok) return;
        const body = (await res.json()) as { isGitRepo?: unknown; busy?: unknown };
        if (body.busy === true) return; // the graph reader is busy: unknown, not "no"
        if (typeof body.isGitRepo !== "boolean") return;
        cache.set(key, body.isGitRepo);
        if (!cancelled) setValue(body.isGitRepo);
      } catch {
        /* unknown: Swarm stays offered; the worker spawn reports the problem */
      }
    })();
    return unlisten;
  }, [cwd, httpBaseUrl, key]);

  return value;
}
