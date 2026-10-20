// Runs preview requests in a module Worker when the environment has one, otherwise inline (tests, SSR). The worker is
// created on first use and shared; bytes are transferred, not copied.
import { createPreviewHandler, type PreviewRequest, type PreviewResult } from "./previewHandler";

type Runner = (request: PreviewRequest) => Promise<PreviewResult>;

let runner: Runner | null = null;

function createWorkerRunner(): Runner | null {
  if (typeof Worker === "undefined") return null;
  try {
    const worker = new Worker(new URL("./preview.worker.ts", import.meta.url), { type: "module" });
    let nextId = 1;
    const pending = new Map<number, (result: PreviewResult) => void>();
    worker.onmessage = (event: MessageEvent<{ id: number; result: PreviewResult }>) => {
      const resolve = pending.get(event.data.id);
      pending.delete(event.data.id);
      resolve?.(event.data.result);
    };
    worker.onerror = () => {
      for (const resolve of pending.values()) {
        resolve({
          ok: false,
          code: "unavailable",
          message: "The preview worker stopped. Try again.",
        });
      }
      pending.clear();
      runner = null;
    };
    return (request) =>
      new Promise<PreviewResult>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        const transfer =
          request.op === "open-sheet" || request.op === "office-meta" ? [request.bytes] : [];
        worker.postMessage({ id, request }, transfer);
      });
  } catch {
    return null;
  }
}

export function runPreview(request: PreviewRequest): Promise<PreviewResult> {
  runner ??= createWorkerRunner() ?? createPreviewHandler();
  return runner(request);
}

/** Test seam: force the inline handler. */
/** @public Kept for tests and external callers (knip). */
export function resetPreviewRunnerForTests(): void {
  runner = createPreviewHandler();
}
