import type { WebViewportSetting } from "@kora/contracts";

export const BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS = 15_000;

type Handler = (preference: WebViewportSetting) => Promise<void>;

class BrowserViewportCommitTimeoutError extends Error {
  constructor(readonly tabId: string) {
    super(`Timed out committing the browser viewport for tab ${tabId}`);
  }
  override readonly name = "BrowserViewportCommitTimeoutError";
}

const handlers = new Map<string, Handler>();
// The promise of the last queued commit per tab: the next one starts after it truly settles.
const queueTails = new Map<string, Promise<unknown>>();

export function subscribeBrowserViewportChange(tabKey: string, cb: Handler): () => void {
  handlers.set(tabKey, cb);
  return () => {
    if (handlers.get(tabKey) === cb) handlers.delete(tabKey);
  };
}

export function commitBrowserViewportChange(
  tabKey: string,
  preference: WebViewportSetting,
): Promise<void> {
  const prior = queueTails.get(tabKey) ?? Promise.resolve();

  // What the queue waits on is the handler itself, even after the caller gave up on it.
  const exec = prior
    .catch(() => undefined)
    .then(() => {
      const cb = handlers.get(tabKey);
      if (!cb) throw new Error(`No visible browser viewport handler for tab ${tabKey}`);
      return { running: cb(preference) };
    });

  const tail = exec.then(
    ({ running }) => running,
    () => undefined,
  );
  const settled = tail.catch(() => undefined);
  queueTails.set(tabKey, settled);
  void settled.then(() => {
    if (queueTails.get(tabKey) === settled) queueTails.delete(tabKey);
  });

  return new Promise<void>((resolve, fail) => {
    let tmr: ReturnType<typeof setTimeout> | undefined;
    // The clock starts when the commit reaches the front, not when it was queued.
    void exec.then(({ running }) => {
      tmr = setTimeout(
        () => fail(new BrowserViewportCommitTimeoutError(tabKey)),
        BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS,
      );
      running.then(
        () => {
          clearTimeout(tmr);
          resolve();
        },
        (err: unknown) => {
          clearTimeout(tmr);
          fail(err);
        },
      );
    }, fail);
  });
}
