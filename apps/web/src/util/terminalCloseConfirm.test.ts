import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
  confirm: vi.fn<(message: string, options?: unknown) => Promise<boolean>>(),
  read: vi.fn<
    () => { dialogs: { confirm: (m: string, o?: unknown) => Promise<boolean> } } | undefined
  >(),
}));

vi.mock("~/localApi", () => ({ readLocalApi: () => api.read() }));

import { confirmTerminalClose } from "./terminalCloseConfirm";

beforeEach(() => {
  api.confirm.mockReset();
  api.read.mockReset().mockReturnValue({ dialogs: { confirm: api.confirm } });
});

describe("confirmTerminalClose", () => {
  test("without a local API the close just goes ahead", async () => {
    api.read.mockReturnValue(undefined);
    expect(await confirmTerminalClose(["T"])).toBe(true);
    expect(api.confirm).not.toHaveBeenCalled();
  });

  test("a single terminal is named in a destructive prompt", async () => {
    api.confirm.mockResolvedValue(true);
    await confirmTerminalClose(["Build"]);
    expect(api.confirm).toHaveBeenCalledWith(
      'Close terminal "Build"?\nThis stops the running process and clears its history.',
      { variant: "destructive" },
    );
  });

  test("several terminals are counted and all named", async () => {
    api.confirm.mockResolvedValue(true);
    await confirmTerminalClose(["A", "B", "C"]);
    expect(api.confirm).toHaveBeenCalledWith(
      'Close 3 terminals?\nThis stops their running processes and clears their histories: "A", "B", "C".',
      { variant: "destructive" },
    );
  });

  test.each([true, false])("the user's answer %s is returned", async (answer) => {
    api.confirm.mockResolvedValue(answer);
    expect(await confirmTerminalClose(["A"])).toBe(answer);
  });

  test("a dialog that throws counts as 'no'", async () => {
    api.confirm.mockRejectedValue(new Error("dialog crashed"));
    expect(await confirmTerminalClose(["A"])).toBe(false);
  });
});
