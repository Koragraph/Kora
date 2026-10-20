// Webhook triggers for one routine. The secret exists on screen exactly once: right after Create or Rotate it is shown
// with a copy button and a ready-made curl line; closing the notice (or leaving) discards it, and the daemon only keeps a
// hash. The receiver is loopback-only, so the copy says so.
import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  RotateCwIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { curlExample, whenLabel, type RoutineWire, type TriggerWire } from "./routineModel";
import { useRoutinesApi } from "./routinesApi";

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

/** The one-time reveal. Rendered only while `secret` is held in the parent's state. */
export function SecretReveal(props: {
  readonly trigger: TriggerWire;
  readonly secret: string;
  readonly rotated: boolean;
  readonly onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The secret is shown once: bring it into view even when the dialog was scrolled to the triggers above it.
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [props.secret]);
  return (
    <div
      ref={box}
      data-secret-reveal
      role="alert"
      className="space-y-2.5 rounded-xl bg-warning-surface p-3 ring-1 ring-warning/35"
    >
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-warning-foreground">
        <KeyRoundIcon className="size-3.5" aria-hidden />
        {props.rotated ? "New secret. The old one stopped working." : "Your webhook secret"}
      </div>
      <p className="text-[12px] leading-snug text-warning-foreground/90">
        Copy it now. It is shown once and Kora keeps only a fingerprint, so it cannot be shown
        again. Lost it? Rotate to get a new one.
      </p>
      <div className="flex items-center gap-1.5">
        <code
          data-secret-value
          className="min-w-0 flex-1 rounded-lg bg-background px-2.5 py-1.5 font-mono text-[11.5px] break-all ring-1 ring-border/70 select-all"
        >
          {props.secret}
        </code>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void copyText(props.secret, "Secret").then((ok) => setCopied(ok))}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <details open className="group">
        <summary className="cursor-pointer text-[12px] font-medium text-warning-foreground select-none">
          Try it from a terminal
        </summary>
        <pre
          data-curl
          className="mt-1.5 rounded-lg bg-background p-2.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap ring-1 ring-border/70"
        >
          {curlExample(props.trigger.url, props.secret)}
        </pre>
        <Button
          size="xs"
          variant="ghost"
          className="mt-1"
          onClick={() =>
            void copyText(curlExample(props.trigger.url, props.secret), "curl command")
          }
        >
          <CopyIcon />
          Copy curl
        </Button>
      </details>
      <div className="flex justify-end">
        <Button size="xs" onClick={props.onDone} data-secret-done>
          I saved it
        </Button>
      </div>
    </div>
  );
}

export function WebhookTriggers(props: {
  readonly routine: RoutineWire;
  readonly webhook: { baseUrl: string; receiverUp: boolean };
  readonly onChanged: () => void;
  readonly now?: number;
}) {
  const api = useRoutinesApi();
  const { routine } = props;
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<{
    trigger: TriggerWire;
    secret: string;
    rotated: boolean;
  } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState<string | null>(null);
  const now = props.now ?? Date.now();

  const fail = (message: string) =>
    toastManager.add({ type: "error", title: "Webhook", description: message });

  const create = async () => {
    setBusy(true);
    const r = await api.createTrigger(routine.id, label.trim() || "Webhook");
    setBusy(false);
    if (!r.ok) return fail(r.message);
    setReveal({ ...r.value, rotated: false });
    setAdding(false);
    setLabel("");
    props.onChanged();
  };
  const rotate = async (t: TriggerWire) => {
    setBusy(true);
    const r = await api.rotateTrigger(routine.id, t.id);
    setBusy(false);
    setConfirmRotate(null);
    if (!r.ok) return fail(r.message);
    setReveal({ ...r.value, rotated: true });
    props.onChanged();
  };
  const del = async (t: TriggerWire) => {
    const r = await api.deleteTrigger(routine.id, t.id);
    if (!r.ok) return fail(r.message);
    if (reveal?.trigger.id === t.id) setReveal(null);
    props.onChanged();
  };

  return (
    <section data-webhook-triggers className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          <WebhookIcon className="size-3.5" aria-hidden /> Webhooks
        </h4>
        {!adding && routine.triggers.length < 5 ? (
          <Button size="xs" variant="outline" onClick={() => setAdding(true)} data-add-webhook>
            <PlusIcon /> Add webhook
          </Button>
        ) : null}
      </div>
      <p className="text-[12px] leading-snug text-muted-foreground">
        Let another tool start this routine with an HTTP POST. It listens on{" "}
        <code>{props.webhook.baseUrl}</code>, which only this Mac can reach; to receive events from
        the internet, point your own tunnel at it.
        {props.webhook.receiverUp ? null : (
          <span className="mt-1 block text-destructive-foreground">
            The receiver is not running right now.
          </span>
        )}
      </p>

      {adding ? (
        // Not a <form>: this sits inside the routine editor's own form, and a nested form's submit bubbles up and saves
        // (and closes) the editor instead of creating the webhook.
        <div
          role="group"
          aria-label="New webhook"
          className="flex items-center gap-2"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (!busy) void create();
            }
          }}
        >
          <Input
            nativeInput
            autoFocus
            aria-label="Webhook name"
            placeholder="Name, e.g. GitHub deploys"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
          />
          <Button
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => void create()}
            data-webhook-create
          >
            Create
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      ) : null}

      {reveal ? (
        <SecretReveal
          trigger={reveal.trigger}
          secret={reveal.secret}
          rotated={reveal.rotated}
          onDone={() => setReveal(null)}
        />
      ) : null}

      <ul className="space-y-1.5">
        {routine.triggers.map((t) => (
          <li key={t.id} data-trigger={t.id} className="rounded-xl p-2.5 ring-1 ring-border/70">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium text-foreground">{t.label}</div>
                <div className="text-[11.5px] text-muted-foreground">
                  {t.lastEventAt ? `Last event ${whenLabel(t.lastEventAt, now)}` : "No events yet"}
                  {t.rotatedAt ? ` · rotated ${whenLabel(t.rotatedAt, now)}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {confirmRotate === t.id ? (
                  <>
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={busy}
                      onClick={() => void rotate(t)}
                    >
                      Rotate now
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmRotate(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setConfirmRotate(t.id)}
                      aria-label={`Rotate secret for ${t.label}`}
                    >
                      <RotateCwIcon /> Rotate
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => void del(t)}
                      aria-label={`Delete ${t.label}`}
                    >
                      <Trash2Icon />
                    </Button>
                  </>
                )}
              </div>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-md bg-card px-2 py-1 font-mono text-[11px] ring-1 ring-border/60">
                POST {t.url}
              </code>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Copy URL"
                onClick={() => void copyText(t.url, "URL")}
              >
                <CopyIcon />
              </Button>
            </div>
            {confirmRotate === t.id ? (
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                Anything using the current secret will be refused until you give it the new one.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
