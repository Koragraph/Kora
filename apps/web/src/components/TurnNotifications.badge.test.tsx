import { HostId } from "@kora/contracts";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  hosts: ["one", "two"],
  shells: new Map<string, unknown>(),
  setBadge: vi.fn(),
  playSound: vi.fn(),
  goTo: vi.fn(),
  showToast: vi.fn(),
  inApp: false,
  mode: "notifications",
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: (id: string) => fake.shells.get(id) }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => ({}), useNavigate: () => fake.goTo }));
vi.mock("./ui/toast", () => ({ toastManager: { add: fake.showToast } }));
vi.mock("../atoms/shell", () => ({ hostShell: { stateEntryAtom: (id: string) => id } }));
vi.mock("../atoms/hosts", () => ({
  useHosts: () => ({ environments: fake.hosts.map((hostId) => ({ hostId })) }),
}));
vi.mock("../hooks/usePrefs", () => ({
  getClientPrefs: () => ({ notificationMode: fake.mode }),
  useClientPrefs: (
    pick: (p: { notificationMode: string; inAppNotificationsEnabled: boolean }) => unknown,
  ) => pick({ notificationMode: fake.mode, inAppNotificationsEnabled: fake.inApp }),
}));
vi.mock("../thread/threadNotifications", async (loadReal) => ({
  ...(await loadReal<typeof import("../thread/threadNotifications")>()),
  playNotificationSound: fake.playSound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: fake.setBadge,
}));

import { TurnNotifications } from "./TurnNotifications";

class SystemAlert extends EventTarget {
  static permission = "granted";
  static sent: SystemAlert[] = [];
  readonly close = vi.fn();
  readonly tag: string;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    this.tag = options.tag ?? "";
    SystemAlert.sent.push(this);
  }
}

const BASE_THREAD = {
  id: "thread",
  title: "Weekly sync notes",
  session: null,
  hasPendingUserInput: false,
  hasPendingApprovals: false,
  archivedAt: null as string | null,
  latestTurn: { completedAt: null as string | null, state: "running", turnId: "turn" },
};

let tree: ReactTestRenderer | undefined; // the mounted coordinator
const page = { focused: false, visibility: "visible" };

const liveShell = (patch: Partial<typeof BASE_THREAD> = {}) => ({
  status: "live",
  snapshot: Option.some({ threads: [{ ...BASE_THREAD, ...patch }] }),
});

function finishOn(host: string, completedAt = "2026-09-13T08:00:00Z") {
  fake.shells.set(
    host,
    liveShell({ latestTurn: { turnId: "turn", state: "completed", completedAt } }),
  );
}

const paint = () =>
  act(async () => {
    if (tree) tree.update(<TurnNotifications />);
    else tree = create(<TurnNotifications />);
  });

const lastBadge = () => fake.setBadge.mock.lastCall?.[0];
const badgeNeverRaised = () => fake.setBadge.mock.calls.every(([n]) => n === 0);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fake, { mode: "notifications", inApp: false, hosts: ["one", "two"] });
  fake.shells.set("one", liveShell());
  fake.shells.set("two", liveShell());
  Object.assign(page, { focused: false, visibility: "visible" });
  SystemAlert.permission = "granted";
  SystemAlert.sent = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", SystemAlert);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { focus: vi.fn() }));
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      hasFocus: () => page.focused,
      get visibilityState() {
        return page.visibility;
      },
    }),
  );
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});

test("a background failure raises the badge and a system alert, not a toast", async () => {
  fake.inApp = true;
  await paint();
  fake.shells.set("one", liveShell({ latestTurn: { ...BASE_THREAD.latestTurn, state: "error" } }));
  await paint();

  expect(SystemAlert.sent[0]?.title).toBe("Chat failed");
  expect(lastBadge()).toBe(1);
  expect(fake.showToast).not.toHaveBeenCalled();
});

test("a focused window gets a toast and no badge or system alert", async () => {
  fake.inApp = true;
  page.focused = true;
  await paint();
  finishOn("one");
  await paint();

  expect(fake.showToast).toHaveBeenCalledOnce();
  expect(SystemAlert.sent).toHaveLength(0);
  expect(badgeNeverRaised()).toBe(true);
});

test.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "%s badges, clicking the alert opens the thread, and muting clears everything",
  async (flag) => {
    await paint();
    fake.shells.set("one", liveShell({ [flag]: true }));
    await paint();
    expect(lastBadge()).toBe(1);

    const alert = SystemAlert.sent[0]!;
    alert.dispatchEvent(new Event("click"));
    expect(fake.goTo).toHaveBeenCalledWith({
      to: "/$hostId/$threadId",
      params: { hostId: HostId.make("one"), threadId: "thread" },
    });

    fake.mode = "sound";
    await paint();
    expect(lastBadge()).toBe(0);
    expect(alert.close).toHaveBeenCalled();
  },
);

test.each([
  ["mode off", () => (fake.mode = "off")],
  ["sound-only mode", () => (fake.mode = "sound")],
  ["focused window", () => (page.focused = true)],
  ["denied permission", () => (SystemAlert.permission = "denied")],
])("no visual alert under %s", async (_label, arrange) => {
  arrange();
  await paint();
  finishOn("one");
  await paint();
  expect(SystemAlert.sent).toHaveLength(0);
  expect(badgeNeverRaised()).toBe(true);
});

test("an archived thread never alerts, even with a pending approval", async () => {
  await paint();
  fake.shells.set(
    "one",
    liveShell({ hasPendingApprovals: true, archivedAt: "2026-09-13T08:00:00Z" }),
  );
  await paint();
  expect(SystemAlert.sent).toHaveLength(0);
  expect(badgeNeverRaised()).toBe(true);
});

test("the count is per notifying thread across hosts; repeats replace the old alert; focus clears", async () => {
  await paint();
  finishOn("one");
  await paint();
  expect(lastBadge()).toBe(1);

  finishOn("one", "2026-09-13T08:01:00Z");
  finishOn("two");
  await paint();
  expect(lastBadge()).toBe(2);
  expect(SystemAlert.sent[0]!.close).toHaveBeenCalledOnce();

  page.focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(lastBadge()).toBe(0);
  expect(SystemAlert.sent.every((a) => a.close.mock.calls.length > 0)).toBe(true);

  page.focused = false;
  finishOn("two", "2026-09-13T08:02:00Z");
  await paint();
  expect(lastBadge()).toBe(1);
});

test("only the alerts of a host that disappears are withdrawn", async () => {
  await paint();
  finishOn("one");
  finishOn("two");
  await paint();
  expect(lastBadge()).toBe(2);
  const [fromOne, fromTwo] = SystemAlert.sent;

  fake.hosts = ["two"];
  await paint();
  expect(lastBadge()).toBe(1);
  expect(fromOne!.close).toHaveBeenCalledOnce();
  expect(fromTwo!.close).not.toHaveBeenCalled();

  await paint();
  expect(fromOne!.close).toHaveBeenCalledOnce();

  fake.hosts = [];
  await paint();
  expect(lastBadge()).toBe(0);
  expect(fromTwo!.close).toHaveBeenCalledOnce();
});

test("completions already present at load or after a reconnect are not badged", async () => {
  finishOn("one");
  await paint();
  fake.shells.set("one", { status: "connecting", snapshot: Option.none() });
  await paint();
  finishOn("one", "2026-09-13T08:01:00Z");
  await paint();
  expect(SystemAlert.sent).toHaveLength(0);
  expect(badgeNeverRaised()).toBe(true);
});

test("another app window gaining focus resets the count, and unmounting unsubscribes", async () => {
  let resetFromShell!: () => void;
  const unsubscribe = vi.fn();
  Object.assign(window, {
    shellBridge: {
      onNotificationBadgeClear: (cb: () => void) => {
        resetFromShell = cb;
        return unsubscribe;
      },
    },
  });
  await paint();
  finishOn("one");
  await paint();

  resetFromShell();
  expect(lastBadge()).toBe(0);

  finishOn("two");
  await paint();
  expect(lastBadge()).toBe(1);

  await act(async () => tree!.unmount());
  tree = undefined;
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(lastBadge()).toBe(0);
});
