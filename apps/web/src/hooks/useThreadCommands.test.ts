import { HostId, ThreadId } from "@kora/contracts";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import {
  ThreadArchiveRefusedError,
  navigateAfterThreadDeletion,
  requestThreadUnpinConfirmation,
} from "./useThreadCommands";

describe("requestThreadUnpinConfirmation", () => {
  test("asks with the thread title and returns the answer", async () => {
    const ask = vi.fn(async (_message: string) => false);

    const result = await requestThreadUnpinConfirmation({
      confirm: ask,
      title: "Release prep",
      enabled: true,
    });

    expect(ask).toHaveBeenCalledWith(
      'Unpin chat "Release prep"?\nIt moves out of your pinned section.',
    );
    expect(result).toMatchObject({ _tag: "Success", value: false });
  });

  test("a dialog that errors is a visible failure, not a silent yes", async () => {
    const result = await requestThreadUnpinConfirmation({
      confirm: () => Promise.reject(new Error("no dialog")),
      title: "T",
      enabled: true,
    });
    expect(result._tag).toBe("Failure");
  });

  test.each([
    ["no dialog is available", { confirm: null, enabled: true }],
    ["confirmation is turned off", { confirm: vi.fn(async () => false), enabled: false }],
  ])("proceeds without asking when %s", async (_label, setup) => {
    const result = await requestThreadUnpinConfirmation({ title: "T", ...setup });
    expect(result).toMatchObject({ _tag: "Success", value: true });
    if (setup.confirm) expect(setup.confirm).not.toHaveBeenCalled();
  });
});

describe("ThreadArchiveRefusedError", () => {
  test("carries which thread was refused and tells the user to stop the turn", () => {
    const error = new ThreadArchiveRefusedError({
      threadId: ThreadId.make("t-9"),
      hostId: HostId.make("h-9"),
    });
    expect(error).toMatchObject({ threadId: "t-9", hostId: "h-9" });
    expect(error.message).toBe("Stop the turn before archiving this chat.");
  });
});

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  test("a successful navigation shows nothing", async () => {
    const toast = vi.spyOn(toastManager, "add");
    await navigateAfterThreadDeletion(async () => {});
    expect(toast).not.toHaveBeenCalled();
  });

  test("a failed navigation is reported in a toast but does not fail the deletion", async () => {
    const toast = vi.spyOn(toastManager, "add").mockReturnValue("t");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("no such route"))),
    ).resolves.toBeUndefined();

    expect(toast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Chat deleted, but navigation failed",
        description: "no such route",
      }),
    );
  });
});
