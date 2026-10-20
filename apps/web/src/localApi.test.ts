import {
  DEFAULT_CLIENT_PREFS,
  type ConfirmDialogOptions,
  type ContextMenuItem,
  type ShellBridge,
} from "@kora/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fallback = vi.hoisted(() => ({
  showMenu: vi.fn(),
  closeMenu: vi.fn<() => void>(),
  confirm:
    vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>(),
}));
vi.mock("./inPageContextMenu", () => ({
  showContextMenuFallback: fallback.showMenu as <T extends string>(
    items: readonly ContextMenuItem<T>[],
    at?: { x: number; y: number },
  ) => Promise<T | null>,
  dismissContextMenu: fallback.closeMenu,
}));
vi.mock("./confirm", () => ({ askToConfirm: fallback.confirm }));

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

const win = () => (globalThis.window ?? globalThis) as Window & typeof globalThis;
const freshApi = async () => (await import("./localApi")).createLocalApi();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
  }
  Reflect.deleteProperty(win(), "shellBridge");
  Object.defineProperty(win(), "localStorage", { value: memoryStorage(), configurable: true });
});
afterEach(() => vi.restoreAllMocks());

describe("in a plain browser", () => {
  test("client prefs round-trip through localStorage", async () => {
    const api = await freshApi();
    const prefs = { ...DEFAULT_CLIENT_PREFS, timestampFormat: "12-hour" as const };
    await api.persistence.setClientPrefs(prefs);
    await expect(api.persistence.getClientPrefs()).resolves.toEqual(prefs);
  });

  test("the context menu uses the in-page fallback, passing the position along", async () => {
    fallback.showMenu.mockResolvedValue("rename");
    const items = [{ id: "rename", label: "Rename" }] as const;
    await expect((await freshApi()).contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe(
      "rename",
    );
    expect(fallback.showMenu).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });

  test("closing the context menu dismisses the fallback", async () => {
    await (await freshApi()).contextMenu.close();
    expect(fallback.closeMenu).toHaveBeenCalledOnce();
  });

  test("a confirmation goes to the themed dialog host and its answer comes back", async () => {
    fallback.confirm.mockResolvedValue(true);
    const options = { variant: "destructive" } as const;
    await expect((await freshApi()).dialogs.confirm("Delete?", options)).resolves.toBe(true);
    expect(fallback.confirm).toHaveBeenCalledWith("Delete?", options);
  });

  test("with no dialog host available a confirmation fails closed", async () => {
    fallback.confirm.mockReturnValue(undefined);
    await expect((await freshApi()).dialogs.confirm("Delete?")).resolves.toBe(false);
  });

  test("backend operations are not part of this facade", async () => {
    const api = await freshApi();
    expect(api).not.toHaveProperty("server");
    expect(api.shell).not.toHaveProperty("openInEditor");
  });
});

describe("inside the desktop shell", () => {
  test("menus, folder picking and prefs are delegated to the bridge", async () => {
    const bridge = {
      showContextMenu: vi.fn().mockResolvedValue("delete"),
      pickFolder: vi.fn().mockResolvedValue("/tmp/project"),
      getClientPrefs: vi.fn().mockResolvedValue(DEFAULT_CLIENT_PREFS),
      setClientPrefs: vi.fn().mockResolvedValue(undefined),
    };
    win().shellBridge = bridge as unknown as ShellBridge;
    fallback.confirm.mockReturnValue(undefined);
    const api = await freshApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    await expect(api.dialogs.pickFolder({ initialPath: "/tmp" })).resolves.toBe("/tmp/project");
    await expect(api.persistence.getClientPrefs()).resolves.toEqual(DEFAULT_CLIENT_PREFS);
    await api.persistence.setClientPrefs(DEFAULT_CLIENT_PREFS);
    await expect(api.dialogs.confirm("Install update?")).resolves.toBe(false);

    expect(bridge.showContextMenu).toHaveBeenCalledWith(items, undefined);
    expect(bridge.pickFolder).toHaveBeenCalledWith({ initialPath: "/tmp" });
    expect(bridge.getClientPrefs).toHaveBeenCalledOnce();
    expect(bridge.setClientPrefs).toHaveBeenCalledWith(DEFAULT_CLIENT_PREFS);
  });
});
