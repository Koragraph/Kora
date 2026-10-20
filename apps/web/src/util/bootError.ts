/** The static splash in index.html, present until React replaces #root's content. */
const splash = (): HTMLElement | null =>
  typeof document === "undefined" ? null : document.getElementById("kora-splash");

/** Startup failed before React mounted: say so on the splash, with a reload button. */
export function showBootError(err: unknown) {
  console.error("Kora failed to start.", err);
  const host = splash();
  if (!host) return;
  const panel = Object.assign(document.createElement("section"), {
    className: "kora-splash-error",
  });
  panel.setAttribute("role", "alert");
  const line = (text: string) => Object.assign(document.createElement("p"), { textContent: text });
  panel.append(line("Kora could not load."));
  if (import.meta.env.DEV && err instanceof Error) panel.append(line(err.message));
  const reload = Object.assign(document.createElement("button"), {
    type: "button",
    textContent: "Reload",
  });
  reload.addEventListener("click", () => window.location.reload());
  panel.append(reload);
  host.replaceChildren(panel);
}

const WAIT_NOTE_ID = "kora-splash-wait";

/**
 * While the daemon has not answered yet (see retryTransientBootstrap), explain the wait under the mark instead of
 * leaving a silent black window. clearBootWaiting removes it once the daemon answers.
 */
export function showBootWaiting(): void {
  const host = splash();
  if (!host || document.getElementById(WAIT_NOTE_ID)) return;
  const note = Object.assign(document.createElement("p"), {
    id: WAIT_NOTE_ID,
    textContent:
      "Waiting for Kora's background service to answer… It starts on its own; this page connects as soon as it does. If it takes more than a minute, quit and reopen Kora.",
  });
  note.setAttribute("role", "status");
  note.style.cssText =
    "margin:12px 24px 0;max-width:420px;text-align:center;font-size:13px;line-height:1.5;color:#8b8d95";
  host.append(note);
}

export function clearBootWaiting(): void {
  if (typeof document === "undefined") return;
  document.getElementById(WAIT_NOTE_ID)?.remove();
}
