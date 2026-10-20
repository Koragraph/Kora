export const WEBVIEW_CRASH_RECOVERY_WINDOW_MS = 30_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const BASE_RECOVERY_DELAY_MS = 250;

export interface WebviewCrashRecoveryState {
  readonly windowStartedAt: number | null;
  readonly attempts: number;
}

export interface WebviewCrashRecoveryPlan {
  readonly state: WebviewCrashRecoveryState;
  readonly delayMs: number;
}

export const INITIAL_WEBVIEW_CRASH_RECOVERY_STATE: WebviewCrashRecoveryState = {
  windowStartedAt: null,
  attempts: 0,
};

const windowExpired = (state: WebviewCrashRecoveryState, at: number): boolean =>
  state.windowStartedAt === null || at - state.windowStartedAt >= WEBVIEW_CRASH_RECOVERY_WINDOW_MS;

export function planWebviewCrashRecovery(
  snap: WebviewCrashRecoveryState,
  at: number,
): WebviewCrashRecoveryPlan | null {
  const fresh = windowExpired(snap, at);
  const used = fresh ? 0 : snap.attempts;
  if (used >= MAX_RECOVERY_ATTEMPTS) return null;

  return {
    state: { windowStartedAt: fresh ? at : snap.windowStartedAt, attempts: used + 1 },
    delayMs: BASE_RECOVERY_DELAY_MS * 2 ** used,
  };
}
