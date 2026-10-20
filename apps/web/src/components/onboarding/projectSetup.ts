import { useEffect, useMemo, useState } from "react";

import { fetchPrimaryHost } from "../../hosts/primary/shellAuth";
import type { GraphFreshness } from "../../hooks/useGraphFreshness";
import { useProjects } from "../../atoms/entities";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** `GET /api/graph/status?cwd=` once (null when the daemon did not answer). */
export async function fetchGraphStatus(
  httpBaseUrl: string,
  cwd: string,
  fetchImpl: FetchImpl = fetchPrimaryHost,
): Promise<GraphFreshness | null> {
  try {
    const url = new URL("/api/graph/status", httpBaseUrl);
    url.searchParams.set("cwd", cwd);
    const res = await fetchImpl(url.toString());
    if (!res.ok) return null;
    const body = (await res.json()) as GraphFreshness;
    return body.busy ? null : body; // busy = no answer yet
  } catch {
    return null;
  }
}

export type IndexRequest = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The daemon's refusal codes, in words a person can act on. */
function indexRefusal(reason: unknown): string {
  if (reason === "unsafe-root") return "Kora never indexes a home or system folder.";
  if (reason === "bare-repo") return "This is a bare git repo, so there are no files to index.";
  if (typeof reason === "string" && /busy/i.test(reason))
    return "The code map is busy. Try again in a moment.";
  return typeof reason === "string" && reason ? reason : "Kora's local service refused it.";
}

/** Ask the daemon to (re)build this folder's code map; says why when it can't. */
export async function requestIndex(
  httpBaseUrl: string,
  cwd: string,
  options: { readonly force?: boolean; readonly full?: boolean } = {},
  fetchImpl: FetchImpl = fetchPrimaryHost,
): Promise<IndexRequest> {
  try {
    const url = new URL("/api/graph/reindex", httpBaseUrl);
    url.searchParams.set("cwd", cwd);
    if (options.force) url.searchParams.set("force", "1");
    if (options.full) url.searchParams.set("full", "1");
    const res = await fetchImpl(url.toString(), { method: "POST" });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
    return { ok: false, reason: indexRefusal(body?.reason) };
  } catch {
    return { ok: false, reason: "Kora's local service didn't answer." };
  }
}

export async function startIndex(
  httpBaseUrl: string,
  cwd: string,
  options: { readonly force?: boolean } = {},
  fetchImpl: FetchImpl = fetchPrimaryHost,
): Promise<boolean> {
  return (await requestIndex(httpBaseUrl, cwd, options, fetchImpl)).ok;
}

/** A folder Claude Code has already opened on this Mac (daemon `GET /api/onboarding/recent-projects`). */
export interface RecentProject {
  readonly path: string;
  readonly name: string;
  /** `~/…` form for display. */
  readonly displayPath: string;
  readonly isGitRepo: boolean;
}

export function parseRecentProjects(value: unknown): RecentProject[] {
  const list = (value as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): RecentProject[] => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.path !== "string" || !r.path.startsWith("/")) return [];
    const name =
      typeof r.name === "string" && r.name ? r.name : (r.path.split("/").pop() ?? r.path);
    return [
      {
        path: r.path,
        name,
        displayPath: typeof r.displayPath === "string" && r.displayPath ? r.displayPath : r.path,
        isGitRepo: r.isGitRepo === true,
      },
    ];
  });
}

/** Recent Claude Code folders that are not Kora projects yet; null while loading (or on an older daemon: []). */
export function useRecentProjects(httpBaseUrl: string | null): readonly RecentProject[] | null {
  const projects = useProjects();
  const [list, setList] = useState<readonly RecentProject[] | null>(null);
  useEffect(() => {
    if (!httpBaseUrl) return;
    let live = true;
    const url = new URL("/api/onboarding/recent-projects", httpBaseUrl).toString();
    fetchPrimaryHost(url)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (body) => {
          if (live) setList(parseRecentProjects(body));
        },
        () => {
          if (live) setList([]);
        },
      );
    return () => {
      live = false;
    };
  }, [httpBaseUrl]);
  return useMemo(() => {
    if (list === null) return null;
    const known = new Set(projects.map((p) => p.workspaceRoot.replace(/\/+$/, "")));
    return list.filter((r) => !known.has(r.path));
  }, [list, projects]);
}
