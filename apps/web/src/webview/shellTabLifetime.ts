import { webBridge } from "~/components/web/webBridge";
import { stopBrowserScreencast } from "./browserScreencast";
import { browserDefaultTabState, resolveBrowserDefaults } from "./browserDefaults";

interface ShellTabLease {
  ready: Promise<void>;
  closeTimer: number | null;
  references: number;
}

const leases = new Map<string, ShellTabLease>();
const pendingTabOperations = new Map<string, Promise<void>>();

const enqueueShellTabOperation = (
  tabKey: string,
  operation1: () => Promise<void> | void,
): Promise<void> => {
  const prior = pendingTabOperations.get(tabKey);
  const queued = prior
    ? prior.catch(() => undefined).then(operation1)
    : Promise.resolve(operation1());
  pendingTabOperations.set(tabKey, queued);
  void queued
    .finally(() => {
      if (pendingTabOperations.get(tabKey) === queued) {
        pendingTabOperations.delete(tabKey);
      }
    })
    .catch(() => undefined);
  return queued;
};

export interface AcquiredShellTab {
  readonly ready: Promise<void>;
  readonly release: () => void;
}

export function acquireShellTab(tabKey: string): AcquiredShellTab {
  const live =
    leases.get(tabKey) ??
    ({
      references: 0,
      closeTimer: null,
      // Zoom/appearance defaults travel with creation so the guest never
      // paints a frame at 100%/system before the preference is applied.
      ready: enqueueShellTabOperation(tabKey, async () =>
        webBridge?.createTab(tabKey, browserDefaultTabState(await resolveBrowserDefaults())),
      ),
    } satisfies ShellTabLease);
  if (live.closeTimer !== null) window.clearTimeout(live.closeTimer);
  live.references += 1;
  live.closeTimer = null;
  leases.set(tabKey, live);

  return {
    ready: live.ready,
    release: () => {
      const lease = leases.get(tabKey);
      if (lease === undefined) return;
      lease.references = Math.max(lease.references - 1, 0);
      if (lease.references !== 0) return;
      lease.closeTimer = window.setTimeout(() => {
        const latest = leases.get(tabKey);
        if (!latest || latest.references > 0) return;
        leases.delete(tabKey);
        void enqueueShellTabOperation(tabKey, async () => {
          await stopBrowserScreencast(tabKey).catch(() => null);
          await webBridge?.closeTab(tabKey);
        }).catch(() => undefined);
      }, 0);
    },
  };
}
