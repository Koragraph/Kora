// Debounced autosave for a settings text field: typing marks it "Saving…", the save lands after a pause, then it
// reads "Saved". A failed save keeps the text and shows the error. The last value is flushed on unmount.
import { useCallback, useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export function useAutosave(input: {
  /** The persisted value; the field adopts it once loaded (null = still loading). */
  readonly initial: string | null;
  readonly save: (value: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  readonly delayMs?: number;
}) {
  const { initial, save, delayMs = 800 } = input;
  const [value, setValueState] = useState("");
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (initial !== null && !loadedRef.current) {
      loadedRef.current = true;
      setValueState(initial);
    }
  }, [initial]);

  const flush = useCallback(async () => {
    const next = pendingRef.current;
    if (next === null) return;
    pendingRef.current = null;
    setStatus("saving");
    const result = await saveRef.current(next);
    if (pendingRef.current !== null) return; // a newer edit is already queued
    if (result.ok) {
      setStatus("saved");
      setError(null);
    } else {
      setStatus("error");
      setError(result.message);
    }
  }, []);

  const setValue = useCallback(
    (next: string) => {
      setValueState(next);
      pendingRef.current = next;
      setStatus("saving");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), delayMs);
    },
    [delayMs, flush],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void flush();
    },
    [flush],
  );

  return { value, setValue, status, error, loaded: loadedRef.current || initial !== null };
}

export function AutosaveLabel(props: { status: AutosaveStatus; error: string | null }) {
  if (props.status === "idle") return null;
  const text =
    props.status === "saving"
      ? "Saving…"
      : props.status === "saved"
        ? "Saved"
        : (props.error ?? "Could not save");
  return (
    <span
      role="status"
      data-autosave={props.status}
      className={
        props.status === "error"
          ? "text-[11.5px] text-destructive"
          : "text-[11.5px] text-muted-foreground"
      }
    >
      {text}
    </span>
  );
}
