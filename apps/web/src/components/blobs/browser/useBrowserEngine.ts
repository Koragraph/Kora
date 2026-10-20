import { resolvePrimaryHostHttpUrl } from "~/hosts/primary/target";
import { fetchPrimaryHost } from "~/hosts/primary/shellAuth";
import type { InstallState, EngineInfo } from "./browserModel";
// The blob browser's engine (the one-time ~98 MB download) over plain authed HTTP, NOT the live socket: the socket only
// exists while a page does, so a socket-only "needs setup" signal left the Computer tab on "Connecting" forever for a
// browser that had never been installed (live QA #4). `GET /api/blob-browser/engine` answers status + install progress;
// `POST /api/blob-browser/engine/install` starts the shared install. Polls while an install runs.
import {
  useEffect,
  createElement,
  useState,
  useRef,
  useCallback,
  useContext,
  createContext,
  type ReactNode,
} from "react";

export interface EngineSnapshot extends EngineInfo {
  readonly install: InstallState;
}
export interface EngineApi {
  status(): Promise<EngineSnapshot>;
  install(): Promise<EngineSnapshot>;
}

const PHASES = new Set(["download", "verify", "extract", "warm", "done", "error"]);

/** Defensive read of the endpoint's JSON (an older daemon answers 404 / something else: null). */
export function parseEngineSnapshot(raw: unknown): EngineSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.installed !== "boolean" || typeof r.supported !== "boolean") return null;
  const i = (typeof r.install === "object" && r.install !== null ? r.install : {}) as Record<
    string,
    unknown
  >;
  const state =
    i.state === "running" || i.state === "done" || i.state === "error" ? i.state : "idle";
  const phase =
    typeof i.phase === "string" && PHASES.has(i.phase)
      ? (i.phase as InstallState["phase"])
      : "download";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    supported: r.supported,
    installed: r.installed,
    version: typeof r.version === "string" ? r.version : null,
    downloadBytes: typeof r.downloadBytes === "number" ? r.downloadBytes : null,
    install: {
      state,
      phase,
      received: num(i.received),
      total: num(i.total),
      fraction: num(i.fraction),
      message: typeof i.message === "string" ? i.message : null,
    },
  };
}

const httpEngineApi: EngineApi = {
  async status() {
    const res = await fetchPrimaryHost(resolvePrimaryHostHttpUrl("/api/blob-browser/engine"));
    const snap = res.ok ? parseEngineSnapshot(await res.json()) : null;
    if (!snap) throw new Error(`engine status ${res.status}`);
    return snap;
  },
  async install() {
    const res = await fetchPrimaryHost(
      resolvePrimaryHostHttpUrl("/api/blob-browser/engine/install"),
      { method: "POST" },
    );
    const snap = res.ok ? parseEngineSnapshot(await res.json()) : null;
    if (!snap) throw new Error(`engine install ${res.status}`);
    return snap;
  },
};

const EngineApiContext = createContext<EngineApi>(httpEngineApi);
export function EngineApiProvider(props: {
  readonly api: EngineApi;
  readonly children: ReactNode;
}) {
  return createElement(EngineApiContext.Provider, { value: props.api }, props.children);
}

export interface BrowserEngine {
  /** null until the first answer (or when the daemon cannot say). */
  readonly snapshot: EngineSnapshot | null;
  readonly error: string | null;
  start(): void;
  refresh(): void;
}

const POLL_MS = 600;

export function useBrowserEngine(): BrowserEngine {
  const api = useContext(EngineApiContext);
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((p: Promise<EngineSnapshot>) => {
    p.then(
      (s) => {
        if (!alive.current) return;
        setSnapshot(s);
        setError(null);
      },
      (e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : "Could not reach Kora.");
      },
    );
  }, []);
  const refresh = useCallback(() => apply(api.status()), [api, apply]);
  const start = useCallback(() => {
    // show "running" at once; the daemon's own answer follows
    setSnapshot((s) =>
      s
        ? { ...s, install: { ...s.install, state: "running", phase: "download", message: null } }
        : s,
    );
    apply(api.install());
  }, [api, apply]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  const running = snapshot?.install.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [running, refresh]);

  return { snapshot, error, start, refresh };
}
