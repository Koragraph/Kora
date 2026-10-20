import type { ClientPrefs } from "@kora/contracts/clientPrefs";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

type Toast = { title: string; description: string; actionProps: { onClick: () => void } };

/** Everything the mocked environment can vary, plus the spies the component talks to. */
const world = vi.hoisted(() => {
  const defaults = () => ({
    liveConnection: true,
    turnFailed: false,
    sessionFailed: false,
    needsApproval: false,
    needsInput: false,
    archivedAt: null as string | null,
    finishedAt: null as string | null,
    pageVisible: "visible",
    windowFocused: true,
    viewing: { hostId: "env-1", threadId: "elsewhere" },
    inAppEnabled: true,
    mode: "off" as ClientPrefs["notificationMode"],
  });
  return {
    defaults,
    s: defaults(),
    systemAlert: vi.fn(function (_title: string, options: NotificationOptions) {
      return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
    }),
    playSound: vi.fn(),
    goTo: vi.fn(),
    closeToast: vi.fn(),
    showToast: vi.fn((_t: Toast) => "toast-1"),
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: world.s.liveConnection ? "live" : "disconnected",
    snapshot: Option.some({
      threads: [
        {
          id: "thread-1",
          title: "Repair the signup flow",
          archivedAt: world.s.archivedAt,
          hasPendingApprovals: world.s.needsApproval,
          hasPendingUserInput: world.s.needsInput,
          session: world.s.sessionFailed ? { status: "error" } : null,
          latestTurn: {
            turnId: "turn-1",
            completedAt: world.s.finishedAt,
            state: world.s.turnFailed ? "error" : world.s.finishedAt ? "completed" : "running",
          },
        },
      ],
    }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => world.s.viewing,
  useNavigate: () => world.goTo,
}));
vi.mock("../hooks/usePrefs", () => ({
  getClientPrefs: () => ({ notificationMode: world.s.mode }),
  useClientPrefs: (
    pick: (p: Pick<ClientPrefs, "notificationMode" | "inAppNotificationsEnabled">) => unknown,
  ) => pick({ notificationMode: world.s.mode, inAppNotificationsEnabled: world.s.inAppEnabled }),
}));
vi.mock("../atoms/hosts", () => ({ useHosts: () => ({ environments: [{ hostId: "env-1" }] }) }));
vi.mock("../atoms/shell", () => ({ hostShell: { stateEntryAtom: vi.fn() } }));
vi.mock("../thread/threadNotifications", async (loadReal) => ({
  ...(await loadReal<typeof import("../thread/threadNotifications")>()),
  playNotificationSound: world.playSound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: world.showToast, close: world.closeToast },
}));

import { TurnNotifications } from "./TurnNotifications";

let tree: ReactTestRenderer | undefined;

const paint = () =>
  act(() => {
    if (tree) tree.update(<TurnNotifications />);
    else tree = create(<TurnNotifications />);
  });

async function finishTurn() {
  world.s.finishedAt = "2026-09-13T10:00:00.000Z";
  await paint();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(world.s, world.defaults());
  const page = {
    hasFocus: () => world.s.windowFocused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    get visibilityState() {
      return world.s.pageVisible;
    },
  };
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", page);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", Object.assign(world.systemAlert, { permission: "granted" }));
});

afterEach(async () => {
  await act(() => tree?.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});

const SYSTEM_ALERT_BODY = { silent: true, tag: "env-1:thread-1", body: "Repair the signup flow" };

describe("completion alerts", () => {
  test("the in-app toast fires once, names the thread, and its action opens it", async () => {
    await paint();
    await finishTurn();
    await paint();

    expect(world.showToast).toHaveBeenCalledTimes(1);
    const toast = world.showToast.mock.calls[0]![0];
    expect([toast.title, toast.description]).toEqual(["Chat completed", "Repair the signup flow"]);

    toast.actionProps.onClick();
    expect(world.closeToast).toHaveBeenCalledWith("toast-1");
    expect(world.goTo).toHaveBeenCalledWith({
      to: "/$hostId/$threadId",
      params: { hostId: "env-1", threadId: "thread-1" },
    });
    expect(world.systemAlert).not.toHaveBeenCalled();
  });

  test("a toast replaces the system popup but the sound still plays", async () => {
    world.s.mode = "notifications-and-sound";
    await paint();
    await finishTurn();

    expect(world.playSound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(world.showToast).toHaveBeenCalledTimes(1);
    expect(world.systemAlert).not.toHaveBeenCalled();
  });

  test("with the window in the background only the system alert is shown", async () => {
    world.s.mode = "notifications";
    world.s.windowFocused = false;
    await paint();
    await finishTurn();

    expect(world.showToast).not.toHaveBeenCalled();
    expect(world.systemAlert).toHaveBeenCalledWith("Chat completed", SYSTEM_ALERT_BODY);
  });

  test("disabling in-app alerts keeps the desktop alert, and re-enabling does not replay", async () => {
    Object.assign(world.s, { windowFocused: false, inAppEnabled: false, mode: "notifications" });
    await paint();
    await finishTurn();
    expect(world.systemAlert).toHaveBeenCalledTimes(1);

    world.s.inAppEnabled = true;
    await paint();
    expect(world.showToast).not.toHaveBeenCalled();
  });

  test("turning alerts on after a completion does not announce the old one", async () => {
    world.s.inAppEnabled = false;
    await paint();
    await finishTurn();
    world.s.inAppEnabled = true;
    await paint();
    expect(world.showToast).not.toHaveBeenCalled();
  });

  test("a completion that was already there at load or reconnect is not announced", async () => {
    await finishTurn();
    world.s.liveConnection = false;
    await paint();
    world.s.liveConnection = true;
    await paint();
    expect(world.showToast).not.toHaveBeenCalled();
  });

  test("viewing the same thread id on a different host does not suppress the toast", async () => {
    world.s.viewing = { hostId: "env-2", threadId: "thread-1" };
    await paint();
    await finishTurn();
    expect(world.showToast).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["is open right now", () => (world.s.viewing.threadId = "thread-1")],
    ["is in an unfocused window", () => (world.s.windowFocused = false)],
    ["is in a hidden tab", () => (world.s.pageVisible = "hidden")],
    ["is archived", () => (world.s.archivedAt = "2026-09-13T09:00:00.000Z")],
    ["has in-app alerts disabled", () => (world.s.inAppEnabled = false)],
  ])("no toast when the thread %s", async (_label, arrange) => {
    await paint();
    arrange();
    await finishTurn();
    expect(world.showToast).not.toHaveBeenCalled();
  });
});

describe("attention alerts", () => {
  test.each([
    ["turnFailed", "Chat failed"],
    ["sessionFailed", "Chat failed"],
    ["needsApproval", "Approval needed"],
    ["needsInput", "Input needed"],
  ] as const)("%s alerts in-app when focused and via the system when not", async (flag, title) => {
    world.s.mode = "notifications-and-sound";
    await paint();
    world.s[flag] = true;
    await paint();
    await paint();

    expect(world.showToast).toHaveBeenCalledTimes(1);
    expect(world.showToast).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(world.playSound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(world.systemAlert).not.toHaveBeenCalled();

    world.s[flag] = false;
    await paint();
    world.s.windowFocused = false;
    world.s[flag] = true;
    await paint();
    await paint();

    expect(world.showToast).toHaveBeenCalledTimes(1);
    expect(world.systemAlert).toHaveBeenCalledExactlyOnceWith(title, SYSTEM_ALERT_BODY);
  });
});
