// Settings > Outside access: let Claude Desktop, Cursor, Claude Code or Codex orchestrate your blobs over MCP.
// Create a named token per client (shown once), paste the ready-made config, see every call they made, revoke any time.
import { CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/util/utils";
import { toastManager } from "~/components/ui/toast";
import { PrefsPageContainer, PrefsRow, PrefsSection } from "../../prefs/prefsLayout";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  useOutsideApi,
  type OutsideAuditWire,
  type OutsideSetupWire,
  type OutsideTokenWire,
} from "./outsideApi";
import {
  CLIENTS,
  TOKEN_PLACEHOLDER,
  auditOutcome,
  auditTime,
  createdLabel,
  lastUsedLabel,
  snippetFor,
  toolWords,
  type ClientKind,
} from "./outsideModel";

async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toastManager.add({ type: "success", title: `${what} copied` });
    return true;
  } catch {
    toastManager.add({
      type: "error",
      title: "Could not copy",
      description: "Select the text and copy it by hand.",
    });
    return false;
  }
}

export function OutsideAccessSettings(props: {
  readonly anchorId?: string;
  /** Audit refresh interval. 0 = off (tests). */
  readonly pollMs?: number;
  readonly now?: () => number;
}) {
  const api = useOutsideApi();
  const nowFn = props.now ?? Date.now;
  const pollMs = props.pollMs ?? 10_000;
  const [setup, setSetup] = useState<OutsideSetupWire | null>(null);
  const [tokens, setTokens] = useState<ReadonlyArray<OutsideTokenWire> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReadonlyArray<OutsideAuditWire> | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [reveal, setReveal] = useState<{ token: OutsideTokenWire; secret: string } | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [client, setClient] = useState<ClientKind>("claude-desktop");
  const now = nowFn();

  // One failed read is not a verdict (the daemon link may still be coming up): the error shows after a second miss in a row.
  const misses = useRef(0);
  const loadTokens = useCallback(async () => {
    const r = await api.tokens();
    if (r.ok) {
      misses.current = 0;
      setTokens(r.value);
      setLoadError(null);
    } else {
      misses.current += 1;
      if (misses.current >= 2) setLoadError(r.message);
    }
  }, [api]);
  const loadAudit = useCallback(async () => {
    const r = await api.audit(null);
    if (r.ok) {
      setRows(r.value.rows);
      setNext(r.value.next);
    }
  }, [api]);

  // The launch line for THIS install. A call made before the daemon link is up is not an answer: ask again every few seconds until
  // one lands (tokens and the log are re-read on the poll too, so they recover on their own).
  const loadSetup = useCallback(async () => {
    const r = await api.setup();
    if (r.ok) setSetup(r.value);
    return r.ok;
  }, [api]);
  useEffect(() => {
    let off = false;
    void loadSetup().then((ok) => {
      if (!ok && !off) {
        /* retried below */
      }
    });
    void loadTokens();
    void loadAudit();
    return () => {
      off = true;
    };
  }, [loadSetup, loadTokens, loadAudit]);
  const loadAuditRef = useRef(loadAudit);
  loadAuditRef.current = loadAudit;
  const setupLoaded = useRef(false);
  setupLoaded.current = setup !== null;
  const tokensLoaded = useRef(false);
  tokensLoaded.current = tokens !== null;
  const loadTokensRef = useRef(loadTokens);
  loadTokensRef.current = loadTokens;
  useEffect(() => {
    const retry = setInterval(() => {
      if (!setupLoaded.current) void loadSetup();
      if (!tokensLoaded.current) void loadTokensRef.current();
    }, 2_000);
    return () => clearInterval(retry);
  }, [loadSetup]);
  useEffect(() => {
    if (pollMs <= 0) return;
    const t = setInterval(() => {
      void loadAuditRef.current();
      void loadTokens();
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, loadTokens]);

  const create = async () => {
    const n = name.trim();
    if (!n) {
      setNameError("Give this client a name, for example Claude Desktop.");
      return;
    }
    setBusy(true);
    const r = await api.create(n);
    setBusy(false);
    if (!r.ok) {
      setNameError(r.message);
      return;
    }
    setNameError(null);
    setName("");
    setReveal(r.value);
    void loadTokens();
  };
  const revoke = async (t: OutsideTokenWire) => {
    setBusy(true);
    const r = await api.revoke(t.id);
    setBusy(false);
    setConfirmRevoke(null);
    if (!r.ok)
      toastManager.add({ type: "error", title: "Could not revoke", description: r.message });
    else {
      if (reveal?.token.id === t.id) setReveal(null);
      toastManager.add({
        type: "success",
        title: `${t.name} revoked`,
        description: "It stops working immediately.",
      });
    }
    void loadTokens();
    void loadAudit();
  };
  const more = async () => {
    if (next === null) return;
    const r = await api.audit(next);
    if (r.ok) {
      setRows((cur) => [...(cur ?? []), ...r.value.rows]);
      setNext(r.value.next);
    }
  };

  const active = (tokens ?? []).filter((t) => t.revokedAt === null);
  const revoked = (tokens ?? []).filter((t) => t.revokedAt !== null);
  const snippet = useMemo(
    () => (setup ? snippetFor(client, setup, reveal?.secret ?? null) : ""),
    [setup, client, reveal],
  );
  const where = CLIENTS.find((c) => c.kind === client)!.where;

  return (
    <PrefsPageContainer>
      <PrefsSection title="Outside access" id={props.anchorId} data-outside>
        <PrefsRow
          title="Use your blobs from other apps"
          description="Claude Desktop, Cursor, Claude Code and Codex can list your blobs, read their threads, send them work and wait for the result. They cannot answer approvals, delete anything, or touch settings, keys, memory, connected apps or the browser. Anything that needs you waits in Kora."
        >
          <div className="mt-3 max-w-xl space-y-2.5">
            <form
              className="flex items-start gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <div className="min-w-0 flex-1">
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(null);
                  }}
                  placeholder="Name this client, e.g. Claude Desktop"
                  maxLength={40}
                  aria-label="Client name"
                  aria-invalid={nameError ? true : undefined}
                  data-token-name
                />
                {nameError ? (
                  <p
                    className="mt-1 text-[12px] text-destructive-foreground"
                    role="alert"
                    data-token-error
                  >
                    {nameError}
                  </p>
                ) : null}
              </div>
              <Button type="submit" size="sm" disabled={busy} data-token-create>
                <PlusIcon /> Create token
              </Button>
            </form>

            {reveal ? (
              <TokenReveal
                token={reveal.token}
                secret={reveal.secret}
                onDone={() => setReveal(null)}
              />
            ) : null}
          </div>
        </PrefsRow>

        <PrefsRow
          title="Tokens"
          description={
            setup
              ? `Each token is limited to ${setup.limits.callsPerMinute} calls and ${setup.limits.sendsPerMinute} messages a minute.`
              : undefined
          }
        >
          {loadError ? (
            <p className="mt-2 text-[12.5px] text-destructive-foreground" role="alert">
              {loadError}
            </p>
          ) : null}
          <ul className="mt-2 divide-y divide-border/50" data-token-list>
            {tokens === null && !loadError ? (
              <li className="py-2 text-[12.5px] text-muted-foreground">Loading...</li>
            ) : null}
            {tokens !== null && active.length === 0 ? (
              <li className="py-2 text-[12.5px] text-muted-foreground" data-token-empty>
                No tokens yet. Create one above for the app you want to connect.
              </li>
            ) : null}
            {active.map((t) => (
              <li key={t.id} data-token={t.id} className="flex items-center gap-3 py-2 text-[13px]">
                <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{t.name}</span>
                  <span className="ml-2 font-mono text-[11.5px] text-muted-foreground">
                    kbo_...{t.suffix}
                  </span>
                  <span className="block text-[11.5px] text-muted-foreground">
                    Created {createdLabel(t.createdAt)} · {lastUsedLabel(t.lastUsedAt, now)}
                  </span>
                </span>
                {confirmRevoke === t.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={busy}
                      onClick={() => void revoke(t)}
                      data-revoke-confirm
                    >
                      Revoke now
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmRevoke(null)}>
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setConfirmRevoke(t.id)}
                    aria-label={`Revoke ${t.name}`}
                    data-revoke
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
            {revoked.map((t) => (
              <li
                key={t.id}
                data-token-revoked={t.id}
                className="flex items-center gap-3 py-2 text-[13px] text-muted-foreground"
              >
                <KeyRoundIcon className="size-3.5 shrink-0 opacity-50" aria-hidden />
                <span className="min-w-0 flex-1 truncate line-through decoration-muted-foreground/50">
                  {t.name}
                </span>
                <span className="text-[11.5px]">Revoked {createdLabel(t.revokedAt!)}</span>
              </li>
            ))}
          </ul>
        </PrefsRow>

        <PrefsRow
          title="Connect a client"
          description="Paste this into the app's MCP config, then restart it. The token goes in the config, so treat the file like a password."
        >
          <div className="mt-3 max-w-xl" data-snippets>
            <div
              role="tablist"
              aria-label="Client"
              className="inline-flex gap-0.5 rounded-full bg-white/[0.06] p-0.5"
            >
              {CLIENTS.map((c) => (
                <button
                  key={c.kind}
                  type="button"
                  role="tab"
                  aria-selected={client === c.kind}
                  data-client-tab={c.kind}
                  onClick={() => setClient(c.kind)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
                    client === c.kind
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-muted-foreground">{where}</p>
            <div className="relative mt-1.5">
              <pre
                data-snippet={client}
                className="overflow-x-auto rounded-xl bg-card p-3 pr-20 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all ring-1 ring-border/60"
              >
                {snippet || "Loading..."}
              </pre>
              <Button
                size="xs"
                variant="outline"
                className="absolute top-2 right-2"
                disabled={!snippet}
                onClick={() => void copyText(snippet, "Config")}
                data-copy-snippet
              >
                <CopyIcon /> Copy
              </Button>
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground" data-snippet-note>
              {reveal
                ? `Your new "${reveal.token.name}" token is already filled in.`
                : `Create a token above and this fills in with it. Until then ${TOKEN_PLACEHOLDER} stands in.`}
            </p>
          </div>
        </PrefsRow>
      </PrefsSection>

      <PrefsSection
        title="Activity"
        data-outside-audit
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh activity"
            onClick={() => void loadAudit()}
          >
            <RefreshCwIcon />
          </Button>
        }
      >
        <div className="pt-1" data-audit-list>
          {rows === null ? (
            <p className="py-2 text-[12.5px] text-muted-foreground">Loading...</p>
          ) : null}
          {rows !== null && rows.length === 0 ? (
            <p className="py-2 text-[12.5px] text-muted-foreground" data-audit-empty>
              Nothing yet. Every call an outside app makes shows up here.
            </p>
          ) : null}
          {rows !== null && rows.length > 0 ? (
            <ul className="divide-y divide-border/50">
              {rows.map((r) => (
                <li
                  key={r.id}
                  data-audit-row={r.id}
                  data-audit-ok={r.ok}
                  className="flex items-baseline gap-3 py-1.5 text-[12.5px]"
                >
                  <span className="w-[5.5rem] shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                    {auditTime(r.at, now)}
                  </span>
                  <span className="w-28 shrink-0 truncate font-medium text-foreground">
                    {r.client}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground/90">
                    {toolWords(r.tool)}
                    {r.target ? (
                      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                        {r.target}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[11.5px]",
                      r.ok ? "text-muted-foreground" : "text-destructive-foreground",
                    )}
                  >
                    {auditOutcome(r)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {next !== null ? (
            <div className="pt-2">
              <Button size="xs" variant="ghost" onClick={() => void more()} data-audit-more>
                Show older
              </Button>
            </div>
          ) : null}
        </div>
      </PrefsSection>
    </PrefsPageContainer>
  );
}

/** The one-time reveal. Rendered only while the parent holds `secret`; closing it discards it. */
function TokenReveal(props: {
  readonly token: OutsideTokenWire;
  readonly secret: string;
  readonly onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      data-token-reveal
      role="alert"
      className="space-y-2.5 rounded-xl bg-warning-surface p-3 ring-1 ring-warning/35"
    >
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-warning-foreground">
        <KeyRoundIcon className="size-3.5" aria-hidden />
        Token for {props.token.name}
      </div>
      <p className="text-[12px] leading-snug text-warning-foreground/90">
        Copy it now. It is shown once and Kora keeps only a fingerprint, so it cannot be shown
        again. Lost it? Revoke it and make a new one.
      </p>
      <div className="flex items-center gap-1.5">
        <code
          data-token-value
          className="min-w-0 flex-1 rounded-lg bg-background px-2.5 py-1.5 font-mono text-[11.5px] break-all ring-1 ring-border/70 select-all"
        >
          {props.secret}
        </code>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void copyText(props.secret, "Token").then((ok) => setCopied(ok))}
          data-copy-token
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Button size="xs" variant="ghost" onClick={props.onDone} data-token-done>
        I have copied it
      </Button>
    </div>
  );
}
