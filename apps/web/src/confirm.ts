import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@kora/contracts";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming" | "closing";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly confirmLabel?: string;
      readonly description?: string;
    };

interface PendingRequest {
  readonly shown: Exclude<ConfirmDialogState, { status: "idle" }>;
  readonly settle: (confirmed: boolean) => void;
}

const IDLE: ConfirmDialogState = { status: "idle" };

let state: ConfirmDialogState = IDLE;
let hosts = 0;
let current: PendingRequest | null = null;
const waiting: PendingRequest[] = [];
const listeners = new Set<() => void>();

function setState(upcoming: ConfirmDialogState): void {
  state = upcoming;
  for (const subscriber of [...listeners]) subscriber();
}

export const readConfirmDialogState = (): ConfirmDialogState => state;

export function subscribeConfirmDialog(subscriber: () => void): () => void {
  listeners.add(subscriber);
  return () => {
    listeners.delete(subscriber);
  };
}

function abandonEverything(): void {
  const all = [current, ...waiting.splice(0)];
  current = null;
  for (const req of all) req?.settle(false);
}

export function registerConfirmDialogHost(): () => void {
  hosts += 1;
  let released = false;
  return () => {
    if (released === true) return;
    released = true;
    hosts -= 1;
    if (hosts === 0) {
      abandonEverything();
      setState(IDLE);
    }
  };
}

export function askToConfirm(
  msg: string,
  opts?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  if (hosts === 0) return undefined;
  return new Promise<boolean>((resolve) => {
    const req: PendingRequest = {
      settle: resolve,
      shown: {
        status: "confirming",
        message: msg,
        variant: opts?.variant ?? "default",
        ...(opts?.confirmLabel ? { confirmLabel: opts.confirmLabel } : {}),
        ...(opts?.description ? { description: opts.description } : {}),
      },
    };
    if (current !== null || state.status === "closing") {
      waiting.push(req);
      return;
    }
    current = req;
    setState(req.shown);
  });
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || current === null) return;
  const answered = current;
  current = null;
  answered.settle(confirmed);
  setState({ ...answered.shown, status: "closing" });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;
  const upcoming = waiting.shift();
  if (!upcoming) {
    setState(IDLE);
    return;
  }
  current = upcoming;
  setState(upcoming.shown);
}

export function resetConfirmDialogForTests(): void {
  abandonEverything();
  hosts = 0;
  state = IDLE;
  listeners.clear();
}
